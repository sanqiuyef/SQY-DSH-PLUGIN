/**
 * dsh-mcp-manager — restart one global MCP row without touching configuration.
 *
 * A global server is a Loader entry, and Cordis' Fiber exposes `restart()`, which
 * disposes and re-applies the plugin with its current config. That is exactly a
 * reconnect: `dsh-mcp-client`'s disposer stops the transport and its `apply()`
 * starts a fresh generation. No profile file is written, so enablement and config
 * stay byte-identical — the reason this is preferred over a
 * `setPluginEnabled(false)` / `setPluginEnabled(true)` pair, which would rewrite
 * the persisted disabled flag twice and leave the row disabled if the second
 * write failed.
 *
 * `restart()` is a public Fiber method (Cordis 4), and `entry.fiber` is the
 * Loader entry the host's own `configEditor.entries()` already exposes. When that
 * fiber is missing (a failed import) or the client's cleanup is incomplete,
 * `dsh-mcp-client` refuses the replacement; that refusal is reported as a 409
 * rather than retried, because it means "restart the Host".
 *
 * Absent HMR, the restart still works (it is a Fiber operation, not a profile
 * reload). When HMR is present the restart runs inside `hmr.runExclusive` so it
 * cannot interleave with a profile recompose.
 */

import { ApiError, badRequest } from './security.js';
import { MCP_CLIENT_PACKAGE } from './patch.js';

/** The host's plugin manager, or `undefined` when this composition has none. */
function pluginManagerOf(ctx) {
  return ctx.pluginManager ?? (typeof ctx.get === 'function' ? ctx.get('pluginManager') : undefined);
}

/** `serverName` from the evaluated config is the only field read there (not a secret). */
function serverNameOf(entry) {
  const evaluated = entry?.options?.config?.serverName;
  if (typeof evaluated === 'string' && evaluated !== '') return evaluated;
  const patchId = typeof entry?.options?.id === 'string' ? entry.options.id : null;
  return patchId !== null && patchId.startsWith('mcp-client-') ? patchId.slice('mcp-client-'.length) : patchId;
}

/** Run `operation` under the HMR lock when the profile has one. */
async function exclusive(ctx, operation) {
  const hmr = typeof ctx.get === 'function' ? ctx.get('hmr') : undefined;
  if (hmr !== undefined && typeof hmr.runExclusive === 'function') return hmr.runExclusive(operation);
  return operation();
}

/**
 * Restart one global MCP entry.
 *
 * @param {object} ctx - plugin context (needs `configEditor`; `pluginManager` optional)
 * @param {{ entryId?: string, patchId?: string }} target
 * @returns {Promise<{
 *   scope: 'global', entryId: string, patchId: string|null, serverName: string|null,
 *   restarted: true, fiberPhase: string|null, diagnostic: string|null,
 * }>}
 */
export async function reconnectGlobalServer(ctx, target) {
  const entryId = typeof target?.entryId === 'string' && target.entryId !== '' ? target.entryId : null;
  const patchId = typeof target?.patchId === 'string' && target.patchId !== '' ? target.patchId : null;
  if (entryId === null && patchId === null) throw badRequest('expected "entryId" or "patchId"');

  const editor = ctx.configEditor;
  if (editor === undefined) throw new ApiError('not-manageable', 'the config editor is not mounted in this host');

  const entries = editor.entries();
  const entry =
    entryId !== null
      ? entries.find((candidate) => String(candidate.id) === entryId)
      : entries.find((candidate) => candidate.options?.id === patchId);
  if (entry === undefined) {
    throw new ApiError('not-found', entryId !== null ? `no plugin entry with id "${entryId}"` : `no MCP entry with patchId "${patchId}"`);
  }
  if (entry.options?.name !== MCP_CLIENT_PACKAGE) {
    throw new ApiError('not-manageable', `entry "${String(entry.id)}" is not an MCP server row`);
  }

  // Read enablement first: restarting a disabled row would silently contradict the
  // switch the page is showing.
  const manager = pluginManagerOf(ctx);
  let before;
  if (manager !== undefined) {
    try {
      before = (await manager.listPlugins()).find((row) => String(row.entryId) === String(entry.id));
    } catch {
      before = undefined;
    }
  }
  if (before !== undefined && before.enabled !== true) {
    throw new ApiError('conflict', 'the server is disabled; enable it before reconnecting');
  }

  const fiber = entry.fiber;
  if (fiber === undefined || fiber === null || typeof fiber.restart !== 'function') {
    throw new ApiError(
      'not-manageable',
      'this entry has no live fiber (its module did not load); fix the configuration or restart the Host',
    );
  }

  try {
    await exclusive(ctx, () => fiber.restart());
  } catch (error) {
    throw new ApiError('conflict', `the host could not restart the server: ${error?.message ?? error}`);
  }

  let after;
  if (manager !== undefined) {
    try {
      after = (await manager.listPlugins()).find((row) => String(row.entryId) === String(entry.id));
    } catch {
      after = undefined;
    }
  }

  return {
    scope: 'global',
    entryId: String(entry.id),
    patchId: typeof entry.options?.id === 'string' ? entry.options.id : null,
    serverName: serverNameOf(entry) ?? null,
    restarted: true,
    fiberPhase: typeof after?.fiberPhase === 'string' ? after.fiberPhase : null,
    diagnostic: typeof after?.diagnostic === 'string' ? after.diagnostic : null,
  };
}
