/**
 * dsh-mcp-manager — project-scope MCP configuration.
 *
 * Global MCP servers live in the profile patch as Loader rows and are available to
 * every Session. Project servers live in the project itself:
 *
 *   <project>/.dsh/mcp.json
 *
 * so the configuration travels with the repository (and can be reviewed in a PR)
 * instead of leaking into one user's profile. The file uses the same
 * `{ "mcpServers": {...} }` shape as `import` / `export`, plus one manager-only
 * key:
 *
 *   {
 *     "mcpServers": { "<serverName>": { "transport": "stdio", "command": "...", ... } },
 *     "disabled": ["<serverName>"]
 *   }
 *
 * **Trust gate.** A repository is untrusted input: cloning it must not be enough to
 * make this host execute an arbitrary command on session start. The runtime only
 * mounts project servers when the exact file content has been approved by the user
 * (the settings page adds that approval when the user edits the list, or through an
 * explicit "trust" action).
 *
 * 信任存储自 0.2.2 起与 dsh-plugin-hub 统一（契约 §1，见 `project-trust.js`）：权威记录
 * 在 `<profileDir>/data/project-trust/trusted.json`，一份记录同时覆盖本项目的
 * `.dsh/mcp.json` 与 `.dsh/plugins.json`，任一份内容变化都需要重新批准。旧
 * `<profileDir>/data/mcp-manager/trusted-projects.json` 只读回退，点一次「信任」即整体
 * 升级为 canonical。本文件里的 `readTrust` / `isProjectTrusted` 保留原签名，语义收窄为
 * 「旧的 mcp-manager 这一层」；完整判定走 `readProjectTrust`（薄封装到 `project-trust.js`）。
 *
 * **Secrets.** Values may be literals or one indirection: `${env:NAME}` (or a pasted
 * `process.env.NAME`). The indirection is resolved in the host process at mount time
 * and is what the UI shows as a reference, so committed files can stay secret-free.
 *
 * All reads are tolerant: a missing or malformed file is data the page reports, not
 * a throw that would take the routes down.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { describeKeyMap, withFileLockAt, writePatchText } from './patch.js';
import { lastProbeOf, probeTargetFingerprint } from './probe.js';
import {
  approveProject,
  legacyMcpTrustPathFor,
  readLegacyMcpTrust,
  revokeProject as revokeCanonicalProject,
  trustStateFor,
} from './project-trust.js';

/** Project-scope file, relative to the project directory. */
export const PROJECT_DIR = '.dsh';
export const PROJECT_FILE = 'mcp.json';

/** 旧 mcp-manager 信任库的文件名（0.2.2 起只读回退；权威记录在 `data/project-trust/trusted.json`）。 */
export const TRUST_FILE = 'trusted-projects.json';

/** One server name, same rule the host applies (`[A-Za-z0-9_-]{1,32}`). */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** `mcpServers` entry keys carried into `@deepseek-ai/dsh-mcp-client`. */
const CONFIG_KEYS = [
  'transport',
  'command',
  'args',
  'env',
  'cwd',
  'url',
  'headers',
  'toolCallTimeoutMs',
  'failOnStartupError',
  'maxInstructionBytes',
  'reconnect',
];

/** `${env:NAME}` and a pasted `process.env.NAME` are the two reference forms. */
const ENV_REFERENCE = /^(?:\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}|(?:!!js\s+)?process\.env\.([A-Za-z_][A-Za-z0-9_]*))$/;

/** Absolute path of one project's configuration file. */
export function projectPathFor(cwd) {
  return join(cwd, PROJECT_DIR, PROJECT_FILE);
}

/** 旧 mcp-manager 信任库的绝对路径（0.2.2 起只读回退）。 */
export function trustPathFor(profileDir) {
  return legacyMcpTrustPathFor(profileDir);
}

/** `sha256` of one file's bytes, or `null` when it does not exist. */
export function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Validate and canonicalize a caller-supplied project directory.
 *
 * @param {unknown} value
 * @returns {Promise<string>} absolute project directory
 * @throws {Error & { code?: string }} when the value is not an existing directory
 */
export async function resolveProjectDir(value) {
  if (typeof value !== 'string' || value.trim() === '') throw projectError('bad-request', '"cwd" must be an absolute project path');
  const cwd = resolve(value);
  if (!isAbsolute(cwd)) throw projectError('bad-request', '"cwd" must be absolute');
  let info;
  try {
    info = await stat(cwd);
  } catch {
    throw projectError('not-found', `project directory does not exist: ${cwd}`);
  }
  if (!info.isDirectory()) throw projectError('bad-request', `not a directory: ${cwd}`);
  return cwd;
}

/** A route-level error with a stable code, mirroring the contract's envelope. */
export function projectError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Read one project file.
 *
 * @param {string} cwd - absolute project directory
 * @returns {Promise<{ cwd: string, path: string, exists: boolean, text: string, hash: string, data: object, error: string | null }>}
 */
export async function readProject(cwd) {
  const path = projectPathFor(cwd);
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { cwd, path, exists: false, text: '', hash: hashBytes(Buffer.alloc(0)), data: emptyProjectData(), error: null };
    }
    return {
      cwd,
      path,
      exists: false,
      text: '',
      hash: hashBytes(Buffer.alloc(0)),
      data: emptyProjectData(),
      error: `cannot read ${path}: ${error?.message ?? error}`,
    };
  }
  const text = bytes.toString('utf8');
  const hash = hashBytes(bytes);
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { cwd, path, exists: true, text, hash, data: emptyProjectData(), error: `invalid JSON: ${error?.message ?? error}` };
  }
  const normalized = normalizeProjectData(raw);
  return { cwd, path, exists: true, text, hash, data: normalized.data, error: normalized.error };
}

/** Empty project document. */
export function emptyProjectData() {
  return { mcpServers: {}, disabled: [] };
}

/**
 * Tolerant normalization: unknown keys are preserved on disk, but only the shape
 * this plugin understands reaches the runtime and the page.
 *
 * @param {unknown} raw
 * @returns {{ data: { mcpServers: Record<string, object>, disabled: string[] }, error: string | null }}
 */
export function normalizeProjectData(raw) {
  const data = emptyProjectData();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { data, error: 'the project file must be a JSON object' };
  }
  const servers = raw.mcpServers;
  if (servers !== undefined && (servers === null || typeof servers !== 'object' || Array.isArray(servers))) {
    return { data, error: '"mcpServers" must be an object' };
  }
  for (const [name, config] of Object.entries(servers ?? {})) {
    if (!SERVER_NAME_PATTERN.test(name)) continue;
    if (config === null || typeof config !== 'object' || Array.isArray(config)) continue;
    data.mcpServers[name] = { ...config };
  }
  const disabled = raw.disabled;
  if (Array.isArray(disabled)) {
    data.disabled = disabled.filter((name) => typeof name === 'string' && SERVER_NAME_PATTERN.test(name));
  }
  return { data, error: null };
}

/** Stable JSON text for the project file (2-space, trailing newline). */
export function serializeProjectData(data) {
  return `${JSON.stringify({ mcpServers: data.mcpServers ?? {}, disabled: data.disabled ?? [] }, null, 2)}\n`;
}

/**
 * Replace one project file atomically, serialized against other writers of the
 * same project. Creates `<project>/.dsh/` when needed.
 *
 * @param {string} cwd
 * @param {{ mcpServers: Record<string, object>, disabled: string[] }} data
 * @returns {Promise<string>} the new file hash
 */
export async function writeProjectData(cwd, data) {
  const path = projectPathFor(cwd);
  const text = serializeProjectData(data);
  await withFileLockAt(path, async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writePatchText(path, text);
  });
  return hashBytes(Buffer.from(text, 'utf8'));
}

/**
 * Read-modify-write one project under its lock, so two page actions cannot
 * interleave. The mutator returns the next data (or throws to abort).
 *
 * @param {string} cwd
 * @param {(data: { mcpServers: Record<string, object>, disabled: string[] }) => object} mutate
 * @returns {Promise<{ data: object, hash: string, path: string }>}
 */
export async function mutateProject(cwd, mutate) {
  const path = projectPathFor(cwd);
  let data;
  let hash = '';
  await withFileLockAt(path, async () => {
    const current = await readProject(cwd);
    if (current.exists && current.error !== null) throw projectError('conflict', `project file is not valid: ${current.error}`);
    data = normalizeProjectData(mutate(current.data)).data;
    const text = serializeProjectData(data);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writePatchText(path, text);
    hash = hashBytes(Buffer.from(text, 'utf8'));
  });
  return { data, hash, path };
}

/* ------------------------------------------------------------------ *
 * Trust store — 薄封装到 `project-trust.js`（统一存储，契约 §1）
 * ------------------------------------------------------------------ */

/**
 * 读旧的 mcp-manager 信任记录（只读回退层）。
 *
 * 返回值保持 0.2.1 的形状：`{ <原始绝对路径>: { hash, at } }`，供旧记录的兼容判定与
 * 诊断使用。新代码应使用 `readProjectTrust`，它同时给出 mcp / 插件两层状态。
 *
 * @param {string} profileDir
 * @returns {Promise<Record<string, { hash: string, at: string }>>}
 */
export async function readTrust(profileDir) {
  return readLegacyMcpTrust(profileDir);
}

/**
 * 旧记录这一层的命中判断（纯函数，保留 0.2.1 的签名）。
 *
 * 完整判定（canonical + 两层）请用 `readProjectTrust`：从这里返回 `false` 只说明
 * 「旧的 mcp-manager 记录没命中」，用户仍可能已经批准过 canonical 存储。
 */
export function isProjectTrusted(trust, cwd, hash) {
  const wanted = String(cwd ?? '').replaceAll('\\', '/').replace(/\/+$/, '');
  const normalized = process.platform === 'win32' ? wanted.toLowerCase() : wanted;
  for (const [key, record] of Object.entries(trust ?? {})) {
    const candidate = String(key).replaceAll('\\', '/').replace(/\/+$/, '');
    const compared = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (compared === normalized && record?.hash === hash) return true;
  }
  return false;
}

/**
 * 一个项目此刻的信任状态（统一存储 + 旧记录回退）。
 *
 * @param {string} profileDir
 * @param {string} cwd
 */
export async function readProjectTrust(profileDir, cwd) {
  return trustStateFor(profileDir, cwd);
}

/**
 * 批准一个项目的当前内容（写 canonical 存储；旧记录保持只读）。
 *
 * 第三个参数保留是为了 0.2.1 的调用点兼容；实际写入的 hash 在批准时重新读盘，
 * 保证记录与磁盘上的两份文件自洽。
 *
 * @param {string} profileDir
 * @param {string} cwd
 * @returns {Promise<{ storePath: string, key: string, hash: string, files: object, approvedAt: string }>}
 */
export async function trustProject(profileDir, cwd) {
  const record = await approveProject(profileDir, cwd);
  // 0.2.1 的返回形状 `{ path, at }` 也保留：页面不使用它，但外部调用点不应读到 undefined。
  return { ...record, path: record.storePath, at: record.approvedAt };
}

/** 撤销一个项目的批准：删 canonical 记录，并尽力删掉自己的旧记录。 */
export async function revokeProject(profileDir, cwd) {
  return revokeCanonicalProject(profileDir, cwd);
}

/* ------------------------------------------------------------------ *
 * Mount / render helpers
 * ------------------------------------------------------------------ */

/** Resolve one `${env:NAME}` / `process.env.NAME` value; anything else is literal. */
export function resolveEnvValue(value) {
  if (typeof value !== 'string') return value;
  const match = ENV_REFERENCE.exec(value.trim());
  if (match === null) return value;
  const name = match[1] ?? match[2];
  const resolved = process.env[name];
  return typeof resolved === 'string' ? resolved : '';
}

/** Env/header facts for the page: reference form is shown, literal values never leave. */
export function describeProjectKeyMap(map) {
  const rows = describeKeyMap(map);
  return rows.map((row) => {
    const value = map?.[row.key];
    const match = typeof value === 'string' ? ENV_REFERENCE.exec(value.trim()) : null;
    if (match === null) return row;
    return { key: row.key, isJsExpr: true, jsExpr: `process.env.${match[1] ?? match[2]}` };
  });
}

/** The config this server would mount with, with references resolved. */
export function runtimeConfigOf(config) {
  const resolved = {};
  for (const key of CONFIG_KEYS) {
    if (!(key in config)) continue;
    resolved[key] = config[key];
  }
  if (resolved.env !== null && typeof resolved.env === 'object' && !Array.isArray(resolved.env)) {
    resolved.env = Object.fromEntries(Object.entries(resolved.env).map(([key, value]) => [key, resolveEnvValue(value)]));
  }
  if (resolved.headers !== null && typeof resolved.headers === 'object' && !Array.isArray(resolved.headers)) {
    resolved.headers = Object.fromEntries(
      Object.entries(resolved.headers).map(([key, value]) => [key, resolveEnvValue(value)]),
    );
  }
  return resolved;
}

/** Missing referenced variables, reported as warnings instead of silent empty values. */
export function missingEnvReferences(config) {
  const missing = [];
  for (const field of ['env', 'headers']) {
    const map = config?.[field];
    if (map === null || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const [key, value] of Object.entries(map)) {
      const match = typeof value === 'string' ? ENV_REFERENCE.exec(value.trim()) : null;
      if (match === null) continue;
      const name = match[1] ?? match[2];
      if (typeof process.env[name] !== 'string') missing.push({ field, key, name });
    }
  }
  return missing;
}

/**
 * Rows the page renders for one project. Deliberately the same field set the
 * global rows use, so one row component can present both scopes.
 *
 * @param {{ cwd: string, path: string, data: object, exists: boolean }} view
 */
export function projectRows(view) {
  const disabled = new Set(view.data.disabled ?? []);
  return Object.entries(view.data.mcpServers ?? {}).map(([serverName, config]) => {
    const transport = config.transport === 'streamable-http' || config.transport === 'http' ? 'streamable-http' : 'stdio';
    const command = typeof config.command === 'string' ? config.command : '';
    const args = Array.isArray(config.args) ? config.args.map(String) : [];
    const url = typeof config.url === 'string' ? config.url : '';
    return {
      entryId: null,
      patchId: null,
      serverName,
      transport,
      target: transport === 'stdio' ? [command, ...args].filter(Boolean).join(' ') : url,
      command,
      args,
      cwd: typeof config.cwd === 'string' ? config.cwd : '',
      url,
      envKeys: describeProjectKeyMap(config.env),
      headerKeys: describeProjectKeyMap(config.headers),
      toolCallTimeoutMs: typeof config.toolCallTimeoutMs === 'number' ? config.toolCallTimeoutMs : null,
      failOnStartupError: typeof config.failOnStartupError === 'boolean' ? config.failOnStartupError : null,
      maxInstructionBytes: typeof config.maxInstructionBytes === 'number' ? config.maxInstructionBytes : null,
      reconnect: config.reconnect !== null && typeof config.reconnect === 'object' && !Array.isArray(config.reconnect) ? { ...config.reconnect } : null,
      enabled: !disabled.has(serverName),
      fiberPhase: null,
      toolCount: 0,
      managed: false,
      source: 'project',
      lastProbe: lastProbeOf(serverName, probeTargetFingerprint({ transport, command, args, url })),
    };
  });
}

/** Absolute path of one project's configuration file, for the page. */
export function projectDocumentPath(cwd) {
  return projectPathFor(cwd);
}
