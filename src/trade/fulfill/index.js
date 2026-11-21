'use strict';
// =====================================================================
// 交易模块 — 权益域（Fulfill Module）
// 职责：支付成功后发放机器人/NT 权益；失败补偿重试
// 幂等：trade_entitlement.uk_order 唯一键（一单一权益）
// 解耦：发放动作抽象 EntitlementAdapter 接口（一期 Mock 落库，二期接账户系统）
// =====================================================================
const { nextId } = require('../../common');
const { err } = require('../../common');

// ---------------- 发放适配器（扩展点） ----------------
class MockEntitlementAdapter {
  /**
   * 模拟真实发放（机器人开通/NT 入账）。返回 true=成功。
   * 二期对接：实现同接口，内部调用 Workspace 账户服务（HTTP/RPC）。
   */
  async grant({ goodsType, goodsId, userId, quantity }) {
    if (!goodsType || !userId || !quantity) throw new Error('发放参数不完整');
    // Mock：直接成功（可用注入 failFn 模拟失败以测试补偿）
    return true;
  }
}

class FulfillRepository {
  constructor(db) { this.db = db; }

  _rowToEnt(r) {
    return {
      entitlementId: r.entitlement_id, orderId: r.order_id, goodsId: r.goods_id,
      goodsType: r.goods_type, userId: r.user_id, quantity: r.quantity,
      status: r.status, retryCount: Number(r.retry_count), lastError: r.last_error,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  /** 建待发放记录：uk_order 唯一键冲突 = 已存在 → 幂等跳过 */
  async insertPending(order) {
    try {
      await this.db.query(
        `INSERT INTO trade_entitlement (entitlement_id, order_id, goods_id, goods_type, user_id, quantity, status)
         VALUES (?,?,?,?,?,?, 'P')`,
        [nextId(), order.orderId, order.goodsId, order.goodsType, order.userId, order.quantity]);
      return true;
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') return false; // 幂等：重复回调/重试
      throw e;
    }
  }

  /** P/F → S（发放成功）条件更新 */
  async markGranted(orderId) {
    const [res] = await this.db.query(
      `UPDATE trade_entitlement SET status='S' WHERE order_id=? AND status IN ('P','F')`, [orderId]);
    return res.affectedRows === 1;
  }

  /** 失败重试计数：最多 N 次后停止（防雪崩） */
  async markFailed(orderId, reason) {
    await this.db.query(
      `UPDATE trade_entitlement SET status='F', retry_count=retry_count+1, last_error=? WHERE order_id=? AND status IN ('P','F')`,
      [String(reason).slice(0, 512), orderId]);
  }

  async findByOrder(orderId) {
    const [rows] = await this.db.query('SELECT * FROM trade_entitlement WHERE order_id=?', [orderId]);
    return this._rowToEnt(rows[0]);
  }

  /** 补偿任务扫描：待发放/失败且重试未超限 */
  async findPendingForRetry(limit = 100, maxRetry = 5) {
    const [rows] = await this.db.query(
      `SELECT * FROM trade_entitlement WHERE status IN ('P','F') AND retry_count < ? LIMIT ?`, [maxRetry, limit]);
    return rows.map((r) => this._rowToEnt(r));
  }
}

class FulfillService {
  constructor(db, adapter, auditBus) {
    this.repo = new FulfillRepository(db);
    this.adapter = adapter;   // EntitlementAdapter（注入）
    this.auditBus = auditBus;
    this.db = db;
  }

  /** 支付成功回调：建待发放（幂等）→ 立即尝试发放 */
  async onPaid(orderId, order) {
    const ent = await this.repo.insertPending(order);
    if (!ent) return { granted: false, reason: '已存在发放记录（幂等跳过）' };
    return this._grant({ entitlementId: null, orderId, goodsId: order.goodsId,
      goodsType: order.goodsType, userId: order.userId, quantity: order.quantity });
  }

  /** 补偿重试入口（TradeScheduler 周期调用） */
  async retryPending() {
    const pending = await this.repo.findPendingForRetry();
    const results = [];
    for (const ent of pending) {
      results.push(await this._grant(ent));
    }
    return results;
  }

  async getEntitlement(orderId) { return this.repo.findByOrder(orderId); }

  async _grant(ent) {
    try {
      const okFlag = await this.adapter.grant({
        goodsType: ent.goodsType, goodsId: ent.goodsId, userId: ent.userId, quantity: ent.quantity,
      });
      if (!okFlag) throw new Error('适配器返回失败');
      await this.repo.markGranted(ent.orderId);
      await this.auditBus.publish({ bizType: 'TRADE_ENTITLE', bizId: ent.orderId, action: 'ENTITLE_GRANT',
        before: null, after: { goodsType: ent.goodsType, quantity: ent.quantity }, operator: 'SYSTEM', traceId: ent.orderId });
      return { orderId: ent.orderId, granted: true };
    } catch (e) {
      await this.repo.markFailed(ent.orderId, e.message);
      await this.db.query(`INSERT INTO trade_event (order_id, event_type, payload) VALUES (?,?,?)`,
        [ent.orderId, 'ENTITLE_FAIL', JSON.stringify({ reason: String(e.message).slice(0, 200) })]);
      return { orderId: ent.orderId, granted: false, error: e.message };
    }
  }
}

module.exports = { FulfillService, MockEntitlementAdapter, FulfillRepository };
