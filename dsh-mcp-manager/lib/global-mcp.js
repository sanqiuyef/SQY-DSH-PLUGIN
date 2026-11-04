/**
 * dsh-mcp-manager — 全局 MCP 占用集合（契约 §2）。
 *
 * 优先级固定为：**全局（profile 补丁里的 mcp-client 行）> 项目（受信任的 .dsh/mcp.json）
 * > 插件（dsh-plugin-hub）**。项目作用域的运行时在挂载每一台服务器之前都要问一句
 * 「这个名字是不是已经被全局占了」，被占的跳过（全局优先），不产生两套工具。
 *
 * 为什么单独一个模块：`project-api.js`（视图里的 skipped/problems）和
 * `project-runtime.js`（挂载前的跳过）都要用这份判定，放在任一文件里都会让两者互相
 * import 形成环。
 *
 * 占用来源有两种，按契约 §2 依次使用：
 *   1. `ctx.pluginManager.listPlugins()` 里 `moduleName === '@deepseek-ai/dsh-mcp-client'`
 *      且未被停用的行，`patchId` 形如 `mcp-client-<serverName>`；
 *   2. `ctx.tools.schemas()` 里以 `mcp__` 开头的工具名（兜住非本插件写入的全局行）。
 *
 * 第 2 步刻意不做「从工具名反解 serverName」：`serverName` 允许下划线，工具名里的
 * `mcp__<name>__<tool>` 无法无歧义拆分。判定方式是拿候选名的命名空间前缀
 * `mcp__<name>__` 去前缀匹配，既准确又不需要解析。
 */

import { MCP_CLIENT_PACKAGE, PATCH_ID_PREFIX, TOOL_NAMESPACE_PREFIX } from './patch.js';
import { SERVER_NAME_PATTERN } from './diagnostics.js';

/**
 * 读当前 profile 的全局 MCP 占用集合。
 *
 * 读取全部容错：服务缺失、调用抛错、返回形状不对都退化为空集合（等于「没有全局冲突」），
 * 因为这里失败不应该阻止项目服务器挂载。
 *
 * @param {object} ctx - 插件上下文
 * @returns {Promise<{ names: Set<string>, tools: string[] }>}
 */
export async function globalMcpOccupancy(ctx) {
  const names = new Set();

  let rows = [];
  try {
    rows = (await ctx?.pluginManager?.listPlugins?.()) ?? [];
  } catch {
    rows = [];
  }
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row === null || typeof row !== 'object') continue;
    if (row.moduleName !== MCP_CLIENT_PACKAGE) continue;
    // `enabled !== false` 才算占用：显式停用的全局行不会再注册工具。
    if (row.enabled === false) continue;
    if (typeof row.patchId !== 'string' || !row.patchId.startsWith(PATCH_ID_PREFIX)) continue;
    const name = row.patchId.slice(PATCH_ID_PREFIX.length);
    if (SERVER_NAME_PATTERN.test(name)) names.add(name);
  }

  const tools = [];
  try {
    const schemas = ctx?.tools?.schemas?.();
    for (const schema of Array.isArray(schemas) ? schemas : []) {
      const toolName = typeof schema === 'string' ? schema : schema?.name;
      if (typeof toolName === 'string' && toolName.startsWith(TOOL_NAMESPACE_PREFIX)) tools.push(toolName);
    }
  } catch {
    /* 工具清单不可用等价于「没有兜底证据」，事务层仍然按 patch 行判定 */
  }

  return { names, tools };
}

/**
 * 这个名字是否已被全局占用（= 项目里的同名条目必须跳过）。
 *
 * @param {string} serverName
 * @param {{ names: Set<string>, tools: string[] }} occupancy
 * @returns {boolean}
 */
export function isShadowedByGlobal(serverName, occupancy) {
  if (typeof serverName !== 'string' || serverName === '') return false;
  if (occupancy?.names?.has?.(serverName)) return true;
  const prefix = `${TOOL_NAMESPACE_PREFIX}${serverName}__`;
  return (Array.isArray(occupancy?.tools) ? occupancy.tools : []).some((tool) => tool.startsWith(prefix));
}

/**
 * 一批项目服务器名里，被全局占用的那些（保持输入顺序）。
 *
 * @param {object} ctx
 * @param {string[]} serverNames
 * @returns {Promise<string[]>}
 */
export async function shadowedGlobalNames(ctx, serverNames) {
  const occupancy = await globalMcpOccupancy(ctx);
  return (Array.isArray(serverNames) ? serverNames : []).filter((name) => isShadowedByGlobal(name, occupancy));
}
