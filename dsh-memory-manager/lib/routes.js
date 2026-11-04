/**
 * dsh-memory-manager — the HTTP surface behind the settings page.
 *
 * Read routes (GET/HEAD only; a POST answers 403 `read-only`):
 *   /digest, /entries, /entry, /diagnostics, /events, /candidates
 * Write routes (POST + `application/json` + bounded body):
 *   /entry (create/update/delete), /candidates/adopt, /candidates/discard,
 *   /consolidate (dream), /open-dir (navigation, not a memory write)
 *
 * All of them go through the same store methods the model-facing tools use, so the two
 * surfaces cannot drift; none of them can race a session's index rewrite because the
 * store serializes writes under the directory lock.
 *
 * Every handler opens with the host's own fence, in this order:
 *   1. `connection.requestRejection(request)` — authentication + Host/Origin gate;
 *   2. method allow-list (and the explicit 403 for write attempts);
 *   3. for POST: `application/json`, body cap, then argument validation.
 * Responses are always `no-store`: memory content changes outside this process, so a
 * cached page would be wrong by design.
 *
 * Project context resolution: a caller may pass `project=<key>` (the value returned by
 * `/diagnostics`), `cwd=<absolute path>` (hashed the same way the session does), or
 * neither (the host process's cwd is used so the page has a default tab).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, sep } from 'node:path';

import { isProjectKey, projectKeyOf } from './project-key.js';
import { resolveWorkspaceId } from './workspace.js';
import { VALID_TYPES, projectName } from './store.js';
import { adoptCandidate, discardCandidate, listCandidateBundles } from './candidates.js';
import { runConsolidation } from './consolidate.js';

/** Body cap for the one POST route, matching the host's convention. */
const MAX_BODY_BYTES = 64 * 1024;

/** A failure the route can name: carries the contract's error code and a status. */
class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = typeof status === 'number' ? status : 500;
  }
}

const badRequest = (message) => new ApiError('bad-request', message, 400);

/** The contract's first line for every route: ask `connection`, fail closed. */
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

/** Send `{ error: { code, message } }`. */
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

/** The explicit answer for a write attempt on a read-only route. */
function readOnly(response) {
  sendJson(response, 403, {
    error: {
      code: 'read-only',
      message: 'this route is read-only; memory writes go to POST /memory-manager/api/entry, /candidates/adopt, /candidates/discard, or /consolidate',
    },
  });
}

/** Read and bound a JSON body. */
async function readJsonBody(request, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw badRequest(`request body exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  if (size === 0) throw badRequest('a JSON body is required');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw badRequest(`request body is not valid JSON: ${error?.message ?? error}`);
  }
}

/** Require a JSON content type. */
function requireJson(request, response) {
  const type = String(request.headers['content-type'] ?? '').toLowerCase();
  if (type.startsWith('application/json')) return true;
  sendJson(response, 415, { error: { code: 'bad-request', message: 'this route requires application/json' } });
  return false;
}

/** Query parameters of a request URL. */
function searchParams(request) {
  try {
    return new URL(request.url ?? '/', 'http://localhost').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Parse an optional integer query parameter, clamping into range. */
function integerParam(params, name, fallback, min, max) {
  const raw = params.get(name);
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw badRequest(`"${name}" must be an integer`);
  return Math.max(min, Math.min(max, value));
}

/** Describe one project key for a response. */
function projectInfo(store, projectKey) {
  if (typeof projectKey !== 'string' || projectKey === '') return null;
  const dir = store.projectDir(projectKey);
  return { key: projectKey, dir, name: projectName(projectKey), exists: existsSync(dir) };
}

/**
 * Resolve a project key from explicit values (`project`/`key` names a directory,
 * `cwd` is hashed with the Workspace-first rule). Shared by query-based reads and
 * body-based writes so both address exactly the same memory.
 */
async function projectKeyForValues(ctx, { project, key, cwd } = {}) {
  const explicit = project ?? key;
  if (typeof explicit === 'string' && explicit !== '') {
    if (!isProjectKey(explicit)) throw badRequest('"project" must be a project key of the form <slug>-<16 hex chars>');
    return explicit;
  }
  const path = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
  if (!isAbsolute(path)) throw badRequest('"cwd" must be an absolute path');
  return projectKeyOf(path, await resolveWorkspaceId(ctx, path));
}

/**
 * Resolve the project context of a request.
 *
 * `project=<key>` is taken as-is (it already names a directory); `cwd=<path>` is hashed
 * with the same Workspace-first rule the session uses, so a page pinned to a directory
 * sees the same memory the agent does. Without either, the host process's cwd is the
 * default tab.
 *
 * @returns {Promise<{ projectKey: string, info: object }>}
 */
async function projectContext(ctx, request, store) {
  const params = searchParams(request);
  const projectKey = await projectKeyForValues(ctx, {
    project: params.get('project'),
    key: params.get('key'),
    cwd: params.get('cwd'),
  });
  return { projectKey, info: projectInfo(store, projectKey) };
}

/** Map a store error (which carries a transport-neutral code) onto the HTTP vocabulary. */
function mapStoreError(error) {
  if (error instanceof ApiError) return error;
  if (error?.code === 'conflict') return new ApiError('conflict', String(error.message ?? error), 409);
  if (error?.code === 'not-found') return new ApiError('not-found', String(error.message ?? error), 404);
  if (error?.code === 'bad-request') return new ApiError('bad-request', String(error.message ?? error), 400);
  if (typeof error?.message === 'string' && /invalid memory name|memory name must be a string/.test(error.message)) {
    return badRequest(error.message);
  }
  return error;
}

/** Validate a scope parameter against the values a route supports. */
function scopeParam(params, allowed, fallback) {
  const raw = params.get('scope');
  if (raw === null || raw === '') return fallback;
  const scope = raw.toLowerCase();
  if (!allowed.includes(scope)) throw badRequest(`"scope" must be one of ${allowed.join(' | ')}`);
  return scope;
}

/** Validate a type parameter. */
function typeParam(params, validTypes) {
  const raw = params.get('type');
  if (raw === null || raw === '') return null;
  const type = raw.toLowerCase();
  if (!validTypes.includes(type)) throw badRequest(`"type" must be one of ${validTypes.join(' | ')}`);
  return type;
}

/** Read a required non-empty string query parameter. */
function stringParam(params, name) {
  const raw = params.get(name);
  if (raw === null || raw.trim() === '') throw badRequest(`"${name}" is required`);
  return raw.trim();
}

// ------------------------------------------------------------------ route bodies

/** `GET /digest` — the exact text injected into the system prompt, plus its budget. */
async function digestBody(ctx, store, request) {
  const { projectKey } = await projectContext(ctx, request, store);
  await store.prefetch('global').catch(() => {});
  await store.prefetch('project', projectKey).catch(() => {});
  const info = store.digestInfo(projectKey);
  return {
    digest: info.digest,
    tokenEstimate: info.tokenEstimate,
    global: info.global,
    project: info.project ?? { ...projectInfo(store, projectKey), count: 0 },
    currentProject: projectInfo(store, projectKey),
    paths: store.roots,
    ready: info.ready,
  };
}

/** `GET /entries` — list or keyword search across both scopes. */
async function entriesBody(ctx, store, request) {
  const params = searchParams(request);
  const scope = scopeParam(params, ['global', 'project', 'all'], 'all');
  const type = typeParam(params, VALID_TYPES);
  const { projectKey, info } = await projectContext(ctx, request, store);
  const limit = integerParam(params, 'limit', 100, 1, 500);
  const query = params.get('query');
  const result = await store.listEntries({ scope, type: type ?? undefined, query: query ?? undefined, limit, projectKey });
  return { scope, total: result.total, project: info, entries: result.entries };
}

/** `GET /entry` — one note's full text. */
async function entryBody(ctx, store, request) {
  const params = searchParams(request);
  const scope = scopeParam(params, ['global', 'project', 'auto'], 'auto');
  const name = stringParam(params, 'name');
  const { projectKey, info } = await projectContext(ctx, request, store);

  const readOne = (target) => store.readNote({ scope: target, projectKey, name });
  let hit = null;
  try {
    if (scope === 'project') hit = await readOne('project');
    else if (scope === 'global') hit = await readOne('global');
    else {
      hit = await readOne('project');
      if (hit === null) hit = await readOne('global');
    }
  } catch (error) {
    throw badRequest(String(error?.message ?? error));
  }
  if (hit === null) throw new ApiError('not-found', `no memory named ${JSON.stringify(name)} in the requested scope`, 404);
  return {
    found: true,
    name: hit.note.name,
    description: hit.note.description,
    type: hit.note.type,
    content: hit.note.content,
    updatedAt: hit.updatedAt,
    scope: hit.scope,
    project: info,
    path: hit.path,
  };
}

/** `GET /diagnostics` — consistency, paths, lock, the project switcher's data, and the audit tail. */
async function diagnosticsBody(ctx, store, request, options = {}) {
  const { projectKey } = await projectContext(ctx, request, store);
  const report = await store.diagnostics({ projectKey });
  // The audit tail rides along so the settings page can show "what ran and why it
  // stopped" without a second request; it is a read-only diagnostic, never prompt input.
  const events = typeof options.events?.read === 'function' ? await options.events.read({ limit: 10 }) : [];
  return { ...report, runtime: { events }, currentProject: projectInfo(store, projectKey) };
}

/** `GET /events` — the bounded runtime audit log, newest first. */
async function eventsBody(request, options = {}) {
  const params = searchParams(request);
  const limit = integerParam(params, 'limit', 50, 1, 200);
  if (typeof options.events?.read !== 'function') return { enabled: false, events: [] };
  const events = await options.events.read({ limit });
  // No absolute path here: `/diagnostics` already carries the storage roots, and this
  // route is content-only.
  return { enabled: true, count: events.length, events };
}

const CANDIDATE_SCOPES = Object.freeze(['project', 'global']);

/** Validate a candidate scope (defaults to project: the common case for consolidation). */
function candidateScope(value) {
  if (value === undefined || value === null || value === '') return 'project';
  if (!CANDIDATE_SCOPES.includes(value)) throw badRequest('"scope" must be "project" or "global"');
  return value;
}

/** Resolve the scope + project key from a JSON body. */
async function candidateTarget(ctx, store, body) {
  const scope = candidateScope(body?.scope);
  const projectKey = await projectKeyForValues(ctx, { project: body?.project, key: body?.key, cwd: body?.cwd });
  return { scope, projectKey, info: scope === 'project' ? projectInfo(store, projectKey) : null };
}

/** `GET /candidates` — candidate bundle summaries for one scope. */
async function candidatesBody(ctx, store, request) {
  const params = searchParams(request);
  const scope = candidateScope(params.get('scope'));
  const projectKey = await projectKeyForValues(ctx, { project: params.get('project'), key: params.get('key'), cwd: params.get('cwd') });
  const candidates = await listCandidateBundles(store, { scope, projectKey });
  return { scope, project: scope === 'project' ? projectInfo(store, projectKey) : null, candidates };
}

/** `POST /candidates/adopt|discard` — shared argument validation. */
async function candidateActionBody(ctx, store, request, action) {
  const body = await readJsonBody(request);
  const target = await candidateTarget(ctx, store, body);
  const id = body?.id;
  if (typeof id !== 'string' || id === '') throw badRequest('"id" is required');
  const index = body?.index;
  if (!Number.isInteger(index) || index < 0) throw badRequest('"index" must be a non-negative integer');
  try {
    if (action === 'adopt') {
      const result = await adoptCandidate(store, { scope: target.scope, projectKey: target.projectKey, id, index });
      return { ok: true, action: result.action, name: result.name, remaining: result.remaining, redacted: result.redacted ?? 0 };
    }
    const result = await discardCandidate(store, { scope: target.scope, projectKey: target.projectKey, id, index });
    return { ok: true, remaining: result.remaining };
  } catch (error) {
    throw mapStoreError(error);
  }
}

/** `POST /consolidate` — run one dream pass and return the candidate bundle summary. */
async function consolidateBody(ctx, store, request, options) {
  const body = await readJsonBody(request);
  const target = await candidateTarget(ctx, store, body);
  if (target.scope === 'project' && target.projectKey === '') {
    throw badRequest('scope=project requires a project context (a project key or cwd)');
  }
  if (typeof options.invoke !== 'function') {
    const error = new Error('the model is not available in this host, so consolidation cannot run');
    error.code = 'llm-unavailable';
    throw error;
  }
  const result = await runConsolidation({
    store,
    scope: target.scope,
    projectKey: target.projectKey,
    invoke: options.invoke,
    now: typeof options.now === 'function' ? options.now() : new Date(),
    logger: options.logger ?? console,
    onEvent: typeof options.events?.append === 'function' ? (event) => void options.events.append(event) : null,
  });
  return { ok: true, id: result.id, count: result.count, index: result.index };
}

const WRITE_ACTIONS = Object.freeze(['create', 'update', 'delete']);
const WRITE_SCOPES = Object.freeze(['project', 'global']);

/**
 * `POST /entry` — the settings page's write path (P1).
 *
 * Same store methods as the model-facing tools, so the two can never drift:
 * `create` → `writeNote(expect:'absent')` (409 when the name exists),
 * `update` → `updateNote` (404 when it does not, merge of the supplied fields),
 * `delete` → `deleteNote` (404 when it does not).
 *
 * Responses are deliberately path-free: the page knows its scope and name, and an
 * absolute memory path in a browser response is an unnecessary disclosure.
 *
 * @returns {Promise<{ ok: true, name: string, scope: string, created?: boolean, removed?: boolean }>}
 */
async function writeEntryBody(ctx, store, request) {
  const body = await readJsonBody(request);
  const action = body?.action;
  if (!WRITE_ACTIONS.includes(action)) throw badRequest('"action" must be one of create | update | delete');
  const scope = body?.scope;
  if (!WRITE_SCOPES.includes(scope)) throw badRequest('"scope" must be "project" or "global"');
  const nameInput = body?.name;
  if (typeof nameInput !== 'string' || nameInput.trim() === '') throw badRequest('"name" is required');

  const projectKey = await projectKeyForValues(ctx, { project: body?.project, key: body?.key, cwd: body?.cwd });

  if (action === 'delete') {
    let result;
    try {
      result = await store.deleteNote({ scope, projectKey, name: nameInput });
    } catch (error) {
      throw mapStoreError(error);
    }
    if (result.deleted !== true) {
      throw new ApiError('not-found', `no memory named ${JSON.stringify(nameInput.trim())} exists in the ${scope} scope`, 404);
    }
    return { ok: true, name: nameInput.trim(), scope, removed: true };
  }

  let type;
  if (body?.type !== undefined) {
    if (typeof body.type !== 'string' || !VALID_TYPES.includes(body.type.trim().toLowerCase())) {
      throw badRequest(`"type" must be one of ${VALID_TYPES.join(' | ')}`);
    }
    type = body.type.trim().toLowerCase();
  }
  const description = body?.description;
  const content = body?.content;
  if (action === 'create') {
    if (typeof description !== 'string' || description.trim() === '') throw badRequest('"description" is required for create');
    if (typeof content !== 'string' || content.trim() === '') throw badRequest('"content" is required for create');
  } else {
    // Partial update: omitted fields keep the value currently on disk.
    if (description !== undefined && typeof description !== 'string') throw badRequest('"description" must be a string');
    if (content !== undefined && typeof content !== 'string') throw badRequest('"content" must be a string');
  }

  try {
    const result =
      action === 'create'
        ? await store.writeNote({ scope, projectKey, name: nameInput, description, content, type: type ?? 'env', expect: 'absent' })
        : await store.updateNote({ scope, projectKey, name: nameInput, description, content, type });
    // `redacted` is the count of masked secrets (the same single-entry redaction the
    // tools use); the response still carries no content and no path.
    return { ok: true, name: result.name, scope, created: result.created === true, redacted: result.redacted ?? 0, aliases: result.aliases ?? [] };
  } catch (error) {
    throw mapStoreError(error);
  }
}

// -------------------------------------------------------------------- open-dir

/** Launch the platform's file manager on a directory without waiting for it. */
function openDirectory(path) {
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(command, [path], { detached: true, stdio: 'ignore' });
    } catch (error) {
      reject(error);
      return;
    }
    child.once('spawn', () => {
      child.unref();
      resolvePromise();
    });
    child.once('error', reject);
  });
}

/** `POST /open-dir` — opening a directory is navigation, not a memory mutation. */
async function openDirBody(ctx, store, request, response, open) {
  const body = await readJsonBody(request);
  const scope = body?.scope ?? 'global';
  if (scope !== 'global' && scope !== 'project') throw badRequest('"scope" must be "global" or "project"');

  const supplied = body?.project ?? body?.key;
  let projectKey = null;
  if (supplied !== undefined && supplied !== null && supplied !== '') {
    if (!isProjectKey(supplied)) throw badRequest('"project" must be a project key of the form <slug>-<16 hex chars>');
    projectKey = supplied;
  } else if (typeof body?.cwd === 'string' && body.cwd !== '') {
    if (!isAbsolute(body.cwd)) throw badRequest('"cwd" must be an absolute path');
    projectKey = projectKeyOf(body.cwd, await resolveWorkspaceId(ctx, body.cwd));
  }

  let dir;
  if (scope === 'global') {
    dir = store.roots.globalDir;
  } else {
    if (projectKey === null) throw badRequest('scope=project requires "project" (a key from /diagnostics) or "cwd"');
    dir = store.projectDir(projectKey);
  }

  // Containment: the directory must belong to one of the two roots. The project key
  // pattern already prevents traversal, and this check keeps a future change to it from
  // turning the route into an arbitrary-directory opener.
  const containmentRoots = [store.roots.globalDir, store.roots.projectsDir];
  const contained = containmentRoots.some((root) => dir === root || dir.startsWith(`${root}${sep}`));
  if (!contained) throw badRequest('the requested directory is outside the memory roots');
  if (!existsSync(dir)) throw new ApiError('not-found', `the memory directory does not exist yet: ${dir}`, 404);

  await open(dir);
  return { ok: true, path: dir };
}

// ------------------------------------------------------------------ registration

/**
 * Register the routes.
 *
 * @param {object} ctx - plugin context (needs `webServer`, `connection`)
 * @param {ReturnType<import('./store.js').createMemoryStore>} store
 * @param {{
 *   openDirectory?: (path: string) => unknown,
 *   invoke?: (request: object) => Promise<object>,
 *   now?: () => Date,
 *   logger?: object,
 *   events?: { read: Function, append?: Function, path?: string },
 * }} [options] - test seams: the directory opener, the model invoker, the clock, the audit log
 * @returns {Array<() => void>} disposers
 */
export function registerRoutes(ctx, store, options = {}) {
  const open = typeof options.openDirectory === 'function' ? options.openDirectory : openDirectory;
  const disposers = [];
  const register = (path, handler) => {
    disposers.push(ctx.webServer.register({ kind: 'exact', path, handler }));
  };

  const readRoute = (handler) => async (request, response) => {
    if (rejectUnauthorized(ctx, request, response)) return;
    if (request.method === 'POST') {
      readOnly(response);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      methodNotAllowed(response, 'GET, HEAD, POST');
      return;
    }
    try {
      sendJson(response, 200, await handler(request, response));
    } catch (error) {
      sendError(response, error);
    }
  };

  register('/memory-manager/api/digest', readRoute((request) => digestBody(ctx, store, request)));
  register('/memory-manager/api/entries', readRoute((request) => entriesBody(ctx, store, request)));

  // `/entry` is the one path that reads AND writes: GET returns one note, POST is the
  // settings page's create/update/delete (P1). The other read routes keep answering 403
  // to POST so a write can never be smuggled through them.
  register('/memory-manager/api/entry', async (request, response) => {
    if (rejectUnauthorized(ctx, request, response)) return;
    if (request.method === 'GET' || request.method === 'HEAD') {
      try {
        sendJson(response, 200, await entryBody(ctx, store, request));
      } catch (error) {
        sendError(response, error);
      }
      return;
    }
    if (request.method === 'POST') {
      if (!requireJson(request, response)) return;
      try {
        sendJson(response, 200, await writeEntryBody(ctx, store, request));
      } catch (error) {
        sendError(response, error);
      }
      return;
    }
    methodNotAllowed(response, 'GET, HEAD, POST');
  });

  register('/memory-manager/api/diagnostics', readRoute((request) => diagnosticsBody(ctx, store, request, options)));
  register('/memory-manager/api/events', readRoute((request) => eventsBody(request, options)));

  // P1 candidate area: list proposals, adopt/discard one, and run a dream pass.
  const writeRoute = (handler) => async (request, response) => {
    if (rejectUnauthorized(ctx, request, response)) return;
    if (request.method !== 'POST') {
      methodNotAllowed(response, 'POST');
      return;
    }
    if (!requireJson(request, response)) return;
    try {
      sendJson(response, 200, await handler(request, response));
    } catch (error) {
      sendError(response, error);
    }
  };

  register('/memory-manager/api/candidates', readRoute((request) => candidatesBody(ctx, store, request)));
  register('/memory-manager/api/candidates/adopt', writeRoute((request) => candidateActionBody(ctx, store, request, 'adopt')));
  register('/memory-manager/api/candidates/discard', writeRoute((request) => candidateActionBody(ctx, store, request, 'discard')));
  register(
    '/memory-manager/api/consolidate',
    writeRoute(async (request) => {
      try {
        return await consolidateBody(ctx, store, request, options);
      } catch (error) {
        if (error?.code === 'llm-unavailable') throw new ApiError('llm-unavailable', String(error.message ?? error), 503);
        throw mapStoreError(error);
      }
    }),
  );

  register('/memory-manager/api/open-dir', async (request, response) => {
    if (rejectUnauthorized(ctx, request, response)) return;
    if (request.method !== 'POST') {
      methodNotAllowed(response, 'POST');
      return;
    }
    if (!requireJson(request, response)) return;
    try {
      sendJson(response, 200, await openDirBody(ctx, store, request, response, open));
    } catch (error) {
      sendError(response, error);
    }
  });

  return disposers;
}

export { ApiError };
