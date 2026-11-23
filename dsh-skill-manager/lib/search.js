/**
 * dsh-skill-manager — 技能正文搜索。
 *
 * 面板的列表只回答「有哪些技能」，检索框要回答「哪个技能里写过 X」。命中行要带行号，前端
 * 才能直接跳到编辑器里的那一行，所以这里必须真读正文，不能只比元数据。
 *
 * 三条边界：
 *  1. 不搜 `_trash/`：`scanAll` 只扫根目录的直接子项与 `_disabled/`，`_trash/` 在
 *     `RESERVED_ENTRIES` 里被跳过，删掉的技能不会以搜索结果的身份回来；
 *  2. 只搜 enabled / disabled 条目：`state === 'invalid'` 的条目连宿主都不加载，契约 §8.4
 *     也只承诺这两种状态，跳过它们；
 *  3. 正文有上限：单文件 > 512 KiB 只匹配元数据，读失败同样只匹配元数据——一个坏文件不该
 *     打断整次搜索。
 *
 * 正文命中只认 frontmatter 之后的正文：元数据已经在 `name` / `description` / `whenToUse`
 * 上判过，若把 frontmatter 也搜进来，「仅元数据命中」会陪绑出一条正文命中，与契约
 * 「仅元数据命中时 hits 为空」相矛盾。
 */

import { readFile, stat } from 'node:fs/promises';

import { badRequest, notFound } from './errors.js';
import { splitFrontmatter } from './parse.js';
import { rootById } from './roots.js';
import { scanAll } from './scan.js';

/** 查询串的最短长度：单字符搜索等于全量转储，没有意义。 */
const MIN_QUERY_CHARS = 2;

/** 默认与最大的返回条数。 */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** 每个技能最多给几条正文命中行。 */
const MAX_HITS = 3;

/** 命中行 trim 后的保留长度，超出加 `…`。 */
const MAX_HIT_CHARS = 200;

/** 参与正文匹配的单文件上限；超限只匹配元数据。 */
const MAX_BODY_BYTES = 512 * 1024;

/** 命中行文本：trim 后超过 200 字符截断并以 `…` 结尾。 */
function clipLine(line) {
  const text = line.trim();
  return text.length > MAX_HIT_CHARS ? `${text.slice(0, MAX_HIT_CHARS)}…` : text;
}

/**
 * 在一个技能文件正文里找命中行。
 *
 * 行号是文件里的 1-based 行号（前端可以直接定位到编辑器）；正文起点由
 * `parse.splitFrontmatter` 的 `bodyStart` 决定，没有合法 frontmatter 时整篇当正文。
 * 只返回前 {@link MAX_HITS} 条，命中行文本按 {@link clipLine} 截断。
 *
 * @param {string} path - 技能文件的绝对路径
 * @param {string} needle - 已经转成小写的查询串
 * @returns {Promise<Array<{ line: number, text: string }>>} 最多 3 条正文命中行
 */
async function bodyHits(path, needle) {
  let info;
  try {
    info = await stat(path);
  } catch {
    return [];
  }
  if (!info.isFile() || info.size > MAX_BODY_BYTES) return [];

  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }

  const split = splitFrontmatter(raw);
  const hasFrontmatter = split.status === 'ok';
  const offset = hasFrontmatter ? split.bodyStart : 0;
  // frontmatter 区间内有几行，正文第一行就是它的下一行。
  const firstLine = hasFrontmatter ? raw.slice(0, offset).split('\n').length : 1;

  const lines = raw.slice(offset).split(/\r?\n/);
  const hits = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].toLowerCase().includes(needle)) continue;
    hits.push({ line: firstLine + index, text: clipLine(lines[index]) });
    if (hits.length >= MAX_HITS) break;
  }
  return hits;
}

/**
 * 在全部扫盘结果里搜技能。
 *
 * 匹配字段：`name` / `description` / `whenToUse` / 正文，大小写不敏感子串。`matched` 是
 * 命中总数，`results` 只装前 `limit` 条，`truncated = matched > results.length`。
 *
 * @param {{ roots: object[], query: string, limit?: number, rootId?: string }} input
 *   `query` 至少 2 个字符；`limit` 默认 50、上限 200；给了 `rootId` 只搜该根
 * @returns {Promise<{
 *   q: string,
 *   matched: number,
 *   truncated: boolean,
 *   results: Array<{
 *     key: string,
 *     rootId: string,
 *     dirName: string,
 *     kind: 'directory' | 'file',
 *     state: string,
 *     name: string,
 *     description: string,
 *     hits: Array<{ line: number, text: string }>,
 *   }>,
 * }>} 命中行最多 3 条，仅元数据命中时 `hits` 为空数组
 */
export async function searchSkills({ roots, query, limit, rootId }) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (q.length < MIN_QUERY_CHARS) throw badRequest(`搜索词至少需要 ${MIN_QUERY_CHARS} 个字符`);
  const needle = q.toLowerCase();

  const requested = Number(limit);
  const max = Number.isFinite(requested)
    ? Math.max(1, Math.min(MAX_LIMIT, Math.trunc(requested)))
    : DEFAULT_LIMIT;

  let scope = roots;
  if (rootId !== undefined && rootId !== null && rootId !== '') {
    const root = rootById(roots, rootId);
    if (root === undefined) throw notFound(`未知的技能根：${String(rootId)}`);
    scope = [root];
  }

  const { skills } = await scanAll({ roots: scope });
  const results = [];
  let matched = 0;

  for (const skill of skills) {
    // 只搜 enabled / disabled：invalid 的条目宿主不会加载，正文也未必是合法 frontmatter。
    if (skill.state === 'invalid') continue;

    const metaHit = [skill.name, skill.description, skill.whenToUse].some(
      (field) => typeof field === 'string' && field.toLowerCase().includes(needle),
    );
    // 结果已经收满、元数据又已经命中时，只需要「是否命中」这一个布尔，不必再读正文。
    const hits = results.length < max || !metaHit ? await bodyHits(skill.path, needle) : [];
    if (!metaHit && hits.length === 0) continue;

    matched += 1;
    if (results.length >= max) continue;
    results.push({
      key: skill.key,
      rootId: skill.rootId,
      dirName: skill.dirName,
      kind: skill.kind,
      state: skill.state,
      name: skill.name,
      description: skill.description,
      hits,
    });
  }

  return { q, matched, truncated: matched > results.length, results };
}
