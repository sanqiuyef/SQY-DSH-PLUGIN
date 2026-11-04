/**
 * dsh-skill-manager — SKILL.md frontmatter parsing and host-accurate linting.
 *
 * The rules are copied from the host provider (`@deepseek-ai/dsh-skill-filesystem`),
 * because the host drops a skill silently: a rejected file only becomes one
 * `logger.warn`, and the model sees "unknown skill". Re-implementing the exact
 * checks is what lets this panel explain a skill that "exists but does not load".
 *
 * Host semantics being reproduced:
 *  - the first line must be exactly `---` (a UTF-8 BOM makes it `\uFEFF---`, so the
 *    whole skill is dropped without a frontmatter match);
 *  - the closing line is a line that is exactly `---` (trailing `\r` allowed);
 *  - the frontmatter block is parsed by `yaml.parse`, and a non-object result is a
 *    miss rather than an error;
 *  - `name` and `description` must be non-empty strings, and `name` must be kebab-case;
 *  - the legacy invocation keys (`disableModelInvocation`, `modelInvocable`,
 *    `userInvocable`) throw, which drops the skill;
 *  - the invocation booleans accept YAML booleans plus 1/0 and the case-insensitive
 *    true/false/yes/no/on/off spellings; anything else throws.
 */

import { parse } from 'yaml';

/** Public skill-name grammar, identical to `@deepseek-ai/dsh-skill`. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Legacy keys the host rejects outright, mapped to the canonical key to suggest. */
const LEGACY_INVOCATION_KEYS = {
  disableModelInvocation: 'disable-model-invocation',
  modelInvocable: 'disable-model-invocation',
  userInvocable: 'user-invocable',
};

/**
 * Keys this panel recognizes. Anything else is reported as a warning only —
 * a skill with extra keys still loads.
 */
const KNOWN_KEYS = new Set([
  'name',
  'description',
  'whenToUse',
  'metadata',
  'disable-model-invocation',
  'user-invocable',
  'license',
  'version',
  'author',
  'tags',
  'allowed-tools',
  'argument-hint',
]);

/** A description above this length is legal but hurts every prompt that carries it. */
const DESCRIPTION_WARN_CHARS = 1024;

/** Strip a leading UTF-8 BOM from a decoded string. */
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Whether the raw decoded text starts with a BOM. */
export function hasBom(text) {
  return text.charCodeAt(0) === 0xfeff;
}

/** Line ending style of a decoded string (`crlf` as soon as one CRLF exists). */
export function detectEol(text) {
  return text.includes('\r\n') ? 'crlf' : 'lf';
}

/**
 * Split raw text into frontmatter data and body, matching the host.
 *
 * `blockStart` / `blockEnd` are the absolute offsets of the frontmatter's inner
 * text (after the opening `---` line, before the closing `---` line). They let a
 * caller rewrite exactly one key without re-serializing the whole block, which
 * is what preserves comments, key order and line endings byte-for-byte.
 *
 * @returns {{ status: 'ok', data: object, body: string, bodyStart: number,
 *   blockStart: number, blockEnd: number }
 *   | { status: 'none' }
 *   | { status: 'yaml-error', message: string, line?: number }}
 */
export function splitFrontmatter(raw) {
  const firstLineEnd = raw.indexOf('\n');
  if (firstLineEnd < 0) return { status: 'none' };
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return { status: 'none' };

  const start = firstLineEnd + 1;
  let lineStart = start;
  let closing;
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart);
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline;
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      closing = { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 };
      break;
    }
    if (nextNewline < 0) break;
    lineStart = nextNewline + 1;
  }
  if (closing === undefined) return { status: 'none' };

  try {
    const data = parse(raw.slice(start, closing.start));
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return { status: 'none' };
    return {
      status: 'ok',
      data,
      body: raw.slice(closing.bodyStart),
      bodyStart: closing.bodyStart,
      blockStart: start,
      blockEnd: closing.start,
    };
  } catch (error) {
    const line = firstErrorLine(error);
    return { status: 'yaml-error', message: errorMessage(error), ...(line === undefined ? {} : { line }) };
  }
}

/** Best-effort 1-based line number from a `yaml` YAMLParseError. */
function firstErrorLine(error) {
  const linePos = error?.linePos;
  if (Array.isArray(linePos) && linePos.length > 0 && typeof linePos[0]?.line === 'number') return linePos[0].line;
  return undefined;
}

/** `String(error)`, with the useful `yaml` message preferred when present. */
function errorMessage(error) {
  if (typeof error?.message === 'string' && error.message !== '') return error.message;
  return String(error);
}

/** Non-empty string field, like the host's `stringField`. */
function stringField(data, key) {
  const value = data[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Parse one invocation boolean with the host's strict grammar. */
function invocationBoolean(data, key) {
  if (!Object.hasOwn(data, key)) return undefined;
  const value = data[key];
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
        return true;
      case 'false':
      case 'no':
      case 'off':
        return false;
      default:
        break;
    }
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`);
}

/** A frontmatter issue. `level: 'error'` means the host will not load this skill. */
function issue(level, code, message, line) {
  return line === undefined ? { level, code, message } : { level, code, message, line };
}

/**
 * Analyze a skill file's text.
 *
 * @param {string} raw - decoded file content (a BOM stays in the string)
 * @param {{ dirName: string, kind: 'directory' | 'file' }} input
 * @returns {{
 *   hasBom: boolean,
 *   name: string,
 *   description: string,
 *   whenToUse?: string,
 *   invocation: { model: boolean, user: boolean },
 *   data: Record<string, unknown> | null,
 *   body: string,
 *   issues: object[],
 *   ok: boolean,
 * }}
 */
export function analyzeContent(raw, { dirName, kind }) {
  const issues = [];
  const bom = hasBom(raw);
  if (bom) {
    issues.push(
      issue(
        'error',
        'bom',
        '文件以 UTF-8 BOM 开头：宿主要求第一行严格等于 "---"，带 BOM 的技能会被静默丢弃。保存时勾选"去除 BOM"即可修复。',
        1,
      ),
    );
  }

  const split = splitFrontmatter(raw);
  if (split.status === 'none') {
    issues.push(
      issue(
        'error',
        'no-frontmatter',
        '缺少 YAML frontmatter：文件必须以一行 "---" 开头、以一行 "---" 结束，且中间是合法的 YAML 映射。',
        1,
      ),
    );
    return {
      hasBom: bom,
      name: dirName,
      description: '',
      invocation: { model: true, user: true },
      data: null,
      body: raw,
      issues,
      ok: false,
    };
  }
  if (split.status === 'yaml-error') {
    issues.push(issue('error', 'yaml-invalid', `YAML 解析失败：${split.message}`, split.line));
    return {
      hasBom: bom,
      name: dirName,
      description: '',
      invocation: { model: true, user: true },
      data: null,
      body: raw,
      issues,
      ok: false,
    };
  }

  const { data, body } = split;
  const name = stringField(data, 'name');
  const description = stringField(data, 'description');

  if (name === undefined) {
    issues.push(issue('error', 'name-missing', 'frontmatter 缺少非空的 name（技能名，kebab-case）。'));
  } else if (!SKILL_NAME.test(name)) {
    issues.push(issue('error', 'name-invalid', `name "${name}" 不是合法技能名：只允许小写字母、数字与连字符（如 my-skill）。`));
  } else if (name !== dirName) {
    issues.push(
      issue('warn', 'name-mismatch', `name "${name}" 与所在条目名 "${dirName}" 不一致：宿主按 name 建索引，文件名只影响阅读。`),
    );
  }

  if (description === undefined) {
    issues.push(issue('error', 'description-missing', 'frontmatter 缺少非空的 description（会进入模型技能目录，务必写清触发场景）。'));
  } else if (description.length > DESCRIPTION_WARN_CHARS) {
    issues.push(
      issue('warn', 'description-long', `description 长度 ${description.length} 字符，超过 ${DESCRIPTION_WARN_CHARS} 会显著占用技能目录预算。`),
    );
  }

  let invocation = { model: true, user: true };
  try {
    for (const [legacy, canonical] of Object.entries(LEGACY_INVOCATION_KEYS)) {
      if (Object.hasOwn(data, legacy)) {
        throw new Error(`frontmatter 字段 "${legacy}" 不被支持，请改用 "${canonical}"`);
      }
    }
    const disableModelInvocation = invocationBoolean(data, 'disable-model-invocation');
    const userInvocable = invocationBoolean(data, 'user-invocable');
    invocation = { model: disableModelInvocation !== true, user: userInvocable !== false };
  } catch (error) {
    issues.push(issue('error', 'invocation-invalid', `${errorMessage(error)}。宿主会因此整条丢弃该技能。`));
  }

  for (const key of Object.keys(data)) {
    if (KNOWN_KEYS.has(key)) continue;
    issues.push(issue('warn', 'unknown-key', `未知的 frontmatter 顶层键 "${key}"：宿主会忽略它（可能是拼写错误或旧版字段）。`));
  }

  const whenToUse = stringField(data, 'whenToUse');
  return {
    hasBom: bom,
    name: name ?? dirName,
    description: description ?? '',
    ...(whenToUse === undefined ? {} : { whenToUse }),
    invocation,
    data,
    body,
    issues,
    ok: !issues.some((entry) => entry.level === 'error'),
  };
}

/** Merge extra issues into one list without duplicating identical entries. */
export function mergeIssues(...lists) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    for (const entry of list ?? []) {
      const key = `${entry.level}|${entry.code}|${entry.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged;
}

/** Whether an issue list contains at least one error. */
export function hasErrorIssue(issues) {
  return issues.some((entry) => entry.level === 'error');
}

/**
 * Split one top-level frontmatter line into the parts a value rewrite keeps.
 *
 * `suffix` is everything after the value token — the padding and, crucially, an
 * inline `# comment` — so callers can replace the value without flattening the
 * rest of the line.
 *
 * @param {string} text - one line of the frontmatter block, without the EOL
 * @returns {{ indent: string, key: string, colon: string, value: string, suffix: string } | null}
 */
function splitKeyLine(text) {
  const head = /^(\s*)(disable-model-invocation|user-invocable)(\s*:)([\s\S]*)$/.exec(text);
  if (head === null) return null;
  const rest = head[4];
  // A YAML comment starts at `#` only after whitespace (or at the line start),
  // so the value token is either a quoted scalar or a run without spaces/`#`.
  const tail = /^\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s#]*)([\s\S]*)$/.exec(rest);
  return {
    indent: head[1],
    key: head[2],
    colon: head[3],
    value: tail === null ? '' : tail[1],
    suffix: tail === null ? rest : tail[2],
  };
}

/**
 * Rewrite only the invocation keys of one block-style frontmatter.
 *
 * The edit is deliberately surgical: the two keys get their canonical spelling,
 * and every other byte (key order, comments, quoting, body, line endings) is
 * copied through untouched. Writing only what is needed keeps the file close to
 * what a human wrote:
 *  - a key that is absent and only needs its default value stays absent;
 *  - a key that is present is set explicitly, so the intent is visible;
 *  - a key that is absent but must deny keeps the shortest legal form.
 *
 * The caller re-analyzes the result; this function only reports that the file
 * shape allowed the edit.
 *
 * @param {string} raw - full decoded file content
 * @param {{ model: boolean, user: boolean }} invocation - resolved policy
 * @returns {{ ok: true, content: string } | { ok: false, reason: string }}
 */
export function rewriteInvocation(raw, { model, user }) {
  const split = splitFrontmatter(raw);
  if (split.status !== 'ok') {
    return {
      ok: false,
      reason: '这份文件没有可解析的块式 frontmatter（缺失、带 BOM 或行内式 YAML 都不行），请先在正文编辑器里修好 frontmatter 再改调用策略。',
    };
  }
  // `detectEol` answers a label ("crlf" | "lf"); here the separator itself is
  // needed, and it must come from the frontmatter region, not the body.
  const eol = detectEol(raw.slice(0, split.blockEnd)) === 'crlf' ? '\r\n' : '\n';
  const block = raw.slice(split.blockStart, split.blockEnd);

  /** Every frontmatter line with its absolute span (the `\r` stays outside `contentEnd`). */
  const lines = [];
  let index = 0;
  for (;;) {
    const newline = block.indexOf('\n', index);
    const lineEnd = newline < 0 ? block.length : newline;
    const slice = block.slice(index, lineEnd);
    const hasCr = slice.endsWith('\r');
    lines.push({
      start: split.blockStart + index,
      contentEnd: split.blockStart + lineEnd - (hasCr ? 1 : 0),
      text: hasCr ? slice.slice(0, -1) : slice,
    });
    if (newline < 0) break;
    index = newline + 1;
  }

  /** Desired value per canonical key; `true` means "default, write only if present". */
  const desired = {
    'disable-model-invocation': model === false ? 'true' : 'false',
    'user-invocable': user === false ? 'false' : 'true',
  };
  const required = {
    'disable-model-invocation': model === false,
    'user-invocable': user === false,
  };

  const edits = [];
  const present = new Set();
  for (const line of lines) {
    // Only top-level `key: value` lines count; nested/indented text is never a
    // frontmatter top-level key and must not be touched.
    if (line.text === '' || /^\s/.test(line.text)) continue;
    const parsed = splitKeyLine(line.text);
    if (parsed === null) continue;
    // `yaml.parse` rejects duplicate top-level keys, so a parsed block holds at
    // most one of each; normalizing every occurrence stays correct regardless.
    present.add(parsed.key);
    // Only the value token is rewritten: everything after it (padding and an
    // inline `# comment`) is copied through, because a human writing
    // `user-invocable: false  # only for /deploy` means that comment to stay.
    edits.push({
      start: line.start,
      end: line.contentEnd,
      text: `${parsed.indent}${parsed.key}${parsed.colon} ${desired[parsed.key]}${parsed.suffix}`,
    });
  }

  const missing = Object.keys(desired).filter((key) => !present.has(key) && required[key]);
  if (missing.length > 0) {
    const prefix = block !== '' && !block.endsWith('\n') ? eol : '';
    edits.push({ start: split.blockEnd, end: split.blockEnd, text: prefix + missing.map((key) => `${key}: ${desired[key]}`).join(eol) + eol });
  }

  // Apply from the end so earlier offsets stay valid.
  edits.sort((left, right) => right.start - left.start || right.end - left.end);
  let content = raw;
  for (const edit of edits) content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
  return { ok: true, content };
}

/** Render a `SkillSummary`-shaped frontmatter block used when creating a skill. */
export function buildFrontmatter({ name, description, whenToUse, invocation }) {
  const lines = ['---', `name: ${yamlScalar(name)}`, `description: ${yamlScalar(description)}`];
  if (typeof whenToUse === 'string' && whenToUse.trim() !== '') lines.push(`whenToUse: ${yamlScalar(whenToUse.trim())}`);
  if (invocation?.model === false) lines.push('disable-model-invocation: true');
  if (invocation?.user === false) lines.push('user-invocable: false');
  lines.push('---', '');
  return lines.join('\n');
}

/** Quote a YAML scalar when plain rendering would be ambiguous. */
function yamlScalar(value) {
  const text = String(value ?? '');
  if (text === '' ) return '""';
  const plain = /^[A-Za-z0-9\u4e00-\u9fff][^\n:#]*$/.test(text) && !/^[\s-]|[\s:]$/.test(text) && !/^(true|false|null|yes|no|on|off|\d+)$/i.test(text);
  if (plain) return text;
  return JSON.stringify(text);
}
