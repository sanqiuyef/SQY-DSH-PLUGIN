/**
 * dsh-plugin-hub — 生效配置合并（User + Workspace → 投影输入）。
 *
 * 这一段是"照 ZCode 做"的核心，规则抄自
 * `ZCode-main/docs/plugins/workspace-level-plugin-architecture.md`：
 *
 *   enabled = workspace.enabledPlugins[id] ?? user.enabledPlugins[id] ?? 默认(true)
 *   options = { ...user.options[id], ...workspace.options[id] }   // 逐 key 覆盖
 *
 * 与 ZCode 的两处刻意差异（都在 README 里写明）：
 *   1. 项目配置未信任时**整层忽略**（连启用状态一起忽略），而不是只忽略危险字段——
 *      这样"没批准过的仓库"不可能改变任何插件行为，同时用户自己的全局开关照常生效。
 *   2. 包与安装记录永远属于 Host 用户级；项目只能引用已安装的包，或用自己的
 *      `plugins.dirs` 指向仓库内的插件根（这些只在项目会话里出现，不进全局列表）。
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { enumerateComponents } from './components.js';
import { readManifest } from './manifest.js';
import { projectTrust } from './trust.js';
import { exists, isInside, resolveInside, stableHash, warn } from './util.js';
import { readInstalled, readUser, readWorkspace } from './store.js';

/** 短 TTL 缓存：`agent/pre-step` 每步都会问一次，而扫描清单/组件是同步 I/O。 */
const CACHE_TTL_MS = 4000;
const cache = new Map();

/** 清空缓存（配置写入后由 routes 调用，保证下一次读到新值）。 */
export function invalidateScopeCache() {
  cache.clear();
}

/**
 * 计算某个工作目录下的生效插件集合。
 *
 * @param {object} ctx 插件上下文
 * @param {string} cwd 会话工作目录（绝对路径）
 * @returns {Promise<object>} 见 SPEC §4 scope.js
 */
export async function effectivePlugins(ctx, cwd) {
  const directory = typeof cwd === 'string' && cwd !== '' ? cwd : null;
  const key = `${directory ?? '<none>'}\u0000${process.env.DSH_PROFILE ?? ''}`;
  const cached = cache.get(key);
  if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const value = await computeEffective(ctx, directory);
  // 只缓存成功计算的结果；失败要让下一次立即重试。
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function computeEffective(ctx, cwd) {
  const installed = await readInstalled(ctx);
  const user = await readUser(ctx);
  const workspace = cwd === null ? null : await readWorkspace(cwd);
  const trust = cwd === null ? { required: false, trusted: true } : await projectTrust(ctx, cwd, { workspace });

  // 未信任时整层忽略：enabled/options/dirs 一起不看。
  const workspaceLayer = workspace !== null && trust.trusted ? workspace.data : null;
  const workspaceIgnored = workspace !== null && workspace.exists && !trust.trusted;

  const plugins = [];
  const diagnostics = [];

  const addPlugin = async (record, marketplace, options) => {
    const manifestResult = await readManifest(record.rootPath);
    if (!manifestResult.ok) {
      diagnostics.push({
        code: `manifest-${manifestResult.reason}`,
        message: manifestResult.message,
        path: record.rootPath,
        pluginId: record.id,
        severity: 'error',
      });
      return;
    }
    const components = await enumerateComponents(record.rootPath, manifestResult.manifest);
    for (const item of components.diagnostics ?? []) {
      diagnostics.push({ ...item, pluginId: record.id, severity: item.severity ?? 'warning' });
    }
    const enabledState = resolveEnabled(record.id, workspaceLayer, user);
    plugins.push({
      id: record.id,
      name: record.name ?? manifestResult.manifest.name,
      version: record.version ?? manifestResult.manifest.version,
      rootPath: record.rootPath,
      marketplace,
      // 内容指纹参与投影签名：包在原地更新（组件数不变）也能触发一次重挂。
      sha256: typeof record.sha256 === 'string' ? record.sha256 : '',
      manifest: manifestResult.manifest,
      manifestPath: manifestResult.manifestPath,
      components,
      enabled: enabledState.enabled,
      enabledSource: enabledState.source,
      options: resolveOptions(record.id, workspaceLayer, user),
      trust: { required: trust.required, trusted: trust.trusted, hash: trust.hash },
    });
  };

  for (const record of Object.values(installed.plugins)) {
    if (record === null || typeof record !== 'object') continue;
    if (typeof record.rootPath !== 'string' || !(await exists(record.rootPath))) {
      diagnostics.push({
        code: 'package-missing',
        message: `installed package ${record.id} is missing; reinstall or uninstall it`,
        path: record.rootPath,
        pluginId: record.id,
        severity: 'warning',
      });
      continue;
    }
    await addPlugin(record, record.marketplace ?? 'local');
  }

  // 项目自带插件根：只在配置被信任后扫描，且路径必须落在项目内。
  if (cwd !== null && workspaceLayer !== null) {
    for (const dir of workspaceLayer.dirs ?? []) {
      const root = resolveInside(cwd, dir);
      if (root === null) {
        diagnostics.push({ code: 'project-dir-escape', message: `plugins.dirs entry "${dir}" is outside the project`, severity: 'warning' });
        continue;
      }
      if (!(await exists(root))) {
        diagnostics.push({ code: 'project-dir-missing', message: `plugins.dirs entry "${dir}" does not exist`, path: root, severity: 'warning' });
        continue;
      }
      for (const child of await listPluginRoots(root)) {
        const manifestResult = await readManifest(child);
        if (!manifestResult.ok) continue;
        const id = `${manifestResult.manifest.name}@project`;
        // 与已安装包同名时让已安装包赢：项目目录是便利入口，不是覆盖通道。
        if (installed.plugins[id] !== undefined || plugins.some((item) => item.name === manifestResult.manifest.name)) continue;
        await addPlugin({ id, name: manifestResult.manifest.name, rootPath: child, version: manifestResult.manifest.version }, 'project');
      }
    }
  }

  // 稳定排序，让投影签名与 UI 列表不受对象遍历顺序影响。
  plugins.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    plugins,
    diagnostics,
    workspace: {
      path: workspace?.path ?? null,
      exists: workspace?.exists ?? false,
      hash: workspace?.hash ?? null,
      trusted: trust.trusted,
      required: trust.required,
      ignored: workspaceIgnored,
      reason: trust.reason,
    },
    user: { enabledPlugins: user.enabledPlugins, options: user.options },
    workspaceConfig: workspaceLayer ?? { enabledPlugins: {}, options: {}, dirs: [] },
    signature: stableHash(
      plugins.map((plugin) => ({
        id: plugin.id,
        rootPath: plugin.rootPath,
        sha256: plugin.sha256,
        enabled: plugin.enabled,
        options: plugin.options,
        components: {
          skills: plugin.components.skills?.length ?? 0,
          commands: plugin.components.commands?.length ?? 0,
          hooks: plugin.components.hooks?.length ?? 0,
          mcp: Object.keys(plugin.components.mcpServers ?? {}).length,
        },
      })),
    ),
  };
}

/** 一个插件是否启用：workspace 显式值 → user 显式值 → 默认 true。 */
function resolveEnabled(id, workspaceLayer, user) {
  const fromWorkspace = workspaceLayer?.enabledPlugins?.[id];
  if (typeof fromWorkspace === 'boolean') return { enabled: fromWorkspace, source: 'workspace' };
  const fromUser = user.enabledPlugins?.[id];
  if (typeof fromUser === 'boolean') return { enabled: fromUser, source: 'user' };
  return { enabled: true, source: 'default' };
}

/** options 逐 key 合并；workspace 覆盖 user。 */
function resolveOptions(id, workspaceLayer, user) {
  return {
    ...(user.options?.[id] ?? {}),
    ...(workspaceLayer?.options?.[id] ?? {}),
  };
}

/**
 * 列出一个目录下的插件根。
 *
 * 约定为"子目录即插件"（`plugins.dirs` 指向合集目录），与 ZCode 的 `plugins.dirs`
 * 行为一致；子目录本身必须是真实目录，符号链接一律跳过（仓库可提交链接）。
 */
async function listPluginRoots(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const roots = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const child = join(dir, entry.name);
    if (!isInside(dir, child)) continue;
    roots.push(child);
  }
  return roots;
}

/** 给路由层用的只读视图：不含 manifest 全文，避免响应里塞满清单。 */
export function summarizeEffective(effective) {
  return {
    plugins: effective.plugins.map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      marketplace: plugin.marketplace,
      rootPath: plugin.rootPath,
      enabled: plugin.enabled,
      enabledSource: plugin.enabledSource,
      options: plugin.options,
      trust: plugin.trust,
      components: (plugin.components.groups ?? []).map((group) => ({ kind: group.kind, count: group.items.length })),
      diagnostics: (plugin.components.diagnostics ?? []).length,
    })),
    diagnostics: effective.diagnostics,
    workspace: effective.workspace,
  };
}

/** 供投影层告警用：把一次 effective 计算里的错误级诊断打到日志（限流由调用方控制）。 */
export function reportDiagnostics(effective) {
  for (const item of effective?.diagnostics ?? []) {
    if (item.severity === 'error') warn(`${item.pluginId ?? '-'}: ${item.message}`);
  }
}
