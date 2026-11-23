/**
 * dsh-skill-manager — 自定义技能根的两份状态（v3.1，契约 §8.6）。
 *
 * 「自定义技能根」有两处记录，语义不同、缺一不可：
 *
 *   1. 运行时列表：本进程内的数组。`/roots/custom` 的 POST 一返回就参与后续扫描，
 *      进程结束即消失。给「先看看这个目录里有什么」用，不写盘。
 *   2. profile 持久化：profile 补丁（`cordis.patch.yml`）里 `- id: skill-manager` 的
 *      `config.customSkillDirs`。插件重载后宿主把它读进 Config，才真的进 rank 300。
 *
 * 另一半是本模块存在的理由：profile 补丁是宿主和别的插件共同改写的文件，所以只动
 * 自己那块托管标记之间的内容，块外一个字节都不碰：
 *
 *   - 托管块存在   → 只替换块内内容（二次写入不会追加出第二份）；
 *   - 块不存在且文件里没有 `- id: skill-manager` → 追加到文件末尾；
 *   - 块不存在但已有手写的 `- id: skill-manager` → 409，绝不猜用户想怎么合并；
 *   - 只有一半标记 → 409，也不猜。
 *
 * 写盘顺序固定为「读原文 → 冲突检查 → 渲染 → 解析校验新全文 → 备份 → 同目录 temp +
 * rename」：新全文在落盘前已经过 `yaml.parse`，所以不会留下半写文件，也不会出现
 * 「写完才发现 YAML 坏了」；rename 之后没有会失败的步骤，因此不需要回滚路径，备份
 * （`<profileDir>/data/skill-manager/backup-<yyyyMMddTHHmmss>.yml`）仍留给人工回退。
 */

import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isMap, isSeq, parseDocument } from 'yaml';

import { ApiError, badRequest, conflict } from './errors.js';
import { detectEol } from './parse.js';
import { firstNonEmpty, normalizeCustomDirs, resolveDshHome } from './roots.js';
import { writeFileAtomic } from './skill-file.js';

/** 托管块开始标记（契约 §8.6 的写死格式）。 */
export const MANAGED_BEGIN = '# >>> dsh-skill-manager custom roots >>>';

/** 托管块结束标记。 */
export const MANAGED_END = '# <<< dsh-skill-manager custom roots <<<';

/** 本插件在 profile 补丁里的 loader id，与 `cordis.patch.yml` 的 `- id:` 一致。 */
const PLUGIN_ID = 'skill-manager';

/** 同一秒内多次写入时备份名的重试上限（`backup-<ts>-2.yml`、`-3` …）。 */
const MAX_BACKUP_NAME_RETRY = 100;

/**
 * `!!js` 表达式在 profile 补丁里是合法的**未求值**节点（只有 loader 求值），
 * 解析时必须给自定义 tag，否则真实 profile 里 MCP 行的 `!!js process.env.X`
 * 会让整份文件被判成坏 YAML。本模块只读自己的 `customSkillDirs`，不求值任何东西。
 */
const JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (value) => ({ __jsExpr: String(value) }) };

/** 进程内的临时自定义根（绝对路径，去重）。模块级状态，进程结束即消失。 */
let runtimeState = [];

/**
 * 进程内的临时自定义根。
 *
 * @returns {string[]} 绝对路径列表的副本（改它不影响内部状态）
 */
export function runtimeDirs() {
  return [...runtimeState];
}

/**
 * 整体替换运行时列表。
 *
 * @param {unknown} dirs - 完整的列表（不是增量）；非字符串与空值条目被丢弃，相对路径按 `cwd` 解析
 * @param {string} [cwd] - 解析相对路径用；缺省 `process.cwd()`
 * @returns {string[]} 规范化后的绝对路径（去重、保序）
 */
export function setRuntimeDirs(dirs, cwd) {
  const base = typeof cwd === 'string' && cwd.trim() !== '' ? cwd : process.cwd();
  runtimeState = normalizeCustomDirs(dirs, base);
  return runtimeDirs();
}

/**
 * 合并 config 里的 dirs 与运行时列表。
 *
 * 先 config 后 runtime：config 的顺序决定 rank 300 起 `custom:<n>` 的先后，运行时
 * 列表追加在后面。按原值去重（Windows 大小写不敏感），不做路径解析——运行时列表
 * 已经在 {@link setRuntimeDirs} 里规范化过。
 *
 * @param {unknown} configDirs - 插件 Config 的 `customSkillDirs`
 * @param {unknown} runtime - 运行时列表
 * @returns {string[]} 合并后的路径列表
 */
export function mergeDirs(configDirs, runtime) {
  const merged = [];
  const seen = new Set();
  for (const list of [configDirs, runtime]) {
    for (const value of Array.isArray(list) ? list : []) {
      if (typeof value !== 'string' || value.trim() === '') continue;
      const dir = value.trim();
      const key = pathKey(dir);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(dir);
    }
  }
  return merged;
}

/**
 * profile 补丁文件路径。
 *
 * 优先 `ctx.configEditor.documentPath`：那是宿主和插件共同改写的文件，位置才是权威。
 * 取不到时按 `dsh-home-paths` 的规则重建：`$DSH_HOME`（无则 `~/.dsh`）/`profiles`/
 * `$DSH_PROFILE`（无则 `desktop`）/`cordis.patch.yml`。
 *
 * `configEditor` 不在本插件的 inject 里，未注入时读 `ctx.configEditor` 会抛，所以两条
 * 访问路径都包在 try 里（与 dsh-plugin-hub 的 `profileDirOf` 同一写法）。
 *
 * @param {object} [ctx] - 插件上下文
 * @returns {string} 补丁文件的绝对路径
 */
export function profilePatchPathOf(ctx) {
  const documentPath = configEditorDocumentPath(ctx);
  if (documentPath !== undefined) return documentPath;
  const profile = firstNonEmpty(process.env.DSH_PROFILE) ?? 'desktop';
  return join(resolveDshHome(undefined), 'profiles', profile, 'cordis.patch.yml');
}

/**
 * 读 profile 里本插件那条 `- id: skill-manager` 的 `config.customSkillDirs`。
 *
 * 读不动不抛：一律 `writable: false` + `error`，让面板把「为什么不能写」直接显示出来
 * （补丁是共享文件，读失败不该让整页崩掉）。
 *
 * @param {object} [ctx] - 插件上下文（只用 `configEditor`）
 * @returns {Promise<{ path: string, dirs: string[], writable: boolean, error?: string }>}
 *   文件不存在时 `dirs: []`；`dirs` 是原文里写的字符串（不做平台化改写）
 */
export async function readProfileCustomDirs(ctx) {
  const path = profilePatchPathOf(ctx);
  const profileDir = dirname(path);

  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
      return { path, dirs: [], writable: false, error: `读取 profile 补丁失败：${messageOf(error)}` };
    }
    // 补丁还没建：能不能写由目录决定（写之前还会再解析一次，这里只回答「可写吗」）。
    if (await canWrite(profileDir, path)) return { path, dirs: [], writable: true };
    return { path, dirs: [], writable: false, error: `profile 补丁不可写：${path}` };
  }

  const span = managedSpan(text);
  if (span === 'broken') return { path, dirs: [], writable: false, error: '托管块标记不完整，未接管' };

  const parsed = parsePatchDocument(text);
  if (parsed.error !== undefined) {
    return { path, dirs: [], writable: false, error: `profile 补丁解析失败：${parsed.error}` };
  }

  const entries = collectPluginEntries(parsed.document.contents);
  if (entries.some((entry) => !isManagedEntry(entry, span))) {
    return { path, dirs: [], writable: false, error: 'profile 里已有手写的 skill-manager 条目，未接管' };
  }
  const managed = entries.filter((entry) => isManagedEntry(entry, span));
  const dirs = managed.length === 0 ? [] : dirsOfEntry(managed[0], parsed.document);
  if (!(await canWrite(profileDir, path))) {
    return { path, dirs, writable: false, error: `profile 补丁不可写：${path}` };
  }
  return { path, dirs, writable: true };
}

/**
 * 把 dirs 写进 profile 补丁的托管块。
 *
 * 传进来的应当是完整的自定义根列表（通常就是 {@link setRuntimeDirs} 的返回值）：
 * 本函数整体替换托管块内容，不做「增删一条」的增量语义。
 *
 * @param {object} [ctx] - 插件上下文（只用 `configEditor`）
 * @param {unknown} dirs - 自定义根列表；写进 YAML 时反斜杠统一转成 `/`
 * @returns {Promise<{ path: string, backupPath: string, requiresReload: true }>}
 *   `requiresReload: true` 表示宿主已被写入新配置，但要重载插件才按新根扫描
 */
export async function writeProfileCustomDirs(ctx, dirs) {
  const path = profilePatchPathOf(ctx);
  const profileDir = dirname(path);
  const list = normalizeDirs(dirs);
  for (const dir of list) {
    if (/[\r\n]/.test(dir)) throw badRequest(`自定义根路径不能包含换行：${JSON.stringify(dir)}`);
  }

  // profile 目录应已存在；这里只是防御（推导出的路径可能指向一个还没建的 profile）。
  await mkdir(profileDir, { recursive: true });

  let original = '';
  try {
    original = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
      throw new ApiError('internal', `读取 profile 补丁失败：${messageOf(error)}`, 500);
    }
  }

  const span = managedSpan(original);
  if (span === 'broken') throw conflict('托管块标记不完整，未写入');

  const parsed = parsePatchDocument(original);
  if (parsed.error !== undefined) throw conflict(`profile 补丁不是合法 YAML，未写入：${parsed.error}`);
  const entries = collectPluginEntries(parsed.document.contents);
  if (entries.some((entry) => !isManagedEntry(entry, span))) {
    throw conflict('profile 里已有手写的 skill-manager 条目，请手动修改');
  }

  // 块的行尾跟原文走，否则 CRLF 的 profile 每次写入都会掺进 LF 行。
  const eol = detectEol(original) === 'crlf' ? '\r\n' : '\n';
  const block = renderManagedBlock(list, eol);
  // 顶层写成 flow 空序列（`[]`）时不能直接追加 block 条目：一个 YAML 文档只有一个
  // 根节点。把这种「空补丁」当作空文件，先剥掉那行再追加。
  const base = span === null && isEmptyRootSequence(parsed.document)
    ? stripEmptySequence(original)
    : original;
  const next = span === null ? appendBlock(base, block, eol) : replaceBlock(original, span, block);

  // 落盘前校验生成的新全文：坏了就到此为止，磁盘上仍是上一份完整文件。
  const validated = parsePatchDocument(next);
  if (validated.error !== undefined) {
    throw conflict(`生成的 profile 补丁无法解析，未写入：${validated.error}`);
  }

  const backupPath = await backupProfileText(profileDir, original);
  try {
    await writeFileAtomic(path, next);
  } catch (error) {
    throw new ApiError('internal', `写入 profile 补丁失败：${messageOf(error)}`, 500);
  }
  return { path, backupPath, requiresReload: true };
}

/**
 * 文档根是否是一个空的 flow 序列（`[]`）。
 *
 * 这种「空补丁」在真实 profile 里偶发（文件被重置成 `[]`），直接追加 `- id:` 会让
 * 文件变成两个根节点、整份 YAML 不可解析。
 *
 * @param {object} document - `yaml.parseDocument` 的结果
 * @returns {boolean}
 */
function isEmptyRootSequence(document) {
  const contents = document?.contents;
  if (contents === null || contents === undefined) return true;
  return isSeq(contents) === true && contents.items.length === 0;
}

/**
 * 删掉只含 `[]` 的那一行；其它行（包括注释）原样保留。
 *
 * @param {string} text
 * @returns {string}
 */
function stripEmptySequence(text) {
  return String(text ?? '').replace(/^[ \t]*\[\][ \t]*(?:\r?\n|$)/m, '');
}

/**
 * 解析一份 profile 补丁。
 *
 * 不抛：YAML 语法错误进 `error`，读侧把它变成面板上的提示，写侧把它变成 409。
 *
 * @param {string} text
 * @returns {{ document: object } | { error: string }}
 */
function parsePatchDocument(text) {
  try {
    const document = parseDocument(String(text ?? ''), { customTags: [JS_TAG] });
    if (document.errors.length > 0) return { error: document.errors[0].message };
    return { document };
  } catch (error) {
    return { error: messageOf(error) };
  }
}

/**
 * 托管块在原文里的字符区间。
 *
 * 只有一半标记时返回 `'broken'`：这时的文件处于本模块不理解的中间状态，猜着补标记
 * 会把用户正在改的东西弄坏，读与写都拒绝。
 *
 * @param {string} text
 * @returns {{ begin: number, end: number } | 'broken' | null} `end` 指向结束标记之后
 */
function managedSpan(text) {
  const source = String(text ?? '');
  const begin = source.indexOf(MANAGED_BEGIN);
  if (begin < 0) return source.includes(MANAGED_END) ? 'broken' : null;
  const end = source.indexOf(MANAGED_END, begin);
  if (end < 0) return 'broken';
  return { begin, end: end + MANAGED_END.length };
}

/**
 * 文档里所有 `- id: skill-manager` 映射节点。
 *
 * 顶层补丁行与 `insert:` 下的条目都算：后者是用 README §5 那种手写方式配的，同样属于
 * 「这份文件里有另一处 config.customSkillDirs」，不能被当成自己的托管块覆盖掉。
 * 返回节点而不是 JS 值：写盘时要靠 `range` 判断这一条在不在托管块内。
 *
 * @param {object} node - YAML 文档的内容节点（Map / Seq / null 均可）
 * @returns {object[]}
 */
function collectPluginEntries(node) {
  const found = [];
  const visit = (value) => {
    if (isMap(value)) {
      if (value.get('id') === PLUGIN_ID) found.push(value);
      for (const pair of value.items) visit(pair.value);
      return;
    }
    if (isSeq(value)) {
      for (const item of value.items) visit(item);
    }
  };
  visit(node);
  return found;
}

/** 一个条目节点是否落在托管块区间内（靠 YAML 节点的 `range` 起点判断）。 */
function isManagedEntry(entry, span) {
  if (span === null || span === 'broken') return false;
  const range = entry.range;
  if (!Array.isArray(range) || range.length === 0) return false;
  return range[0] >= span.begin && range[0] < span.end;
}

/**
 * 一个条目节点里的 `config.customSkillDirs`。
 *
 * @param {object} entry - `- id: skill-manager` 的映射节点
 * @param {object} document - 它所属的文档（`toJS` 需要）
 * @returns {string[]} 非数组或缺失按 `[]`
 */
function dirsOfEntry(entry, document) {
  const value = entry.toJS(document);
  const raw = value !== null && typeof value === 'object' && value.config !== null && typeof value.config === 'object'
    ? value.config.customSkillDirs
    : undefined;
  return normalizeDirs(raw);
}

/**
 * 渲染托管块。
 *
 * 格式写死（契约 §8.6 / README §5）：路径用单引号包住、反斜杠转 `/`，这样
 * `'D:/my-skills'` 在 Windows 与 POSIX 上是同一个字符串，也不触发 YAML 的任何
 * 转义或行折叠。空列表写 `customSkillDirs: []`。
 *
 * @param {string[]} dirs - 已规整的路径列表
 * @param {string} [eol] - 行尾
 * @returns {string} 以行尾结尾的整块文本
 */
function renderManagedBlock(dirs, eol = '\n') {
  const lines = [MANAGED_BEGIN, `- id: ${PLUGIN_ID}`, '  config:'];
  if (dirs.length === 0) {
    lines.push('    customSkillDirs: []');
  } else {
    lines.push('    customSkillDirs:');
    for (const dir of dirs) lines.push(`      - ${yamlString(dir)}`);
  }
  lines.push(MANAGED_END);
  return `${lines.join(eol)}${eol}`;
}

/** 单引号 YAML 标量：`\` → `/`，内部单引号按 YAML 规则写成 `''`。 */
function yamlString(value) {
  return `'${value.replace(/\\/g, '/').replace(/'/g, "''")}'`;
}

/**
 * 用新块替换旧块。
 *
 * 结束标记之后的换行归块所有（块自带行尾），这里吃掉紧邻的一个换行，否则二次写入会
 * 每次多出一个空行。
 *
 * @param {string} text
 * @param {{ begin: number, end: number }} span
 * @param {string} block
 * @returns {string}
 */
function replaceBlock(text, span, block) {
  let rest = text.slice(span.end);
  if (rest.startsWith('\r\n')) rest = rest.slice(2);
  else if (rest.startsWith('\n')) rest = rest.slice(1);
  return `${text.slice(0, span.begin)}${block}${rest}`;
}

/**
 * 在文件末尾追加托管块，前面留一个空行。
 *
 * @param {string} text
 * @param {string} block
 * @param {string} eol
 * @returns {string}
 */
function appendBlock(text, block, eol) {
  if (text === '') return block;
  const base = text.endsWith('\n') ? text : `${text}${eol}`;
  return `${base}${eol}${block}`;
}

/**
 * 备份补丁原文到 `<profileDir>/data/skill-manager/backup-<yyyyMMddTHHmmss>.yml`。
 *
 * 同一秒内第二次写入会撞名，依次退到 `-2`、`-3`…：备份是回滚依据，不能被自己的
 * 下一次写入覆盖掉。
 *
 * @param {string} profileDir - profile 目录
 * @param {string} text - 当前原文（文件不存在时为空字符串）
 * @returns {Promise<string>} 备份文件的绝对路径
 */
async function backupProfileText(profileDir, text) {
  const directory = join(profileDir, 'data', 'skill-manager');
  await mkdir(directory, { recursive: true });
  const base = `backup-${timestamp()}`;
  let path = join(directory, `${base}.yml`);
  let counter = 1;
  while ((await statOrUndefined(path)) !== undefined) {
    counter += 1;
    if (counter > MAX_BACKUP_NAME_RETRY) throw new ApiError('internal', '备份文件名冲突过多，未写入 profile 补丁', 500);
    path = join(directory, `${base}-${counter}.yml`);
  }
  await writeFile(path, text, 'utf8');
  return path;
}

/** `yyyyMMddTHHmmss` 本地时间戳，与回收站条目命名同款。 */
function timestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

/**
 * 目录（以及已存在的目标文件）是否可写。
 *
 * profile 目录可能还没建（推导出的路径、全新 profile），所以先往上找最近的已存在
 * 目录再查权限：{@link writeProfileCustomDirs} 会 `mkdir -p`，可写与否取决于祖先。
 *
 * @param {string} dir - 目标所在目录
 * @param {string} path - 目标文件（可能还不存在）
 * @returns {Promise<boolean>}
 */
async function canWrite(dir, path) {
  let current = dir;
  for (;;) {
    const info = await statOrUndefined(current);
    if (info !== undefined) {
      if (info.isDirectory() !== true) return false;
      try {
        await access(current, fsConstants.W_OK);
      } catch {
        return false;
      }
      break;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  if ((await statOrUndefined(path)) === undefined) return true;
  try {
    await access(path, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** 路径列表规整：丢非字符串/空值、去重（Windows 大小写不敏感）、保序。 */
function normalizeDirs(value) {
  if (!Array.isArray(value)) return [];
  const dirs = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const dir = item.trim();
    if (dir === '') continue;
    const key = pathKey(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push(dir);
  }
  return dirs;
}

/** 路径比较键：Windows 大小写不敏感。 */
/**
 * 路径比较键：先解析成绝对路径再做 Windows 大小写折叠。
 *
 * 只在 trim/小写上比较会让 `C:/skills` 与 `C:\skills` 变成两个根——配置文件里
 * 写正斜杠、运行时列表里写反斜杠是最常见的输入，必须归一到同一个键。
 *
 * @param {string} value
 * @returns {string}
 */
function pathKey(value) {
  let path;
  try {
    path = resolve(String(value));
  } catch {
    path = String(value);
  }
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

/** `ctx.configEditor.documentPath`；取不到时 `undefined`。 */
function configEditorDocumentPath(ctx) {
  const readers = [
    () => ctx?.configEditor?.documentPath,
    () => (typeof ctx?.get === 'function' ? ctx.get('configEditor')?.documentPath : undefined),
  ];
  for (const read of readers) {
    try {
      const value = read();
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    } catch {
      /* 未注入的服务在这里抛；换下一条访问路径 */
    }
  }
  return undefined;
}

/** `stat` 遇 ENOENT/ENOTDIR 归为 `undefined`（与 `lib/market.js` / `lib/trash.js` 同款）。 */
async function statOrUndefined(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined;
    throw error;
  }
}

/** 错误文本（`Error.message` 优先）。 */
function messageOf(error) {
  return String(error?.message ?? error);
}
