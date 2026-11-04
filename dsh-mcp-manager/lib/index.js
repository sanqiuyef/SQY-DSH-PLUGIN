/**
 * dsh-mcp-manager — host half entry point.
 *
 * Mounts the sixteen routes of this plugin's HTTP API
 * under `/mcp-manager/api` and delegates each to one module:
 *
 *   GET  /servers                servers.js   live rows + health + raw config facts + diagnostics
 *   POST /servers/toggle         toggle.js    enable/disable through pluginManager
 *   POST /servers/toggle-batch   toggle.js    the same, for a sequential list of entry ids
 *   POST /servers/reconnect      reconnect.js / project-api.js  restart one row in place
 *   POST /servers/update         edit.js      raw-layer edit through ConfigEditor.edit
 *   POST /servers/add            patch.js     managed-block insert (lock/backup/verify)
 *   POST /servers/remove         patch.js     managed-block delete (lock/backup/verify)
 *   POST /probe                  probe.js     stdio or streamable-http probe (stage + hint + schema bytes)
 *   GET  /export                 transfer.js  mcpServers export (no literal credentials)
 *   POST /import                 transfer.js  mcpServers import (reported drops)
 *   GET  /project                project-api.js  project view (trust layers, skipped names)
 *   POST /project/{trust,add,update,remove,toggle}  project file mutations
 *
 * Why plain `webServer.register` routes instead of a typert remote: a remote needs
 * generated `typert.host.js` / `typert.remote-client.js` artifacts and a
 * `dsh-api-remotes` dependency, while `webServer.register()` is a plain call the
 * host already exposes to its own plugins. Same origin, no code generation, and the
 * browser half can `fetch('/mcp-manager/api/...')` like any other page resource.
 *
 * Every handler follows the same opening order, because each step is a fence:
 *   1. `connection.requestRejection(request)` — the host's authentication and
 *      Host/Origin gate (contract §2.8; the contract calls this the first line).
 *   2. method whitelist.
 *   3. for mutations: `application/json` and a 64 KiB body cap.
 * Only then does a handler read the body or touch configuration.
 *
 * `inject` names the services the route bodies use. Declaring them keeps the plugin
 * unmounted in compositions that lack one, instead of failing at request time.
 */

import {
  ApiError,
  badRequest,
  readJsonBody,
  rejectUnauthorized,
  requireJson,
  requireMethod,
  sendError,
  sendJson,
} from './security.js';
import { addManagedServer, removeManagedServer } from './patch.js';
import { listServers } from './servers.js';
import { setServerEnabled, setServersEnabled } from './toggle.js';
import { reconnectGlobalServer } from './reconnect.js';
import { resetHealth } from './health.js';
import { updateServerConfig } from './edit.js';
import { validateServerInput } from './diagnostics.js';
import {
  clearProbes,
  probeHttp,
  probeInputFromConfig,
  probeStdio,
  probeTargetFingerprint,
  probeTargetForEntry,
  probeTargetForPatch,
  rememberProbe,
} from './probe.js';
import { exportServers, importServers } from './transfer.js';
import { lastSnapshotPath, scheduleSnapshot } from './snapshot.js';
import { applyEnvBridge, envBridgeSnapshot } from './env-bridge.js';
import { mountProjectRuntime } from './project-runtime.js';
import {
  addProjectServer,
  projectProbeTarget,
  projectView,
  reconnectProjectServer,
  removeProjectServer,
  setProjectServerEnabled,
  trustProjectScope,
  updateProjectServer,
} from './project-api.js';

/** Loader entry id, matching this bundle's `cordis.patch.yml`. */
export const name = 'mcp-manager';

/** The host services this plugin needs. */
export const inject = ['webServer', 'connection', 'pluginManager', 'configEditor', 'subprocess', 'tools', 'workingDirectory'];

/** Route prefix, frozen by the contract. */
const BASE = '/mcp-manager/api';

/**
 * Mount the routes, tied to the plugin fiber.
 *
 * `ctx.effect` is what the host's own plugins use for their resources (dshmarket
 * registers its routes the same way): when this fiber is disposed or hot-swapped,
 * the returned disposer unregisters every route, so a reload cannot collide with the
 * previous registration.
 */
export function apply(ctx) {
  // Before any route, tool, or snapshot exists: fill `process.env` from
  // `<profileDir>/data/mcp-manager/secrets.json` so `!!js process.env.X` row
  // expressions evaluate against the operator's current values even when the desktop
  // app was launched by a wrapper with a stale environment. Synchronous by contract
  // (never await here); failures only warn and are reported through `GET /servers`.
  applyEnvBridge(ctx);

  ctx.effect(() => {
    const disposers = [];

    // Project scope: mount/unmount per-Agent MCP clients from `<project>/.dsh/mcp.json`.
    // Installed before the routes so a Session created during startup is covered.
    const disposeProjectRuntime = mountProjectRuntime(ctx);

    const mount = (path, handler) => {
      disposers.push(ctx.webServer.register({ kind: 'exact', path: `${BASE}${path}`, handler }));
    };

    /** A read-only route: authentication, then GET/HEAD, then the body. */
    const readRoute = (handler) => async (request, response) => {
      if (rejectUnauthorized(ctx, request, response)) return;
      if (!requireMethod(request, response, 'GET')) return;
      try {
        await handler(request, response);
      } catch (error) {
        sendError(response, error);
      }
    };

    /** A mutating route: authentication, POST, JSON, bounded body, then the body. */
    const mutateRoute = (handler) => async (request, response) => {
      if (rejectUnauthorized(ctx, request, response)) return;
      if (!requireMethod(request, response, 'POST')) return;
      if (!requireJson(request, response)) return;
      try {
        await handler(request, response);
      } catch (error) {
        sendError(response, error);
      }
    };

    // 1 -------------------------------------------------------------- GET /servers
    // `snapshotPath` points the page (or a person at a terminal) at the startup
    // diagnostics file without having to guess its timestamped name.
    mount(
      '/servers',
      readRoute(async (_request, response) => {
        const view = await listServers(ctx);
        sendJson(response, 200, { ...view, snapshotPath: lastSnapshotPath(), envBridge: envBridgeSnapshot() });
      }),
    );

    // 2 ------------------------------------------------------- POST /servers/toggle
    mount(
      '/servers/toggle',
      mutateRoute(async (request, response) => {
        const body = await readJsonBody(request);
        const { entryId, enabled } = body ?? {};
        sendJson(response, 200, await setServerEnabled(ctx, entryId, enabled));
      }),
    );

    // 3 ------------------------------------------------------- POST /servers/update
    mount(
      '/servers/update',
      mutateRoute(async (request, response) => {
        const body = await readJsonBody(request);
        const { patchId, config, migrateSecrets } = body ?? {};
        if (typeof patchId !== 'string' || patchId === '') throw badRequest('"patchId" must be a non-empty string');
        if (config !== undefined && (config === null || typeof config !== 'object' || Array.isArray(config))) {
          throw badRequest('"config" must be an object');
        }
        if (migrateSecrets !== undefined && typeof migrateSecrets !== 'boolean') {
          throw badRequest('"migrateSecrets" must be a boolean');
        }
        if (config === undefined && migrateSecrets !== true) {
          throw badRequest('"config" is required unless migrateSecrets is true');
        }
        sendJson(
          response,
          200,
          await updateServerConfig(ctx, { patchId, config: config ?? {}, migrateSecrets: migrateSecrets === true }),
        );
      }),
    );

    // 4 ---------------------------------------------------------- POST /servers/add
    mount(
      '/servers/add',
      mutateRoute(async (request, response) => {
        const body = await readJsonBody(request);
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw badRequest('a JSON object body is required');
        const input = body.server;
        if (input === undefined) throw badRequest('"server" is required');
        const validation = validateServerInput(input);
        if (!validation.ok) throw new ApiError('bad-request', 'invalid server definition', { details: validation.errors });
        sendJson(response, 200, await addManagedServer(ctx, validation.server));
      }),
    );

    // 5 ------------------------------------------------------- POST /servers/remove
    mount(
      '/servers/remove',
      mutateRoute(async (request, response) => {
        const body = await readJsonBody(request);
        const { patchId } = body ?? {};
        if (typeof patchId !== 'string' || patchId === '') throw badRequest('"patchId" must be a non-empty string');
        sendJson(response, 200, await removeManagedServer(ctx, patchId));
      }),
    );

    // 5b ----------------------------------------------------- POST /servers/reconnect
    // One restart in place. Global rows restart their Loader fiber (no file write);
    // project rows remount in each live Session of that project. A refused restart
    // is a classified 409, never a silent success.
    mount(
      '/servers/reconnect',
      mutateRoute(async (request, response) => {
        const body = await readJsonBody(request);
        if (body !== null && body.scope === 'project') {
          sendJson(response, 200, await reconnectProjectServer(ctx, body.cwd, body.serverName));
          return;
        }
        sendJson(
          response,
          200,
          await reconnectGlobalServer(ctx, { entryId: body?.entryId, patchId: body?.patchId }),
        );
      }),
    );

    // 5c ------------------------------------------------- POST /servers/toggle-batch
    // Sequential on purpose (see toggle.js): each row reports its own outcome.
    mount(
      '/servers/toggle-batch',
      mutateRoute(async (request, response) => {
        const body = await readJsonBody(request);
        const { entryIds, enabled } = body ?? {};
        sendJson(response, 200, await setServersEnabled(ctx, entryIds, enabled));
      }),
    );

    // 6 -------------------------------------------------------------- POST /probe
    mount(
      '/probe',
      mutateRoute(async (request, response) => {
        const body = await readJsonBody(request);
        const { patchId, entryId, server } = body ?? {};

        let target;
        let serverName = null;
        if (body.scope === 'project') {
          const resolved = await projectProbeTarget(ctx, body.cwd, body.serverName);
          target = probeInputFromConfig(resolved.server);
          serverName = resolved.serverName;
        } else if (typeof patchId === 'string' && patchId !== '') {
          const resolved = probeTargetForPatch(ctx, patchId);
          target = resolved.input;
          serverName = resolved.serverName;
        } else if (typeof entryId === 'string' && entryId !== '') {
          const resolved = probeTargetForEntry(ctx, entryId);
          target = resolved.input;
          serverName = resolved.serverName;
        } else if (server !== undefined) {
          const validation = validateServerInput(server);
          if (!validation.ok) throw new ApiError('bad-request', 'invalid server definition', { details: validation.errors });
          target = probeInputFromConfig(validation.server);
          serverName = typeof server.serverName === 'string' ? server.serverName : null;
        } else {
          throw badRequest('expected one of "patchId", "entryId", or "server"');
        }

        // A failed probe is data, not an HTTP error (contract §5 row 6).
        const result =
          target.transport === 'streamable-http' ? await probeHttp(target) : await probeStdio(ctx, target);
        if (serverName !== null) rememberProbe(serverName, result, probeTargetFingerprint(target));
        sendJson(response, 200, result);
      }),
    );

    // 7 ------------------------------------------------------------- GET /export
    mount(
      '/export',
      readRoute(async (_request, response) => {
        sendJson(response, 200, await exportServers(ctx));
      }),
    );

    // 8 ------------------------------------------------------------- POST /import
    mount(
      '/import',
      mutateRoute(async (request, response) => {
        const body = await readJsonBody(request);
        sendJson(response, 200, await importServers(ctx, body ?? {}));
      }),
    );

    // 9 ------------------------------------------------------- GET /project (scope)
    // Project-scope MCP servers live in `<project>/.dsh/mcp.json`; `cwd` is optional
    // and defaults to the newest live Session's directory.
    mount(
      '/project',
      readRoute(async (request, response) => {
        const cwd = new URL(request.url ?? '/', 'http://localhost').searchParams.get('cwd') ?? undefined;
        sendJson(response, 200, await projectView(ctx, cwd));
      }),
    );

    // 10 --------------------------------------------------------- POST /project/trust
    mount(
      '/project/trust',
      mutateRoute(async (request, response) => {
        const body = await readJsonBody(request);
        sendJson(response, 200, await trustProjectScope(ctx, body?.cwd));
      }),
    );

    // 11 ----------------------------------------------------------- POST /project/add
    mount(
      '/project/add',
      mutateRoute(async (request, response) => {
        const body = await readJsonBody(request);
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw badRequest('a JSON object body is required');
        if (body.server === undefined) throw badRequest('"server" is required');
        sendJson(response, 200, await addProjectServer(ctx, body.cwd, body.server));
      }),
    );

    // 12 -------------------------------------------------------- POST /project/update
    mount(
      '/project/update',
      mutateRoute(async (request, response) => {
        const body = await readJsonBody(request);
        const { cwd, serverName, config } = body ?? {};
        if (typeof serverName !== 'string' || serverName === '') throw badRequest('"serverName" must be a non-empty string');
        sendJson(response, 200, await updateProjectServer(ctx, cwd, serverName, config));
      }),
    );

    // 13 -------------------------------------------------------- POST /project/remove
    mount(
      '/project/remove',
      mutateRoute(async (request, response) => {
        const body = await readJsonBody(request);
        const { cwd, serverName } = body ?? {};
        if (typeof serverName !== 'string' || serverName === '') throw badRequest('"serverName" must be a non-empty string');
        sendJson(response, 200, await removeProjectServer(ctx, cwd, serverName));
      }),
    );

    // 14 -------------------------------------------------------- POST /project/toggle
    mount(
      '/project/toggle',
      mutateRoute(async (request, response) => {
        const body = await readJsonBody(request);
        const { cwd, serverName, enabled } = body ?? {};
        if (typeof serverName !== 'string' || serverName === '') throw badRequest('"serverName" must be a non-empty string');
        sendJson(response, 200, await setProjectServerEnabled(ctx, cwd, serverName, enabled));
      }),
    );

    // Diagnostics snapshot: scheduled after the routes are live, never awaited (a
    // slow or failing snapshot must not affect apply). On HMR remount this runs
    // again, so the newest file always describes the current mount.
    const cancelSnapshot = scheduleSnapshot(ctx);

    return () => {
      cancelSnapshot();
      disposeProjectRuntime();
      clearProbes();
      resetHealth();
      for (const dispose of disposers.splice(0)) {
        try {
          dispose?.();
        } catch {
          /* one failing disposer must not keep the others mounted */
        }
      }
    };
  }, 'mcp-manager: http routes');
}

export default { name, inject, apply };
