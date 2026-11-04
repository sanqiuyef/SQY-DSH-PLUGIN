/**
 * dsh-mcp-manager — 统一的项目信任存储（契约 §1）。
 *
 * 为什么要有这个模块：同一个 DSH profile 里同时装着 dsh-mcp-manager、dsh-plugin-hub、
 * dsh-skill-manager，三者的「项目配置信任」必须同一套口径，否则用户在其中一个插件里点过
 * 「信任」之后，另一个插件仍然会认为项目未授权。契约把权威存储定在：
 *
 *   <profileDir>/data/project-trust/trusted.json
 *
 * 一份记录同时覆盖项目里的两份配置文件：
 *
 *   mcp      = <cwd>/.dsh/mcp.json      的字节 sha256，不存在为 null
 *   plugins  = <cwd>/.dsh/plugins.json  的字节 sha256，不存在为 null
 *
 * 聚合 hash（必须与其它两个仓库逐字节一致，见契约 §1.3）：
 *
 *   canonical = "dsh-project-trust/v1\n" + "mcp:" + (mcp ?? "-") + "\n" + "plugins:" + (plugins ?? "-")
 *   hash      = sha256(canonical, utf8) 的 hex
 *
 * 历史记录只读回退（契约 §1.4）：旧 mcp-manager 的
 * `<profileDir>/data/mcp-manager/trusted-projects.json`（key = 原始绝对路径）与旧 hub 的
 * `<profileDir>/data/plugin-hub/trusted.json`（key = trustKey(cwd)）继续参与判定，但新代码
 * 只往 canonical 存储写。用户点一次「信任」后整体升级为 canonical，此后任一份文件变化都
 * 需要重新批准。
 *
 * 写入协议（契约 §1.5）：读当前 canonical → 只改自己这条 → 原子写回。锁文件固定为
 * `<store>.lock`（`withFileLockAt` 的约定），另一个插件用同一路径加锁，所以两边的
 * 读-合并-写不会交错。
 *
 * 本模块刻意不 import `project.js`：`project.js` 反过来包装这里的读写，保持依赖单向。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { withFileLockAt, writePatchText } from './patch.js';

/** canonical 存储的版本号与 canonical 文本的头行（契约 §1.2 / §1.3）。 */
export const TRUST_VERSION = 1;
export const CANONICAL_HEADER = 'dsh-project-trust/v1';

/** 存储文件名；完整路径是 `<profileDir>/data/project-trust/trusted.json`。 */
export const TRUST_STORE_FILE = 'trusted.json';

/** 项目里参与聚合的两份配置（相对项目根）。 */
export const PROJECT_MCP_FILE = join('.dsh', 'mcp.json');
export const PROJECT_PLUGINS_FILE = join('.dsh', 'plugins.json');

/** 分层状态：`not-applicable` = 对应的文件不存在（契约 §1.6）。 */
export const LAYER_TRUSTED = 'trusted';
export const LAYER_UNTRUSTED = 'untrusted';
export const LAYER_NOT_APPLICABLE = 'not-applicable';

/** 信任来源：canonical 命中 / 旧记录命中 / 都没有。 */
export const SOURCE_SHARED = 'shared';
export const SOURCE_LEGACY = 'legacy';
export const SOURCE_NONE = 'none';

/** canonical 存储的绝对路径。 */
export function trustStorePathFor(profileDir) {
  return join(profileDir, 'data', 'project-trust', TRUST_STORE_FILE);
}

/**
 * canonical 存储的锁文件路径。
 *
 * 只是把契约 §1.5 的约定显式暴露出来（供 UI/诊断和测试断言）；真正的加锁在
 * `withFileLockAt` 里完成，它锁的就是 `<store>.lock`。
 */
export function trustLockPathFor(profileDir) {
  return `${trustStorePathFor(profileDir)}.lock`;
}

/** 旧 mcp-manager 信任库（只读回退）。 */
export function legacyMcpTrustPathFor(profileDir) {
  return join(profileDir, 'data', 'mcp-manager', 'trusted-projects.json');
}

/** 旧 dsh-plugin-hub 信任库（只读回退，供「插件」分层状态显示）。 */
export function legacyHubTrustPathFor(profileDir) {
  return join(profileDir, 'data', 'plugin-hub', 'trusted.json');
}

/** 项目 MCP 配置的绝对路径。 */
export function mcpPathFor(cwd) {
  return join(cwd, PROJECT_MCP_FILE);
}

/** 项目插件配置的绝对路径。 */
export function pluginsPathFor(cwd) {
  return join(cwd, PROJECT_PLUGINS_FILE);
}

/**
 * 信任键的规范形式（契约 §1.2，必须与 dsh-plugin-hub 的 `trustKey` 一致）：
 * 反斜杠转 `/`、去掉末尾 `/`、Windows 上转小写。
 *
 * 刻意不做 `resolve()`：调用方传进来的已经是绝对路径，这里只做契约规定的三步变换，
 * 两个仓库才能算出同一个 key。
 */
export function normalizeTrustKey(cwd) {
  const normalized = String(cwd ?? '').replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** 聚合 hash 的 canonical 文本（逐字节照契约 §1.3；导出供测试断言字节）。 */
export function canonicalTrustText(mcp, plugins) {
  const mcpPart = mcp === null || mcp === undefined ? '-' : String(mcp);
  const pluginsPart = plugins === null || plugins === undefined ? '-' : String(plugins);
  return `${CANONICAL_HEADER}\nmcp:${mcpPart}\nplugins:${pluginsPart}`;
}

/** 聚合 hash：`sha256(canonical, utf8)` 的 hex。 */
export function aggregateHash(mcp, plugins) {
  return createHash('sha256').update(canonicalTrustText(mcp, plugins), 'utf8').digest('hex');
}

/** 一份文件的字节 sha256；不存在（或不可读）为 `null`。 */
export async function fileHashOrNull(path) {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex');
  } catch {
    return null;
  }
}

/** 一个项目当前两份配置的字节 hash：`{ mcp, plugins }`。 */
export async function projectFileHashes(cwd) {
  const [mcp, plugins] = await Promise.all([fileHashOrNull(mcpPathFor(cwd)), fileHashOrNull(pluginsPathFor(cwd))]);
  return { mcp, plugins };
}

/* ------------------------------------------------------------------ *
 * canonical 存储
 * ------------------------------------------------------------------ */

/** 只保留契约认识的字段；其它项目的记录原样保留，不丢字段。 */
function serializeStore(projects) {
  return `${JSON.stringify({ version: TRUST_VERSION, projects }, null, 2)}\n`;
}

/**
 * 读 canonical 存储。缺失或损坏都退化成空表：读取方的职责是「未信任」，不是抛错。
 *
 * @returns {Promise<{ version: number, projects: Record<string, object> }>}
 */
export async function readTrustStore(profileDir) {
  try {
    const raw = JSON.parse(await readFile(trustStorePathFor(profileDir), 'utf8'));
    const projects = raw?.projects;
    if (projects === null || typeof projects !== 'object' || Array.isArray(projects)) {
      return { version: TRUST_VERSION, projects: {} };
    }
    const out = {};
    for (const [key, record] of Object.entries(projects)) {
      if (record === null || typeof record !== 'object' || Array.isArray(record)) continue;
      out[key] = record;
    }
    return { version: TRUST_VERSION, projects: out };
  } catch {
    return { version: TRUST_VERSION, projects: {} };
  }
}

/** 一条 canonical 记录 → 判定需要的字段；结构不对视为没有记录。 */
function recordOf(store, key) {
  const record = store.projects?.[key];
  if (record === null || typeof record !== 'object' || typeof record.hash !== 'string' || record.hash === '') return null;
  return {
    hash: record.hash,
    files: {
      mcp: typeof record.files?.mcp === 'string' ? record.files.mcp : null,
      plugins: typeof record.files?.plugins === 'string' ? record.files.plugins : null,
    },
    approvedAt: typeof record.approvedAt === 'string' ? record.approvedAt : '',
  };
}

/* ------------------------------------------------------------------ *
 * 旧记录（只读回退）
 * ------------------------------------------------------------------ */

/**
 * 读旧 mcp-manager 信任库：`{ version, projects: { <原始绝对路径>: { hash, at } } }`。
 *
 * @returns {Promise<Record<string, { hash: string, at: string }>>}
 */
export async function readLegacyMcpTrust(profileDir) {
  try {
    const raw = JSON.parse(await readFile(legacyMcpTrustPathFor(profileDir), 'utf8'));
    const projects = raw?.projects;
    if (projects === null || typeof projects !== 'object' || Array.isArray(projects)) return {};
    const out = {};
    for (const [project, record] of Object.entries(projects)) {
      if (record === null || typeof record !== 'object') continue;
      if (typeof record.hash !== 'string' || record.hash === '') continue;
      out[project] = { hash: record.hash, at: typeof record.at === 'string' ? record.at : '' };
    }
    return out;
  } catch {
    return {};
  }
}

/** 读旧 dsh-plugin-hub 信任库：key 为 `trustKey(cwd)`，字段是 `{ hash, approvedAt }`。 */
export async function readLegacyHubTrust(profileDir) {
  try {
    const raw = JSON.parse(await readFile(legacyHubTrustPathFor(profileDir), 'utf8'));
    const projects = raw?.projects;
    if (projects === null || typeof projects !== 'object' || Array.isArray(projects)) return {};
    const out = {};
    for (const [key, record] of Object.entries(projects)) {
      if (record === null || typeof record !== 'object') continue;
      if (typeof record.hash !== 'string' || record.hash === '') continue;
      out[key] = { hash: record.hash, approvedAt: typeof record.approvedAt === 'string' ? record.approvedAt : '' };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 旧 mcp-manager 记录里这个项目的命中项。
 *
 * 旧记录是**原始绝对路径**做 key，但同一条路径可能因为大小写/分隔符写法不同而键不一致；
 * 因此按契约的规范形式比较两边，而不是只做字符串等值比较。
 */
function legacyMcpHit(trust, cwd, mcpHash) {
  if (mcpHash === null) return false;
  const wanted = normalizeTrustKey(cwd);
  for (const [key, record] of Object.entries(trust)) {
    if (normalizeTrustKey(key) !== wanted) continue;
    if (record.hash === mcpHash) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 判定 / 写入
 * ------------------------------------------------------------------ */

/**
 * 一个项目此刻的信任状态（契约 §1.4 + §1.6）。
 *
 * @param {string} profileDir
 * @param {string} cwd
 * @returns {Promise<{
 *   cwd: string, key: string, storePath: string,
 *   files: { mcp: string|null, plugins: string|null }, hash: string,
 *   shared: boolean, mcp: string, plugins: string, source: string,
 *   record: object|null, legacy: { mcp: boolean, plugins: boolean }
 * }>}
 */
export async function trustStateFor(profileDir, cwd) {
  const key = normalizeTrustKey(cwd);
  const files = await projectFileHashes(cwd);
  const hash = aggregateHash(files.mcp, files.plugins);
  const store = await readTrustStore(profileDir);
  const record = recordOf(store, key);
  const shared = record !== null && record.hash === hash;

  const legacyMcp = shared ? false : legacyMcpHit(await readLegacyMcpTrust(profileDir), cwd, files.mcp);
  let legacyHub = false;
  if (!shared && files.plugins !== null) {
    const hub = await readLegacyHubTrust(profileDir);
    legacyHub = hub[key]?.hash === files.plugins;
  }

  // 「不适用」= 对应文件不存在；存在时再判断有没有被批准（canonical 或旧记录）。
  const mcpLayer = files.mcp === null ? LAYER_NOT_APPLICABLE : shared || legacyMcp ? LAYER_TRUSTED : LAYER_UNTRUSTED;
  const pluginsLayer =
    files.plugins === null ? LAYER_NOT_APPLICABLE : shared || legacyHub ? LAYER_TRUSTED : LAYER_UNTRUSTED;
  const source = shared ? SOURCE_SHARED : legacyMcp || legacyHub ? SOURCE_LEGACY : SOURCE_NONE;

  return {
    cwd,
    key,
    storePath: trustStorePathFor(profileDir),
    files,
    hash,
    shared,
    mcp: mcpLayer,
    plugins: pluginsLayer,
    source,
    record,
    legacy: { mcp: legacyMcp, plugins: legacyHub },
  };
}

/**
 * 批准一个项目的当前内容（读-合并-原子写，锁 `<store>.lock`）。
 *
 * 两份文件的 hash 在**批准这一刻**重新读盘，而不是相信调用方传进来的旧值：
 * 这样「文件刚写完就批准」与「外部改动后点批准」得到的是同一份自洽记录。
 *
 * @param {string} profileDir
 * @param {string} cwd
 * @returns {Promise<{ storePath: string, key: string, hash: string, files: object, approvedAt: string }>}
 */
export async function approveProject(profileDir, cwd) {
  const storePath = trustStorePathFor(profileDir);
  const key = normalizeTrustKey(cwd);
  const files = await projectFileHashes(cwd);
  const hash = aggregateHash(files.mcp, files.plugins);
  const approvedAt = new Date().toISOString();

  await mkdir(dirname(storePath), { recursive: true, mode: 0o700 });
  await withFileLockAt(storePath, async () => {
    const store = await readTrustStore(profileDir);
    store.projects[key] = { hash, files: { mcp: files.mcp, plugins: files.plugins }, approvedAt };
    await writePatchText(storePath, serializeStore(store.projects));
  });
  return { storePath, key, hash, files, approvedAt };
}

/** 删掉旧 mcp-manager 记录里这个项目的一条；返回是否真的删掉。 */
async function removeLegacyMcpRecord(profileDir, cwd) {
  const path = legacyMcpTrustPathFor(profileDir);
  const wanted = normalizeTrustKey(cwd);
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    const projects = raw?.projects;
    if (projects === null || typeof projects !== 'object' || Array.isArray(projects)) return false;
    const keys = Object.keys(projects).filter((key) => normalizeTrustKey(key) === wanted);
    if (keys.length === 0) return false;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await withFileLockAt(path, async () => {
      // 锁内重读，避免把别处刚写进来的记录覆盖掉。
      const current = JSON.parse(await readFile(path, 'utf8'));
      const next = current?.projects !== null && typeof current?.projects === 'object' ? { ...current.projects } : {};
      for (const key of keys) delete next[key];
      await writePatchText(path, `${JSON.stringify({ ...current, version: current?.version ?? 1, projects: next }, null, 2)}\n`);
    });
    return true;
  } catch {
    // 旧文件损坏、被删、或被占用都不是拒绝撤销的理由：canonical 记录才是权威。
    return false;
  }
}

/**
 * 撤销一个项目的批准：删 canonical 记录，并尽力删掉自己的旧记录（契约 §1.5）。
 * 旧 hub 记录属于另一个插件，不动。
 *
 * @returns {Promise<{ removed: boolean, legacyRemoved: boolean }>}
 */
export async function revokeProject(profileDir, cwd) {
  const storePath = trustStorePathFor(profileDir);
  const key = normalizeTrustKey(cwd);
  let removed = false;
  await mkdir(dirname(storePath), { recursive: true, mode: 0o700 });
  await withFileLockAt(storePath, async () => {
    const store = await readTrustStore(profileDir);
    if (store.projects[key] === undefined) return;
    delete store.projects[key];
    await writePatchText(storePath, serializeStore(store.projects));
    removed = true;
  });
  const legacyRemoved = await removeLegacyMcpRecord(profileDir, cwd);
  return { removed, legacyRemoved };
}
