/**
 * dsh-skill-manager — 插件技能（宿主 `skills` 服务的只读视图）。
 *
 * dsh-plugin-hub 把每个已启用插件的技能注册进宿主 `skills` 服务，provider 形如
 * `plugin-hub:<pluginId>`，rank 350（介于 custom 300 与 user-dsh 400 之间）。
 * `overview` 需要把这些名字与扫盘结果对照，标出「被插件同名遮蔽」的条目。
 *
 * 三条硬约束：
 *  1. 只读：不注册 provider、不写任何技能文件；
 *  2. 不抛错：Agent / `skills` 服务任一不可用都降级为 `available: false`，
 *     绝不阻塞 `overview` 的其余扫描；
 *  3. 只认 provider 前缀：filesystem / runtime 等其它宿主 provider 不算插件技能。
 */

import { resolve } from 'node:path';

import { mergeIssues } from './parse.js';

/** 插件中心注册的 provider 前缀（契约 §3）。 */
export const PLUGIN_PROVIDER_PREFIX = 'plugin-hub:';

/** 插件技能的固定 rank：高于 custom 300，低于 user-dsh 400。 */
export const PLUGIN_SKILL_RANK = 350;

/** 路径比较键：规范化 + Windows 大小写不敏感（与契约 §1.2 的 normalized-cwd 同口径）。 */
function pathKey(value) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  let path = resolve(value);
  if (path.length > 1 && (path.endsWith('/') || path.endsWith('\\'))) path = path.slice(0, -1);
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

/**
 * 一个 live Agent 的生效目录：优先 `workingDirectory` 服务，回退 `session.header.cwd`。
 *
 * @param {object} ctx - 插件上下文
 * @param {object} agent - live Agent（`session` 必有）
 * @returns {string} 目录；未知时为空串
 */
function agentCwd(ctx, agent) {
  try {
    const dir = ctx?.workingDirectory?.get?.(agent?.session);
    if (typeof dir === 'string' && dir !== '') return dir;
  } catch {
    /* 服务异常时退回 session 自带的 cwd */
  }
  const headerCwd = agent?.session?.header?.cwd;
  return typeof headerCwd === 'string' && headerCwd !== '' ? headerCwd : '';
}

/**
 * 选一个 live Agent：优先「生效目录 == cwd」的最新 Agent，否则退回最新 Agent。
 *
 * `agents.list()` 按创建顺序返回，末尾最新（与 routes.js 的 defaultCwd 同口径）。
 *
 * @param {object} ctx - 插件上下文
 * @param {string} [cwd] - 本次 overview 解析出的目录
 * @returns {object | undefined}
 */
export function pickLiveAgent(ctx, cwd) {
  let agents = [];
  try {
    const registry = typeof ctx?.get === 'function' ? ctx.get('agents') : ctx?.agents;
    agents = typeof registry?.list === 'function' ? registry.list() : [];
  } catch {
    agents = [];
  }
  if (!Array.isArray(agents) || agents.length === 0) return undefined;
  const wanted = pathKey(cwd);
  let latest;
  for (let index = agents.length - 1; index >= 0; index -= 1) {
    const agent = agents[index];
    if (agent === null || typeof agent !== 'object' || agent.session === undefined) continue;
    if (latest === undefined) latest = agent;
    if (wanted === '') continue;
    const dir = agentCwd(ctx, agent);
    if (dir !== '' && pathKey(dir) === wanted) return agent;
  }
  return latest;
}

/**
 * 读取当前 live Agent 可见的插件技能。
 *
 * 返回形状固定为 `{ available, providerPrefix, skills, error? }`：
 * `skills` 是 `[{ name, provider, path? }]`（按 name、provider 排序），
 * 任何失败都返回 `available: false` 而不是抛错。
 *
 * @param {object} ctx - 插件上下文
 * @param {{ cwd?: string }} [options] - 本次解析出的目录
 * @returns {Promise<{ available: boolean, providerPrefix: string, skills: object[], error?: string }>}
 */
export async function listPluginSkills(ctx, options = {}) {
  const unavailable = (error) => ({ available: false, providerPrefix: PLUGIN_PROVIDER_PREFIX, skills: [], error });
  const requestedCwd = typeof options.cwd === 'string' && options.cwd.trim() !== '' ? options.cwd.trim() : undefined;
  const agent = pickLiveAgent(ctx, requestedCwd);
  if (agent === undefined) return unavailable('没有 live Agent，无法读取插件技能');

  let service;
  try {
    // 插件中心的 provider 注册在 agent.ctx 的 scope 层，优先用 Agent 自己的上下文。
    service = agent.ctx?.get?.('skills') ?? ctx.get?.('skills');
  } catch {
    service = undefined;
  }
  if (service === null || service === undefined || typeof service.list !== 'function') {
    return unavailable('宿主 skills 服务不可用');
  }

  const lookupCwd = requestedCwd ?? agentCwd(ctx, agent) ?? '';
  let summaries;
  try {
    const lookup = { scope: agent };
    if (lookupCwd !== '') lookup.cwd = lookupCwd;
    summaries = await service.list(lookup);
  } catch (error) {
    return unavailable(`读取插件技能失败：${error?.message ?? String(error)}`);
  }
  if (!Array.isArray(summaries)) return unavailable('宿主 skills 服务返回了非数组结果');

  const skills = [];
  const seen = new Set();
  for (const summary of summaries) {
    if (summary === null || typeof summary !== 'object') continue;
    const provider = summary.provider;
    if (typeof provider !== 'string' || !provider.startsWith(PLUGIN_PROVIDER_PREFIX)) continue;
    const name = summary.name;
    if (typeof name !== 'string' || name === '') continue;
    // 同名同 provider 只保留一条（理论上服务已去重，这里防御 provider 重复注册）。
    const key = `${name}\u0000${provider}`;
    if (seen.has(key)) continue;
    seen.add(key);
    skills.push({
      name,
      provider,
      ...(typeof summary.path === 'string' && summary.path !== '' ? { path: summary.path } : {}),
    });
  }
  skills.sort((left, right) => left.name.localeCompare(right.name) || left.provider.localeCompare(right.provider));
  return { available: true, providerPrefix: PLUGIN_PROVIDER_PREFIX, skills };
}

/**
 * 把插件技能与扫盘技能按 name 对照，给被插件版本胜出的条目打标。
 *
 * 只处理 **enabled** 条目（停用/异常条目本来就不进宿主目录，标「被遮蔽」是假象），
 * 且只处理 rank > 350 的根：project(100/200) 与 custom(300) 本地技能仍优先，
 * 宿主不会采用插件那份，因此不标。
 *
 * 已有的 `shadowedBy`（同根重复 / 更高 rank 根）保持原样，不覆盖；插件信息另放
 * `shadowedByPlugin`，两条遮蔽原因可以同时存在。
 *
 * @param {object[]} skills - 扫盘技能（原地修改）
 * @param {object[]} plugins - `listPluginSkills().skills`
 * @returns {{ marked: number }} 被标记的条目数（供测试/诊断）
 */
export function applyPluginShadowing(skills, plugins) {
  if (!Array.isArray(skills) || !Array.isArray(plugins) || plugins.length === 0) return { marked: 0 };
  const byName = new Map();
  for (const plugin of plugins) {
    if (plugin === null || typeof plugin !== 'object') continue;
    if (typeof plugin.name !== 'string' || plugin.name === '') continue;
    if (typeof plugin.provider !== 'string' || plugin.provider === '') continue;
    if (!byName.has(plugin.name)) byName.set(plugin.name, plugin);
  }
  let marked = 0;
  for (const skill of skills) {
    if (skill === null || typeof skill !== 'object') continue;
    const plugin = byName.get(skill.name);
    if (plugin === undefined) continue;
    if (skill.state !== 'enabled') continue;
    if (!(typeof skill.rank === 'number' && skill.rank > PLUGIN_SKILL_RANK)) continue;
    skill.shadowed = true;
    skill.shadowedByPlugin = { provider: plugin.provider };
    skill.issues = mergeIssues(skill.issues, [
      {
        level: 'warn',
        code: 'shadowed-by-plugin',
        message: `与插件中心提供的同名技能 "${skill.name}"（${plugin.provider}）冲突：插件技能 rank 350，优先于 user/bundled 技能，宿主不会采用本条目。`,
      },
    ]);
    marked += 1;
  }
  return { marked };
}
