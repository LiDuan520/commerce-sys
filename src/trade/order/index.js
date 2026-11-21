'use strict';
// =====================================================================
// 交易模块 — 订单域（Order Module）
// 职责：下单（快照+防超卖）/ 取消 / 超时关单 / 订单查询 / 状态机
// 解耦：商品经 goodsReader 只读接口取快照；审计走 auditBus；事件走 trade_event
// =====================================================================
const express = require('express');
const { z } = require('zod');
const { err, nextId, buildPage, ok, toDBTime } = require('../../common');
const { asyncHandler } = require('../../common/error-handler');

const PAY_DEADLINE_MIN = 30; // 支付截止：下单 + 30min

// 订单状态机迁移表（W待支付 P已支付 C已取消 X已关闭 R退款中 D已退款）
const ORDER_TRANSITIONS = {
  W: ['P', 'C', 'X'],   // 待支付 → 支付成功/用户取消/超时关闭
  P: ['R'],             // 已支付 → 退款中
  R: ['D'],             // 退款中 → 已退款
  C: [], X: [], D: [],  // 终态
};

class OrderRepository {
  constructor(db) { this.db = db; }

  _rowToOrder(r) {
    if (!r) return null;
    return {
      orderId: r.order_id, userId: r.user_id, goodsId: r.goods_id,
      goodsName: r.goods_name, goodsType: r.goods_type,
      unitPrice: Number(r.unit_price), quantity: r.quantity, totalAmount: Number(r.total_amount),
      status: r.status, payDeadline: r.pay_deadline ? new Date(r.pay_deadline + 'Z') : null,
      version: Number(r.version), createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  async insert(order) {
    const [res] = await this.db.query(
      `INSERT INTO trade_order (order_id, user_id, goods_id, goods_name, goods_type, unit_price, quantity, total_amount, status, pay_deadline)
       VALUES (?,?,?,?,?,?,?,?, 'W', ?)`,
      [order.orderId, order.userId, order.goodsId, order.goodsName, order.goodsType,
       order.unitPrice, order.quantity, order.totalAmount, toDBTime(order.payDeadline)]
    );
    return res.insertId;
  }

  async findByOrderId(orderId) {
    const [rows] = await this.db.query('SELECT * FROM trade_order WHERE order_id = ?', [orderId]);
    return this._rowToOrder(rows[0]);
  }

  /** 状态机条件迁移：WHERE 带前置态，0 行受影响 → 并发冲突/非法迁移 */
  async transition(orderId, from, to) {
    const [res] = await this.db.query(
      `UPDATE trade_order SET status=?, version=version+1 WHERE order_id=? AND status=?`,
      [to, orderId, from]);
    return res.affectedRows === 1;
  }

  async page({ userId, status }, { offset, limit }) {
    const cond = []; const vals = [];
    if (userId) { cond.push('user_id=?'); vals.push(userId); }
    if (status) { cond.push('status=?'); vals.push(status); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const [rows] = await this.db.query(
      `SELECT * FROM trade_order ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...vals, limit, offset]);
    const [[{ total }]] = await this.db.query(`SELECT COUNT(*) AS total FROM trade_order ${where}`, vals);
    return { list: rows.map((r) => this._rowToOrder(r)), total };
  }

  /** 超时关单扫描：W 且 pay_deadline 已过 */
  async findExpired(now, limit = 100) {
    const [rows] = await this.db.query(
      `SELECT order_id, quantity, goods_id FROM trade_order WHERE status='W' AND pay_deadline < ? LIMIT ?`,
      [toDBTime(now), limit]);
    return rows.map((r) => ({ orderId: r.order_id, quantity: r.quantity, goodsId: r.goods_id }));
  }
}

class EventRepository {
  constructor(db) { this.db = db; }
  async append(orderId, eventType, payload) {
    await this.db.query(
      `INSERT INTO trade_event (order_id, event_type, payload) VALUES (?,?,?)`,
      [orderId, eventType, JSON.stringify(payload)]);
  }
  async listByOrder(orderId) {
    const [rows] = await this.db.query(
      `SELECT * FROM trade_event WHERE order_id=? ORDER BY id`, [orderId]);
    return rows.map((r) => ({ orderId: r.order_id, eventType: r.event_type,
      payload: JSON.parse(r.payload), createdAt: r.created_at }));
  }
}

class OrderService {
  /**
   * @param goodsReader    商品模块只读接口（快照 + 原子扣减/回补库存，见 app.js 注入）
   * @param auditBus       审计事件总线
   */
  constructor(db, goodsReader, auditBus) {
    this.db = db;
    this.repo = new OrderRepository(db);
    this.events = new EventRepository(db);
    this.goodsReader = goodsReader;
    this.auditBus = auditBus;
  }

  /** 下单：快照 + 原子扣库存 + 建单（事务：扣减失败整体回滚） */
  async createOrder({ goodsId, quantity, userId }) {
    if (!(quantity >= 1 && quantity <= 999)) throw err.param('数量须在 1-999 之间');
    // 只读快照：仅 A（在售）可下单
    const goods = await this.goodsReader.getSnapshot(goodsId);
    if (!goods) throw err.notFound(`商品不存在: ${goodsId}`);
    if (goods.status !== 'A') throw err.conflict('商品不在售，无法下单', { code: 'GOODS_NOT_SELLING' });
    if (goods.salePrice <= 0) throw err.param('商品价格异常（<= 0）');

    const order = {
      orderId: nextId(), userId, goodsId,
      goodsName: goods.name, goodsType: goods.typeCode,
      unitPrice: goods.salePrice, quantity,
      totalAmount: goods.salePrice * quantity,
      status: 'W', // 新单即待支付
      payDeadline: new Date(Date.now() + PAY_DEADLINE_MIN * 60 * 1000),
    };

    // 原子扣减（-1=无限库存跳过）：单语句条件更新，affectedRows=0 → 库存不足
    if (goods.stock !== -1) {
      const deducted = await this.goodsReader.deductStock(goodsId, quantity);
      if (!deducted) {
        throw err.conflict('库存不足', { code: 'STOCK_NOT_ENOUGH' });
      }
    }

    try {
      await this.repo.insert(order);
    } catch (e) {
      // 建单失败回补库存（补偿路径）
      if (goods.stock !== -1) await this.goodsReader.restoreStock(goodsId, quantity);
      throw e;
    }

    await this.events.append(order.orderId, 'CREATE', { goodsId, quantity, totalAmount: order.totalAmount });
    await this.auditBus.publish({ bizType: 'TRADE_ORDER', bizId: order.orderId, action: 'CREATE',
      before: null, after: { goodsId, quantity, totalAmount: order.totalAmount, userId },
      operator: userId, traceId: order.orderId });
    return order;
  }

  async getOrder(orderId) { return this._require(orderId); }

  async listOrders(query) {
    const page = buildPage(query);
    return { ...(await this.repo.page(query, page)), ...page };
  }

  async orderTimeline(orderId) { return this.events.listByOrder(orderId); }

  /** 用户取消：仅 W 态；取消后回补库存 */
  async cancel(orderId, userId) {
    const order = await this._require(orderId);
    if (order.userId !== userId) throw err.conflict('仅买家本人可取消订单');
    this._assert('W', 'C', '用户取消', order);
    const done = await this.repo.transition(orderId, 'W', 'C');
    if (!done) throw err.conflict('订单状态已变化，请刷新重试');
    if (order.goodsType) await this._restore(order);
    await this.events.append(orderId, 'CANCEL', { by: 'USER' });
    await this.auditBus.publish({ bizType: 'TRADE_ORDER', bizId: orderId, action: 'CANCEL',
      before: { status: 'W' }, after: { status: 'C' }, operator: userId, traceId: orderId });
    return this.repo.findByOrderId(orderId);
  }

  /** Scheduler 回调：超时关单（幂等：W→X 条件更新）+ 回补库存 */
  async closeExpired(order) {
    const done = await this.repo.transition(order.orderId, 'W', 'X');
    if (!done) return { applied: false, reason: '订单已不在待支付态' };
    await this._restore(order);
    await this.events.append(order.orderId, 'CLOSE', { by: 'SYSTEM', reason: 'PAY_TIMEOUT' });
    await this.auditBus.publish({ bizType: 'TRADE_ORDER', bizId: order.orderId, action: 'CLOSE',
      before: { status: 'W' }, after: { status: 'X' }, operator: 'SYSTEM', traceId: order.orderId });
    return { applied: true };
  }

  async findExpired() { return this.repo.findExpired(new Date()); }

  _assert(from, to, ctx, order) {
    if (!(ORDER_TRANSITIONS[from] || []).includes(to)) {
      throw err.conflict(`订单状态 ${from} 不允许 ${ctx}（当前: ${order.status}）`);
    }
  }

  async _restore(order) {
    // 库存回补（下单时是有限库存才需要）
    const goods = await this.goodsReader.getSnapshot(order.goodsId);
    if (goods && goods.stock !== -1) {
      await this.goodsReader.restoreStock(order.goodsId, order.quantity);
    }
  }

  async _require(orderId) {
    const order = await this.repo.findByOrderId(orderId);
    if (!order) throw err.notFound(`订单不存在: ${orderId}`);
    return order;
  }
}

// ---------------- HTTP 层 ----------------
const createOrderSchema = z.object({
  goodsId: z.string().min(1).max(32),
  quantity: z.number().int().min(1).max(999),
  userId: z.string().min(1).max(32),
});
const listSchema = z.object({
  userId: z.string().max(32).optional(),
  status: z.enum(['W', 'P', 'C', 'X', 'R', 'D']).optional(),
  pageNo: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

function buildRouter(svc) {
  const r = express.Router({ mergeParams: true });
  const w = asyncHandler;

  r.post('/orders', w(async (req, res) => {
    const input = createOrderSchema.parse(req.body);
    res.status(201).json(ok(await svc.createOrder(input)));
  }));

  r.get('/orders/:orderId', w(async (req, res) => {
    res.json(ok(await svc.getOrder(req.params.orderId)));
  }));

  r.get('/orders', w(async (req, res) => {
    const q = listSchema.parse(req.query);
    res.json(ok(await svc.listOrders(q)));
  }));

  r.get('/orders/:orderId/timeline', w(async (req, res) => {
    res.json(ok(await svc.orderTimeline(req.params.orderId)));
  }));

  r.post('/orders/:orderId/cancel', w(async (req, res) => {
    const { userId } = z.object({ userId: z.string().min(1).max(32) }).parse(req.body || {});
    res.json(ok(await svc.cancel(req.params.orderId, userId)));
  }));

  return r;
}

module.exports = { OrderService, buildRouter, ORDER_TRANSITIONS, OrderRepository };
