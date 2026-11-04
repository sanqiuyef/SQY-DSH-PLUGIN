/**
 * dsh-skill-manager — the Host HTTP surface.
 *
 * Four read endpoints (overview, skill, market, usage) and nine write endpoints
 * (save, create, toggle, delete, invocation, batch, import, open,
 * market/install), all same-origin and authenticated through the host's own
 * fence:
 *   1. `connection.requestRejection(request)` — authentication + Host/Origin gate;
 *   2. POST only: same-origin check, `application/json`, body cap;
 *   3. argument validation against the roots this request itself resolved.
 *
 * A caller can never name an arbitrary path: every `rootId` must be one of the
 * roots this scan produced, and every `dirName` must be a single path segment.
 * Responses are `no-store` — the filesystem changes outside this process.
 */

import { resolve } from 'node:path';

import { ApiError, badRequest, forbidden, notFound } from './errors.js';
import { importSkillPackage } from './import.js';
import { marketSummary, readInstallState, scanMarket, installFromMarket, defaultMarketDir } from './market.js';
import { openInFileManager } from './open.js';
import { applyPluginShadowing, listPluginSkills } from './plugin-skills.js';
import { firstNonEmpty, resolveRoots, rootById } from './roots.js';
import { isInside, isSafeSegment, scanAll, skillEntryPath } from './scan.js';
import { createSkill, readSkill, saveSkill, setInvocation } from './skill-file.js';
import { setSkillEnabled, trashSkill } from './toggle.js';
import { collectUsage } from './usage.js';

/** API prefix shared with the client half. */
export const API_BASE = '/skill-manager/api';

/** Body cap for write routes. */
const MAX_BODY_BYTES = 256 * 1024;

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

/** GET /overview */
async function overviewBody(ctx, config, request) {
  const params = searchParams(request);
  const cwd = firstNonEmpty(params.get('cwd'), defaultCwd(ctx));
  const resolved = resolveRoots({ options: config, cwd });
  const { skills, diagnostics } = await scanAll({ roots: resolved.roots });

  // 插件同名遮蔽：宿主 skills 服务不可用时仅降级该字段，扫描结果照常返回。
  const pluginSkills = await listPluginSkills(ctx, { cwd: resolved.cwd });
  applyPluginShadowing(skills, pluginSkills.skills);

  const marketDir = firstNonEmpty(config.marketDir) === undefined ? defaultMarketDir(resolved.dshHome) : resolve(config.marketDir);
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
    },
    diagnostics,
    market,
    pluginSkills: pluginSkillsPayload(pluginSkills),
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
  const pluginSkills = await listPluginSkills(ctx, { cwd: resolved.cwd });
  if (detail?.skill !== undefined) applyPluginShadowing([detail.skill], pluginSkills.skills);
  return detail;
}

/** POST /skill/save */
async function saveBody(ctx, config, body) {
  const cwd = firstNonEmpty(body?.cwd, defaultCwd(ctx));
  const resolved = resolveRoots({ options: config, cwd });
  if (typeof body?.content !== 'string') throw badRequest('"content" is required');
  return saveSkill({
    roots: resolved.roots,
    rootId: requireString(body, 'rootId'),
    dirName: requireString(body, 'dirName'),
    kind: normalizeKind(body?.kind),
    state: body?.state === 'disabled' ? 'disabled' : 'enabled',
    expectedHash: optionalString(body, 'hash'),
    content: body.content,
    stripBom: body?.stripBom === true,
  });
}

/** POST /skill/create */
async function createBody(ctx, config, body) {
  const cwd = firstNonEmpty(body?.cwd, defaultCwd(ctx));
  const resolved = resolveRoots({ options: config, cwd });
  return createSkill({
    roots: resolved.roots,
    rootId: requireString(body, 'rootId'),
    name: requireString(body, 'name'),
    description: requireString(body, 'description'),
    whenToUse: optionalString(body, 'whenToUse'),
    body: optionalString(body, 'body'),
    invocation: body?.invocation,
  });
}

/** POST /skill/toggle */
async function toggleBody(ctx, config, body) {
  const cwd = firstNonEmpty(body?.cwd, defaultCwd(ctx));
  const resolved = resolveRoots({ options: config, cwd });
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
  const resolved = resolveRoots({ options: config, cwd });
  return trashSkill({
    roots: resolved.roots,
    rootId: requireString(body, 'rootId'),
    dirName: requireString(body, 'dirName'),
    kind: normalizeKind(body?.kind),
  });
}

/** POST /open */
async function openBody(ctx, config, body, open) {
  const cwd = firstNonEmpty(body?.cwd, defaultCwd(ctx));
  const resolved = resolveRoots({ options: config, cwd });
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
  return { ok: true, opened: open(target) };
}

/** GET /market */
async function marketBody(ctx, config, request) {
  const params = searchParams(request);
  const cwd = firstNonEmpty(params.get('cwd'), defaultCwd(ctx));
  const resolved = resolveRoots({ options: config, cwd });
  const { skills } = await scanAll({ roots: resolved.roots });
  const marketDir = firstNonEmpty(config.marketDir) === undefined ? defaultMarketDir(resolved.dshHome) : resolve(config.marketDir);
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
  const resolved = resolveRoots({ options: config, cwd });
  const rootId = optionalString(body, 'rootId') ?? 'user-dsh';
  const root = rootById(resolved.roots, rootId);
  if (root === undefined) throw notFound(`未知的技能根：${rootId}`);
  const marketDir = firstNonEmpty(config.marketDir) === undefined ? defaultMarketDir(resolved.dshHome) : resolve(config.marketDir);
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
  const resolved = resolveRoots({ options: config, cwd });
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
  const resolved = resolveRoots({ options: config, cwd });
  const action = body?.action;
  if (action !== 'enable' && action !== 'disable' && action !== 'delete') {
    throw badRequest('"action" 必须是 enable、disable 或 delete');
  }
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
        results.push({ ok: true, rootId, dirName, kind, trashed: value.trashed });
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

/** POST /skill/import — 导入本地文件夹 / .md（contract §3.13）. */
async function importBody(ctx, config, body) {
  const cwd = firstNonEmpty(body?.cwd, defaultCwd(ctx));
  const resolved = resolveRoots({ options: config, cwd });
  const rootId = optionalString(body, 'rootId') ?? 'user-dsh';
  const root = rootById(resolved.roots, rootId);
  if (root === undefined) throw notFound(`未知的技能根：${rootId}`);
  return importSkillPackage({ root, sourcePath: requireString(body, 'path'), cwd: resolved.cwd });
}

/**
 * Register every route; returns the disposers so `ctx.effect` owns their lifetime.
 *
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

  register('/overview', readRoute((request) => overviewBody(ctx, config, request)));
  register('/skill', readRoute((request) => skillBody(ctx, config, request)));
  register('/market', readRoute((request) => marketBody(ctx, config, request)));
  register('/usage', readRoute(() => usageBody(ctx)));
  register('/skill/save', writeRoute((body) => saveBody(ctx, config, body)));
  register('/skill/create', writeRoute((body) => createBody(ctx, config, body)));
  register('/skill/toggle', writeRoute((body) => toggleBody(ctx, config, body)));
  register('/skill/delete', writeRoute((body) => deleteBody(ctx, config, body)));
  register('/skill/invocation', writeRoute((body) => invocationBody(ctx, config, body)));
  register('/skill/batch', writeRoute((body) => batchBody(ctx, config, body)));
  register('/skill/import', writeRoute((body) => importBody(ctx, config, body)));
  register('/open', writeRoute((body) => openBody(ctx, config, body, open)));
  register('/market/install', writeRoute((body) => marketInstallBody(ctx, config, body)));

  return disposers;
}
