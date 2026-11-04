/**
 * dsh-plugin-hub — HTTP API（前缀 `/plugin-hub/api`）。
 *
 * 页面只认这些路由，宿主侧不暴露别的写入口。每条 handler 的顺序固定：
 *   鉴权围栏 → 方法 →（mutation）JSON + 体积 → 参数校验 → 业务 → JSON 响应。
 *
 * 为什么用 `webServer.register` 而不是 typert remote：与 dsh-mcp-manager 同样的取舍——
 * remote 需要生成 host/client 两个 typert 工件并依赖 dsh-api-remotes，而这是同源页面，
 * 普通 fetch 足够，且不需要代码生成。
 *
 * 所有"写"都在最后由 `invalidateScopeCache()` 让下一次会话读到新配置。
 */

import { createHash } from 'node:crypto';
import { lstat, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { enumerateComponents } from './components.js';
import { hasPluginContent, manifestFromMarketEntry, readManifest, writeSynthesizedManifest } from './manifest.js';
import { parseMarketIndex, readLocalIndex, resolveMarketSource } from './market.js';
import { collectOccupancy, conflictsForPlugins } from './occupancy.js';
import { projectionConflicts, projectionErrors } from './projection/index.js';
import { materialize } from './sources.js';
import { invalidateScopeCache, summarizeEffective } from './scope.js';
import { effectivePlugins } from './scope.js';
import {
  ApiError,
  badRequest,
  notFound,
  readJsonBody,
  rejectUnauthorized,
  requireCwd,
  requireJson,
  requireMethod,
  sendError,
  sendJson,
} from './security.js';
import { trustProject, trustView } from './trust.js';
import {
  hubPaths,
  listCachedVersions,
  mutateInstalled,
  mutateMarketplaces,
  mutateUser,
  mutateWorkspace,
  readInstalled,
  readMarketplaces,
  readUser,
  readWorkspace,
  removeWorkspaceKeys,
  workspaceConfigPath,
} from './store.js';
import { ensureDir, isInside, nowIso, sha256Text, stableHash, warn } from './util.js';

/** 路由前缀，客户端与本文件必须一致。 */
export const BASE = '/plugin-hub/api';

/** 索引 TTL：超过 1 小时视为过期，浏览市场时后台刷新一次（失败只记 lastError）。 */
const MARKET_TTL_SEC = 60 * 60;

/** 自动刷新失败后的退避：10 分钟内不再为同一个市场重排后台抓取。 */
const MARKET_RETRY_COOLDOWN_MS = 10 * 60 * 1000;

/** 正在后台刷新的市场 id：单飞去重，避免每次打开市场页都重新克隆一遍仓库。 */
const refreshingMarkets = new Set();

/** 全局写锁：安装/卸载同时只允许一个（cache 目录与 installed.json 是一致性单元）。 */
let mutationChain = Promise.resolve();

function serialize(operation) {
  const next = mutationChain.catch(() => {}).then(operation);
  mutationChain = next.then(
    () => {},
    () => {},
  );
  return next;
}

/**
 * 注册全部路由。
 *
 * @param {object} ctx 插件上下文（需要 webServer）
 * @returns {() => void} disposer
 */
export function mountRoutes(ctx) {
  const disposers = [];
  const mount = (path, handler) => {
    disposers.push(ctx.webServer.register({ kind: 'exact', path: `${BASE}${path}`, handler }));
  };

  /** 读路由：鉴权 → GET/HEAD。 */
  const readRoute = (handler) => async (request, response) => {
    if (rejectUnauthorized(ctx, request, response)) return;
    if (!requireMethod(request, response, 'GET')) return;
    try {
      await handler(request, response);
    } catch (error) {
      sendError(response, error);
    }
  };

  /** 写路由：鉴权 → POST → JSON → 有界 body。 */
  const mutateRoute = (handler) => async (request, response) => {
    if (rejectUnauthorized(ctx, request, response)) return;
    if (!requireMethod(request, response, 'POST')) return;
    if (!requireJson(request, response)) return;
    try {
      const body = await readJsonBody(request);
      await handler(body ?? {}, request, response);
    } catch (error) {
      sendError(response, error);
    }
  };

  // ------------------------------------------------------- GET /current-workspace
  // 页面不知道"当前项目"是哪个目录：取最新一个 live Agent 的工作目录作为项目作用域默认值。
  // 失败（没有 live agent）返回 cwd:null，页面据此禁用项目作用域而不是猜路径。
  mount(
    '/current-workspace',
    readRoute(async (_request, response) => {
      let cwd = null;
      try {
        const agents = ctx.agents?.list?.() ?? [];
        for (let index = agents.length - 1; index >= 0; index -= 1) {
          const agent = agents[index];
          if (agent?.session === undefined || agent.session === null) continue;
          const value = ctx.workingDirectory.get(agent.session);
          if (typeof value === 'string' && value !== '') {
            cwd = value;
            break;
          }
        }
      } catch {
        cwd = null;
      }
      sendJson(response, 200, { cwd });
    }),
  );

  // ------------------------------------------------------------ GET /overview
  mount(
    '/overview',
    readRoute(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const cwd = url.searchParams.get('cwd') ?? undefined;
      const paths = hubPaths(ctx);
      const installed = await readInstalled(ctx);
      const marketplaces = await readMarketplaces(ctx);
      const user = await readUser(ctx);
      const workspace = cwd ? await readWorkspace(cwd) : null;
      const effective = await effectivePlugins(ctx, cwd);
      const trust = cwd ? await trustView(ctx, cwd) : null;
      const mcpConflicts = await mcpConflictView(ctx, cwd, effective);
      sendJson(response, 200, {
        hubRoot: paths.root,
        installed: Object.values(installed.plugins),
        // 市场也走 summary：页面据此显示「索引过期 / 上次抓取失败」，不需要自己算 age。
        marketplaces: Object.values(marketplaces.marketplaces).map((record) => summarizeMarket(record)),
        user,
        workspace: workspace
          ? {
              path: workspace.path,
              exists: workspace.exists,
              hash: workspace.hash,
              error: workspace.error,
              config: workspace.data,
            }
          : null,
        trust,
        // MCP 重名：投影运行时跳过过的 + 按当前生效插件 dry-run 出来的，按 cwd 去重。
        // 页面在没有 live Agent 时也要能看到冲突（装完插件还没开会话是常见状态）。
        mcpConflicts,
        // 运行期挂载失败（每插件每能力最近一条）：页面用它显示红点/诊断，而不是只留 console.warn。
        projectionErrors: projectionErrors(cwd),
        effective: summarizeEffective(effective),
      });
    }),
  );

  // ---------------------------------------------------------- GET /components
  mount(
    '/components',
    readRoute(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const id = url.searchParams.get('id');
      if (typeof id !== 'string' || id === '') throw badRequest('"id" is required');
      const record = await findInstalled(ctx, id);
      const manifestResult = await readManifest(record.rootPath);
      if (!manifestResult.ok) throw new ApiError('manifest-invalid', manifestResult.message);
      const components = await enumerateComponents(record.rootPath, manifestResult.manifest);
      sendJson(response, 200, {
        id,
        manifest: manifestResult.manifest,
        manifestPath: manifestResult.manifestPath,
        format: record.format ?? manifestResult.format,
        components,
      });
    }),
  );

  // ------------------------------------------------------------ POST /market/add
  // 只收一个 source（与 ZCode 的「添加插件市场」一致：GitHub 仓库 / Git URL /
  // marketplace.json URL / 本地目录）。id 可以由调用方显式给出（脚本与旧调用兼容），
  // 否则依次退回 清单 name → 来源名；同来源重复添加是幂等刷新，不同来源撞 id 才加序号。
  mount(
    '/market/add',
    mutateRoute(async (body, _request, response) => {
      const source = normalizeMarketSourceInput(body.source);
      const explicitId = body.id === undefined || body.id === null || body.id === ''
        ? null
        : normalizeMarketId(body.id);
      const existing = await readMarketplaces(ctx);
      let fetched;
      try {
        fetched = await fetchMarketIndex(ctx, { source });
      } catch (error) {
        // 重复添加同一个来源等于刷新：失败时把错误写在旧记录上，页面才能显示「上次失败」。
        await rememberMarketFailure(ctx, { source }, error);
        throw error;
      }
      const id = uniqueMarketId(existing.marketplaces, explicitId, fetched.name, source);
      const record = {
        id,
        source,
        name: fetched.name ?? id,
        description: fetched.description,
        lastUpdated: nowIso(),
        // fetchedAt 是「成功抓取」的时间；lastUpdated 在旧记录里可能来自市场清单自身。
        fetchedAt: nowIso(),
        lastError: null,
        lastErrorAt: null,
        pluginCount: fetched.pluginCount,
        indexPath: fetched.indexPath,
      };
      await mutateMarketplaces(ctx, (current) => {
        current.marketplaces[id] = record;
        return current;
      });
      invalidateScopeCache();
      sendJson(response, 200, await entriesPayload(ctx, id));
    }),
  );

  // --------------------------------------------------------- POST /market/remove
  // 只删登记与本地缓存副本；目录来源的用户文件一个都不动（那是用户自己的仓库）。
  mount(
    '/market/remove',
    mutateRoute(async (body, _request, response) => {
      const id = normalizeMarketId(body.id);
      const marketplaces = await readMarketplaces(ctx);
      const record = marketplaces.marketplaces[id];
      if (record === undefined) throw notFound(`unknown marketplace "${id}"`);
      await dropMarketCache(ctx, record.source).catch((error) => {
        warn(`marketplace cache cleanup failed for ${id}: ${error?.message ?? error}`);
      });
      await mutateMarketplaces(ctx, (current) => {
        delete current.marketplaces[id];
        return current;
      });
      invalidateScopeCache();
      sendJson(response, 200, { ok: true, id });
    }),
  );

  // -------------------------------------------------------- POST /market/refresh
  mount(
    '/market/refresh',
    mutateRoute(async (body, _request, response) => {
      const id = normalizeMarketId(body.id);
      const marketplaces = await readMarketplaces(ctx);
      const existing = marketplaces.marketplaces[id];
      if (existing === undefined) throw notFound(`unknown marketplace "${id}"`);
      let fetched;
      try {
        fetched = await fetchMarketIndex(ctx, { source: existing.source });
      } catch (error) {
        // 刷新失败不清空旧条目：lastError 落盘，旧的 indexPath 还能继续浏览。
        await rememberMarketFailure(ctx, { id }, error);
        throw error;
      }
      const record = {
        ...existing,
        name: fetched.name ?? existing.name,
        description: fetched.description ?? existing.description,
        lastUpdated: nowIso(),
        fetchedAt: nowIso(),
        lastError: null,
        lastErrorAt: null,
        pluginCount: fetched.pluginCount,
        indexPath: fetched.indexPath,
      };
      await mutateMarketplaces(ctx, (current) => {
        current.marketplaces[id] = record;
        return current;
      });
      invalidateScopeCache();
      sendJson(response, 200, await entriesPayload(ctx, id));
    }),
  );

  // -------------------------------------------------------- POST /market/entries
  // 不传 id = 聚合全部市场（商店「全部」视图）；传 id = 单个市场。
  // 单个市场读不出来时返回 error 而不是 500：一个坏市场不该让整个商店打不开。
  mount(
    '/market/entries',
    mutateRoute(async (body, _request, response) => {
      const rawId = typeof body.id === 'string' ? body.id.trim() : '';
      if (rawId === '') {
        const marketplaces = await readMarketplaces(ctx);
        const installed = await readInstalled(ctx);
        const index = indexInstalled(installed);
        const entries = [];
        const errors = [];
        const diagnostics = [];
        const summaries = [];
        for (const record of Object.values(marketplaces.marketplaces)) {
          const view = await readMarketView(record);
          summaries.push(summarizeMarket(record, view.entries));
          if (view.error !== null) {
            errors.push({ marketplace: record.id, message: view.error });
            continue;
          }
          for (const item of view.diagnostics ?? []) diagnostics.push({ ...item, marketplace: record.id });
          for (const entry of view.entries) entries.push(entryView(entry, record.id, index));
        }
        // 过期市场在后台刷新一次；本次仍返回缓存内容，刷新结果由下一次轮询/打开页面看到。
        for (const summary of summaries) {
          if (summary.stale === true) scheduleMarketRefresh(ctx, summary.id);
        }
        sendJson(response, 200, { marketplace: null, marketplaces: summaries, entries, errors, diagnostics });
        return;
      }
      const id = normalizeMarketId(rawId);
      const payload = await entriesPayload(ctx, id);
      if (payload.marketplace?.stale === true) scheduleMarketRefresh(ctx, id);
      sendJson(response, 200, payload);
    }),
  );

  // --------------------------------------------------------------- POST /install
  mount(
    '/install',
    mutateRoute(async (body, _request, response) => {
      const result = await serialize(() => installPlugin(ctx, body));
      invalidateScopeCache();
      sendJson(response, 200, result);
    }),
  );

  // ------------------------------------------------------------- POST /uninstall
  mount(
    '/uninstall',
    mutateRoute(async (body, _request, response) => {
      const id = typeof body.id === 'string' ? body.id : '';
      if (id === '') throw badRequest('"id" is required');
      const result = await serialize(async () => {
        const record = await findInstalled(ctx, id);
        const paths = hubPaths(ctx);
        if (isInside(paths.cacheRoot, record.rootPath)) {
          // 缓存按 `<market>/<name>/<version>` 分桶：记录只指向当前版本，但旧版本目录
          // 是为回滚保留的。卸载要删整个桶，否则这些目录既不能回滚也无法再被清理。
          // 只认「cacheRoot 下恰好两层」的桶：手工编辑过的 installed.json 若把 rootPath
          // 写成两层形状，退化为只删该目录，不能连累同一个市场里的其它插件。
          const bucket = dirname(record.rootPath);
          const bucketDepth = relative(paths.cacheRoot, bucket).split(/[\\/]+/).filter(Boolean).length;
          const target = isInside(paths.cacheRoot, bucket) && bucketDepth === 2 ? bucket : record.rootPath;
          await rm(target, { recursive: true, force: true });
        } else {
          warn(`refusing to delete ${record.rootPath}: outside the plugin cache`);
        }
        await mutateInstalled(ctx, (current) => {
          delete current.plugins[id];
          return current;
        });
        return { ok: true, id };
      });
      invalidateScopeCache();
      sendJson(response, 200, result);
    }),
  );

  // -------------------------------------------------------------- GET /versions
  // 缓存里按版本分桶保留下来的全部版本；`current` 是 installed.json 正在用的那个。
  mount(
    '/versions',
    readRoute(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const id = url.searchParams.get('id');
      if (typeof id !== 'string' || id === '') throw badRequest('"id" is required');
      const record = await findInstalled(ctx, id);
      sendJson(response, 200, {
        id,
        currentVersion: typeof record.version === 'string' ? record.version : null,
        versions: await listCachedVersions(ctx, record),
      });
    }),
  );

  // ---------------------------------------------------------------- POST /switch
  // 切到缓存里已有的另一个版本：只改 installed.json 的 rootPath/version/sha256，
  // 不碰 user/workspace 的启用状态。下一次 agent/pre-step 因签名（rootPath+sha256）
  // 变化自动重挂，不需要宿主 HMR，也不走包管理器。
  mount(
    '/switch',
    mutateRoute(async (body, _request, response) => {
      const id = typeof body.id === 'string' ? body.id : '';
      const version = typeof body.version === 'string' ? body.version.trim() : '';
      if (id === '') throw badRequest('"id" is required');
      if (version === '') throw badRequest('"version" is required');
      const result = await serialize(async () => {
        const record = await findInstalled(ctx, id);
        const target = (await listCachedVersions(ctx, record)).find((item) => item.version === version);
        if (target === undefined) throw notFound(`plugin "${id}" has no cached version "${version}"`);
        const next = {
          ...record,
          version: target.version,
          rootPath: target.rootPath,
          sha256: target.sha256,
          // format 是安装来源的标记（synthesized = 市场条目合成）；切换版本不改写它，
          // 否则回滚一次就会把「市场条目」显示成「Claude 插件」。
          format: record.format ?? target.format ?? null,
          updatedAt: nowIso(),
        };
        await mutateInstalled(ctx, (current) => {
          const previous = current.plugins[id];
          if (previous === undefined) throw notFound(`unknown plugin "${id}"`);
          // installedAt 指首次安装时间，换版本不重置。
          next.installedAt = previous.installedAt ?? next.installedAt;
          current.plugins[id] = next;
          return current;
        });
        return { ok: true, id, record: next };
      });
      invalidateScopeCache();
      sendJson(response, 200, result);
    }),
  );

  // ---------------------------------------------------------------- POST /enable
  mount(
    '/enable',
    mutateRoute(async (body, _request, response) => {
      const id = typeof body.id === 'string' ? body.id : '';
      if (id === '') throw badRequest('"id" is required');
      const scope = body.scope === 'workspace' ? 'workspace' : 'user';
      // `enabled: null` 在 workspace 作用域表示"删除覆盖，恢复继承"。
      if (body.enabled !== null && typeof body.enabled !== 'boolean') {
        throw badRequest('"enabled" must be a boolean or null');
      }
      if (scope === 'user') {
        if (typeof body.enabled !== 'boolean') throw badRequest('user scope requires a boolean "enabled"');
        await mutateUser(ctx, (current) => {
          current.enabledPlugins[id] = body.enabled;
          return current;
        });
      } else {
        const cwd = requireCwd(body.cwd);
        await mutateWorkspace(cwd, (current) => {
          if (body.enabled === null) {
            current.enabledPlugins = omitKey(current.enabledPlugins, id);
          } else {
            current.enabledPlugins[id] = body.enabled;
          }
          return current;
        });
      }
      invalidateScopeCache();
      sendJson(response, 200, await enableResult(ctx, body.cwd, id));
    }),
  );

  // --------------------------------------------------------------- POST /options
  mount(
    '/options',
    mutateRoute(async (body, _request, response) => {
      const id = typeof body.id === 'string' ? body.id : '';
      if (id === '') throw badRequest('"id" is required');
      const options = normalizeOptions(body.options);
      const scope = body.scope === 'workspace' ? 'workspace' : 'user';
      if (scope === 'user') {
        await mutateUser(ctx, (current) => {
          current.options[id] = options;
          return current;
        });
      } else {
        const cwd = requireCwd(body.cwd);
        await mutateWorkspace(cwd, (current) => {
          current.options = { ...current.options, [id]: options };
          return current;
        });
      }
      invalidateScopeCache();
      sendJson(response, 200, await enableResult(ctx, body.cwd, id));
    }),
  );

  // ----------------------------------------------------------------- POST /trust
  mount(
    '/trust',
    mutateRoute(async (body, _request, response) => {
      const cwd = requireCwd(body.cwd);
      const result = await trustProject(ctx, cwd);
      invalidateScopeCache();
      sendJson(response, 200, result);
    }),
  );

  // -------------------------------------------------------------- POST /reload
  mount(
    '/reload',
    mutateRoute(async (_body, _request, response) => {
      invalidateScopeCache();
      sendJson(response, 200, { ok: true });
    }),
  );

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose?.();
      } catch {
        /* 单个失败不影响其它路由卸载 */
      }
    }
  };
}

// ---------------------------------------------------------------- overview helpers

/**
 * overview 的 MCP 重名视图（契约 §2）。
 *
 * 两路合并、按 `<pluginId>\0<serverName>\0<source>` 去重：
 *   1. `projectionConflicts(cwd)` —— 投影运行时真的让位过的条目（权威）；
 *   2. `conflictsForPlugins(...)` —— 用当前生效插件 + 实时占用表算出的 dry-run，
 *      覆盖「装完插件还没开过会话」/「全局服务器刚连上」这些运行时还没跑到的时刻。
 *
 * 占用表读取失败只会让 dry-run 变空（运行时那一路仍在），不会让 overview 500。
 *
 * @param {object} ctx
 * @param {string|undefined} cwd
 * @param {object} effective - effectivePlugins 的返回值
 * @returns {Promise<Array<{ cwd?: string, pluginId: string, serverName: string, source: string }>>}
 */
async function mcpConflictView(ctx, cwd, effective) {
  const recorded = projectionConflicts(cwd);
  let computed = [];
  try {
    const occupancy = await collectOccupancy(ctx, cwd);
    computed = conflictsForPlugins(occupancy, effective?.plugins ?? []);
  } catch (error) {
    warn(`overview: cannot compute the MCP occupancy: ${error?.message ?? error}`);
  }
  const seen = new Set();
  const out = [];
  for (const item of [...recorded, ...computed]) {
    if (item === null || typeof item !== 'object') continue;
    if (typeof item.pluginId !== 'string' || typeof item.serverName !== 'string') continue;
    const source = item.source === 'project' ? 'project' : 'global';
    const key = `${item.pluginId}\u0000${item.serverName}\u0000${source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...(typeof item.cwd === 'string' && item.cwd !== '' ? { cwd: item.cwd } : {}),
      pluginId: item.pluginId,
      serverName: item.serverName,
      source,
    });
  }
  out.sort((left, right) => {
    const a = `${left.pluginId}\u0000${left.serverName}\u0000${left.source}`;
    const b = `${right.pluginId}\u0000${right.serverName}\u0000${right.source}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return out;
}

// ---------------------------------------------------------------- install

/**
 * 安装一个插件。
 *
 * 两种入参：
 *   { marketplace, name } —— 从市场索引解析来源
 *   { source, name? }     —— 直接给来源（页面"从本地目录/Git 安装"）
 */
async function installPlugin(ctx, body) {
  const paths = await ensureHubDir(ctx);
  let source;
  let marketplace = 'local';
  let expectedName = typeof body.name === 'string' && body.name !== '' ? body.name : null;
  let marketEntry = null;

  if (typeof body.marketplace === 'string' && body.marketplace !== '') {
    marketplace = body.marketplace;
    const marketplaces = await readMarketplaces(ctx);
    const record = marketplaces.marketplaces[marketplace];
    if (record === undefined) throw notFound(`unknown marketplace "${marketplace}"`);
    const view = await readMarketView(record);
    if (view.error !== null) throw new ApiError('market-index-unreadable', view.error);
    const entry = view.entries.find((item) => item.name === expectedName);
    if (entry === undefined) throw notFound(`marketplace "${marketplace}" has no plugin "${expectedName}"`);
    source = resolveMarketSource(entry, record);
    expectedName = entry.name;
    marketEntry = entry;
  } else if (body.source !== undefined) {
    source = normalizeInstallSource(body.source);
  } else {
    throw badRequest('provide either "marketplace"+"name" or "source"');
  }

  // 先物化到临时目录，验证清单通过后再挪进最终版本目录：失败不会留下"半个插件"。
  const staging = join(paths.cacheRoot, '.staging', `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await ensureDir(staging);
  let rootPath;
  let sha256;
  try {
    const materialized = await materialize({ source, destDir: staging, log: warn });
    rootPath = materialized.rootPath;
    sha256 = materialized.sha256;
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  const manifestResult = await readManifest(rootPath);
  let manifest = manifestResult.ok ? manifestResult.manifest : null;
  let format = manifestResult.ok ? manifestResult.format : null;

  // Claude 目录里有一部分条目把清单语义写在 marketplace.json（strict:false 的语言服务器插件），
  // 仓库里根本没有 plugin.json。这种情况按「市场条目即清单」合成，否则这些插件永远装不上。
  if (manifest === null && marketEntry !== null) {
    const synthesized = manifestFromMarketEntry(marketEntry);
    if (synthesized !== null && (synthesized.lspServers !== undefined || await hasPluginContent(rootPath))) {
      manifest = synthesized;
      format = 'synthesized';
      // 落到包里：组件路由与投影层都按 readManifest 读，不能只存在 installed 记录里。
      await writeSynthesizedManifest(rootPath, manifest);
    }
  }

  if (manifest === null) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw new ApiError(
      'source-invalid',
      `the package has no usable plugin manifest: ${manifestResult.message}`,
    );
  }
  const name = expectedName ?? manifest.name;
  const version = manifest.version ?? '0.0.0';
  const finalDir = join(paths.cacheRoot, marketplace, sanitizeSegment(name), sanitizeSegment(version));
  await rm(finalDir, { recursive: true, force: true });

  // 原子替换：暂存目录 rename 到最终位置。Windows 上 rename 到已存在目录会失败，
  // 所以先删旧目录、不预建目标目；跨盘/挂载点失败时退回复制（功能等价，只是多一次全量写）。
  const { rename, cp } = await import('node:fs/promises');
  try {
    await ensureDir(dirname(finalDir));
    await rename(rootPath, finalDir);
  } catch {
    await ensureDir(dirname(finalDir));
    await cp(rootPath, finalDir, { recursive: true, force: true });
  }
  await rm(staging, { recursive: true, force: true }).catch(() => {});

  const id = `${name}@${marketplace}`;
  const record = {
    id,
    name,
    version,
    marketplace,
    rootPath: finalDir,
    source,
    sha256,
    format,
    installedAt: nowIso(),
    updatedAt: nowIso(),
  };
  await mutateInstalled(ctx, (current) => {
    const previous = current.plugins[id];
    if (previous !== undefined) record.installedAt = previous.installedAt ?? record.installedAt;
    current.plugins[id] = record;
    return current;
  });

  // 新安装默认在全局启用（与 ZCode 一致）；项目层不动。
  await mutateUser(ctx, (current) => {
    if (current.enabledPlugins[id] === undefined) current.enabledPlugins[id] = true;
    return current;
  });

  return {
    ...record,
    components: await enumerateComponents(finalDir, manifest).then((value) =>
      (value.groups ?? []).map((group) => ({ kind: group.kind, count: group.items.length })),
    ),
  };
}

// ---------------------------------------------------------------- market fetch

/**
 * 取一次市场索引并缓存到本地。
 *
 * 缓存路径只由**来源**决定（`marketCacheKey`），与市场 id 解耦：id 可以是清单里的 name
 * （添加前才知道），不必为了改名而搬目录。
 *
 *   - 目录来源：直接读工作副本里的 marketplace.json，不复制（用户可能在编辑自己的仓库）。
 *   - Git / GitHub 来源：浅克隆到 `cache/.markets/<key>/`，再读根或 `.claude-plugin/` 下的清单。
 *   - URL 来源：把 JSON 落到 `indexes/<key>.json`，让刷新与安装离线也能工作。
 *
 * @returns {Promise<{name?: string, description?: string, pluginCount: number, indexPath: string,
 *   diagnostics: Array<{code: string, message: string, path?: string}>}>}
 */
async function fetchMarketIndex(ctx, { source }) {
  const paths = await ensureHubDir(ctx);
  const key = marketCacheKey(source);

  if (source.kind === 'directory') {
    const base = source.path;
    const candidates = [
      join(base, 'marketplace.json'),
      join(base, '.claude-plugin', 'marketplace.json'),
      join(base, '.zcode-plugin', 'marketplace.json'),
    ];
    const indexPath = await firstExisting(candidates);
    if (indexPath === null) throw new ApiError('source-invalid', `no marketplace.json under ${base}`);
    const parsed = parseMarketIndex(await readFile(indexPath, 'utf8'), { indexPath });
    return toFetched(parsed, indexPath);
  }

  if (source.kind === 'git' || source.kind === 'github') {
    const checkout = join(paths.cacheRoot, '.markets', key);
    const url = source.kind === 'github' ? `https://github.com/${source.repo}.git` : source.url;
    // 不要先删 checkout：materialize 自己会「同级临时目录准备 → 成功后原子替换」。
    // 先删会让 clone 失败（网络/仓库消失）时连旧索引一起丢掉，而页面仍指着旧记录。
    await materialize({ source: { kind: 'git', url, ref: source.ref }, destDir: checkout, log: warn });
    const candidates = [join(checkout, 'marketplace.json'), join(checkout, '.claude-plugin', 'marketplace.json')];
    const indexPath = await firstExisting(candidates);
    if (indexPath === null) throw new ApiError('source-invalid', 'cloned repository has no marketplace.json');
    const parsed = parseMarketIndex(await readFile(indexPath, 'utf8'), { indexPath });
    return toFetched(parsed, indexPath);
  }

  if (source.kind === 'url') {
    const target = join(paths.root, 'indexes', `${key}.json`);
    const text = await fetchText(source.url);
    await ensureDir(join(paths.root, 'indexes'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(target, text, 'utf8');
    const parsed = parseMarketIndex(text, { indexPath: target });
    return toFetched(parsed, target);
  }

  throw badRequest(`unsupported marketplace source kind "${source.kind}"`);
}

function toFetched(parsed, indexPath) {
  return {
    name: parsed.name,
    description: parsed.description,
    pluginCount: parsed.plugins.length,
    indexPath,
    diagnostics: parsed.diagnostics ?? [],
  };
}

/** 缓存键：来源的稳定指纹（目录路径按平台归一，Windows 大小写不敏感）。 */
function marketCacheKey(source) {
  const canonical = JSON.stringify({
    kind: source.kind,
    path: source.kind === 'directory'
      ? resolve(source.path).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
      : undefined,
    url: source.url,
    repo: source.repo,
    ref: source.ref,
  });
  return createHash('sha1').update(canonical).digest('hex').slice(0, 16);
}

/** 删除一个市场的本地缓存副本；目录来源无处可删（那是用户自己的工作副本）。 */
async function dropMarketCache(ctx, source) {
  if (source?.kind === 'directory') return;
  const paths = await ensureHubDir(ctx);
  const key = marketCacheKey(source);
  if (source.kind === 'url') {
    await rm(join(paths.root, 'indexes', `${key}.json`), { force: true });
    return;
  }
  await rm(join(paths.cacheRoot, '.markets', key), { recursive: true, force: true });
}

/** 一个市场的条目视图：读不出来不算异常，带上 error 让 UI 显示「刷新失败」。 */
async function readMarketView(record) {
  try {
    const parsed = await readLocalIndex(record);
    const entries = await annotateLocalEntries(parsed.plugins, record);
    return { entries, diagnostics: parsed.diagnostics ?? [], error: null };
  } catch (error) {
    return { entries: [], diagnostics: [], error: String(error?.message ?? error) };
  }
}

// ------------------------------------------------- 条目本地元数据（组件类型 / 格式）

/** 本地条目的探测结果缓存：`<indexPath>::<name>` → { stamp, patch }。 */
const localEntryCache = new Map();
const MAX_LOCAL_ENTRY_CACHE = 4000;

/** 展示顺序（与 components.buildGroups 一致）。 */
const COMPONENT_TYPE_ORDER = ['agent', 'command', 'skill', 'hook', 'mcp', 'lsp'];
const COMPONENT_TYPE_BUCKETS = {
  agent: 'agents',
  command: 'commands',
  skill: 'skills',
  hook: 'hooks',
  mcp: 'mcpServers',
  lsp: 'lspServers',
};

/**
 * 给「来源已经在本地」的条目补 format / componentTypes。
 *
 * 相对路径条目和目录源本来就躺在市场 checkout 里，读一次 plugin.json + 组件目录就能把
 * 卡片上的组件类型显示出来；远程条目（git-subdir / url）保持索引给到什么显示什么，
 * 不能为了展示去克隆 300 个仓库。
 */
async function annotateLocalEntries(entries, record) {
  const indexPath = typeof record?.indexPath === 'string' ? record.indexPath : '';
  if (indexPath === '') return entries;

  let stamp;
  try {
    const info = await lstat(indexPath);
    stamp = `${info.mtimeMs}:${info.size}`;
  } catch {
    return entries;
  }

  const out = [];
  for (const entry of entries) {
    const key = `${indexPath}::${entry.name}`;
    const cached = localEntryCache.get(key);
    if (cached !== undefined && cached.stamp === stamp) {
      out.push({ ...entry, ...cached.patch });
      continue;
    }
    let patch = {};
    try {
      patch = await inspectLocalEntry(entry, record);
    } catch {
      patch = {};
    }
    if (localEntryCache.size > MAX_LOCAL_ENTRY_CACHE) localEntryCache.clear();
    localEntryCache.set(key, { stamp, patch });
    out.push({ ...entry, ...patch });
  }
  return out;
}

/** 探测单个条目：来源是本地目录且能读出清单时，返回 { format, componentTypes }。 */
async function inspectLocalEntry(entry, record) {
  let source;
  try {
    source = resolveMarketSource(entry, record);
  } catch {
    return {};
  }
  if (source?.kind !== 'directory') return {};

  const info = await lstat(source.path).catch(() => null);
  if (info === null || !info.isDirectory()) return {};

  const manifestResult = await readManifest(source.path);
  const components = await enumerateComponents(
    source.path,
    manifestResult.ok ? manifestResult.manifest : null,
  );

  const detected = [];
  for (const kind of COMPONENT_TYPE_ORDER) {
    const bucket = components[COMPONENT_TYPE_BUCKETS[kind]];
    const count = Array.isArray(bucket) ? bucket.length : Object.keys(bucket ?? {}).length;
    if (count > 0) detected.push(kind);
  }

  const patch = {};
  if (manifestResult.ok) patch.format = manifestResult.format;
  // 目录里声明的 componentTypes 优先（catalog 是契约）；只有索引没写时才用探测结果补。
  // Claude 目录基本都不写，所以这一条正是让卡片显示组件类型的地方。
  const declared = Array.isArray(entry.componentTypes) ? entry.componentTypes : [];
  const componentTypes = declared.length > 0 ? declared : detected;
  if (componentTypes.length > 0) patch.componentTypes = componentTypes;
  return patch;
}

/** 单市场响应体（添加/刷新/单市场浏览共用）。 */
async function entriesPayload(ctx, id) {
  const marketplaces = await readMarketplaces(ctx);
  const record = marketplaces.marketplaces[id];
  if (record === undefined) throw notFound(`unknown marketplace "${id}"`);
  const installed = await readInstalled(ctx);
  const index = indexInstalled(installed);
  const view = await readMarketView(record);
  const summary = summarizeMarket(record, view.entries);
  return {
    // 顶层同时摊平 summary 字段，兼容 v0.1 调用方（`json().pluginCount`）。
    ...summary,
    marketplace: summary,
    entries: view.entries.map((entry) => entryView(entry, id, index)),
    diagnostics: view.diagnostics,
    error: view.error,
  };
}

/** 已安装索引：按 `<name>@<marketplace>` 命中；只有身份不含市场的旧记录才按 name 兜底。 */
function indexInstalled(installed) {
  const byId = new Map();
  const byName = new Map();
  for (const record of Object.values(installed.plugins ?? {})) {
    if (record === null || typeof record !== 'object' || typeof record.id !== 'string') continue;
    byId.set(record.id, record);
    const marketplace = typeof record.marketplace === 'string' ? record.marketplace : '';
    if (marketplace !== '' && marketplace !== 'local') continue;
    if (typeof record.name === 'string' && !byName.has(record.name)) byName.set(record.name, record);
  }
  return { byId, byName };
}

function entryView(entry, marketplace, installed) {
  const id = `${entry.name}@${marketplace}`;
  const record = installed.byId.get(id) ?? installed.byName.get(entry.name) ?? null;
  const installedVersion = typeof record?.version === 'string' ? record.version : null;
  const version = typeof entry.version === 'string' ? entry.version : null;
  return {
    id,
    name: entry.name,
    marketplace,
    version,
    displayName: entry.displayName ?? null,
    displayNameI18n: entry.displayNameI18n ?? null,
    description: entry.description ?? '',
    descriptionI18n: entry.descriptionI18n ?? null,
    icon: entry.icon ?? null,
    category: entry.category ?? null,
    keywords: entry.keywords ?? [],
    publisherType: entry.publisherType ?? null,
    componentTypes: entry.componentTypes ?? [],
    author: entry.author ?? null,
    homepage: entry.homepage ?? null,
    license: entry.license ?? null,
    // 'zcode' | 'root' | 'claude' | 'synthesized' | null（远程条目未经本地探测时为 null）
    format: entry.format ?? null,
    source: entry.source,
    installed: record !== null,
    installedVersion,
    updatable: record !== null && version !== null && installedVersion !== null && version !== installedVersion,
  };
}

// ---------------------------------------------------------------- helpers

/** 从来源里抽一个候选 id（清单没有可用 name 时的兜底）。 */
function deriveMarketBaseName(source) {
  if (source.kind === 'directory') return basename(resolve(source.path));
  if (source.kind === 'github') return String(source.repo ?? '').split('/').filter(Boolean).pop() ?? '';
  if (source.kind === 'git' || source.kind === 'url') {
    let pathname = '';
    try {
      pathname = new URL(source.url).pathname;
    } catch {
      pathname = String(source.url ?? '');
    }
    const file = basename(pathname.replace(/\/+$/, ''));
    const withoutExt = file.replace(/\.(git|json)$/i, '');
    if (withoutExt.toLowerCase() === 'marketplace') {
      // `.../owner/repo/marketplace.json` 这类 CDN 地址：用上一级目录更有辨识度。
      const parent = basename(dirname(pathname.replace(/\/+$/, '')));
      return parent !== '' ? parent : withoutExt;
    }
    return withoutExt;
  }
  return '';
}

/** 市场 id 合法化：与 normalizeMarketId 同一形状。 */
function slugifyMarketId(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+/, '')
    .replace(/-+$/, '')
    .slice(0, 64);
  return /^[a-z0-9][a-z0-9._-]*$/.test(text) ? text : '';
}

/**
 * 决定市场 id：显式 id → 清单 name → 来源名，撞了同来源复用、异来源加 `-2`/`-3`。
 */
function uniqueMarketId(existing, explicitId, parsedName, source) {
  const preferred =
    explicitId ??
    (slugifyMarketId(parsedName) || slugifyMarketId(deriveMarketBaseName(source)) || 'market');
  const sameSource = (record) => JSON.stringify(record?.source ?? null) === JSON.stringify(source);
  let candidate = preferred;
  for (let index = 2; index <= 50; index += 1) {
    const record = existing[candidate];
    if (record === undefined) return candidate;
    if (sameSource(record)) return candidate;
    candidate = `${preferred}-${index}`;
  }
  throw badRequest(`too many marketplaces share the id "${preferred}"`);
}

// ---------------------------------------------------------------- helpers

async function enableResult(ctx, cwd, id) {
  const effective = await effectivePlugins(ctx, cwd);
  const plugin = effective.plugins.find((item) => item.id === id);
  return {
    plugin: plugin
      ? {
          id: plugin.id,
          enabled: plugin.enabled,
          enabledSource: plugin.enabledSource,
          options: plugin.options,
        }
      : null,
    workspace: effective.workspace,
  };
}

async function findInstalled(ctx, id) {
  const installed = await readInstalled(ctx);
  const record = installed.plugins[id];
  if (record === undefined) throw notFound(`unknown plugin "${id}"`);
  return record;
}

async function ensureHubDir(ctx) {
  const paths = hubPaths(ctx);
  await ensureDir(paths.cacheRoot);
  await ensureDir(paths.dataRoot);
  await ensureDir(join(paths.root, 'indexes'));
  return paths;
}

function normalizeMarketId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (id === '') throw badRequest('"id" is required');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw badRequest('"id" must be a short identifier');
  return id;
}

/**
 * 市场来源入参归一化：把用户在「添加插件市场」里粘贴的一行文本识别成 SPEC 的来源。
 *
 * 识别顺序（与 ZCode 的输入框提示一致：GitHub 仓库、Git URL、文件或目录）：
 *   - `gh:owner/repo` / `github:owner/repo` / `owner/repo` → GitHub
 *   - `https://github.com/owner/repo(.git)` / `https://host/x.git` / `git@host:x.git` → git
 *   - `https://…/marketplace.json`（或任意 http(s) 地址）→ url（抓取索引）
 *   - 其余（`D:\x`、`\\server\share`、`./x`、`~/x`）→ 本地目录
 */
function normalizeMarketSourceInput(raw) {
  if (typeof raw === 'string' && raw.trim() !== '') {
    const value = raw.trim().replace(/^["']|["']$/g, '');
    if (/^(gh|github):/i.test(value)) return { kind: 'github', repo: value.replace(/^(gh|github):/i, '') };
    if (/^git@[^\s:]+:.+$/i.test(value)) return { kind: 'git', url: value };
    if (/^https?:\/\//i.test(value)) {
      const github = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/?#].*)?$/i.exec(value);
      if (github !== null) return { kind: 'github', repo: `${github[1]}/${github[2]}` };
      if (/\.git$/i.test(value)) return { kind: 'git', url: value };
      return { kind: 'url', url: value };
    }
    // `owner/repo`：至少一段斜杠、不含空白/反斜杠、不是盘符或 UNC、不是相对路径。
    if (
      /^[^\s/\\]+(\/[^\s/\\]+)+$/.test(value) &&
      !/^[A-Za-z]:/.test(value) &&
      !value.startsWith('./') &&
      !value.startsWith('../')
    ) {
      return { kind: 'github', repo: value };
    }
    return { kind: 'directory', path: value };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw badRequest('"source" must be a string or an object');
  }
  switch (raw.kind ?? raw.source) {
    case 'directory':
    case 'file':
      if (typeof raw.path !== 'string' || raw.path === '') throw badRequest('"source.path" is required');
      return { kind: 'directory', path: raw.path };
    case 'url': {
      if (typeof raw.url !== 'string' || raw.url === '') throw badRequest('"source.url" is required');
      return { kind: 'url', url: raw.url };
    }
    case 'git':
      if (typeof raw.url !== 'string' || raw.url === '') throw badRequest('"source.url" is required');
      return { kind: 'git', url: raw.url, ...(raw.ref ? { ref: String(raw.ref) } : {}) };
    case 'github':
      if (typeof raw.repo !== 'string' || raw.repo === '') throw badRequest('"source.repo" is required');
      return { kind: 'github', repo: raw.repo, ...(raw.ref ? { ref: String(raw.ref) } : {}) };
    default:
      throw badRequest('unsupported source kind');
  }
}

/** 直接安装入参：只接受 SPEC 里的四种来源。 */
function normalizeInstallSource(raw) {
  if (typeof raw === 'string' && raw.trim() !== '') {
    const value = raw.trim();
    if (/^https?:\/\//i.test(value)) return { kind: 'archive', url: value };
    return { kind: 'directory', path: value };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('"source" must be a string or an object');
  const kind = raw.kind;
  if (kind === 'directory') return { kind: 'directory', path: String(raw.path ?? '') };
  if (kind === 'git') return { kind: 'git', url: String(raw.url ?? ''), ...(raw.ref ? { ref: String(raw.ref) } : {}) };
  if (kind === 'archive') return { kind: 'archive', url: String(raw.url ?? '') };
  throw badRequest('unsupported install source kind');
}

function normalizeOptions(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('"options" must be an object');
  const clean = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') clean[key] = value;
    else throw badRequest(`option "${key}" must be a string, number, or boolean`);
  }
  return clean;
}

function summarizeMarket(record, entries) {
  const freshness = marketFreshness(record);
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    source: record.source,
    lastUpdated: record.lastUpdated,
    pluginCount: record.pluginCount ?? entries?.length ?? 0,
    indexPath: record.indexPath,
    // 新鲜度与健康状态：页面据此显示「过期」「上次抓取失败」，不用自己算时间差。
    fetchedAt: freshness.fetchedAt,
    ageSec: freshness.ageSec,
    stale: freshness.stale,
    lastError: typeof record.lastError === 'string' && record.lastError !== '' ? record.lastError : null,
    lastErrorAt: typeof record.lastErrorAt === 'string' ? record.lastErrorAt : null,
  };
}

/**
 * 索引新鲜度。
 *
 * `fetchedAt` 是新记录里的「成功抓取时间」；老记录没有这个字段，回退到
 * `lastUpdated`（当时只在抓取成功后写）。两者都没有就不判断过期——宁可少刷新一次，
 * 也不要因为缺字段把每个市场都当成过期。
 */
function marketFreshness(record) {
  const stamp =
    typeof record?.fetchedAt === 'string' && record.fetchedAt !== ''
      ? record.fetchedAt
      : typeof record?.lastUpdated === 'string'
        ? record.lastUpdated
        : null;
  const parsed = stamp === null ? Number.NaN : Date.parse(stamp);
  const ageSec = Number.isFinite(parsed) ? Math.max(0, Math.floor((Date.now() - parsed) / 1000)) : null;
  return { fetchedAt: stamp, ageSec, stale: ageSec !== null && ageSec > MARKET_TTL_SEC };
}

/** 最近一次抓取失败是否还在退避窗口内（`lastErrorAt` 是持久状态，重启后也生效）。 */
function recentlyFailedMarket(record) {
  const stamp = Date.parse(typeof record?.lastErrorAt === 'string' ? record.lastErrorAt : '');
  return Number.isFinite(stamp) && Date.now() - stamp < MARKET_RETRY_COOLDOWN_MS;
}

/**
 * 记一次抓取失败（不清空旧条目，`indexPath` 仍指向上一次成功的本地副本）。
 *
 * `id` 缺省时按来源指纹找已有记录——「重复添加同一个来源」就是刷新，失败也要留痕。
 */
async function rememberMarketFailure(ctx, { id, source }, error) {
  const message = String(error?.message ?? error);
  await mutateMarketplaces(ctx, (current) => {
    const row =
      id !== undefined
        ? current.marketplaces[id]
        : Object.values(current.marketplaces).find(
            (item) => JSON.stringify(item?.source ?? null) === JSON.stringify(source),
          );
    if (row === undefined) return undefined;
    row.lastError = message;
    row.lastErrorAt = nowIso();
    return current;
  }).catch((writeError) => {
    warn(`cannot record the marketplace failure: ${writeError?.message ?? writeError}`);
  });
}

/**
 * 后台刷新一个过期市场（单飞去重 + 失败退避）。
 *
 * 只自动刷新**非破坏性来源**（本地目录 / 远端索引 URL）：git/github 的刷新要替换
 * cache/.markets 里的 checkout，浏览页面不该触发「删目录再克隆」。git 市场仍会标记
 * 过期，由用户显式点刷新。
 *
 * 失败后 10 分钟内不再自动重试：`fetchedAt` 不前进，否则每次打开市场页都会重排一次
 * 抓取（git clone 超时可达分钟级）。显式刷新不受退避限制。
 */
function scheduleMarketRefresh(ctx, id) {
  if (refreshingMarkets.has(id)) return;
  refreshingMarkets.add(id);
  void (async () => {
    try {
      const marketplaces = await readMarketplaces(ctx);
      const existing = marketplaces.marketplaces[id];
      if (existing === undefined) return;
      const kind = existing.source?.kind;
      if (kind !== 'directory' && kind !== 'url') return;
      if (recentlyFailedMarket(existing)) return;
      const fetched = await fetchMarketIndex(ctx, { source: existing.source });
      await mutateMarketplaces(ctx, (current) => {
        // 刷新期间市场被移除：不复活记录。
        const row = current.marketplaces[id];
        if (row === undefined) return undefined;
        current.marketplaces[id] = {
          ...row,
          name: fetched.name ?? row.name,
          description: fetched.description ?? row.description,
          lastUpdated: nowIso(),
          fetchedAt: nowIso(),
          lastError: null,
          lastErrorAt: null,
          pluginCount: fetched.pluginCount,
          indexPath: fetched.indexPath,
        };
        return current;
      });
      invalidateScopeCache();
    } catch (error) {
      warn(`market "${id}" background refresh failed: ${error?.message ?? error}`);
      await rememberMarketFailure(ctx, { id }, error);
    } finally {
      refreshingMarkets.delete(id);
    }
  })().catch(() => {});
}

function sanitizeSegment(value) {
  return String(value ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 96) || 'item';
}

function omitKey(object, key) {
  const next = { ...object };
  delete next[key];
  return next;
}

async function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      const { stat } = await import('node:fs/promises');
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

/** Node 20 自带 fetch；统一超时与错误码，避免路由里散落 try/catch。 */
async function fetchText(url, { timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new ApiError('source-unreachable', `${url} answered ${response.status}`);
    return await response.text();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('source-unreachable', `${url} is unreachable: ${error?.message ?? error}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 供 index.js 复用的稳定 hash（写入口径与投影签名一致）。 */
export function configSignature(value) {
  return stableHash(value);
}

/** 供测试断言用：当前 workspace 文件路径。 */
export const workspaceFileFor = workspaceConfigPath;

/** 未使用但保留：语义化 hash（README 提到 sha256 内容指纹）。 */
export const contentHash = sha256Text;

/** 项目配置删除覆盖的工具（与 store 同名函数保持一致语义）。 */
export const stripWorkspaceOverride = removeWorkspaceKeys;

/** 让测试能清空串行队列。 */
export function resetMutationChain() {
  mutationChain = Promise.resolve();
}
