/**
 * dsh-plugin-hub — 宿主入口。
 *
 * 只做三件事，业务都在下层模块：
 *   1. 一次性可写性探测（数据目录不可写时只告警，不让整个插件挂掉）；
 *   2. 挂 per-Agent 投影（`agent/created` / `agent/pre-step` / `agent/disposed`）；
 *   3. 挂 HTTP 路由（`/plugin-hub/api/*`）。
 *
 * 顺序刻意是"先投影，后路由"：启动期创建的会话不会因为页面还没挂好而错过脚本/工具。
 * 投影的 `resolveEffective` 由这里注入，而不是让投影层自己 import scope：这样投影层
 * 可以用假实现单独冒烟（见 scripts/runtime-smoke.mjs）。
 */

import { join } from 'node:path';
import { mountProjection } from './projection/index.js';
import { mountRoutes } from './routes.js';
import { effectivePlugins, invalidateScopeCache } from './scope.js';
import { hubRoot, probeWritable } from './store.js';
import { warn } from './util.js';

/** Loader entry id，与 cordis.patch.yml 一致。 */
export const name = 'plugin-hub';

/**
 * 需要的宿主服务。
 *
 * `webServer`/`connection` 是路由的硬依赖；`workingDirectory` 用来算会话的项目目录。
 * `configEditor` 只在定位 profile 目录时可选使用（缺失时按 DSH_HOME 规则重建），
 * 因此不写进 inject，避免在没有它的组合里整插件不可用。
 */
export const inject = ['webServer', 'connection', 'workingDirectory', 'agents'];

/**
 * @param {object} ctx 插件上下文
 */
export function apply(ctx) {
  ctx.effect(() => {
    const disposers = [];

    // 数据目录探测是异步的，但不 await：启动路径不该等磁盘。
    probeWritable(ctx).catch(() => {});

    try {
      const disposeProjection = mountProjection(ctx, {
        resolveEffective: (cwd) => effectivePlugins(ctx, cwd),
        // `${ZCODE_PLUGIN_DATA}` 指向插件私有数据目录：落在 profile 的插件中心数据根下，
        // 不写进插件包（包可能来自只读 cache 或 Git 工作副本）。
        resolvePluginData: (_ctx, pluginId) => join(hubRoot(ctx), 'data', pluginId),
      });
      disposers.push(disposeProjection);
    } catch (error) {
      warn(`projection is unavailable: ${error?.message ?? error}`);
    }

    try {
      const disposeRoutes = mountRoutes(ctx);
      disposers.push(disposeRoutes);
    } catch (error) {
      // 路由挂了页面就不可用，但会话侧的投影仍应工作。
      warn(`routes are unavailable: ${error?.message ?? error}`);
    }

    return () => {
      invalidateScopeCache();
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose?.();
        } catch (error) {
          warn(`teardown failed: ${error?.message ?? error}`);
        }
      }
    };
  }, 'plugin-hub: routes and projection');
}

export default { name, inject, apply };
