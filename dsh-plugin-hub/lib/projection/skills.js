/**
 * dsh-plugin-hub / projection — per-Agent skill provider.
 *
 * 一个已启用插件 → agent.ctx 上的**一个** skills provider（名字带 pluginId）。挂到
 * `agent.ctx` 的 provider 只会进入该 Agent 的 scope 层，因此同一个插件在 A 会话里
 * 生效、在 B 会话里没启用时互不影响。
 *
 * 契约核对（@deepseek-ai/dsh-skill 的 registerProvider/validateCandidate）：
 *   - provider 必须有 `{ name, list(options), get(candidate, options) }`；
 *   - `list` 返回 `SkillCandidate[]` 或 `{ candidates, complete }`；
 *   - candidate 必填：name（kebab-case）、description（非空）、invocation、
 *     source（字符串）、provider（必须等于 provider 名）、rank（有限数）；
 *     可选：path、whenToUse、resourceBase、locator、metadata；
 *   - `get` 返回的 SkillDefinition 必须有字符串 `content`。
 *
 * 两条硬规则（SPEC §6 + Lead 要求）：
 *   1. 技能文件路径只能来自 effective 结果（不自己遍历插件目录找技能）；
 *   2. 每次读文件前做「是否仍在插件根内」+「路径上无符号链接」的二次校验，
 *      并且 **不跟随符号链接** —— 一个 `skills/x -> C:\Windows` 的链接不能让
 *      模型把插件根外的文件读进上下文。
 *
 * 内容不缓存：`list()` 每次都重新读 frontmatter，`get()` 每次都重新读全文，
 * 这样用户直接改 SKILL.md 后下一次 skill 目录刷新就能看到（不需要先改配置）。
 */

import { lstat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

/** 本插件的技能来源标签；SkillSource 是「字符串 + 扩展」所以自定义值合法。 */
export const SKILL_SOURCE = 'plugin-hub';

/**
 * 层内排名。只在「同一个 scope 层的同名技能」之间比较：
 * 选择 350 = 高于 CUSTOM(300)/USER_DSH(400) 里靠前的自定义目录、低于 project 系
 * (100/200)，即「项目自带优先，其次插件，最后用户目录」。
 */
export const PLUGIN_SKILL_RANK = 350;

/** 与 dsh-skill 的公开技能名文法保持一致，避免候选在服务端校验时被整批拒绝。 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** frontmatter 里最多向上走这么多级做符号链接检查（防御异常路径导致的长循环）。 */
const MAX_PATH_DEPTH = 64;

/** 单次 frontmatter 读取上限，防止把巨型文件读进内存。 */
const MAX_SKILL_BYTES = 1024 * 1024;

/** 输出/诊断里统一的告警前缀（SPEC §7：只在失败/降级处 warn）。 */
function warn(message) {
  console.warn(`[plugin-hub] ${message}`);
}

/**
 * 判断名字是否是合法的 kebab-case 技能名。
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isSkillName(name) {
  return typeof name === 'string' && SKILL_NAME.test(name);
}

/* ------------------------------------------------------------------ *
 * frontmatter（YAML 子集）
 * ------------------------------------------------------------------ */

/**
 * 解析 `---` 包裹的 frontmatter。
 *
 * 这里只实现 frontmatter 实际会用到的一小撮 YAML：`key: value`、引号字符串、
 * `>` / `|` 块标量、`a | b` 之外的简单嵌套（取 `a.b` 时退化为原始对象）。
 * 刻意不引入 yaml 依赖（零依赖规则）。解析不了就返回 undefined，由调用方当作
 * 「不是技能文件」跳过 —— 比抛错把整批候选打断要安全。
 *
 * @param {string} raw - 文件全文
 * @returns {{ data: Record<string, unknown>, body: string } | undefined}
 */
export function parseFrontmatter(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') return undefined;
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      end = index;
      break;
    }
  }
  if (end < 0) return undefined;
  return {
    data: parseFrontmatterBlock(lines.slice(1, end)),
    body: lines.slice(end + 1).join('\n'),
  };
}

/**
 * 把 frontmatter 行块解析成平面对象（一层嵌套会用 `key.sub` 存，取用时只看顶层）。
 *
 * @param {string[]} lines
 * @returns {Record<string, unknown>}
 */
function parseFrontmatterBlock(lines) {
  const data = {};
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      index += 1;
      continue;
    }
    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (match === null) {
      // 顶层出现无法识别的行（例如列表项），忽略；不因此判定文件非法。
      index += 1;
      continue;
    }
    const key = match[1];
    const rest = match[2].trim();
    if (rest === '|' || rest === '>' || rest === '|-' || rest === '|+' || rest === '>-' || rest === '>+') {
      const { value, nextIndex } = readBlockScalar(lines, index + 1, rest.startsWith('>'));
      data[key] = value;
      index = nextIndex;
      continue;
    }
    if (rest === '') {
      // 空值：可能是嵌套 map 也可能是空字符串；向后收集缩进行并按 `k: v` 拍平。
      const collected = [];
      let nextIndex = index + 1;
      while (nextIndex < lines.length && /^\s+\S/.test(lines[nextIndex])) {
        collected.push(lines[nextIndex].trim());
        nextIndex += 1;
      }
      if (collected.length === 0) data[key] = '';
      else if (collected.every((entry) => /^[A-Za-z0-9_.-]+\s*:/.test(entry))) {
        data[key] = Object.fromEntries(
          collected.map((entry) => {
            const nested = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(entry);
            return [nested[1], parseScalar(nested[2].trim())];
          }),
        );
      } else data[key] = collected.join(' ');
      index = nextIndex;
      continue;
    }
    data[key] = parseScalar(rest);
    index += 1;
  }
  return data;
}

/**
 * 读取 `|` / `>` 块标量。
 *
 * @param {string[]} lines
 * @param {number} start - 块标量第一行
 * @param {boolean} folded - true 表示 `>`（换行折成空格）
 * @returns {{ value: string, nextIndex: number }}
 */
function readBlockScalar(lines, start, folded) {
  const collected = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '') {
      collected.push('');
      index += 1;
      continue;
    }
    if (!/^\s+\S/.test(line)) break;
    collected.push(line.trim());
    index += 1;
  }
  const text = folded ? collected.join(' ').replace(/\s+/g, ' ').trim() : collected.join('\n').trim();
  return { value: text, nextIndex: index };
}

/**
 * 解析单个标量：引号、布尔、数字、空值。行尾 ` #` 注释在非引号值里会被去掉。
 *
 * @param {string} raw
 * @returns {string | number | boolean | null}
 */
function parseScalar(raw) {
  const text = raw.trim();
  if (text === '') return '';
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1).replace(/''/g, "'");
  const withoutComment = text.replace(/\s+#.*$/, '').trim();
  if (/^(true|yes|on)$/i.test(withoutComment)) return true;
  if (/^(false|no|off)$/i.test(withoutComment)) return false;
  if (/^-?\d+$/.test(withoutComment)) return Number.parseInt(withoutComment, 10);
  return withoutComment;
}

/**
 * 读 frontmatter 布尔值；只接受真正的布尔/字符串布尔，其他一律 undefined。
 *
 * @param {Record<string, unknown>} data
 * @param {string} key
 * @returns {boolean | undefined}
 */
function frontmatterBoolean(data, key) {
  const value = data[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^(true|yes|on)$/i.test(value)) return true;
    if (/^(false|no|off)$/i.test(value)) return false;
  }
  return undefined;
}

/**
 * 读调用策略，语义与 dsh-skill-filesystem 一致：
 *   缺省 → 模型可调用、用户可调用；`disable-model-invocation` 关模型侧，
 *   `user-invocable: false` 关用户侧。
 *
 * @param {Record<string, unknown>} data
 * @returns {{ modelInvocable: boolean, userInvocable: boolean }}
 */
export function readInvocation(data) {
  return {
    modelInvocable: frontmatterBoolean(data, 'disable-model-invocation') !== true,
    userInvocable: frontmatterBoolean(data, 'user-invocable') !== false,
  };
}

/**
 * 读取并解析一个技能文件（全文，含正文）。
 *
 * @param {string} filePath - 绝对路径（来自 effective 结果）
 * @returns {Promise<{ ok: true, name: string, description: string, whenToUse?: string,
 *   invocation: { modelInvocable: boolean, userInvocable: boolean }, content: string }
 *   | { ok: false, reason: string }>}
 */
export async function readSkillFile(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    return { ok: false, reason: `cannot read ${filePath}: ${error?.message ?? error}` };
  }
  if (raw.length > MAX_SKILL_BYTES) return { ok: false, reason: `${filePath} is larger than ${MAX_SKILL_BYTES} bytes` };
  const parsed = parseFrontmatter(raw);
  if (parsed === undefined) return { ok: false, reason: `${filePath} has no YAML frontmatter` };
  const { data } = parsed;
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  if (name === '') return { ok: false, reason: `${filePath} frontmatter requires "name"` };
  if (!isSkillName(name)) return { ok: false, reason: `${filePath} has an invalid skill name "${name}"` };
  if (description === '') return { ok: false, reason: `${filePath} frontmatter requires "description"` };
  const whenToUse = typeof data.whenToUse === 'string' ? data.whenToUse.trim() : '';
  return {
    ok: true,
    name,
    description,
    ...(whenToUse === '' ? {} : { whenToUse }),
    invocation: readInvocation(data),
    content: parsed.body.trim(),
  };
}

/* ------------------------------------------------------------------ *
 * 路径围栏
 * ------------------------------------------------------------------ */

/**
 * 词法围栏：`target` 必须严格位于 `rootPath` 内（等于 root 也算不合法，因为技能是文件）。
 *
 * @param {string} rootPath
 * @param {string} target
 * @returns {boolean}
 */
export function isInsideRoot(rootPath, target) {
  if (typeof rootPath !== 'string' || typeof target !== 'string') return false;
  const root = resolve(rootPath);
  const abs = resolve(target);
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
  return true;
}

/**
 * 符号链接围栏：从 target 向上到 root（含两端）逐级 lstat，任何一级是符号链接就拒绝。
 *
 * 之所以不 `realpath` 后再比较：realpath 会把链接「跟过去」，那样链接目标在根外也能
 * 通过校验，正好绕开围栏。Windows 的 junction 在 libuv 里同样表现为 reparse point，
 * `isSymbolicLink()` 为 true，所以同一套判断覆盖 junction。
 *
 * @param {string} rootPath
 * @param {string} target
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function checkPathFence(rootPath, target) {
  if (!isInsideRoot(rootPath, target)) return { ok: false, reason: `${target} is outside the plugin root ${rootPath}` };
  const root = resolve(rootPath);
  const abs = resolve(target);
  // Windows 路径大小写不敏感：配置里 `C:\Cache\x` 与 `c:\cache\x` 是同一个目录，
  // 用区分大小写的 === 会在走到根之前就失败，误报「无法确认在根内」。
  const samePath = (left, right) => (process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right);
  let current = abs;
  for (let depth = 0; depth < MAX_PATH_DEPTH; depth += 1) {
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      const code = error?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: `${current} no longer exists` };
      return { ok: false, reason: `cannot inspect ${current}: ${error?.message ?? error}` };
    }
    if (info.isSymbolicLink()) return { ok: false, reason: `${current} is a symbolic link (not followed)` };
    if (samePath(current, root)) return { ok: true };
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // 词法上在根内却没能走到根（例如大小写/规范化差异）：保守拒绝而不是放行。
  return { ok: false, reason: `could not verify that ${abs} lives under ${root}` };
}

/* ------------------------------------------------------------------ *
 * provider
 * ------------------------------------------------------------------ */

/**
 * 从 effective 插件记录里收集技能入口（只做形状过滤，不读文件内容）。
 *
 * @param {object} plugin
 * @returns {Array<{ path: string, directory: string, name?: string, description?: string }>}
 */
function collectSkillEntries(plugin) {
  const items = plugin?.components?.skills;
  if (!Array.isArray(items)) return [];
  const entries = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;
    if (typeof item.path !== 'string' || item.path === '') continue;
    const path = resolve(item.path);
    const directory = typeof item.root === 'string' && item.root !== '' ? resolve(item.root) : dirname(path);
    entries.push({
      path,
      directory,
      ...(typeof item.name === 'string' ? { name: item.name } : {}),
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
    });
  }
  return entries;
}

/**
 * 构造一个只包含单一 skills 注册的 Cordis 插件对象。
 *
 * 不直接 `ctx.skills.registerProvider()` 而是包一层 `ctx.plugin()`：SPEC §4 要求
 * 每个插件一个挂载单元，fiber 的 dispose 会连带撤销 provider 注册，卸载/换 cwd 时
 * 不必手工追踪每个 disposer。
 *
 * @param {object} plugin - effective 插件记录（id / rootPath / components.skills）
 * @param {{ cwd?: string }} [context] - 目前无需 cwd：技能路径一律取 effective 里的绝对路径
 * @returns {{ name: string, inject: string[], apply: Function } | null}
 */
export function createSkillsUnit(plugin, context = {}) {
  void context;
  const pluginId = typeof plugin?.id === 'string' ? plugin.id : '';
  const rootPath = typeof plugin?.rootPath === 'string' ? resolve(plugin.rootPath) : '';
  if (pluginId === '' || rootPath === '') return null;
  const entries = collectSkillEntries(plugin);
  if (entries.length === 0) return null;
  const providerName = `${SKILL_SOURCE}:${pluginId}`;
  const warnOnce = new Set();

  return {
    name: `${SKILL_SOURCE}:skills:${pluginId}`,
    inject: ['skills'],
    /**
     * @param {object} ctx - 注入 skills 的子上下文（挂到 agent.ctx 后即 agent scope）
     */
    apply(ctx) {
      // control（signal / invalidate）用不上：本 provider 不缓存内容、没有远端初始化。
      ctx.skills.registerProvider(() => ({
        name: providerName,

        /**
         * 每次调用都重新读盘：frontmatter 里的 name/description 可能与 effective
         * 快照不同（用户刚改过文件），以磁盘为准。
         *
         * @param {{ signal?: AbortSignal }} [options]
         * @returns {Promise<Array<object> | { candidates: Array<object>, complete: boolean }>}
         */
        async list(options = {}) {
          options.signal?.throwIfAborted?.();
          const candidates = [];
          let complete = true;
          for (const entry of entries) {
            const fence = await checkPathFence(rootPath, entry.path);
            if (!fence.ok) {
              // 每轮只告警一次，避免 list() 高频调用刷屏。
              if (!warnOnce.has(entry.path)) {
                warnOnce.add(entry.path);
                warn(`skills: skipping ${pluginId} entry ${entry.path}: ${fence.reason}`);
              }
              continue;
            }
            let parsed;
            try {
              parsed = await readSkillFile(entry.path);
            } catch (error) {
              complete = false;
              warn(`skills: reading ${entry.path} failed: ${error?.message ?? error}`);
              continue;
            }
            if (!parsed.ok) {
              if (!warnOnce.has(entry.path)) {
                warnOnce.add(entry.path);
                warn(`skills: skipping ${pluginId} entry: ${parsed.reason}`);
              }
              continue;
            }
            candidates.push({
              name: parsed.name,
              description: parsed.description,
              ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
              invocation: parsed.invocation,
              source: SKILL_SOURCE,
              provider: providerName,
              rank: PLUGIN_SKILL_RANK,
              // locator 是本 provider 私有值：skills 服务会原样传回 get()。
              locator: { path: entry.path, directory: entry.directory },
              path: entry.path,
              resourceBase: { kind: 'directory', path: entry.directory },
            });
          }
          // 有任何一次 IO 意外失败就报告「不完整」，让 skills 服务不要缓存这份快照。
          return complete ? candidates : { candidates, complete };
        },

        /**
         * 读全文。candidate 来自本 provider 的 list()，但这里仍重做一次路径围栏：
         * locator 在 skills 服务的缓存里可能已经过期（插件重装/目录改名）。
         *
         * @param {object} candidate
         * @param {{ signal?: AbortSignal }} [options]
         * @returns {Promise<object | undefined>}
         */
        async get(candidate, options = {}) {
          const locator = candidate?.locator;
          if (locator === null || typeof locator !== 'object' || typeof locator.path !== 'string') return undefined;
          options.signal?.throwIfAborted?.();
          const fence = await checkPathFence(rootPath, locator.path);
          if (!fence.ok) {
            warn(`skills: refusing to load ${locator.path}: ${fence.reason}`);
            return undefined;
          }
          const parsed = await readSkillFile(locator.path);
          if (!parsed.ok) return undefined;
          const directory = typeof locator.directory === 'string' ? locator.directory : dirname(locator.path);
          return {
            name: parsed.name,
            description: parsed.description,
            ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
            invocation: parsed.invocation,
            source: SKILL_SOURCE,
            provider: providerName,
            resourceBase: { kind: 'directory', path: directory },
            path: locator.path,
            content: parsed.content,
          };
        },
      }));
    },
  };
}

/**
 * 供诊断/路由复用的技能入口清单（不读内容）。
 *
 * @param {object} plugin
 * @returns {string[]}
 */
export function skillFilesOf(plugin) {
  return collectSkillEntries(plugin).map((entry) => entry.path);
}
