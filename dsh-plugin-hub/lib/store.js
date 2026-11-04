/**
 * dsh-plugin-hub — 落盘层。
 *
 * 所有权模型（照 ZCode 的两级配置 + Host 用户级包）：
 *   - 包（cache/）与安装记录（installed.json）永远属于 Host 用户级；
 *   - 全局启用/选项在 `data/plugin-hub/user.json`；
 *   - 项目启用/选项在 `<project>/.dsh/plugins.json`（可提交进 Git，只声明"用不用、怎么配"）。
 *
 * 所有写入都走「读 → mutator → 原子写」，并在 `<file>.lock` 上串行化：设置页、路由、
 * 投影层可能同时写同一个文件，最后写入者不能覆盖掉别人的字段。mutator 返回 undefined
 * 表示"无需改动"，此时不做任何写盘。
 */

import { dirname, join } from 'node:path';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readManifest } from './manifest.js';
import { ensureDir, isInside, nowIso, readJsonFile, sha256Dir, sha256Text, warn, withLock, writeJsonAtomic } from './util.js';

/** 用户级默认形状。 */
export const EMPTY_USER = Object.freeze({ version: 1, enabledPlugins: {}, options: {} });

/** 项目级默认形状；`dirs` 允许项目自带插件根目录（相对项目路径）。 */
export const EMPTY_WORKSPACE = Object.freeze({ version: 1, enabledPlugins: {}, options: {}, dirs: [] });

/**
 * 当前 profile 目录。
 *
 * 与 dsh-mcp-manager 同一套判定：profile 补丁文件所在目录才是权威（那是宿主和插件
 * 共同改写的位置）；没有 configEditor 时按 `dsh-home-paths` 的规则重建。
 *
 * `configEditor` 不在本插件的 inject 里（缺它也应可用），所以只能走"可选访问"：
 * Cordis 对未注入服务取属性会抛，`ctx.get(name)` 才是返回 undefined 的读法；
 * 两条路径都包在 try 里，任何一种组合都不会让 apply 直接失败。
 */
export function profileDirOf(ctx) {
  let documentPath;
  try {
    const editor = typeof ctx?.get === 'function' ? ctx.get('configEditor') : ctx?.configEditor;
    documentPath = editor?.documentPath;
  } catch {
    documentPath = undefined;
  }
  if (typeof documentPath === 'string' && documentPath !== '') return dirname(documentPath);
  const home =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
      ? process.env.DSH_HOME
      : join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh');
  const profile =
    typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE !== '' ? process.env.DSH_PROFILE : 'desktop';
  return join(home, 'profiles', profile);
}

/** 插件中心的数据根（不进 profile 的 node_modules，避免被包管理器清理）。 */
export function hubRoot(ctx) {
  return join(profileDirOf(ctx), 'data', 'plugin-hub');
}

/** 全部落盘路径集中在这里，路由与投影层不要自己拼。 */
export function hubPaths(ctx) {
  const root = hubRoot(ctx);
  return {
    root,
    cacheRoot: join(root, 'cache'),
    dataRoot: join(root, 'data'),
    installed: join(root, 'installed.json'),
    user: join(root, 'user.json'),
    marketplaces: join(root, 'marketplaces.json'),
    // 旧版信任库：0.3.1 起只读回退（契约 §1.4），新写入走 lib/project-trust.js。
    trusted: join(root, 'trusted.json'),
    logs: join(root, 'logs'),
  };
}

/**
 * 旧 dsh-mcp-manager 的项目信任库（契约 §1.4 的只读回退来源，key = 原始绝对路径）。
 *
 * 只读：本插件永远不会写它。路径集中在这里，是为了让 project-trust.js 不自己拼
 * profile 目录结构（profileDirOf 的规则只在本文件维护一份）。
 */
export function mcpManagerTrustPath(ctx) {
  return join(profileDirOf(ctx), 'data', 'mcp-manager', 'trusted-projects.json');
}

/** 首次使用时建好目录；幂等。 */
export async function ensureHubDirs(ctx) {
  const paths = hubPaths(ctx);
  await ensureDir(paths.cacheRoot);
  await ensureDir(paths.dataRoot);
  await ensureDir(paths.logs);
  return paths;
}

/** 通用「读最新 → 变更 → 原子写」；`mutator` 返回 undefined 时不写。 */
async function mutateJson(path, fallback, mutator) {
  return withLock(`${path}.lock`, async () => {
    const current = await readJsonFile(path, fallback);
    const next = await mutator(current);
    if (next === undefined) return current;
    await writeJsonAtomic(path, next);
    return next;
  });
}

// ---------------------------------------------------------------- installed

export async function readInstalled(ctx) {
  const data = await readJsonFile(hubPaths(ctx).installed, { version: 1, plugins: {} });
  if (data === null || typeof data !== 'object') return { version: 1, plugins: {} };
  const plugins = data.plugins !== null && typeof data.plugins === 'object' ? data.plugins : {};
  return { version: 1, plugins };
}

export async function mutateInstalled(ctx, mutator) {
  await ensureHubDirs(ctx);
  return mutateJson(hubPaths(ctx).installed, { version: 1, plugins: {} }, async (current) => {
    const base = {
      version: 1,
      plugins: current?.plugins !== null && typeof current?.plugins === 'object' ? current.plugins : {},
    };
    const next = await mutator(base);
    return next === undefined ? undefined : { version: 1, plugins: next.plugins ?? base.plugins };
  });
}

/**
 * 列出一个已安装插件在缓存里保留下来的全部版本。
 *
 * 安装目录本来就按 `cache/<market>/<name>/<version>` 分桶（routes.installPlugin），
 * 但 installed.json 只留当前一条记录。旧版本目录不删，正是为了让这里能列出来回滚；
 * 卸载时再整桶清掉（routes 的 /uninstall），不留既不能回滚也不能清理的孤儿目录。
 *
 * 版本号以目录里的清单为准：目录名是 sanitize 后的片段，可能与 `manifest.version`
 * 不同（例如带 `+build` 的版本）。清单 name 与记录不一致的目录视为别的东西，不列出。
 *
 * @param {object} ctx
 * @param {object} record InstalledRecord
 * @returns {Promise<Array<{ version: string, rootPath: string, sha256: string,
 *   format: string|null, mtime: string, current: boolean }>>}
 */
export async function listCachedVersions(ctx, record) {
  const paths = hubPaths(ctx);
  // 记录的 rootPath 就是版本目录；它的父目录是按插件分好的桶。
  const bucket = dirname(String(record?.rootPath ?? ''));
  if (!isInside(paths.cacheRoot, bucket) || bucket === paths.cacheRoot) return [];

  let entries;
  try {
    entries = await readdir(bucket, { withFileTypes: true });
  } catch {
    return [];
  }

  // 安装允许记录名（调用方 name / 市场条目名）与包内 manifest.name 不同，
  // 所以不能只按 record.name 过滤，否则这类合法安装永远列出空版本。
  // 以「当前版本的清单 name」作为包身份，记录名也接受；两者都不匹配的目录视为别的东西。
  const acceptedNames = new Set([String(record?.name ?? '')]);
  const currentManifest = await readManifest(String(record?.rootPath ?? ''));
  if (currentManifest.ok) acceptedNames.add(currentManifest.manifest.name);

  const byVersion = new Map();
  for (const entry of entries) {
    // withFileTypes 的 isDirectory 不跟随符号链接：版本目录必须是真实目录。
    if (!entry.isDirectory()) continue;
    const rootPath = join(bucket, entry.name);
    const manifestResult = await readManifest(rootPath);
    if (!manifestResult.ok || !acceptedNames.has(manifestResult.manifest.name)) continue;
    const version = typeof manifestResult.manifest.version === 'string' && manifestResult.manifest.version !== ''
      ? manifestResult.manifest.version
      : entry.name;
    const info = await stat(rootPath).catch(() => null);
    const mtime = info === null ? new Date(0).toISOString() : new Date(info.mtimeMs).toISOString();
    const currentPath = String(record.rootPath ?? '');
    const candidate = {
      version,
      rootPath,
      sha256: await sha256Dir(rootPath).catch(() => ''),
      format: manifestResult.format ?? null,
      mtime,
      // Windows 路径大小写不敏感；其余平台按逐字节比较。
      current:
        rootPath === currentPath ||
        (process.platform === 'win32' && rootPath.toLowerCase() === currentPath.toLowerCase()),
    };
    // 同名版本目录（sanitize 碰撞）只留较新的那个。
    const previous = byVersion.get(version);
    if (previous === undefined || previous.mtime < candidate.mtime) byVersion.set(version, candidate);
  }

  // 当前版本永远排第一，其余按目录时间从新到旧。
  return [...byVersion.values()].sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1;
    return left.mtime < right.mtime ? 1 : left.mtime > right.mtime ? -1 : 0;
  });
}

// ---------------------------------------------------------------- user scope

export async function readUser(ctx) {
  const data = await readJsonFile(hubPaths(ctx).user, { ...EMPTY_USER, enabledPlugins: {}, options: {} });
  return normalizeScopeConfig(data, EMPTY_USER);
}

export async function mutateUser(ctx, mutator) {
  await ensureHubDirs(ctx);
  return mutateJson(hubPaths(ctx).user, { ...EMPTY_USER, enabledPlugins: {}, options: {} }, async (current) => {
    const base = normalizeScopeConfig(current, EMPTY_USER);
    const next = await mutator(base);
    return next === undefined ? undefined : normalizeScopeConfig({ ...base, ...next }, EMPTY_USER);
  });
}

// ---------------------------------------------------------------- workspace scope

/** 项目作用域文件名固定；不接受调用方传其它名字（避免写到任意路径）。 */
export function workspaceConfigPath(cwd) {
  return join(cwd, '.dsh', 'plugins.json');
}

/**
 * 读项目配置。
 *
 * `hash` 是原文 sha256，信任门与"配置没变就不重挂"都用它；文件不存在时 hash 为 null，
 * 调用方据此区分"没有项目配置"和"配置为空"。
 */
export async function readWorkspace(cwd) {
  const path = workspaceConfigPath(cwd);
  let text = null;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    text = null;
  }
  if (text === null) {
    return { path, exists: false, hash: null, data: cloneWorkspace(EMPTY_WORKSPACE), error: null };
  }
  let parsed = null;
  let error = null;
  try {
    parsed = text.trim() === '' ? {} : JSON.parse(text);
  } catch (parseError) {
    error = `not valid JSON: ${parseError.message}`;
  }
  return {
    path,
    exists: true,
    hash: sha256Text(text),
    data: normalizeScopeConfig(parsed ?? {}, EMPTY_WORKSPACE),
    error,
  };
}

export async function mutateWorkspace(cwd, mutator) {
  const path = workspaceConfigPath(cwd);
  await ensureDir(dirname(path));
  return withLock(`${path}.lock`, async () => {
    const current = await readWorkspace(cwd);
    if (current.error !== null) {
      throw Object.assign(new Error(`project config ${path} is ${current.error}`), { code: 'config-invalid' });
    }
    const next = await mutator(current.data);
    if (next === undefined) return current.data;
    const normalized = normalizeScopeConfig({ ...current.data, ...next }, EMPTY_WORKSPACE);
    await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    return normalized;
  });
}

/** 只删当前 scope 的键（"恢复继承"），不写 sentinel。 */
export function removeWorkspaceKeys(config, pluginId) {
  const next = cloneWorkspace(config ?? EMPTY_WORKSPACE);
  delete next.enabledPlugins[pluginId];
  delete next.options[pluginId];
  return next;
}

// ---------------------------------------------------------------- marketplaces

export async function readMarketplaces(ctx) {
  const data = await readJsonFile(hubPaths(ctx).marketplaces, { version: 1, marketplaces: {} });
  const marketplaces =
    data?.marketplaces !== null && typeof data?.marketplaces === 'object' ? data.marketplaces : {};
  return { version: 1, marketplaces };
}

export async function mutateMarketplaces(ctx, mutator) {
  await ensureHubDirs(ctx);
  return mutateJson(hubPaths(ctx).marketplaces, { version: 1, marketplaces: {} }, async (current) => {
    const base = {
      version: 1,
      marketplaces: current?.marketplaces !== null && typeof current?.marketplaces === 'object' ? current.marketplaces : {},
    };
    const next = await mutator(base);
    return next === undefined ? undefined : { version: 1, marketplaces: next.marketplaces ?? base.marketplaces };
  });
}

// ---------------------------------------------------------------- trust

/**
 * 旧版信任库（`data/plugin-hub/trusted.json`）。
 *
 * 0.3.1 起它只是**只读兼容层**：判定与写入都走 lib/project-trust.js 的 canonical 存储
 * （三件套共用一份，见契约 §1）。保留这两个函数是为了「旧记录迁移期间还能读到」，
 * 以及给测试/诊断一个读取入口；新代码不要再调 approveProject 写它。
 */

export async function readTrust(ctx) {
  const data = await readJsonFile(hubPaths(ctx).trusted, { version: 1, projects: {} });
  const projects = data?.projects !== null && typeof data?.projects === 'object' ? data.projects : {};
  return { version: 1, projects };
}

export async function mutateTrust(ctx, mutator) {
  await ensureHubDirs(ctx);
  return mutateJson(hubPaths(ctx).trusted, { version: 1, projects: {} }, async (current) => {
    const base = {
      version: 1,
      projects: current?.projects !== null && typeof current?.projects === 'object' ? current.projects : {},
    };
    const next = await mutator(base);
    return next === undefined ? undefined : { version: 1, projects: next.projects ?? base.projects };
  });
}

/** 信任键统一用绝对路径的规范形式（Windows 上大小写不敏感）。 */
export function trustKey(cwd) {
  const normalized = String(cwd ?? '').replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** 记录一次信任（旧版写入路径，0.3.1 起不再是主路径；见 lib/project-trust.js）。 */
export async function approveProject(ctx, cwd, hash) {
  const key = trustKey(cwd);
  await mutateTrust(ctx, (current) => {
    current.projects[key] = { hash, approvedAt: nowIso() };
    return current;
  });
}

// ---------------------------------------------------------------- helpers

/** 归一化一个 scope 配置对象，保证三个字段存在且类型正确。 */
export function normalizeScopeConfig(raw, fallback) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const enabledPlugins = {};
  if (source.enabledPlugins !== null && typeof source.enabledPlugins === 'object') {
    for (const [id, value] of Object.entries(source.enabledPlugins)) {
      if (typeof value === 'boolean') enabledPlugins[id] = value;
    }
  }
  const options = {};
  if (source.options !== null && typeof source.options === 'object') {
    for (const [id, value] of Object.entries(source.options)) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      const entry = {};
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') entry[key] = item;
      }
      options[id] = entry;
    }
  }
  const dirs = Array.isArray(source.dirs) ? source.dirs.filter((item) => typeof item === 'string' && item !== '') : [];
  const hasDirs = fallback === EMPTY_WORKSPACE || Object.prototype.hasOwnProperty.call(source, 'dirs');
  return {
    version: 1,
    enabledPlugins,
    options,
    ...(hasDirs ? { dirs } : {}),
  };
}

/** 深拷贝一个 workspace 形状（避免 mutator 改到常量）。 */
export function cloneWorkspace(config) {
  return {
    version: 1,
    enabledPlugins: { ...(config?.enabledPlugins ?? {}) },
    options: JSON.parse(JSON.stringify(config?.options ?? {})),
    dirs: [...(config?.dirs ?? [])],
  };
}

/** 启动期一次性的健康检查：数据目录不可写时只告警，不让插件整体挂掉。 */
export async function probeWritable(ctx) {
  const probe = join(hubRoot(ctx), `.probe-${process.pid}`);
  try {
    const paths = await ensureHubDirs(ctx);
    await writeFile(probe, 'ok', 'utf8');
    return { ok: true, root: paths.root };
  } catch (error) {
    warn(`data directory is not writable: ${error?.message ?? error}`);
    return { ok: false, error: String(error?.message ?? error) };
  } finally {
    // 探测文件不留在数据目录里：每次启动都会写一个，堆积没有意义。
    await rm(probe, { force: true }).catch(() => {});
  }
}
