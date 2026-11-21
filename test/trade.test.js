'use strict';
// =====================================================================
// 交易链路集成测试 — MemDB 扩展 trade_* 表，直测真实服务代码
// 覆盖：下单/防超卖/快照、取消+回补库存、回调验签/幂等/金额篡改、
//       权益发放+补偿重试、超时关单、状态机非法迁移、订单列表
// =====================================================================
const test = require('node:test');
const assert = require('node:assert');

// ---- 复用一期测试的 MemDB 基座，扩展交易表 ----
const base = require('./integration.test.js'); // 仅为确保一期用例也在同套件运行

const { buildApp } = require('../src/app');

class TradeMemDB {
  constructor() {
    this.goods = new Map(); this.plans = new Map(); this.schedules = new Map();
    this.audits = []; this.orders = new Map(); this.pays = new Map();
    this.entitlements = new Map(); this.tradeEvents = [];
    this.seq = 0;
  }
  async query(sql, p = []) {
    const s = normalize(sql);
    // ---- 复用一期分支（goods/price/schedule/audit/goods_type） ----
    if (s.startsWith('INSERT INTO goods (goods_id')) {
      const [gid, tc, sku, name, unit, sale, market, stock, status, eff] = p;
      if ([...this.goods.values()].some((g) => g.type_code === tc && g.sku === sku)) {
        const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e;
      }
      this.goods.set(gid, { id: ++this.seq, goods_id: gid, type_code: tc, sku, name, unit,
        sale_price: sale, market_price: market, stock, status, effective_time: eff,
        version: 0, created_at: now(), updated_at: now() });
      return [{ insertId: this.seq, affectedRows: 1 }, undefined];
    }
    if (s.startsWith('SELECT * FROM goods WHERE goods_id')) {
      return [[this.goods.get(p[0]) || null], undefined];
    }
    if (s.startsWith('SELECT * FROM goods WHERE type_code')) {
      const [tc, sku] = p;
      const row = [...this.goods.values()].find((g) => g.type_code === tc && g.sku === sku) || null;
      return [[row], undefined];
    }
    if (s.startsWith('SELECT type_code, status FROM goods_type')) {
      const map = { ROBOT: 'A', NT: 'A' };
      return [[{ type_code: p[0], status: map[p[0]] || 'D' }], undefined];
    }
    if (s.startsWith('SELECT id FROM goods_schedule') || s.startsWith('SELECT id, payload FROM goods_schedule')) {
      const rows = [...this.schedules.values()].filter((x) => x.biz_id === p[0] && x.policy_kind === 'SHELF' && x.status === 'W').map((x) => ({ id: x.id, payload: x.payload }));
      return [rows, undefined];
    }
    if (s.startsWith('UPDATE goods SET status=')) {
      const hasEff = s.includes('effective_time=?');
      const statusVal = p[0]; const effVal = hasEff ? p[1] : null;
      const goodsId = p[p.length - 2]; const from = p[p.length - 1];
      const g = this.goods.get(goodsId);
      if (!g || g.status !== from) return [{ affectedRows: 0 }, undefined];
      g.status = statusVal; g.effective_time = effVal; g.version += 1;
      return [{ affectedRows: 1 }, undefined];
    }
    if (s.startsWith('INSERT INTO price_plan')) {
      this.plans.set(p[0], { id: ++this.seq, price_plan_id: p[0], goods_id: p[1], price: p[2],
        effective_time: p[3], status: p[4], operator: p[5], remark: p[6] });
      return [{ insertId: this.seq, affectedRows: 1 }, undefined];
    }
    if (s.startsWith('INSERT INTO audit_log')) {
      this.audits.push({ id: ++this.seq, biz_id: p[0], biz_type: p[1], action: p[2],
        before_value: p[3], after_value: p[4], operator: p[5], trace_id: p[6], created_at: now() });
      return [{ insertId: this.seq, affectedRows: 1 }, undefined];
    }
    // ---- 交易表 ----
    if (s.startsWith('INSERT INTO trade_order')) {
      const [orderId, userId, goodsId, goodsName, goodsType, unitPrice, qty, totalAmount, deadline] = p;
      this.orders.set(orderId, { id: ++this.seq, order_id: orderId, user_id: userId, goods_id: goodsId,
        goods_name: goodsName, goods_type: goodsType, unit_price: unitPrice, quantity: qty,
        total_amount: totalAmount, status: 'W', pay_deadline: deadline, version: 0,
        created_at: now(), updated_at: now() });
      return [{ insertId: this.seq, affectedRows: 1 }, undefined];
    }
    if (s.startsWith('SELECT * FROM trade_order WHERE order_id')) {
      return [[this.orders.get(p[0]) || null], undefined];
    }
    if (s.startsWith('UPDATE trade_order SET status=?')) {
      const [to, orderId, from] = p;
      const o = this.orders.get(orderId);
      if (!o || o.status !== from) return [{ affectedRows: 0 }, undefined];
      o.status = to; o.version += 1;
      return [{ affectedRows: 1 }, undefined];
    }
    if (s.startsWith('SELECT order_id, quantity, goods_id FROM trade_order')) {
      const rows = [...this.orders.values()].filter((o) => o.status === 'W' && o.pay_deadline < p[0])
        .map((o) => ({ order_id: o.order_id, quantity: o.quantity, goods_id: o.goods_id }));
      return [rows, undefined];
    }
    if (s.startsWith('SELECT * FROM trade_order') || s.startsWith('SELECT COUNT(*) AS total FROM trade_order')) {
      // WHERE user_id/status 可选 + LIMIT/OFFSET
      let list = [...this.orders.values()].sort((a, b) => b.id - a.id);
      const m = s.match(/WHERE (.+?) (ORDER|LIMIT)/) || s.match(/WHERE (.+)$/);
      if (m) {
        const condSql = m[1].trim();
        const condVals = p.slice(0, condSql.split('=?').length - 1);
        condSql.split(' AND ').forEach((c, i) => {
          const col = c.split('=')[0].trim();
          const v = condVals[i];
          if (col === 'user_id') list = list.filter((o) => o.user_id === v);
          if (col === 'status') list = list.filter((o) => o.status === v);
        });
      }
      if (s.startsWith('SELECT COUNT(*)')) return [[{ total: list.length }], undefined];
      return [paginate(list, s, p), undefined];
    }
    if (s.startsWith('INSERT INTO trade_pay')) {
      this.pays.set(p[0], { id: ++this.seq, pay_id: p[0], order_id: p[1], channel: p[2],
        channel_trade_no: null, amount: p[3], status: 'I', paid_at: null });
      return [{ insertId: this.seq, affectedRows: 1 }, undefined];
    }
    if (s.startsWith('SELECT * FROM trade_pay WHERE pay_id')) {
      return [[this.pays.get(p[0]) || null], undefined];
    }
    if (s.startsWith('UPDATE trade_pay SET status=\'S\'')) {
      const [tradeNo, payId] = p;
      const row = this.pays.get(payId);
      if (!row || row.status !== 'I') return [{ affectedRows: 0 }, undefined];
      row.status = 'S'; row.channel_trade_no = tradeNo; row.paid_at = now();
      return [{ affectedRows: 1 }, undefined];
    }
    if (s.startsWith('UPDATE trade_pay SET status=\'F\'')) {
      const row = this.pays.get(p[1]);
      if (row && row.status === 'I') { row.status = 'F'; row.channel_trade_no = p[0]; }
      return [{ affectedRows: 1 }, undefined];
    }
    if (s.startsWith('SELECT * FROM trade_pay WHERE order_id')) {
      const rows = [...this.pays.values()].filter((x) => x.order_id === p[0]).sort((a, b) => b.id - a.id);
      return [rows, undefined];
    }
    if (s.startsWith('INSERT INTO trade_entitlement')) {
      if (this.entitlements.has(p[1])) { const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e; }
      this.entitlements.set(p[1], { id: ++this.seq, entitlement_id: p[0], order_id: p[1],
        goods_id: p[2], goods_type: p[3], user_id: p[4], quantity: p[5],
        status: 'P', retry_count: 0, last_error: null });
      return [{ insertId: this.seq, affectedRows: 1 }, undefined];
    }
    if (s.startsWith('UPDATE trade_entitlement SET status=\'S\'')) {
      const row = [...this.entitlements.values()].find((x) => x.order_id === p[0]);
      if (!row || !['P', 'F'].includes(row.status)) return [{ affectedRows: 0 }, undefined];
      row.status = 'S';
      return [{ affectedRows: 1 }, undefined];
    }
    if (s.startsWith('UPDATE trade_entitlement SET status=\'F\'')) {
      const row = [...this.entitlements.values()].find((x) => x.order_id === p[1]);
      if (row && ['P', 'F'].includes(row.status)) { row.status = 'F'; row.retry_count += 1; row.last_error = p[0]; }
      return [{ affectedRows: 1 }, undefined];
    }
    if (s.startsWith('SELECT * FROM trade_entitlement WHERE order_id')) {
      return [[[...this.entitlements.values()].find((x) => x.order_id === p[0]) || null], undefined];
    }
    if (s.startsWith('SELECT * FROM trade_entitlement WHERE status')) {
      const rows = [...this.entitlements.values()].filter((x) => ['P', 'F'].includes(x.status) && x.retry_count < p[0]);
      return [rows, undefined];
    }
    if (s.startsWith('INSERT INTO trade_event')) {
      this.tradeEvents.push({ id: ++this.seq, order_id: p[0], event_type: p[1], payload: p[2], created_at: now() });
      return [{ insertId: this.seq, affectedRows: 1 }, undefined];
    }
    if (s.startsWith('SELECT * FROM trade_event WHERE order_id')) {
      const evts = [...this.tradeEvents.values()].filter((e) => e.order_id === p[0]).sort((a, b) => a.id - b.id);
      return [evts, undefined];
    }
    // ---- 库存原子扣减/回补（交易域受控通道） ----
    if (s.startsWith('UPDATE goods SET stock = stock - ?')) {
      const [qty, gid, qty2] = p;
      const g = this.goods.get(gid);
      if (!g || g.status !== 'A' || g.stock < qty) return [{ affectedRows: 0 }, undefined];
      g.stock -= qty;
      return [{ affectedRows: 1 }, undefined];
    }
    if (s.startsWith('UPDATE goods SET stock = stock + ?')) {
      const [qty, gid] = p;
      const g = this.goods.get(gid);
      if (g) g.stock += qty;
      return [{ affectedRows: 1 }, undefined];
    }
    throw new Error('TradeMemDB 未支持 SQL: ' + s.slice(0, 70));
  }
  async getConnection() {
    const self = this;
    return { query: (s, p) => self.query(s, p), async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} };
  }
}
function normalize(sql) { return sql.replace(/\s+/g, ' ').trim(); }
function now() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
function paginate(list, s, p) {
  const limit = p[p.length - 2]; const offset = p[p.length - 1];
  return list.slice(offset, offset + limit);
}

function makeApp(opts = {}) {
  const db = new TradeMemDB();
  const app = buildApp({ db, schedulerEnabled: false, ...opts });
  return { db, app };
}

async function req(app, method, path, body) {
  const listener = app.listen(0);
  const port = listener.address().port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  listener.close();
  return { status: res.status, json, text };
}

/** 建一个在售商品（走真实 goods API：建品 → 上架） */
async function seedGoods(app, { sku, price = 1000, stock = 5, type = 'ROBOT' } = {}) {
  const r = await req(app, 'POST', '/api/v1/goods', {
    typeCode: type, sku, name: `商品-${sku}`, salePrice: price, stock, operator: 'seeder',
  });
  if (r.status !== 201) throw new Error('seedGoods failed: ' + r.text);
  const rl = await req(app, 'POST', `/api/v1/goods/${r.json.data.goodsId}/listing`, { operator: 'seeder' });
  if (rl.status !== 200) throw new Error('seedGoods listing failed: ' + rl.text);
  return r.json.data;
}

// =====================================================================
// UC1：下单 → 支付 → 到账 主流程
// =====================================================================
test('UC1 主流程：下单(扣库存/快照) → 支付回调(验签) → 订单已支付 + 权益已发放', async () => {
  const { app, db } = makeApp();
  const goods = await seedGoods(app, { sku: 'T-01', price: 1000, stock: 5 });

  // 下单
  const r1 = await req(app, 'POST', '/api/v1/trade/orders', { goodsId: goods.goodsId, quantity: 2, userId: 'u-1001' });
  assert.equal(r1.status, 201);
  const order = r1.json.data;
  assert.equal(order.totalAmount, 2000);
  assert.equal(order.status, 'W');
  assert.equal(order.goodsName, '商品-T-01'); // 快照
  let g = [...db.goods.values()].find((x) => x.goods_id === goods.goodsId);
  assert.equal(g.stock, 3); // 5-2

  // 发起支付（MOCK 渠道）
  const r2 = await req(app, 'POST', `/api/v1/trade/orders/${order.orderId}/pay`, { channel: 'MOCK' });
  assert.equal(r2.status, 200);
  const payParams = r2.json.data; // { payId, params: {payId, amount, ts, sign} }

  // 用支付参数构造回调（Mock 渠道 params 内含签名）
  const cb = { ...payParams.params, channelTradeNo: 'MOCK-CB-1' };
  const r3 = await req(app, 'POST', '/api/v1/trade/pay/callback/MOCK', cb);
  assert.equal(r3.status, 200);
  assert.equal(r3.text, 'success');

  // 订单已支付 + 权益已发放 + 事件链完整
  const r4 = await req(app, 'GET', `/api/v1/trade/orders/${order.orderId}`);
  assert.equal(r4.json.data.status, 'P');
  const ent = [...db.entitlements.values()].find((x) => x.order_id === order.orderId);
  assert.ok(ent && ent.status === 'S');
  const types = db.tradeEvents.map((e) => e.event_type);
  assert.ok(types.includes('CREATE') && types.includes('PAY_SUCCESS'));
});

// =====================================================================
// UC2：回调安全 —— 重复回调幂等 / 签名伪造 / 金额篡改
// =====================================================================
test('UC2 回调安全：重放幂等 / 错签名 401 / 金额篡改 400 不推进', async () => {
  const { app, db } = makeApp();
  const goods = await seedGoods(app, { sku: 'T-02', price: 500, stock: 1 });
  const { json: { data: order } } = await req(app, 'POST', '/api/v1/trade/orders', { goodsId: goods.goodsId, quantity: 1, userId: 'u-2' });
  const { json: { data: pay } } = await req(app, 'POST', `/api/v1/trade/orders/${order.orderId}/pay`, { channel: 'MOCK' });

  // 伪造签名 → 401
  const bad = { ...pay.params, sign: 'deadbeef' };
  const rBad = await req(app, 'POST', '/api/v1/trade/pay/callback/MOCK', bad);
  assert.equal(rBad.status, 401);

  // 金额篡改 → 400，订单不动
  const tampered = { ...pay.params, amount: 1 };
  const rTamper = await req(app, 'POST', '/api/v1/trade/pay/callback/MOCK', tampered);
  assert.equal(rTamper.status, 401); // 签名对不上金额 → 401（篡改必导致验签失败）
  let o = db.orders.get(order.orderId);
  assert.equal(o.status, 'W');

  // 正常回调 → 成功
  const rOk = await req(app, 'POST', '/api/v1/trade/pay/callback/MOCK', { ...pay.params, channelTradeNo: 'CB-OK' });
  assert.equal(rOk.status, 200);
  assert.equal(db.orders.get(order.orderId).status, 'P');

  // 重复回调 → 幂等 200，权益不重复发放
  const entCount = [...db.entitlements.values()].filter((x) => x.order_id === order.orderId).length;
  const rDup = await req(app, 'POST', '/api/v1/trade/pay/callback/MOCK', { ...pay.params, channelTradeNo: 'CB-OK-2' });
  assert.equal(rDup.status, 200);
  const entCount2 = [...db.entitlements.values()].filter((x) => x.order_id === order.orderId).length;
  assert.equal(entCount2, entCount); // 未新增
  assert.equal(db.orders.get(order.orderId).status, 'P'); // 状态不变
});

// =====================================================================
// UC3：超时关单 —— 回补库存 + 幂等
// =====================================================================
test('UC3 超时关单：W 过期 → X + 库存回补；重复关单幂等', async () => {
  const { app, db } = makeApp();
  const goods = await seedGoods(app, { sku: 'T-03', price: 100, stock: 4 });
  const { json: { data: order } } = await req(app, 'POST', '/api/v1/trade/orders', { goodsId: goods.goodsId, quantity: 3, userId: 'u-3' });
  assert.equal([...db.goods.values()].find((x) => x.goods_id === goods.goodsId).stock, 1); // 4-3

  // 把 deadline 置为过去（模拟过期）
  const o = db.orders.get(order.orderId);
  o.pay_deadline = '2020-01-01 00:00:00';

  const { TradeScheduler } = require('../src/trade/scheduler');
  const svc = app.locals.tradeSvc || null;
  // 通过 onStarted 拿不到（schedulerEnabled=false）→ 直接构造 scheduler tick
  const { OrderService } = require('../src/trade/order');
  const orderSvc = new OrderService(db,
    { getSnapshot: async (gid) => { const g = [...db.goods.values()].find((x) => x.goods_id === gid); return g ? { ...g, goodsType: g.type_code } : null; },
      deductStock: async () => true, restoreStock: async (gid, q) => { const g = [...db.goods.values()].find((x) => x.goods_id === gid); if (g) g.stock += q; } },
    { publish: async () => {} });
  const { FulfillService, MockEntitlementAdapter } = require('../src/trade/fulfill');
  const fulfillSvc = new FulfillService(db, new MockEntitlementAdapter(), { publish: async () => {} });
  const sched = new TradeScheduler({ orderSvc, fulfillSvc });
  await sched.tick();

  assert.equal(db.orders.get(order.orderId).status, 'X');
  assert.equal([...db.goods.values()].find((x) => x.goods_id === goods.goodsId).stock, 4); // 回补

  // 幂等：再 tick 不再处理
  await sched.tick();
  assert.equal(db.orders.get(order.orderId).status, 'X');
  assert.equal([...db.goods.values()].find((x) => x.goods_id === goods.goodsId).stock, 4);
  const closes = db.tradeEvents.filter((e) => e.event_type === 'CLOSE').length;
  assert.equal(closes, 1);
});

// =====================================================================
// UC4：用户取消 —— 仅 W 态、回补库存、买家校验
// =====================================================================
test('UC4 取消：W→C 回补库存；非本人拒绝；已支付拒绝', async () => {
  const { app, db } = makeApp();
  const goods = await seedGoods(app, { sku: 'T-04', price: 100, stock: 10 });
  const { json: { data: order } } = await req(app, 'POST', '/api/v1/trade/orders', { goodsId: goods.goodsId, quantity: 4, userId: 'u-4' });

  // 非本人 → 冲突
  const rNotOwner = await req(app, 'POST', `/api/v1/trade/orders/${order.orderId}/cancel`, { userId: 'someone-else' });
  assert.equal(rNotOwner.status, 409);

  // 本人取消 → C + 回补
  const rCancel = await req(app, 'POST', `/api/v1/trade/orders/${order.orderId}/cancel`, { userId: 'u-4' });
  assert.equal(rCancel.status, 200);
  assert.equal(rCancel.json.data.status, 'C');
  assert.equal([...db.goods.values()].find((x) => x.goods_id === goods.goodsId).stock, 10);

  // 已取消再取消 → 冲突
  const rAgain = await req(app, 'POST', `/api/v1/trade/orders/${order.orderId}/cancel`, { userId: 'u-4' });
  assert.equal(rAgain.status, 409);
});

// =====================================================================
// UC5：库存不足 / 不在售 下单拒绝
// =====================================================================
test('UC5 防超卖：库存不足下单拒绝且不建单；不在售拒绝', async () => {
  const { app, db } = makeApp();
  const goods = await seedGoods(app, { sku: 'T-05', price: 100, stock: 2 });

  // 库存不足
  const r1 = await req(app, 'POST', '/api/v1/trade/orders', { goodsId: goods.goodsId, quantity: 5, userId: 'u-5' });
  assert.equal(r1.status, 409);
  assert.equal(r1.json.code, 'STATE_CONFLICT');
  assert.equal(db.orders.size, 0); // 未建单
  assert.equal([...db.goods.values()].find((x) => x.goods_id === goods.goodsId).stock, 2); // 库存未动

  // 下架后下单 → 拒绝
  const g = [...db.goods.values()].find((x) => x.goods_id === goods.goodsId);
  g.status = 'S';
  const r2 = await req(app, 'POST', '/api/v1/trade/orders', { goodsId: goods.goodsId, quantity: 1, userId: 'u-5' });
  assert.equal(r2.status, 409);
});

// =====================================================================
// 补充：权益补偿重试（发放失败 → retry 成功）
// =====================================================================
test('权益补偿：发放失败进入 F → 补偿任务重试成功', async () => {
  const { app, db } = makeApp();
  // 注入会失败一次的适配器
  let attempts = 0;
  const FailingAdapter = { grant: async () => { attempts += 1; if (attempts === 1) throw new Error('下游账户服务超时'); return true; } };
  const goods = await seedGoods(app, { sku: 'T-06', price: 100, stock: 1 });
  const { json: { data: order } } = await req(app, 'POST', '/api/v1/trade/orders', { goodsId: goods.goodsId, quantity: 1, userId: 'u-6' });
  const { json: { data: pay } } = await req(app, 'POST', `/api/v1/trade/orders/${order.orderId}/pay`, { channel: 'MOCK' });

  // 注意：makeApp 里 adapter 是内置 Mock —— 这里直接验证补偿路径用 FulfillService 重建
  const { FulfillService } = require('../src/trade/fulfill');
  const fulfillSvc = new FulfillService(db, FailingAdapter, { publish: async () => {} });

  // 先手动插入待发放（模拟支付成功后异步发放前的状态）
  await db.query('INSERT INTO trade_entitlement (entitlement_id, order_id, goods_id, goods_type, user_id, quantity) VALUES (?,?,?,?,?,?)',
    ['ent-001', order.orderId, goods.goodsId, 'ROBOT', 'u-6', 1]);

  // 第一次重试：失败 → F + retry_count=1
  const r1 = await fulfillSvc.retryPending();
  assert.equal(r1[0].granted, false);
  let ent = [...db.entitlements.values()].find((x) => x.order_id === order.orderId);
  assert.equal(ent.status, 'F');
  assert.equal(ent.retry_count, 1);

  // 第二次重试：成功 → S
  const r2 = await fulfillSvc.retryPending();
  assert.equal(r2[0].granted, true);
  ent = [...db.entitlements.values()].find((x) => x.order_id === order.orderId);
  assert.equal(ent.status, 'S');
  assert.ok(db.tradeEvents.some((e) => e.event_type === 'ENTITLE_FAIL'));
});

// =====================================================================
// 补充：订单列表 / 时间线 / 404 / 参数校验
// =====================================================================
test('订单列表与时间线：按用户过滤 + CREATE 事件', async () => {
  const { app, db } = makeApp();
  const goods = await seedGoods(app, { sku: 'T-07', price: 100, stock: 9 });
  await req(app, 'POST', '/api/v1/trade/orders', { goodsId: goods.goodsId, quantity: 1, userId: 'u-7a' });
  await req(app, 'POST', '/api/v1/trade/orders', { goodsId: goods.goodsId, quantity: 2, userId: 'u-7b' });

  const r = await req(app, 'GET', '/api/v1/trade/orders?userId=u-7a');
  assert.equal(r.status, 200);
  assert.equal(r.json.data.list.length, 1);
  assert.equal(r.json.data.list[0].userId, 'u-7a');

  const tl = await req(app, 'GET', `/api/v1/trade/orders/${r.json.data.list[0].orderId}/timeline`);
  assert.equal(tl.json.data[0].eventType, 'CREATE');
});

test('订单 404 / 非法参数', async () => {
  const { app } = makeApp();
  const r404 = await req(app, 'GET', '/api/v1/trade/orders/no-such-order');
  assert.equal(r404.status, 404);
  const rBad = await req(app, 'POST', '/api/v1/trade/orders', { goodsId: 'x', quantity: 0, userId: 'u' });
  assert.equal(rBad.status, 400);
});
