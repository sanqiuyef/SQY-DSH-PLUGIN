/**
 * dsh-mcp-manager — project-scope MCP runtime.
 *
 * Global servers are Loader rows: they connect once, in the Host scope, and their
 * tools are visible to every Session. Project servers cannot work that way — a
 * project's `.dsh/mcp.json` must apply to *its* Sessions only. The host's own MCP
 * client supports that directly: mounted on an Agent's context, it reserves the
 * namespace inside that Agent's registration scope, so tools and transports are
 * isolated per Agent.
 *
 * This module therefore mounts one `@deepseek-ai/dsh-mcp-client` instance per
 * enabled project server **on `agent.ctx`**:
 *
 *   agent.ctx.plugin(mcpClient, { serverName, ...config })
 *
 * Lifecycle:
 *   - `agent/created` mounts the current set for the new Agent.
 *   - `agent/pre-step` re-reads the file (cheap: hash only when `stat` changed) so a
 *     page edit or a `git pull` applies on the next model step, in that Session.
 *   - `agent/disposed` (and this plugin's own disposal) unmounts everything.
 *
 * The trust gate lives in `project.js` → `project-trust.js` (unified store, contract §1):
 * an unapproved file mounts nothing. Mounting is non-blocking — `ctx.plugin()` returns its
 * Fiber immediately and the client connects inside it; a slow server delays its own tools,
 * never the Session start.
 *
 * 重名优先级（契约 §2）：**全局 > 项目**。挂载前先读全局占用集合（`global-mcp.js`），
 * 项目里的同名服务器直接跳过（全局优先），每个名字只 warn 一次，并把跳过名单记进
 * `agentState.skipped`，由 `projectRuntimeSnapshot()` 和 `GET /project` 暴露给前端。
 * 占用集合也算进挂载签名：全局连接状态一变，下一次 `agent/pre-step` 就会重新 reconcile。
 */

import { MCP_CLIENT_PACKAGE } from './patch.js';
import { profileDirOf } from './patch.js';
import { LAYER_TRUSTED } from './project-trust.js';
import {
  missingEnvReferences,
  projectRows,
  readProject,
  readProjectTrust,
  runtimeConfigOf,
} from './project.js';
import { globalMcpOccupancy, isShadowedByGlobal } from './global-mcp.js';
import { resolve } from 'node:path';

/** One cached module per plugin instance (HMR remounts create a new module). */
let modulePromise = null;

/** Per-Agent mounts: sessionId → { cwd, signature, servers, skipped, disposers }. */
const agentState = new Map();

/** Serializes syncs per Agent so two steps cannot mount twice. */
const syncQueues = new Map();

/** 「因为与全局同名而跳过」的只 warn 一次集合：`<cwd>\0<serverName>`。 */
const warnedSkips = new Set();

/** The last sync outcome per Agent, reported through `GET /project`. */
export function projectRuntimeSnapshot() {
  const sessions = [];
  for (const [sessionId, state] of agentState) {
    sessions.push({ sessionId, cwd: state.cwd, servers: state.servers, skipped: state.skipped ?? [] });
  }
  return { sessions };
}

/** Clear module state (tests / disposal). */
export function resetProjectRuntime() {
  for (const state of agentState.values()) state.disposers.splice(0).forEach(disposeQuietly);
  agentState.clear();
  syncQueues.clear();
  warnedSkips.clear();
  modulePromise = null;
}

/**
 * Resolve the host's MCP client module once.
 *
 * `ctx.loader.import()` resolves it the way the composition itself does, so the
 * project instances are the same code the global rows run.
 *
 * @param {object} ctx
 * @returns {Promise<object>} a Cordis-compatible plugin object
 */
async function loadMcpClient(ctx) {
  if (modulePromise !== null) return modulePromise;
  modulePromise = (async () => {
    const namespace =
      typeof ctx.loader?.import === 'function'
        ? await ctx.loader.import(MCP_CLIENT_PACKAGE)
        : await import(MCP_CLIENT_PACKAGE);
    const plugin = namespace?.default ?? namespace;
    if (plugin === null || typeof plugin !== 'object' || typeof plugin.apply !== 'function') {
      throw new Error(`${MCP_CLIENT_PACKAGE} did not export a plugin`);
    }
    return { name: MCP_CLIENT_PACKAGE, inject: plugin.inject ?? ['tools'], apply: plugin.apply, Config: plugin.Config };
  })().catch((error) => {
    modulePromise = null;
    throw error;
  });
  return modulePromise;
}

/** Unmount one Agent's project servers. */
function disposeAgent(sessionId) {
  const state = agentState.get(sessionId);
  if (state === undefined) return;
  agentState.delete(sessionId);
  state.disposers.splice(0).forEach(disposeQuietly);
}

function disposeQuietly(disposer) {
  try {
    if (typeof disposer === 'function') disposer();
    else if (typeof disposer?.dispose === 'function') disposer.dispose();
  } catch {
    /* one failed unmount must not keep the rest mounted */
  }
}

/**
 * 「项目服务器与全局同名、因此跳过挂载」只提示一次。
 *
 * 每个 `agent/pre-step` 都会重新 reconcile，若每次都 warn，日志会被同一句刷满。
 * 键包含项目目录，所以两个项目各自的冲突互不吞掉。
 */
function warnSkippedOnce(cwd, serverName) {
  const key = `${cwd}\u0000${serverName}`;
  if (warnedSkips.has(key)) return;
  warnedSkips.add(key);
  console.warn(
    `[mcp-manager] project ${cwd}: "${serverName}" is already provided by a global MCP server; ` +
      'skipping the project entry (global wins)',
  );
}

/**
 * The outcome of one sync, so a caller (the reconnect route) can report what
 * actually happened instead of assuming the mount succeeded.
 *
 * @typedef {{
 *   cwd: string, mounted: string[], failed: Array<{ serverName: string, error: string }>,
 *   skipped: string[], error: string|null, unchanged: boolean,
 * }} SyncOutcome
 */

/** Neutral outcome for the paths that decide nothing (no Session, no directory). */
function emptyOutcome(overrides = {}) {
  return { cwd: '', mounted: [], failed: [], skipped: [], error: null, unchanged: false, ...overrides };
}

/**
 * Read the project, decide the desired mount signature, and reconcile.
 *
 * @param {object} ctx - plugin context
 * @param {object} agent - live Agent (`agent.ctx`, `agent.session`)
 * @returns {Promise<SyncOutcome>}
 */
async function syncAgent(ctx, agent) {
  const session = agent?.session;
  if (session === undefined || session === null) return emptyOutcome();
  const sessionId = String(session.id);
  let cwd;
  try {
    cwd = ctx.workingDirectory.get(session);
  } catch {
    return emptyOutcome();
  }
  if (typeof cwd !== 'string' || cwd === '') return emptyOutcome();

  const view = await readProject(cwd);
  const trust = await readProjectTrust(profileDirOf(ctx), cwd);
  // 挂载只需要 mcp 这一层：canonical 命中，或旧 mcp-manager 记录命中（插件层与此无关）。
  const trusted = view.exists && view.error === null && trust.mcp === LAYER_TRUSTED;

  const enabled = Object.entries(view.data.mcpServers).filter(([name]) => !view.data.disabled.includes(name));
  // 重名判定只对「真的会被挂载」的条目有意义：没批准时一台都不会挂。
  const occupancy = trusted ? await globalMcpOccupancy(ctx) : { names: new Set(), tools: [] };
  const skipped = [];
  const mountable = [];
  for (const entry of enabled) {
    if (isShadowedByGlobal(entry[0], occupancy)) skipped.push(entry[0]);
    else mountable.push(entry);
  }

  // 签名里带上跳过名单：全局占用一变（连接完成、停用、改名），下一次 pre-step 就重新 reconcile。
  const signature = trusted
    ? `${cwd}\u0000${view.hash}\u0000${skipped.join(',')}`
    : `${cwd}\u0000untrusted`;

  const current = agentState.get(sessionId);
  if (current !== undefined && current.signature === signature) {
    return emptyOutcome({ cwd, mounted: [...current.servers], skipped: [...current.skipped], unchanged: true });
  }
  disposeAgent(sessionId);
  if (!trusted) return emptyOutcome({ cwd });

  for (const serverName of skipped) warnSkippedOnce(cwd, serverName);

  if (mountable.length === 0) {
    agentState.set(sessionId, { cwd, signature, servers: [], skipped, disposers: [], agent });
    return emptyOutcome({ cwd, skipped });
  }

  let plugin;
  try {
    plugin = await loadMcpClient(ctx);
  } catch (error) {
    const message = `${error?.message ?? error}`;
    console.warn(`[mcp-manager] project scope: cannot load ${MCP_CLIENT_PACKAGE}: ${message}`);
    // Every mountable server is a failure, not a silent skip: the reconnect caller
    // must be able to say so.
    return emptyOutcome({
      cwd,
      skipped,
      error: message,
      failed: mountable.map(([serverName]) => ({ serverName, error: message })),
    });
  }

  const disposers = [];
  const servers = [];
  const failed = [];
  for (const [serverName, config] of mountable) {
    const missing = missingEnvReferences(config);
    for (const item of missing) {
      console.warn(`[mcp-manager] project ${cwd}: ${serverName}.${item.field}.${item.key} references ${item.name}, which is not set`);
    }
    try {
      const fiber = agent.ctx.plugin(plugin, { serverName, ...runtimeConfigOf(config) });
      disposers.push(fiber);
      servers.push(serverName);
    } catch (error) {
      const message = `${error?.message ?? error}`;
      console.warn(`[mcp-manager] project ${cwd}: cannot mount ${serverName}: ${message}`);
      failed.push({ serverName, error: message });
    }
  }
  agentState.set(sessionId, { cwd, signature, servers, skipped, disposers, agent });
  return emptyOutcome({ cwd, mounted: servers, failed, skipped });
}

/**
 * Force one project server to reconnect in every live Session of that project.
 *
 * A project server is mounted per Agent, so "reconnect" means: dispose the
 * Agent's mounts, forget its signature, and sync again — `syncAgent` re-reads
 * `.dsh/mcp.json`, re-checks trust and mounts fresh `dsh-mcp-client` instances.
 *
 * Two consequences the caller must be told about, and the page says out loud:
 *
 *   - the whole set is remounted, not just `serverName`: per-Agent mounting has no
 *     per-server projection, so the other project servers of that Session restart
 *     too (`remountedServers` lists them);
 *   - it takes effect immediately, so a model step in progress loses its project
 *     tools for that Session.
 *
 * Mount failures are reported, never swallowed: `failed` carries each server the
 * runtime refused to mount, and `error` the module-load failure when there is one.
 *
 * @param {object} ctx
 * @param {string} cwd - absolute project directory
 * @param {string} serverName
 * @returns {Promise<{
 *   scope: 'project', cwd: string, serverName: string, remounted: number,
 *   remountedServers: string[], failed: Array<{ serverName: string, error: string }>,
 *   sessions: string[], error: string|null, reason: string|null,
 * }>}
 */
export async function remountProjectServer(ctx, cwd, serverName) {
  const target = resolve(cwd);
  const affected = [];
  for (const agent of liveAgents(ctx)) {
    const session = agent?.session;
    if (session === undefined || session === null) continue;
    let directory;
    try {
      directory = ctx.workingDirectory.get(session);
    } catch {
      continue;
    }
    if (typeof directory !== 'string' || directory === '' || resolve(directory) !== target) continue;
    affected.push({ sessionId: String(session.id), agent });
  }

  for (const item of affected) disposeAgent(item.sessionId);
  const outcomes = [];
  for (const item of affected) outcomes.push(await enqueue(ctx, item.agent));

  const mounted = [];
  const failed = [];
  let error = null;
  for (const outcome of outcomes) {
    if (outcome === undefined) continue;
    for (const name of outcome.mounted ?? []) if (!mounted.includes(name)) mounted.push(name);
    for (const item of outcome.failed ?? []) failed.push(item);
    if (error === null && typeof outcome.error === 'string') error = outcome.error;
  }

  return {
    scope: 'project',
    cwd: target,
    serverName,
    remounted: affected.length,
    remountedServers: mounted,
    failed,
    sessions: affected.map((item) => item.sessionId),
    error,
    reason: affected.length === 0 ? 'no live Session in this project; the next step reads the file again' : null,
  };
}

/** Live Agents from the host registry, tolerant of a missing/renamed service. */
function liveAgents(ctx) {
  try {
    const registry = typeof ctx.get === 'function' ? ctx.get('agents') : ctx.agents;
    const agents = typeof registry?.list === 'function' ? registry.list() : [];
    return Array.isArray(agents) ? agents : [];
  } catch {
    return [];
  }
}

/** Serialize syncs for one Agent (a pre-step must not race the creation mount). */
function enqueue(ctx, agent) {
  const sessionId = String(agent?.session?.id ?? '');
  if (sessionId === '') return Promise.resolve();
  const previous = syncQueues.get(sessionId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => syncAgent(ctx, agent))
    .catch((error) => {
      const message = `${error?.message ?? error}`;
      console.warn(`[mcp-manager] project scope sync failed: ${message}`);
      // A rejected sync is still an outcome the reconnect route must report.
      return emptyOutcome({ error: message });
    });
  syncQueues.set(sessionId, next);
  next.finally(() => {
    if (syncQueues.get(sessionId) === next) syncQueues.delete(sessionId);
  });
  return next;
}

/**
 * Mount the project-scope runtime on the plugin fiber.
 *
 * @param {object} ctx
 * @returns {() => void} disposer that removes listeners and unmounts every Agent
 */
export function mountProjectRuntime(ctx) {
  if (typeof ctx.on !== 'function') return () => {};
  const offCreated = ctx.on('agent/created', (payload) => enqueue(ctx, payload?.agent));
  const offDisposed = ctx.on('agent/disposed', (payload) => {
    disposeAgent(String(payload?.agent?.id ?? ''));
  });
  const offPreStep = ctx.on('agent/pre-step', async (payload, next) => {
    await enqueue(ctx, payload?.agent);
    return next();
  });

  return () => {
    offCreated?.();
    offDisposed?.();
    offPreStep?.();
    for (const sessionId of [...agentState.keys()]) disposeAgent(sessionId);
    syncQueues.clear();
  };
}

/** Rows for one already-read project (the route reuses this after reading). */
export function projectViewRows(view) {
  return projectRows(view);
}
