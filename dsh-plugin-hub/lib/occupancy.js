/**
 * dsh-plugin-hub — MCP 服务器重名占用表（三件套契约 §2）。
 *
 * 优先级固定为：**全局（profile 补丁里的 mcp-client 行）> 项目（受信任的 .dsh/mcp.json）
 * > 插件（plugin-hub）**。插件声明的 server 与全局/项目同名时不挂载——挂上去会让同一个
 * 名字在 Agent 作用域里撞车（mcp-client 要求 serverName 在存活实例间唯一），而且模型会
 * 看到两套来源不同的工具。
 *
 * 与 dsh-mcp-manager 的 `global-mcp.js` 同一套判定口径，两边的判定必须一致：
 *   1. `pluginManager.listPlugins()` 里 `moduleName === '@deepseek-ai/dsh-mcp-client'`、
 *      未被停用、`patchId` 形如 `mcp-client-<serverName>` 的行；
 *   2. `tools.schemas()` 里以 `mcp__` 开头的工具名做兜底（覆盖手写 patch 行等没有
 *      patchId 的全局服务器）。
 *
 * 第 2 步刻意不做「从工具名反解 serverName」：serverName 允许下划线，工具名
 * `mcp__<name>__<tool>` 无法无歧义拆分。判定方式是拿候选名的命名空间前缀
 * `mcp__<name>__` 去前缀匹配，既准确又不需要解析。
 *
 * 服务缺失、调用抛错、返回形状不对都退化成空集合（等于「没有冲突」）：重名优先级是
 * 一层优化，不能因为它失败而拦住插件的正常挂载。
 */

import { readFile } from 'node:fs/promises';

import { LAYER_NOT_APPLICABLE, LAYER_TRUSTED, mcpPathFor, trustStateFor } from './project-trust.js';
import { normalizeServerName, SERVER_NAME_PATTERN } from './projection/mcp.js';
import { warn } from './util.js';

/** 宿主 MCP 客户端包名（全局行的 `moduleName`）。 */
export const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client';

/** mcp-manager 派生 loader 行 id 的前缀（`mcp-client-<serverName>`）。 */
export const PATCH_ID_PREFIX = 'mcp-client-';

/** mcp-client 为每个服务器预定的工具命名空间前缀。 */
export const TOOL_NAMESPACE_PREFIX = 'mcp__';

/** 插件间/进程内的冲突来源（UI 只认这两个值）。 */
export const SOURCE_GLOBAL = 'global';
export const SOURCE_PROJECT = 'project';

/**
 * 读宿主服务：`ctx.get(name)` 是 Cordis 里唯一「缺了就返回 undefined」的读法；
 * `ctx[name]` 在未注入的服务上会抛，所以两条路径都试、都包 try。
 *
 * @param {object} ctx
 * @param {string} name
 * @returns {any}
 */
function serviceOf(ctx, name) {
  try {
    if (ctx !== null && typeof ctx === 'object' && typeof ctx.get === 'function') {
      const value = ctx.get(name);
      if (value !== undefined && value !== null) return value;
    }
  } catch {
    /* 未注入的服务直接跳过 */
  }
  try {
    return ctx?.[name];
  } catch {
    return undefined;
  }
}

/**
 * 全局 MCP 占用集合。
 *
 * @param {object} ctx - 宿主插件上下文
 * @returns {Promise<{ names: Set<string>, tools: string[] }>}
 */
export async function globalOccupancy(ctx) {
  const names = new Set();

  let rows = [];
  try {
    const manager = serviceOf(ctx, 'pluginManager');
    rows = typeof manager?.listPlugins === 'function' ? await manager.listPlugins() : [];
  } catch (error) {
    warn(`occupancy: cannot read the global plugin rows: ${error?.message ?? error}`);
    rows = [];
  }
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row === null || typeof row !== 'object') continue;
    if (row.moduleName !== MCP_CLIENT_MODULE) continue;
    // 显式停用的全局行不会再注册工具，不算占用。
    if (row.enabled === false) continue;
    if (typeof row.patchId !== 'string' || !row.patchId.startsWith(PATCH_ID_PREFIX)) continue;
    const name = row.patchId.slice(PATCH_ID_PREFIX.length);
    if (SERVER_NAME_PATTERN.test(name)) names.add(name);
  }

  const tools = [];
  try {
    const toolsService = serviceOf(ctx, 'tools');
    const schemas = typeof toolsService?.schemas === 'function' ? toolsService.schemas() : [];
    for (const schema of Array.isArray(schemas) ? schemas : []) {
      const toolName = typeof schema === 'string' ? schema : schema?.name;
      if (typeof toolName === 'string' && toolName.startsWith(TOOL_NAMESPACE_PREFIX)) tools.push(toolName);
    }
  } catch (error) {
    // 工具清单不可用等价于「没有兜底证据」：仍然按 patch 行判定。
    warn(`occupancy: cannot read the tool schemas: ${error?.message ?? error}`);
  }

  return { names, tools };
}

/**
 * 项目 MCP 占用集合：只在该项目的 **mcp 层已信任** 时计入（契约 §2）。
 *
 * @param {object} ctx
 * @param {string} cwd
 * @returns {Promise<{ names: Set<string>, layer: string, error: string|null }>}
 */
export async function projectOccupancy(ctx, cwd) {
  if (typeof cwd !== 'string' || cwd === '') {
    return { names: new Set(), layer: LAYER_NOT_APPLICABLE, error: null };
  }
  let state;
  try {
    state = await trustStateFor(ctx, cwd);
  } catch (error) {
    return { names: new Set(), layer: LAYER_NOT_APPLICABLE, error: String(error?.message ?? error) };
  }
  if (state.mcp !== LAYER_TRUSTED) {
    // 未信任/文件不存在：一台都不会挂，因此也不占用任何名字。
    return { names: new Set(), layer: state.mcp, error: null };
  }

  let data;
  try {
    data = JSON.parse(await readFile(mcpPathFor(cwd), 'utf8'));
  } catch (error) {
    return { names: new Set(), layer: state.mcp, error: `not valid JSON: ${error?.message ?? error}` };
  }
  const servers = data?.mcpServers;
  const disabled = Array.isArray(data?.disabled) ? data.disabled.filter((item) => typeof item === 'string') : [];
  const names = new Set();
  if (servers !== null && typeof servers === 'object' && !Array.isArray(servers)) {
    for (const name of Object.keys(servers)) {
      if (disabled.includes(name)) continue;
      if (SERVER_NAME_PATTERN.test(name)) names.add(name);
    }
  }
  return { names, layer: state.mcp, error: null };
}

/**
 * 一次算齐全局与项目占用表。
 *
 * @param {object} ctx
 * @param {string} cwd
 * @returns {Promise<{ global: { names: Set<string>, tools: string[] }, project: { names: Set<string>, layer: string, error: string|null } }>}
 */
export async function collectOccupancy(ctx, cwd) {
  const [global, project] = await Promise.all([globalOccupancy(ctx), projectOccupancy(ctx, cwd)]);
  return { global, project };
}

/**
 * 这个名字被谁占着（全局优先，其次项目）；都没占返回 null。
 *
 * @param {string} serverName - 已经规范化（collectMcpServers 装出来的名字）
 * @param {object} occupancy
 * @returns {'global'|'project'|null}
 */
export function shadowingSource(serverName, occupancy) {
  if (typeof serverName !== 'string' || serverName === '') return null;
  if (occupancy?.global?.names?.has?.(serverName) === true) return SOURCE_GLOBAL;
  const prefix = `${TOOL_NAMESPACE_PREFIX}${serverName}__`;
  const tools = Array.isArray(occupancy?.global?.tools) ? occupancy.global.tools : [];
  if (tools.some((tool) => typeof tool === 'string' && tool.startsWith(prefix))) return SOURCE_GLOBAL;
  if (occupancy?.project?.names?.has?.(serverName) === true) return SOURCE_PROJECT;
  return null;
}

/**
 * 一批插件里「会因为重名而跳过」的条目（给 overview 的 dry-run 与投影层共用）。
 *
 * 只比名字，不看 server 配置是否合法：配置不合法本来就不会挂，多报一条同名冲突
 * 对用户没有误导（列表里那台服务器确实没起来），而重复实现一遍校验只会引入两套真相。
 *
 * @param {object} occupancy
 * @param {Array<object>} plugins - effective 的插件行
 * @returns {Array<{ pluginId: string, serverName: string, source: 'global'|'project' }>}
 */
export function conflictsForPlugins(occupancy, plugins) {
  const out = [];
  for (const plugin of Array.isArray(plugins) ? plugins : []) {
    if (plugin === null || typeof plugin !== 'object') continue;
    if (typeof plugin.id !== 'string' || plugin.id === '') continue;
    if (plugin.enabled === false) continue;
    const servers = plugin.components?.mcpServers;
    if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) continue;
    for (const rawName of Object.keys(servers)) {
      const normalized = normalizeServerName(rawName);
      if (normalized === undefined) continue;
      const source = shadowingSource(normalized.name, occupancy);
      if (source === null) continue;
      out.push({ pluginId: plugin.id, serverName: normalized.name, source });
    }
  }
  return out;
}
