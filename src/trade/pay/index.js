'use strict';
// =====================================================================
// 交易模块 — 支付域（Pay Module）
// 职责：发起支付 / 渠道回调验签 + 幂等 / 支付成功推进订单
// 解耦：渠道抽象 PaymentChannel 接口（Mock 实现，可换 WXPAY/ALIPAY 适配器）
// =====================================================================
const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const { err, nextId, ok } = require('../../common');
const { asyncHandler } = require('../../common/error-handler');

// ---------------- 渠道接口（扩展点：面向接口编程） ----------------
/**
 * PaymentChannel 契约：
 *  - code(): 渠道编码
 *  - createPay(payId, amount): 返回支付参数（交付给前端唤起支付）
 *  - verify(payload): 回调验签 → { payId, channelTradeNo, amount, ok, reason }
 */
class MockChannel {
  constructor(secret) { this.secret = secret || 'mock-channel-secret'; this._code = 'MOCK'; }
  code() { return this._code; }
  createPay(payId, amount) {
    // 沙箱语义：支付参数含回调所需全字段（payId/amount/ts/sign），
    // 前端拿它调用 callback 即完成支付；真实渠道替换为渠道收银台参数
    const ts = Date.now();
    const sign = this._sign(payId, amount, ts);
    return { channel: this._code, payId, amount, params: { payId, amount, ts, sign } };
  }
  verify(payload) {
    const { payId, amount, ts, sign, channelTradeNo } = payload || {};
    if (!payId || sign === undefined || ts === undefined) {
      return { ok: false, reason: '回调缺少必填字段' };
    }
    // 时间窗防重放：±5 分钟
    if (Math.abs(Date.now() - Number(ts)) > 5 * 60 * 1000) {
      return { ok: false, reason: '回调时间戳超出容许窗口' };
    }
    const expect = this._sign(payId, Number(amount), Number(ts));
    if (expect !== sign) return { ok: false, reason: '签名不匹配' };
    return { ok: true, payId, channelTradeNo: channelTradeNo || `MOCK-${payId}`, amount: Number(amount) };
  }
  /** HMAC-SHA256(payId|amount|ts, secret) —— 与真实渠道验签同构 */
  _sign(payId, amount, ts) {
    return crypto.createHmac('sha256', this.secret).update(`${payId}|${amount}|${ts}`).digest('hex');
  }
}

// ---------------- 仓储 ----------------
class PayRepository {
  constructor(db) { this.db = db; }

  _rowToPay(r) {
    if (!r) return null;
    return {
      payId: r.pay_id, orderId: r.order_id, channel: r.channel,
      channelTradeNo: r.channel_trade_no, amount: Number(r.amount), status: r.status,
      paidAt: r.paid_at, createdAt: r.created_at,
    };
  }

  async create(pay) {
    await this.db.query(
      `INSERT INTO trade_pay (pay_id, order_id, channel, amount, status) VALUES (?,?,?,?,'I')`,
      [pay.payId, pay.orderId, pay.channel, pay.amount]);
  }

  async findByPayId(payId) {
    const [rows] = await this.db.query('SELECT * FROM trade_pay WHERE pay_id=?', [payId]);
    return this._rowToPay(rows[0]);
  }

  async findByOrder(orderId) {
    const [rows] = await this.db.query('SELECT * FROM trade_pay WHERE order_id=? ORDER BY id DESC', [orderId]);
    return rows.map((r) => this._rowToPay(r));
  }

  /** 回调幂等核心：I→S 条件更新 + 回填渠道交易号；0 行 → 重复回调/状态不符 */
  async markSuccess(payId, channelTradeNo) {
    const [res] = await this.db.query(
      `UPDATE trade_pay SET status='S', channel_trade_no=?, paid_at=NOW() WHERE pay_id=? AND status='I'`,
      [channelTradeNo, payId]);
    return res.affectedRows === 1;
  }

  async markFail(payId, reason) {
    await this.db.query(
      `UPDATE trade_pay SET status='F', channel_trade_no=COALESCE(channel_trade_no, ?) WHERE pay_id=? AND status='I'`,
      [reason, payId]);
  }
}

// ---------------- 服务 ----------------
class PayService {
  /**
   * @param orderSvc    订单域服务（支付成功推进 W→P）
   * @param channels    渠道注册表 { code: PaymentChannel }
   * @param auditBus    审计总线
   */
  constructor(db, orderSvc, fulfillSvc, channels, auditBus) {
    this.db = db;
    this.repo = new PayRepository(db);
    this.orderSvc = orderSvc;
    this.fulfillSvc = fulfillSvc;
    this.channels = channels;
    this.auditBus = auditBus;
  }

  /** 发起支付：校验订单态（W）→ 建支付单 → 返回渠道支付参数 */
  async initiatePayment(orderId, channelCode) {
    const ch = this.channels[channelCode];
    if (!ch) throw err.param(`不支持的支付渠道: ${channelCode}`);
    const order = await this.orderSvc.getOrder(orderId);
    if (order.status !== 'W') throw err.conflict('仅待支付订单可发起支付');
    if (order.payDeadline.getTime() <= Date.now()) throw err.conflict('订单已超时，请重新下单');

    const payId = nextId();
    await this.repo.create({ payId, orderId, channel: ch.code(), amount: order.totalAmount });
    const params = ch.createPay(payId, order.totalAmount);
    return { payId, orderId, ...params };
  }

  /**
   * 渠道回调（核心安全路径）：
   * 1. 验签（渠道实现）→ 失败 4xx（不推进状态机）
   * 2. 支付单存在性 + 金额一致性校验（防篡改）
   * 3. I→S 条件更新幂等：重复回调直接成功返回（渠道语义要求）
   * 4. 推进订单 W→P + 触发权益发放（异步）
   */
  async handleCallback(channelCode, payload) {
    const ch = this.channels[channelCode];
    if (!ch) return { httpStatus: 400, body: 'unknown channel' };

    const v = ch.verify(payload);
    if (!v.ok) return { httpStatus: 401, body: `verify failed: ${v.reason}` };

    const pay = await this.repo.findByPayId(v.payId);
    if (!pay) return { httpStatus: 404, body: 'pay not found' };
    if (pay.amount !== v.amount) {
      // 金额篡改：记失败事件，绝不推进订单
      await this.repo.markFail(v.payId, `AMOUNT_MISMATCH:${v.amount}`);
      await this._event(pay.orderId, 'PAY_FAIL', { reason: 'AMOUNT_MISMATCH', expect: pay.amount, got: v.amount });
      return { httpStatus: 400, body: 'amount mismatch' };
    }

    // 幂等：I→S 只有第一次成功
    const first = await this.repo.markSuccess(v.payId, v.channelTradeNo);
    if (first) {
      // 推进订单 W→P（回调可能晚于关单 → 条件更新失败不抛错，人工对账路径）
      const moved = await this.orderSvc.repo.transition(pay.orderId, 'W', 'P');
      await this._event(pay.orderId, 'PAY_SUCCESS', { payId: v.payId, channel: channelCode, amount: v.amount });
      if (moved) {
        await this.auditBus.publish({ bizType: 'TRADE_PAY', bizId: v.payId, action: 'PAY_SUCCESS',
          before: { status: 'W' }, after: { status: 'P' }, operator: 'SYSTEM', traceId: pay.orderId });
        // 权益发放（uk_order 幂等，失败由补偿任务重试）
        const paidOrder = await this.orderSvc.getOrder(pay.orderId);
        await this.fulfillSvc.onPaid(pay.orderId, paidOrder);
      } else {
        // 已关单后收到回调：记录 PAY_LATE 语义（不重复发放，人工处理）
        await this._event(pay.orderId, 'PAY_FAIL', { reason: 'ORDER_NOT_PAYABLE', payId: v.payId });
      }
    }
    // 渠道要求：重复回调也回成功
    return { httpStatus: 200, body: 'success' };
  }

  async listPays(orderId) { return this.repo.findByOrder(orderId); }

  async _event(orderId, type, payload) {
    await this.db.query(`INSERT INTO trade_event (order_id, event_type, payload) VALUES (?,?,?)`,
      [orderId, type, JSON.stringify(payload)]);
  }
}

// ---------------- HTTP 层 ----------------
const initiateSchema = z.object({ channel: z.string().min(1).max(16) });

function buildRouter(svc) {
  const r = express.Router({ mergeParams: true });
  const w = asyncHandler;

  // 发起支付：POST /trade/orders/:orderId/pay
  r.post('/orders/:orderId/pay', w(async (req, res) => {
    const { channel } = initiateSchema.parse(req.body);
    res.json(ok(await svc.initiatePayment(req.params.orderId, channel)));
  }));

  // 渠道回调：POST /trade/pay/callback/:channel（成功恒 200 纯文本，失败 4xx 纯文本 —— 渠道网关语义）
  r.post('/pay/callback/:channel', w(async (req, res) => {
    const result = await svc.handleCallback(req.params.channel, req.body);
    res.status(result.httpStatus).send(result.body);
  }));

  return r;
}

module.exports = { PayService, MockChannel, buildRouter };
