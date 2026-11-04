/**
 * dsh-plugin-hub / projection — per-Agent MCP 服务器挂载。
 *
 * 复用宿主自己的 `@deepseek-ai/dsh-mcp-client`：把一个实例挂到 `agent.ctx` 上，它就会
 * 在该 Agent 的注册作用域里预定 `mcp__<serverName>__` 命名空间 —— 工具与传输都按
 * Agent 隔离，和 dsh-mcp-manager 的项目作用域 MCP 是同一套做法。
 *
 * 与 ZCode 一致，服务器配置里的字符串做单遍变量展开：
 *   ${ZCODE_PLUGIN_ROOT} / ${CLAUDE_PLUGIN_ROOT}  → 插件根（两个名字等价）
 *   ${ZCODE_PLUGIN_DATA}                          → 该插件的数据目录
 *   ${ZCODE_PROJECT_DIR}                          → 当前会话 cwd
 *   ${user_config.KEY}                            → 该插件生效的 options[KEY]
 *
 * 安全取舍：`${user_config.KEY}` 在 options 里找不到时**跳过整个 server** 并告警，
 * 而不是展开成空串 —— 空串通常会让服务器带着半截凭据启动，报错信息还可能把 URL
 * 打进日志。这是 SPEC §6「敏感引用不做特殊处理，V1 仅提示」的具体落法。
 *
 * 子代理不继承这些挂载（已知边界：agent.ctx 的作用域只覆盖该 Agent 本身）。
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** 宿主 MCP 客户端包名；用 ctx.loader.import() 解析，保证和全局行跑同一份代码。 */
export const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client';

/** 与 mcp-client 的 serverName 约束一致（`[A-Za-z0-9_-]{1,32}`）。 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** 透传给 mcp-client 的配置键（其余字段丢弃，避免把 ZCode 私有字段喂给它的 Config）。 */
const CONFIG_KEYS = Object.freeze([
  'command',
  'args',
  'env',
  'cwd',
  'url',
  'headers',
  'toolCallTimeoutMs',
  'failOnStartupError',
  'maxInstructionBytes',
  'reconnect',
]);

/** 单遍变量占位符：`${...}`（内容里不允许再出现 `}`）。 */
const VAR_PATTERN = /\$\{([^{}]+)\}/gu;

/** 记录 `${user_config.KEY}` 引用的正则（用于缺失检测，不参与替换）。 */
const USER_CONFIG_PATTERN = /\$\{user_config\.([A-Za-z0-9_.-]+)\}/gu;

/** `ctx.loader.import()` 的模块级缓存（HMR 重挂会产生新模块实例，缓存随之一并重置）。 */
let modulePromise = null;

/** 告警前缀统一（SPEC §7）。 */
function warn(message) {
  console.warn(`[plugin-hub] ${message}`);
}

/**
 * 清空模块缓存（插件卸载/测试用）。
 */
export function resetMcpModuleCache() {
  modulePromise = null;
}

/**
 * 解析并缓存宿主 MCP 客户端插件。
 *
 * 缓存的是 Promise：并发挂载多个 server 时只会 import 一次。失败时把缓存清掉，
 * 让下一次 sync 还能重试（否则一次瞬时失败会永久禁用 MCP 投影）。
 *
 * @param {object} ctx - 宿主插件上下文
 * @returns {Promise<object>} Cordis 兼容的插件对象
 */
export async function loadMcpClient(ctx) {
  if (modulePromise !== null) return modulePromise;
  modulePromise = (async () => {
    const namespace =
      typeof ctx?.loader?.import === 'function'
        ? await ctx.loader.import(MCP_CLIENT_PACKAGE)
        : await import(MCP_CLIENT_PACKAGE);
    const plugin = namespace?.default ?? namespace;
    if (plugin === null || typeof plugin !== 'object' || typeof plugin.apply !== 'function') {
      throw new Error(`${MCP_CLIENT_PACKAGE} did not export a plugin`);
    }
    return {
      name: MCP_CLIENT_PACKAGE,
      inject: Array.isArray(plugin.inject) ? plugin.inject : ['tools'],
      apply: plugin.apply,
      ...(plugin.Config === undefined ? {} : { Config: plugin.Config }),
    };
  })().catch((error) => {
    modulePromise = null;
    throw error;
  });
  return modulePromise;
}

/**
 * 单遍变量替换。识别不了的 `${...}` 原样保留：ZCode 插件可能引用本插件未提供的
 * 变量，静默清空会让配置看起来「生效了」但实际是错的。
 *
 * @param {string} text
 * @param {Record<string, string>} vars
 * @returns {string}
 */
export function expandVars(text, vars) {
  if (typeof text !== 'string') return text;
  return text.replace(VAR_PATTERN, (match, rawName) => {
    const key = rawName.trim();
    return Object.prototype.hasOwnProperty.call(vars, key) ? (vars[key] ?? '') : match;
  });
}

/** 递归展开任意 JSON 值里的字符串（对象键不展开，与 ZCode 一致）。 */
function expandDeep(value, vars) {
  if (typeof value === 'string') return expandVars(value, vars);
  if (Array.isArray(value)) return value.map((item) => expandDeep(item, vars));
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = expandDeep(item, vars);
  return out;
}

/**
 * 该插件的数据目录。
 *
 * SPEC §3 把 plugin data 定为 `<profileDir>/data/plugin-hub/data/<pluginId>/`（V1 未用，
 * 留给 V2）。profileDir 的规则与 dsh-mcp-manager 的 `profileDirOf` 相同：
 * `configEditor.documentPath` 的父目录，否则 `$DSH_HOME|~/.dsh` + `profiles/$DSH_PROFILE|desktop`。
 * 这里复制该规则是为了不依赖 Lead 的 patch/util 模块（写入范围限制）；
 * 若 index.js 注入了 `resolvePluginData`，以注入值优先。
 *
 * @param {object} ctx
 * @param {string} pluginId
 * @returns {string}
 */
export function defaultPluginDataDir(ctx, pluginId) {
  const patchPath = ctx?.configEditor?.documentPath;
  if (typeof patchPath === 'string' && patchPath !== '') {
    return join(patchPath, '..', 'data', 'plugin-hub', 'data', pluginId);
  }
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh');
  const profile = typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE !== '' ? process.env.DSH_PROFILE : 'desktop';
  return join(home, 'profiles', profile, 'data', 'plugin-hub', 'data', pluginId);
}

/**
 * 由插件记录 + 会话 cwd 构造变量表。
 *
 * @param {object} plugin
 * @param {{ cwd: string, pluginDataDir: string }} context
 * @returns {Record<string, string>}
 */
function variableTable(plugin, context) {
  const rootPath = typeof plugin?.rootPath === 'string' ? resolve(plugin.rootPath) : '';
  const options = plugin?.options !== null && typeof plugin?.options === 'object' ? plugin.options : {};
  const vars = {
    ZCODE_PLUGIN_ROOT: rootPath,
    CLAUDE_PLUGIN_ROOT: rootPath,
    ZCODE_PLUGIN_DATA: context.pluginDataDir,
    CLAUDE_PLUGIN_DATA: context.pluginDataDir,
    ZCODE_PROJECT_DIR: context.cwd,
    CLAUDE_PROJECT_DIR: context.cwd,
  };
  for (const [key, value] of Object.entries(options)) {
    vars[`user_config.${key}`] = String(value ?? '');
  }
  return vars;
}

/**
 * 判断 serverName 是否合法；不合法就做最小清洗（保留字母数字下划线短横线）。
 *
 * @param {string} name
 * @returns {{ name: string, changed: boolean } | undefined}
 */
export function normalizeServerName(name) {
  if (typeof name !== 'string' || name.trim() === '') return undefined;
  const raw = name.trim();
  if (SERVER_NAME_PATTERN.test(raw)) return { name: raw, changed: false };
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/gu, '-').slice(0, 32);
  if (!SERVER_NAME_PATTERN.test(cleaned)) return undefined;
  return { name: cleaned, changed: true };
}

/**
 * 把一条 ZCode/Claude 形状的服务器配置规范成 mcp-client 的 Config。
 *
 * ZCode 用 `type`/`transport` 描述传输，Claude 用「有没有 url」。三种写法都接受：
 * stdio 必须有 command；HTTP 必须有合法 url。
 *
 * @param {Record<string, unknown>} raw
 * @returns {{ ok: true, config: object } | { ok: false, reason: string }}
 */
export function normalizeServerConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'the server entry must be an object' };
  const declared = typeof raw.transport === 'string' ? raw.transport : typeof raw.type === 'string' ? raw.type : '';
  const wantsHttp = /^(streamable-http|streamablehttp|http|sse)$/iu.test(declared);
  const transport = wantsHttp || (raw.command === undefined && typeof raw.url === 'string') ? 'streamable-http' : 'stdio';
  if (transport === 'stdio') {
    if (typeof raw.command !== 'string' || raw.command.trim() === '') return { ok: false, reason: 'a stdio server requires a non-empty "command"' };
  } else if (typeof raw.url !== 'string' || raw.url.trim() === '') {
    return { ok: false, reason: 'an HTTP server requires a non-empty "url"' };
  }
  const config = { transport };
  for (const key of CONFIG_KEYS) {
    if (!(key in raw) || raw[key] === undefined) continue;
    config[key] = raw[key];
  }
  if (Array.isArray(config.args)) config.args = config.args.map((value) => String(value));
  if (config.env !== undefined && (config.env === null || typeof config.env !== 'object' || Array.isArray(config.env))) {
    delete config.env;
  }
  if (config.headers !== undefined && (config.headers === null || typeof config.headers !== 'object' || Array.isArray(config.headers))) {
    delete config.headers;
  }
  // stdio 的 cwd 必须绝对：相对路径会落到宿主进程目录，行为不可预测。
  if (config.cwd !== undefined && (typeof config.cwd !== 'string' || !/^(?:[A-Za-z]:[\\/]|\/)/u.test(config.cwd))) delete config.cwd;
  return { ok: true, config };
}

/**
 * 枚举一个插件要挂的 MCP 服务器（含变量展开与跳过诊断）。
 *
 * @param {object} plugin - effective 插件记录
 * @param {{ cwd: string, pluginDataDir: string }} context
 * @returns {Array<{ serverName: string, config: object }>}
 */
export function collectMcpServers(plugin, context) {
  const pluginId = typeof plugin?.id === 'string' ? plugin.id : '?';
  const servers = plugin?.components?.mcpServers;
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers) || Object.keys(servers).length === 0) return [];
  const vars = variableTable(plugin, context);
  const options = plugin?.options !== null && typeof plugin?.options === 'object' ? plugin.options : {};
  const out = [];
  for (const [rawName, rawConfig] of Object.entries(servers)) {
    const normalizedName = normalizeServerName(rawName);
    if (normalizedName === undefined) {
      warn(`mcp: ${pluginId} server "${rawName}" has an unusable name; skipped`);
      continue;
    }
    if (normalizedName.changed) warn(`mcp: ${pluginId} server "${rawName}" mounted as "${normalizedName.name}" (name must match [A-Za-z0-9_-]{1,32})`);
    // 缺失的 user_config：先于展开判定，否则会被错误地展开成空串。
    const missing = referencedUserConfigKeys(rawConfig).filter((key) => !Object.prototype.hasOwnProperty.call(options, key));
    if (missing.length > 0) {
      warn(`mcp: ${pluginId} server "${normalizedName.name}" references ${missing.map((key) => `\${user_config.${key}}`).join(', ')}, which this plugin's options do not provide; skipped`);
      continue;
    }
    const expanded = expandDeep(rawConfig, vars);
    const normalized = normalizeServerConfig(expanded);
    if (!normalized.ok) {
      warn(`mcp: ${pluginId} server "${normalizedName.name}": ${normalized.reason}; skipped`);
      continue;
    }
    out.push({ serverName: normalizedName.name, config: normalized.config });
  }
  return out;
}

/**
 * 配置里引用的 `${user_config.KEY}` 键（去重，保持出现顺序）。
 *
 * @param {unknown} config
 * @returns {string[]}
 */
function referencedUserConfigKeys(config) {
  let text;
  try {
    text = JSON.stringify(config ?? null);
  } catch {
    return [];
  }
  const keys = [];
  USER_CONFIG_PATTERN.lastIndex = 0;
  let match = USER_CONFIG_PATTERN.exec(text);
  while (match !== null) {
    if (!keys.includes(match[1])) keys.push(match[1]);
    match = USER_CONFIG_PATTERN.exec(text);
  }
  return keys;
}
