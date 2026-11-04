/**
 * dsh-plugin-hub / projection — per-Agent 编排层。
 *
 * 职责：把「当前 cwd 下生效的插件集合」（由外部注入的 `resolveEffective(cwd)` 算出来）
 * 投影到每个活着的 Agent 上。投影单元有四类（skills / commands / hooks / mcp），
 * 每类**每个插件一个**挂载单元，单元名带 pluginId（如 `plugin-hub:skills:zotero`），
 * 这样卸载与诊断都能定位到「哪个插件的哪类能力」。
 *
 * 生命周期（与 dsh-mcp-manager 的 project-runtime 同构）：
 *   - `agent/created`  → 为该 Agent 挂一遍当前生效集合（串行等待，首个 step 前就绪）；
 *   - `agent/pre-step` → 重新解析并比对签名，变了就「先卸后挂」；
 *   - `agent/disposed` → 该 Agent 的全部单元卸载；
 *   - 本插件自己的 disposer → 摘事件监听 + 卸载所有 Agent。
 *
 * 幂等的关键：**签名**。签名 = cwd + 生效插件集合（id / 绝对根路径 / 各组件数量）+
 * 每个插件 options 的稳定哈希 + 因 MCP 重名而跳过的条目。签名没变就一个挂载动作都不做，
 * 所以 pre-step 每步调用也不会反复 plugin()/dispose()。
 *
 * MCP 重名优先级（契约 §2）：全局（mcp-manager / profile patch）> 项目（受信任的
 * `.dsh/mcp.json`）> 插件。占用集合由 lib/occupancy.js 算出后进入签名——全局服务器晚
 * 连接、项目信任状态变化都会改变「跳过名单」，下一次 pre-step 自然重新 reconcile。
 * 同一 Agent 内两个插件声明同名 server 仍是「后到跳过」（保留旧行为）。
 *
 * 三条边界：
 *   1. 不自己读盘判断「生效」——一律走注入的 `resolveEffective`，避免与 store/scope
 *      的信任门、作用域合并逻辑出现两套真相。
 *   2. `resolveEffective` 抛错不崩、不写签名，下一次 sync 自然重试。
 *   3. 子代理不继承投影（agent.ctx 的 scope 只覆盖该 Agent 本身，已知边界）。
 */

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { collectOccupancy, shadowingSource } from '../occupancy.js';
import { nowIso } from '../util.js';
import { createCommandsUnit } from './commands.js';
import { createHooksUnit } from './hooks.js';
import { collectMcpServers, defaultPluginDataDir, loadMcpClient, normalizeServerName, resetMcpModuleCache } from './mcp.js';
import { createSkillsUnit } from './skills.js';

/** 诊断/日志前缀（SPEC §7：只在失败/降级处 warn）。 */
const LOG_PREFIX = '[plugin-hub]';

/** per-Agent 挂载状态：sessionId → { cwd, signature, units, conflicts }。 */
const agentState = new Map();

/** per-Agent 串行队列：sessionId → Promise。防止 created 与 pre-step 并发重复挂载。 */
const syncQueues = new Map();

/**
 * 运行期挂载失败的环形缓冲。
 *
 * 投影失败过去只进 `console.warn`：页面全绿，用户只看到「技能怎么没出现」。
 * 这里把**每一轮 reconcile 的实际结果**记下来供 overview/插件详情展示；
 * 同一 cwd 下一轮挂载开始时会先清空（成功即消失），所以它表示"最近一次结果"，
 * 不是审计日志。上限 100 条足够覆盖几十个项目的当前状态。
 */
const PROJECTION_ERROR_LIMIT = 100;
const projectionErrorLog = [];

/** 记录一次挂载失败（`extra` 用于 MCP 这类同一插件多服务器的场景）。 */
function recordProjectionError(cwd, pluginId, kind, error, extra = {}) {
  if (typeof cwd !== 'string' || cwd === '') return;
  projectionErrorLog.push({
    cwd,
    pluginId: String(pluginId ?? ''),
    kind,
    code: typeof error?.code === 'string' && error.code !== '' ? error.code : 'mount-failed',
    message: String(error?.message ?? error),
    at: nowIso(),
    ...extra,
  });
  if (projectionErrorLog.length > PROJECTION_ERROR_LIMIT) {
    projectionErrorLog.splice(0, projectionErrorLog.length - PROJECTION_ERROR_LIMIT);
  }
}

/** 清掉某个 cwd 的上一轮错误（下一轮会按实际结果重新记录）。 */
function clearProjectionErrors(cwd) {
  const key = cwdKey(cwd);
  for (let index = projectionErrorLog.length - 1; index >= 0; index -= 1) {
    if (cwdKey(projectionErrorLog[index].cwd) === key) projectionErrorLog.splice(index, 1);
  }
}

/**
 * 最近一次 reconcile 的挂载失败（按 cwd 过滤，省略 cwd = 全部）。
 *
 * 同一 (cwd, 插件, 能力, 错误码) 只返回最近一条：页面要回答的是「现在为什么没挂上」。
 *
 * @param {string} [cwd]
 * @returns {Array<{ cwd: string, pluginId: string, kind: string, code: string,
 *   message: string, at: string, serverName?: string }>}
 */
export function projectionErrors(cwd) {
  const wanted = typeof cwd === 'string' && cwd !== '' ? cwdKey(cwd) : null;
  const latest = new Map();
  for (const item of projectionErrorLog) {
    if (wanted !== null && cwdKey(item.cwd) !== wanted) continue;
    const key = `${cwdKey(item.cwd)}\u0000${item.pluginId}\u0000${item.kind}\u0000${item.code}`;
    latest.set(key, item);
  }
  return [...latest.values()]
    .map((item) => ({ ...item }))
    .sort((left, right) => (left.at < right.at ? 1 : left.at > right.at ? -1 : 0));
}

/** 供路由/诊断读取的当前投影快照。 */
export function projectionSnapshot() {
  const sessions = [];
  for (const [sessionId, state] of agentState) {
    sessions.push({
      sessionId,
      cwd: state.cwd,
      signature: state.signature,
      units: state.units.map((unit) => ({ name: unit.name, kind: unit.kind, pluginId: unit.pluginId })),
      conflicts: (state.conflicts ?? []).map((item) => ({ ...item })),
    });
  }
  return { sessions };
}

/**
 * 因「与全局/项目 MCP 同名」而跳过的条目，按 cwd 去重。
 *
 * 两路来源的合并（供 overview.mcpConflicts 与插件详情共用）：
 *   - 本函数：投影运行时**真的跳过**过的条目（含未落盘的当前 Agent 状态）；
 *   - `conflictsForPlugins`：还没跑过会话时按生效插件 + 占用表做的 dry-run。
 * 返回行固定带 `cwd`，同一个 cwd 下的同一处冲突只出现一次（多个会话共享一份投影）。
 *
 * @param {string} [cwd] 只看这个项目；省略 = 全部
 * @returns {Array<{ cwd: string, pluginId: string, serverName: string, source: string }>}
 */
export function projectionConflicts(cwd) {
  const wanted = typeof cwd === 'string' && cwd !== '' ? cwdKey(cwd) : null;
  const seen = new Set();
  const out = [];
  for (const state of agentState.values()) {
    const key = cwdKey(state.cwd);
    if (wanted !== null && key !== wanted) continue;
    for (const item of state.conflicts ?? []) {
      const id = `${key}\u0000${item.pluginId ?? ''}\u0000${item.serverName ?? ''}\u0000${item.source ?? ''}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ cwd: state.cwd, pluginId: item.pluginId, serverName: item.serverName, source: item.source });
    }
  }
  return out;
}

/** cwd 的比较键：同一路径的不同写法（大小写/分隔符/尾斜杠）算同一个项目。 */
function cwdKey(value) {
  const text = typeof value === 'string' ? value : '';
  if (text === '') return '';
  let resolved = text;
  try {
    resolved = resolve(text);
  } catch {
    resolved = text;
  }
  const slashed = resolved.replaceAll('\\', '/').replace(/\/+$/u, '');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/** 清空全部运行时状态（插件卸载 / 测试）。 */
export function resetProjectionRuntime() {
  for (const [sessionId, state] of [...agentState]) {
    agentState.delete(sessionId);
    for (const unit of state.units.splice(0)) disposeUnit(unit);
  }
  syncQueues.clear();
  projectionErrorLog.length = 0;
  resetMcpModuleCache();
}

/** 告警（统一前缀，避免 console.log 噪声）。 */
function warn(message) {
  console.warn(`${LOG_PREFIX} ${message}`);
}

/**
 * Agent 的会话键。
 *
 * 只用 `agent.id` 不够稳：dsh-mcp-manager 在 created/pre-step 用 `agent.session.id`、
 * 在 disposed 用 `agent.id`，两处不一致时会漏清理。ReactLoopAgent 上两者相同，
 * 但这里统一走一个 helper，任何一边缺失都还能落到另一边。
 *
 * @param {object} agent
 * @returns {string}
 */
function agentKey(agent) {
  const sessionId = agent?.session?.id;
  if (typeof sessionId === 'string' && sessionId !== '') return sessionId;
  const id = agent?.id;
  return typeof id === 'string' ? id : '';
}

/** 稳定 JSON：对象键排序，数组保序。用于把 options 之类的小对象压成可比字符串。 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/**
 * 各能力组件数量。只数「会被挂载的东西」：option 开关变化时签名必须跟着变。
 *
 * @param {object} components
 * @returns {{ skills: number, commands: number, hooks: number, mcp: number }}
 */
function componentCounts(components) {
  const arrayCount = (value) => (Array.isArray(value) ? value.length : 0);
  const objectCount = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).length : 0);
  return {
    skills: arrayCount(components?.skills),
    commands: arrayCount(components?.commands),
    hooks: arrayCount(components?.hooks),
    mcp: objectCount(components?.mcpServers),
  };
}

/**
 * 取出「真正要被投影」的插件行。
 *
 * `enabled === false` 必须排除：scope.js 在项目未信任时会把 enabled 强制为 false，
 * 而信任门属于 store/scope 的职责，投影层只消费结果。
 *
 * @param {object} resolved - resolveEffective 的返回值
 * @returns {Array<object>}
 */
function enabledPlugins(resolved) {
  const plugins = resolved?.plugins;
  if (!Array.isArray(plugins)) return [];
  return plugins.filter((plugin) => plugin !== null && typeof plugin === 'object' && typeof plugin.id === 'string' && plugin.id !== '' && plugin.enabled !== false);
}

/** 生效插件里是否至少有一个声明了 MCP server（没声明就不必读占用表）。 */
function declaresMcpServers(resolved) {
  return enabledPlugins(resolved).some((plugin) => {
    const servers = plugin.components?.mcpServers;
    return servers !== null && typeof servers === 'object' && !Array.isArray(servers) && Object.keys(servers).length > 0;
  });
}

/** 占用表的空形状（无 MCP 声明 / 读取失败时的兜底）。 */
function emptyOccupancy() {
  return {
    global: { names: new Set(), tools: [] },
    project: { names: new Set(), layer: 'not-applicable', error: null },
  };
}

/**
 * 计算同步签名。
 *
 * 除了插件集合本身，还把「因 MCP 重名而跳过的条目」压进签名：全局服务器晚连接、
 * 项目文件变化或信任状态翻转都会改变跳过名单，从而让下一次 pre-step 重新 reconcile。
 * 只收与当前插件相关的那几条，避免全局任何一个 MCP 服务器的工具变化都触发重挂。
 *
 * @param {object} resolved
 * @param {string} cwd
 * @param {object} occupancy - collectOccupancy 的返回值
 * @returns {string} sha256 hex
 */
function signatureOf(resolved, cwd, occupancy) {
  const rows = enabledPlugins(resolved)
    .map((plugin) => ({
      id: plugin.id,
      root: typeof plugin.rootPath === 'string' ? resolve(plugin.rootPath) : '',
      // 包内容指纹：原地更新（组件数不变、只改 SKILL/命令文本）也要重挂一次，
      // 否则 hook 命令文本、命令文件路径这类"文件内容变了但结构没变"的更新不会生效。
      sha256: typeof plugin.sha256 === 'string' ? plugin.sha256 : '',
      counts: componentCounts(plugin.components),
      options: plugin.options !== null && typeof plugin.options === 'object' ? plugin.options : {},
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return createHash('sha256')
    .update(canonicalJson({ cwd: resolve(cwd), plugins: rows, skipped: shadowRows(resolved, occupancy) }), 'utf8')
    .digest('hex');
}

/**
 * 当前生效插件里会被全局/项目占用的 server 名（`<pluginId>\0<serverName>\0<source>`，已排序）。
 *
 * @param {object} resolved
 * @param {object} occupancy
 * @returns {string[]}
 */
function shadowRows(resolved, occupancy) {
  const rows = [];
  for (const plugin of enabledPlugins(resolved)) {
    const servers = plugin.components?.mcpServers;
    if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) continue;
    for (const rawName of Object.keys(servers)) {
      const normalized = normalizeServerName(rawName);
      if (normalized === undefined) continue;
      const source = shadowingSource(normalized.name, occupancy);
      if (source === null) continue;
      rows.push(`${plugin.id}\u0000${normalized.name}\u0000${source}`);
    }
  }
  return rows.sort();
}

/** 安静卸载一个 Cordis fiber / disposer。单个卸载失败不能连累其余。 */
function disposeQuietly(fiber) {
  try {
    if (typeof fiber === 'function') fiber();
    else if (typeof fiber?.dispose === 'function') fiber.dispose();
    else if (typeof fiber?.stop === 'function') fiber.stop();
  } catch (error) {
    warn(`projection: disposing a mount failed: ${error?.message ?? error}`);
  }
}

/** 卸载一个挂载单元（单元可能持有多个 fiber，例如一个插件的多个 MCP server）。 */
function disposeUnit(unit) {
  const fibers = Array.isArray(unit?.fibers) ? unit.fibers.splice(0) : [];
  for (const fiber of fibers) disposeQuietly(fiber);
}

/** 卸载并忘记一个 Agent 的全部单元。 */
function disposeAgent(sessionId) {
  if (sessionId === '') return;
  const state = agentState.get(sessionId);
  if (state === undefined) return;
  agentState.delete(sessionId);
  for (const unit of state.units.splice(0)) disposeUnit(unit);
}

/**
 * 挂一个能力单元。
 *
 * @param {object} agentCtx - agent 的作用域上下文
 * @param {object} pluginObject - Cordis 插件对象（来自各能力模块的工厂）
 * @param {string} kind - skills | commands | hooks | mcp
 * @param {string} pluginId
 * @param {string} cwd - 出错时归因到哪个项目
 * @returns {{ name: string, kind: string, pluginId: string, fibers: any[] } | undefined}
 */
function mountUnit(agentCtx, pluginObject, kind, pluginId, cwd) {
  try {
    const fiber = agentCtx.plugin(pluginObject);
    return {
      name: typeof pluginObject?.name === 'string' ? pluginObject.name : `plugin-hub:${kind}:${pluginId}`,
      kind,
      pluginId,
      fibers: fiber === undefined || fiber === null ? [] : [fiber],
    };
  } catch (error) {
    warn(`projection: cannot mount ${kind} for plugin "${pluginId}": ${error?.message ?? error}`);
    recordProjectionError(cwd, pluginId, kind, error);
    return undefined;
  }
}

/** 调用一个能力工厂，把异常收敛成 warn + undefined。 */
function safeCreate(factory, kind, pluginId, cwd) {
  try {
    return factory();
  } catch (error) {
    warn(`projection: building the ${kind} unit for plugin "${pluginId}" failed: ${error?.message ?? error}`);
    recordProjectionError(cwd, pluginId, kind, error);
    return undefined;
  }
}

/**
 * 为一个 Agent 构造全部挂载单元。
 *
 * 同一 Agent 内的冲突处理：
 *   - command 重名 → 后到的跳过（claimName 返回 false），保持 `/name` 唯一；
 *   - MCP serverName 与全局/项目同名 → 跳过并记进 conflicts（契约 §2，全局 > 项目 > 插件）；
 *   - 同 Agent 内两个插件同名 → 后到跳过（mcp-client 要求 serverName 在存活实例间唯一）。
 *
 * @param {object} ctx - 宿主插件上下文
 * @param {object} options - mountProjection 的选项
 * @param {object} agent
 * @param {object} resolved - resolveEffective 结果
 * @param {string} cwd
 * @param {object} occupancy - collectOccupancy 结果
 * @returns {Promise<{ units: Array<object>, conflicts: Array<{ pluginId: string, serverName: string, source: string }> }>}
 */
async function mountAll(ctx, options, agent, resolved, cwd, occupancy) {
  const agentCtx = agent?.ctx;
  if (agentCtx === null || typeof agentCtx !== 'object' || typeof agentCtx.plugin !== 'function') {
    // 没有 per-agent 上下文就无处投影：不报错，等下一次 pre-step 再看。
    return { units: [], conflicts: [] };
  }
  const units = [];
  const conflicts = [];
  const claimedCommands = new Set();
  const claimedServers = new Set();
  let mcpPlugin;
  let mcpResolved = false;

  // 本轮是这些插件在当前 cwd 的最新一次结果：先清掉上一轮的错误，
  // 失败的会在下面重新记录，成功的自然消失（页面不会留下修好了还亮着的红点）。
  clearProjectionErrors(cwd);

  for (const plugin of enabledPlugins(resolved)) {
    const pluginId = plugin.id;

    const skills = safeCreate(() => createSkillsUnit(plugin, { cwd }), 'skills', pluginId, cwd);
    if (skills !== null && skills !== undefined) {
      const unit = mountUnit(agentCtx, skills, 'skills', pluginId, cwd);
      if (unit !== undefined) units.push(unit);
    }

    const commands = safeCreate(
      () =>
        createCommandsUnit(plugin, {
          cwd,
          claimName(name) {
            if (claimedCommands.has(name)) return false;
            claimedCommands.add(name);
            return true;
          },
        }),
      'commands',
      pluginId,
      cwd,
    );
    if (commands !== null && commands !== undefined) {
      const unit = mountUnit(agentCtx, commands, 'commands', pluginId, cwd);
      if (unit !== undefined) units.push(unit);
    }

    const hooks = safeCreate(() => createHooksUnit(plugin, { cwd, hostCtx: ctx }), 'hooks', pluginId, cwd);
    if (hooks !== null && hooks !== undefined) {
      const unit = mountUnit(agentCtx, hooks, 'hooks', pluginId, cwd);
      if (unit !== undefined) units.push(unit);
    }

    // MCP 模块只在真需要时加载一次；加载失败不阻塞其它插件，下一轮 sync 还能重试。
    if (!mcpResolved) {
      mcpResolved = true;
      try {
        mcpPlugin = await loadMcpClient(ctx);
      } catch (error) {
        warn(`projection: cannot load the MCP client: ${error?.message ?? error}`);
        mcpPlugin = undefined;
      }
    }
    if (mcpPlugin !== undefined) {
      const pluginDataDir =
        typeof options.resolvePluginData === 'function' ? options.resolvePluginData(ctx, pluginId) : defaultPluginDataDir(ctx, pluginId);
      const servers = safeCreate(() => collectMcpServers(plugin, { cwd, pluginDataDir }), 'mcp', pluginId, cwd) ?? [];
      const fibers = [];
      for (const server of servers) {
        // 重名优先级：全局 > 项目 > 插件。让位后不再尝试挂载，也不会占用 claimedServers。
        const shadowedBy = shadowingSource(server.serverName, occupancy);
        if (shadowedBy !== null) {
          warn(
            `projection: MCP server "${server.serverName}" from plugin "${pluginId}" is already provided by a ${shadowedBy} MCP server; skipped`,
          );
          conflicts.push({ pluginId, serverName: server.serverName, source: shadowedBy });
          continue;
        }
        if (claimedServers.has(server.serverName)) {
          warn(`projection: MCP server "${server.serverName}" from plugin "${pluginId}" is already mounted for this agent; skipped`);
          continue;
        }
        claimedServers.add(server.serverName);
        try {
          fibers.push(agentCtx.plugin(mcpPlugin, { serverName: server.serverName, ...server.config }));
        } catch (error) {
          warn(`projection: cannot mount MCP server "${server.serverName}" from plugin "${pluginId}": ${error?.message ?? error}`);
          // 同一插件多个 server：带上 serverName，页面才能说清是哪一个没挂上。
          recordProjectionError(cwd, pluginId, 'mcp', error, { serverName: server.serverName });
        }
      }
      if (fibers.length > 0) {
        units.push({ name: `plugin-hub:mcp:${pluginId}`, kind: 'mcp', pluginId, fibers });
      }
    }
  }
  return { units, conflicts };
}

/**
 * 同步一个 Agent（必须在队列里串行执行）。
 *
 * @param {object} ctx
 * @param {object} options
 * @param {object} agent
 * @returns {Promise<void>}
 */
async function syncAgent(ctx, options, agent) {
  const sessionId = agentKey(agent);
  if (sessionId === '') return;
  let cwd;
  try {
    cwd = ctx.workingDirectory.get(agent.session);
  } catch (error) {
    warn(`projection: cannot resolve the working directory of session ${sessionId}: ${error?.message ?? error}`);
    return;
  }
  if (typeof cwd !== 'string' || cwd === '') return;

  let resolved;
  try {
    resolved = await options.resolveEffective(cwd);
  } catch (error) {
    // 不崩溃、不写签名 —— 下一次 sync 会重新解析并重试。
    warn(`projection: resolveEffective failed for ${cwd}: ${error?.message ?? error}`);
    const state = agentState.get(sessionId);
    if (state !== undefined && state.cwd !== cwd) {
      // cwd 已经变了：旧 cwd 的投影继续生效会给出错误的能力，先卸掉再等重试。
      disposeAgent(sessionId);
    }
    return;
  }

  // 占用表每轮重算：全局服务器连接完成、项目文件/信任变化都要立刻反映到跳过名单。
  // 没有任何插件声明 MCP 时跳过这次读盘/读服务（占位判定与挂载都无事可做）。
  // 读取失败已在 occupancy 内部收敛为空集合，这里再加一层兜底，绝不让它挡住 reconcile。
  let occupancy;
  if (declaresMcpServers(resolved)) {
    try {
      occupancy = await collectOccupancy(ctx, cwd);
    } catch (error) {
      warn(`projection: cannot compute the MCP occupancy for ${cwd}: ${error?.message ?? error}`);
      occupancy = emptyOccupancy();
    }
  } else {
    occupancy = emptyOccupancy();
  }

  const signature = signatureOf(resolved, cwd, occupancy);
  const current = agentState.get(sessionId);
  if (current !== undefined && current.signature === signature) return; // 幂等：签名没变什么都不做

  if (current !== undefined) {
    agentState.delete(sessionId);
    for (const unit of current.units.splice(0)) disposeUnit(unit); // 先卸
  }

  const { units, conflicts } = await mountAll(ctx, options, agent, resolved, cwd, occupancy);
  agentState.set(sessionId, { cwd, signature, units, conflicts });
}

/**
 * 把 sync 串行化到一个 Agent 的队列上。
 *
 * @param {object} ctx
 * @param {object} options
 * @param {object} agent
 * @returns {Promise<void>} 永不 reject
 */
function enqueue(ctx, options, agent) {
  const sessionId = agentKey(agent);
  if (sessionId === '') return Promise.resolve();
  const previous = syncQueues.get(sessionId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => syncAgent(ctx, options, agent))
    .catch((error) => {
      warn(`projection: sync failed for session ${sessionId}: ${error?.message ?? error}`);
    });
  syncQueues.set(sessionId, next);
  next.finally(() => {
    if (syncQueues.get(sessionId) === next) syncQueues.delete(sessionId);
  });
  return next;
}

/**
 * 挂载投影运行时。
 *
 * @param {object} ctx - 宿主插件上下文（需要 `on` / `workingDirectory` / `loader` / `subprocess`）
 * @param {{ resolveEffective: (cwd: string) => Promise<object>, resolvePluginData?: (ctx: object, pluginId: string) => string }} options
 *   `resolveEffective` 由 lib/index.js 注入（scope.effectivePlugins），本模块不自己读盘。
 *   `resolvePluginData` 可选：覆盖 `${ZCODE_PLUGIN_DATA}` 的目录解析。
 * @returns {() => void} disposer：摘监听 + 卸载所有 Agent
 */
export function mountProjection(ctx, options = {}) {
  const resolveEffective = options?.resolveEffective;
  if (typeof resolveEffective !== 'function') {
    warn('projection: mountProjection requires { resolveEffective }');
    return () => {};
  }
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.on !== 'function') {
    warn('projection: the host context exposes no event bus; projection is not mounted');
    return () => {};
  }
  const config = { ...options, resolveEffective };

  // created 是 serial：等投影完成再进入首个 step，避免模型第一次请求看不到命令/技能。
  const offCreated = ctx.on('agent/created', (payload) => enqueue(ctx, config, payload?.agent));

  // pre-step 是 waterfall：无论同步结果如何都必须 next()，否则会话卡死。
  const offPreStep = ctx.on('agent/pre-step', async (payload, next) => {
    try {
      await enqueue(ctx, config, payload?.agent);
    } catch (error) {
      warn(`projection: pre-step sync failed: ${error?.message ?? error}`);
    }
    return next();
  });

  const offDisposed = ctx.on('agent/disposed', (payload) => {
    disposeAgent(agentKey(payload?.agent));
  });

  return () => {
    offCreated?.();
    offPreStep?.();
    offDisposed?.();
    for (const sessionId of [...agentState.keys()]) disposeAgent(sessionId);
    syncQueues.clear();
    // 投影层整体卸载后旧的运行时错误不再成立；模块实例被 HMR 复用时也不能残留。
    projectionErrorLog.length = 0;
    resetMcpModuleCache();
  };
}
