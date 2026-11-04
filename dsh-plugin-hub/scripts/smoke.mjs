/**
 * 端到端冒烟：不启动 HTTP 服务，直接把宿主路由挂到假 webServer 上调用。
 *
 * 覆盖：安装（本地目录）→ 生效视图 → 组件明细 → 全局/项目作用域覆盖 → 信任门 →
 * options 合并 → 卸载 → 安全围栏（鉴权/方法/Content-Type/坏 body）。
 * 投影层（skills/commands/hooks/MCP 真正挂到 Agent）由 runtime-smoke 与真机验证覆盖。
 */

import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { makeFixturePlugin } from './fixture/make.mjs';
import { mountRoutes } from '../lib/routes.js';
import { hubPaths } from '../lib/store.js';
import { findExecutable } from '../lib/util.js';

const execFileAsync = promisify(execFile);

const results = [];
const check = (label, ok, extra = '') => {
  results.push({ label, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ` :: ${extra}` : ''}`);
  if (!ok) process.exitCode = 1;
};

const root = await mkdtemp(join(tmpdir(), 'hub-smoke-'));
const profile = join(root, 'profile');
const project = join(root, 'project');
const fixture = await makeFixturePlugin(join(root, 'fixture'));
await mkdir(profile, { recursive: true });
await mkdir(project, { recursive: true });

/** 假响应：记录状态与 body，供断言。 */
function makeResponse() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(text = '') {
      this.body = String(text);
    },
    json() {
      try {
        return JSON.parse(this.body);
      } catch {
        return null;
      }
    },
  };
}

/** 假请求：body 用 Readable 模拟，method/url/headers 按需覆盖。 */
function makeRequest({ method = 'GET', url = '/', body, contentType = 'application/json', headers = {} } = {}) {
  const stream = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
  stream.method = method;
  stream.url = url;
  stream.headers = { ...(body === undefined ? {} : { 'content-type': contentType }), ...headers };
  return stream;
}

const routes = new Map();
const health = { rejection: undefined };
const ctx = {
  configEditor: { documentPath: join(profile, 'cordis.patch.yml') },
  connection: { requestRejection: () => health.rejection },
  workingDirectory: { get: () => project },
  webServer: {
    register(route) {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  },
};

const disposeRoutes = mountRoutes(ctx);
const call = async (path, options) => {
  const [bare] = path.split('?');
  const handler = routes.get(`/plugin-hub/api${bare}`);
  if (handler === undefined) throw new Error(`route not mounted: ${bare}`);
  const response = makeResponse();
  await handler(makeRequest({ url: `/plugin-hub/api${path}`, ...options }), response);
  return response;
};

// 1 ---------------------------------------------------------------- 初始视图
let response = await call('/overview?cwd=' + encodeURIComponent(project));
check('overview starts empty', response.status === 200 && response.json().installed.length === 0);
check('overview exposes projectionErrors', Array.isArray(response.json().projectionErrors));

// 2 ------------------------------------------------------- 安装（本地目录）
response = await call('/install', { method: 'POST', body: { source: { kind: 'directory', path: fixture } } });
let installed = response.json();
check('install from directory', response.status === 200 && installed?.id === 'hub-fixture@local', installed?.id ?? response.body.slice(0, 120));
check('install records version', installed?.version === '0.1.0');
const cacheRoot = hubPaths(ctx).cacheRoot;
check('package copied into cache', String(installed?.rootPath ?? '').startsWith(cacheRoot));
check('new install enabled in user scope', (await readJson(join(hubPaths(ctx).root, 'user.json')))?.enabledPlugins?.['hub-fixture@local'] === true);

// 3 -------------------------------------------------------------- 生效视图
response = await call('/overview?cwd=' + encodeURIComponent(project));
let overview = response.json();
check('overview lists installed', overview.installed.length === 1);
check('effective plugin enabled', overview.effective.plugins[0]?.enabled === true, overview.effective.plugins[0]?.enabledSource);
const counts = Object.fromEntries((overview.effective.plugins[0]?.components ?? []).map((item) => [item.kind, item.count]));
check('effective component counts', counts.skill === 2 && counts.command === 1 && counts.agent === 1 && counts.mcp === 1, JSON.stringify(counts));

// 4 ---------------------------------------------------------------- 组件明细
response = await call('/components?id=' + encodeURIComponent('hub-fixture@local'));
const detail = response.json();
check('components returns skills', (detail.components?.skills ?? []).length === 2);
check('components returns ui surface', (detail.components?.uiSurfaces ?? []).length === 1);
check('components returns hook command', (detail.components?.hooks ?? []).some((hook) => hook.event === 'PreToolUse'));

// 5 -------------------------------------------------------- 全局作用域启停
response = await call('/enable', { method: 'POST', body: { id: 'hub-fixture@local', enabled: false, scope: 'user' } });
check('user disable applies', response.json()?.plugin?.enabled === false);
response = await call('/enable', { method: 'POST', body: { id: 'hub-fixture@local', enabled: true, scope: 'user' } });
check('user enable applies', response.json()?.plugin?.enabled === true);

// 6 ------------------------------------- 项目作用域 + 信任门（未信任整层忽略）
response = await call('/enable', { method: 'POST', body: { id: 'hub-fixture@local', enabled: false, scope: 'workspace', cwd: project } });
overview = (await call('/overview?cwd=' + encodeURIComponent(project))).json();
check('untrusted workspace override ignored', overview.effective.plugins[0]?.enabled === true && overview.effective.workspace.ignored === true);
const workspaceFile = join(project, '.dsh', 'plugins.json');
check('workspace file written', (await readJson(workspaceFile))?.enabledPlugins?.['hub-fixture@local'] === false);

response = await call('/trust', { method: 'POST', body: { cwd: project } });
check('trust accepted', response.status === 200 && response.json()?.trusted === true);
overview = (await call('/overview?cwd=' + encodeURIComponent(project))).json();
check('trusted workspace override applies', overview.effective.plugins[0]?.enabled === false && overview.effective.plugins[0]?.enabledSource === 'workspace');

// 7 ------------------------------------------------- 恢复继承（删 key 不写 sentinel）
response = await call('/enable', { method: 'POST', body: { id: 'hub-fixture@local', enabled: null, scope: 'workspace', cwd: project } });
overview = (await call('/overview?cwd=' + encodeURIComponent(project))).json();
check('restore inheritance re-enables', overview.effective.plugins[0]?.enabled === true && overview.effective.plugins[0]?.enabledSource === 'user');
const workspaceAfter = await readJson(workspaceFile);
check('override key removed', workspaceAfter?.enabledPlugins?.['hub-fixture@local'] === undefined);

// 8 ------------------------------------------------------------ options 合并
await call('/options', { method: 'POST', body: { id: 'hub-fixture@local', options: { label: 'global-label' }, scope: 'user' } });
await call('/options', { method: 'POST', body: { id: 'hub-fixture@local', options: { extra: 'project-only' }, scope: 'workspace', cwd: project } });
await call('/trust', { method: 'POST', body: { cwd: project } });
overview = (await call('/overview?cwd=' + encodeURIComponent(project))).json();
const merged = overview.effective.plugins[0]?.options ?? {};
check('options merged across scopes', merged.label === 'global-label' && merged.extra === 'project-only', JSON.stringify(merged));

// 9 ------------------------------------------------- 统一信任 + MCP 重名诊断
// 契约 §1：一次批准写 canonical 存储（<profileDir>/data/project-trust/trusted.json），
// 聚合 hash 逐字节按契约算；契约 §2：项目里与插件同名的 server 让位并进 overview.mcpConflicts。
const canonicalStorePath = join(profile, 'data', 'project-trust', 'trusted.json');
const projectMcpPath = join(project, '.dsh', 'mcp.json');
const trustKeyOf = (cwd) => {
  const slashed = cwd.replaceAll('\\', '/').replace(/\/+$/u, '');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
};
const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
await writeFile(
  projectMcpPath,
  `${JSON.stringify({ mcpServers: { fixture: { command: 'node', args: ['mcp/server.mjs'] } } }, null, 2)}\n`,
  'utf8',
);
response = await call('/trust', { method: 'POST', body: { cwd: project } });
check(
  'trust writes the shared canonical store',
  response.status === 200 && response.json()?.trusted === true && response.json()?.layers?.mcp === 'trusted',
  JSON.stringify(response.json()?.layers ?? null),
);

const canonical = await readJson(canonicalStorePath);
const canonicalRecord = canonical?.projects?.[trustKeyOf(project)] ?? null;
const mcpHash = sha256Bytes(await readFile(projectMcpPath));
const pluginsHash = sha256Bytes(await readFile(workspaceFile));
const expectedAggregate = sha256Bytes(Buffer.from(`dsh-project-trust/v1\nmcp:${mcpHash}\nplugins:${pluginsHash}`, 'utf8'));
check(
  'canonical record matches the aggregate-hash contract',
  canonical?.version === 1 &&
    canonicalRecord?.hash === expectedAggregate &&
    canonicalRecord?.files?.mcp === mcpHash &&
    canonicalRecord?.files?.plugins === pluginsHash &&
    typeof canonicalRecord?.approvedAt === 'string',
  JSON.stringify({ hash: canonicalRecord?.hash, expected: expectedAggregate }),
);

overview = (await call('/overview?cwd=' + encodeURIComponent(project))).json();
const firstConflicts = overview.mcpConflicts ?? [];
check(
  'overview trust layers show both files trusted',
  overview.trust?.layers?.mcp === 'trusted' &&
    overview.trust?.layers?.plugins === 'trusted' &&
    overview.trust?.layers?.shared === true &&
    overview.trust?.layers?.source === 'shared',
  JSON.stringify(overview.trust?.layers ?? null),
);
check(
  'overview reports the plugin-vs-project MCP conflict',
  firstConflicts.some((item) => item.pluginId === 'hub-fixture@local' && item.serverName === 'fixture' && item.source === 'project'),
  JSON.stringify(firstConflicts),
);
const conflictKeys = firstConflicts.map((item) => `${item.pluginId}\u0000${item.serverName}\u0000${item.source}`);
check('overview mcpConflicts are deduped', conflictKeys.length === new Set(conflictKeys).size, JSON.stringify(conflictKeys));

// 项目文件一改（等同 git pull），聚合 hash 不再命中：mcp 层回退为未信任，项目占用立即清空。
await writeFile(
  projectMcpPath,
  `${JSON.stringify({ mcpServers: { fixture: { command: 'node', args: ['mcp/other.mjs'] } } }, null, 2)}\n`,
  'utf8',
);
overview = (await call('/overview?cwd=' + encodeURIComponent(project))).json();
check(
  'untrusted mcp layer drops the project occupancy',
  overview.trust?.layers?.mcp === 'untrusted' &&
    overview.trust?.layers?.plugins === 'untrusted' &&
    (overview.mcpConflicts ?? []).length === 0,
  JSON.stringify({ layers: overview.trust?.layers ?? null, conflicts: overview.mcpConflicts ?? null }),
);

response = await call('/trust', { method: 'POST', body: { cwd: project } });
overview = (await call('/overview?cwd=' + encodeURIComponent(project))).json();
check(
  're-trusting after a change restores the trusted state',
  response.status === 200 &&
    overview.trust?.layers?.mcp === 'trusted' &&
    overview.trust?.layers?.plugins === 'trusted' &&
    (overview.mcpConflicts ?? []).length === 1,
  JSON.stringify(overview.mcpConflicts ?? null),
);

// 10 ---------------------------------------------------------------- 安全围栏
health.rejection = 403;
response = await call('/overview');
check('unauthenticated request refused', response.status === 403);
health.rejection = undefined;

response = await call('/overview', { method: 'POST', body: { anything: true } });
check('wrong method refused', response.status === 405);

response = await call('/install', { method: 'POST', contentType: 'text/plain', body: { source: { kind: 'directory', path: fixture } } });
check('non-JSON mutation refused', response.status === 415);

response = await call('/install', { method: 'POST', body: {} });
check('missing source refused', response.status === 400, String(response.json()?.error?.code));

response = await call('/install', { method: 'POST', body: { source: { kind: 'directory', path: join(root, 'nope') } } });
check('unreachable source refused', response.status === 502 || response.status === 422, String(response.json()?.error?.code));

// 11 -------------------------------------------------------- 版本历史与回滚
// 安装目录按 `<market>/<name>/<version>` 分桶；installed.json 只留当前记录。
// 旧版本目录必须能列出来（/versions）、能切回去（/switch），并在卸载时整桶清掉。
const fixtureV2 = await makeFixturePlugin(join(root, 'fixture-v2'), { version: '0.2.0' });
response = await call('/install', { method: 'POST', body: { source: { kind: 'directory', path: fixtureV2 } } });
check('install a second version', response.status === 200 && response.json()?.version === '0.2.0', String(response.json()?.version));

response = await call('/versions?id=' + encodeURIComponent('hub-fixture@local'));
const versionView = response.json();
check(
  'versions lists both cached versions',
  response.status === 200 &&
    versionView?.currentVersion === '0.2.0' &&
    (versionView?.versions ?? []).length === 2 &&
    versionView.versions.some((item) => item.version === '0.1.0') &&
    versionView.versions.some((item) => item.version === '0.2.0'),
  JSON.stringify((versionView?.versions ?? []).map((item) => item.version)),
);
check(
  'versions carry rootPath/sha256/mtime/current',
  (versionView?.versions ?? []).every(
    (item) =>
      typeof item.rootPath === 'string' &&
      typeof item.sha256 === 'string' &&
      item.sha256.length === 64 &&
      typeof item.mtime === 'string' &&
      typeof item.current === 'boolean',
  ) && (versionView?.versions ?? []).filter((item) => item.current === true).length === 1,
  JSON.stringify((versionView?.versions ?? []).map((item) => ({ version: item.version, current: item.current }))),
);

response = await call('/switch', { method: 'POST', body: { id: 'hub-fixture@local', version: '0.1.0' } });
check('switch to the older version', response.status === 200 && response.json()?.record?.version === '0.1.0', String(response.json()?.record?.version));
overview = (await call('/overview?cwd=' + encodeURIComponent(project))).json();
const switchedRecord = (overview.installed ?? []).find((item) => item.id === 'hub-fixture@local');
check(
  'switch keeps the user-scope enable flag',
  switchedRecord?.version === '0.1.0' && overview.user?.enabledPlugins?.['hub-fixture@local'] === true,
  JSON.stringify({ version: switchedRecord?.version, enabled: overview.user?.enabledPlugins?.['hub-fixture@local'] }),
);
check(
  'switch updates the effective root',
  String(switchedRecord?.rootPath ?? '').endsWith('0.1.0'),
  String(switchedRecord?.rootPath ?? ''),
);
check(
  'switch preserves installedAt',
  typeof installed?.installedAt === 'string' && switchedRecord?.installedAt === installed.installedAt,
  JSON.stringify({ before: installed?.installedAt, after: switchedRecord?.installedAt }),
);

response = await call('/switch', { method: 'POST', body: { id: 'hub-fixture@local', version: '9.9.9' } });
check('switch to an unknown version is 404', response.status === 404, String(response.json()?.error?.code));
response = await call('/versions?id=' + encodeURIComponent('missing@local'));
check('versions for an unknown plugin is 404', response.status === 404);

// 12 ---------------------------------------------------------------- 卸载
const beforeRemove = (await call('/overview')).json().installed[0];
response = await call('/uninstall', { method: 'POST', body: { id: 'hub-fixture@local' } });
check('uninstall ok', response.status === 200 && response.json()?.ok === true);
overview = (await call('/overview?cwd=' + encodeURIComponent(project))).json();
check('installed list empty after uninstall', overview.installed.length === 0);
check('cache directory removed', await missing(beforeRemove.rootPath));
check('uninstall removes every cached version', await missing(join(cacheRoot, 'local', 'hub-fixture')));

// 12b ------------------------------ 安装名 != 包内 manifest.name 时的版本列表
// installPlugin 允许调用方用 name 覆盖清单名（市场条目名也可能不同）；这种合法安装的
// 缓存桶仍然属于该插件，/versions 不能因为 manifest.name 不相等就返回空。
const renamedV1 = await makeFixturePlugin(join(root, 'renamed-v1'), { version: '1.0.0' });
const renamedV2 = await makeFixturePlugin(join(root, 'renamed-v2'), { version: '2.0.0' });
response = await call('/install', { method: 'POST', body: { source: { kind: 'directory', path: renamedV1 }, name: 'renamed-fixture' } });
check(
  'install accepts a caller-provided name',
  response.status === 200 && response.json()?.id === 'renamed-fixture@local' && response.json()?.name === 'renamed-fixture',
  JSON.stringify({ id: response.json()?.id, name: response.json()?.name }),
);
response = await call('/install', { method: 'POST', body: { source: { kind: 'directory', path: renamedV2 }, name: 'renamed-fixture' } });
check('install a second version under the renamed id', response.status === 200 && response.json()?.version === '2.0.0');
response = await call('/versions?id=' + encodeURIComponent('renamed-fixture@local'));
check(
  'versions accept an install name that differs from the manifest name',
  (response.json()?.versions ?? []).length === 2,
  JSON.stringify((response.json()?.versions ?? []).map((item) => item.version)),
);
response = await call('/switch', { method: 'POST', body: { id: 'renamed-fixture@local', version: '1.0.0' } });
check(
  'switch works when the install name differs from the manifest name',
  response.status === 200 && response.json()?.record?.version === '1.0.0',
  String(response.json()?.error?.code ?? response.json()?.record?.version),
);
await call('/uninstall', { method: 'POST', body: { id: 'renamed-fixture@local' } });
check('renamed plugin cache removed', await missing(join(cacheRoot, 'local', 'renamed-fixture')));

// 12c ------------------------- 卸载桶越界守卫（两层形状的 rootPath 不删兄弟目录）
// installed.json 是可直接编辑的普通 JSON：手工写成 cache/<market>/<name> 时，
// 只能删这个目录，不能把同一市场下其它插件一起删掉。
const installedPath = hubPaths(ctx).installed;
const installedData = (await readJson(installedPath)) ?? { version: 1, plugins: {} };
const guardRoot = join(cacheRoot, 'guard-market', 'guard-plugin');
const guardSibling = join(cacheRoot, 'guard-market', 'other-plugin');
await mkdir(guardRoot, { recursive: true });
await mkdir(guardSibling, { recursive: true });
await writeFile(join(guardSibling, 'keep.txt'), 'keep', 'utf8');
installedData.plugins['guard@guard-market'] = {
  id: 'guard@guard-market',
  name: 'guard',
  version: '0.1.0',
  marketplace: 'guard-market',
  rootPath: guardRoot,
  source: { kind: 'directory', path: guardRoot },
  sha256: '',
  format: 'zcode',
  installedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
await writeFile(installedPath, `${JSON.stringify(installedData, null, 2)}\n`, 'utf8');
response = await call('/uninstall', { method: 'POST', body: { id: 'guard@guard-market' } });
check(
  'uninstall only removes the record root for a two-level bucket',
  response.status === 200 && (await missing(guardRoot)) && !(await missing(guardSibling)),
  JSON.stringify({ rootGone: await missing(guardRoot), siblingGone: await missing(guardSibling) }),
);
await rm(join(cacheRoot, 'guard-market'), { recursive: true, force: true });

// 13 --------------------------------------------------------- 市场索引（本地）
const marketDir = join(root, 'market');
await mkdir(marketDir, { recursive: true });
await writeFixtureMarket(marketDir, fixture);
response = await call('/market/add', { method: 'POST', body: { id: 'fixture-market', source: { kind: 'directory', path: marketDir } } });
check('market added', response.status === 200 && response.json()?.pluginCount === 1, String(response.json()?.pluginCount));
response = await call('/market/entries', { method: 'POST', body: { id: 'fixture-market' } });
check('market entries listed', response.json()?.entries?.[0]?.name === 'hub-fixture');
response = await call('/install', { method: 'POST', body: { marketplace: 'fixture-market', name: 'hub-fixture' } });
check('install from marketplace', response.status === 200 && response.json()?.id === 'hub-fixture@fixture-market', String(response.json()?.id ?? response.json()?.error?.code));
response = await call('/market/refresh', { method: 'POST', body: { id: 'fixture-market' } });
check('market refresh ok', response.status === 200);

// 14 --------------------------------------- 添加市场（免 id / 元数据 / 聚合 / 移除）
const personalDir = join(root, 'personal-market');
await mkdir(personalDir, { recursive: true });
await writeFixtureMarket(personalDir, fixture, {
  name: 'personal-plugins',
  plugin: {
    name: 'personal-fixture',
    displayName_i18n: { 'zh-CN': '个人夹具' },
    description_i18n: { 'zh-CN': '带元数据的个人市场条目' },
    icon: 'https://example.com/icon.png',
    category: 'developer-tools',
    publisherType: 'community',
    componentTypes: ['skill', 'mcp', 'not-a-kind'],
    keywords: ['fixture', 'demo'],
    author: { name: 'plugin-hub' },
  },
});
response = await call('/market/add', { method: 'POST', body: { source: { kind: 'directory', path: personalDir } } });
check(
  'market add derives id from manifest name',
  response.status === 200 && response.json()?.marketplace?.id === 'personal-plugins',
  String(response.json()?.marketplace?.id ?? response.json()?.error?.code),
);
const personalEntry = response.json()?.entries?.[0] ?? null;
check(
  'market entries keep catalog metadata',
  personalEntry?.displayNameI18n?.['zh-CN'] === '个人夹具' &&
    personalEntry?.category === 'developer-tools' &&
    personalEntry?.publisherType === 'community' &&
    personalEntry?.icon === 'https://example.com/icon.png' &&
    JSON.stringify(personalEntry?.componentTypes) === JSON.stringify(['skill', 'mcp']) &&
    personalEntry?.author === 'plugin-hub',
  JSON.stringify(personalEntry?.componentTypes ?? null),
);
response = await call('/market/add', { method: 'POST', body: { source: { kind: 'directory', path: personalDir } } });
check('re-adding the same source is idempotent', response.json()?.marketplace?.id === 'personal-plugins');

response = await call('/market/entries', { method: 'POST', body: {} });
const aggregate = response.json() ?? {};
check(
  'market entries aggregate across marketplaces',
  aggregate.entries?.length === 2 && aggregate.entries.every((entry) => typeof entry.marketplace === 'string'),
  String(aggregate.entries?.length),
);
check(
  'aggregate entries mark installed per <name>@<marketplace>',
  aggregate.entries?.find((entry) => entry.id === 'hub-fixture@fixture-market')?.installed === true &&
    aggregate.entries?.find((entry) => entry.id === 'personal-fixture@personal-plugins')?.installed === false,
);

response = await call('/market/remove', { method: 'POST', body: { id: 'personal-plugins' } });
check('market removed', response.status === 200 && response.json()?.ok === true);
overview = (await call('/overview')).json();
check('removed market is gone from overview', !(overview.marketplaces ?? []).some((item) => item.id === 'personal-plugins'));
response = await call('/market/remove', { method: 'POST', body: { id: 'personal-plugins' } });
check('removing an unknown market is 404', response.status === 404);

// 15 --------------------------------------------- 市场索引新鲜度与抓取失败
const staleDir = join(root, 'stale-market');
await mkdir(staleDir, { recursive: true });
await writeFixtureMarket(staleDir, fixture, { name: 'stale-market' });
response = await call('/market/add', { method: 'POST', body: { source: { kind: 'directory', path: staleDir } } });
const freshSummary = response.json()?.marketplace ?? null;
check(
  'a fresh market reports fetchedAt and is not stale',
  typeof freshSummary?.fetchedAt === 'string' &&
    freshSummary?.ageSec !== null &&
    typeof freshSummary?.ageSec === 'number' &&
    freshSummary?.stale === false &&
    freshSummary?.lastError === null,
  JSON.stringify(freshSummary),
);

// 手工把成功抓取时间拨到 2 小时前：entries 应标记过期，并在后台刷新后清掉 lastError。
// 刷新只作用于同一个市场，不会影响下面「抓取失败」用例的独立市场。
const marketStorePath = join(hubPaths(ctx).root, 'marketplaces.json');
const marketStore = await readJson(marketStorePath);
marketStore.marketplaces['stale-market'].fetchedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
marketStore.marketplaces['stale-market'].lastError = 'previous failure';
await writeFile(marketStorePath, `${JSON.stringify(marketStore, null, 2)}\n`, 'utf8');
response = await call('/market/entries', { method: 'POST', body: { id: 'stale-market' } });
check(
  'a stale market is flagged with its last error',
  response.json()?.marketplace?.stale === true && response.json()?.marketplace?.lastError === 'previous failure',
  JSON.stringify(response.json()?.marketplace ?? null),
);
let refreshedRow = null;
for (let attempt = 0; attempt < 125; attempt += 1) {
  const row = (await readJson(marketStorePath))?.marketplaces?.['stale-market'];
  if (row?.lastError === null) {
    refreshedRow = row;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}
check(
  'a stale market is refreshed in the background',
  refreshedRow !== null && typeof refreshedRow.fetchedAt === 'string',
  JSON.stringify(refreshedRow ?? null),
);

// 另一个市场：索引文件被删掉 → 刷新失败。市场保留、旧条目还在，失败原因落盘。
const flakyDir = join(root, 'flaky-market');
await mkdir(flakyDir, { recursive: true });
await writeFixtureMarket(flakyDir, fixture, { name: 'flaky-market' });
response = await call('/market/add', { method: 'POST', body: { source: { kind: 'directory', path: flakyDir } } });
check('flaky market added', response.status === 200);
await rm(join(flakyDir, 'marketplace.json'), { force: true });
response = await call('/market/refresh', { method: 'POST', body: { id: 'flaky-market' } });
check('a failed refresh answers 422', response.status === 422, String(response.json()?.error?.code));
overview = (await call('/overview')).json();
const flaky = (overview.marketplaces ?? []).find((item) => item.id === 'flaky-market');
check(
  'refresh failure is persisted without dropping the market',
  flaky !== undefined && typeof flaky.lastError === 'string' && flaky.lastError !== '' && flaky.pluginCount === 1,
  JSON.stringify(flaky ?? null),
);
await call('/market/remove', { method: 'POST', body: { id: 'flaky-market' } });
await call('/market/remove', { method: 'POST', body: { id: 'stale-market' } });

// 16 ----------------------------- git 市场刷新失败时保留旧 checkout（回归）
// 以前 fetchMarketIndex 先 rm checkout 再 clone：clone 失败后 record.indexPath 已不存在，
// 页面从「旧索引可浏览」变成 entries=0。materialize 自带临时目录 + 原子替换，不该预删。
const gitBin = await findExecutable('git');
if (gitBin === null) {
  console.log('SKIP git market refresh regression — git not on PATH');
} else {
  const gitRepo = join(root, 'git-market-src');
  const gitPlugin = join(gitRepo, 'plugin');
  await mkdir(gitPlugin, { recursive: true });
  await writeFixtureMarket(gitRepo, gitPlugin, {
    name: 'git-market',
    plugin: { name: 'git-fixture', version: '0.1.0' },
  });
  await execFileAsync(gitBin, ['init'], { cwd: gitRepo });
  await execFileAsync(gitBin, ['add', '-A'], { cwd: gitRepo });
  await execFileAsync(
    gitBin,
    ['-c', 'user.email=smoke@example.com', '-c', 'user.name=smoke', '-c', 'commit.gpgsign=false', 'commit', '-m', 'init'],
    { cwd: gitRepo },
  );

  response = await call('/market/add', { method: 'POST', body: { source: { kind: 'git', url: gitRepo } } });
  const gitMarket = response.json()?.marketplace ?? null;
  check('git market added', response.status === 200 && gitMarket?.id === 'git-market', String(gitMarket?.id ?? response.json()?.error?.code));
  const gitIndexPath = typeof gitMarket?.indexPath === 'string' ? gitMarket.indexPath : '';
  check('git checkout exists after add', gitIndexPath !== '' && (await missing(gitIndexPath)) === false, gitIndexPath);

  // 源仓库消失 → clone 失败；旧 checkout 与索引必须原地保留。
  await rename(gitRepo, `${gitRepo}-moved`);
  response = await call('/market/refresh', { method: 'POST', body: { id: 'git-market' } });
  check('a failed git refresh is reported', response.status === 502 || response.status === 422, String(response.status));
  check('a failed git refresh keeps the old checkout', (await missing(gitIndexPath)) === false, gitIndexPath);
  response = await call('/market/entries', { method: 'POST', body: { id: 'git-market' } });
  check(
    'the old git index stays browsable after a failed refresh',
    response.status === 200 && response.json()?.error === null && (response.json()?.entries ?? []).length === 1,
    JSON.stringify({ error: response.json()?.error ?? null, entries: (response.json()?.entries ?? []).length }),
  );
  overview = (await call('/overview')).json();
  const gitRow = (overview.marketplaces ?? []).find((item) => item.id === 'git-market');
  check(
    'the git refresh failure is persisted',
    typeof gitRow?.lastError === 'string' && gitRow.lastError !== '',
    JSON.stringify(gitRow ?? null),
  );
  await call('/market/remove', { method: 'POST', body: { id: 'git-market' } });
}

disposeRoutes();
const failed = results.filter((item) => !item.ok);
console.log(`${'-'.repeat(72)}\n${results.length} cases: ${results.length - failed.length} passed, ${failed.length} failed`);
console.log(failed.length === 0 ? 'ALL PASS' : 'FAILED');
if (failed.length > 0) process.exitCode = 1;

// ------------------------------------------------------------------ helpers

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function missing(path) {
  try {
    await stat(path);
    return false;
  } catch {
    return true;
  }
}

/** 写一个最小 marketplace.json，条目指向本地 fixture 目录。 */
async function writeFixtureMarket(dir, pluginDir, options = {}) {
  const { writeFile } = await import('node:fs/promises');
  const { relative } = await import('node:path');
  const entry = {
    name: 'hub-fixture',
    description: 'Fixture plugin',
    version: '0.1.0',
    source: relative(dir, pluginDir).split('\\').join('/'),
    ...(options.plugin ?? {}),
  };
  await writeFile(
    join(dir, 'marketplace.json'),
    `${JSON.stringify(
      {
        name: options.name ?? 'fixture-market',
        owner: { name: 'plugin-hub' },
        plugins: [entry],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}
