/**
 * dsh-skill-manager — the one error type every route maps to a response.
 *
 * The client switches on `code` for copy; `status` is the HTTP status the
 * envelope travels with. Anything that is not an `ApiError` becomes a 500.
 */

export class ApiError extends Error {
  /**
   * @param {string} code - machine code (`not-found`, `conflict`, …)
   * @param {string} message - fallback prose for the client
   * @param {number} [status] - HTTP status
   */
  constructor(code, message, status = 500) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export const badRequest = (message) => new ApiError('bad-request', message, 400);
export const forbidden = (message) => new ApiError('forbidden', message, 403);
export const readOnly = (message = '目标是只读根（bundled），不能修改') => new ApiError('read-only', message, 403);
export const notFound = (message) => new ApiError('not-found', message, 404);
export const conflict = (message) => new ApiError('conflict', message, 409);
export const exists = (message) => new ApiError('exists', message, 409);
export const tooLarge = (message) => new ApiError('too-large', message, 413);
