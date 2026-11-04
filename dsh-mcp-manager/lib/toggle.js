/**
 * dsh-mcp-manager — enable/disable one MCP row through the host's own manager.
 *
 * This is the one mutation with a first-class host API
 * (`pluginManager.setPluginEnabled(entryId, enabled)`), and it is strictly better
 * than writing the patch: it persists the loader's `disabled` flag, applies it live
 * through HMR, and returns how the application actually went. The plugin therefore
 * never hand-writes an enablement change.
 *
 * `application` is the answer, not a formality: `applied`
 * means hot, `restart-required` carries `restartReason` (`no-hmr`,
 * `package-moved`, ...), `overridden` means a higher-priority layer pins the row, and
 * `failed`/`cancelled` mean the change did not take. A caller that ignores it will
 * show a switch that lies.
 */

import { ApiError, badRequest } from './security.js';
import { MCP_CLIENT_PACKAGE } from './patch.js';

/** The host's plugin manager, or `undefined` when this composition has none. */
function pluginManagerOf(ctx) {
  return ctx.pluginManager ?? (typeof ctx.get === 'function' ? ctx.get('pluginManager') : undefined);
}

/** A short, non-secret summary of a `ChangeResult.error`. */
function changeErrorSummary(error) {
  if (error === null || typeof error !== 'object') return String(error ?? 'unknown');
  const code = typeof error.code === 'string' ? error.code : null;
  const diagnostic = typeof error.diagnostic === 'string' ? error.diagnostic : null;
  return [code, diagnostic].filter((part) => part !== null && part !== '').join(': ') || 'unknown';
}

/**
 * Enable or disable one MCP row.
 *
 * @param {object} ctx - plugin context (needs `pluginManager`)
 * @param {string} entryId - the Loader entry id (`listPlugins().entryId`)
 * @param {boolean} enabled
 * @returns {Promise<{ changed: boolean, application: string|null, restartReason: string|null }>}
 */
export async function setServerEnabled(ctx, entryId, enabled) {
  if (typeof entryId !== 'string' || entryId === '') throw badRequest('"entryId" must be a non-empty string');
  if (typeof enabled !== 'boolean') throw badRequest('"enabled" must be a boolean');

  const manager = pluginManagerOf(ctx);
  if (manager === undefined) throw new ApiError('write-failed', 'the plugin manager is not mounted in this host');

  // Resolve and classify the target first, so an unknown id is a 404 and a
  // read-only row is a 409, instead of the manager's own failure surfacing as 500.
  const rows = await manager.listPlugins();
  const row = rows.find((candidate) => String(candidate.entryId) === entryId);
  if (row === undefined) throw new ApiError('not-found', `no plugin entry with id "${entryId}"`);
  if (row.moduleName !== MCP_CLIENT_PACKAGE) {
    throw new ApiError('not-manageable', `entry "${entryId}" is not an MCP server row`);
  }
  if (row.patchId === undefined) {
    throw new ApiError(
      'not-manageable',
      `entry "${entryId}" cannot be managed by the profile patch (${row.readOnlyReason ?? 'management-required'})`,
    );
  }

  let result;
  try {
    result = await manager.setPluginEnabled(entryId, enabled);
  } catch (error) {
    throw new ApiError('conflict', `the host refused the change: ${error?.message ?? error}`);
  }

  const application = typeof result?.application === 'string' ? result.application : null;
  const restartReason = typeof result?.restartReason === 'string' ? result.restartReason : null;
  if (application === 'failed') {
    throw new ApiError('conflict', `the host could not apply the change: ${changeErrorSummary(result?.error)}`);
  }
  if (application === 'cancelled') throw new ApiError('conflict', 'the host cancelled the change');

  return { changed: result?.changed === true, application, restartReason };
}

/** The largest batch one request may carry — the page never lists more than this. */
export const MAX_BATCH_ENTRIES = 200;

/**
 * Enable or disable several rows in one request.
 *
 * The loop is sequential on purpose: `setPluginEnabled` writes the profile manifest
 * and lets HMR recompose, so two concurrent calls would race the same files. Each
 * row reports its own outcome; one failure does not stop the rest, and the caller
 * gets the full `results` list plus a `failed` count instead of a bare error. That
 * is what lets the page show "9 of 10 disabled" rather than guessing.
 *
 * @param {object} ctx
 * @param {string[]} entryIds
 * @param {boolean} enabled
 * @returns {Promise<{
 *   enabled: boolean, requested: number, changed: number, failed: number,
 *   results: Array<{ entryId: string, ok: boolean, changed?: boolean, application?: string|null,
 *     restartReason?: string|null, error?: { code: string, message: string } }>,
 * }>}
 */
export async function setServersEnabled(ctx, entryIds, enabled) {
  if (!Array.isArray(entryIds) || entryIds.length === 0) throw badRequest('"entryIds" must be a non-empty array');
  if (entryIds.length > MAX_BATCH_ENTRIES) throw badRequest(`"entryIds" must hold at most ${MAX_BATCH_ENTRIES} ids`);
  if (typeof enabled !== 'boolean') throw badRequest('"enabled" must be a boolean');

  const results = [];
  for (const entryId of entryIds) {
    if (typeof entryId !== 'string' || entryId === '') {
      results.push({ entryId: String(entryId), ok: false, error: { code: 'bad-request', message: 'entry id must be a non-empty string' } });
      continue;
    }
    try {
      const outcome = await setServerEnabled(ctx, entryId, enabled);
      results.push({ entryId, ok: true, ...outcome });
    } catch (error) {
      results.push({
        entryId,
        ok: false,
        error: {
          code: error instanceof ApiError ? error.code : 'unknown',
          message: String(error?.message ?? error),
        },
      });
    }
  }

  return {
    enabled,
    requested: entryIds.length,
    changed: results.filter((row) => row.ok && row.changed === true).length,
    failed: results.filter((row) => row.ok !== true).length,
    results,
  };
}
