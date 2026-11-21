'use strict';
// =====================================================================
// 定时调度器（Scheduler）—— 独立原子组件：统一轮询到期计划
// 职责：每 tick 扫描 SHELF / PRICE 两类待生效计划，回调模块幂等 apply 方法
// 说明：单实例 setInterval；多实例部署时需换 DB 分布式锁（扩展点）
// =====================================================================

class Scheduler {
  /**
   * @param goodsSvc    商品模块服务（applyShelfPlan 幂等）
   * @param priceSvc    价格模块服务（applyDuePlan 幂等）
   * @param scheduleRepo goods_schedule 仓储（SHELF 计划数据源）
   * @param intervalMs  轮询周期
   */
  constructor({ goodsSvc, priceSvc, scheduleRepo, intervalMs = 5000 }) {
    this.goodsSvc = goodsSvc;
    this.priceSvc = priceSvc;
    this.scheduleRepo = scheduleRepo;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = false;
  }

  start() {
    // tick 重入保护：上一轮未完成则跳过本轮（防慢查询堆积）
    this.timer = setInterval(() => {
      this.tick().catch((e) => console.error('[SCHEDULER-ERR]', e));
    }, this.intervalMs);
    this.timer.unref?.(); // 不阻塞进程退出
    return this;
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      // 1) 定时上下架计划（goods_schedule）
      const due = await this.scheduleRepo.findDue(new Date());
      for (const plan of due) {
        const r = await this.goodsSvc.applyShelfPlan(plan);
        if (!r.applied) console.warn('[SHELF-PLAN-SKIP]', plan.id, r.reason);
      }
      // 2) 定时调价方案（price_plan，经 priceSvc 查询到期方案）
      const duePrices = await this.priceSvc.findDuePlans(new Date());
      for (const plan of duePrices) {
        const r = await this.priceSvc.applyDuePlan(plan);
        if (!r.applied) console.warn('[PRICE-PLAN-SKIP]', plan.pricePlanId, r.reason);
      }
    } finally {
      this.running = false;
    }
  }
}

module.exports = { Scheduler };
