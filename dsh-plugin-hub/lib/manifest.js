/**
 * dsh-plugin-hub — 插件清单（plugin.json）解析与校验（SPEC §4 manifest.js）。
 *
 * 职责：
 *  - readManifest(rootPath)：按 `.zcode-plugin/plugin.json`（首选）→ 根 `plugin.json`（回退）
 *    读取并校验，返回 `{ ok:true, manifest, manifestPath, format }` 或
 *    `{ ok:false, reason:'missing'|'invalid'|'name', message, manifestPath? }`。
 *  - 词法小工具（resolveInside / isRecord / lstatOrNull / isSymbolicLink）：
 *    并行开发期间 util.js 归 Lead 所有，契约禁止本模块 import 它，所以这里保留一份
 *    极小实现并导出，供 components.js / sources.js / market.js 复用，避免三份漂移。
 *    util.js 落地后语义保持一致（resolveInside 的判据逐行对齐），可直接替换。
 *
 * 安全口径（见 SPEC §6）：清单文件本身也不跟随符号链接——链接可以让"插件内声明"
 * 变成"根外任意 JSON 的内容"，后续所有基于插件根的路径校验就失去意义。
 */

import { readFile, lstat, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative } from 'node:path';

/** 清单 name 合法形状（SPEC §4）：会进入 provider 名 / 斜杠命令名 / MCP 命名空间，放宽会撞名。 */
export const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * 清单候选，顺序即优先级；`format` 回传给调用方做展示与诊断。
 *
 * `.claude-plugin/plugin.json` 排在最后：Claude Code 插件包的清单位置，
 * 与 ZCode 生态共用同样的 skills/ commands/ agents/ hooks/ .mcp.json 布局。
 * 放在最后是为了不让"根 plugin.json + .claude-plugin/plugin.json"并存的历史
 * 插件改变既有解析结果。
 */
export const MANIFEST_CANDIDATES = [
  { relative: '.zcode-plugin/plugin.json', format: 'zcode' },
  { relative: 'plugin.json', format: 'root' },
  { relative: '.claude-plugin/plugin.json', format: 'claude' },
];

/**
 * 从市场条目合成清单用的字段白名单。
 *
 * Claude 的 marketplace 条目在 `strict: false`（或仓库里根本没放 plugin.json）时
 * 自带清单语义：name/description/version 之外还可能有 lspServers 等组件声明。
 * 只白名单复制，不把 source/homepage 之类"分发信息"混进插件清单。
 */
const MANIFEST_FROM_ENTRY_FIELDS = [
  'name',
  'version',
  'description',
  'author',
  'license',
  'homepage',
  'keywords',
  'skills',
  'commands',
  'agents',
  'hooks',
  'mcpServers',
  'lspServers',
  'userConfig',
  'ui',
];

/**
 * 清单体积上限。
 * 正常 plugin.json 只有几 KB；1MiB 以上更像误把构建产物塞进来，直接判 invalid 比
 * 把几十 MB 文本读进内存安全。
 */
const MAX_MANIFEST_BYTES = 1024 * 1024;

/** 是否是普通 JSON 对象（排除 null / 数组）。 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 词法路径防线：把 `target` 解析到 `root` 内，越界返回 null。
 *
 * 纯字符串判断（不 stat），所以复制/扫描前就能挡住绝对路径、盘符路径、UNC 与 `..`
 * 穿越；符号链接逃逸由调用方在 lstat 阶段另行拒绝。
 */
export function resolveInside(root, target) {
  if (typeof root !== 'string' || root === '') return null;
  if (typeof target !== 'string') return null;
  if (target.includes('\0')) return null;
  if (isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target) || target.startsWith('\\\\')) return null;
  const resolvedRoot = normalize(root);
  const resolved = normalize(join(resolvedRoot, target));
  const rel = relative(resolvedRoot, resolved);
  if (rel === '') return resolved;
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return resolved;
}

/** `child` 是否落在 `parent` 内（两侧都应是 normalize 后的绝对路径）。 */
export function isInside(parent, child) {
  const rel = relative(normalize(parent), normalize(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** lstat 便捷封装；路径不存在返回 null（扫描里"不存在"是常态，不该用异常表达）。 */
export async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

/** 是否符号链接 / junction；lstat 对两者都返回 isSymbolicLink() === true。 */
export async function isSymbolicLink(path) {
  const info = await lstatOrNull(path);
  return Boolean(info?.isSymbolicLink());
}

/** 把任意错误压成一行文本（错误对象进 JSON 会变成 `{}`，诊断里只留 message 即可）。 */
export function messageOf(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * 读取并校验插件清单。
 *
 * 不在缺失字段上做兜底伪造：description/version 缺失就缺省，由 UI 降级展示；
 * 未知字段原样保留（SPEC §4：未知字段保留不报错），便于市场条目透传 store listing。
 */
export async function readManifest(rootPath) {
  if (typeof rootPath !== 'string' || rootPath.trim() === '') {
    return { ok: false, reason: 'invalid', message: '插件根目录无效（需要非空路径字符串）' };
  }

  let lastProblem = null;
  for (const candidate of MANIFEST_CANDIDATES) {
    const segments = candidate.relative.split('/');
    const manifestPath = join(rootPath, ...segments);

    // 带子目录的候选（.zcode-plugin/、.claude-plugin/）要连父目录一起看：
    // 父目录被换成链接时，清单实际来自插件根之外，后面的路径校验就全部失效。
    if (segments.length > 1) {
      const dirPath = join(rootPath, ...segments.slice(0, -1));
      const dirInfo = await lstatOrNull(dirPath);
      if (dirInfo === null) continue;
      if (dirInfo.isSymbolicLink()) {
        lastProblem = {
          reason: 'invalid',
          message: `清单目录是符号链接，已拒绝：${dirPath}`,
          manifestPath,
        };
        continue;
      }
      if (!dirInfo.isDirectory()) continue;
    }

    const info = await lstatOrNull(manifestPath);
    if (info === null) continue;

    // 安全：链接清单可以指向根外任意 JSON，读取即等于信任根外内容，直接拒绝。
    if (info.isSymbolicLink()) {
      return {
        ok: false,
        reason: 'invalid',
        message: `清单文件是符号链接，已拒绝：${manifestPath}`,
        manifestPath,
      };
    }
    // 名字叫 plugin.json 的目录不是清单：若首选位置异常，继续回退到下一候选。
    if (!info.isFile()) {
      lastProblem = {
        reason: 'invalid',
        message: `清单路径不是普通文件：${manifestPath}`,
        manifestPath,
      };
      continue;
    }
    if (info.size > MAX_MANIFEST_BYTES) {
      return {
        ok: false,
        reason: 'invalid',
        message: `清单文件过大（>1MiB），已拒绝：${manifestPath}`,
        manifestPath,
      };
    }

    let text;
    try {
      text = await readFile(manifestPath, 'utf8');
    } catch (error) {
      return {
        ok: false,
        reason: 'invalid',
        message: `清单读取失败：${messageOf(error)}`,
        manifestPath,
      };
    }

    let parsed;
    try {
      // BOM 会让 JSON.parse 直接失败；编辑器在 Windows 上保存带 BOM 的 JSON 很常见。
      parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (error) {
      return {
        ok: false,
        reason: 'invalid',
        message: `清单不是合法 JSON：${messageOf(error)}`,
        manifestPath,
      };
    }
    if (!isRecord(parsed)) {
      return {
        ok: false,
        reason: 'invalid',
        message: '清单顶层必须是 JSON 对象',
        manifestPath,
      };
    }

    const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
    if (!PLUGIN_NAME_PATTERN.test(name)) {
      return {
        ok: false,
        reason: 'name',
        message: `清单 name 非法（需匹配 ${PLUGIN_NAME_PATTERN}）：${name || '(缺失)'}`,
        manifestPath,
      };
    }
    // 只做 name 的规范化（去首尾空白）；其余字段保持作者原样，store listing 依赖它们透传。
    if (parsed.name !== name) parsed.name = name;

    return { ok: true, manifest: parsed, manifestPath, format: candidate.format };
  }

  if (lastProblem) return { ok: false, ...lastProblem };
  return {
    ok: false,
    reason: 'missing',
    message: '插件根目录下没有 .zcode-plugin/plugin.json、plugin.json 或 .claude-plugin/plugin.json',
  };
}

// ============================================================
// 从市场条目合成清单（Claude marketplace 的 strict:false 形态）
// ============================================================

/**
 * 把市场条目里"清单语义"的字段挑出来，合成一个最小清单。
 *
 * 只在包里确实没有 plugin.json 时才调用；返回 null 表示这个条目不够格做清单
 * （至少要有合法 name），调用方据此走原来的报错路径，不静默装一个空壳。
 *
 * @param {object|null|undefined} entry 市场条目（parseMarketIndex 的产物）
 * @returns {object|null}
 */
export function manifestFromMarketEntry(entry) {
  if (!isRecord(entry)) return null;
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  if (!PLUGIN_NAME_PATTERN.test(name)) return null;

  const manifest = { name };
  for (const field of MANIFEST_FROM_ENTRY_FIELDS) {
    if (field === 'name') continue;
    const value = entry[field];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (isRecord(value) && Object.keys(value).length === 0) continue;
    manifest[field] = value;
  }
  return manifest;
}

/** 包内是否至少有一样"插件内容"，用来判断合成清单是否合理（避免装一个空目录）。 */
export async function hasPluginContent(rootPath) {  if (typeof rootPath !== 'string' || rootPath === '') return false;
  const markers = [
    ['skills'],
    ['commands'],
    ['agents'],
    ['hooks', 'hooks.json'],
    ['.mcp.json'],
    ['lsp.json'],
  ];
  for (const segments of markers) {
    const info = await lstatOrNull(join(rootPath, ...segments));
    if (info !== null && !info.isSymbolicLink()) return true;
  }
  return false;
}

/**
 * 把合成清单落到包内（`.claude-plugin/plugin.json`）。
 *
 * 目的是让"清单"成为包内唯一真相：组件路由、投影层都按 readManifest 读，
 * 只在 installed 记录里记一份合成结果会让它们读到两份不同的清单。
 * 写的是我们自己 cache 里的副本，不动用户来源。
 *
 * @returns {Promise<string>} 写好的清单路径
 */
export async function writeSynthesizedManifest(rootPath, manifest) {
  const dirPath = join(rootPath, '.claude-plugin');
  await mkdir(dirPath, { recursive: true });
  const manifestPath = join(dirPath, 'plugin.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifestPath;
}
