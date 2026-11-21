'use strict';
// =====================================================================
// 公共模块：统一异常中间件 —— 所有路由的最后一道防线
// 防御性编程：未知异常脱敏（只回 code），已知 BizError 按 httpStatus 返回
// =====================================================================

const { BizError, ErrorCode, fail } = require('./index');

/** async 路由包装：Express 4 不捕获 Promise rejection，必须显式转 next(e) */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
/** Express 错误中间件（4 参签名，Express 自动识别） */
function errorHandler(errObj, _req, res, _next) {
  if (errObj instanceof BizError) {
    if (errObj.httpStatus >= 500) {
      console.error('[BIZ-5xx]', errObj.code, errObj.message);
    }
    return res.status(errObj.httpStatus).json(fail(errObj.code, errObj.message, errObj.detail));
  }
  // zod 校验错误 → 统一转 PARAM_INVALID
  if (errObj && errObj.name === 'ZodError') {
    return res.status(400).json(fail(ErrorCode.PARAM_INVALID, '参数校验失败', errObj.issues));
  }
  // mysql2 唯一键冲突（ER_DUP_ENTRY 1062）→ 409，避免泄漏 SQL 文本
  if (errObj && errObj.code === 'ER_DUP_ENTRY') {
    return res.status(409).json(fail(ErrorCode.DUPLICATE, '唯一性冲突：记录已存在'));
  }
  console.error('[UNEXPECTED]', errObj); // 服务端留全量日志
  return res.status(500).json(fail(ErrorCode.INTERNAL, '系统内部错误'));
}

/** 兜底：路径不存在（在 errorHandler 之前注册） */
function notFoundHandler(req, res) {
  res.status(404).json(fail(ErrorCode.NOT_FOUND, `路径不存在: ${req.method} ${req.path}`));
}

module.exports = { errorHandler, notFoundHandler, asyncHandler };
