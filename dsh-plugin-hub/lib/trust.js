/**
 * dsh-plugin-hub — 项目配置信任门。
 *
 * 为什么需要：`<project>/.dsh/plugins.json` 随仓库走，clone 一个仓库不等于授权它的
 * 内容。项目可以写 `plugins.options`（会展开进 MCP 的 env/headers）和 `plugins.dirs`
 * （直接指向仓库内的插件根），所以"文件内容"必须先被人批准过一次。
 *
 * 0.3.1 起判定走三件套共用的 canonical 存储（`data/project-trust/trusted.json`）：
 * 一次批准同时覆盖本项目的 `.dsh/plugins.json` 与 `.dsh/mcp.json`，另一个插件
 * （dsh-mcp-manager）点过的旧记录仍然只读生效。聚合 hash 与分层状态由
 * lib/project-trust.js 计算，本文件只负责把它翻译成「插件投影用不用项目层」。
 *
 * 注意这不是插件域的通用审批：User 作用域的安装/启用是用户自己的显式动作，不走这里。
 */

import { readWorkspace } from './store.js';
import { approveProject, LAYER_NOT_APPLICABLE, LAYER_TRUSTED, trustStateFor } from './project-trust.js';

/**
 * 计算一个项目当前的信任状态。
 *
 * 语义保持不变（`required` / `trusted` / `hash`），新增 `layers` 给 UI 显示分层状态：
 *   - `trusted` 取**插件层**（`plugins.json`）的状态——项目层能不能改插件行为只看它；
 *   - `mcp` 层状态供 MCP 优先级判定（lib/occupancy.js）与 UI 使用；
 *   - `shared` / `source` 说明这份信任来自 canonical 记录还是旧的单插件记录。
 *
 * @param {object} ctx 插件上下文（用于定位 data 目录）
 * @param {string} cwd 项目绝对路径
 * @param {{ workspace?: object }} [preloaded] 已读过的 workspace 结果（避免重复读盘）
 * @returns {Promise<{
 *   required: boolean, trusted: boolean, hash: string|null,
 *   reason?: string,
 *   layers: { mcp: string, plugins: string, shared: boolean, source: string },
 *   files: { mcp: string|null, plugins: string|null },
 * }>}
 */
export async function projectTrust(ctx, cwd, preloaded = {}) {
  const workspace = preloaded.workspace ?? (await readWorkspace(cwd));
  const declaresAnything =
    Object.keys(workspace.data?.enabledPlugins ?? {}).length > 0 ||
    Object.keys(workspace.data?.options ?? {}).length > 0 ||
    (workspace.data?.dirs ?? []).length > 0;
  const state = await trustStateFor(ctx, cwd);
  const layers = layersOf(state);
  const base = { hash: workspace.hash, layers, files: state.files };

  if (!workspace.exists || !declaresAnything) {
    // 没有任何声明时不需要批准：空文件（例如刚写过一条又被恢复继承）不该弹信任横幅。
    // 分层状态仍如实返回，UI 用不到它时自然忽略。
    return { required: false, trusted: true, ...base, reason: 'no project config' };
  }
  if (workspace.error !== null) {
    return { required: true, trusted: false, ...base, reason: `project config ${workspace.error}` };
  }
  if (layers.plugins !== LAYER_TRUSTED) {
    // 旧文案分「从没批准」与「内容变过」两种，UI/日志据此给出不同提示。
    const known = state.record !== null || state.legacy.plugins || state.legacy.mcp;
    return {
      required: true,
      trusted: false,
      ...base,
      reason: known ? 'project config changed since it was approved' : 'project config was never approved',
    };
  }
  return { required: true, trusted: true, ...base };
}

/**
 * 批准当前内容。返回新的信任状态。
 *
 * 写的是 canonical 存储（一次批准覆盖本项目两份配置）；旧 hub 记录保持原样，
 * 由 project-trust 的只读回退继续认。
 *
 * @returns {Promise<{ trusted: true, hash: string, layers: object }>}
 */
export async function trustProject(ctx, cwd) {
  const workspace = await readWorkspace(cwd);
  if (workspace.exists && workspace.error !== null) {
    throw Object.assign(new Error(`project config ${workspace.error}`), { code: 'config-invalid' });
  }
  // 只有 MCP 配置的项目也要能批准（契约 §1.6：只有一份文件时，批准它即可）。
  const state = await trustStateFor(ctx, cwd);
  if (state.files.mcp === null && state.files.plugins === null) {
    throw Object.assign(new Error('there is no project config to approve'), { code: 'not-found' });
  }
  const written = await approveProject(ctx, cwd);
  const after = await trustStateFor(ctx, cwd);
  return { trusted: true, hash: written.hash, layers: layersOf(after) };
}

/** 只读视图给路由/UI 用，不含内部判断顺序。 */
export async function trustView(ctx, cwd) {
  const status = await projectTrust(ctx, cwd);
  return { cwd, ...status };
}

/** 内部状态 → 契约 §1.6 的分层视图（只暴露 UI 认识的字段）。 */
function layersOf(state) {
  return {
    mcp: state.mcp ?? LAYER_NOT_APPLICABLE,
    plugins: state.plugins ?? LAYER_NOT_APPLICABLE,
    shared: state.shared === true,
    source: state.source,
  };
}
