/**
 * dsh-skill-manager — route smoke test (no HTTP server, no profile).
 *
 *   D:\nodejs\node.exe test\routes-smoke.mjs
 *
 * A fake Cordis context captures the registered handlers, then requests are
 * driven through them with minimal IncomingMessage-like objects. This pins the
 * HTTP contract (paths, methods, JSON bodies, error envelopes, same-origin gate,
 * authentication fence, disposer) without starting a Harness.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerRoutes, API_BASE } from '../lib/routes.js';
import { setRuntimeDirs } from '../lib/custom-roots.js';

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`);
  }
}

/** Minimal Cordis context: registers routes, records the disposers. */
function fakeContext({ rejection, agents, skills, sessionQuery, cwd } = {}) {
  const routes = new Map();
  const disposers = [];
  const ctx = {
    // 与宿主一致的按名取服务：测试里只关心 agents / skills / sessionQuery。
    get(name) {
      if (name === 'agents') return agents;
      if (name === 'skills') return skills;
      if (name === 'sessionQuery') return sessionQuery;
      return undefined;
    },
    webServer: {
      getOrigin: () => 'http://127.0.0.1:52118',
      register(route) {
        assert.equal(route.kind, 'exact');
        routes.set(route.path, route.handler);
        const dispose = () => routes.delete(route.path);
        disposers.push(dispose);
        return dispose;
      },
    },
    connection: {
      requestRejection: () => rejection,
    },
    workingDirectory: {
      defaultDirectory: cwd ?? process.cwd(),
      ...(cwd === undefined ? {} : { get: () => cwd }),
    },
  };
  return { ctx, routes, disposers };
}

/** A live-Agent double shaped like the host's: `session` + scoped `ctx.get('skills')`. */
function fakeAgent({ cwd, skills }) {
  return {
    session: { id: `session-${cwd}`, header: { cwd } },
    ctx: {
      get(name) {
        return name === 'skills' ? skills : undefined;
      },
    },
  };
}

/** Build a request whose body is JSON-serialized when provided. */
function makeRequest({ method = 'GET', path = '/', headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  return {
    method,
    url: API_BASE + path,
    headers: { ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/** Build a response that records status, headers and JSON body. */
function makeResponse() {
  const response = {
    status: 0,
    headers: {},
    text: '',
    writeHead(status, headers) {
      response.status = status;
      response.headers = headers ?? {};
    },
    end(text) {
      response.text = text ?? '';
    },
    json() {
      return response.text === '' ? undefined : JSON.parse(response.text);
    },
  };
  return response;
}

/** Drive one handler and return the recorded response. */
async function call(routes, request) {
  const response = makeResponse();
  const entry = routes.get(request.url.split('?')[0]);
  assert.ok(entry, `route not registered: ${request.url}`);
  await entry(request, response);
  return response;
}

console.log('dsh-skill-manager route smoke');

const base = await mkdtemp(join(tmpdir(), 'dsh-skill-manager-routes-'));
try {
  const rootPath = join(base, 'custom-skills');
  await mkdir(join(rootPath, 'alpha'), { recursive: true });
  const alphaContent = ['---', 'name: alpha', 'description: Fixture alpha.', '---', '', '# alpha', ''].join('\n');
  await writeFile(join(rootPath, 'alpha', 'SKILL.md'), alphaContent, 'utf8');

  const { ctx, routes, disposers } = fakeContext();
  const opened = [];
  const disposeRoutes = registerRoutes(ctx, { customSkillDirs: [rootPath] }, { openInFileManager: (path) => opened.push(path) });

  await check('twenty-three route paths are registered', () => {
    assert.equal(routes.size, 23);
    assert.deepEqual([...routes.keys()].sort(), [
      `${API_BASE}/host-skills`,
      `${API_BASE}/market`,
      `${API_BASE}/market/install`,
      `${API_BASE}/market/uninstall`,
      `${API_BASE}/open`,
      `${API_BASE}/overview`,
      `${API_BASE}/roots/custom`,
      `${API_BASE}/search`,
      `${API_BASE}/skill`,
      `${API_BASE}/skill/batch`,
      `${API_BASE}/skill/create`,
      `${API_BASE}/skill/delete`,
      `${API_BASE}/skill/export`,
      `${API_BASE}/skill/file`,
      `${API_BASE}/skill/files`,
      `${API_BASE}/skill/import`,
      `${API_BASE}/skill/invocation`,
      `${API_BASE}/skill/save`,
      `${API_BASE}/skill/toggle`,
      `${API_BASE}/trash`,
      `${API_BASE}/trash/purge`,
      `${API_BASE}/trash/restore`,
      `${API_BASE}/usage`,
    ].sort());
  });

  await check('overview answers 200 with the contract shape', async () => {
    const response = await call(routes, makeRequest({ path: `/overview?cwd=${encodeURIComponent(base)}` }));
    assert.equal(response.status, 200);
    const body = response.json();
    assert.equal(typeof body.cwd, 'string');
    assert.equal(Array.isArray(body.skills), true);
    assert.equal(body.counts.total >= 1, true);
    assert.equal(typeof body.scannedAt, 'number');
    assert.equal(body.roots.some((root) => root.id === 'custom:0' && root.exists === true), true);
    assert.equal(body.market !== null, true);
    assert.equal(response.headers['cache-control'], 'no-store');
  });

  await check('overview finds the fixture skill', async () => {
    const response = await call(routes, makeRequest({ path: `/overview?cwd=${encodeURIComponent(base)}` }));
    const alpha = response.json().skills.find((skill) => skill.name === 'alpha');
    assert.ok(alpha, 'alpha missing');
    assert.equal(alpha.source, 'custom');
    assert.equal(alpha.state, 'enabled');
    assert.equal(alpha.key, 'custom:0/alpha');
  });

  await check('overview rejects non-GET methods', async () => {
    const response = await call(routes, makeRequest({ method: 'POST', path: '/overview' }));
    assert.equal(response.status, 405);
  });

  await check('skill detail returns content, hash and body', async () => {
    const query = `/skill?rootId=custom:0&dirName=alpha&kind=directory&state=enabled&cwd=${encodeURIComponent(base)}`;
    const response = await call(routes, makeRequest({ path: query }));
    assert.equal(response.status, 200);
    const body = response.json();
    assert.equal(body.content.trim().startsWith('---'), true);
    assert.equal(body.hasBom, false);
    assert.equal(body.frontmatter.name, 'alpha');
    assert.match(body.body, /# alpha/);
    assert.equal(typeof body.skill.hash, 'string');
  });

  await check('skill detail without rootId is a 400 envelope', async () => {
    const response = await call(routes, makeRequest({ path: '/skill?dirName=alpha' }));
    assert.equal(response.status, 400);
    assert.equal(response.json().error.code, 'bad-request');
  });

  await check('unknown root is a 404, not a path traversal', async () => {
    const response = await call(routes, makeRequest({ path: '/skill?rootId=..%2F..%2Fetc&dirName=alpha' }));
    assert.equal(response.status, 404);
    assert.equal(response.json().error.code, 'not-found');
  });

  await check('write without JSON content type is 415', async () => {
    const response = await call(routes, makeRequest({ method: 'POST', path: '/skill/toggle', headers: { origin: 'http://127.0.0.1:52118' } }));
    assert.equal(response.status, 415);
  });

  await check('cross-site write is 403', async () => {
    const response = await call(
      routes,
      makeRequest({
        method: 'POST',
        path: '/skill/toggle',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
        body: { rootId: 'custom:0', dirName: 'alpha', kind: 'directory', enabled: false },
      }),
    );
    assert.equal(response.status, 403);
    assert.equal(response.json().error.code, 'forbidden');
  });

  await check('cross-origin write is 403', async () => {
    const response = await call(
      routes,
      makeRequest({
        method: 'POST',
        path: '/skill/toggle',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: { rootId: 'custom:0', dirName: 'alpha', kind: 'directory', enabled: false },
      }),
    );
    assert.equal(response.status, 403);
  });

  const okHeaders = { 'content-type': 'application/json', origin: 'http://127.0.0.1:52118' };

  await check('toggle disables and re-enables the fixture skill', async () => {
    let response = await call(
      routes,
      makeRequest({
        method: 'POST',
        path: '/skill/toggle',
        headers: okHeaders,
        body: { rootId: 'custom:0', dirName: 'alpha', kind: 'directory', enabled: false, cwd: base },
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(response.json().state, 'disabled');

    response = await call(
      routes,
      makeRequest({
        method: 'POST',
        path: '/skill/toggle',
        headers: okHeaders,
        body: { rootId: 'custom:0', dirName: 'alpha', kind: 'directory', enabled: true, cwd: base },
      }),
    );
    assert.equal(response.json().state, 'enabled');
  });

  await check('save with a stale hash is 409 conflict', async () => {
    const detail = (
      await call(
        routes,
        makeRequest({ path: `/skill?rootId=custom:0&dirName=alpha&kind=directory&cwd=${encodeURIComponent(base)}` }),
      )
    ).json();
    const response = await call(
      routes,
      makeRequest({
        method: 'POST',
        path: '/skill/save',
        headers: okHeaders,
        body: {
          rootId: 'custom:0',
          dirName: 'alpha',
          kind: 'directory',
          state: 'enabled',
          hash: 'stale-hash',
          content: detail.content,
          cwd: base,
        },
      }),
    );
    assert.equal(response.status, 409);
    assert.equal(response.json().error.code, 'conflict');
  });

  await check('save with the current hash succeeds and reports issues', async () => {
    const detail = (
      await call(
        routes,
        makeRequest({ path: `/skill?rootId=custom:0&dirName=alpha&kind=directory&cwd=${encodeURIComponent(base)}` }),
      )
    ).json();
    const response = await call(
      routes,
      makeRequest({
        method: 'POST',
        path: '/skill/save',
        headers: okHeaders,
        body: {
          rootId: 'custom:0',
          dirName: 'alpha',
          kind: 'directory',
          state: 'enabled',
          hash: detail.skill.hash,
          content: detail.content.replace('# alpha', '# alpha edited'),
          cwd: base,
        },
      }),
    );
    assert.equal(response.status, 200);
    const body = response.json();
    assert.equal(body.ok, true);
    assert.equal(Array.isArray(body.issues), true);
    assert.notEqual(body.hash, detail.skill.hash);
    const onDisk = await readFile(join(rootPath, 'alpha', 'SKILL.md'), 'utf8');
    assert.match(onDisk, /alpha edited/);
  });

  await check('create writes a skill and refuses a duplicate', async () => {
    let response = await call(
      routes,
      makeRequest({
        method: 'POST',
        path: '/skill/create',
        headers: okHeaders,
        body: { rootId: 'custom:0', name: 'route-made', description: 'Made by the route test.', cwd: base },
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(response.json().skill.name, 'route-made');

    response = await call(
      routes,
      makeRequest({
        method: 'POST',
        path: '/skill/create',
        headers: okHeaders,
        body: { rootId: 'custom:0', name: 'route-made', description: 'dup', cwd: base },
      }),
    );
    assert.equal(response.status, 409);
    assert.equal(response.json().error.code, 'exists');
  });

  await check('delete moves the skill into _trash', async () => {
    const response = await call(
      routes,
      makeRequest({
        method: 'POST',
        path: '/skill/delete',
        headers: okHeaders,
        body: { rootId: 'custom:0', dirName: 'route-made', kind: 'directory', cwd: base },
      }),
    );
    assert.equal(response.status, 200);
    assert.match(response.json().trashed, /_trash/);
  });

  await check('open hands the resolved path to the OS opener', async () => {
    const response = await call(
      routes,
      makeRequest({
        method: 'POST',
        path: '/open',
        headers: okHeaders,
        body: { rootId: 'custom:0', dirName: 'alpha', kind: 'directory', cwd: base },
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(opened.length, 1);
    assert.equal(opened[0], join(rootPath, 'alpha'));
  });

  await check('open refuses an escaping dirName', async () => {
    const response = await call(
      routes,
      makeRequest({
        method: 'POST',
        path: '/open',
        headers: okHeaders,
        body: { rootId: 'custom:0', dirName: '../..', kind: 'directory', cwd: base },
      }),
    );
    assert.equal(response.status, 400);
  });

  await check('invocation route flips the soft-disable keys without moving the entry', async () => {
    const response = await call(
      routes,
      makeRequest({
        method: 'POST',
        path: '/skill/invocation',
        headers: okHeaders,
        body: { rootId: 'custom:0', dirName: 'alpha', kind: 'directory', model: false, user: true, cwd: base },
      }),
    );
    assert.equal(response.status, 200);
    const body = response.json();
    assert.deepEqual(body.invocation, { model: false, user: true });
    assert.equal(typeof body.hash, 'string');
    const onDisk = await readFile(join(rootPath, 'alpha', 'SKILL.md'), 'utf8');
    assert.match(onDisk, /disable-model-invocation: true/);
    // 条目仍在根目录（软禁用不搬目录）
    assert.equal(response.status, 200);
    const overview = (await call(routes, makeRequest({ path: `/overview?cwd=${encodeURIComponent(base)}` }))).json();
    const alpha = overview.skills.find((skill) => skill.name === 'alpha');
    assert.deepEqual(alpha.invocation, { model: false, user: true });
    assert.equal(alpha.state, 'enabled');
  });

  await check('invocation route validates booleans and rejects a stale hash', async () => {
    let response = await call(
      routes,
      makeRequest({
        method: 'POST', path: '/skill/invocation', headers: okHeaders,
        body: { rootId: 'custom:0', dirName: 'alpha', kind: 'directory', model: 'no', user: true, cwd: base },
      }),
    );
    assert.equal(response.status, 400);
    assert.equal(response.json().error.code, 'bad-request');

    response = await call(
      routes,
      makeRequest({
        method: 'POST', path: '/skill/invocation', headers: okHeaders,
        body: { rootId: 'custom:0', dirName: 'alpha', kind: 'directory', hash: 'stale', model: true, user: true, cwd: base },
      }),
    );
    assert.equal(response.status, 409);
    assert.equal(response.json().error.code, 'conflict');
  });

  await check('batch route returns per-item results and one failure does not stop the rest', async () => {
    await mkdir(join(rootPath, 'batch-a'), { recursive: true });
    await writeFile(join(rootPath, 'batch-a', 'SKILL.md'), ['---', 'name: batch-a', 'description: A.', '---', 'a'].join('\n'), 'utf8');
    await mkdir(join(rootPath, 'batch-b'), { recursive: true });
    await writeFile(join(rootPath, 'batch-b', 'SKILL.md'), ['---', 'name: batch-b', 'description: B.', '---', 'b'].join('\n'), 'utf8');

    const response = await call(
      routes,
      makeRequest({
        method: 'POST', path: '/skill/batch', headers: okHeaders,
        body: {
          action: 'disable',
          items: [
            { rootId: 'custom:0', dirName: 'batch-a', kind: 'directory' },
            { rootId: 'custom:0', dirName: 'no-such-skill', kind: 'directory' },
            { rootId: 'custom:0', dirName: 'batch-b', kind: 'directory' },
          ],
          cwd: base,
        },
      }),
    );
    assert.equal(response.status, 200);
    const body = response.json();
    assert.equal(body.counts.total, 3);
    assert.equal(body.counts.ok, 2);
    assert.equal(body.counts.failed, 1);
    assert.equal(body.results[0].ok, true);
    assert.equal(body.results[1].ok, false);
    assert.equal(body.results[1].error.code, 'not-found');
    assert.equal(body.results[2].ok, true);
    const scanned = await readFile(join(rootPath, '_disabled', 'batch-a', 'SKILL.md'), 'utf8');
    assert.match(scanned, /name: batch-a/);
  });

  await check('batch route rejects an unknown action and an empty list', async () => {
    let response = await call(
      routes,
      makeRequest({ method: 'POST', path: '/skill/batch', headers: okHeaders, body: { action: 'explode', items: [], cwd: base } }),
    );
    assert.equal(response.status, 400);
    response = await call(
      routes,
      makeRequest({ method: 'POST', path: '/skill/batch', headers: okHeaders, body: { action: 'delete', items: [], cwd: base } }),
    );
    assert.equal(response.status, 400);
    response = await call(
      routes,
      makeRequest({
        method: 'POST', path: '/skill/batch', headers: okHeaders,
        body: { action: 'delete', items: new Array(201).fill({ rootId: 'custom:0', dirName: 'alpha' }), cwd: base },
      }),
    );
    assert.equal(response.status, 400);
  });

  await check('import route imports a folder and reports skips', async () => {
    const incoming = join(base, 'route-incoming');
    await mkdir(join(incoming, 'pack', 'one'), { recursive: true });
    await writeFile(join(incoming, 'pack', 'one', 'SKILL.md'), ['---', 'name: imported-one', 'description: One.', '---', '1'].join('\n'), 'utf8');
    await mkdir(join(incoming, 'pack', 'two'), { recursive: true });
    await writeFile(join(incoming, 'pack', 'two', 'SKILL.md'), ['---', 'name: two', '---', '2'].join('\n'), 'utf8');

    const response = await call(
      routes,
      makeRequest({
        method: 'POST', path: '/skill/import', headers: okHeaders,
        body: { path: incoming, rootId: 'custom:0', cwd: base },
      }),
    );
    assert.equal(response.status, 200);
    const body = response.json();
    assert.deepEqual(body.imported.map((entry) => entry.name), ['imported-one']);
    assert.equal(body.skipped[0].code, 'invalid');
    assert.equal(body.skipped[0].issue, 'description-missing');
  });

  await check('import route requires a path and a known root', async () => {
    let response = await call(
      routes,
      makeRequest({ method: 'POST', path: '/skill/import', headers: okHeaders, body: { rootId: 'custom:0', cwd: base } }),
    );
    assert.equal(response.status, 400);
    response = await call(
      routes,
      makeRequest({ method: 'POST', path: '/skill/import', headers: okHeaders, body: { path: base, rootId: 'nope', cwd: base } }),
    );
    assert.equal(response.status, 404);
  });

  await check('usage route degrades to available:false without a session query service', async () => {
    const response = await call(routes, makeRequest({ path: '/usage' }));
    assert.equal(response.status, 200);
    const body = response.json();
    assert.equal(body.available, false);
    assert.match(body.error, /sessionQuery/);
    assert.deepEqual(body.skills, []);
  });

  await check('usage route counts calls through the injected session query service', async () => {
    const now = Date.now();
    const sessionQuery = {
      async listSessions() {
        return [{ header: { id: 's1', createdAt: now - 1000 }, live: true, persisted: true }];
      },
      async readSession() {
        return {
          session: { id: 's1' },
          events: [{ type: 'tool/call', time: now - 500, seq: 1, data: { name: 'skill', arguments: '{"name":"alpha"}' } }],
        };
      },
    };
    const usageServer = fakeContext({ sessionQuery, cwd: base });
    const usageDisposers = registerRoutes(usageServer.ctx, { customSkillDirs: [rootPath] });
    try {
      const response = await call(usageServer.routes, makeRequest({ path: '/usage' }));
      assert.equal(response.status, 200);
      const body = response.json();
      assert.equal(body.available, true);
      assert.equal(body.sessions.total, 1);
      assert.equal(body.skills[0].name, 'alpha');
      assert.equal(body.skills[0].d7, 1);
    } finally {
      usageDisposers.forEach((dispose) => dispose());
    }
  });

  await check('usage route rejects non-GET', async () => {
    const response = await call(routes, makeRequest({ method: 'POST', path: '/usage' }));
    assert.equal(response.status, 405);
  });

  await check('market answers with the contract shape', async () => {
    const response = await call(routes, makeRequest({ path: `/market?cwd=${encodeURIComponent(base)}&limit=20` }));
    assert.equal(response.status, 200);
    const body = response.json();
    assert.equal(typeof body.available, 'boolean');
    assert.equal(Array.isArray(body.repos), true);
    assert.equal(typeof body.counts.totalSkills, 'number');
    if (body.available) assert.equal(body.repos.length > 0, true);
  });

  await check('market/install rejects an unknown market entry', async () => {
    const response = await call(
      routes,
      makeRequest({
        method: 'POST',
        path: '/market/install',
        headers: okHeaders,
        body: { repo: 'no-such-repo', folder: 'no-such-skill', rootId: 'custom:0', cwd: base },
      }),
    );
    assert.equal(response.status, 404);
    assert.equal(response.json().error.code, 'not-found');
  });

  /** Bundled fixture at rank 600: the only disk root that loses to plugin skills (350). */
  const bundledPath = join(base, 'bundled-skills');
  await mkdir(join(bundledPath, 'plugin-demo'), { recursive: true });
  await writeFile(
    join(bundledPath, 'plugin-demo', 'SKILL.md'),
    ['---', 'name: plugin-demo', 'description: Bundled fixture shadowed by a plugin skill.', '---', '', '# plugin-demo', ''].join('\n'),
    'utf8',
  );

  await check('overview marks plugin-hub duplicates (rank 350) and reports pluginSkills', async () => {
    const listed = [];
    const pluginList = [
      {
        name: 'plugin-demo',
        description: 'Provided by a plugin.',
        provider: 'plugin-hub:demo',
        source: 'plugin-hub',
        invocation: { modelInvocable: true, userInvocable: true },
        path: join(bundledPath, 'plugin-demo', 'SKILL.md'),
      },
      {
        name: 'alpha',
        description: 'Provided by another plugin.',
        provider: 'plugin-hub:other',
        source: 'plugin-hub',
        invocation: { modelInvocable: true, userInvocable: true },
      },
    ];
    const skillsService = {
      async list(options) {
        listed.push(options);
        return pluginList;
      },
    };
    const agent = fakeAgent({ cwd: base, skills: skillsService });
    const pluginServer = fakeContext({ agents: { list: () => [agent] }, skills: skillsService, cwd: base });
    const pluginDisposers = registerRoutes(pluginServer.ctx, { customSkillDirs: [rootPath], bundledSkillDir: bundledPath });
    try {
      const response = await call(pluginServer.routes, makeRequest({ path: `/overview?cwd=${encodeURIComponent(base)}` }));
      assert.equal(response.status, 200);
      const body = response.json();

      // 服务调用必须带上本次 cwd 与 live Agent（agent.ctx 的 scope 层才有插件 provider）。
      assert.equal(listed.length, 1);
      assert.equal(listed[0].scope, agent);
      assert.equal(listed[0].cwd, base);
      assert.deepEqual(body.pluginSkills, {
        available: true,
        count: 2,
        providers: ['plugin-hub:demo', 'plugin-hub:other'],
      });

      const bundled = body.skills.find((skill) => skill.rootId === 'bundled' && skill.name === 'plugin-demo');
      assert.ok(bundled, 'bundled plugin-demo missing');
      assert.equal(bundled.shadowed, true);
      assert.deepEqual(bundled.shadowedByPlugin, { provider: 'plugin-hub:demo' });
      const issue = bundled.issues.find((entry) => entry.code === 'shadowed-by-plugin');
      assert.ok(issue, 'shadowed-by-plugin issue missing');
      assert.equal(issue.level, 'warn');
      assert.match(issue.message, /plugin-hub:demo/);
      assert.equal(body.counts.shadowedByPlugin, 1);

      // custom 300 < 350：本地技能仍优先，不能误标。
      const custom = body.skills.find((skill) => skill.rootId === 'custom:0' && skill.name === 'alpha');
      assert.ok(custom, 'custom alpha missing');
      assert.equal(custom.shadowed, false);
      assert.equal(custom.shadowedByPlugin, undefined);

      // GET /skill 与列表同口径。
      const detail = await call(
        pluginServer.routes,
        makeRequest({
          path: `/skill?rootId=bundled&dirName=plugin-demo&kind=directory&state=enabled&cwd=${encodeURIComponent(base)}`,
        }),
      );
      assert.equal(detail.status, 200);
      assert.deepEqual(detail.json().skill.shadowedByPlugin, { provider: 'plugin-hub:demo' });
    } finally {
      pluginDisposers.forEach((dispose) => dispose());
    }
  });

  await check('overview degrades pluginSkills without an agent or skills service', async () => {
    // 1) 没有 live Agent：overview 照常 200，只是插件视图不可用。
    const bare = fakeContext({ cwd: base });
    let disposers = registerRoutes(bare.ctx, { customSkillDirs: [rootPath], bundledSkillDir: bundledPath });
    try {
      const response = await call(bare.routes, makeRequest({ path: `/overview?cwd=${encodeURIComponent(base)}` }));
      assert.equal(response.status, 200);
      const body = response.json();
      assert.equal(body.pluginSkills.available, false);
      assert.equal(body.pluginSkills.count, 0);
      assert.equal(typeof body.pluginSkills.error, 'string');
      assert.equal(body.counts.shadowedByPlugin, 0);
      assert.equal(body.counts.total >= 1, true);
    } finally {
      disposers.forEach((dispose) => dispose());
    }

    // 2) Agent 在、skills 服务不在：同样降级而不是抛错。
    const agent = fakeAgent({ cwd: base, skills: undefined });
    const noService = fakeContext({ agents: { list: () => [agent] }, cwd: base });
    disposers = registerRoutes(noService.ctx, { customSkillDirs: [rootPath], bundledSkillDir: bundledPath });
    try {
      const response = await call(noService.routes, makeRequest({ path: `/overview?cwd=${encodeURIComponent(base)}` }));
      assert.equal(response.status, 200);
      const body = response.json();
      assert.equal(body.pluginSkills.available, false);
      assert.equal(body.pluginSkills.count, 0);
      assert.match(body.pluginSkills.error, /skills 服务/);
      assert.equal(body.counts.shadowedByPlugin, 0);
    } finally {
      disposers.forEach((dispose) => dispose());
    }
    // 3) skills 服务抛错：同样降级，不能把 overview 变成 500。
    const throwing = fakeAgent({ cwd: base, skills: { async list() { throw new Error('boom'); } } });
    const throwingServer = fakeContext({ agents: { list: () => [throwing] }, cwd: base });
    disposers = registerRoutes(throwingServer.ctx, { customSkillDirs: [rootPath], bundledSkillDir: bundledPath });
    try {
      const response = await call(throwingServer.routes, makeRequest({ path: `/overview?cwd=${encodeURIComponent(base)}` }));
      assert.equal(response.status, 200);
      const body = response.json();
      assert.equal(body.pluginSkills.available, false);
      assert.match(body.pluginSkills.error, /读取宿主技能失败/);
      assert.equal(body.counts.shadowedByPlugin, 0);
    } finally {
      disposers.forEach((dispose) => dispose());
    }
  });

  /* v3：回收站 / 资源文件 / 正文搜索 / host-skills / 市场卸载 / 严格入参 */
  const q = `cwd=${encodeURIComponent(base)}`;
  await mkdir(join(rootPath, '_trash', 'trashed-a@20260101T000000'), { recursive: true });
  await writeFile(join(rootPath, '_trash', 'trashed-a@20260101T000000', 'SKILL.md'), alphaContent.replace('alpha', 'trashed-a'), 'utf8');
  await mkdir(join(rootPath, '_trash', 'trashed-b@20260101T000001'), { recursive: true });
  await writeFile(join(rootPath, '_trash', 'trashed-b@20260101T000001', 'SKILL.md'), alphaContent.replace('alpha', 'trashed-b'), 'utf8');
  await mkdir(join(rootPath, 'alpha', 'references'), { recursive: true });
  await writeFile(join(rootPath, 'alpha', 'references', 'notes.md'), '# notes\n', 'utf8');

  await check('trash route lists entries and restore brings one back', async () => {
    const listed = await call(routes, makeRequest({ path: `/trash?rootId=custom:0&${q}` }));
    assert.equal(listed.status, 200);
    const body = listed.json();
    assert.equal(body.counts.total >= 2, true);
    const entry = body.roots[0].entries.find((candidate) => candidate.name === 'trashed-a');
    assert.ok(entry);

    const restored = await call(routes, makeRequest({
      method: 'POST', path: '/trash/restore',
      headers: { 'content-type': 'application/json' },
      body: { rootId: 'custom:0', token: entry.token, cwd: base },
    }));
    assert.equal(restored.status, 200);
    assert.equal(restored.json().state, 'enabled');
  });

  await check('trash purge refuses an unconfirmed sweep and accepts a confirmed one', async () => {
    const refused = await call(routes, makeRequest({
      method: 'POST', path: '/trash/purge',
      headers: { 'content-type': 'application/json' },
      body: { rootId: 'custom:0', all: true, cwd: base },
    }));
    assert.equal(refused.status, 400);

    const purged = await call(routes, makeRequest({
      method: 'POST', path: '/trash/purge',
      headers: { 'content-type': 'application/json' },
      body: { rootId: 'custom:0', all: true, confirm: true, cwd: base },
    }));
    assert.equal(purged.status, 200);
    assert.equal(purged.json().removed.length >= 1, true);
  });

  await check('resource routes list, read, write and reject an escape', async () => {
    const listed = await call(routes, makeRequest({ path: `/skill/files?rootId=custom:0&dirName=alpha&kind=directory&${q}` }));
    assert.equal(listed.status, 200);
    assert.equal(listed.json().entries.some((entry) => entry.relativePath === 'references/notes.md'), true);

    const read = await call(routes, makeRequest({ path: `/skill/file?rootId=custom:0&dirName=alpha&kind=directory&file=references/notes.md&${q}` }));
    assert.equal(read.status, 200);
    const hash = read.json().hash;
    assert.match(hash, /^[a-f0-9]{64}$/);

    const written = await call(routes, makeRequest({
      method: 'POST', path: '/skill/file',
      headers: { 'content-type': 'application/json' },
      body: { rootId: 'custom:0', dirName: 'alpha', kind: 'directory', file: 'references/notes.md', content: '# changed\n', hash, cwd: base },
    }));
    assert.equal(written.status, 200);

    const escape = await call(routes, makeRequest({ path: `/skill/file?rootId=custom:0&dirName=alpha&kind=directory&file=../../etc/passwd&${q}` }));
    assert.equal(escape.status, 400);

    const wrongMethod = await call(routes, makeRequest({ method: 'PUT', path: '/skill/file' }));
    assert.equal(wrongMethod.status, 405);
  });

  await check('search route matches the body and rejects a one-character query', async () => {
    const found = await call(routes, makeRequest({ path: `/search?q=${encodeURIComponent('Fixture alpha')}&${q}` }));
    assert.equal(found.status, 200);
    assert.equal(found.json().results.length >= 1, true);

    const tooShort = await call(routes, makeRequest({ path: `/search?q=a&${q}` }));
    assert.equal(tooShort.status, 400);
  });

  await check('host-skills route exposes the live catalog and overview derives hostOnly', async () => {
    const summaries = [{
      name: 'preset-only',
      description: 'from a preset provider',
      source: 'bundled',
      provider: 'filesystem',
      invocation: { modelInvocable: true, userInvocable: true },
    }];
    const service = { snapshot: async () => ({ skills: summaries, complete: true }) };
    const agent = fakeAgent({ cwd: base, skills: service });
    const hostCtx = fakeContext({ agents: { list: () => [agent] }, cwd: base });
    const hostDisposers = registerRoutes(hostCtx.ctx, { customSkillDirs: [rootPath] });
    try {
      const response = await call(hostCtx.routes, makeRequest({ path: `/host-skills?${q}` }));
      assert.equal(response.status, 200);
      const body = response.json();
      assert.equal(body.available, true);
      assert.equal(body.complete, true);
      assert.equal(body.count, 1);
      assert.deepEqual(body.providers, ['filesystem']);
      assert.equal(body.skills[0].modelInvocable, true);

      const overview = await call(hostCtx.routes, makeRequest({ path: `/overview?${q}` }));
      const payload = overview.json();
      assert.equal(payload.hostSkills.available, true);
      assert.equal(payload.hostOnly.length, 1);
      assert.equal(payload.hostOnly[0].name, 'preset-only');
    } finally {
      hostDisposers.forEach((dispose) => dispose());
    }
  });

  await check('save requires a hash, open reports a missing target, batch supports invocation', async () => {
    const noHash = await call(routes, makeRequest({
      method: 'POST', path: '/skill/save',
      headers: { 'content-type': 'application/json' },
      body: { rootId: 'custom:0', dirName: 'alpha', kind: 'directory', content: '---\nname: alpha\ndescription: x\n---\n', cwd: base },
    }));
    assert.equal(noHash.status, 400);
    assert.equal(noHash.json().error.code, 'bad-request');

    const missing = await call(routes, makeRequest({
      method: 'POST', path: '/open',
      headers: { 'content-type': 'application/json' },
      body: { rootId: 'custom:0', dirName: 'nope', kind: 'directory', cwd: base },
    }));
    assert.equal(missing.status, 404);

    const batch = await call(routes, makeRequest({
      method: 'POST', path: '/skill/batch',
      headers: { 'content-type': 'application/json' },
      body: { action: 'invocation', model: false, user: true, items: [{ rootId: 'custom:0', dirName: 'alpha', kind: 'directory' }], cwd: base },
    }));
    assert.equal(batch.status, 200);
    assert.equal(batch.json().results[0].invocation.model, false);
  });

  await check('market install then uninstall clears the ledger record', async () => {
    const marketDir = join(base, 'market');
    await mkdir(join(marketDir, 'skills', 'repo-a', 'skill-a'), { recursive: true });
    await writeFile(
      join(marketDir, 'skills', 'repo-a', 'skill-a', 'SKILL.md'),
      ['---', 'name: skill-a', 'description: Market fixture.', '---', 'body'].join('\n'),
      'utf8',
    );
    const marketCtx = fakeContext({ cwd: base });
    const marketDisposers = registerRoutes(marketCtx.ctx, { customSkillDirs: [rootPath], marketDir });
    try {
      const installed = await call(marketCtx.routes, makeRequest({
        method: 'POST', path: '/market/install',
        headers: { 'content-type': 'application/json' },
        body: { repo: 'repo-a', folder: 'skill-a', rootId: 'custom:0', cwd: base },
      }));
      assert.equal(installed.status, 200);

      const uninstalled = await call(marketCtx.routes, makeRequest({
        method: 'POST', path: '/market/uninstall',
        headers: { 'content-type': 'application/json' },
        body: { repo: 'repo-a', folder: 'skill-a', rootId: 'custom:0', cwd: base },
      }));
      assert.equal(uninstalled.status, 200);
      assert.equal(uninstalled.json().ledgerRemoved, true);

      const market = await call(marketCtx.routes, makeRequest({ path: `/market?query=skill-a&${q}` }));
      const entries = market.json().repos.flatMap((repo) => repo.skills);
      assert.equal(entries.every((entry) => entry.installed === false), true);
    } finally {
      marketDisposers.forEach((dispose) => dispose());
    }
  });

  await check('custom roots route reports profile state and persists a managed block', async () => {
    const profileDir = join(base, 'profile');
    await mkdir(profileDir, { recursive: true });
    const patchPath = join(profileDir, 'cordis.patch.yml');
    await writeFile(patchPath, '# profile patch\n[]\n', 'utf8');

    const rootsCtx = fakeContext({ cwd: base });
    rootsCtx.ctx.configEditor = { documentPath: patchPath };
    const rootsDisposers = registerRoutes(rootsCtx.ctx, { customSkillDirs: [rootPath] });
    try {
      const listed = await call(rootsCtx.routes, makeRequest({ path: `/roots/custom?${q}` }));
      assert.equal(listed.status, 200);
      assert.equal(listed.json().profilePath, patchPath);
      assert.equal(listed.json().writable, true);

      const extra = join(base, 'extra-roots');
      await mkdir(extra, { recursive: true });
      const written = await call(rootsCtx.routes, makeRequest({
        method: 'POST', path: '/roots/custom',
        headers: { 'content-type': 'application/json' },
        body: { dirs: [extra], persist: true, cwd: base },
      }));
      assert.equal(written.status, 200);
      assert.equal(written.json().persisted, true);
      assert.equal(written.json().requiresReload, true);

      const text = await readFile(patchPath, 'utf8');
      assert.match(text, /dsh-skill-manager custom roots/);
      assert.match(text, /extra-roots/);

      const reloaded = await call(rootsCtx.routes, makeRequest({ path: `/roots/custom?${q}` }));
      assert.equal(reloaded.json().persisted.length, 1);
    } finally {
      setRuntimeDirs([], base);
      rootsDisposers.forEach((dispose) => dispose());
    }
  });

  await check('export route writes an archive and refuses to overwrite one', async () => {
    await mkdir(join(rootPath, 'export-only'), { recursive: true });
    await writeFile(join(rootPath, 'export-only', 'SKILL.md'), alphaContent.replace('alpha', 'export-only'), 'utf8');
    const target = join(base, 'export-only.zip');
    const body = {
      rootId: 'custom:0', dirName: 'export-only', kind: 'directory', targetPath: target, cwd: base,
    };
    const first = await call(routes, makeRequest({
      method: 'POST', path: '/skill/export', headers: { 'content-type': 'application/json' }, body,
    }));
    assert.equal(first.status, 200);
    assert.equal(first.json().path, target);
    assert.equal(first.json().files >= 1, true);

    const again = await call(routes, makeRequest({
      method: 'POST', path: '/skill/export', headers: { 'content-type': 'application/json' }, body,
    }));
    assert.equal(again.status, 409);

    const badExt = await call(routes, makeRequest({
      method: 'POST', path: '/skill/export',
      headers: { 'content-type': 'application/json' },
      body: { ...body, targetPath: join(base, 'export-only.txt') },
    }));
    assert.equal(badExt.status, 400);

    // 删掉磁盘上的技能，再从压缩包导入回来：验证解压 + 发现 + 拍平。
    const removed = await call(routes, makeRequest({
      method: 'POST', path: '/skill/delete',
      headers: { 'content-type': 'application/json' },
      body: { rootId: 'custom:0', dirName: 'export-only', kind: 'directory', cwd: base },
    }));
    assert.equal(removed.status, 200);

    const imported = await call(routes, makeRequest({
      method: 'POST', path: '/skill/import',
      headers: { 'content-type': 'application/json' },
      body: { rootId: 'custom:0', path: target, cwd: base },
    }));
    assert.equal(imported.status, 200);
    assert.equal(imported.json().archive, true);
    assert.deepEqual(imported.json().imported.map((entry) => entry.name), ['export-only']);
  });

  await check('disposing the routes unregisters every handler', () => {
    for (const dispose of disposers) dispose();
    assert.equal(routes.size, 0);
    void disposeRoutes;
  });

  await check('requestRejection answers before any handler runs', async () => {
    const fenced = fakeContext({ rejection: 401 });
    registerRoutes(fenced.ctx, { customSkillDirs: [rootPath] });
    const response = await call(fenced.routes, makeRequest({ path: '/overview' }));
    assert.equal(response.status, 401);
    assert.equal(response.text, '');
  });
} finally {
  await rm(base, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(failure.error);
  process.exitCode = 1;
}
