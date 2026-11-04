/**
 * dsh-plugin-hub — 组件枚举（SPEC §4 components.js）。
 *
 * 职责：
 *  - enumerateComponents(rootPath, manifest)：一次读盘产出 skills / commands / agents / hooks /
 *    mcpServers / uiSurfaces / diagnostics，以及展示用的 groups。
 *  - skillRoots / markdownDirs：默认目录 + manifest 声明目录，去重（同步：投影层在 apply 里同步取）。
 *  - readMarkdownFrontmatter / parseFrontmatter：零依赖 frontmatter（name/description/whenToUse/
 *    argument-hint，支持单行与 `|`/`>` 块标量）。
 *
 * 三条硬规则（对齐 ZCode 参考实现）：
 *  1. 永不抛错：读取/解析问题进 diagnostics，其余组件照常枚举。
 *  2. 一律不跟随符号链接（含 Windows junction）：插件内容不可信，链接可指向根外；
 *     拒绝链接即拒绝逃逸，无需判断链接指向哪里。
 *  3. manifest 声明路径先过 resolveInside 词法防线，绝对路径与 `..` 直接拒绝。
 */

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isRecord, resolveInside } from './manifest.js';

/** 技能入口文件名（ZCode / Claude 一致）。 */
export const SKILL_FILE_NAME = 'SKILL.md';

/**
 * V1 支持的 hook 事件（SPEC §1）。不在表内的事件不进入 components.hooks：枚举结果会被
 * 投影层直接消费，把未实现的 Notification/PreCompact 混进去会让人以为已经生效，
 * 这里改为记录 warning 诊断。
 */
export const SUPPORTED_HOOK_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop']);

const COMPONENT_DIRS = { commands: 'commands', agents: 'agents', skills: 'skills' };
/** 技能目录扫描跳过项：依赖树与点目录都不是技能集合，扫进来只会产生假组件。 */
const IGNORED_SCAN_ENTRIES = new Set(['node_modules']);
/** 展示顺序（与 ZCode contracts.PluginComponentKind 注释一致；lsp 是 Claude 侧新增的末位）。 */
const GROUP_ORDER = ['agent', 'command', 'skill', 'hook', 'mcp', 'lsp'];
/** frontmatter 键名归一：ZCode 用 when_to_use，Claude 生态常见 whenToUse / when-to-use。 */
const FRONTMATTER_ALIASES = new Map([
  ['name', 'name'],
  ['description', 'description'],
  ['whentouse', 'whenToUse'],
  ['when_to_use', 'whenToUse'],
  ['when-to-use', 'whenToUse'],
  ['argumenthint', 'argumentHint'],
  ['argument_hint', 'argumentHint'],
  ['argument-hint', 'argumentHint'],
]);

// ============================================================
// manifest 声明的目录解析
// ============================================================

/** 技能根：默认 `skills/` + manifest 声明，去重。同步返回绝对路径数组。 */
export function skillRoots(rootPath, manifest) {
  return collectComponentDirs(rootPath, fieldOf(manifest, 'skills'), 'skills', []);
}

/** command / agent 的 markdown 目录：默认目录 + manifest 声明，去重。 */
export function markdownDirs(rootPath, manifest, kind) {
  const dirName = COMPONENT_DIRS[kind];
  if (!dirName) return [];
  return collectComponentDirs(rootPath, fieldOf(manifest, kind), dirName, []);
}

/** 从 manifest 取组件字段；manifest 允许为 null（清单解析失败的降级链路）。 */
function fieldOf(manifest, key) {
  return isRecord(manifest) ? manifest[key] : undefined;
}

/**
 * 合并默认目录与 manifest 声明目录。
 * object 形态（`{ name: { description } }`）在 commands/agents 里表达"元数据条目"、没有目录，
 * 所以这里只消费 string / string[]，对象由调用方单独处理。
 */
function collectComponentDirs(rootPath, manifestField, defaultDir, diagnostics) {
  if (typeof rootPath !== 'string' || rootPath === '') return [];
  const dirs = [];
  const seen = new Set();
  const push = (absolutePath) => {
    // Windows 大小写不敏感，按小写去重；POSIX 保持原样。
    const key = process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath;
    if (seen.has(key)) return;
    seen.add(key);
    dirs.push(absolutePath);
  };

  const defaultPath = join(rootPath, defaultDir);
  const defaultInfo = lstatOrNullSync(defaultPath);
  if (defaultInfo?.isSymbolicLink()) {
    // 惯例目录被换成链接是典型逃逸手法：整棵组件树都会落在插件根外。
    diag(diagnostics, 'plugin_symlink_rejected', `默认组件目录是符号链接，已跳过：${defaultPath}`, defaultPath);
  } else if (defaultInfo?.isDirectory()) {
    push(defaultPath);
  }

  const declared = typeof manifestField === 'string'
    ? [manifestField]
    : Array.isArray(manifestField) ? manifestField.filter((item) => typeof item === 'string') : [];

  for (const raw of declared) {
    const cleaned = raw.trim().replace(/^\.\/+/, '');
    if (cleaned === '') continue;
    const resolved = resolveInside(rootPath, cleaned);
    if (!resolved) {
      diag(diagnostics, 'plugin_component_path_invalid', `manifest 声明的 ${defaultDir} 路径越出插件根，已拒绝：${raw}`, rootPath);
      continue;
    }
    const info = lstatOrNullSync(resolved);
    if (!info) {
      diag(diagnostics, 'plugin_component_missing', `manifest 声明的 ${defaultDir} 目录不存在：${raw}`, resolved);
      continue;
    }
    if (info.isSymbolicLink()) {
      diag(diagnostics, 'plugin_symlink_rejected', `manifest 声明的 ${defaultDir} 目录是符号链接，已跳过：${raw}`, resolved);
      continue;
    }
    if (!info.isDirectory()) {
      diag(diagnostics, 'plugin_component_path_invalid', `manifest 声明的 ${defaultDir} 不是目录：${raw}`, resolved);
      continue;
    }
    push(resolved);
  }
  return dirs;
}

// ============================================================
// 枚举入口
// ============================================================

/**
 * 枚举一个插件根下的全部组件（永不抛错）。
 *
 * @param {string} rootPath 插件根绝对路径（物化后的 cache 目录）
 * @param {object|null|undefined} manifest 已解析清单；null 表示降级枚举
 * @param {{ manifestPath?: string }} [options] 诊断里回显的清单路径
 */
export async function enumerateComponents(rootPath, manifest, options = {}) {
  const diagnostics = [];
  const result = {
    groups: [],
    skills: [],
    commands: [],
    agents: [],
    hooks: [],
    mcpServers: {},
    lspServers: {},
    uiSurfaces: [],
    diagnostics,
  };
  if (typeof rootPath !== 'string' || rootPath.trim() === '') {
    diag(diagnostics, 'plugin_root_not_found', '插件根目录无效，无法枚举组件');
    return result;
  }

  let safeManifest = manifest ?? null;
  if (safeManifest !== null && !isRecord(safeManifest)) {
    diag(diagnostics, 'plugin_manifest_invalid', 'manifest 不是对象，已按「无清单」降级枚举', options?.manifestPath);
    safeManifest = null;
  }
  const manifestPath = typeof options?.manifestPath === 'string' ? options.manifestPath : undefined;

  // 每类组件独立兜底：一个损坏的 hooks.json 不该让技能列表整体消失。
  const guard = (code, label, run, fallback) => {
    try {
      return run();
    } catch (error) {
      diag(diagnostics, code, `${label}枚举失败：${messageOf(error)}`, rootPath);
      return fallback;
    }
  };

  result.agents = guard('plugin_component_read_failed', 'agent ', () => collectMarkdownItems(rootPath, safeManifest, 'agents', diagnostics), []);
  result.commands = guard('plugin_component_read_failed', 'command ', () => collectMarkdownItems(rootPath, safeManifest, 'commands', diagnostics), []);
  result.skills = guard('plugin_component_read_failed', 'skill ', () => collectSkillItems(rootPath, safeManifest, diagnostics), []);
  result.hooks = guard('plugin_hook_read_failed', 'hook ', () => collectHooks(rootPath, safeManifest, manifestPath, diagnostics), []);
  result.mcpServers = guard('plugin_mcp_read_failed', 'MCP ', () => collectMcpServers(rootPath, safeManifest, manifestPath, diagnostics), {});
  result.lspServers = guard('plugin_lsp_read_failed', 'LSP ', () => collectLspServers(rootPath, safeManifest, manifestPath, diagnostics), {});
  // lsp 与 mcp 一样只枚举、不投影（V1）；名字列表给展示层直接用。
  result.lsp = Object.keys(result.lspServers);
  result.uiSurfaces = guard('plugin_ui_surface_invalid', 'ui.surfaces ', () => collectUiSurfaces(safeManifest, manifestPath, diagnostics), []);

  result.groups = buildGroups(result);
  return result;
}

/** 组装展示分组：只带 name/description（SPEC §4 groups 形状），顺序固定。 */
function buildGroups(components) {
  const groups = [];
  const brief = (item) => (item.description ? { name: item.name, description: item.description } : { name: item.name });
  const add = (kind, items) => {
    if (items.length > 0) groups.push({ kind, items });
  };

  add('agent', components.agents.map(brief));
  add('command', components.commands.map(brief));
  add('skill', components.skills.map(brief));

  const eventNames = [];
  for (const hook of components.hooks) if (!eventNames.includes(hook.event)) eventNames.push(hook.event);
  add('hook', eventNames.map((name) => ({ name })));
  add('mcp', Object.keys(components.mcpServers).map((name) => ({ name })));
  add('lsp', Object.keys(components.lspServers ?? {}).map((name) => ({ name })));

  // 顺序表是展示契约；万一未来插入新 kind，这里保证已有 kind 的相对顺序不变。
  groups.sort((a, b) => GROUP_ORDER.indexOf(a.kind) - GROUP_ORDER.indexOf(b.kind));
  return groups;
}

// ============================================================
// command / agent（markdown）
// ============================================================

/** 枚举 commands / agents：object 形式声明 + 目录里的 .md 文件。 */
function collectMarkdownItems(rootPath, manifest, kind, diagnostics) {
  const items = [];
  const seen = new Set();
  const field = fieldOf(manifest, kind);

  // object 形式只有元数据、没有文件（ZCode 同款）。
  if (isRecord(field)) {
    for (const [rawName, meta] of Object.entries(field)) {
      const name = rawName.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const description = isRecord(meta) && typeof meta.description === 'string' ? meta.description.trim() : '';
      items.push(withOptional({ name }, { description }));
    }
  } else if (field !== undefined && typeof field !== 'string' && !Array.isArray(field)) {
    diag(diagnostics, 'plugin_component_path_invalid', `manifest.${kind} 必须是字符串、字符串数组或对象，实际是 ${typeof field}`, rootPath);
  }

  for (const dir of collectComponentDirs(rootPath, field, COMPONENT_DIRS[kind], diagnostics)) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      diag(diagnostics, 'plugin_component_read_failed', `目录读取失败：${messageOf(error)}`, dir);
      continue;
    }
    entries.sort(byName);
    for (const entry of entries) {
      const entryPath = join(dir, entry.name);
      // 先判链接再判类型：目录里的 .md 链接同样是文件级逃逸面。
      if (entry.isSymbolicLink()) {
        diag(diagnostics, 'plugin_symlink_rejected', `${kind} 目录中的符号链接已跳过：${entryPath}`, entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      const frontmatter = readMarkdownFrontmatter(entryPath);
      const name = (frontmatter.name || entry.name.slice(0, -'.md'.length)).trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      items.push(withOptional({ name, path: entryPath }, {
        description: frontmatter.description,
        argumentHint: kind === 'commands' ? frontmatter.argumentHint : undefined,
      }));
    }
  }
  return items;
}

// ============================================================
// skills
// ============================================================

/** 枚举技能：根自身含 SKILL.md 即一个技能，再扫一层子目录。 */
function collectSkillItems(rootPath, manifest, diagnostics) {
  const items = [];
  const seenFiles = new Set();
  const seenNames = new Set();
  for (const root of collectComponentDirs(rootPath, fieldOf(manifest, 'skills'), 'skills', diagnostics)) {
    for (const skillFile of scanSkillFiles(root, diagnostics)) {
      const fileKey = skillFile.toLowerCase();
      if (seenFiles.has(fileKey)) continue;
      seenFiles.add(fileKey);

      const frontmatter = readMarkdownFrontmatter(skillFile);
      // 回退名取技能目录名（根技能即根目录名），与 ZCode 一致。
      const name = (frontmatter.name || basename(dirname(skillFile))).trim();
      if (!name || seenNames.has(name)) continue;
      seenNames.add(name);

      items.push(withOptional(
        { name, path: skillFile, root: dirname(skillFile) },
        // whenToUse 是 SPEC §4 skills 形状之外的新增字段：投影层拼技能提示词要用（ZCode 同样消费）。
        { description: frontmatter.description, whenToUse: frontmatter.whenToUse },
      ));
    }
  }
  return items;
}

/** 扫描一个技能根的 SKILL.md：根自身 + 一层子目录；不跟随符号链接。 */
function scanSkillFiles(rootPath, diagnostics) {
  const rootInfo = lstatOrNullSync(rootPath);
  if (!rootInfo) return [];
  if (rootInfo.isSymbolicLink()) {
    diag(diagnostics, 'plugin_symlink_rejected', `技能根是符号链接，已跳过：${rootPath}`, rootPath);
    return [];
  }
  if (!rootInfo.isDirectory()) return [];

  const files = [];
  const own = join(rootPath, SKILL_FILE_NAME);
  const ownInfo = lstatOrNullSync(own);
  if (ownInfo?.isSymbolicLink()) diag(diagnostics, 'plugin_symlink_rejected', `SKILL.md 是符号链接，已跳过：${own}`, own);
  else if (ownInfo?.isFile()) files.push(own);

  let entries;
  try {
    entries = readdirSync(rootPath, { withFileTypes: true });
  } catch (error) {
    diag(diagnostics, 'plugin_component_read_failed', `技能目录读取失败：${messageOf(error)}`, rootPath);
    return files;
  }
  entries.sort(byName);
  for (const entry of entries) {
    if (entry.name.startsWith('.') || IGNORED_SCAN_ENTRIES.has(entry.name)) continue;
    const entryPath = join(rootPath, entry.name);
    if (entry.isSymbolicLink()) {
      // 目录级链接指向根外任意目录：拒绝即无逃逸，无需 realpath 判定。
      diag(diagnostics, 'plugin_symlink_rejected', `技能目录中的符号链接已跳过：${entryPath}`, entryPath);
      continue;
    }
    if (!entry.isDirectory()) continue;
    const candidate = join(entryPath, SKILL_FILE_NAME);
    const info = lstatOrNullSync(candidate);
    if (info?.isSymbolicLink()) {
      diag(diagnostics, 'plugin_symlink_rejected', `SKILL.md 是符号链接，已跳过：${candidate}`, candidate);
      continue;
    }
    // 分类目录（skills/engineering/）没有 SKILL.md，拼出来的路径不存在，不能计为技能。
    if (info?.isFile()) files.push(candidate);
  }
  return files;
}

// ============================================================
// hooks
// ============================================================

/**
 * 解析 hook：`hooks/hooks.json` 与 manifest.hooks。
 * 兼容 `{ EventName: [{ matcher?, hooks: [{ type:'command', command, timeout? }] }] }`、
 * 扁平写法 `{ EventName: [{ command }] }` 与字符串项。
 */
function collectHooks(rootPath, manifest, manifestPath, diagnostics) {
  const sources = [];
  const standardPath = join(rootPath, 'hooks', 'hooks.json');
  const standardInfo = lstatOrNullSync(standardPath);
  if (standardInfo?.isSymbolicLink()) {
    diag(diagnostics, 'plugin_symlink_rejected', `hooks.json 是符号链接，已跳过：${standardPath}`, standardPath);
  } else if (standardInfo?.isFile()) {
    const raw = readJsonSafe(standardPath, 'plugin_hook_read_failed', diagnostics);
    if (raw !== undefined) sources.push({ raw, wrapper: true, sourcePath: standardPath });
  }

  const spec = fieldOf(manifest, 'hooks');
  if (spec !== undefined) {
    for (const item of Array.isArray(spec) ? spec : [spec]) {
      if (typeof item === 'string') {
        const resolved = resolveInside(rootPath, item.trim().replace(/^\.\/+/, ''));
        if (!resolved) {
          diag(diagnostics, 'plugin_component_path_invalid', `manifest.hooks 路径越出插件根，已拒绝：${item}`, manifestPath);
          continue;
        }
        const info = lstatOrNullSync(resolved);
        if (info?.isSymbolicLink()) {
          diag(diagnostics, 'plugin_symlink_rejected', `manifest.hooks 路径是符号链接，已跳过：${item}`, resolved);
          continue;
        }
        if (!info?.isFile()) {
          diag(diagnostics, 'plugin_hook_read_failed', `manifest.hooks 文件不存在：${item}`, resolved);
          continue;
        }
        const raw = readJsonSafe(resolved, 'plugin_hook_read_failed', diagnostics);
        if (raw !== undefined) sources.push({ raw, wrapper: true, sourcePath: resolved });
      } else if (isRecord(item)) {
        sources.push({ raw: item, wrapper: false, sourcePath: manifestPath });
      } else {
        diag(diagnostics, 'plugin_hook_invalid', 'manifest.hooks 项必须是对象、文件路径或它们的数组', manifestPath);
      }
    }
  }

  const hooks = [];
  const seen = new Set();
  for (const source of sources) {
    const hooksRoot = pickHooksRoot(source.raw);
    if (!hooksRoot) {
      diag(diagnostics, 'plugin_hook_invalid', source.wrapper ? 'hook 文件内容必须是对象（可含 hooks 包装层）' : 'manifest.hooks 必须是对象', source.sourcePath);
      continue;
    }
    for (const [rawEvent, rawList] of Object.entries(hooksRoot)) {
      const event = rawEvent.trim();
      if (!event) continue;
      if (!SUPPORTED_HOOK_EVENTS.has(event)) {
        diag(diagnostics, 'plugin_hook_unsupported_event', `V1 不支持该 hook 事件，已忽略：${event}`, source.sourcePath);
        continue;
      }
      if (!Array.isArray(rawList)) {
        diag(diagnostics, 'plugin_hook_invalid', `${event} 的值必须是数组`, source.sourcePath);
        continue;
      }
      for (const entry of rawList) collectHookEntries(event, entry, source.sourcePath, diagnostics, hooks, seen);
    }
  }
  return hooks;
}

/** 兼容"文件里带 hooks 包装层"与"文件直接写事件表"两种写法。 */
function pickHooksRoot(raw) {
  if (!isRecord(raw)) return null;
  if (isRecord(raw.hooks)) return raw.hooks;
  return raw;
}

/** 解析单个 event 值（matcher 容器、单 hook 对象或字符串）。 */
function collectHookEntries(event, entry, sourcePath, diagnostics, hooks, seen) {
  if (typeof entry === 'string') {
    pushHook(event, undefined, entry, undefined, sourcePath, diagnostics, hooks, seen);
    return;
  }
  if (!isRecord(entry)) {
    diag(diagnostics, 'plugin_hook_invalid', `${event} 的 hook 项必须是对象或字符串`, sourcePath);
    return;
  }
  const matcher = typeof entry.matcher === 'string' && entry.matcher.trim() !== '' ? entry.matcher.trim() : undefined;
  const nested = Array.isArray(entry.hooks) ? entry.hooks : null;
  // 有 hooks 数组走 matcher 容器；否则把 entry 自身当扁平 hook（`{ matcher?, command }`）。
  for (const raw of nested ?? [entry]) {
    if (typeof raw === 'string') {
      pushHook(event, matcher, raw, undefined, sourcePath, diagnostics, hooks, seen);
      continue;
    }
    if (!isRecord(raw)) {
      diag(diagnostics, 'plugin_hook_invalid', `${event} 的 hook 项必须是对象或字符串`, sourcePath);
      continue;
    }
    const type = typeof raw.type === 'string' ? raw.type.trim() : 'command';
    if (type !== 'command') {
      diag(diagnostics, 'plugin_hook_unsupported_type', `V1 只支持 command 类型 hook，已忽略：${type}`, sourcePath);
      continue;
    }
    const command = typeof raw.command === 'string' ? raw.command.trim() : '';
    if (!command) {
      diag(diagnostics, 'plugin_hook_invalid', `${event} 的 hook 缺少 command`, sourcePath);
      continue;
    }
    pushHook(event, matcher, command, timeoutMsOf(raw), sourcePath, diagnostics, hooks, seen);
  }
}

function pushHook(event, matcher, command, timeoutMs, sourcePath, diagnostics, hooks, seen) {
  const trimmed = String(command ?? '').trim();
  if (!trimmed) {
    diag(diagnostics, 'plugin_hook_invalid', `${event} 的 hook command 为空`, sourcePath);
    return;
  }
  const key = [event, matcher ?? '', trimmed, timeoutMs ?? ''].join('\u0000');
  if (seen.has(key)) return;
  seen.add(key);
  hooks.push(withOptional({ event, command: trimmed }, { matcher, timeoutMs }));
}

/**
 * hook 超时归一成毫秒：Claude/ZCode 的 `timeout` 单位是秒，显式 `timeoutMs` 优先。
 * 不归一会让 5 秒的超时被当成 5 毫秒（立刻 kill）。
 */
function timeoutMsOf(raw) {
  if (typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0) return Math.round(raw.timeoutMs);
  if (typeof raw.timeout === 'number' && Number.isFinite(raw.timeout) && raw.timeout > 0) return Math.round(raw.timeout * 1000);
  return undefined;
}

// ============================================================
// MCP
// ============================================================

/**
 * 解析 MCP server：根 `.mcp.json`（ZCode 兼容来源）→ manifest.mcpServers 覆盖。
 * 只做形状校验、不展开 `${...}`：展开需要运行期上下文（项目目录/用户配置），
 * 属投影层职责；提前展开会把敏感值写进 catalog。
 */
function collectMcpServers(rootPath, manifest, manifestPath, diagnostics) {
  const merged = {};
  const filePath = join(rootPath, '.mcp.json');
  const info = lstatOrNullSync(filePath);
  if (info?.isSymbolicLink()) {
    diag(diagnostics, 'plugin_symlink_rejected', `.mcp.json 是符号链接，已跳过：${filePath}`, filePath);
  } else if (info?.isFile()) {
    const raw = readJsonSafe(filePath, 'plugin_mcp_read_failed', diagnostics);
    if (raw !== undefined) Object.assign(merged, normalizeMcpServers(raw, filePath, diagnostics));
  }

  const spec = fieldOf(manifest, 'mcpServers');
  if (spec === undefined) return merged;

  const fromManifest = {};
  for (const item of Array.isArray(spec) ? spec : [spec]) {
    if (typeof item === 'string') {
      const resolved = resolveInside(rootPath, item.trim().replace(/^\.\/+/, ''));
      if (!resolved) {
        diag(diagnostics, 'plugin_component_path_invalid', `manifest.mcpServers 路径越出插件根，已拒绝：${item}`, manifestPath);
        continue;
      }
      const fileInfo = lstatOrNullSync(resolved);
      if (fileInfo?.isSymbolicLink()) {
        diag(diagnostics, 'plugin_symlink_rejected', `manifest.mcpServers 路径是符号链接，已跳过：${item}`, resolved);
        continue;
      }
      if (!fileInfo?.isFile()) {
        diag(diagnostics, 'plugin_mcp_read_failed', `manifest.mcpServers 文件不存在：${item}`, resolved);
        continue;
      }
      const raw = readJsonSafe(resolved, 'plugin_mcp_read_failed', diagnostics);
      if (raw !== undefined) Object.assign(fromManifest, normalizeMcpServers(raw, resolved, diagnostics));
      continue;
    }
    if (isRecord(item)) {
      Object.assign(fromManifest, normalizeMcpServers(item, manifestPath, diagnostics));
      continue;
    }
    diag(diagnostics, 'plugin_mcp_invalid', 'manifest.mcpServers 必须是对象、文件路径或它们的数组', manifestPath);
  }

  // manifest 内联声明优先于根 .mcp.json（与 ZCode 一致：fromFile 之后 fromManifest）。
  return Object.assign(merged, fromManifest);
}

/** 统一 `{ mcpServers: {...} }` 包装层与裸映射，逐个 server 校验是对象。 */
function normalizeMcpServers(value, sourcePath, diagnostics) {
  return normalizeServers(value, sourcePath, diagnostics, 'plugin_mcp_invalid');
}

/**
 * LSP 服务器：根 `lsp.json`（Claude 侧可选写法）→ manifest.lspServers 覆盖。
 *
 * 与 MCP 同样只做形状校验：V1 不启动语言服务器（SPEC §1 的 agent/ui 同款口径），
 * 枚举出来是为了让「语言服务器插件」在 UI 里看得见、不是装了个空壳。
 */
function collectLspServers(rootPath, manifest, manifestPath, diagnostics) {
  const merged = {};
  const filePath = join(rootPath, 'lsp.json');
  const info = lstatOrNullSync(filePath);
  if (info?.isSymbolicLink()) {
    diag(diagnostics, 'plugin_symlink_rejected', `lsp.json 是符号链接，已跳过：${filePath}`, filePath);
  } else if (info?.isFile()) {
    const raw = readJsonSafe(filePath, 'plugin_lsp_read_failed', diagnostics);
    if (raw !== undefined) Object.assign(merged, normalizeServers(raw, filePath, diagnostics, 'plugin_lsp_invalid'));
  }

  const spec = fieldOf(manifest, 'lspServers');
  if (spec === undefined) return merged;

  const fromManifest = {};
  for (const item of Array.isArray(spec) ? spec : [spec]) {
    if (typeof item === 'string') {
      const resolved = resolveInside(rootPath, item.trim().replace(/^\.\/+/, ''));
      if (!resolved) {
        diag(diagnostics, 'plugin_component_path_invalid', `manifest.lspServers 路径越出插件根，已拒绝：${item}`, manifestPath);
        continue;
      }
      const fileInfo = lstatOrNullSync(resolved);
      if (fileInfo?.isSymbolicLink()) {
        diag(diagnostics, 'plugin_symlink_rejected', `manifest.lspServers 路径是符号链接，已跳过：${item}`, resolved);
        continue;
      }
      if (!fileInfo?.isFile()) {
        diag(diagnostics, 'plugin_lsp_read_failed', `manifest.lspServers 文件不存在：${item}`, resolved);
        continue;
      }
      const raw = readJsonSafe(resolved, 'plugin_lsp_read_failed', diagnostics);
      if (raw !== undefined) Object.assign(fromManifest, normalizeServers(raw, resolved, diagnostics, 'plugin_lsp_invalid'));
      continue;
    }
    if (isRecord(item)) {
      Object.assign(fromManifest, normalizeServers(item, manifestPath, diagnostics, 'plugin_lsp_invalid'));
      continue;
    }
    diag(diagnostics, 'plugin_lsp_invalid', 'manifest.lspServers 必须是对象、文件路径或它们的数组', manifestPath);
  }

  return Object.assign(merged, fromManifest);
}

/** 通用 server 映射归一：`{ mcpServers: {...} }` / `{ lspServers: {...} }` 包装层与裸映射都接。 */
function normalizeServers(value, sourcePath, diagnostics, code) {
  if (!isRecord(value)) {
    diag(diagnostics, code, '配置必须是 JSON 对象', sourcePath);
    return {};
  }
  const servers = isRecord(value.mcpServers)
    ? value.mcpServers
    : isRecord(value.lspServers) ? value.lspServers : value;
  const out = {};
  for (const [rawName, config] of Object.entries(servers)) {
    const name = rawName.trim();
    if (!name) {
      diag(diagnostics, code, 'server 名为空，已跳过', sourcePath);
      continue;
    }
    if (!isRecord(config)) {
      diag(diagnostics, code, `server 配置必须是对象：${name}`, sourcePath);
      continue;
    }
    out[name] = config;
  }
  return out;
}

// ============================================================
// ui.surfaces
// ============================================================

/**
 * 解析 `manifest.ui.surfaces[]`：V1 只枚举、不渲染（SPEC §1）。
 * resourceUri 必须 `ui://`，否则运行时 mcp/uiReadResource 无法寻址，早失败好过运行期报错。
 */
function collectUiSurfaces(manifest, manifestPath, diagnostics) {
  const ui = fieldOf(manifest, 'ui');
  if (!isRecord(ui)) return [];
  const rawSurfaces = ui.surfaces;
  if (rawSurfaces === undefined) return [];
  if (!Array.isArray(rawSurfaces)) {
    diag(diagnostics, 'plugin_ui_surface_invalid', 'ui.surfaces 必须是数组', manifestPath);
    return [];
  }

  const surfaces = [];
  const seen = new Set();
  for (const raw of rawSurfaces) {
    const reject = (message) => diag(diagnostics, 'plugin_ui_surface_invalid', message, manifestPath);
    if (!isRecord(raw)) {
      reject('ui.surfaces 项必须是对象');
      continue;
    }
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id) {
      reject('ui surface 缺少 id');
      continue;
    }
    if (seen.has(id)) {
      reject(`ui surface id 重复，已忽略后者：${id}`);
      continue;
    }
    const title = pickLocalizedTitle(raw.title);
    const server = typeof raw.server === 'string' ? raw.server.trim() : '';
    const resourceUri = typeof raw.resourceUri === 'string' ? raw.resourceUri.trim() : '';
    if (!title) {
      reject(`ui surface 缺少 title：${id}`);
      continue;
    }
    if (!server) {
      reject(`ui surface 缺少 server：${id}`);
      continue;
    }
    if (!resourceUri.startsWith('ui://')) {
      reject(`ui surface 的 resourceUri 必须以 ui:// 开头：${id}`);
      continue;
    }
    seen.add(id);
    surfaces.push(withOptional(
      { id, title, server, resourceUri },
      { icon: typeof raw.icon === 'string' && raw.icon.trim() !== '' ? raw.icon.trim() : undefined },
    ));
  }
  return surfaces;
}

/** title 可以是字符串或 `{ 'zh-CN': ..., 'en-US': ... }`；展示优先中文。 */
function pickLocalizedTitle(value) {
  if (typeof value === 'string') return value.trim();
  if (!isRecord(value)) return '';
  for (const key of ['zh-CN', 'zh', 'en-US', 'en']) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  for (const candidate of Object.values(value)) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return '';
}

// ============================================================
// frontmatter（零依赖）
// ============================================================

/**
 * 读取 markdown frontmatter 标量；文件不可读时返回空对象。
 * 只关心展示/投影需要的 name、description、whenToUse、argument-hint；
 * 解析失败按"没有 frontmatter"降级，绝不因为 YAML 不标准就丢掉整个组件。
 */
export function readMarkdownFrontmatter(filePath) {
  try {
    return parseFrontmatter(readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

/** 纯函数版 frontmatter 解析，便于测试块标量与引号分支。 */
export function parseFrontmatter(text) {
  const frontmatter = extractFrontmatter(String(text ?? ''));
  if (frontmatter === null) return {};
  const result = {};
  for (const [rawKey, rawValue] of Object.entries(parseFlatScalars(frontmatter))) {
    const key = FRONTMATTER_ALIASES.get(rawKey.toLowerCase());
    if (!key) continue;
    const value = parseScalar(rawValue);
    if (value) result[key] = value;
  }
  return result;
}

/** 抽出 `---` 包围的头部；没有或未闭合都视为无 frontmatter。 */
function extractFrontmatter(text) {
  const normalized = text.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---')) return null;
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (endIndex <= 0) return null;
  return lines.slice(1, endIndex).join('\n');
}

/** 解析顶层 `key: value`；块标量把后续缩进行收进同一键，嵌套映射整体跳过。 */
function parseFlatScalars(frontmatter) {
  const values = {};
  const lines = frontmatter.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim().length === 0 || line.trim().startsWith('#')) continue;
    // 缩进行属于上一个键（块标量内容或嵌套映射），顶层扫描不处理。
    if (/^\s/.test(line)) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === '' || Object.prototype.hasOwnProperty.call(values, key)) continue;
    const style = blockScalarStyle(value);
    if (style) {
      const block = readBlockScalar(lines, index + 1, style);
      values[key] = block.value;
      index = block.nextIndex - 1;
    } else {
      values[key] = value;
    }
  }
  return values;
}

/** `>` 折叠 / `|` 字面，允许 `+`/`-` chomping 后缀。 */
function blockScalarStyle(value) {
  if (/^>[+-]?$/.test(value)) return 'folded';
  if (/^\|[+-]?$/.test(value)) return 'literal';
  return null;
}

function readBlockScalar(lines, startIndex, style) {
  const rawLines = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    // 非空且顶格的行 = 下一个顶层键，块标量到此结束。
    if (line.trim().length > 0 && !/^\s/.test(line)) break;
    rawLines.push(line);
    index += 1;
  }
  let indent = null;
  for (const line of rawLines) {
    if (line.trim().length === 0) continue;
    const width = leadingWhitespace(line);
    indent = indent === null ? width : Math.min(indent, width);
  }
  const contentLines = rawLines.map((line) => (line.trim().length === 0 ? '' : line.slice(indent ?? 0)));
  const value = style === 'folded' ? foldLines(contentLines) : contentLines.join('\n').trim();
  return { value, nextIndex: index };
}

function leadingWhitespace(value) {
  return /^(\s*)/.exec(value)?.[1]?.length ?? 0;
}

/** 折叠（`>`）：同段换行折成一个空格，空行分段。 */
function foldLines(lines) {
  const paragraphs = [];
  let current = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (current.length > 0) {
        paragraphs.push(current.join(' '));
        current = [];
      }
      continue;
    }
    current.push(trimmed);
  }
  if (current.length > 0) paragraphs.push(current.join(' '));
  return paragraphs.join('\n').trim();
}

/** 去成对引号；不做引号外截断（description 常含中文冒号）。 */
function parseScalar(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

// ============================================================
// 小工具
// ============================================================

function lstatOrNullSync(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function byName(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** 只写入有值的可选字段，避免产物里出现 `undefined` 键（影响 JSON 往返一致性）。 */
function withOptional(base, extras) {
  for (const [key, value] of Object.entries(extras)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    base[key] = value;
  }
  return base;
}

/** 读 JSON；失败进诊断并返回 undefined（调用方跳过该来源，不中断其它组件）。 */
function readJsonSafe(filePath, code, diagnostics) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    diag(diagnostics, code, `JSON 读取失败：${messageOf(error)}`, filePath);
    return undefined;
  }
}

function diag(diagnostics, code, message, path) {
  diagnostics.push(path ? { code, message, path } : { code, message });
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
