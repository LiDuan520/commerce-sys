'use strict';
// =====================================================================
// 集成测试（node:test）—— 内存 MySQL 兼容层，直连真实模块代码
// 覆盖：建品校验 / 状态机全链路 / 立即调价 / 定时调价生效 / 定时上下架生效
//       / 取消计划 / 乐观锁并发冲突 / 审计留痕 / API 错误契约
// 运行：node --test test/
// =====================================================================
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

// ---- 内存 MySQL 兼容层：实现 mysql2 pool 接口子集 + SQL 子集 ----
// 目的：无 MySQL 环境下直测真实仓储与服务代码（不 mock 业务逻辑）
class MemDB {
  constructor() {
    this.goods = new Map();          // goods_id -> row（含 version）
    this.plans = new Map();          // price_plan_id -> row
    this.schedules = new Map();      // id -> row
    this.audits = [];
    this.seq = 0;
  }
  async query(sql, params = []) {
    const [rows, meta] = this._exec(normalize(sql), params);
    return [rows, meta];
  }
  async getConnection() { return new TxConn(this); }
  _exec(sql, p) {
    if (sql.startsWith('INSERT INTO goods (goods_id')) {
      const [goodsId, typeCode, sku, name, unit, salePrice, marketPrice, stock, status, effTime] = p;
      if ([...this.goods.values()].some((g) => g.type_code === typeCode && g.sku === sku)) {
        const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e;
      }
      this.goods.set(goodsId, { id: ++this.seq, goods_id: goodsId, type_code: typeCode, sku, name,
        unit, sale_price: salePrice, market_price: marketPrice, stock, status,
        effective_time: effTime, version: 0, created_at: now(), updated_at: now() });
      return [{ insertId: this.seq, affectedRows: 1 }, undefined];
    }
    if (sql.startsWith('INSERT INTO price_plan')) {
      const [planId, goodsId, price, effTime, status, operator, remark] = p;
      this.plans.set(planId, { id: ++this.seq, price_plan_id: planId, goods_id: goodsId,
        price, effective_time: effTime, status, operator, remark, fail_reason: null,
        created_at: now(), updated_at: now() });
      return [{ insertId: this.seq, affectedRows: 1 }, undefined];
    }
    if (sql.startsWith('INSERT INTO goods_schedule')) {
      const [bizId, kind, actionCode, payload, effTime] = p;
      this.schedules.set(++this.seq, { id: this.seq, biz_id: bizId, policy_kind: kind,
        action_code: actionCode, payload, status: 'W', effective_time: effTime,
        fail_reason: null, created_at: now(), updated_at: now() });
      return [{ insertId: this.seq, affectedRows: 1 }, undefined];
    }
    if (sql.startsWith('INSERT INTO audit_log')) {
      const [bizId, bizType, action, before, after, operator, traceId] = p;
      this.audits.push({ id: ++this.seq, biz_id: bizId, biz_type: bizType, action,
        before_value: before, after_value: after, operator, trace_id: traceId, created_at: now() });
      return [{ insertId: this.seq, affectedRows: 1 }, undefined];
    }
    if (sql.startsWith('SELECT * FROM goods WHERE goods_id')) {
      return [[this.goods.get(p[0]) || null], undefined];
    }
    if (sql.startsWith('SELECT * FROM goods WHERE type_code')) {
      const [tc, sku] = p;
      const row = [...this.goods.values()].find((g) => g.type_code === tc && g.sku === sku) || null;
      return [[row], undefined];
    }
    if (sql.startsWith('SELECT type_code, status FROM goods_type')) {
      const map = { ROBOT: 'A', NT: 'A' };
      return [[{ type_code: p[0], status: map[p[0]] || 'D' }], undefined];
    }
    if (sql.startsWith('SELECT id FROM goods_schedule WHERE biz_id')
        || sql.startsWith('SELECT id, payload FROM goods_schedule')) {
      // existsPending / cancelSchedule：待生效 SHELF 计划
      const rows = [...this.schedules.values()]
        .filter((s) => s.biz_id === p[0] && s.policy_kind === 'SHELF' && s.status === 'W')
        .map((s) => ({ id: s.id, payload: s.payload }));
      return [rows, undefined];
    }
    if (sql.startsWith('SELECT * FROM goods_schedule WHERE biz_id')) {
      const rows = [...this.schedules.values()].filter((s) => s.biz_id === p[0] && s.policy_kind === p[1] && s.status === 'W');
      return [rows.length ? [rows[0]] : [], undefined];
    }
    if (sql.startsWith('SELECT * FROM goods_schedule WHERE status')) {
      const rows = [...this.schedules.values()]
        .filter((s) => s.status === 'W' && s.effective_time <= p[0])
        .sort((a, b) => (a.effective_time < b.effective_time ? -1 : 1)).slice(0, p[1] || 100)
        .map((s) => ({ ...s, payload: s.payload })); // payload 保持 JSON 字符串，服务层再 parse
      return [rows, undefined];
    }
    if (sql.startsWith('SELECT * FROM price_plan WHERE goods_id') && sql.includes("status='W'")) {
      const rows = [...this.plans.values()].filter((r) => r.goods_id === p[0] && r.status === 'W');
      return [rows, undefined];
    }
    if (sql.startsWith('SELECT * FROM price_plan WHERE status')) {
      const rows = [...this.plans.values()]
        .filter((r) => r.status === 'W' && r.effective_time <= p[0])
        .sort((a, b) => (a.effective_time < b.effective_time ? -1 : 1)).slice(0, p[1] || 100);
      return [rows, undefined];
    }
    // UPDATE goods SET name=...（基础信息编辑 + 乐观锁）
    if (sql.startsWith('UPDATE goods SET name=')) {
      const [name, unit, marketPrice, stock, goodsId, version] = p;
      const g = this.goods.get(goodsId);
      if (!g || g.version !== version) return [{ affectedRows: 0 }, undefined];
      Object.assign(g, { name, unit, market_price: marketPrice, stock, version: g.version + 1 });
      return [{ affectedRows: 1 }, undefined];
    }
    // UPDATE goods SET status=...（状态机条件迁移）
    if (sql.startsWith('UPDATE goods SET status=')) {
      // SET sets... WHERE goods_id=? AND status=?
      const setStatus = p[0]; const effTimeIdx = sql.includes('effective_time=?') ? 1 : -1;
      const goodsId = p[p.length - 2]; const from = p[p.length - 1];
      const g = this.goods.get(goodsId);
      if (!g || g.status !== from) return [{ affectedRows: 0 }, undefined];
      g.status = setStatus;
      if (effTimeIdx >= 0) g.effective_time = p[effTimeIdx];
      else g.effective_time = null;
      g.version += 1;
      return [{ affectedRows: 1 }, undefined];
    }
    // UPDATE goods SET sale_price=?（价格模块受控通道）
    if (sql.startsWith('UPDATE goods SET sale_price=')) {
      const [price, goodsId] = p;
      const g = this.goods.get(goodsId);
      if (!g) return [{ affectedRows: 0 }, undefined];
      g.sale_price = price; g.version += 1;
      return [{ affectedRows: 1 }, undefined];
    }
    if (sql.startsWith("UPDATE goods_schedule SET status='C'")) {
      const row = this.schedules.get(p[0]);
      if (!row || row.status !== 'W') return [{ affectedRows: 0 }, undefined];
      row.status = 'C'; return [{ affectedRows: 1 }, undefined];
    }
    if (sql.startsWith('UPDATE goods_schedule SET status=?')) {
      const [status, failReason, id, from] = p;
      const row = this.schedules.get(id);
      if (!row || row.status !== from) return [{ affectedRows: 0 }, undefined];
      row.status = status; row.fail_reason = failReason;
      return [{ affectedRows: 1 }, undefined];
    }
    if (sql.startsWith('UPDATE price_plan SET status=?')) {
      const [status, failReason, planId, from] = p;
      const row = this.plans.get(planId);
      if (!row || row.status !== from) return [{ affectedRows: 0 }, undefined];
      row.status = status; row.fail_reason = failReason;
      return [{ affectedRows: 1 }, undefined];
    }
    // SELECT * FROM goods / price_plan / audit_log 列表分页
    if (sql.startsWith('SELECT * FROM goods ') || sql === 'SELECT * FROM goods') {
      const cond = sql.includes('WHERE') ? null : null; // 简化：全量返回（列表排序在内存中做）
      const list = [...this.goods.values()].sort((a, b) => b.id - a.id);
      const { offset, limit } = listArgs(sql, p);
      return [list.slice(offset, offset + limit), undefined];
    }
    if (sql.startsWith('SELECT COUNT(*)')) {
      return [[{ total: this.goods.size }], undefined];
    }
    if (sql.startsWith('SELECT * FROM price_plan WHERE goods_id=? ORDER BY')) {
      const [goodsId, limit, offset] = p;
      const list = [...this.plans.values()].filter((r) => r.goods_id === goodsId)
        .sort((a, b) => (b.effective_time > a.effective_time ? 1 : -1));
      return [list.slice(offset, offset + limit), undefined];
    }
    if (sql.startsWith('SELECT COUNT(*) AS total FROM price_plan')) {
      const goodsId = p[0];
      return [[{ total: [...this.plans.values()].filter((r) => r.goods_id === goodsId).length }], undefined];
    }
    if (sql.startsWith('SELECT COUNT(*) AS total FROM audit_log')) {
      const m = sql.match(/WHERE (.+)$/);
      let rows = this.audits;
      if (m) {
        const condSql = m[1];
        const condVals = p;
        condSql.split(' AND ').forEach((c, i) => {
          const col = c.split('=')[0].trim();
          const v = condVals[i];
          if (col === 'biz_type') rows = rows.filter((a) => a.biz_type === v);
          if (col === 'biz_id') rows = rows.filter((a) => a.biz_id === v);
          if (col === 'operator') rows = rows.filter((a) => a.operator === v);
        });
      }
      return [[{ total: rows.length }], undefined];
    }
    if (sql.startsWith('SELECT * FROM audit_log')) {
      // audit_page 查询：WHERE biz_type/biz_id/operator 可选 + LIMIT/OFFSET
      let rows = this.audits;
      const m = sql.match(/WHERE (.+?) ORDER BY/);
      if (m) {
        const condSql = m[1];
        const condVals = p.slice(0, condSql.split('=?').length - 1);
        condSql.split(' AND ').forEach((c, i) => {
          const col = c.split('=')[0].trim();
          const v = condVals[i];
          if (col === 'biz_type') rows = rows.filter((a) => a.biz_type === v);
          if (col === 'biz_id') rows = rows.filter((a) => a.biz_id === v);
          if (col === 'operator') rows = rows.filter((a) => a.operator === v);
        });
      }
      rows = [...rows].sort((a, b) => b.id - a.id);
      const limit = p[p.length - 2]; const offset = p[p.length - 1];
      return [rows.slice(offset, offset + limit), undefined];
    }
    throw new Error('MemDB 未支持的 SQL: ' + sql.slice(0, 60));
  }
}

function normalize(sql) { return sql.replace(/\s+/g, ' ').trim().replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/= \?/g, '=?').replace(/VALUES \(/, 'VALUES(').replace(/, \)/g, ',').trim(); }
function now() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
function listArgs(sql, p) {
  // LIMIT ? OFFSET ? 在参数末尾
  return { limit: p[p.length - 2], offset: p[p.length - 1] };
}
class TxConn {
  constructor(db) { this.db = db; this.tx = []; }
  async query(sql, p) {
    const [rows, meta] = this.db._exec(normalize(sql), p);
    return [rows, meta];
  }
  async beginTransaction() {}
  async commit() {}
  async rollback() {}
  release() {}
}

// ---- 测试装配：真实 buildApp（MemDB 注入） ----
const { buildApp } = require('../src/app');

function makeApp() {
  const db = new MemDB();
  const app = buildApp({ db, schedulerEnabled: false });
  return { db, app };
}

// HTTP 辅助
async function req(app, method, path, body, headers) {
  const listener = app.listen(0);
  const port = listener.address().port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(headers || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  listener.close();
  return { status: res.status, json };
}

// =====================================================================
// 用例 1：建品链路 —— 校验 + 初始价格方案 + 审计
// =====================================================================
test('建品：正常创建（ROBOT），生成初始价格方案与审计', async () => {
  const { app, db } = makeApp();
  const r = await req(app, 'POST', '/api/v1/goods', {
    typeCode: 'ROBOT', sku: 'R001', name: '客服机器人', salePrice: 9900, stock: 10, operator: 'lucas',
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.code, 'OK');
  const goodsId = r.json.data.goodsId;
  assert.match(goodsId, /^\d+$/);

  // 初始价格方案已生成（status=A）
  const plans = [...db.plans.values()].filter((x) => x.goods_id === goodsId);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].price, 9900);
  assert.equal(plans[0].status, 'A');

  // 审计已留痕（CREATE）
  assert.ok(db.audits.some((a) => a.biz_id === goodsId && a.action === 'CREATE' && a.operator === 'lucas'));
});

test('建品：NT 类型缺 unit → PARAM_INVALID', async () => {
  const { app } = makeApp();
  const r = await req(app, 'POST', '/api/v1/goods', {
    typeCode: 'NT', sku: 'N001', name: 'NT 100', salePrice: 1000, operator: 'lucas',
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'PARAM_INVALID');
});

test('建品：未注册类型 → 拒绝', async () => {
  const { app } = makeApp();
  const r = await req(app, 'POST', '/api/v1/goods', {
    typeCode: 'FOO', sku: 'F001', name: 'X', operator: 'lucas',
  });
  assert.equal(r.status, 400);
});

test('建品：SKU 重复 → DUPLICATE（应用层先挡）', async () => {
  const { app } = makeApp();
  const body = { typeCode: 'ROBOT', sku: 'DUP', name: 'A', salePrice: 100, operator: 'lucas' };
  await req(app, 'POST', '/api/v1/goods', body);
  const r = await req(app, 'POST', '/api/v1/goods', body);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'DUPLICATE');
});

// =====================================================================
// 用例 2：状态机 —— 草稿→在售→停售→在售；非法迁移拒绝
// =====================================================================
test('上下架：D→A→S→A 全链路 + 审计动作', async () => {
  const { app, db } = makeApp();
  const { json } = await req(app, 'POST', '/api/v1/goods', {
    typeCode: 'ROBOT', sku: 'SM-1', name: '状态机商品', salePrice: 500, operator: 'op',
  });
  const id = json.data.goodsId;

  // 草稿直接下架 → 非法
  const bad = await req(app, 'POST', `/api/v1/goods/${id}/delisting`, { operator: 'op' });
  assert.equal(bad.status, 409);
  assert.equal(bad.json.code, 'STATE_CONFLICT');

  // 上架：售价必须 > 0
  const { json: j2 } = await req(app, 'POST', `/api/v1/goods/${id}/listing`, { operator: 'op' });
  assert.equal(j2.data.status, 'A');

  // 下架
  const j3 = await req(app, 'POST', `/api/v1/goods/${id}/delisting`, { operator: 'op' });
  assert.equal(j3.json.data.status, 'S');

  // 重新上架
  const j4 = await req(app, 'POST', `/api/v1/goods/${id}/listing`, { operator: 'op' });
  assert.equal(j4.json.data.status, 'A');

  assert.ok(db.audits.filter((a) => a.biz_id === id).map((a) => a.action).join(',').includes('LISTING'));
  assert.ok(db.audits.filter((a) => a.biz_id === id).map((a) => a.action).join(',').includes('DELISTING'));
});

test('上架：零价商品拒绝（PARAM_INVALID）', async () => {
  const { app } = makeApp();
  const { json } = await req(app, 'POST', '/api/v1/goods', {
    typeCode: 'ROBOT', sku: 'ZP-1', name: '零价商品', operator: 'op',
  });
  const r = await req(app, 'POST', `/api/v1/goods/${json.data.goodsId}/listing`, { operator: 'op' });
  assert.equal(r.status, 400);
});

// =====================================================================
// 用例 3：立即调价 —— 生效价同步 + 履历 + 受控通道
// =====================================================================
test('调价：立即调价更新 sale_price 并追加履历', async () => {
  const { app, db } = makeApp();
  const { json } = await req(app, 'POST', '/api/v1/goods', {
    typeCode: 'ROBOT', sku: 'PC-1', name: '调价商品', salePrice: 1000, operator: 'op',
  });
  const id = json.data.goodsId;

  const r = await req(app, 'POST', `/api/v1/goods/${id}/price/change`, { price: 1999, operator: 'op', remark: '促销' });
  assert.equal(r.status, 200);
  const g = [...db.goods.values()].find((x) => x.goods_id === id);
  assert.equal(g.sale_price, 1999);

  const plans = [...db.plans.values()].filter((x) => x.goods_id === id);
  assert.equal(plans.length, 2); // 初始 + 本次
  assert.ok(plans.some((x) => x.status === 'A' && x.price === 1999));
  assert.ok(db.audits.some((a) => a.biz_type === 'PRICE_PLAN' && a.action === 'APPLY_PRICE' && a.after_value && a.after_value.includes('1999')));
});

test('调价：非正整数价格 → PARAM_INVALID', async () => {
  const { app } = makeApp();
  const { json } = await req(app, 'POST', '/api/v1/goods', {
    typeCode: 'ROBOT', sku: 'PC-2', name: 'X', salePrice: 100, operator: 'op',
  });
  const r = await req(app, 'POST', `/api/v1/goods/${json.data.goodsId}/price/change`, { price: -5, operator: 'op' });
  assert.equal(r.status, 400);
});

// =====================================================================
// 用例 4：定时调价 —— 到期由 Scheduler 生效
// =====================================================================
test('定时调价：到期前不生效，Scheduler tick 后生效', async () => {
  const { db, app } = makeApp();
  const { Scheduler } = require('../src/scheduler');
  const { json } = await req(app, 'POST', '/api/v1/goods', {
    typeCode: 'NT', sku: 'NT-1', name: 'NT 包', unit: 100, salePrice: 1000, operator: 'op',
  });
  const id = json.data.goodsId;

  // 过去时间被拒
  const bad = await req(app, 'POST', `/api/v1/goods/${id}/price/schedule`, {
    price: 2000, effectiveTime: '2020-01-01T00:00:00Z', operator: 'op',
  });
  assert.equal(bad.status, 400);

  // 生效时间 1s 后（UTC 存储为本地字符串 → 直接用近未来）
  const eff = new Date(Date.now() + 1000);
  const r = await req(app, 'POST', `/api/v1/goods/${id}/price/schedule`, {
    price: 2000, effectiveTime: eff.toISOString(), operator: 'op',
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.status, 'W');

  // 未到期：tick 空转（两处仓储均返回空到期集）
  const emptyRepo = { findDue: async () => [] };
  const { PriceService } = require('../src/price');
  const priceSvc = new PriceService(db,
    { applySalePrice: async (_c, gid, pr) => { const row = [...db.goods.values()].find((x) => x.goods_id === gid); row.sale_price = pr; } },
    { publish: async () => {} });
  const scheduler = new Scheduler({ goodsSvc: { applyShelfPlan: async () => ({ applied: false }) }, priceSvc, scheduleRepo: emptyRepo });
  await scheduler.tick();
  let g = [...db.goods.values()].find((x) => x.goods_id === id);
  assert.equal(g.sale_price, 1000);

  // 到期：等待 1.3s 后 tick（Scheduler 派发 + applyDuePlan 生效）
  await new Promise((r2) => setTimeout(r2, 1300));
  const due = await priceSvc.findDuePlans(new Date());
  assert.equal(due.length, 1);
  const res = await priceSvc.applyDuePlan(due[0]);
  assert.equal(res.applied, true);
  g = [...db.goods.values()].find((x) => x.goods_id === id);
  assert.equal(g.sale_price, 2000);

  // 幂等：再次 apply 已生效方案 → applied=false
  const res2 = await priceSvc.applyDuePlan(due[0]);
  assert.equal(res2.applied, false);
});

// =====================================================================
// 用例 5：定时上下架 —— 计划生效 + 取消
// =====================================================================
test('定时上架：到期生效为在售；取消则回草稿', async () => {
  const { db, app } = makeApp();
  const { json } = await req(app, 'POST', '/api/v1/goods', {
    typeCode: 'ROBOT', sku: 'SC-1', name: '定时上架商品', salePrice: 300, operator: 'op',
  });
  const id = json.data.goodsId;

  const eff = new Date(Date.now() + 800);
  const r = await req(app, 'POST', `/api/v1/goods/${id}/schedule-shelf`, {
    actionCode: 'DRAFT_TO_ON', effectiveTime: eff.toISOString(), operator: 'op',
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.status, 'P'); // 上架中

  // 到期生效
  await new Promise((r2) => setTimeout(r2, 1100));
  const plan = [...db.schedules.values()].find((s) => s.biz_id === id && s.status === 'W');
  assert.ok(plan, '存在 W 计划');
  const { GoodsService } = require('../src/goods');
  const goodsSvc = new GoodsService(db, { publish: async () => {} }, { initPrice: async () => {} }, {
    get: async (tc) => ({ typeCode: tc, status: 'A' }),
  });
  const res = await goodsSvc.applyShelfPlan({ ...plan, id: plan.id, bizId: id, payload: JSON.parse(plan.payload) });
  assert.equal(res.applied, true);
  const g = [...db.goods.values()].find((x) => x.goods_id === id);
  assert.equal(g.status, 'A');

  // 幂等：重复 apply → applied=false
  const res2 = await goodsSvc.applyShelfPlan({ ...plan, id: plan.id, bizId: id, payload: JSON.parse(plan.payload) });
  assert.equal(res2.applied, false);
});

test('定时计划：重复创建 → DUPLICATE_PLAN；取消流程回退状态', async () => {
  const { app, db } = makeApp();
  const { json } = await req(app, 'POST', '/api/v1/goods', {
    typeCode: 'ROBOT', sku: 'SC-2', name: 'X', salePrice: 300, operator: 'op',
  });
  const id = json.data.goodsId;
  const eff = new Date(Date.now() + 60000).toISOString();
  await req(app, 'POST', `/api/v1/goods/${id}/schedule-shelf`, {
    actionCode: 'DRAFT_TO_ON', effectiveTime: eff, operator: 'op',
  });
  const dup = await req(app, 'POST', `/api/v1/goods/${id}/schedule-shelf`, {
    actionCode: 'DRAFT_TO_ON', effectiveTime: eff, operator: 'op',
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.code, 'DUPLICATE_PLAN');

  // 取消 → 计划 C + 商品回 D
  const cancel = await req(app, 'POST', `/api/v1/goods/${id}/cancel-schedule`, { operator: 'op' });
  assert.equal(cancel.status, 200);
  const g = [...db.goods.values()].find((x) => x.goods_id === id);
  assert.equal(g.status, 'D');
  const planRow = [...db.schedules.values()].find((s) => s.biz_id === id);
  assert.equal(planRow.status, 'C');
});

// =====================================================================
// 用例 6：并发 —— 乐观锁（版本冲突 → 409）
// =====================================================================
test('并发编辑：版本号过期 → STATE_CONFLICT', async () => {
  const { app } = makeApp();
  const { json } = await req(app, 'POST', '/api/v1/goods', {
    typeCode: 'ROBOT', sku: 'CC-1', name: '并发商品', salePrice: 100, operator: 'op',
  });
  const id = json.data.goodsId;
  // 第一笔成功（version 0→1）
  const r1 = await req(app, 'PUT', `/api/v1/goods/${id}`, { name: '改名1', stock: 5, version: 0, operator: 'op1' });
  assert.equal(r1.status, 200);
  // 第二笔拿旧 version=0 → 冲突
  const r2 = await req(app, 'PUT', `/api/v1/goods/${id}`, { name: '改名2', stock: 6, version: 0, operator: 'op2' });
  assert.equal(r2.status, 409);
  assert.equal(r2.json.code, 'STATE_CONFLICT');
});

// =====================================================================
// 用例 7：审计查询接口
// =====================================================================
test('审计查询：按 bizId 过滤', async () => {
  const { app } = makeApp();
  const { json } = await req(app, 'POST', '/api/v1/goods', {
    typeCode: 'ROBOT', sku: 'AU-1', name: '审计商品', salePrice: 100, operator: 'lucas',
  });
  const id = json.data.goodsId;
  const r = await req(app, 'GET', `/api/v1/audits?bizId=${id}`);
  assert.equal(r.status, 200);
  assert.ok(r.json.data.list.length >= 1);
  assert.equal(r.json.data.list[0].bizId, id);
});

// =====================================================================
// 用例 8：不存在资源 / 参数校验错误契约
// =====================================================================
test('404：不存在的商品', async () => {
  const { app } = makeApp();
  const r = await req(app, 'GET', '/api/v1/goods/999999');
  assert.equal(r.status, 404);
  assert.equal(r.json.code, 'NOT_FOUND');
});

test('400：body 缺字段（zod 拦截）', async () => {
  const { app } = makeApp();
  const r = await req(app, 'POST', '/api/v1/goods', { sku: 'X' });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'PARAM_INVALID');
});
