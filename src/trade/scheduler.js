'use strict';
// =====================================================================
// 交易调度器（TradeScheduler）—— 独立原子组件
// 职责：1) 超时关单（W→X + 回补库存） 2) 权益发放补偿重试
// 幂等：全部条件更新 / 唯一键；tick 重入保护同一期 Scheduler
// =====================================================================

class TradeScheduler {
  /**
   * @param orderSvc   订单域服务（closeExpired 幂等）
   * @param fulfillSvc 权益域服务（retryPending）
   */
  constructor({ orderSvc, fulfillSvc, intervalMs = 30000 }) {
    this.orderSvc = orderSvc;
    this.fulfillSvc = fulfillSvc;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = false;
  }

  start() {
    this.timer = setInterval(() => {
      this.tick().catch((e) => console.error('[TRADE-SCHEDULER-ERR]', e));
    }, this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      // 1) 超时关单：W 且 pay_deadline 已过
      const expired = await this.orderSvc.findExpired();
      for (const order of expired) {
        const r = await this.orderSvc.closeExpired(order);
        if (!r.applied) console.warn('[TRADE-CLOSE-SKIP]', order.orderId, r.reason);
      }
      // 2) 权益发放补偿
      const retried = await this.fulfillSvc.retryPending();
      for (const r of retried) {
        if (!r.granted) console.warn('[ENTITLE-RETRY-FAIL]', r.orderId, r.error);
      }
    } finally {
      this.running = false;
    }
  }
}

module.exports = { TradeScheduler };
