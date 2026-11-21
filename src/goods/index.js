'use strict';
// =====================================================================
// 商品模块（Goods Module）—— 模块边界：对外只暴露 goodsService 接口与路由
// 职责：商品 CRUD + 状态机（草稿/上架中/在售/停售）+ 定时上下架计划
// 解耦：不直接写价格表/审计表；调价委托 PriceModule，留痕经 AuditBus
// =====================================================================
const express = require('express');
const { z } = require('zod');
const { err, nextId, buildPage, ok, toDBTime } = require('../common');
const { asyncHandler } = require('../common/error-handler');

// ---------------- 数据访问层（模块内私有，外部黑盒） ----------------
class GoodsRepository {
  constructor(db) { this.db = db; }

  _rowToGoods(r) {
    if (!r) return null;
    return {
      goodsId: r.goods_id, typeCode: r.type_code, sku: r.sku, name: r.name,
      unit: r.unit === null ? null : Number(r.unit),
      salePrice: Number(r.sale_price), marketPrice: r.market_price === null ? null : Number(r.market_price),
      stock: r.stock, status: r.status,
      effectiveTime: r.effective_time ? new Date(r.effective_time + 'Z') : null,
      version: Number(r.version),
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  async insert(goods) {
    const [res] = await this.db.query(
      `INSERT INTO goods (goods_id, type_code, sku, name, unit, sale_price, market_price, stock, status, effective_time)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [goods.goodsId, goods.typeCode, goods.sku, goods.name, goods.unit,
       goods.salePrice, goods.marketPrice, goods.stock, goods.status, goods.effectiveTime ? toDBTime(goods.effectiveTime) : null]
    );
    return res.insertId;
  }

  async findById(goodsId) {
    const [rows] = await this.db.query('SELECT * FROM goods WHERE goods_id = ?', [goodsId]);
    return this._rowToGoods(rows[0]);
  }

  async update(goods, expectVersion) {
    // 乐观锁：version 不匹配 → 0 行受影响 → 上层转 STATE_CONFLICT
    const [res] = await this.db.query(
      `UPDATE goods SET name=?, unit=?, market_price=?, stock=?, version=version+1 WHERE goods_id=? AND version=?`,
      [goods.name, goods.unit, goods.marketPrice, goods.stock, goods.goodsId, expectVersion]
    );
    return res.affectedRows === 1;
  }

  async findBySku(typeCode, sku) {
    const [rows] = await this.db.query('SELECT * FROM goods WHERE type_code=? AND sku=?', [typeCode, sku]);
    return this._rowToGoods(rows[0]);
  }

  /** 条件更新（状态机迁移专用）：where 描述前置条件，SET 子句受控白名单拼接 */
  async updateStatus(goodsId, where, sets) {
    const setSql = Object.entries(sets).map(([k]) => `${k}=?`).join(', ');
    const values = Object.values(sets);
    const whereSql = Object.entries(where).map(([k]) => `${k}=?`).join(' AND ');
    const [res] = await this.db.query(
      `UPDATE goods SET ${setSql}, version=version+1 WHERE goods_id=? AND ${whereSql}`,
      [...values, goodsId, ...Object.values(where)]
    );
    return res.affectedRows === 1;
  }

  async page({ typeCode, status, keyword }, { offset, limit }) {
    const cond = []; const vals = [];
    if (typeCode) { cond.push('type_code=?'); vals.push(typeCode); }
    if (status) { cond.push('status=?'); vals.push(status); }
    if (keyword) { cond.push('name LIKE ?'); vals.push(`%${keyword}%`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const [rows] = await this.db.query(
      `SELECT * FROM goods ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...vals, limit, offset]);
    const [[{ total }]] = await this.db.query(`SELECT COUNT(*) AS total FROM goods ${where}`, vals);
    return { list: rows.map((r) => this._rowToGoods(r)), total };
  }
}

// ---------------- 状态机（原子化：迁移表驱动，扩展=加一行） ----------------
// D=草稿 A=在售 S=停售 P=上架中(定时待生效)
const TRANSITIONS = {
  D: ['A', 'P'],   // 草稿 → 在售（立即上架）/ 上架中（定时上架）
  P: ['A', 'D'],   // 上架中 → 在售（计划生效）/ 草稿（取消定时）
  A: ['S'],        // 在售 → 停售（立即下架）；在售 → P 语义不成立（调价不换态）
  S: ['A', 'P'],   // 停售 → 在售（重新上架）/ 上架中（定时重新上架）
};
function assertTransition(from, to, ctx = '') {
  const allowed = (TRANSITIONS[from] || []).includes(to);
  if (!allowed) throw err.conflict(`非法状态迁移: ${from} -> ${to}${ctx ? ' (' + ctx + ')' : ''}`);
}

// ---------------- 计划仓储（定时上下架，与商品同库） ----------------
class ScheduleRepository {
  constructor(db) { this.db = db; }

  async create(plan) {
    await this.db.query(
      `INSERT INTO goods_schedule (biz_id, policy_kind, action_code, payload, status, effective_time)
       VALUES (?,?,?,?, 'W', ?)`,
      [plan.bizId, plan.policyKind, plan.actionCode, JSON.stringify(plan.payload), toDBTime(plan.effectiveTime)]
    );
  }

  /** 唯一性业务校验：同 biz 同 kind 只允许一条 W 计划（DB uk 兜底） */
  async existsPending(bizId, policyKind) {
    const [[row]] = await this.db.query(
      `SELECT id FROM goods_schedule WHERE biz_id=? AND policy_kind=? AND status='W'`, [bizId, policyKind]);
    return !!row;
  }

  /** 取消计划：乐观锁防止与生效任务竞态（W → C） */
  async cancel(planId) {
    const [res] = await this.db.query(
      `UPDATE goods_schedule SET status='C' WHERE id=? AND status='W'`, [planId]);
    return res.affectedRows === 1;
  }

  /** 扫描到期计划（Scheduler 轮询入口） */
  async findDue(now, limit = 100) {
    const [rows] = await this.db.query(
      `SELECT * FROM goods_schedule WHERE status='W' AND effective_time<=? ORDER BY effective_time LIMIT ?`,
      [toDBTime(now), limit]);
    return rows.map((r) => ({
      id: r.id, bizId: r.biz_id, policyKind: r.policy_kind, actionCode: r.action_code,
      payload: JSON.parse(r.payload), effectiveTime: new Date(r.effective_time + 'Z'), status: r.status,
    }));
  }

  /** 标记生效（W → S），失败标 F 并留原因，不回滚已提交业务事务 */
  async markStatus(planId, status, from, failReason) {
    const [res] = await this.db.query(
      `UPDATE goods_schedule SET status=?, fail_reason=? WHERE id=? AND status=?`,
      [status, failReason || null, planId, from]);
    return res.affectedRows === 1;
  }
}

// ---------------- 领域服务（模块对外唯一入口） ----------------
class GoodsService {
  /**
   * @param db          数据库连接池（基础设施注入）
   * @param auditBus    审计事件总线（跨模块解耦：只依赖事件契约，不依赖 AuditModule 实现）
   * @param priceFacade 价格模块门面（建品/改品时同步价格履历）
   */
  constructor(db, auditBus, priceFacade, goodsTypeRegistry) {
    this.db = db; // 计划查询直用（模块私有）
    this.repo = new GoodsRepository(db);
    this.schedules = new ScheduleRepository(db);
    this.auditBus = auditBus;
    this.priceFacade = priceFacade;
    this.typeRegistry = goodsTypeRegistry;
  }

  async createGoods(input) {
    // 类型校验：未注册类型拒绝（类型注册制扩展点）
    const type = await this.typeRegistry.get(input.typeCode);
    if (!type || type.status !== 'A') throw err.param(`未注册或已停用的商品类型: ${input.typeCode}`);

    // NT（代币类）必须提供面额 —— 资金类商品防御
    if (input.typeCode === 'NT' && !(input.unit > 0)) throw err.param('NT 商品必须提供大于 0 的面额 unit');

    // SKU 查重（应用层先挡 + DB 唯一键兜底）
    if (await this.repo.findBySku(input.typeCode, input.sku)) {
      throw err.duplicate(`SKU 已存在: ${input.typeCode}/${input.sku}`);
    }

    const goods = {
      goodsId: nextId(), typeCode: input.typeCode, sku: input.sku, name: input.name,
      unit: input.unit ?? null, salePrice: input.salePrice ?? 0,
      marketPrice: input.marketPrice ?? null, stock: input.stock ?? 0,
      status: 'D', effectiveTime: null,
    };
    await this.repo.insert(goods);

    // 价格履历初始化（有初始价才建方案）—— 价格域写操作委托价格模块
    if (input.salePrice > 0) {
      await this.priceFacade.initPrice(goods.goodsId, input.salePrice, input.operator, input.traceId);
    }

    await this.auditBus.publish({ bizType: 'GOODS', bizId: goods.goodsId, action: 'CREATE',
      before: null, after: this._safeGoods(goods), operator: input.operator, traceId: input.traceId });
    return goods;
  }

  async updateGoods(goodsId, input) {
    const goods = await this._require(goodsId);
    // 状态机约束：在售商品仅允许改库存（价格走调价接口，状态走上下架接口）
    if (goods.status === 'A') {
      throw err.conflict('在售商品不允许直接编辑基础信息，请先下架（库存调整除外）');
    }
    const updated = {
      goodsId, typeCode: goods.typeCode, sku: goods.sku,
      name: input.name ?? goods.name, unit: input.unit ?? goods.unit,
      salePrice: goods.salePrice, marketPrice: input.marketPrice ?? goods.marketPrice,
      stock: input.stock ?? goods.stock, status: goods.status,
    };
    if (input.stock !== undefined && goods.status === 'A') updated.stock = input.stock;

    const okRows = await this.repo.update(updated, input.version);
    if (!okRows) throw err.conflict('并发冲突：商品已被他人修改，请刷新后重试（乐观锁）');
    await this.auditBus.publish({ bizType: 'GOODS', bizId: goodsId, action: 'UPDATE',
      before: this._safeGoods(goods), after: this._safeGoods(updated), operator: input.operator, traceId: input.traceId });
    return this.repo.findById(goodsId);
  }

  // ---------------- 上下架（原子操作） ----------------
  async listing(goodsId, operator, traceId) {
    const goods = await this._require(goodsId);
    assertTransition(goods.status, 'A', '立即上架');
    if (goods.salePrice <= 0) throw err.param('上架前必须设置售价（> 0 分）');
    // 条件更新充当乐观语义：WHERE status=前置态，并发下只有一方成功
    const done = await this.repo.updateStatus(goodsId, { status: goods.status }, { status: 'A', effective_time: null });
    if (!done) throw err.conflict('并发冲突：状态已变化，请重试');
    await this.auditBus.publish({ bizType: 'GOODS', bizId: goodsId, action: 'LISTING',
      before: this._safeGoods(goods), after: this._safeGoods(await this.repo.findById(goodsId)),
      operator, traceId });
    return this.repo.findById(goodsId);
  }

  async delisting(goodsId, operator, traceId) {
    const goods = await this._require(goodsId);
    assertTransition(goods.status, 'S', '立即下架');
    const done = await this.repo.updateStatus(goodsId, { status: goods.status }, { status: 'S', effective_time: null });
    if (!done) throw err.conflict('并发冲突：状态已变化，请重试');
    await this.auditBus.publish({ bizType: 'GOODS', bizId: goodsId, action: 'DELISTING',
      before: this._safeGoods(goods), after: this._safeGoods(await this.repo.findById(goodsId)),
      operator, traceId });
    return this.repo.findById(goodsId);
  }

  /**
   * 定时上下架：落 W 计划。
   * - 定时上架（D/S → A）：商品立即转 P（挂起，防止到期前被编辑/人工上架）
   * - 定时下架（A → S）：保持 A 在售到生效时刻（提前下架违背定时语义），到期转 S
   */
  async scheduleShelf(goodsId, { actionCode, effectiveTime }, operator, traceId) {
    const goods = await this._require(goodsId);
    if (await this.schedules.existsPending(goodsId, 'SHELF')) {
      throw err.duplicatePlan('该商品已存在待生效的上下架计划');
    }
    const target = actionCode === 'OFF_SHELF' ? 'S' : 'A';
    assertTransition(goods.status, target, `定时${actionCode}`);
    if (target === 'A' && goods.salePrice <= 0) throw err.param('上架前必须设置售价（> 0 分）');

    await this.schedules.create({ bizId: goodsId, policyKind: 'SHELF', actionCode,
      payload: { from: goods.status, to: target }, effectiveTime });
    if (target === 'A') {
      // 上架计划：立即转 P 挂起态
      const done = await this.repo.updateStatus(goodsId, { status: goods.status }, { status: 'P', effective_time: toDBTime(effectiveTime) });
      if (!done) throw err.conflict('并发冲突：状态已变化，请重试');
    }
    await this.auditBus.publish({ bizType: 'GOODS', bizId: goodsId, action: 'SCHEDULE',
      before: this._safeGoods(goods),
      after: { plan: { actionCode, effectiveTime, target } }, operator, traceId });
    return this.repo.findById(goodsId);
  }

  /** Scheduler 回调：计划到期执行 —— 幂等（W→S 条件更新），前置态校验防人工干预竞态 */
  async applyShelfPlan(plan) {
    const target = plan.payload.to;
    const from = plan.payload.from;
    const goods = await this._require(plan.bizId);
    // 上架计划前置 P；下架计划前置 A（生效前商品须仍处计划发起时的在售态）
    const expected = target === 'A' ? 'P' : from;
    if (goods.status !== expected) {
      await this.schedules.markStatus(plan.id, 'F', 'W', `商品当前状态 ${goods.status} 不满足计划前置 ${expected} 态`);
      return { applied: false, reason: '状态不满足前置条件' };
    }
    const done = await this.repo.updateStatus(plan.bizId, { status: expected }, { status: target, effective_time: null });
    if (!done) { await this.schedules.markStatus(plan.id, 'F', 'W', '并发冲突'); return { applied: false, reason: '并发冲突' }; }
    await this.schedules.markStatus(plan.id, 'S', 'W');
    await this.auditBus.publish({ bizType: 'GOODS', bizId: plan.bizId, action: target === 'A' ? 'LISTING' : 'DELISTING',
      before: this._safeGoods(goods), after: this._safeGoods(await this.repo.findById(plan.bizId)),
      operator: 'SYSTEM', traceId: `plan-${plan.id}` });
    return { applied: true };
  }

  /** 取消待生效计划：上架计划回退 P→from；下架计划商品保持 A 不动 */
  async cancelSchedule(goodsId, operator, traceId) {
    const goods = await this._require(goodsId);
    const [rows] = await this.db.query(
      `SELECT id, payload FROM goods_schedule WHERE biz_id=? AND policy_kind='SHELF' AND status='W'`, [goodsId]);
    if (!rows.length) throw err.notFound('无待生效的上下架计划');
    const planId = rows[0].id;
    const payload = JSON.parse(rows[0].payload);
    // 先取消计划（W→C），再回退商品状态 —— 与生效任务竞态时只有一方成功
    const canceled = await this.schedules.cancel(planId);
    if (!canceled) throw err.conflict('计划已被生效任务处理，无法取消');
    if (goods.status === 'P') {
      // 挂起态回退到计划发起前状态
      const back = payload.from || 'D';
      const done = await this.repo.updateStatus(goodsId, { status: 'P' }, { status: back, effective_time: null });
      if (!done) throw err.conflict('并发冲突：状态已变化');
    }
    await this.auditBus.publish({ bizType: 'SCHEDULE', bizId: String(planId), action: 'CANCEL_PLAN',
      before: { goodsId, status: 'W' }, after: { goodsId, status: 'C' }, operator, traceId });
    return { canceled: planId };
  }

  async getGoods(goodsId) { return this._require(goodsId); }

  async listGoods(query) {
    const page = buildPage(query);
    return this.repo.page(query, page).then((r) => ({ ...r, ...page }));
  }

  async _require(goodsId) {
    const goods = await this.repo.findById(goodsId);
    if (!goods) throw err.notFound(`商品不存在: ${goodsId}`);
    return goods;
  }

  /** 审计快照脱敏：只留业务字段 */
  _safeGoods(g) {
    return { goodsId: g.goodsId, typeCode: g.typeCode, sku: g.sku, name: g.name, unit: g.unit,
      salePrice: g.salePrice, stock: g.stock, status: g.status };
  }
}

// ---------------- HTTP 层（薄路由：只做参数校验 + 委托服务） ----------------
const createGoodsSchema = z.object({
  typeCode: z.string().min(1).max(32),
  sku: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  unit: z.number().positive().optional(),
  salePrice: z.number().int().nonnegative().optional(),
  marketPrice: z.number().int().nonnegative().optional(),
  stock: z.number().int().min(-1).default(0),
  operator: z.string().min(1).max(64),
});
const updateGoodsSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  unit: z.number().positive().optional(),
  marketPrice: z.number().int().nonnegative().optional(),
  stock: z.number().int().min(-1).optional(),
  version: z.number().int().nonnegative(),
  operator: z.string().min(1).max(64),
});
const shelfSchema = z.object({
  actionCode: z.enum(['DRAFT_TO_ON', 'ON_AGAIN', 'OFF_SHELF']),
  effectiveTime: z.coerce.date().refine((d) => d.getTime() > Date.now(), '生效时间必须晚于当前时间'),
  operator: z.string().min(1).max(64),
});

function buildRouter(svc) {
  const r = express.Router();
  const w = asyncHandler; // async 错误统一进 errorHandler（Express 4 不捕获 Promise rejection）

  r.post('/', w(async (req, res) => {
    const input = createGoodsSchema.parse(req.body);
    res.status(201).json(ok(await svc.createGoods(input)));
  }));

  r.get('/:goodsId', w(async (req, res) => {
    res.json(ok(await svc.getGoods(req.params.goodsId)));
  }));

  r.get('/', w(async (req, res) => {
    const q = z.object({
      typeCode: z.string().optional(), status: z.enum(['D', 'P', 'A', 'S']).optional(),
      keyword: z.string().max(64).optional(),
      pageNo: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
    }).parse(req.query);
    res.json(ok(await svc.listGoods(q)));
  }));

  r.put('/:goodsId', w(async (req, res) => {
    const input = updateGoodsSchema.parse(req.body);
    res.json(ok(await svc.updateGoods(req.params.goodsId, input)));
  }));

  r.post('/:goodsId/listing', w(async (req, res) => {
    const { operator } = z.object({ operator: z.string().min(1).max(64) }).parse(req.body || {});
    res.json(ok(await svc.listing(req.params.goodsId, operator, req.header('x-trace-id'))));
  }));

  r.post('/:goodsId/delisting', w(async (req, res) => {
    const { operator } = z.object({ operator: z.string().min(1).max(64) }).parse(req.body || {});
    res.json(ok(await svc.delisting(req.params.goodsId, operator, req.header('x-trace-id'))));
  }));

  r.post('/:goodsId/schedule-shelf', w(async (req, res) => {
    const input = shelfSchema.parse(req.body);
    res.json(ok(await svc.scheduleShelf(req.params.goodsId, input, input.operator, req.header('x-trace-id'))));
  }));

  r.post('/:goodsId/cancel-schedule', w(async (req, res) => {
    const { operator } = z.object({ operator: z.string().min(1).max(64) }).parse(req.body || {});
    res.json(ok(await svc.cancelSchedule(req.params.goodsId, operator, req.header('x-trace-id'))));
  }));

  return r;
}

module.exports = { GoodsService, buildRouter, TRANSITIONS, assertTransition };
