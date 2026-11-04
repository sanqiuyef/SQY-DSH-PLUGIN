/**
 * dsh-plugin-hub — marketplace.json 索引（SPEC §4 market.js）。
 *
 * 职责：
 *  - parseMarketIndex(text, { indexPath })：解析 ZCode / Claude 形状的 `{ name, owner, plugins: [...] }`，
 *    返回 `{ name?, description?, plugins: MarketEntry[] }`（附带 diagnostics 供 UI 展示）。
 *    **entry.source 原样保留**（字符串或对象），SourceSpec 的解析推迟到 resolveMarketSource：
 *    解析相对路径需要索引文件位置，而 routes 会把整个 entry 再传回来。
 *  - readLocalIndex(record)：读 record.indexPath；索引缺失/不可读/非法 JSON 时**抛错**
 *    （routes 捕获后按空表处理）。
 *  - resolveMarketSource(entry, record)：纯函数，把原始条目解析成 SPEC 的 SourceSpec；
 *    相对路径按 record.indexPath 所在目录解析。
 *
 * 兼容的 source 形态：字符串相对/绝对路径、http(s) URL，以及对象
 * `{ source: 'directory'|'file'|'git'|'git-subdir'|'github'|'url'|'npm', ... }`。
 * npm 源在 SPEC §1 明确不在 V1 范围，解析时抛 `market-source-unsupported`。
 */

import { lstat, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isRecord } from './manifest.js';
import { isArchivePath } from './sources.js';

/**
 * 商店展示字段的体积上限（catalog 由第三方维护，不能让一个条目把响应撑爆）。
 * 超长文本按前缀截断——详情页需要的是"能认出这是哪个插件"，不是全文。
 */
const MAX_DISPLAY_NAME = 120;
const MAX_DESCRIPTION = 600;
const MAX_ICON = 2048;
const MAX_CATEGORY = 64;
const MAX_KEYWORDS = 12;
const MAX_KEYWORD = 40;
const MAX_AUTHOR = 120;
const MAX_HOMEPAGE = 2048;
const MAX_LICENSE = 120;
/** 条目内联组件声明（lspServers 等）的体积上限：catalog 由第三方维护，不能撑爆响应。 */
const MAX_ENTRY_OVERRIDE_BYTES = 64 * 1024;

/** 允许对外透传的组件类型（与 ZCode PluginComponentType 对齐，额外保留 ui）。 */
const COMPONENT_TYPES = new Set(['agent', 'command', 'skill', 'hook', 'mcp', 'lsp', 'ui']);

/** 市场条目的展示元数据：全部可选，缺字段由 UI 降级，不做兜底伪造。 */
function readListing(raw) {
  const listing = {};

  const displayName = pickText(raw.displayName, MAX_DISPLAY_NAME);
  if (displayName !== undefined) listing.displayName = displayName;
  const displayNameI18n = pickLocaleMap(raw.displayName_i18n ?? raw.displayNameI18n, MAX_DISPLAY_NAME);
  if (displayNameI18n !== undefined) listing.displayNameI18n = displayNameI18n;
  // 条目自带 description 已由外层处理；这里只收多语言覆盖与其余展示字段。
  const descriptionI18n = pickLocaleMap(raw.description_i18n ?? raw.descriptionI18n, MAX_DESCRIPTION);
  if (descriptionI18n !== undefined) listing.descriptionI18n = descriptionI18n;

  const icon = pickIcon(raw.icon);
  if (icon !== undefined) listing.icon = icon;
  const category = pickText(raw.category, MAX_CATEGORY);
  if (category !== undefined) listing.category = category.toLowerCase();
  const keywords = pickKeywords(raw.keywords ?? raw.tags);
  if (keywords !== undefined) listing.keywords = keywords;

  const publisherType = raw.publisherType === 'official' || raw.publisherType === 'community'
    ? raw.publisherType
    : undefined;
  if (publisherType !== undefined) listing.publisherType = publisherType;

  const componentTypes = pickComponentTypes(raw.componentTypes, raw.lspServers !== undefined);
  if (componentTypes !== undefined) listing.componentTypes = componentTypes;

  const author = pickAuthor(raw.author);
  if (author !== undefined) listing.author = author;

  // Claude 官方目录里 homepage 是条目级字段（仓库内子目录地址），license 偶有出现。
  const homepage = pickUrl(raw.homepage ?? raw.homePage);
  if (homepage !== undefined) listing.homepage = homepage;
  const license = pickText(raw.license, MAX_LICENSE);
  if (license !== undefined) listing.license = license;

  return listing;
}

function pickText(value, max) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text === '') return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 只收 `{ locale: text }` 形状；键必须是语言 id，值必须是非空字符串。 */
function pickLocaleMap(value, max) {
  if (!isRecord(value)) return undefined;
  const out = {};
  for (const [locale, text] of Object.entries(value)) {
    const picked = pickText(text, max);
    if (picked === undefined) continue;
    if (!/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(locale)) continue;
    out[locale] = picked;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** 图标只接受 http(s) / data:image：其他协议（file:、javascript:）不进渲染层。 */
function pickIcon(value) {
  const text = pickText(value, MAX_ICON);
  if (text === undefined) return undefined;
  return /^(https?:\/\/|data:image\/)/i.test(text) ? text : undefined;
}

/** 主页只接受 http(s)：`file:` / `javascript:` 之类不进可点击链接。 */
function pickUrl(value) {
  const text = pickText(value, MAX_HOMEPAGE);
  if (text === undefined) return undefined;
  return /^https?:\/\//i.test(text) ? text : undefined;
}

function pickKeywords(value) {
  if (!Array.isArray(value)) return undefined;
  const out = [];
  for (const item of value) {
    const keyword = pickText(item, MAX_KEYWORD);
    if (keyword === undefined) continue;
    if (!out.includes(keyword)) out.push(keyword);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out.length === 0 ? undefined : out;
}

/** 组件类型白名单顺序：卡片上的徽章顺序必须稳定，不能跟着 catalog 的写法摇摆。 */
const COMPONENT_TYPE_ORDER = [...COMPONENT_TYPES];

/**
 * 组件类型白名单过滤（按白名单顺序输出）。
 *
 * `declaresLsp` 来自条目里的 lspServers：Claude 目录有一批「语言服务器插件」
 * 只在这一层声明组件（包里连 plugin.json 都没有），不补这一位卡片上就什么组件都显示不出来。
 */
function pickComponentTypes(value, declaresLsp = false) {
  const seen = new Set();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const kind = item.trim().toLowerCase();
      if (COMPONENT_TYPES.has(kind)) seen.add(kind);
    }
  }
  if (declaresLsp) seen.add('lsp');
  return seen.size === 0 ? undefined : COMPONENT_TYPE_ORDER.filter((kind) => seen.has(kind));
}

function pickAuthor(value) {
  if (typeof value === 'string') return pickText(value, MAX_AUTHOR);
  if (!isRecord(value)) return undefined;
  return pickText(value.name, MAX_AUTHOR);
}

/** 市场索引解析失败的结构化错误（带稳定 code，便于 routes 映射）。 */
export class MarketError extends Error {
  /**
   * @param {'market-index-missing'|'market-index-invalid'|'market-index-unreadable'
   *   |'market-entry-invalid'|'market-source-unsupported'} code
   * @param {string} message
   * @param {string} [path]
   */
  constructor(code, message, path) {
    super(message);
    this.name = 'MarketError';
    this.code = code;
    if (typeof path === 'string' && path !== '') this.path = path;
  }

  toJSON() {
    return this.path ? { code: this.code, message: this.message, path: this.path } : { code: this.code, message: this.message };
  }
}

/** 是否本模块抛出的结构化错误。 */
export function isMarketError(error) {
  return error instanceof MarketError;
}

// ============================================================
// 解析
// ============================================================

/**
 * 解析 marketplace.json 文本。
 *
 * 单个坏条目不会毁掉整张索引：缺少 name/source 的条目进 diagnostics 后跳过，
 * 其余条目照常返回（市场文件由第三方维护，容错比 fail-closed 更实用）。
 *
 * @param {string} text
 * @param {{ indexPath?: string }} [options]
 * @returns {{ name?: string, description?: string, owner?: string,
 *   plugins: Array<{name: string, description?: string, version?: string, source: unknown}>,
 *   diagnostics: Array<{code: string, message: string, path?: string}> }}
 */
export function parseMarketIndex(text, options = {}) {
  const indexPath = typeof options?.indexPath === 'string' ? options.indexPath : undefined;
  const result = { plugins: [], diagnostics: [] };
  const report = (code, message) => {
    result.diagnostics.push(indexPath ? { code, message, path: indexPath } : { code, message });
  };

  let data;
  try {
    data = JSON.parse(String(text ?? '').replace(/^\uFEFF/, ''));
  } catch (error) {
    report('market-index-invalid', `marketplace.json 不是合法 JSON：${messageOf(error)}`);
    return result;
  }
  if (!isRecord(data)) {
    report('market-index-invalid', 'marketplace.json 顶层必须是对象');
    return result;
  }

  if (typeof data.name === 'string' && data.name.trim() !== '') result.name = data.name.trim();
  if (typeof data.description === 'string' && data.description.trim() !== '') {
    result.description = data.description.trim();
  }
  if (isRecord(data.owner) && typeof data.owner.name === 'string' && data.owner.name.trim() !== '') {
    result.owner = data.owner.name.trim();
  } else if (typeof data.owner === 'string' && data.owner.trim() !== '') {
    result.owner = data.owner.trim();
  }

  if (!Array.isArray(data.plugins)) {
    report('market-index-invalid', 'marketplace.json 缺少 plugins 数组');
    return result;
  }

  const seen = new Set();
  for (const raw of data.plugins) {
    if (!isRecord(raw)) {
      report('market-entry-invalid', '市场条目必须是对象');
      continue;
    }
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (name === '') {
      report('market-entry-invalid', '市场条目缺少 name');
      continue;
    }
    if (raw.source === undefined || raw.source === null) {
      report('market-entry-invalid', `市场条目缺少 source：${name}`);
      continue;
    }
    if (seen.has(name)) {
      report('market-entry-invalid', `市场条目 name 重复，已忽略后者：${name}`);
      continue;
    }
    seen.add(name);

    // 契约：保留 name / description / version 与**原始 source**；解析成 SourceSpec 是
    // resolveMarketSource 的职责（routes 会把整个 entry 再传回来）。
    const entry = { name, source: raw.source };
    const description = pickText(raw.description, MAX_DESCRIPTION);
    if (description !== undefined) entry.description = description;
    const version = typeof raw.version === 'string'
      ? raw.version.trim()
      : typeof raw.version === 'number'
        ? String(raw.version)
        : '';
    if (version !== '') entry.version = version;
    // 商店展示元数据（图标/分类/关键词/发布者/组件类型）原样透传，缺失即省略：
    // 这些字段来自第三方 catalog，UI 必须能在缺字段时正常降级。
    Object.assign(entry, readListing(raw));

    // Claude 目录允许把组件声明写在条目里（strict:false 的 LSP 插件就是这样）。
    // 这里原样带出，安装时若包里没有 plugin.json 就用它合成清单。
    if (isRecord(raw.lspServers) || typeof raw.lspServers === 'string' || Array.isArray(raw.lspServers)) {
      if (JSON.stringify(raw.lspServers).length <= MAX_ENTRY_OVERRIDE_BYTES) entry.lspServers = raw.lspServers;
    }
    if (raw.strict === false) entry.strict = false;
    result.plugins.push(entry);
  }

  return result;
}

/**
 * 读取本地缓存的索引文件。
 * 缺失/不可读/非法 JSON 抛错（routes 捕获后展示空市场，比静默空表更容易定位问题）。
 *
 * @param {{ indexPath?: string, name?: string }} record
 * @returns {Promise<{name?: string, description?: string, plugins: object[],
 *   diagnostics: Array<{code: string, message: string, path?: string}>}>}
 */
export async function readLocalIndex(record) {
  const indexPath = typeof record?.indexPath === 'string' ? record.indexPath.trim() : '';
  if (indexPath === '') {
    throw new MarketError(
      'market-index-missing',
      '市场记录没有 indexPath（本地索引路径），请先刷新该市场',
    );
  }

  const info = await lstat(indexPath).catch(() => null);
  if (info === null) {
    throw new MarketError('market-index-missing', `市场索引文件不存在：${indexPath}`, indexPath);
  }
  if (info.isSymbolicLink()) {
    // 索引文件同样不跟随链接：链接可以指向任意 JSON，让"市场条目"变成根外内容。
    throw new MarketError('market-index-unreadable', `市场索引文件是符号链接，已拒绝：${indexPath}`, indexPath);
  }
  if (!info.isFile()) {
    throw new MarketError('market-index-unreadable', `市场索引路径不是普通文件：${indexPath}`, indexPath);
  }

  let text;
  try {
    text = await readFile(indexPath, 'utf8');
  } catch (error) {
    throw new MarketError('market-index-unreadable', `市场索引读取失败：${messageOf(error)}`, indexPath);
  }

  const parsed = parseMarketIndex(text, { indexPath });
  const invalid = parsed.diagnostics.find((item) => item.code === 'market-index-invalid');
  if (invalid) throw new MarketError('market-index-invalid', invalid.message, indexPath);
  return parsed;
}

// ============================================================
// SourceSpec 解析
// ============================================================

/**
 * 把原始市场条目解析成 SPEC 的 SourceSpec（纯函数：不读盘、不联网）。
 *
 * entry 是 parseMarketIndex 里的原始条目（`{ name, source }`）；为方便测试也接受
 * 直接传原始 source 值本身。
 *
 * @param {object|string} entry
 * @param {{ indexPath?: string, baseDir?: string }} record
 * @returns {{kind: 'directory'|'git'|'archive', path?: string, url?: string, ref?: string}}
 */
export function resolveMarketSource(entry, record) {
  const rawSource = isRecord(entry) && Object.prototype.hasOwnProperty.call(entry, 'source')
    ? entry.source
    : entry;
  const baseDir = baseDirOf(record);

  if (typeof rawSource === 'string') return resolveStringSource(rawSource, baseDir);
  if (isRecord(rawSource)) return resolveObjectSource(rawSource, baseDir);
  throw new MarketError('market-entry-invalid', '市场条目缺少合法的 source（字符串或对象）');
}

/**
 * 索引所在目录；没有 indexPath 时退化为 record.baseDir（测试/内联索引可用）。
 *
 * 索引放在 `.claude-plugin/`（或 `.zcode-plugin/`）里时，条目的相对路径以**仓库根**为基准：
 * Claude 官方目录里 `"./plugins/claude-security"` 指的是仓库根的 plugins/ 目录，
 * 按清单目录去解析会多拼一层 `.claude-plugin/`（表现为"来源目录不存在"）。
 */
function baseDirOf(record) {
  if (typeof record?.indexPath === 'string' && record.indexPath.trim() !== '') {
    const dir = dirname(resolve(record.indexPath.trim()));
    return basename(dir).startsWith('.') ? dirname(dir) : dir;
  }
  if (typeof record?.baseDir === 'string' && record.baseDir.trim() !== '') {
    return resolve(record.baseDir.trim());
  }
  return null;
}

/** 字符串 source：URL / file URL / 本地路径（相对按索引目录解析），再按扩展名分归档或目录。 */
function resolveStringSource(raw, baseDir) {
  const text = raw.trim();
  if (text === '') throw new MarketError('market-entry-invalid', 'source 为空字符串');

  if (/^https?:\/\//i.test(text)) return { kind: 'archive', url: text };

  if (/^file:/i.test(text)) {
    let localPath;
    try {
      localPath = fileURLToPath(text);
    } catch (error) {
      throw new MarketError('market-entry-invalid', `file: 地址非法：${messageOf(error)}`);
    }
    return localPathSpec(localPath);
  }

  return localPathSpec(resolveLocalPath(text, baseDir));
}

/** 对象 source：按 `source` 字段分派；github/git 统一落成 git SourceSpec。 */
function resolveObjectSource(raw, baseDir) {
  const kind = typeof raw.source === 'string' ? raw.source.trim().toLowerCase() : '';
  switch (kind) {
    case 'directory': {
      const localPath = requirePath(raw, baseDir, 'directory');
      return { kind: 'directory', path: localPath };
    }
    case 'file': {
      // file 既可能是目录也可能是 zip：没有 stat（纯函数）只能按扩展名判，归档走 file:// URL。
      const localPath = requirePath(raw, baseDir, 'file');
      return localPathSpec(localPath);
    }
    case 'git': {
      const url = requireUrl(raw, 'git');
      return gitSpec(url, raw);
    }
    case 'git-subdir': {
      // Claude marketplace 的常用形态：repo URL + 仓库内 path（monorepo 插件）。
      const url = requireUrl(raw, 'git-subdir');
      const subPath = normalizeSubPath(raw.path);
      if (!subPath) throw new MarketError('market-entry-invalid', 'git-subdir 源缺少仓库内 path');
      return gitSpec(url, raw, subPath);
    }
    case 'github': {
      const repo = typeof raw.repo === 'string' ? raw.repo.trim() : '';
      if (repo === '') throw new MarketError('market-entry-invalid', 'github 源缺少 repo');
      const url = /^https?:\/\//i.test(repo) || repo.startsWith('git@')
        ? repo
        : `https://github.com/${repo.replace(/^\/+/, '').replace(/\.git$/i, '')}.git`;
      return gitSpec(url, raw, normalizeSubPath(raw.path));
    }
    case 'url': {
      const url = requireUrl(raw, 'url');
      // Claude 官方目录把 Git 仓库也写成 url 源（`…/repo.git`）。按形状分派到克隆，
      // 否则会把 git 仓库当 zip 下载，得到一个坏归档（表现为"安装报错但看不出为什么"）。
      if (/^(git@|git:\/\/)/i.test(url) || /\.git\/?$/i.test(url)) return gitSpec(url, raw);
      if (!/^https?:\/\//i.test(url)) {
        throw new MarketError('market-entry-invalid', `url 源必须是 http(s) 地址：${url}`);
      }
      return { kind: 'archive', url };
    }
    case 'npm':
      throw new MarketError('market-source-unsupported', 'V1 不支持 npm 源（SPEC §1）');
    case 'pip':
      throw new MarketError('market-source-unsupported', 'V1 不支持 pip 源（SPEC §1）');
    default:
      throw new MarketError(
        'market-source-unsupported',
        `不支持的 source 类型：${kind || '(缺失)'}`,
      );
  }
}

/** github/git 共用：ref 优先，sha 只在没有 ref 时兜底（shallow clone 无法直接固定 sha，V1 仅透传）。 */
function gitSpec(url, raw, forcedSubPath) {
  const ref = firstString(raw.ref, raw.branch, raw.sha);
  const subPath = forcedSubPath ?? normalizeSubPath(raw.path);
  const spec = { kind: 'git', url };
  if (ref) spec.ref = ref;
  if (subPath) spec.path = subPath;
  return spec;
}

/** 仓库内子路径：拒绝绝对路径与 `..`（纵深防御；物化阶段还会再过一次 resolveInside）。 */
function normalizeSubPath(value) {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.trim().replace(/^\.\/+/, '');
  if (cleaned === '') return undefined;
  if (isAbsoluteLike(cleaned) || cleaned.split(/[\\/]+/).includes('..')) {
    throw new MarketError('market-entry-invalid', `source.path 必须是仓库内相对路径：${value}`);
  }
  return cleaned;
}

/** 本地路径 source：相对路径按索引目录解析；绝对路径直接用。 */
function requirePath(raw, baseDir, kind) {
  const value = typeof raw.path === 'string' ? raw.path.trim() : '';
  if (value === '') throw new MarketError('market-entry-invalid', `${kind} 源缺少 path`);
  return resolveLocalPath(value, baseDir);
}

function requireUrl(raw, kind) {
  const value = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (value === '') throw new MarketError('market-entry-invalid', `${kind} 源缺少 url`);
  return value;
}

function resolveLocalPath(rawPath, baseDir) {
  const cleaned = rawPath.replace(/^\.\/+/, '');
  if (isAbsoluteLike(cleaned)) return resolve(cleaned);
  if (baseDir === null) {
    // 相对路径的基准是索引文件所在目录；拿不到基准就无法安全解释（不能按进程 cwd 猜）。
    throw new MarketError(
      'market-index-missing',
      `相对 source 需要索引文件位置：${rawPath}（record.indexPath 缺失）`,
    );
  }
  return resolve(baseDir, cleaned);
}

/** 本地路径按扩展名分流：归档编码成 file:// URL，交给 sources.downloadTo 的 file: 分支。 */
function localPathSpec(localPath) {
  const absolute = resolve(localPath);
  return isArchivePath(absolute)
    ? { kind: 'archive', url: pathToFileURL(absolute).href }
    : { kind: 'directory', path: absolute };
}

function isAbsoluteLike(value) {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function messageOf(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
