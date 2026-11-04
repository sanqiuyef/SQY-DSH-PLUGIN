/**
 * dsh-plugin-hub — 统一的项目信任存储（三件套契约 §1）。
 *
 * 为什么需要：同一个 DSH profile 里同时装着 dsh-mcp-manager、dsh-plugin-hub、
 * dsh-skill-manager，三者对「项目配置的信任」必须同一套口径。旧实现各自记一份
 * （`data/plugin-hub/trusted.json`、`data/mcp-manager/trusted-projects.json`），
 * 用户在其中一个插件里点过「信任」之后，另一个仍然认为项目未授权。契约把权威存储定在：
 *
 *   <profileDir>/data/project-trust/trusted.json
 *
 * 一份记录同时覆盖项目里的两份配置文件：
 *
 *   mcp      = <cwd>/.dsh/mcp.json      的字节 sha256，不存在为 null
 *   plugins  = <cwd>/.dsh/plugins.json  的字节 sha256，不存在为 null
 *
 * 聚合 hash（必须与其它两个仓库逐字节一致，契约 §1.3）：
 *
 *   canonical = "dsh-project-trust/v1\n" + "mcp:" + (mcp ?? "-") + "\n" + "plugins:" + (plugins ?? "-")
 *   hash      = sha256(canonical, utf8) 的 hex
 *
 * 旧记录只读回退（契约 §1.4）：旧 mcp-manager 的 `trusted-projects.json`（key = 原始
 * 绝对路径）与旧 hub 的 `trusted.json`（key = trustKey(cwd)）继续参与判定，但新代码只往
 * canonical 存储写。用户点一次「信任」后整体升级为 canonical，此后任一份文件变化都需要
 * 重新批准。
 *
 * 写入协议（契约 §1.5）：读当前 canonical → 只改自己这条 → 原子写回；锁文件固定为
 * `<store>.lock`，另一个插件用同一路径加锁，所以两边不会把对方的记录覆盖掉。
 *
 * 本模块不 import `trust.js`：`trust.js` 反过来消费这里的判定，保持依赖单向。
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { mcpManagerTrustPath, profileDirOf, hubPaths, trustKey } from './store.js';
import { ensureDir, nowIso, readJsonFile, withLock, writeJsonAtomic } from './util.js';

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

/** canonical 存储的绝对路径（纯函数，供测试与其它模块断言路径）。 */
export function trustStorePathFor(profileDir) {
  return join(profileDir, 'data', 'project-trust', TRUST_STORE_FILE);
}

/** 本 profile 的 canonical 存储路径。 */
export function trustStorePath(ctx) {
  return trustStorePathFor(profileDirOf(ctx));
}

/** canonical 存储的锁文件（契约 §1.5 固定为 `<store>.lock`）。 */
export function trustLockPath(ctx) {
  return `${trustStorePath(ctx)}.lock`;
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
 * 聚合 hash 的 canonical 文本（逐字节照契约 §1.3；导出供测试断言字节）。
 *
 * @param {string|null} mcp
 * @param {string|null} plugins
 * @returns {string}
 */
export function canonicalTrustText(mcp, plugins) {
  const mcpPart = mcp === null || mcp === undefined ? '-' : String(mcp);
  const pluginsPart = plugins === null || plugins === undefined ? '-' : String(plugins);
  return `${CANONICAL_HEADER}\nmcp:${mcpPart}\nplugins:${pluginsPart}`;
}

/** 聚合 hash：`sha256(canonical, utf8)` 的 hex。 */
export function aggregateHash(mcp, plugins) {
  return createHash('sha256').update(canonicalTrustText(mcp, plugins), 'utf8').digest('hex');
}

/** 一份文件的**字节** sha256（不是先解码再编码）；不存在或不可读为 `null`。 */
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

/**
 * 读 canonical 存储。缺失或损坏都退化成空表：读取方的职责是「未信任」，不是抛错。
 *
 * @returns {Promise<{ version: number, projects: Record<string, object> }>}
 */
export async function readTrustStore(ctx) {
  const data = await readJsonFile(trustStorePath(ctx), { version: TRUST_VERSION, projects: {} });
  const projects = data?.projects !== null && typeof data?.projects === 'object' ? data.projects : {};
  const out = {};
  for (const [key, record] of Object.entries(projects)) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) continue;
    out[key] = record;
  }
  return { version: TRUST_VERSION, projects: out };
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
export async function readLegacyMcpTrust(ctx) {
  const data = await readJsonFile(mcpManagerTrustPath(ctx), { version: 1, projects: {} });
  const projects = data?.projects !== null && typeof data?.projects === 'object' ? data.projects : {};
  const out = {};
  for (const [project, record] of Object.entries(projects)) {
    if (record === null || typeof record !== 'object') continue;
    if (typeof record.hash !== 'string' || record.hash === '') continue;
    out[project] = { hash: record.hash, at: typeof record.at === 'string' ? record.at : '' };
  }
  return out;
}

/** 读旧 dsh-plugin-hub 信任库：key 为 `trustKey(cwd)`，字段是 `{ hash, approvedAt }`。 */
export async function readLegacyHubTrust(ctx) {
  const data = await readJsonFile(hubPaths(ctx).trusted, { version: 1, projects: {} });
  const projects = data?.projects !== null && typeof data?.projects === 'object' ? data.projects : {};
  const out = {};
  for (const [key, record] of Object.entries(projects)) {
    if (record === null || typeof record !== 'object') continue;
    if (typeof record.hash !== 'string' || record.hash === '') continue;
    out[key] = { hash: record.hash, approvedAt: typeof record.approvedAt === 'string' ? record.approvedAt : '' };
  }
  return out;
}

/**
 * 旧 mcp-manager 记录里这个项目的命中项。
 *
 * 旧记录用**原始绝对路径**做 key，同一条路径可能因大小写/分隔符写法不同而键不一致；
 * 因此按 trustKey（= 契约 §1.2 的规范形式）比较两边，而不是字符串等值比较。
 */
function legacyMcpHit(trust, cwd, mcpHash) {
  if (mcpHash === null) return false;
  const wanted = trustKey(cwd);
  for (const [key, record] of Object.entries(trust)) {
    if (trustKey(key) !== wanted) continue;
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
 * @param {object} ctx
 * @param {string} cwd
 * @param {{ files?: { mcp: string|null, plugins: string|null } }} [preloaded] 已算过的文件 hash
 * @returns {Promise<{
 *   cwd: string, key: string, storePath: string,
 *   files: { mcp: string|null, plugins: string|null }, hash: string,
 *   shared: boolean, mcp: string, plugins: string, source: string,
 *   record: object|null, legacy: { mcp: boolean, plugins: boolean }
 * }>}
 */
export async function trustStateFor(ctx, cwd, preloaded = {}) {
  const key = trustKey(cwd);
  const files = preloaded.files ?? (await projectFileHashes(cwd));
  const hash = aggregateHash(files.mcp, files.plugins);
  const store = await readTrustStore(ctx);
  const record = recordOf(store, key);
  const shared = record !== null && record.hash === hash;

  // 旧记录只在 canonical 没命中时才有意义（命中说明用户已经整体升级过一次）。
  const legacyMcp = shared ? false : legacyMcpHit(await readLegacyMcpTrust(ctx), cwd, files.mcp);
  let legacyHub = false;
  if (!shared && files.plugins !== null) {
    const hub = await readLegacyHubTrust(ctx);
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
    storePath: trustStorePath(ctx),
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
 * 「文件刚写完就批准」与「外部改动后点批准」得到同一份自洽记录。
 *
 * @param {object} ctx
 * @param {string} cwd
 * @returns {Promise<{ storePath: string, key: string, hash: string, files: object, approvedAt: string }>}
 */
export async function approveProject(ctx, cwd) {
  const storePath = trustStorePath(ctx);
  const key = trustKey(cwd);
  const files = await projectFileHashes(cwd);
  const hash = aggregateHash(files.mcp, files.plugins);
  const approvedAt = nowIso();

  await ensureDir(join(profileDirOf(ctx), 'data', 'project-trust'));
  await withLock(`${storePath}.lock`, async () => {
    // 锁内重读：另一个插件可能刚写过别的项目，不能整文件覆盖。
    const store = await readTrustStore(ctx);
    store.projects[key] = { hash, files: { mcp: files.mcp, plugins: files.plugins }, approvedAt };
    await writeJsonAtomic(storePath, { version: TRUST_VERSION, projects: store.projects });
  });
  return { storePath, key, hash, files, approvedAt };
}
