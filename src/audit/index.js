'use strict';
// =====================================================================
// 审计模块（Audit Module）—— 跨模块解耦核心：只消费「审计事件」契约
// 业务模块 publish 事件，本模块落库；双方互不 import 对方实现
// 失败策略：审计失败不阻断业务主流程（先记后补），但必须告警日志
// =====================================================================
const express = require('express');
const { z } = require('zod');
const { buildPage, ok, toDBTime } = require('../common');
const { asyncHandler } = require('../common/error-handler');

// ---------------- 事件总线（进程内实现，接口与实现分离 → 可换 MQ） ----------------
class InProcessAuditBus {
  constructor(auditService) { this.auditService = auditService; }
  async publish(event) {
    try {
      await this.auditService.record(event);
    } catch (e) {
      // 审计属于旁路：失败不回滚业务事务，降级为结构化告警日志（后续可接 MQ 重投）
      console.error('[AUDIT-DROP]', JSON.stringify(event), e.message);
    }
  }
}

// ---------------- 数据访问层 ----------------
class AuditRepository {
  constructor(db) { this.db = db; }
  async insert(evt) {
    await this.db.query(
      `INSERT INTO audit_log (biz_id, biz_type, action, before_value, after_value, operator, trace_id)
       VALUES (?,?,?,?,?,?,?)`,
      [evt.bizId, evt.bizType, evt.action,
       evt.before === null ? null : JSON.stringify(evt.before),
       evt.after === null ? null : JSON.stringify(evt.after),
       evt.operator, evt.traceId || null]
    );
  }
  async page({ bizType, bizId, operator }, { offset, limit }) {
    const cond = []; const vals = [];
    if (bizType) { cond.push('biz_type=?'); vals.push(bizType); }
    if (bizId) { cond.push('biz_id=?'); vals.push(bizId); }
    if (operator) { cond.push('operator=?'); vals.push(operator); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const [rows] = await this.db.query(
      `SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...vals, limit, offset]);
    const [[{ total }]] = await this.db.query(`SELECT COUNT(*) AS total FROM audit_log ${where}`, vals);
    return { list: rows.map((r) => ({
      id: r.id, bizId: r.biz_id, bizType: r.biz_type, action: r.action,
      before: r.before_value ? JSON.parse(r.before_value) : null,
      after: r.after_value ? JSON.parse(r.after_value) : null,
      operator: r.operator, traceId: r.trace_id, createdAt: r.created_at,
    })), total };
  }
}

// ---------------- 领域服务 ----------------
class AuditService {
  constructor(db) { this.repo = new AuditRepository(db); }
  async record(evt) {
    // 契约校验：事件结构非法直接抛（总线层降级为告警日志）
    if (!evt || !evt.bizId || !evt.bizType || !evt.action || !evt.operator) {
      throw new Error('非法审计事件：缺少必填字段');
    }
    await this.repo.insert(evt);
  }
  async list(query) {
    const page = buildPage(query);
    return { ...(await this.repo.page(query, page)), ...page };
  }
}

// ---------------- HTTP 层 ----------------
function buildRouter(svc) {
  const r = express.Router();
  const w = asyncHandler;
  r.get('/', w(async (req, res) => {
    const q = z.object({
      bizType: z.string().max(32).optional(),
      bizId: z.string().max(32).optional(),
      operator: z.string().max(64).optional(),
      pageNo: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
    }).parse(req.query);
    res.json(ok(await svc.list(q)));
  }));
  return r;
}

module.exports = { AuditService, InProcessAuditBus, buildRouter };
