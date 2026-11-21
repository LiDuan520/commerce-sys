'use strict';
// =====================================================================
// 价格模块（Price Module）—— 模块边界：对外只暴露 PriceService / facade
// 职责：立即调价、定时调价（价格方案）、价格履历查询
// 解耦：生效价冗余写 goods.sale_price 仅经 GoodsModule 提供的受控接口；
//       审计经 AuditBus；定时调度经 GoodsModule 的 Scheduler 统一轮询。
// =====================================================================
const express = require('express');
const { z } = require('zod');
const { err, nextId, buildPage, ok, toDBTime } = require('../common');
const { asyncHandler } = require('../common/error-handler');

// ---------------- 数据访问层 ----------------
class PriceRepository {
  constructor(db) { this.db = db; }

  _rowToPlan(r) {
    return {
      pricePlanId: r.price_plan_id, goodsId: r.goods_id, price: Number(r.price),
      effectiveTime: new Date(r.effective_time + 'Z'), status: r.status,
      operator: r.operator, remark: r.remark, createdAt: r.created_at,
    };
  }

  async insert(plan) {
    await this.db.query(
      `INSERT INTO price_plan (price_plan_id, goods_id, price, effective_time, status, operator, remark)
       VALUES (?,?,?,?,?,?,?)`,
      [plan.pricePlanId, plan.goodsId, plan.price, toDBTime(plan.effectiveTime), plan.status, plan.operator, plan.remark || null]
    );
  }

  async findPendingByGoods(goodsId) {
    const [rows] = await this.db.query(
      `SELECT * FROM price_plan WHERE goods_id=? AND status='W'`, [goodsId]);
    return rows.map((r) => this._rowToPlan(r));
  }

  async markStatus(pricePlanId, status, from, failReason) {
    const [res] = await this.db.query(
      `UPDATE price_plan SET status=?, fail_reason=? WHERE price_plan_id=? AND status=?`,
      [status, failReason || null, pricePlanId, from]);
    return res.affectedRows === 1;
  }

  async pageByGoods(goodsId, { offset, limit }) {
    const [rows] = await this.db.query(
      `SELECT * FROM price_plan WHERE goods_id=? ORDER BY effective_time DESC, id DESC LIMIT ? OFFSET ?`,
      [goodsId, limit, offset]);
    const [[{ total }]] = await this.db.query(
      `SELECT COUNT(*) AS total FROM price_plan WHERE goods_id=?`, [goodsId]);
    return { list: rows.map((r) => this._rowToPlan(r)), total };
  }

  /** 到期待生效方案（Scheduler 轮询） */
  async findDue(now, limit = 100) {
    const [rows] = await this.db.query(
      `SELECT * FROM price_plan WHERE status='W' AND effective_time<=? ORDER BY effective_time LIMIT ?`,
      [toDBTime(now), limit]);
    return rows.map((r) => this._rowToPlan(r));
  }
}

// ---------------- 领域服务 ----------------
class PriceService {
  /** Scheduler 查询到期方案（模块内聚：仓储细节不外泄） */
  async findDuePlans(now, limit = 100) { return this.repo.findDue(now, limit); }

  /**
   * @param goodsWriter 受控写接口（GoodsModule 注入）：唯一允许写 goods.sale_price 的通道
   * @param auditBus    审计事件总线
   */
  constructor(db, goodsWriter, auditBus) {
    this.db = db; // 事务连接获取（模块私有）
    this.repo = new PriceRepository(db);
    this.goodsWriter = goodsWriter;
    this.auditBus = auditBus;
  }

  /** 建品初始化价格方案（GoodsModule 建品时调用；不写 sale_price —— 建品已带初值） */
  async initPrice(goodsId, price, operator, traceId) {
    const plan = {
      pricePlanId: nextId(), goodsId, price, effectiveTime: new Date(),
      status: 'A', operator, remark: '建品初始价',
    };
    await this.repo.insert(plan);
    await this.auditBus.publish({ bizType: 'PRICE_PLAN', bizId: plan.pricePlanId, action: 'CREATE',
      before: null, after: { goodsId, price }, operator, traceId });
    return plan;
  }

  /** 立即调价：新方案即刻生效 + 冗余写 goods.sale_price（受控通道） */
  async changePriceNow(goodsId, price, operator, remark, traceId) {
    if (!(price > 0)) throw err.param('价格必须大于 0（单位：分）');
    // 事务保护方案落库与生效价写入的一致性（同一连接）
    await this._withTransaction(async (conn) => {
      const plan = { pricePlanId: nextId(), goodsId, price, effectiveTime: new Date(), status: 'A', operator, remark };
      await this.repo.insert(plan);
      await this.goodsWriter.applySalePrice(conn, goodsId, price);
      await this.auditBus.publish({ bizType: 'PRICE_PLAN', bizId: plan.pricePlanId, action: 'APPLY_PRICE',
        before: null, after: { goodsId, price }, operator, traceId });
    });
    return this.repo.pageByGoods(goodsId, { offset: 0, limit: 1 });
  }

  /** 定时调价：W 方案，到期由 Scheduler 生效 */
  async schedulePrice(goodsId, price, effectiveTime, operator, remark, traceId) {
    if (!(price > 0)) throw err.param('价格必须大于 0（单位：分）');
    if (effectiveTime.getTime() <= Date.now()) throw err.param('生效时间必须晚于当前时间');
    if ((await this.repo.findPendingByGoods(goodsId)).length > 0) {
      throw err.duplicatePlan('该商品已存在待生效的调价计划');
    }
    const plan = { pricePlanId: nextId(), goodsId, price, effectiveTime, status: 'W', operator, remark };
    await this.repo.insert(plan);
    await this.auditBus.publish({ bizType: 'PRICE_PLAN', bizId: plan.pricePlanId, action: 'SCHEDULE',
      before: null, after: { goodsId, price, effectiveTime }, operator, traceId });
    return plan;
  }

  /** Scheduler 回调：方案到期生效 —— 幂等（W→A 条件更新）+ 受控写 sale_price */
  async applyDuePlan(plan) {
    const done = await this.repo.markStatus(plan.pricePlanId, 'A', 'W');
    if (!done) return { applied: false, reason: '方案已被取消或已生效' };
    await this.goodsWriter.applySalePrice(null, plan.goodsId, plan.price);
    await this.auditBus.publish({ bizType: 'PRICE_PLAN', bizId: plan.pricePlanId, action: 'APPLY_PRICE',
      before: null, after: { goodsId: plan.goodsId, price: plan.price }, operator: 'SYSTEM', traceId: `plan-${plan.pricePlanId}` });
    return { applied: true };
  }

  async cancelPlan(goodsId, operator, traceId) {
    const pending = await this.repo.findPendingByGoods(goodsId);
    if (!pending.length) throw err.notFound('无待生效的调价计划');
    const plan = pending[0];
    const done = await this.repo.markStatus(plan.pricePlanId, 'C', 'W');
    if (!done) throw err.conflict('计划已生效，无法取消');
    await this.auditBus.publish({ bizType: 'PRICE_PLAN', bizId: plan.pricePlanId, action: 'CANCEL_PLAN',
      before: { status: 'W' }, after: { status: 'C' }, operator, traceId });
    return { canceled: plan.pricePlanId };
  }

  async listPlans(goodsId, query) {
    const page = buildPage(query);
    return { ...(await this.repo.pageByGoods(goodsId, page)), ...page };
  }

  async _withTransaction(fn) {
    const conn = await this.db.getConnection();
    try {
      await conn.beginTransaction();
      await fn(conn);
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }
}

// ---------------- HTTP 层 ----------------
const priceSchema = z.object({
  price: z.number().int().positive(),
  operator: z.string().min(1).max(64),
  remark: z.string().max(255).optional(),
});
const schedulePriceSchema = priceSchema.extend({
  effectiveTime: z.coerce.date().refine((d) => d.getTime() > Date.now(), '生效时间必须晚于当前时间'),
});

function buildRouter(svc) {
  const r = express.Router({ mergeParams: true }); // 继承挂载层 :goodsId（Express 4 默认丢弃）
  const w = asyncHandler; // async 错误统一进 errorHandler
  // 挂载 /goods/:goodsId/price 前缀（由 app.js 组装）
  r.post('/change', w(async (req, res) => {
    const { price, operator, remark } = priceSchema.parse(req.body);
    res.json(ok(await svc.changePriceNow(req.params.goodsId, price, operator, remark, req.header('x-trace-id'))));
  }));
  r.post('/schedule', w(async (req, res) => {
    const input = schedulePriceSchema.parse(req.body);
    res.json(ok(await svc.schedulePrice(req.params.goodsId, input.price, input.effectiveTime, input.operator, input.remark, req.header('x-trace-id'))));
  }));
  r.post('/cancel', w(async (req, res) => {
    const { operator } = z.object({ operator: z.string().min(1).max(64) }).parse(req.body || {});
    res.json(ok(await svc.cancelPlan(req.params.goodsId, operator, req.header('x-trace-id'))));
  }));
  r.get('/plans', w(async (req, res) => {
    const q = z.object({
      pageNo: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
    }).parse(req.query);
    res.json(ok(await svc.listPlans(req.params.goodsId, q)));
  }));
  return r;
}

module.exports = { PriceService, buildRouter };
