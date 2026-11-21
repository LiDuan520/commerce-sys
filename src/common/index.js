'use strict';
// =====================================================================
// 公共模块（common）：横切关注点原子化 — 统一错误 / 统一响应 / 雪花ID / 时间
// 严禁在此出现任何业务语义（SRP：本文件只做技术支撑）
// =====================================================================

// ---------------- 错误体系 ----------------
/** 业务错误基类：携带稳定错误码，供统一异常中间件转 HTTP 响应 */
class BizError extends Error {
  constructor(code, message, httpStatus = 400, detail) {
    super(message);
    this.name = 'BizError';
    this.code = code;
    this.httpStatus = httpStatus;
    if (detail !== undefined) this.detail = detail;
  }
}

/** 稳定错误码：客户端按 code 处理，禁止直接透出异常堆栈 */
const ErrorCode = Object.freeze({
  PARAM_INVALID: 'PARAM_INVALID',        // 入参校验失败
  NOT_FOUND: 'NOT_FOUND',                // 资源不存在
  STATE_CONFLICT: 'STATE_CONFLICT',      // 状态机非法迁移/并发冲突
  DUPLICATE: 'DUPLICATE',                // 唯一性冲突（SKU 等）
  DUPLICATE_PLAN: 'DUPLICATE_PLAN',      // 已存在待生效计划
  INTERNAL: 'INTERNAL',                  // 系统内部错误（日志脱敏后对外只给 code）
});

/** 便捷工厂：保持各模块抛错风格统一 */
const err = {
  param: (msg, detail) => new BizError(ErrorCode.PARAM_INVALID, msg, 400, detail),
  notFound: (msg) => new BizError(ErrorCode.NOT_FOUND, msg, 404),
  conflict: (msg, detail) => new BizError(ErrorCode.STATE_CONFLICT, msg, 409, detail),
  duplicate: (msg) => new BizError(ErrorCode.DUPLICATE, msg, 409),
  duplicatePlan: (msg) => new BizError(ErrorCode.DUPLICATE_PLAN, msg, 409),
  internal: (msg) => new BizError(ErrorCode.INTERNAL, msg || '系统内部错误', 500),
};

// ---------------- 雪花 ID（趋势递增、无自增泄漏） ----------------
// 41bit 时间戳 + 10bit 机器ID + 12bit 序列；单实例单进程下保证不重
const SNOWFLAKE_EPOCH = 1735689600000; // 2025-01-01T00:00:00Z
const MACHINE_ID = 1;
let snowSeq = 0;
let snowLast = 0;
function nextId() {
  const now = Date.now();
  if (now === snowLast) {
    snowSeq = (snowSeq + 1) & 0xfff;             // 同毫秒序列耗尽 → 自旋到下一毫秒
    if (snowSeq === 0) {
      while (Date.now() <= now) { /* spin */ }
    }
  } else {
    snowSeq = 0;
    snowLast = now;
  }
  // 显式 BigInt 转换：41bit 时间戳 + 10bit 机器 + 12bit 序列
  const ts = BigInt(Date.now() - SNOWFLAKE_EPOCH) & ((1n << 41n) - 1n);
  const id = (ts << 22n) | (BigInt(MACHINE_ID) << 12n) | BigInt(snowSeq);
  return id.toString();
}

// ---------------- 分页（防御：参数由 zod 校验后传入） ----------------
function buildPage({ pageNo = 1, pageSize = 20 } = {}) {
  const size = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const no = Math.max(Number(pageNo) || 1, 1);
  return { offset: (no - 1) * size, limit: size, pageNo: no, pageSize: size };
}

// ---------------- 统一响应 ----------------
function ok(data) { return { code: 'OK', message: 'success', data }; }
function fail(code, message, detail) {
  const body = { code, message };
  if (detail !== undefined) body.detail = detail;
  return body;
}

// ---------------- 时间工具（显式 UTC，杜绝时区歧义） ----------------
function nowUTC() { return new Date(); }
function toDBTime(d) { return d.toISOString().slice(0, 19).replace('T', ' '); }

module.exports = {
  BizError, ErrorCode, err,
  nextId, buildPage, ok, fail,
  nowUTC, toDBTime,
};
