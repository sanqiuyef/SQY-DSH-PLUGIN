/**
 * dsh-mcp-manager — project-scope route handlers.
 *
 * The eight global routes operate on the profile patch through the host's own
 * services. Project servers are plain JSON in the user's repository, so their
 * handlers are simpler: read, validate with the same validator the global rows use,
 * write atomically, then re-approve the exact content the user just authored.
 *
 * Every mutation re-approves the new hash: an edit made through this page is an
 * explicit user action, so the next `agent/pre-step` may mount it without a second
 * confirmation. Any change made *outside* the page (git pull, editor) keeps the
 * previous hash and therefore stays unapproved until the user trusts it again.
 */

import { ApiError, badRequest } from './security.js';
import { profileDirOf } from './patch.js';
import { validateServerInput } from './diagnostics.js';
import { projectRuntimeSnapshot, remountProjectServer } from './project-runtime.js';
import { globalMcpOccupancy, isShadowedByGlobal } from './global-mcp.js';
import { LAYER_TRUSTED, LAYER_UNTRUSTED } from './project-trust.js';
import {
  missingEnvReferences,
  mutateProject,
  projectRows,
  readProject,
  readProjectTrust,
  resolveProjectDir,
  runtimeConfigOf,
  trustProject,
} from './project.js';

/** The live Session's project directory, or `null` when no Agent is live. */
export function defaultProjectDir(ctx) {
  try {
    const registry = typeof ctx.get === 'function' ? ctx.get('agents') : ctx.agents;
    const agents = typeof registry?.list === 'function' ? registry.list() : [];
    for (let index = agents.length - 1; index >= 0; index -= 1) {
      const session = agents[index]?.session;
      if (session === undefined) continue;
      const dir = ctx.workingDirectory?.get?.(session);
      if (typeof dir === 'string' && dir !== '') return dir;
    }
  } catch {
    /* an unavailable registry is the same as no live Agent */
  }
  return null;
}

/** Resolve the target project: the caller's `cwd`, else the newest live Session. */
async function projectDirOf(ctx, value) {
  try {
    if (typeof value === 'string' && value.trim() !== '') return await resolveProjectDir(value);
    const fallback = defaultProjectDir(ctx);
    if (fallback === null) {
      throw new ApiError('not-found', 'no live Session provides a project directory; pass "cwd" explicitly');
    }
    return await resolveProjectDir(fallback);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(error?.code === 'not-found' ? 'not-found' : 'bad-request', String(error?.message ?? error));
  }
}

/** 把页面上的一条项目服务器变成文件里的配置：去掉 manager 专用字段，空默认值不落盘。 */
function configOfServer(server) {
  const config = { ...server };
  delete config.serverName;
  if (Array.isArray(config.args) && config.args.length === 0) delete config.args;
  if (config.env !== null && typeof config.env === 'object' && Object.keys(config.env).length === 0) delete config.env;
  if (config.headers !== null && typeof config.headers === 'object' && Object.keys(config.headers).length === 0) delete config.headers;
  if (config.cwd === '') delete config.cwd;
  return config;
}

/**
 * Build the `GET /project` payload.
 *
 * 除原有字段外，0.2.2 增加两个契约字段（§1.6 / §2）：
 *   - `trustLayers`：`{ mcp, plugins, shared, source }`，值为 `trusted | untrusted |
 *     not-applicable`（文件不存在即不适用），供前端逐层显示；
 *   - `skipped`：会被挂载、但已被全局同名服务器占用的项目服务器名（全局优先）。
 *
 * @param {object} ctx
 * @param {string} [requestedCwd]
 */
export async function projectView(ctx, requestedCwd) {
  const cwd = await projectDirOf(ctx, requestedCwd);
  const view = await readProject(cwd);
  const trust = await readProjectTrust(profileDirOf(ctx), cwd);
  // `trusted` 仍是「MCP 这一层可用」：页面原有按钮与运行时的挂载条件都看它。
  const trusted = view.exists && view.error === null && trust.mcp === LAYER_TRUSTED;
  const rows = projectRows(view);
  const problems = [];

  if (view.error !== null) problems.push({ level: 'error', serverName: null, message: view.error });
  if (view.exists && view.error === null && rows.length > 0 && trust.mcp === LAYER_UNTRUSTED) {
    problems.push({
      level: 'warn',
      serverName: null,
      message: '这个项目的 MCP 配置还没有被信任，当前不会挂载到任何会话；确认内容后点击「信任并启用」。',
    });
  }
  if (trust.plugins === LAYER_UNTRUSTED) {
    problems.push({
      level: 'warn',
      serverName: null,
      message: '本项目的插件配置（.dsh/plugins.json）还没有被信任；「信任并启用」一次同时覆盖 MCP 与插件配置。',
    });
  }
  for (const [serverName, config] of Object.entries(view.data.mcpServers)) {
    for (const item of missingEnvReferences(config)) {
      problems.push({
        level: 'warn',
        serverName,
        message: `${item.field}.${item.key} 引用的环境变量 ${item.name} 未设置，挂载后会得到空字符串`,
      });
    }
  }

  // 全局优先（契约 §2）：占用的名字在运行时会被跳过，这里标记并给出跳过清单。
  const occupancy = await globalMcpOccupancy(ctx);
  const enabledNames = Object.entries(view.data.mcpServers)
    .filter(([serverName]) => !view.data.disabled.includes(serverName))
    .map(([serverName]) => serverName);
  const skipped = enabledNames.filter((serverName) => isShadowedByGlobal(serverName, occupancy));
  const skippedSet = new Set(skipped);
  for (const row of rows) {
    if (!isShadowedByGlobal(row.serverName, occupancy)) continue;
    problems.push({
      level: 'warn',
      serverName: row.serverName,
      message: '与全局 MCP 服务器同名：项目配置中的这一条不会挂载（全局优先）',
    });
  }
  const servers = rows.map((row) => ({ ...row, skipped: skippedSet.has(row.serverName) }));

  return {
    scope: 'project',
    cwd,
    path: view.path,
    exists: view.exists,
    trusted,
    hash: view.hash,
    trustLayers: {
      mcp: trust.mcp,
      plugins: trust.plugins,
      shared: trust.shared,
      source: trust.source,
    },
    skipped,
    servers,
    problems,
    totals: {
      servers: servers.length,
      enabled: servers.filter((server) => server.enabled).length,
      active: projectRuntimeSnapshot().sessions.filter((session) => session.cwd === cwd).length,
      tools: 0,
    },
    runtime: projectRuntimeSnapshot().sessions.filter((session) => session.cwd === cwd),
  };
}

/**
 * `POST /project/trust`: approve the exact current content.
 *
 * 一次批准覆盖本项目的 `.dsh/mcp.json` 与 `.dsh/plugins.json`（契约 §1.5/§1.6）。
 * 两份文件都不存在时没有可批准的内容，直接拒绝而不是写一条空记录。
 */
export async function trustProjectScope(ctx, requestedCwd) {
  const cwd = await projectDirOf(ctx, requestedCwd);
  const view = await readProject(cwd);
  if (view.error !== null) throw new ApiError('conflict', `project file is not valid: ${view.error}`);
  const trust = await readProjectTrust(profileDirOf(ctx), cwd);
  if (trust.files.mcp === null && trust.files.plugins === null) {
    throw new ApiError('conflict', 'this project has no .dsh/mcp.json or .dsh/plugins.json to approve');
  }
  await trustProject(profileDirOf(ctx), cwd);
  return projectView(ctx, cwd);
}

/**
 * `POST /project/add`.
 *
 * @param {object} ctx
 * @param {string} requestedCwd
 * @param {unknown} input - the same server shape `validateServerInput` accepts
 */
export async function addProjectServer(ctx, requestedCwd, input) {
  const cwd = await projectDirOf(ctx, requestedCwd);
  const validation = validateServerInput(input);
  if (!validation.ok) throw new ApiError('bad-request', 'invalid server definition', { details: validation.errors });
  const server = validation.server;
  await mutateProject(cwd, (data) => {
    if (data.mcpServers[server.serverName] !== undefined) {
      throw new ApiError('conflict', `server "${server.serverName}" already exists in this project`);
    }
    const next = { ...data, mcpServers: { ...data.mcpServers, [server.serverName]: configOfServer(server) } };
    next.disabled = data.disabled.filter((name) => name !== server.serverName);
    return next;
  });
  await trustProject(profileDirOf(ctx), cwd);
  return projectView(ctx, cwd);
}

/** `POST /project/update`: merge omitted `env`/`headers` from the previous config. */
export async function updateProjectServer(ctx, requestedCwd, serverName, config) {
  const cwd = await projectDirOf(ctx, requestedCwd);
  if (typeof serverName !== 'string' || serverName === '') throw badRequest('"serverName" must be a non-empty string');
  if (config === null || typeof config !== 'object' || Array.isArray(config)) throw badRequest('"config" must be an object');
  await mutateProject(cwd, (data) => {
    const current = data.mcpServers[serverName];
    if (current === undefined) throw new ApiError('not-found', `server "${serverName}" is not in this project`);
    const nextConfig = { ...current, ...config };
    if (!Object.prototype.hasOwnProperty.call(config, 'env')) nextConfig.env = current.env;
    if (!Object.prototype.hasOwnProperty.call(config, 'headers')) nextConfig.headers = current.headers;
    const validation = validateServerInput({ serverName, ...nextConfig });
    if (!validation.ok) throw new ApiError('bad-request', 'invalid server definition', { details: validation.errors });
    return { ...data, mcpServers: { ...data.mcpServers, [serverName]: nextConfig } };
  });
  await trustProject(profileDirOf(ctx), cwd);
  return projectView(ctx, cwd);
}

/** `POST /project/remove`. */
export async function removeProjectServer(ctx, requestedCwd, serverName) {
  const cwd = await projectDirOf(ctx, requestedCwd);
  if (typeof serverName !== 'string' || serverName === '') throw badRequest('"serverName" must be a non-empty string');
  await mutateProject(cwd, (data) => {
    if (data.mcpServers[serverName] === undefined) throw new ApiError('not-found', `server "${serverName}" is not in this project`);
    const mcpServers = { ...data.mcpServers };
    delete mcpServers[serverName];
    return { mcpServers, disabled: data.disabled.filter((name) => name !== serverName) };
  });
  await trustProject(profileDirOf(ctx), cwd);
  return projectView(ctx, cwd);
}

/** `POST /project/toggle`: the `disabled` list keeps the standard map portable. */
export async function setProjectServerEnabled(ctx, requestedCwd, serverName, enabled) {
  const cwd = await projectDirOf(ctx, requestedCwd);
  if (typeof serverName !== 'string' || serverName === '') throw badRequest('"serverName" must be a non-empty string');
  if (typeof enabled !== 'boolean') throw badRequest('"enabled" must be a boolean');
  await mutateProject(cwd, (data) => {
    if (data.mcpServers[serverName] === undefined) throw new ApiError('not-found', `server "${serverName}" is not in this project`);
    const disabled = data.disabled.filter((name) => name !== serverName);
    if (!enabled) disabled.push(serverName);
    return { ...data, disabled };
  });
  await trustProject(profileDirOf(ctx), cwd);
  return projectView(ctx, cwd);
}

/**
 * `POST /servers/reconnect` with `scope: 'project'`: force one project server to
 * remount in every live Session of its project.
 *
 * Refuses a disabled or unknown entry: reconnecting something the file says is off
 * would contradict the list the page is showing. A project with no live Session is
 * not an error — the file change already applies on the next `agent/pre-step`.
 *
 * @param {object} ctx
 * @param {string} requestedCwd
 * @param {string} serverName
 */
export async function reconnectProjectServer(ctx, requestedCwd, serverName) {
  const cwd = await projectDirOf(ctx, requestedCwd);
  if (typeof serverName !== 'string' || serverName === '') throw badRequest('"serverName" must be a non-empty string');
  const view = await readProject(cwd);
  if (view.error !== null) throw new ApiError('conflict', `project file is not valid: ${view.error}`);
  if (view.data.mcpServers[serverName] === undefined) {
    throw new ApiError('not-found', `server "${serverName}" is not in this project`);
  }
  if (view.data.disabled.includes(serverName)) {
    throw new ApiError('conflict', 'the server is disabled; enable it before reconnecting');
  }
  // Nothing is mounted for an unapproved file, so "reconnect" would be a no-op with
  // a misleading count. Say what is actually missing.
  const trust = await readProjectTrust(profileDirOf(ctx), cwd);
  if (trust.mcp !== LAYER_TRUSTED) {
    throw new ApiError('conflict', 'this project is not trusted; trust it before reconnecting');
  }
  return remountProjectServer(ctx, cwd, serverName);
}

/**
 * Resolve one project server into the probe target the existing `/probe` route
 * understands, resolving `${env:NAME}` references the same way the runtime does.
 *
 * @param {object} ctx
 * @param {string} requestedCwd
 * @param {string} serverName
 */
export async function projectProbeTarget(ctx, requestedCwd, serverName) {
  const cwd = await projectDirOf(ctx, requestedCwd);
  if (typeof serverName !== 'string' || serverName === '') throw badRequest('"serverName" must be a non-empty string');
  const view = await readProject(cwd);
  if (view.error !== null) throw new ApiError('conflict', `project file is not valid: ${view.error}`);
  const config = view.data.mcpServers[serverName];
  if (config === undefined) throw new ApiError('not-found', `server "${serverName}" is not in this project`);
  const validation = validateServerInput({ serverName, ...runtimeConfigOf(config) });
  if (!validation.ok) throw new ApiError('bad-request', 'invalid server definition', { details: validation.errors });
  return { serverName, server: validation.server };
}
