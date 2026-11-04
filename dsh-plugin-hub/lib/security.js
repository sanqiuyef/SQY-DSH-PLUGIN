/**
 * dsh-plugin-hub — HTTP 安全原语（每条路由共用）。
 *
 * 三条规则写在同一个文件里，任何路由都不可能漏掉其中一条：
 *   1. 先问 `connection.requestRejection(request)`——这是宿主唯一的鉴权 + Host/Origin
 *      围栏（DNS rebinding / 跨站调用都在这里挡）。先应答后鉴权的本地 HTTP 端点等于裸奔。
 *   2. mutation 只收 POST + `application/json` + ≤64 KiB，边读边判，超限立刻拒绝。
 *   3. 响应里不得出现凭据：错误文本统一 `redact()`。
 */

import { redact } from './util.js';

/** mutation body 上限，与 dsh-mcp-manager 保持一致。 */
export const MAX_BODY_BYTES = 64 * 1024;

/** 契约里的错误码 → HTTP 状态。 */
export const STATUS_BY_CODE = Object.freeze({
  'bad-request': 400,
  'not-found': 404,
  'not-manageable': 409,
  conflict: 409,
  'config-invalid': 409,
  'lock-timeout': 409,
  'source-unreachable': 502,
  'source-invalid': 422,
  'source-empty': 422,
  'market-index-missing': 404,
  'market-index-invalid': 422,
  'market-index-unreadable': 422,
  'market-entry-invalid': 422,
  'market-source-unsupported': 422,
  'manifest-invalid': 422,
  'write-failed': 500,
  internal: 500,
});

/** 带错误码的失败，路由直接 `sendError` 即可。 */
export class ApiError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = typeof options.status === 'number' ? options.status : STATUS_BY_CODE[code] ?? 500;
    this.details = options.details;
  }
}

export const badRequest = (message, details) => new ApiError('bad-request', message, { details });
export const notFound = (message) => new ApiError('not-found', message);

/** 把任意 error 归一化成 ApiError（来源层抛的是带 code 的普通 Error）。 */
export function asApiError(error) {
  if (error instanceof ApiError) return error;
  const raw = typeof error?.code === 'string' ? error.code : '';
  const code = raw !== '' && Object.prototype.hasOwnProperty.call(STATUS_BY_CODE, raw) ? raw : 'internal';
  return new ApiError(code, error?.message ?? String(error), {});
}

/** 第一条围栏；返回 true 表示已经拒绝并结束响应。 */
export function rejectUnauthorized(ctx, request, response) {
  let rejection;
  try {
    rejection = ctx.connection?.requestRejection?.(request);
  } catch {
    rejection = 500;
  }
  if (rejection === undefined || rejection === null) return false;
  response.writeHead(Number(rejection) || 403, { 'cache-control': 'no-store' });
  response.end();
  return true;
}

/** JSON 响应；`no-store` 无条件，因为内容都是实时配置。 */
export function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

/** 错误响应；未知失败落 internal/500，不猜错误码。 */
export function sendError(response, error) {
  const apiError = asApiError(error);
  const body = { error: { code: apiError.code, message: redact(apiError.message) } };
  if (apiError.details !== undefined) body.error.details = apiError.details;
  sendJson(response, apiError.status, body);
}

/** 方法白名单；GET 也接受 HEAD。 */
export function requireMethod(request, response, method) {
  if (request.method === method || (method === 'GET' && request.method === 'HEAD')) return true;
  response.writeHead(405, { allow: method === 'GET' ? 'GET, HEAD' : method, 'cache-control': 'no-store' });
  response.end();
  return false;
}

/** mutation 只接受 application/json（text/plain 是免预检的 CSRF 友好类型）。 */
export function requireJson(request, response) {
  const type = String(request.headers['content-type'] ?? '').toLowerCase();
  if (type.startsWith('application/json')) return true;
  sendError(response, new ApiError('bad-request', 'mutating routes require application/json', { status: 415 }));
  return false;
}

/** 读取有上限的 JSON body。 */
export async function readJsonBody(request, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new ApiError('bad-request', `request body exceeds ${limit} bytes`, { status: 413 });
    chunks.push(chunk);
  }
  if (size === 0) throw new ApiError('bad-request', 'a JSON body is required');
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ApiError('bad-request', `the request body is not valid JSON: ${error.message}`);
  }
}

/** `cwd` 查询参数：必须是绝对路径（项目作用域写盘用），否则 400。 */
export function requireCwd(raw) {
  const cwd = typeof raw === 'string' ? raw.trim() : '';
  if (cwd === '') throw badRequest('"cwd" is required for project scope');
  if (!/^([A-Za-z]:[\\/]|\\\\|\/)/.test(cwd)) throw badRequest('"cwd" must be an absolute path');
  return cwd;
}
