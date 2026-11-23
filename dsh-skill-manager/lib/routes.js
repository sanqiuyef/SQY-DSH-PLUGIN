/**
 * dsh-skill-manager — the Host HTTP surface.
 *
 * Twenty-three route paths: ten reads (overview, skill, market, usage,
 * host-skills, trash, search, skill/files, skill/file, roots/custom), twelve
 * writes (save, create, toggle, delete, invocation, batch, import, open,
 * market/install, market/uninstall, trash/restore, trash/purge, export), and
 * two mixed paths (`skill/file` and `roots/custom`) that also serve POST.
 * Every one is same-origin and authenticated through the host's own fence:
 *   1. `connection.requestRejection(request)` — authentication + Host/Origin gate;
 *   2. POST only: same-origin check, `application/json`, body cap;
 *   3. argument validation against the roots this request itself resolved.
 *
 * A caller can never name an arbitrary path: every `rootId` must be one of the
 * roots this scan produced, and every `dirName` must be a single path segment.
 * Responses are `no-store` — the filesystem changes outside this process.
 */

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { createArchive, extractArchive, isArchivePath } from './archive.js';
import { readProfileCustomDirs, runtimeDirs, setRuntimeDirs, writeProfileCustomDirs } from './custom-roots.js';
import { ApiError, badRequest, forbidden, notFound } from './errors.js';
import { importSkillPackage } from './import.js';
import {
  defaultMarketDir,
  findInstallRecord,
  installFromMarket,
  marketSummary,
  readInstallState,
  removeInstallRecord,
  scanMarket,
} from './market.js';
import { openInFileManager } from './open.js';
import { applyHostShadowing, applyPluginShadowing, findDisabledLeaks, listHostSkills } from './plugin-skills.js';
import { listSkillFiles, readSkillFile, writeSkillFile } from './resource.js';
import { firstNonEmpty, resolveRoots, rootById } from './roots.js';
import { isInside, isSafeSegment, scanAll, skillEntryPath } from './scan.js';
import { searchSkills } from './search.js';
import { createSkill, readSkill, saveSkill, setInvocation } from './skill-file.js';
import { setSkillEnabled, trashSkill } from './toggle.js';
import { listTrash, purgeTrash, restoreTrash } from './trash.js';
import { collectUsage } from './usage.js';

/** API prefix shared with the client half. */
export const API_BASE = '/skill-manager/api';

/**
 * Body cap for write routes.
 *
 * The skill content limit is 256 KiB (`skill-file.js`); the JSON envelope adds
 * the field names, escaping and the rest of the payload, so a body cap equal to
 * the content cap would make the advertised maximum unreachable.
 */
const MAX_BODY_BYTES = 512 * 1024;

/** Upper bound on one batch request; the panel never needs more in one go. */
export const BATCH_MAX_ITEMS = 200;

/** Answer an unaudienced request the way every host route does: fail closed. */
function rejectUnauthorized(ctx, request, response) {
  let rejection;
  try {
    rejection = ctx.connection?.requestRejection?.(request);
  } catch {
    rejection = 500;
  }
  if (rejection === undefined || rejection === null) return false;
  response.writeHead(Number(rejection) || 403, { 'cache-control': 'no-store' });
  response.end();
  return true;
}

/** Send JSON, never cacheable. */
function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

/** Send the contract's error envelope. */
function sendError(response, error) {
  if (error instanceof ApiError) {
    sendJson(response, error.status, { error: { code: error.code, message: error.message } });
    return;
  }
  sendJson(response, 500, { error: { code: 'internal', message: String(error?.message ?? error) } });
}

/** Answer a method the route does not accept. */
function methodNotAllowed(response, allow) {
  response.writeHead(405, { allow, 'cache-control': 'no-store' });
  response.end();
}

/** Require a JSON content type on a write route. */
function requireJson(request, response) {
  const type = String(request.headers['content-type'] ?? '').toLowerCase();
  if (type.startsWith('application/json')) return true;
  sendJson(response, 415, { error: { code: 'unsupported-media', message: 'this route requires application/json' } });
  return false;
}

/** Same-origin gate for mutations. */
function requireSameOrigin(ctx, request, response) {
  const site = request.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== '' && site !== 'same-origin' && site !== 'none') {
    sendJson(response, 403, { error: { code: 'forbidden', message: 'cross-site requests are refused' } });
    return false;
  }
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || origin === '') return true;
  let expected;
  try {
    expected = ctx.webServer?.getOrigin?.();
  } catch {
    expected = undefined;
  }
  if (typeof expected !== 'string' || expected === '') return true;
  try {
    if (new URL(origin).origin === new URL(expected).origin) return true;
  } catch {
    /* fall through to the rejection below */
  }
  sendJson(response, 403, { error: { code: 'forbidden', message: 'cross-origin requests are refused' } });
  return false;
}

/** Read and bound a JSON body. */
async function readJsonBody(request, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new ApiError('too-large', `request body exceeds ${limit} bytes`, 413);
    chunks.push(chunk);
  }
  if (size === 0) throw badRequest('a JSON body is required');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw badRequest(`request body is not valid JSON: ${error?.message ?? error}`);
  }
}

/** Query parameters of a request URL. */
function searchParams(request) {
  try {
    return new URL(request.url ?? '/', 'http://localhost').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/**
 * The cwd to derive project roots from when the caller names none.
 *
 * Project roots belong to a workspace, so the live session's effective directory
 * is the honest default: the panel is opened from inside a session, and the host
 * process cwd may be anywhere. Falls back to the host's default directory.
 */
function defaultCwd(ctx) {
  try {
    const registry = ctx.get?.('agents') ?? ctx.agents;
    const agents = typeof registry?.list === 'function' ? registry.list() : [];
    for (let index = agents.length - 1; index >= 0; index -= 1) {
      const session = agents[index]?.session;
      if (session === undefined) continue;
      const dir = ctx.workingDirectory?.get?.(session);
      if (typeof dir === 'string' && dir !== '') return dir;
    }
  } catch {
    /* fall through to the default directory */
  }
  try {
    const value = ctx.workingDirectory?.defaultDirectory;
    if (typeof value === 'string' && value !== '') return value;
  } catch {
    /* fall through to the process cwd */
  }
  return process.cwd();
}

/**
 * Resolve roots for one request, folding in the runtime custom roots added
 * through `/roots/custom`.
 *
 * The runtime list lives for this process only; the profile block is what
 * survives a reload (contract §8.6). Keeping it here means every route — scan,
 * market, search, create — sees the same root set without touching each call.
 *
 * @param {object} ctx - plugin context (unused today, kept for symmetry with the other helpers)
 * @param {object} config - normalized plugin config
 * @param {string} cwd - request working directory
 */
function resolveRootsFor(ctx, config, cwd) {
  const runtime = runtimeDirs();
  const options = runtime.length === 0
    ? config
    : { ...config, customSkillDirs: [...(Array.isArray(config.customSkillDirs) ? config.customSkillDirs : []), ...runtime] };
  return resolveRoots({ options, cwd });
}

/** A required string field of a JSON body. */
function requireString(body, key) {
  const value = body?.[key];
  if (typeof value !== 'string' || value === '') throw badRequest(`"${key}" is required`);
  return value;
}

/** An optional string field of a JSON body. */
function optionalString(body, key) {
  const value = body?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Normalize the entry kind, defaulting to a directory bundle. */
function normalizeKind(value) {
  if (value === undefined || value === null || value === '') return 'directory';
  if (value === 'directory' || value === 'file') return value;
  throw badRequest(`unsupported skill kind: ${String(value)}`);
}

/** Count skills per root for the overview payload. */
function countPerRoot(roots, skills) {
  const counts = new Map();
  for (const skill of skills) counts.set(skill.rootId, (counts.get(skill.rootId) ?? 0) + 1);
  return roots.map((root) => ({ ...root, skillCount: counts.get(root.id) ?? 0 }));
}

/** Names that already exist in a personal root, used for market "installed" marks. */
function personalSkillNames(skills) {
  return skills.filter((skill) => skill.source === 'user-dsh' || skill.source === 'user-agents').map((skill) => skill.name);
}

/**
 * Absolute paths of the writable roots this request resolved.
 *
 * The install ledger is shared by every workspace, so the market view narrows it
 * to these roots: an install recorded elsewhere must not read as "installed"
 * here (its "update" button would overwrite a same-named local skill).
 */
function writableRootPaths(roots) {
  return roots.filter((root) => root.writable === true).map((root) => root.path);
}

/** Payload shape of the plugin-provided skill view (contract §3.1). */
function pluginSkillsPayload(pluginSkills) {
  const skills = Array.isArray(pluginSkills?.skills) ? pluginSkills.skills : [];
  return {
    available: pluginSkills?.available === true,
    count: skills.length,
    providers: [...new Set(skills.map((skill) => skill.provider))].sort(),
    ...(typeof pluginSkills?.error === 'string' && pluginSkills.error !== '' ? { error: pluginSkills.error } : {}),
  };
}

/**
 * Derive the v2 `pluginSkills` view from one host snapshot.
 *
 * `listHostSkills` already fetched the winning catalog; reusing it keeps a
 * single round trip per request instead of one per view.
 *
 * @param {{ available: boolean, providerPrefix: string, skills?: object[], error?: string }} host
 * @returns {{ available: boolean, providerPrefix: string, skills: object[], error?: string }}
 */
function pluginViewOf(host) {
  const source = host?.available === true && Array.isArray(host.skills) ? host.skills : [];
  const skills = source
    .filter((entry) => entry.provider.startsWith(host.providerPrefix))
    .map((entry) => ({
      name: entry.name,
      provider: entry.provider,
      ...(entry.path === undefined ? {} : { path: entry.path }),
    }));
  return {
    available: host?.available === true,
    providerPrefix: host?.providerPrefix,
    skills,
    ...(typeof host?.error === 'string' && host.error !== '' ? { error: host.error } : {}),
  };
}

/**
 * Compact payload for the host catalog view (contract §8.1).
 *
 * @param {{ available: boolean, complete: boolean, skills?: object[], error?: string }} host
 */
function hostSkillsPayload(host) {
  const skills = host?.available === true && Array.isArray(host.skills) ? host.skills : [];
  return {
    available: host?.available === true,
    complete: host?.complete === true,
    count: skills.length,
    providers: [...new Set(skills.map((skill) => skill.provider))].sort(),
    ...(typeof host?.error === 'string' && host.error !== '' ? { error: host.error } : {}),
  };
}

/** GET /overview */
async function overviewBody(ctx, config, request) {
  const params = searchParams(request);
  const cwd = firstNonEmpty(params.get('cwd'), defaultCwd(ctx));
  const resolved = resolveRootsFor(ctx, config, cwd);
  const scanned = await scanAll({ roots: resolved.roots });
  const skills = scanned.skills;

  // 宿主可见技能：一次快照同时用于同名遮蔽标注与「宿主有、磁盘没有」对照（契约 §8.1）。
  const host = await listHostSkills(ctx, { cwd: resolved.cwd });
  const pluginSkills = pluginViewOf(host);
  applyPluginShadowing(skills, pluginSkills.skills);
  // 用宿主的真实胜出者校正 rank 推断（rank 表是宿主私有常量的副本）。
  applyHostShadowing(skills, host.skills);
  const scannedNames = new Set(skills.map((skill) => skill.name));
  const hostOnly = host.available === true ? host.skills.filter((entry) => !scannedNames.has(entry.name)) : [];
  // 停用约定健康检查：_disabled/ 里的条目若被宿主发现，说明发现规则变了。
  const diagnostics = scanned.diagnostics.concat(findDisabledLeaks(skills, host.skills));

  const marketDir = marketDirOf(config, resolved.dshHome);
  let market = null;
  try {
    // 安装账本：「已安装」按 repo+folder + 本次请求的可写根精确匹配，不再按名字猜（契约 §3.8）。
    const installState = await readInstallState(marketDir);
    const summary = await marketSummary({
      marketDir,
      installedNames: personalSkillNames(skills),
      installState,
      rootPaths: writableRootPaths(resolved.roots),
    });
    market = { ...summary };
  } catch (error) {
    market = { available: false, path: marketDir, repos: 0, skills: 0, installed: 0, error: String(error?.message ?? error) };
  }

  return {
    cwd: resolved.cwd,
    projectRoot: resolved.projectRoot,
    dshHome: resolved.dshHome,
    agentsHome: resolved.agentsHome,
    roots: countPerRoot(resolved.roots, skills),
    skills,
    counts: {
      total: skills.length,
      enabled: skills.filter((skill) => skill.state === 'enabled').length,
      disabled: skills.filter((skill) => skill.state === 'disabled').length,
      invalid: skills.filter((skill) => skill.state === 'invalid').length,
      shadowed: skills.filter((skill) => skill.shadowed === true).length,
      shadowedByPlugin: skills.filter((skill) => skill.shadowedByPlugin !== undefined).length,
      shadowedByHost: skills.filter((skill) => skill.shadowedByHost !== undefined).length,
    },
    diagnostics,
    market,
    pluginSkills: pluginSkillsPayload(pluginSkills),
    hostSkills: hostSkillsPayload(host),
    hostOnly,
    scannedAt: Date.now(),
  };
}

/** GET /skill */
async function skillBody(ctx, config, request) {
  const params = searchParams(request);
  const rootId = firstNonEmpty(params.get('rootId'));
  const dirName = firstNonEmpty(params.get('dirName'));
  if (rootId === undefined) throw badRequest('"rootId" is required');
  if (dirName === undefined) throw badRequest('"dirName" is required');
  const kind = normalizeKind(params.get('kind'));
  const state = params.get('state') === 'disabled' ? 'disabled' : 'enabled';
  const resolved = resolveRoots({ options: config, cwd: firstNonEmpty(params.get('cwd'), defaultCwd(ctx)) });
  const detail = await readSkill({ roots: resolved.roots, rootId, dirName, kind, state });
  // 详情页与列表同口径：被插件同名遮蔽的条目也要带 shadowedByPlugin。
  const host = await listHostSkills(ctx, { cwd: resolved.cwd });
  if (detail?.skill !== undefined) applyPluginShadowing([detail.skill], pluginViewOf(host).skills);
  return detail;
}

/** The market directory this request resolves to (config override or default). */
function marketDirOf(config, dshHome) {
  return firstNonEmpty(config.marketDir) === undefined ? defaultMarketDir(dshHome) : resolve(config.marketDir);
}

/** POST /skill/save */
async function saveBody(ctx, config, body) {
  const cwd = firstNonEmpty(body?.cwd, defaultCwd(ctx));
  const resolved = resolveRootsFor(ctx, config, cwd);
  if (typeof body?.content !== 'string') throw badRequest('"content" is required');
  // 契约 §3.3：hash 必填。没有它，保存就是一次无保护的覆盖。
  const hash = optionalString(body, 'hash');
  if (hash === undefined) throw badRequest('"hash" 必填：保存必须携带读取时的内容哈希');
  return saveSkill({
    roots: resolved.roots,
    rootId: requireString(body, 'rootId'),
    dirName: requireString(body, 'dirName'),
    kind: normalizeKind(body?.kind),
    state: body?.state === 'disabled' ? 'disabled' : 'enabled',
    expectedHash: hash,
    content: body.content,
    stripBom: body?.stripBom === true,
  });
}

/** POST /skill/create */
async function createBody(ctx, config, body) {
  const cwd = firstNonEmpty(body?.cwd, defaultCwd(ctx));
  const resolved = resolveRootsFor(ctx, config, cwd);
  return createSkill({
    roots: resolved.roots,
    rootId: requireString(body, 'rootId'),
    name: requireString(body, 'name'),
    description: requireString(body, 'description'),
    whenToUse: optionalString(body, 'whenToUse'),
    body: optionalString(body, 'body'),
    invocation: body?.invocation,
    kind: normalizeKind(body?.kind),
  });
}

/** POST /skill/toggle */
async function toggleBody(ctx, config, body) {
  const cwd = firstNonEmpty(body?.cwd, defaultCwd(ctx));
  const resolved = resolveRootsFor(ctx, config, cwd);
  return setSkillEnabled({
    roots: resolved.roots,
    rootId: requireString(body, 'rootId'),
    dirName: requireString(body, 'dirName'),
    kind: normalizeKind(body?.kind),
    enabled: body?.enabled === true,
  });
}

/** POST /skill/delete */
async function deleteBody(ctx, config, body) {
  const cwd = firstNonEmpty(body?.cwd, defaultCwd(ctx));
  const resolved = resolveRootsFor(ctx, config, cwd);
  const rootId = requireString(body, 'rootId');
  const dirName = requireString(body, 'dirName');
  const result = await trashSkill({ roots: resolved.roots, rootId, dirName, kind: normalizeKind(body?.kind) });
  // 删除即卸载：账本里同根同名的记录一并清掉，否则市场页会一直显示「已安装/有更新」，
  // 点「更新」还会把刚删掉的技能装回来（契约 §8.5）。
  const root = rootById(resolved.roots, rootId);
  const ledgerRemoved = root === undefined
    ? false
    : await removeInstallRecord({ marketDir: marketDirOf(config, resolved.dshHome), rootPath: root.path, name: dirName });
  return { ...result, ledgerRemoved };
}

/** POST /open */
async function openBody(ctx, config, body, open) {
  const cwd = firstNonEmpty(body?.cwd, defaultCwd(ctx));
  const resolved = resolveRootsFor(ctx, config, cwd);
  const rootId = optionalString(body, 'rootId');
  if (rootId === undefined) throw badRequest('"rootId" is required');
  const root = rootById(resolved.roots, rootId);
  if (root === undefined) throw notFound(`未知的技能根：${rootId}`);
  const dirName = optionalString(body, 'dirName');
  let target = root.path;
  if (dirName !== undefined) {
    if (!isSafeSegment(dirName)) throw badRequest(`非法的技能名：${JSON.stringify(dirName)}`);
    const kind = normalizeKind(body?.kind);
    target = skillEntryPath(root, dirName, kind, body?.state === 'disabled' ? 'disabled' : 'enabled');
    if (!isInside(root.path, target)) throw forbidden('目标路径越出技能根');
  }
  // 打开一个不存在的路径会静默成功（explorer 不报错），面板却提示「已打开」。
  // 先确认目标存在，让失败可见。
  const info = await stat(target).catch((error) => {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined;
    throw error;
  });
  if (info === undefined) throw notFound(`路径不存在：${target}`);
  return { ok: true, opened: open(target) };
}

/** GET /market */
async function marketBody(ctx, config, request) {
  const params = searchParams(request);
  const cwd = firstNonEmpty(params.get('cwd'), defaultCwd(ctx));
  const resolved = resolveRootsFor(ctx, config, cwd);
  const { skills } = await scanAll({ roots: resolved.roots });
  const marketDir = marketDirOf(config, resolved.dshHome);
  const limitRaw = Number.parseInt(params.get('limit') ?? '', 10);
  const perRepoRaw = Number.parseInt(params.get('perRepo') ?? '', 10);
  return scanMarket({
    marketDir,
    installedNames: personalSkillNames(skills),
    installState: await readInstallState(marketDir),
    rootPaths: writableRootPaths(resolved.roots),
    query: params.get('query') ?? '',
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 500,
    ...(Number.isFinite(perRepoRaw) && perRepoRaw > 0 ? { perRepo: perRepoRaw } : {}),
  });
}

/** POST /market/install */
async function marketInstallBody(ctx, config, body) {
  const cwd = firstNonEmpty(body?.cwd, defaultCwd(ctx));
  const resolved = resolveRootsFor(ctx, config, cwd);
  const rootId = optionalString(body, 'rootId') ?? 'user-dsh';
  const root = rootById(resolved.roots, rootId);
  if (root === undefined) throw notFound(`未知的技能根：${rootId}`);
  const marketDir = marketDirOf(config, resolved.dshHome);
  return installFromMarket({
    marketDir,
    repo: requireString(body, 'repo'),
    folder: requireString(body, 'folder'),
    root,
    overwrite: body?.overwrite === true,
  });
}

/** POST /skill/invocation — the soft-disable path (contract §3.10). */
async function invocationBody(ctx, config, body) {
  const cwd = firstNonEmpty(body?.cwd, defaultCwd(ctx));
  const resolved = resolveRootsFor(ctx, config, cwd);
  if (typeof body?.model !== 'boolean' || typeof body?.user !== 'boolean') {
    throw badRequest('"model" 与 "user" 必须是布尔值');
  }
  return setInvocation({
    roots: resolved.roots,
    rootId: requireString(body, 'rootId'),
    dirName: requireString(body, 'dirName'),
    kind: normalizeKind(body?.kind),
    state: body?.state === 'disabled' ? 'disabled' : 'enabled',
    expectedHash: optionalString(body, 'hash'),
    model: body.model,
    user: body.user,
  });
}

/** GET /usage — the call ledger (contract §3.11). */
async function usageBody(ctx) {
  // 惰性取服务：不在 lib/index.js 的 inject 里加 sessionQuery，老宿主照样能挂载，
  // 服务缺失时账本降级为 available:false，其余功能不受影响。
  let sessionQuery;
  try {
    sessionQuery = ctx.get?.('sessionQuery');
  } catch {
    sessionQuery = undefined;
  }
  return collectUsage({ sessionQuery });
}

/** POST /skill/batch — 批量启停/删除，逐条结果（contract §3.12）. */
async function batchBody(ctx, config, body) {
  const cwd = firstNonEmpty(body?.cwd, defaultCwd(ctx));
  const resolved = resolveRootsFor(ctx, config, cwd);
  const action = body?.action;
  if (action !== 'enable' && action !== 'disable' && action !== 'delete' && action !== 'invocation') {
    throw badRequest('"action" 必须是 enable、disable、delete 或 invocation');
  }
  // 三态调用策略的批量写入：一条请求带同一组 model/user，逐条落到各自 frontmatter。
  const model = body?.model;
  const user = body?.user;
  if (action === 'invocation' && (typeof model !== 'boolean' || typeof user !== 'boolean')) {
    throw badRequest('"model" 与 "user" 必须是布尔值');
  }
  const marketDir = marketDirOf(config, resolved.dshHome);
  const items = body?.items;
  if (!Array.isArray(items) || items.length === 0) throw badRequest('"items" 必须是非空数组');
  if (items.length > BATCH_MAX_ITEMS) throw badRequest(`一次最多处理 ${BATCH_MAX_ITEMS} 条`);

  // 串行 + 逐条收集：单条失败不影响其余（panel 的语义），也不做事务。
  const results = [];
  let succeeded = 0;
  for (const item of items) {
    const rootId = typeof item?.rootId === 'string' ? item.rootId : '';
    const dirName = typeof item?.dirName === 'string' ? item.dirName : '';
    const kind = item?.kind === 'file' ? 'file' : 'directory';
    try {
      if (rootId === '' || dirName === '') throw badRequest('每一条都需要 rootId 与 dirName');
      const target = { roots: resolved.roots, rootId, dirName, kind };
      if (action === 'delete') {
        const value = await trashSkill(target);
        const recordRoot = rootById(resolved.roots, rootId);
        const ledgerRemoved = recordRoot === undefined
          ? false
          : await removeInstallRecord({ marketDir, rootPath: recordRoot.path, name: dirName });
        results.push({ ok: true, rootId, dirName, kind, trashed: value.trashed, ledgerRemoved });
      } else if (action === 'invocation') {
        const value = await setInvocation({
          ...target,
          state: item?.state === 'disabled' ? 'disabled' : 'enabled',
          model,
          user,
        });
        results.push({ ok: true, rootId, dirName, kind, invocation: value.invocation });
      } else {
        const value = await setSkillEnabled({ ...target, enabled: action === 'enable' });
        results.push({ ok: true, rootId, dirName, kind, state: value.state });
      }
      succeeded += 1;
    } catch (error) {
      results.push({
        ok: false,
        rootId,
        dirName,
        kind,
        error: {
          code: error instanceof ApiError ? error.code : 'internal',
          message: String(error?.message ?? error),
        },
      });
    }
  }
  return { ok: true, action, results, counts: { total: items.length, ok: succeeded, failed: items.length - succeeded } };
}

/** POST /skill/import — 导入本地文件夹 / .md / 压缩包（contract §3.13 / §8.8）. */
async function importBody(ctx, config, body) {
  const cwd = firstNonEmpty(body?.cwd, defaultCwd(ctx));
  const resolved = resolveRootsFor(ctx, config, cwd);
  const rootId = optionalString(body, 'rootId') ?? 'user-dsh';
  const root = rootById(resolved.roots, rootId);
  if (root === undefined) throw notFound(`未知的技能根：${rootId}`);
  const sourcePath = requireString(body, 'path');

  // 压缩包：先解到临时目录，再走同一套发现/拍平/跳过规则，结束后删临时目录。
  const raw = sourcePath.trim().replace(/^"(.*)"$/, '$1');
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(resolved.cwd, raw);
  if (isArchivePath(absolute)) {
    const staging = await mkdtemp(join(tmpdir(), 'skill-manager-import-'));
    try {
      await extractArchive(absolute, staging);
      const result = await importSkillPackage({ root, sourcePath: staging, cwd: resolved.cwd });
      return { ...result, source: absolute, archive: true };
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  return importSkillPackage({ root, sourcePath, cwd: resolved.cwd });
}

/** GET /host-skills — 宿主 skills 服务的只读快照（契约 §8.1）. */
async function hostSkillsBody(ctx, config, request) {
  const params = searchParams(request);
  const resolved = resolveRoots({ options: config, cwd: firstNonEmpty(params.get('cwd'), defaultCwd(ctx)) });
  const host = await listHostSkills(ctx, { cwd: resolved.cwd });
  const skills = host.available === true ? host.skills : [];
  return {
    available: host.available === true,
    complete: host.complete === true,
    count: skills.length,
    providers: [...new Set(skills.map((entry) => entry.provider))].sort(),
    skills,
    ...(typeof host.error === 'string' && host.error !== '' ? { error: host.error } : {}),
  };
}

/** GET /trash — 回收站条目（契约 §8.2）. */
async function trashBody(ctx, config, request) {
  const params = searchParams(request);
  const resolved = resolveRoots({ options: config, cwd: firstNonEmpty(params.get('cwd'), defaultCwd(ctx)) });
  const rootId = firstNonEmpty(params.get('rootId'));
  if (rootId !== undefined && rootById(resolved.roots, rootId) === undefined) {
    throw notFound(`未知的技能根：${rootId}`);
  }
  return listTrash({ roots: resolved.roots, rootId });
}

/** POST /trash/restore */
async function restoreTrashBody(ctx, config, body) {
  const resolved = resolveRoots({ options: config, cwd: firstNonEmpty(body?.cwd, defaultCwd(ctx)) });
  return restoreTrash({
    roots: resolved.roots,
    rootId: requireString(body, 'rootId'),
    token: requireString(body, 'token'),
    overwrite: body?.overwrite === true,
  });
}

/** POST /trash/purge */
async function purgeTrashBody(ctx, config, body) {
  const resolved = resolveRoots({ options: config, cwd: firstNonEmpty(body?.cwd, defaultCwd(ctx)) });
  return purgeTrash({
    roots: resolved.roots,
    rootId: requireString(body, 'rootId'),
    token: optionalString(body, 'token'),
    all: body?.all === true,
    confirm: body?.confirm === true,
  });
}

/** GET /skill/files — 技能目录内的资源文件（契约 §8.3）. */
async function filesBody(ctx, config, request) {
  const params = searchParams(request);
  const resolved = resolveRoots({ options: config, cwd: firstNonEmpty(params.get('cwd'), defaultCwd(ctx)) });
  const rootId = firstNonEmpty(params.get('rootId'));
  const dirName = firstNonEmpty(params.get('dirName'));
  if (rootId === undefined) throw badRequest('"rootId" is required');
  if (dirName === undefined) throw badRequest('"dirName" is required');
  return listSkillFiles({
    roots: resolved.roots,
    rootId,
    dirName,
    kind: normalizeKind(params.get('kind')),
    state: params.get('state') === 'disabled' ? 'disabled' : 'enabled',
  });
}

/** GET /skill/file — 读一个资源文件. */
async function fileBody(ctx, config, request) {
  const params = searchParams(request);
  const resolved = resolveRoots({ options: config, cwd: firstNonEmpty(params.get('cwd'), defaultCwd(ctx)) });
  const rootId = firstNonEmpty(params.get('rootId'));
  const dirName = firstNonEmpty(params.get('dirName'));
  const file = firstNonEmpty(params.get('file'));
  if (rootId === undefined) throw badRequest('"rootId" is required');
  if (dirName === undefined) throw badRequest('"dirName" is required');
  if (file === undefined) throw badRequest('"file" 是必填的相对路径');
  return readSkillFile({
    roots: resolved.roots,
    rootId,
    dirName,
    file,
    kind: normalizeKind(params.get('kind')),
    state: params.get('state') === 'disabled' ? 'disabled' : 'enabled',
  });
}

/** POST /skill/file — 写一个资源文件（只允许已存在的文件）. */
async function fileWriteBody(ctx, config, body) {
  const resolved = resolveRoots({ options: config, cwd: firstNonEmpty(body?.cwd, defaultCwd(ctx)) });
  if (typeof body?.content !== 'string') throw badRequest('"content" is required');
  return writeSkillFile({
    roots: resolved.roots,
    rootId: requireString(body, 'rootId'),
    dirName: requireString(body, 'dirName'),
    file: requireString(body, 'file'),
    kind: normalizeKind(body?.kind),
    state: body?.state === 'disabled' ? 'disabled' : 'enabled',
    content: body.content,
    expectedHash: optionalString(body, 'hash'),
  });
}

/** GET /search — 正文搜索（契约 §8.4）. */
async function searchBody(ctx, config, request) {
  const params = searchParams(request);
  const resolved = resolveRoots({ options: config, cwd: firstNonEmpty(params.get('cwd'), defaultCwd(ctx)) });
  const limitRaw = Number.parseInt(params.get('limit') ?? '', 10);
  return searchSkills({
    roots: resolved.roots,
    query: params.get('q') ?? '',
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50,
    rootId: firstNonEmpty(params.get('rootId')),
  });
}

/** POST /market/uninstall — 卸载到 `_trash/` 并销账（契约 §8.5）. */
async function marketUninstallBody(ctx, config, body) {
  const cwd = firstNonEmpty(body?.cwd, defaultCwd(ctx));
  const resolved = resolveRootsFor(ctx, config, cwd);
  const rootId = requireString(body, 'rootId');
  const root = rootById(resolved.roots, rootId);
  if (root === undefined) throw notFound(`未知的技能根：${rootId}`);
  if (root.writable !== true) throw forbidden('只读根不能卸载');
  if (root.exists !== true) throw notFound(`根目录不存在：${root.path}`);

  const marketDir = marketDirOf(config, resolved.dshHome);
  const name = optionalString(body, 'name');
  const repo = optionalString(body, 'repo');
  const folder = optionalString(body, 'folder');
  if (name === undefined && (repo === undefined || folder === undefined)) {
    throw badRequest('请给出 "name"，或同时给出 "repo" 与 "folder"');
  }

  // 账本是唯一知道「这个磁盘条目由哪个市场来源装进来」的地方。
  const state = await readInstallState(marketDir);
  const record = findInstallRecord({ installed: state.installed, rootPath: root.path, repo, folder, name });
  const targetName = name ?? record?.name;
  if (typeof targetName !== 'string' || targetName === '') {
    throw notFound('账本里没有这个安装记录，请改用 "name" 指定要卸载的技能');
  }

  const dirTarget = skillEntryPath(root, targetName, 'directory', 'enabled');
  const fileTarget = skillEntryPath(root, targetName, 'file', 'enabled');
  const isDirectory = (await stat(dirTarget).catch(() => undefined)) !== undefined;
  const isFile = !isDirectory && (await stat(fileTarget).catch(() => undefined)) !== undefined;
  if (!isDirectory && !isFile) throw notFound(`目标根里没有该技能：${targetName}`);

  const value = await trashSkill({
    roots: resolved.roots,
    rootId,
    dirName: targetName,
    kind: isDirectory ? 'directory' : 'file',
  });
  const ledgerRemoved = await removeInstallRecord({ marketDir, rootPath: root.path, name: targetName });
  return { ok: true, name: targetName, trashed: value.trashed, ledgerRemoved };
}

/** `stat` 存在性：目录/文件都算。 */
async function existsOnDisk(path) {
  return (await stat(path).catch(() => undefined)) !== undefined;
}

/** 路径比较键（Windows 大小写不敏感），用于自定义根的 `source` 合并。 */
function customRootKey(path) {
  const value = resolve(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/** GET /roots/custom — 运行时列表与 profile 持久化的两份状态（契约 §8.6）. */
async function customRootsBody(ctx, config, request) {
  const params = searchParams(request);
  const cwd = firstNonEmpty(params.get('cwd'), defaultCwd(ctx));
  const profile = await readProfileCustomDirs(ctx);
  const runtime = runtimeDirs();
  const dirs = [];
  const seen = new Set();
  for (const [source, list] of [['config', profile.dirs], ['runtime', runtime]]) {
    for (const dir of list) {
      const key = customRootKey(dir);
      if (seen.has(key)) continue;
      seen.add(key);
      dirs.push({ path: dir, exists: await existsOnDisk(dir), source });
    }
  }
  return {
    profilePath: profile.path,
    writable: profile.writable !== false && profile.error === undefined,
    persisted: profile.dirs,
    runtime,
    dirs,
    ...(profile.error === undefined ? {} : { error: profile.error }),
  };
}

/** POST /roots/custom — 替换运行时列表，可选写进 profile 托管块. */
async function customRootsWriteBody(ctx, config, body) {
  const cwd = firstNonEmpty(body?.cwd, defaultCwd(ctx));
  if (!Array.isArray(body?.dirs)) throw badRequest('"dirs" 必须是数组（完整的运行时列表）');
  const runtime = setRuntimeDirs(body.dirs, cwd);
  const result = { ok: true, runtime };
  if (body?.persist === true) {
    const written = await writeProfileCustomDirs(ctx, runtime);
    result.persisted = true;
    result.path = written.path;
    result.backupPath = written.backupPath;
    result.requiresReload = true;
  }
  return result;
}

/** POST /skill/export — 把技能打包成 zip/tgz（契约 §8.7）. */
async function exportBody(ctx, config, body) {
  const cwd = firstNonEmpty(body?.cwd, defaultCwd(ctx));
  const resolved = resolveRootsFor(ctx, config, cwd);
  const rootId = requireString(body, 'rootId');
  const root = rootById(resolved.roots, rootId);
  if (root === undefined) throw notFound(`未知的技能根：${rootId}`);
  const dirName = requireString(body, 'dirName');
  if (!isSafeSegment(dirName)) throw badRequest(`非法的技能名：${JSON.stringify(dirName)}`);
  const kind = normalizeKind(body?.kind);
  const source = skillEntryPath(root, dirName, kind, body?.state === 'disabled' ? 'disabled' : 'enabled');
  if (!isInside(root.path, source)) throw forbidden('目标路径越出技能根');
  if (!(await existsOnDisk(source))) throw notFound(`技能不存在：${dirName}`);

  const rawTarget = requireString(body, 'targetPath').trim().replace(/^"(.*)"$/, '$1');
  const targetPath = isAbsolute(rawTarget) ? resolve(rawTarget) : resolve(resolved.cwd, rawTarget);
  const created = await createArchive(source, targetPath);
  return { ok: true, path: created.path, files: created.files };
}

/**
 * Register every route; returns the disposers so `ctx.effect` owns their lifetime.
 * @param {object} ctx - plugin context (needs `webServer`, `connection`, `workingDirectory`)
 * @param {object} config - normalized plugin config
 * @param {{ openInFileManager?: (path: string) => unknown }} [seams] - test seams
 */
export function registerRoutes(ctx, config = {}, seams = {}) {
  const open = typeof seams.openInFileManager === 'function' ? seams.openInFileManager : openInFileManager;
  const disposers = [];
  const register = (path, handler) => {
    disposers.push(ctx.webServer.register({ kind: 'exact', path: API_BASE + path, handler }));
  };

  const readRoute = (handler) => async (request, response) => {
    if (rejectUnauthorized(ctx, request, response)) return;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      methodNotAllowed(response, 'GET, HEAD');
      return;
    }
    try {
      sendJson(response, 200, await handler(request, response));
    } catch (error) {
      sendError(response, error);
    }
  };

  const writeRoute = (handler) => async (request, response) => {
    if (rejectUnauthorized(ctx, request, response)) return;
    if (request.method !== 'POST') {
      methodNotAllowed(response, 'POST');
      return;
    }
    if (!requireSameOrigin(ctx, request, response)) return;
    if (!requireJson(request, response)) return;
    try {
      const body = await readJsonBody(request);
      sendJson(response, 200, await handler(body, request, response));
    } catch (error) {
      sendError(response, error);
    }
  };

  /**
   * One path serving both a read (GET/HEAD) and a write (POST).
   *
   * `webServer.register` is one handler per exact path, so the resource-file
   * route cannot be registered twice; it dispatches on the method instead.
   */
  const mixedRoute = (reader, writer) => async (request, response) => {
    if (rejectUnauthorized(ctx, request, response)) return;
    if (request.method === 'GET' || request.method === 'HEAD') {
      try {
        sendJson(response, 200, await reader(request, response));
      } catch (error) {
        sendError(response, error);
      }
      return;
    }
    if (request.method !== 'POST') {
      methodNotAllowed(response, 'GET, HEAD, POST');
      return;
    }
    if (!requireSameOrigin(ctx, request, response)) return;
    if (!requireJson(request, response)) return;
    try {
      const body = await readJsonBody(request);
      sendJson(response, 200, await writer(body, request, response));
    } catch (error) {
      sendError(response, error);
    }
  };

  register('/overview', readRoute((request) => overviewBody(ctx, config, request)));
  register('/skill', readRoute((request) => skillBody(ctx, config, request)));
  register('/market', readRoute((request) => marketBody(ctx, config, request)));
  register('/usage', readRoute(() => usageBody(ctx)));
  register('/host-skills', readRoute((request) => hostSkillsBody(ctx, config, request)));
  register('/trash', readRoute((request) => trashBody(ctx, config, request)));
  register('/search', readRoute((request) => searchBody(ctx, config, request)));
  register('/skill/files', readRoute((request) => filesBody(ctx, config, request)));
  register(
    '/skill/file',
    mixedRoute(
      (request) => fileBody(ctx, config, request),
      (body) => fileWriteBody(ctx, config, body),
    ),
  );
  register('/skill/save', writeRoute((body) => saveBody(ctx, config, body)));
  register('/skill/create', writeRoute((body) => createBody(ctx, config, body)));
  register('/skill/toggle', writeRoute((body) => toggleBody(ctx, config, body)));
  register('/skill/delete', writeRoute((body) => deleteBody(ctx, config, body)));
  register('/skill/invocation', writeRoute((body) => invocationBody(ctx, config, body)));
  register('/skill/batch', writeRoute((body) => batchBody(ctx, config, body)));
  register('/skill/import', writeRoute((body) => importBody(ctx, config, body)));
  register('/open', writeRoute((body) => openBody(ctx, config, body, open)));
  register('/market/install', writeRoute((body) => marketInstallBody(ctx, config, body)));
  register('/market/uninstall', writeRoute((body) => marketUninstallBody(ctx, config, body)));
  register('/trash/restore', writeRoute((body) => restoreTrashBody(ctx, config, body)));
  register('/trash/purge', writeRoute((body) => purgeTrashBody(ctx, config, body)));
  register(
    '/roots/custom',
    mixedRoute(
      (request) => customRootsBody(ctx, config, request),
      (body) => customRootsWriteBody(ctx, config, body),
    ),
  );
  register('/skill/export', writeRoute((body) => exportBody(ctx, config, body)));

  return disposers;
}
