/**
 * dsh-memory-manager host-half smoke test — offline, no host, no real memory roots.
 *
 * What is pinned here, in order:
 *   A. project keys        — six pinned ZCode-compatible cases, plus normalization;
 *   B. note format         — safe names, frontmatter rendering (incl. `metadata.aliases`),
 *                            tolerant parsing;
 *   C. query primitives    — tokenization, scoring, snippets, index-row matching;
 *   D. store               — CRUD, index freshness, corrupt-file tolerance, lock/atomic
 *                            cleanup, and a concurrent-writer stress on one index;
 *   E. search / list       — scores, filters, limits;
 *   F. digest              — budgets, recency ordering, the frozen recent band,
 *                            truncation, determinism, cache behaviour;
 *   G. plugin wiring       — apply() registers 5 tools + section + 10 routes + 4 listeners,
 *                            tool schemas are inside the host's supported JSON-Schema
 *                            subset, and the synchronous section reports a written note;
 *   G2. no workspace service — the Cordis inject fence;
 *   H. routes              — auth first, no-store, the exact JSON shapes, 403 on write
 *                            attempts, and /open-dir validated without opening anything;
 *   I. roots / empty store — resolution order and the pre-first-write state;
 *   J. write routes        — create/update/delete over HTTP, fences, concurrency;
 *   K. P1 features         — selector parsing, the model invoker, recall (model, lexical,
 *                            auto fallback), dream candidates, extraction, and apply-level
 *                            opt-in behaviour;
 *   L. write-time dedupe   — similar-note hints and `metadata.aliases` merging;
 *   M. secret redaction    — the rule table and the single store write entry;
 *   N. runtime audit       — bounded JSONL events, rotation, /events, /diagnostics tail.
 *
 * Run:  node scripts/smoke.mjs
 */

import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { keyHashInput, normalizeForKeys, projectKeyOf, isProjectKey, slugOf } from '../lib/project-key.js';
import {
  INDEX_NAME,
  VALID_TYPES,
  atomicWriteBackend,
  createMemoryStore,
  formatNote,
  indexLine,
  indexLineMatches,
  indexLinkTarget,
  parseNote,
  projectName,
  resolveRoots,
  safeName,
  scoreNote,
  snippetOf,
  tokenize,
} from '../lib/store.js';
import { DEFAULT_LIMITS, estimateTokens, renderDigest, resolveLimits, truncateChars } from '../lib/digest.js';
import { apply } from '../lib/index.js';
import { registerRoutes } from '../lib/routes.js';
import { createLlmInvoker, parseJsonLoose } from '../lib/llm.js';
import { createRecallEngine, lexicalSelection, markMemoryRead, parseSelection, resetReadTracker, resolveRecallConfig, DEFAULT_RECALL } from '../lib/recall.js';
import { adoptCandidate, discardCandidate, listCandidateBundles, readCandidateBundle, writeCandidateBundle } from '../lib/candidates.js';
import { indexHealth, runConsolidation, runExtraction } from '../lib/consolidate.js';
import { REDACTION_RULES, redactNote, redactSecrets } from '../lib/redact.js';
import { DEFAULT_EVENTS, EVENTS_FILE, createEventLog, normalizeEvent } from '../lib/events.js';

let failures = 0;
const check = (label, condition, detail = '') => {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};
const section = (title) => console.log(`\n--- ${title} ---`);

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

let tempDirs = [];
async function makeRoots() {
  const dir = await mkdtemp(join(tmpdir(), 'memory-manager-'));
  tempDirs.push(dir);
  return { dir, roots: { globalDir: join(dir, 'global'), projectsDir: join(dir, 'projects') } };
}

/** Read the audit log a mounted plugin wrote beside its global root (newest first, [] when absent). */
async function readAuditEvents(roots) {
  let text;
  try {
    text = await readFile(join(roots.globalDir, EVENTS_FILE), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((event) => event !== null)
    .reverse();
}

/** Mock ServerResponse for route tests. */
function mockResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    ended: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers ?? {};
      return this;
    },
    end(body) {
      if (body !== undefined) this.body += String(body);
      this.ended = true;
    },
  };
}

/** Mock IncomingMessage; `body` is yielded for POST routes. */
function mockRequest({ method = 'GET', url = '/', headers = {}, body } = {}) {
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body, 'utf8');
    },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

/**
 * Approximate the host's `assertSupportedJsonSchema` (dsh-tools/lib/index.js:80-240):
 * only the documented keyword subset, standard `required` arrays, and every required
 * name declared. Running our tool schemas through this is what keeps a schema from
 * registering cleanly in smoke and failing on the real host.
 */
const SUPPORTED_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
]);
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];

function schemaProblems(schema, path = 'schema') {
  const problems = [];
  const walk = (node, where) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      problems.push(`${where} is not a schema object`);
      return;
    }
    for (const key of Object.keys(node)) {
      if (!SUPPORTED_KEYWORDS.has(key)) problems.push(`${where}.${key} is not a supported keyword`);
    }
    if (node.type !== undefined && !SCHEMA_TYPES.includes(node.type)) problems.push(`${where}.type is invalid`);
    if (node.type === 'object') {
      if (node.properties !== undefined) {
        if (node.properties === null || typeof node.properties !== 'object') problems.push(`${where}.properties must be an object`);
        else for (const [key, value] of Object.entries(node.properties)) walk(value, `${where}.properties.${key}`);
      }
      if (node.required !== undefined) {
        if (!Array.isArray(node.required) || node.required.some((entry) => typeof entry !== 'string')) {
          problems.push(`${where}.required must be an array of strings`);
        } else {
          for (const key of node.required) {
            if (node.properties === undefined || node.properties[key] === undefined) problems.push(`${where}.required names undeclared property ${key}`);
          }
        }
      }
      if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') {
        problems.push(`${where}.additionalProperties must be a boolean`);
      }
    }
    if (node.type === 'array') {
      if (node.items === undefined) problems.push(`${where}.items is required for an array`);
      else walk(node.items, `${where}.items`);
    }
    if (node.enum !== undefined && !Array.isArray(node.enum)) problems.push(`${where}.enum must be an array`);
  };
  walk(schema, path);
  return problems;
}

const main = async () => {
  // ---------------------------------------------------------- A. project keys
  section('A. project keys (ZCode compatibility)');
  {
    const cases = [
      ['D:\\work\\demo-a', 'demo-a-90d18ee4adaecf32'],
      ['C:\\work\\demo-b', 'demo-b-c0f18dcc5d91c0ff'],
      ['D:\\work\\sample-project', 'sample-project-279aa28300769857'],
      ['C:\\work\\sample-app', 'sample-app-5c52aa461bd6668d'],
      ['D:\\work\\demo-c', 'demo-c-12cd8fd29200fd6e'],
      ['C:\\Users\\x', 'x-b86681a9de073158'],
    ];
    for (const [cwd, expected] of cases) {
      const key = projectKeyOf(cwd);
      check(`projectKey(${cwd}) matches the pinned expectation`, key === expected, `${key} vs ${expected}`);
    }
    check('the hash input is lowercased end to end', normalizeForKeys('C:\\Work\\MyProject') === 'c:\\work\\myproject');
    check('a trailing separator does not change the key', projectKeyOf('D:\\work\\demo\\') === projectKeyOf('D:\\work\\demo'));
    check('drive-letter case does not change the key', projectKeyOf('d:\\work\\demo') === projectKeyOf('D:\\work\\demo'));
    check('NFC is applied before hashing', normalizeForKeys('D:\\work\\demo') === normalizeForKeys('D:\\work\\demo'.normalize('NFC')));
    check('a Chinese basename keeps its slug', slugOf('D:\\work\\示例项目') === '示例项目', slugOf('D:\\work\\示例项目'));
    check('the slug keeps underscores (live table evidence)', slugOf('D:\\work\\mcp_servers') === 'mcp_servers');
    check('a filesystem root still yields a key', isProjectKey(projectKeyOf('D:\\')), projectKeyOf('D:\\'));
    check('the key pattern rejects a path', !isProjectKey('..\\..\\evil') && !isProjectKey('slug') && !isProjectKey('slug-zzzz'));
    check('an empty cwd is rejected', (() => { try { projectKeyOf('   '); return false; } catch { return true; } })());
  }

  // --------------------------------------------------------- B. note format
  section('B. note format and tolerant parsing');
  {
    check('safeName replaces illegal characters', safeName('a/b:c*d?e"f<g>h|i') === 'a-b-c-d-e-f-g-h-i');
    check('safeName strips edge dots and spaces', safeName(' .note. ') === 'note');
    check('safeName keeps Chinese and underscores', safeName('记忆_条目') === '记忆_条目');
    for (const bad of ['', '  ', 'memory', 'MEMORY', 'CON', 'lpt1.md', 'x'.repeat(121)]) {
      let rejected = false;
      try {
        safeName(bad);
      } catch {
        rejected = true;
      }
      check(`safeName rejects ${JSON.stringify(bad.slice(0, 12))}`, rejected);
    }

    const formatted = formatNote({ name: 'demo-note', description: 'demo description', type: 'env', content: 'Body line.\nSecond line.' });
    check('the rendered note starts with frontmatter', formatted.startsWith('---\nname: demo-note\ndescription: demo description\nmetadata:\n  type: env\n---\n\n'));
    check('the rendered note ends with one newline', formatted.endsWith('Second line.\n') && !formatted.endsWith('\n\n'));
    const parsed = parseNote(formatted, 'demo-note.md');
    check('the note round-trips through the parser', parsed.name === 'demo-note' && parsed.description === 'demo description' && parsed.type === 'env' && parsed.content.trim() === 'Body line.\nSecond line.');
    check('a note has no error', parsed.error === null);

    const extra = parseNote('---\nname: x\ndescription: 摘要: 含冒号\nmetadata:\n  node_type: memory\n  type: project\n  originSessionId: sess_1\n---\n\nbody\n', 'x.md');
    check('unknown frontmatter keys are ignored', extra.name === 'x' && extra.description === '摘要: 含冒号' && extra.type === 'project');
    check('a colon in the description round-trips through YAML quoting', parseNote(formatNote({ name: 'y', description: '注意: 这里有冒号', type: 'user', content: 'b' }), 'y.md').description === '注意: 这里有冒号');

    // Aliases are an additive frontmatter key: absent by default, read back when present.
    check('a note without aliases writes no alias line', !formatNote({ name: 'z', description: 'd', type: 'env', content: 'b' }).includes('aliases'));
    const aliasedNote = formatNote({ name: 'z', description: 'd', type: 'env', content: 'b', aliases: ['别名', 'other-name', 'z'] });
    check('aliases render as a YAML flow list in metadata', aliasedNote.includes('  type: env\n  aliases: ["别名","other-name"]\n---'), aliasedNote.split('\n').slice(0, 7).join('|'));
    const parsedAliases = parseNote(aliasedNote, 'z.md');
    check('aliases parse back', JSON.stringify(parsedAliases.aliases) === JSON.stringify(['别名', 'other-name']), JSON.stringify(parsedAliases.aliases));
    check('a note without aliases parses to an empty list', JSON.stringify(parseNote('---\nname: q\ndescription: d\nmetadata:\n  type: env\n---\n\nb\n', 'q.md').aliases) === '[]');
    check('aliases survive the tolerant line scan', JSON.stringify(parseNote('---\nname: [broken\ndescription: d\nmetadata:\n  type: env\n  aliases: ["a", "b"]\n---\n\nx\n', 'r.md').aliases) === JSON.stringify(['a', 'b']));

    const noFrontmatter = parseNote('# just markdown\nno frontmatter here\n', 'plain.md');
    check('a note without frontmatter still parses', noFrontmatter.name === 'plain' && noFrontmatter.content.includes('no frontmatter') && noFrontmatter.error === null);
    const broken = parseNote('---\nname: [unclosed\n---\nbody\n', 'broken.md');
    check('broken frontmatter is reported, not fatal', broken.error !== null && broken.content === 'body\n');
    check('CRLF notes parse', parseNote('---\r\nname: crlf\r\ndescription: d\r\nmetadata:\r\n  type: env\r\n---\r\n\r\nbody\r\n', 'crlf.md').content === 'body\r\n');
  }

  // ------------------------------------------------------ C. query primitives
  section('C. tokenization, scoring, snippets, index rows');
  {
    const tokens = tokenize('DSH 记忆 2026 fallback');
    check('latin runs become word tokens', tokens.has('dsh') && tokens.has('2026') && tokens.has('fallback'));
    const zhRun = tokenize('记忆系统');
    check('CJK runs contribute the whole run and every bigram', zhRun.has('记忆系统') && zhRun.has('记忆') && zhRun.has('忆系') && zhRun.has('系统'));

    const note = { name: 'alpha', description: 'beta gamma', content: 'delta epsilon' };
    const score = (query) => scoreNote(note, tokenize(query), query.trim().toLowerCase());
    check('a name token scores 4 plus the substring bonus', score('alpha') === 7, String(score('alpha')));
    check('a description token scores 3 plus the bonus', score('beta') === 6, String(score('beta')));
    check('a body token scores 1 plus the bonus', score('delta') === 4, String(score('delta')));
    check('an absent token scores 0', score('zulu') === 0);
    const cjk = { name: '记忆', description: '用户偏好', content: '' };
    check('CJK search scores by bigram + substring', scoreNote(cjk, tokenize('用户'), '用户') === 6, String(scoreNote(cjk, tokenize('用户'), '用户')));

    const longBody = `${'x'.repeat(200)} needle ${'y'.repeat(200)}`;
    const snippet = snippetOf(longBody, new Set(['needle']), 'needle');
    check('a snippet contains the match', snippet.includes('needle') && snippet.length <= 200, String(snippet.length));
    check('a snippet is elided when it starts mid-text', snippet.startsWith('…'), snippet.slice(0, 10));

    check('an index row is recognised', indexLinkTarget('- [note](note.md) — desc') === 'note.md');
    check('index matching is exact, not substring', indexLineMatches('- [aa](aa.md) — x', 'a') === false && indexLineMatches('- [a](a.md) — x', 'a') === true);
    check('an index row renders in the server.py format', indexLine('note', 'one line') === '- [note](note.md) — one line');
    check('a non-index line is not an index row', indexLinkTarget('# Memory Index') === null);
  }

  // ---------------------------------------------------------------- D. store
  section('D. store CRUD, index freshness, locks, concurrency');
  {
    const { dir, roots } = await makeRoots();
    const store = createMemoryStore({ roots, logger: { warn() {} } });
    const projectCwd = 'D:\\work\\demo';
    const projectKey = projectKeyOf(projectCwd);
    const projectDir = store.projectDir(projectKey);

    const created = await store.writeNote({ scope: 'project', projectKey, name: 'demo-note', description: 'Demo description', content: 'First body.', type: 'env' });
    check('a new note reports created=true', created.created === true);
    check('the note lands under projectsDir/<key>/memory', created.path === join(projectDir, 'demo-note.md'), created.path);
    const noteText = await readFile(created.path, 'utf8');
    check('the note uses the global-memory frontmatter', noteText.startsWith('---\nname: demo-note\ndescription: Demo description\nmetadata:\n  type: env\n---\n\nFirst body.\n'));
    const indexPath = join(projectDir, INDEX_NAME);
    check('the index row is written', (await readFile(indexPath, 'utf8')) === '- [demo-note](demo-note.md) — Demo description\n');

    const updated = await store.writeNote({ scope: 'project', projectKey, name: 'demo-note', description: 'Updated description', content: 'Second body.', type: 'user' });
    check('rewriting the same name reports created=false', updated.created === false);
    const indexAfterUpdate = await readFile(indexPath, 'utf8');
    check('rewriting replaces the index row instead of appending', indexAfterUpdate === '- [demo-note](demo-note.md) — Updated description\n');
    check('rewriting replaces the body', (await readFile(updated.path, 'utf8')).includes('Second body.'));
    check('rewriting updates the type', parseNote(await readFile(updated.path, 'utf8'), 'demo-note.md').type === 'user');

    // External writer appends an index row; our next write must keep it (re-read inside the lock).
    await writeFile(indexPath, `${indexAfterUpdate}- [external](external.md) — external row\n`, 'utf8');
    await store.writeNote({ scope: 'project', projectKey, name: 'second', description: 'Second note', content: 'body', type: 'project' });
    const indexAfterSecond = await readFile(indexPath, 'utf8');
    check('a concurrent external index row survives our write', indexAfterSecond.includes('- [external](external.md) — external row'));
    check('both index rows are present', indexAfterSecond.includes('demo-note') && indexAfterSecond.includes('second'));

    const read = await store.readNote({ scope: 'project', projectKey, name: 'second' });
    check('readNote returns the parsed body', read?.note.content.trim() === 'body');
    check('readNote is case-insensitive', (await store.readNote({ scope: 'project', projectKey, name: 'SECOND' }))?.note.name === 'second');
    check('readNote returns null for a missing name', (await store.readNote({ scope: 'project', projectKey, name: 'nope' })) === null);

    const listed = await store.list({ scope: 'project', projectKey });
    check('list returns both notes sorted by name', JSON.stringify(listed.entries.map((entry) => entry.name)) === JSON.stringify(['demo-note', 'second']), JSON.stringify(listed.entries.map((entry) => entry.name)));
    check('list entries carry type and updatedAt', listed.entries[0].type === 'user' && typeof listed.entries[0].updatedAt === 'string');

    // Tolerant parsing: a corrupt file must be reported, not throw.
    await writeFile(join(projectDir, 'corrupt.md'), '---\nname: [broken\n---\ncorrupt body\n', 'utf8');
    const afterCorrupt = await store.readScope('project', projectKey);
    check('a corrupt note still appears', afterCorrupt.entries.some((entry) => entry.file === 'corrupt.md'));
    check('a corrupt note is diagnosed', afterCorrupt.problems.some((problem) => problem.level === 'warn' && /frontmatter/.test(problem.message)));
    // Orphan index row + name mismatch diagnostics.
    await writeFile(join(projectDir, 'mismatch.md'), '---\nname: other-name\ndescription: d\nmetadata:\n  type: env\n---\n\nx\n', 'utf8');
    await writeFile(indexPath, `${await readFile(indexPath, 'utf8')}- [ghost](ghost.md) — ghost\n`, 'utf8');
    const diagnosed = await store.readScope('project', projectKey);
    check('a frontmatter/file name mismatch is diagnosed', diagnosed.problems.some((problem) => problem.name === 'other-name' && /differs from its file name/.test(problem.message)));
    check('an orphan index row is diagnosed', diagnosed.problems.some((problem) => problem.name === 'ghost' && /no such note/.test(problem.message)));
    check('a note without an index row is diagnosed', diagnosed.problems.some((problem) => /no row in MEMORY\.md/.test(problem.message)));

    const deleted = await store.deleteNote({ scope: 'project', projectKey, name: 'second' });
    check('delete removes the note', deleted.deleted === true && !existsSync(join(projectDir, 'second.md')));
    check('delete removes its index row', !(await readFile(indexPath, 'utf8')).includes('- [second](second.md)'));
    check('deleting a missing note is a no-op', (await store.deleteNote({ scope: 'project', projectKey, name: 'second' })).deleted === false);

    // Global scope.
    const global = await store.writeNote({ scope: 'global', name: 'global-note', description: 'Global description', content: 'global body', type: 'reference' });
    check('a global note lands in globalDir', global.path === join(roots.globalDir, 'global-note.md'));
    check('the global index is maintained', (await readFile(join(roots.globalDir, INDEX_NAME), 'utf8')).includes('[global-note](global-note.md)'));

    // Lock and temp cleanliness.
    const projectFiles = await readdir(projectDir);
    check('no lock file is left behind', !projectFiles.some((name) => name.endsWith('.lock')));
    check('no temp file is left behind', !projectFiles.some((name) => name.endsWith('.tmp')));

    // Multi-line description is flattened into one index row.
    await store.writeNote({ scope: 'project', projectKey, name: 'multiline', description: 'line one\nline two', content: 'b', type: 'env' });
    const indexText = await readFile(indexPath, 'utf8');
    check('a multi-line description becomes one index row', indexText.includes('- [multiline](multiline.md) — line one line two'));

    // Invalid input is rejected before touching the disk.
    const rejects = async (label, action) => {
      let rejected = false;
      try {
        await action();
      } catch {
        rejected = true;
      }
      check(label, rejected);
    };
    await rejects('an invalid type is rejected', () => store.writeNote({ scope: 'project', projectKey, name: 'x', description: 'd', content: 'c', type: 'nonsense' }));
    await rejects('an empty description is rejected', () => store.writeNote({ scope: 'project', projectKey, name: 'x', description: '   ', content: 'c' }));
    await rejects('an empty content is rejected', () => store.writeNote({ scope: 'project', projectKey, name: 'x', description: 'd', content: '  ' }));
    await rejects('an invalid name is rejected', () => store.writeNote({ scope: 'project', projectKey, name: '', description: 'd', content: 'c' }));

    // Concurrent writers on the same project: the lock + fresh index read must keep
    // every row (this is the acceptance test for the old server.py defect).
    const writers = [createMemoryStore({ roots, logger: { warn() {} } }), createMemoryStore({ roots, logger: { warn() {} } })];
    const names = Array.from({ length: 12 }, (_, index) => `concurrent-${String(index).padStart(2, '0')}`);
    await Promise.all(
      names.map((name, index) =>
        writers[index % 2].writeNote({ scope: 'project', projectKey, name, description: `concurrent ${index}`, content: 'body', type: 'env' }),
      ),
    );
    const concurrentIndex = await readFile(indexPath, 'utf8');
    check('every concurrent write kept its index row', names.every((name) => concurrentIndex.includes(`- [${name}](${name}.md)`)));
    const indexRowsForConcurrent = concurrentIndex.split('\n').filter((line) => line.includes('concurrent-'));
    check('exactly one index row per concurrent note', indexRowsForConcurrent.length === names.length, String(indexRowsForConcurrent.length));
    check('concurrent writes created every file', (await readdir(projectDir)).filter((name) => name.startsWith('concurrent-')).length === names.length);

    await rm(dir, { recursive: true, force: true });
  }

  // ------------------------------------------------------- E. search / list
  section('E. search and list');
  {
    const { dir, roots } = await makeRoots();
    const store = createMemoryStore({ roots, logger: { warn() {} } });
    const projectKey = projectKeyOf('D:\\work\\search-demo');
    await store.writeNote({ scope: 'project', projectKey, name: 'hardware-overview', description: '台式机硬件配置一览', content: 'CPU i5-12400F；GPU RTX 4060 8GB。', type: 'env' });
    await store.writeNote({ scope: 'project', projectKey, name: 'user-pref', description: '用户偏好：中文沟通', content: '默认使用中文。', type: 'user' });
    await store.writeNote({ scope: 'global', name: 'global-dsh', description: 'DSH 官方仓库已公开', content: '安装位置在 AppData。', type: 'reference' });

    const chinese = await store.search({ query: '硬件', scope: 'all', projectKey });
    check('a CJK query finds the note', chinese.hits.some((hit) => hit.name === 'hardware-overview'), JSON.stringify(chinese.hits));
    check('search hits carry score and snippet', typeof chinese.hits[0]?.score === 'number' && typeof chinese.hits[0]?.snippet === 'string');
    const english = await store.search({ query: 'RTX', scope: 'all', projectKey });
    check('an English body token finds the note', english.hits[0]?.name === 'hardware-overview');
    const scopedGlobal = await store.search({ query: 'dsh', scope: 'global', projectKey });
    check('scope=global only searches the global store', scopedGlobal.hits.every((hit) => hit.scope === 'global') && scopedGlobal.hits.length === 1);
    const typed = await store.search({ query: 'i5', scope: 'all', type: 'env', projectKey });
    check('the type filter is applied', typed.hits.length === 1 && typed.hits[0].type === 'env', JSON.stringify(typed.hits));
    check('a zero-hit query returns an empty list', (await store.search({ query: 'zzzz-not-there', scope: 'all', projectKey })).hits.length === 0);
    check('search requires a query', await store.search({ query: '   ', scope: 'all', projectKey }).then(() => false, () => true));

    const listedAll = await store.list({ scope: 'all', projectKey });
    check('list covers both scopes', listedAll.total === 3 && new Set(listedAll.entries.map((entry) => entry.scope)).size === 2);
    const listedType = await store.list({ scope: 'all', type: 'user', projectKey });
    check('list filters by type', listedType.total === 1 && listedType.entries[0].name === 'user-pref');
    const limited = await store.list({ scope: 'all', projectKey, limit: 1 });
    check('list honours the limit and reports the true total', limited.entries.length === 1 && limited.total === 3);

    const routed = await store.listEntries({ scope: 'all', query: '硬件', projectKey, limit: 10 });
    check('route-facing search rows carry score', routed.entries.length > 0 && typeof routed.entries[0].score === 'number');
    await rm(dir, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- F. digest
  section('F. digest budgets and cache');
  {
    const limits = resolveLimits({});
    check('default limits match the contract', DEFAULT_LIMITS.digestMaxTokens === 1200 && DEFAULT_LIMITS.digestMaxEntries === 24 && DEFAULT_LIMITS.digestEntryChars === 120);
    check('global memory is not injected by default', DEFAULT_LIMITS.digestIncludeGlobal === false && limits.digestIncludeGlobal === false);
    check('limit resolution ignores junk', resolveLimits({ digestMaxTokens: -5, digestMaxEntries: 'x' }).digestMaxTokens === 1200);
    check('an explicit boolean limit is honoured', resolveLimits({ digestIncludeProject: false }).digestIncludeProject === false);
    check('digestIncludeGlobal can be switched back on', resolveLimits({ digestIncludeGlobal: true }).digestIncludeGlobal === true);

    const globalEntries = Array.from({ length: 200 }, (_, index) => ({
      name: `g-${String(index).padStart(3, '0')}`,
      description: `全局条目 ${index} `.padEnd(200, '描'),
      updatedAt: new Date(2026, 0, 1, 0, 0, index).toISOString(),
    }));
    const projectEntries = Array.from({ length: 30 }, (_, index) => ({
      name: `p-${String(index).padStart(2, '0')}`,
      description: `项目条目 ${index} `.padEnd(200, '述'),
    }));

    // Default shape: the project index only, plus one line naming the global count.
    const defaultDigest = renderDigest({ global: { entries: globalEntries.slice(0, 18) }, project: { entries: projectEntries }, limits });
    const defaultProjectLines = defaultDigest.split('\n').filter((line) => /^- p-/.test(line));
    check('the default digest injects the project block only', defaultProjectLines.length === 24, String(defaultProjectLines.length));
    check('the default digest injects no global entries', defaultDigest.split('\n').filter((line) => /^- g-/.test(line)).length === 0);
    check('the default digest reports the project cap', /还有 6 条，用 memory_search 检索/.test(defaultDigest));
    check('the default digest keeps the global count as a one-line hint', defaultDigest.includes('全局记忆 18 条，用 memory_search 检索。'), defaultDigest.split('\n').slice(-1)[0]);
    check('the default header names only the project count', defaultDigest.startsWith('## 记忆（项目 30 条；用 memory_search 检索）'), defaultDigest.split('\n')[0]);
    check('each project description is truncated to 120 characters', defaultProjectLines.every((line) => {
      const description = line.split(' — ')[1] ?? '';
      return [...description].length <= 120;
    }));
    check(
      'the default digest is deterministic',
      renderDigest({ global: { entries: globalEntries.slice(0, 18) }, project: { entries: projectEntries }, limits }) === defaultDigest,
    );

    // The opt-in v0.1 shape: the whole global index, token-capped.
    const withGlobal = renderDigest({
      global: { entries: globalEntries },
      project: { entries: projectEntries },
      limits: resolveLimits({ digestIncludeGlobal: true }),
    });
    const injectedGlobalLines = withGlobal.split('\n').filter((line) => /^- g-/.test(line));
    check('digestIncludeGlobal=true injects the global index', injectedGlobalLines.length > 0 && withGlobal.includes('全局（最近'), String(injectedGlobalLines.length));
    check('the injected global block respects its token budget', estimateTokens(injectedGlobalLines.join('\n')) <= 1200, String(estimateTokens(injectedGlobalLines.join('\n'))));
    check('the injected global block names its omissions', /还有 \d+ 条，用 memory_search 检索/.test(withGlobal));
    check('the enabled-global header carries both counts', withGlobal.startsWith('## 记忆（全局 200 条 / 项目 30 条；用 memory_search 检索）'), withGlobal.split('\n')[0]);
    check('the enabled-global digest drops the count hint', !withGlobal.includes('全局记忆 200 条，用 memory_search 检索。'));

    check('both scopes empty renders nothing', renderDigest({ global: { entries: [] }, project: { entries: [] }, limits }) === '');
    const hintOnly = renderDigest({ global: { entries: globalEntries.slice(0, 3) }, project: null, limits });
    check('an unloaded project keeps only the global-count hint', hintOnly === '## 记忆（全局 3 条；用 memory_search 检索）\n\n全局记忆 3 条，用 memory_search 检索。', hintOnly);
    check('an empty project with global memory still hints', renderDigest({ global: { entries: globalEntries.slice(0, 3) }, project: { entries: [] }, limits }).includes('全局记忆 3 条，用 memory_search 检索。'));
    check('a project-only digest has a project header', renderDigest({ global: null, project: { entries: projectEntries.slice(0, 3) }, limits }).startsWith('## 记忆（项目 3 条'));

    check('truncateChars marks its cut with an ellipsis', truncateChars('abcdefghij', 5) === 'abcd…');
    check('estimateTokens counts CJK higher than latin', estimateTokens('记忆') > estimateTokens('ab'));

    // Store-backed cache: synchronous after an async refresh, and stable.
    const { dir, roots } = await makeRoots();
    const store = createMemoryStore({ roots, logger: { warn() {} } });
    const projectKey = projectKeyOf('D:\\work\\digest-demo');
    check('an unwarmed cache renders nothing synchronously', store.digestFor(projectKey) === '');
    await store.writeNote({ scope: 'global', name: 'global-demo', description: '全局缓存示例', content: 'b', type: 'env' });
    await store.writeNote({ scope: 'project', projectKey, name: 'project-demo', description: '项目缓存示例', content: 'b', type: 'env' });
    await store.refresh('global', null);
    await store.refresh('project', projectKey);
    const cached = store.digestFor(projectKey);
    check('the cached digest injects the project note', cached.includes('project-demo'), cached.split('\n')[0]);
    check('a freshly loaded cache bands a just-written note', /近期更新/.test(cached), cached.split('\n')[1]);
    check('the cached digest does not inject the global note', !cached.includes('global-demo'));
    check('the cached digest still reports the global count', cached.includes('全局记忆 1 条，用 memory_search 检索。'));
    check('the synchronous digest is stable across calls', store.digestFor(projectKey) === cached);
    const info = store.digestInfo(projectKey);
    check('digestInfo reports counts and tokens', info.global.count === 1 && info.project.count === 1 && info.tokenEstimate === estimateTokens(cached));
    check('digestInfo reports readiness', info.ready.global === true && info.ready.project === true);

    // Recency-first ordering + the recent band. The band is measured against the
    // snapshot's own `loadedAt`, so it is frozen for as long as the cache is.
    const nowIso = '2026-10-18T06:00:00.000Z';
    const loadedMs = Date.parse(nowIso);
    const stamp = (msAgo) => new Date(loadedMs - msAgo).toISOString();
    const manyEntries = Array.from({ length: 30 }, (_, index) => ({
      name: `p-${String(index).padStart(2, '0')}`,
      description: `项目条目 ${index}`,
      updatedAt: stamp(30 * 86400000 - index * 1000),
    }));
    // p-25 is the newest note: alphabetically it is the 26th row, i.e. exactly the row a
    // name-ordered 24-row cap used to drop. Recency ordering must show it.
    manyEntries[25] = { name: 'p-25', description: '项目条目 25', updatedAt: stamp(60 * 1000) };
    const recentDigest = renderDigest({ global: null, project: { entries: manyEntries, loadedAt: nowIso }, limits });
    const projectBullets = (text) => text.split('\n').filter((line) => /^- p-\d\d — /.test(line));
    check('the newest note leads the project block', projectBullets(recentDigest)[0]?.startsWith('- p-25 '), projectBullets(recentDigest)[0]);
    check('the recent band is its own block', /近期更新（最近 24 小时内）：/.test(recentDigest), recentDigest.split('\n')[1]);
    check('a note beyond the name-ordered cap is now visible', recentDigest.includes('- p-25 —'));
    check('the recent band is not repeated in the project block', projectBullets(recentDigest).filter((line) => line.startsWith('- p-25 ')).length === 1);
    check('the project block stays recency-ordered behind the band', projectBullets(recentDigest)[1]?.startsWith('- p-29 '), projectBullets(recentDigest)[1]);
    check(
      'the recent band has its own budget on top of the project cap',
      projectBullets(recentDigest).length === 25 && projectBullets(recentDigest).length <= limits.digestMaxEntries + limits.digestRecentMaxEntries,
      String(projectBullets(recentDigest).length),
    );
    check('the omission count covers every row not shown', /还有 5 条，用 memory_search 检索/.test(recentDigest));

    // The band is frozen at the cache's load time, never at the wall clock: an old
    // snapshot still bands its own last hour, which `Date.now()` could not do.
    const frozenEntries = [
      { name: 'frozen-new', description: 'd', updatedAt: '2025-12-31T23:00:00.000Z' },
      { name: 'frozen-old', description: 'd', updatedAt: '2025-12-01T00:00:00.000Z' },
    ];
    const frozen = renderDigest({ global: null, project: { entries: frozenEntries, loadedAt: '2026-01-01T00:00:00.000Z' }, limits });
    check('the recent band follows the snapshot load time', /近期更新/.test(frozen) && frozen.includes('frozen-new') && frozen.indexOf('frozen-new') < frozen.indexOf('frozen-old'));
    const outside = renderDigest({ global: null, project: { entries: frozenEntries, loadedAt: '2026-03-01T00:00:00.000Z' }, limits });
    check('a snapshot loaded later has no recent band', !/近期更新/.test(outside) && outside.includes('frozen-old'));
    const noLoadedAt = renderDigest({ global: null, project: { entries: manyEntries }, limits });
    check('a missing loadedAt disables the band but keeps recency order', !/近期更新/.test(noLoadedAt) && noLoadedAt.indexOf('- p-25 ') < noLoadedAt.indexOf('- p-29 '));
    check('the band is still deterministic', renderDigest({ global: null, project: { entries: manyEntries, loadedAt: nowIso }, limits }) === recentDigest);

    // Overflow: recency beyond the band cap stays at the head of the project list, so
    // nothing recent is dropped and the "还有 N 条" count is the whole truth.
    const bandCap = renderDigest({
      global: null,
      project: { entries: Array.from({ length: 10 }, (_, index) => ({ name: `r-${index}`, description: 'd', updatedAt: stamp(index * 1000) })), loadedAt: nowIso },
      limits: resolveLimits({ digestRecentMaxEntries: 3, digestMaxEntries: 4 }),
    });
    check('the band cap leaves the overflow at the head of the project list', bandCap.includes('- r-3 —') && !bandCap.includes('- r-7 —'));
    check('the band-capped digest counts every row it omits', /还有 3 条，用 memory_search 检索/.test(bandCap));
    check('the band limits are configurable and validated', resolveLimits({ digestRecentHours: 1, digestRecentMaxEntries: 2 }).digestRecentMaxEntries === 2 && resolveLimits({ digestRecentHours: 0 }).digestRecentHours === 24);
    await rm(dir, { recursive: true, force: true });
  }

  // ---------------------------------------------------- G. plugin wiring
  section('G. plugin wiring, tool schemas, tool execution');
  const { dir: wiringDir, roots: wiringRoots } = await makeRoots();
  {
    const registeredTools = [];
    const sections = [];
    const routeRegistrations = [];
    const eventHandlers = new Map();
    const effectDisposers = [];
    // A fake Workspace registry: `D:\work\wiring-demo` is owned by one Workspace, so
    // every key for it must be the workspace-prefixed hash. It is exposed ONLY through
    // ctx.get(): Cordis throws on direct property reads of a non-injected service, which
    // is exactly the production failure this test now guards against.
    const fakeWorkspaceRegistry = {
      resolveByPath: async (cwd) => (cwd === 'D:\\work\\wiring-demo' ? { id: 'ws-wiring-1' } : undefined),
    };
    const ctx = {
      tools: { register: (definition) => { registeredTools.push(definition); return () => {}; } },
      systemPrompt: { section: (definition) => { sections.push(definition); return () => {}; } },
      webServer: { register: (route) => { routeRegistrations.push(route); return () => {}; } },
      connection: { requestRejection: () => undefined },
      workingDirectory: { get: (session) => session?.cwd },
      effect: (fn) => {
        const dispose = fn();
        effectDisposers.push(dispose);
        return dispose;
      },
      on: (event, handler) => {
        const handlers = eventHandlers.get(event) ?? [];
        handlers.push(handler);
        eventHandlers.set(event, handlers);
        return () => {};
      },
      get: (name) => (name === 'workspaceRegistry' ? fakeWorkspaceRegistry : undefined),
      logger: { warn() {} },
    };
    apply(ctx, { memoryRoots: { global: wiringRoots.globalDir, projects: wiringRoots.projectsDir } });

    check('five tools are registered', registeredTools.length === 5, registeredTools.map((tool) => tool.name).join(','));
    check('the tool names match global-memory', JSON.stringify(registeredTools.map((tool) => tool.name).sort()) === JSON.stringify(['memory_delete', 'memory_list', 'memory_read', 'memory_search', 'memory_write']));
    check('the prompt section is registered', sections.length === 1 && sections[0].name === 'memory:digest');
    check('the section order is 150', sections[0].order === 150);
    check('the section does not interpolate', sections[0].interpolate === false);
    check('the section text is a synchronous function', typeof sections[0].text === 'function');
    check('ten routes are registered', routeRegistrations.length === 10, routeRegistrations.map((route) => route.path).join(','));
    check('the routes are exact paths', routeRegistrations.every((route) => route.kind === 'exact'));
    check(
      'the refresh events are subscribed',
      ['agent/created', 'agent/disposed', 'agent/turn-stopping', 'session/event'].every((event) => eventHandlers.has(event)),
      [...eventHandlers.keys()].join(','),
    );

    for (const tool of registeredTools) {
      const parameterProblems = schemaProblems(tool.parameters, `${tool.name}.parameters`);
      const outputProblems = schemaProblems(tool.output?.schema, `${tool.name}.output.schema`);
      check(`${tool.name} parameters are inside the host's JSON-Schema subset`, parameterProblems.length === 0, parameterProblems.join('; '));
      check(`${tool.name} output schema is inside the host's JSON-Schema subset`, outputProblems.length === 0, outputProblems.join('; '));
      check(`${tool.name} declares output.render`, typeof tool.output?.render === 'function');
    }

    const projectCwd = 'D:\\work\\wiring-demo';
    const pathKey = projectKeyOf(projectCwd);
    const workspaceKey = projectKeyOf(projectCwd, 'ws-wiring-1');
    check('a workspace id changes the key but not the slug', workspaceKey !== pathKey && workspaceKey.startsWith('wiring-demo-'), workspaceKey);
    // One session object across every handler: the plugin caches the resolved key per session.
    const session = { cwd: projectCwd };
    const agent = { session };
    const exec = { agent, signal: { aborted: false } };
    const tool = (name) => registeredTools.find((definition) => definition.name === name);
    const renderOf = (name, args, value) => tool(name).output.render(args, value);

    // The section's agent/created warm-up.
    for (const handler of eventHandlers.get('agent/created') ?? []) handler({ agent });
    await sleep(60);

    const writeResult = await tool('memory_write').execute({ name: 'tool-note', description: 'Tool description', content: 'Tool body.', type: 'env' }, exec);
    check('memory_write reports ok/created/scope/path', writeResult.ok === true && writeResult.created === true && writeResult.scope === 'project' && writeResult.path.endsWith('tool-note.md'), JSON.stringify(writeResult));
    check(
      'memory_write reports the dedupe and redaction fields',
      Array.isArray(writeResult.similar) && Array.isArray(writeResult.aliases) && writeResult.redacted === 0 && writeResult.viaAlias === '',
      JSON.stringify(writeResult),
    );
    check('memory_write creates the project note', existsSync(writeResult.path));
    const nearDuplicate = await tool('memory_write').execute({ name: 'tool-note-copy', description: 'Tool description', content: 'Tool body.', type: 'env' }, exec);
    check('memory_write hints at a near-duplicate without blocking', nearDuplicate.ok === true && nearDuplicate.similar.some((hit) => hit.name === 'tool-note'), JSON.stringify(nearDuplicate.similar));
    check('the hint reaches the model in the rendered result', renderOf('memory_write', {}, nearDuplicate)[0].text.includes('Similar existing memories'));
    await tool('memory_delete').execute({ name: 'tool-note-copy' }, exec);
    check(
      'a workspace-owned directory stores under the workspace-prefixed key',
      writeResult.path.includes(workspaceKey) && !writeResult.path.includes(pathKey),
      writeResult.path,
    );

    const sectionText = sections[0].text({ agent });
    check('the section text is synchronous and includes the written note', typeof sectionText === 'string' && sectionText.includes('tool-note'), sectionText.split('\n')[0]);
    check('the section text is stable', sections[0].text({ agent }) === sectionText);
    check('the section text without an agent does not throw', typeof sections[0].text({}) === 'string');

    // A mid-session `cd`: the session/event listener loads the new project's cache so
    // the next synchronous assemble can see it.
    const secondCwd = 'D:\\work\\second-project';
    const secondSession = { cwd: secondCwd };
    const secondAgent = { session: secondSession };
    const secondKey = projectKeyOf(secondCwd);
    const secondDir = join(wiringRoots.projectsDir, secondKey, 'memory');
    await mkdir(secondDir, { recursive: true });
    await writeFile(join(secondDir, 'second-note.md'), formatNote({ name: 'second-note', description: 'second desc', content: 'second body', type: 'env' }), 'utf8');
    await writeFile(join(secondDir, INDEX_NAME), `${indexLine('second-note', 'second desc')}\n`, 'utf8');
    for (const handler of eventHandlers.get('session/event') ?? []) handler(secondSession, { type: 'working-directory/change', data: { cwd: secondCwd } });
    await sleep(60);
    const secondText = sections[0].text({ agent: secondAgent });
    check('a directory change loads the new project digest', secondText.includes('second-note'), secondText.split('\n')[0]);

    const readResult = await tool('memory_read').execute({ name: 'TOOL-NOTE' }, exec);
    check('memory_read finds a note case-insensitively', readResult.name === 'tool-note' && readResult.content.trim() === 'Tool body.' && typeof readResult.updatedAt === 'string');
    check('memory_read render returns a text content block', Array.isArray(renderOf('memory_read', { name: 'tool-note' }, readResult)) && renderOf('memory_read', { name: 'tool-note' }, readResult)[0].type === 'text');

    const searchResult = await tool('memory_search').execute({ query: 'tool' }, exec);
    check('memory_search returns the note', searchResult.total >= 1 && searchResult.results[0].name === 'tool-note' && searchResult.results[0].scope === 'project');
    check('memory_search keeps its result rows inside the declared schema', !('path' in searchResult.results[0]) && !('updatedAt' in searchResult.results[0]));
    const listResult = await tool('memory_list').execute({}, exec);
    check('memory_list returns the note', listResult.total >= 1 && listResult.entries.some((entry) => entry.name === 'tool-note'));
    check('memory_list render is text', renderOf('memory_list', {}, listResult)[0].type === 'text');

    const globalWrite = await tool('memory_write').execute({ name: 'global-tool-note', description: 'Global tool note', content: 'global body', scope: 'global', type: 'reference' }, exec);
    check('memory_write can target the global scope', globalWrite.scope === 'global' && existsSync(globalWrite.path));

    let missingRead = '';
    try {
      await tool('memory_read').execute({ name: 'does-not-exist' }, exec);
    } catch (error) {
      missingRead = String(error.message);
    }
    check('memory_read missing note is a self-healable error', missingRead.includes('memory not found'), missingRead);

    let badType = '';
    try {
      await tool('memory_write').execute({ name: 'bad-type', description: 'd', content: 'c', type: 'nonsense' }, exec);
    } catch (error) {
      badType = String(error.message);
    }
    check('memory_write rejects an unknown type', badType.includes('invalid type'), badType);

    const deleteResult = await tool('memory_delete').execute({ name: 'tool-note' }, exec);
    check('memory_delete removes the note', deleteResult.ok === true && deleteResult.removed === true);
    check('memory_delete names the note it removed', deleteResult.name === 'tool-note' && deleteResult.viaAlias === '', JSON.stringify(deleteResult));
    check('memory_delete render is text', renderOf('memory_delete', { name: 'tool-note' }, deleteResult)[0].type === 'text');
    let deleteAgain = '';
    try {
      await tool('memory_delete').execute({ name: 'tool-note' }, exec);
    } catch (error) {
      deleteAgain = String(error.message);
    }
    check('deleting a missing note is a self-healable error', deleteAgain.includes('memory not found'), deleteAgain);

    // A tool without an agent still works for global scope but refuses project scope.
    let projectNeedsAgent = '';
    try {
      await tool('memory_write').execute({ name: 'no-agent', description: 'd', content: 'c' }, {});
    } catch (error) {
      projectNeedsAgent = String(error.message);
    }
    check('project writes require an agent session', projectNeedsAgent.includes('agent session'), projectNeedsAgent);
    check('global writes work without an agent', (await tool('memory_write').execute({ name: 'agentless-global', description: 'd', content: 'c', scope: 'global' }, {})).scope === 'global');

    // Disposing the fiber-mounted surface must not throw.
    let disposed = false;
    try {
      for (const dispose of effectDisposers) {
        if (typeof dispose === 'function') dispose();
        else disposed = true;
      }
    } catch {
      disposed = true;
    }
    check('the plugin surface is disposable', effectDisposers.length === 1 && disposed === false);
  }
  await rm(wiringDir, { recursive: true, force: true });

  // ------------------------- G2. no workspace service (Cordis inject fence)
  section('G2. absent workspace registry');
  {
    // Reproduces the production failure mode: Cordis throws on a direct property read
    // of a service the plugin did not inject. Any such read here fails the check with
    // the real message instead of silently working in the tests.
    const strictContext = (base) =>
      new Proxy(base, {
        get(target, property, receiver) {
          if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
          throw new Error(`cannot get property "${String(property)}" without inject`);
        },
      });

    const makeHost = async ({ get, roots }) => {
      const tools = [];
      const routes = [];
      const effects = [];
      const base = {
        tools: { register: (definition) => { tools.push(definition); return () => {}; } },
        systemPrompt: { section: () => () => {} },
        webServer: { register: (route) => { routes.push(route); return () => {}; } },
        connection: { requestRejection: () => undefined },
        workingDirectory: { get: (session) => session?.cwd },
        effect: (fn) => { const dispose = fn(); effects.push(dispose); return dispose; },
        on: () => () => {},
        get,
        logger: { warn() {} },
      };
      apply(strictContext(base), { memoryRoots: { global: roots.globalDir, projects: roots.projectsDir } });
      return { tools, routes, effects };
    };

    const callRoute = async (route, options) => {
      const response = mockResponse();
      await route.handler(mockRequest(options), response);
      return { status: response.statusCode, body: response.body };
    };

    // Variant 1: ctx.get() throws — the context has no workspace service at all.
    const first = await makeRoots();
    try {
      const host = await makeHost({
        get: () => {
          throw new Error('cannot get property "workspaceRegistry" without inject');
        },
        roots: first.roots,
      });
      const tool = (name) => host.tools.find((definition) => definition.name === name);
      const projectCwd = 'D:\\work\\no-workspace-demo';
      const exec = { agent: { session: { cwd: projectCwd } }, signal: { aborted: false } };

      const emptyList = await tool('memory_list').execute({}, exec);
      check(
        'memory_list on an empty store returns { entries: [], total: 0 }',
        emptyList.total === 0 && Array.isArray(emptyList.entries) && emptyList.entries.length === 0,
        JSON.stringify(emptyList),
      );
      const written = await tool('memory_write').execute({ name: 'reg-note', description: 'registry-free note', content: 'registry-free body', type: 'env' }, exec);
      check('memory_write works without a workspace service', written.ok === true && written.scope === 'project' && existsSync(written.path), JSON.stringify(written));
      const read = await tool('memory_read').execute({ name: 'reg-note' }, exec);
      check('memory_read works without a workspace service', read.name === 'reg-note' && read.content.trim() === 'registry-free body');
      const search = await tool('memory_search').execute({ query: 'registry' }, exec);
      check('memory_search works without a workspace service', search.total >= 1 && search.results[0].name === 'reg-note');
      const list = await tool('memory_list').execute({}, exec);
      check('memory_list sees the written note', list.total === 1 && list.entries[0].name === 'reg-note');
      const deleted = await tool('memory_delete').execute({ name: 'reg-note' }, exec);
      check('memory_delete works without a workspace service', deleted.removed === true);

      const route = (suffix) => host.routes.find((entry) => entry.path === `/memory-manager/api/${suffix}`);
      const cwdParam = encodeURIComponent(projectCwd);
      const responses = {
        digest: await callRoute(route('digest'), { url: `/memory-manager/api/digest?cwd=${cwdParam}` }),
        entries: await callRoute(route('entries'), { url: `/memory-manager/api/entries?scope=all&cwd=${cwdParam}` }),
        entry: await callRoute(route('entry'), { url: `/memory-manager/api/entry?scope=global&name=missing&cwd=${cwdParam}` }),
        diagnostics: await callRoute(route('diagnostics'), { url: `/memory-manager/api/diagnostics?cwd=${cwdParam}` }),
      };
      check(
        'the four read routes survive a missing workspace service',
        responses.digest.status === 200 && responses.entries.status === 200 && responses.entry.status === 404 && responses.diagnostics.status === 200,
        Object.entries(responses).map(([name, value]) => `${name}:${value.status}`).join(','),
      );
      check(
        'no route answered 500 or leaked the Cordis inject error',
        Object.values(responses).every((value) => value.status !== 500) &&
          !Object.values(responses).map((value) => value.body).join('').includes('without inject'),
      );
    } finally {
      await rm(first.dir, { recursive: true, force: true });
    }

    // Variant 2: ctx.get() returns undefined (service simply not mounted).
    const second = await makeRoots();
    try {
      const host = await makeHost({ get: () => undefined, roots: second.roots });
      const tool = (name) => host.tools.find((definition) => definition.name === name);
      const projectCwd = 'D:\\work\\no-workspace-demo-2';
      const exec = { agent: { session: { cwd: projectCwd } }, signal: { aborted: false } };
      const list = await tool('memory_list').execute({}, exec);
      check('memory_list survives ctx.get() returning undefined', list.total === 0 && Array.isArray(list.entries));
      const digestRoute = host.routes.find((entry) => entry.path === '/memory-manager/api/digest');
      const digest = await callRoute(digestRoute, { url: `/memory-manager/api/digest?cwd=${encodeURIComponent(projectCwd)}` });
      check('the digest route survives ctx.get() returning undefined', digest.status === 200);
    } finally {
      await rm(second.dir, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------- H. routes
  section('H. HTTP routes');
  {
    const { dir, roots } = await makeRoots();
    const store = createMemoryStore({ roots, logger: { warn() {} } });
    const projectCwd = 'D:\\work\\routes-demo';
    const projectKey = projectKeyOf(projectCwd);
    await store.writeNote({ scope: 'project', projectKey, name: 'route-note', description: 'Route note description', content: 'Route note body.', type: 'env' });
    await store.writeNote({ scope: 'global', name: 'route-global', description: 'Global route note', content: 'global body', type: 'reference' });

    let rejection = undefined;
    const routes = [];
    const opened = [];
    const ctx = {
      connection: { requestRejection: () => rejection },
      webServer: { register: (route) => { routes.push(route); return () => {}; } },
    };
    registerRoutes(ctx, store, { openDirectory: async (path) => opened.push(path) });

    const route = (suffix) => routes.find((entry) => entry.path === `/memory-manager/api/${suffix}`);
    const call = async (suffix, options) => {
      const response = mockResponse();
      await route(suffix).handler(mockRequest(options), response);
      let json = null;
      try {
        json = JSON.parse(response.body);
      } catch {
        json = null;
      }
      return { status: response.statusCode, headers: response.headers, body: response.body, json };
    };

    check('ten routes are registered', routes.length === 10, routes.map((entry) => entry.path).join(','));

    rejection = 401;
    const denied = await call('digest');
    check('an unauthenticated request is refused before any work', denied.status === 401 && denied.body === '');
    rejection = undefined;

    const digest = await call('digest', { url: `/memory-manager/api/digest?project=${projectKey}` });
    check('GET /digest answers 200', digest.status === 200);
    check('GET /digest is no-store', digest.headers['cache-control'] === 'no-store');
    check(
      'GET /digest returns the digest text',
      typeof digest.json.digest === 'string' && digest.json.digest.includes('route-note') && digest.json.digest.includes('全局记忆 1 条，用 memory_search 检索。'),
      digest.json.digest,
    );
    check('GET /digest does not inject global entries by default', !digest.json.digest.includes('route-global'));
    check('GET /digest returns a token estimate', typeof digest.json.tokenEstimate === 'number' && digest.json.tokenEstimate > 0);
    check('GET /digest returns counts and paths', digest.json.global.count === 1 && digest.json.project.count === 1 && digest.json.paths.globalDir === roots.globalDir);
    check('GET /digest returns the current project', digest.json.currentProject.key === projectKey && digest.json.currentProject.name === 'routes-demo');

    const entries = await call('entries', { url: `/memory-manager/api/entries?scope=all&project=${projectKey}` });
    check('GET /entries answers 200', entries.status === 200);
    check('GET /entries returns a bare array', Array.isArray(entries.json.entries) && entries.json.total === 2, JSON.stringify(entries.json).slice(0, 120));
    check('GET /entries rows carry scope and path', entries.json.entries.every((entry) => typeof entry.scope === 'string' && typeof entry.path === 'string'));
    const searched = await call('entries', { url: `/memory-manager/api/entries?scope=all&project=${projectKey}&query=route` });
    check('GET /entries with query returns scored rows', searched.json.entries.length > 0 && typeof searched.json.entries[0].score === 'number');
    check('searched rows keep their file path for the UI', searched.json.entries.every((row) => typeof row.path === 'string'));
    const badScope = await call('entries', { url: '/memory-manager/api/entries?scope=galaxy' });
    check('GET /entries rejects an unknown scope', badScope.status === 400 && badScope.json.error.code === 'bad-request');
    const badProject = await call('entries', { url: '/memory-manager/api/entries?project=..%2F..%2Fevil' });
    check('GET /entries rejects a malformed project key', badProject.status === 400);

    const entry = await call('entry', { url: `/memory-manager/api/entry?scope=project&project=${projectKey}&name=route-note` });
    check('GET /entry returns the full note', entry.status === 200 && entry.json.found === true && entry.json.content.trim() === 'Route note body.' && entry.json.scope === 'project');
    check('GET /entry is no-store', entry.headers['cache-control'] === 'no-store');
    const missingEntry = await call('entry', { url: `/memory-manager/api/entry?project=${projectKey}&name=nope` });
    check('GET /entry missing note is a 404', missingEntry.status === 404 && missingEntry.json.error.code === 'not-found');
    const noName = await call('entry', { url: '/memory-manager/api/entry' });
    check('GET /entry without a name is a 400', noName.status === 400 && noName.json.error.code === 'bad-request');

    const diagnostics = await call('diagnostics', { url: `/memory-manager/api/diagnostics?project=${projectKey}` });
    check('GET /diagnostics answers 200', diagnostics.status === 200);
    check('GET /diagnostics reports ok and writer backend', typeof diagnostics.json.ok === 'boolean' && ['used', 'fallback'].includes(diagnostics.json.writer), JSON.stringify(diagnostics.json.writer));
    check('GET /diagnostics lists the current project', Array.isArray(diagnostics.json.projects) && diagnostics.json.projects.some((project) => project.key === projectKey && project.current === true));
    check('GET /diagnostics returns problems and lock facts', Array.isArray(diagnostics.json.problems) && diagnostics.json.lock !== null && typeof diagnostics.json.lock.path === 'string');
    check('GET /diagnostics returns paths', diagnostics.json.paths.globalDir === roots.globalDir && diagnostics.json.paths.projectsDir === roots.projectsDir);

    const writeAttempt = await call('entries', { method: 'POST', url: '/memory-manager/api/entries', headers: { 'content-type': 'application/json' }, body: '{}' });
    check('a POST to a read route is 403 read-only', writeAttempt.status === 403 && writeAttempt.json.error.code === 'read-only');
    const wrongMethod = await call('entries', { method: 'PUT', url: '/memory-manager/api/entries' });
    check('an unsupported method is 405 with allow', wrongMethod.status === 405 && wrongMethod.headers.allow === 'GET, HEAD, POST');

    const openedResponse = await call('open-dir', { method: 'POST', url: '/memory-manager/api/open-dir', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'project', project: projectKey }) });
    check('POST /open-dir answers 200 with the directory', openedResponse.status === 200 && openedResponse.json.ok === true && openedResponse.json.path === store.projectDir(projectKey));
    check('POST /open-dir actually asks the OS to open the directory', opened.length === 1 && opened[0] === store.projectDir(projectKey));
    const openGlobal = await call('open-dir', { method: 'POST', url: '/memory-manager/api/open-dir', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'global' }) });
    check('POST /open-dir can open the global directory', openGlobal.status === 200 && opened[1] === roots.globalDir);
    const openBadScope = await call('open-dir', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'elsewhere' }) });
    check('POST /open-dir rejects an unknown scope', openBadScope.status === 400);
    const openMissing = await call('open-dir', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'project', project: 'never-written-0123456789abcdef' }) });
    check('POST /open-dir reports a missing directory as 404', openMissing.status === 404, openMissing.body);
    const openPlain = await call('open-dir', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    check('POST /open-dir requires JSON', openPlain.status === 415);
    const openGet = await call('open-dir', { method: 'GET' });
    check('GET /open-dir is 405', openGet.status === 405 && openGet.headers.allow === 'POST');

    await rm(dir, { recursive: true, force: true });
  }

  // ---------------------------------------------- I. roots, keys, empty store
  section('I. root resolution, project keys, empty store');
  {
    const config = resolveRoots({ memoryRoots: { global: 'D:\\mem\\global', projects: 'D:\\mem\\projects' } }, {}, 'C:\\Users\\x');
    check('config roots win over defaults', config.globalDir === 'D:\\mem\\global' && config.projectsDir === 'D:\\mem\\projects');
    const envRoots = resolveRoots({}, { GLOBAL_MEMORY_DIR: 'D:\\env\\global', DSH_HOME: 'D:\\dsh' }, 'C:\\Users\\x');
    check('GLOBAL_MEMORY_DIR is honoured', envRoots.globalDir === 'D:\\env\\global');
    check('projectsDir defaults under DSH_HOME', envRoots.projectsDir === 'D:\\dsh\\memories\\projects', envRoots.projectsDir);
    const homeRoots = resolveRoots({}, {}, 'C:\\Users\\x');
    check('the default global root is DSH-owned', homeRoots.globalDir === 'C:\\Users\\x\\.dsh\\memories\\global', homeRoots.globalDir);
    check('the default projects root is DSH-owned', homeRoots.projectsDir === 'C:\\Users\\x\\.dsh\\memories\\projects', homeRoots.projectsDir);
    check('the ZCode global directory is never a default', !homeRoots.globalDir.includes('.zcode'));

    // Workspace priority: stable per workspace, distinct from the path hash.
    const pathKey = projectKeyOf('D:\\work\\demo');
    const wsKey = projectKeyOf('D:\\work\\demo', 'ws-abc-123');
    check('a workspace id takes priority over the path hash', wsKey !== pathKey, `${wsKey} vs ${pathKey}`);
    check('the workspace key is stable', projectKeyOf('D:\\work\\demo', 'ws-abc-123') === wsKey);
    check('the workspace key keeps the directory slug', wsKey.startsWith('demo-') && wsKey.endsWith(`-${wsKey.split('-').pop()}`), wsKey);
    check('an empty workspace id falls back to the path hash', projectKeyOf('D:\\work\\demo', '') === pathKey);
    check('the workspace hash input is prefixed', keyHashInput('D:\\work\\demo', 'ws-abc-123') === 'workspace:ws-abc-123');

    // A fresh install: roots are created, and every read is an empty state, not an error.
    const { dir, roots } = await makeRoots();
    const emptyStore = createMemoryStore({ roots, logger: { warn() {} } });
    const ensured = await emptyStore.ensureRoots();
    check('ensureRoots creates both roots', existsSync(ensured.globalDir) && existsSync(ensured.projectsDir));
    const emptyList = await emptyStore.listEntries({ scope: 'all', projectKey: pathKey });
    check('an empty store lists without error', emptyList.total === 0 && emptyList.entries.length === 0);
    check('an empty store renders no digest', emptyStore.digestFor(pathKey) === '');
    const emptyGlobal = await emptyStore.listEntries({ scope: 'global' });
    check('an empty global scope lists without error', emptyGlobal.total === 0 && emptyGlobal.entries.length === 0);
    const emptyDiagnostics = await emptyStore.diagnostics({});
    check('diagnostics on an empty store succeeds', emptyDiagnostics.ok === true && Array.isArray(emptyDiagnostics.projects) && emptyDiagnostics.projects.length === 0);

    // The HTTP layer must return empty state, not an error, before the first write.
    const emptyRoutes = [];
    registerRoutes(
      {
        connection: { requestRejection: () => undefined },
        webServer: { register: (route) => { emptyRoutes.push(route); return () => {}; } },
      },
      emptyStore,
      { openDirectory: async () => {} },
    );
    const emptyDigestRoute = emptyRoutes.find((entry) => entry.path.endsWith('/digest'));
    const emptyDigestResponse = mockResponse();
    await emptyDigestRoute.handler(mockRequest({ url: `/memory-manager/api/digest?project=${pathKey}` }), emptyDigestResponse);
    const emptyDigestBody = JSON.parse(emptyDigestResponse.body);
    check(
      'an empty store answers /digest with an empty digest and zero counts',
      emptyDigestResponse.statusCode === 200 && emptyDigestBody.digest === '' && emptyDigestBody.global.count === 0 && emptyDigestBody.project.count === 0,
      emptyDigestResponse.body.slice(0, 160),
    );
    const emptyEntriesRoute = emptyRoutes.find((entry) => entry.path.endsWith('/entries'));
    const emptyEntriesResponse = mockResponse();
    await emptyEntriesRoute.handler(mockRequest({ url: `/memory-manager/api/entries?scope=all&project=${pathKey}` }), emptyEntriesResponse);
    check('an empty store answers /entries with an empty list', emptyEntriesResponse.statusCode === 200 && JSON.parse(emptyEntriesResponse.body).total === 0);
    await rm(dir, { recursive: true, force: true });

    const backend = await atomicWriteBackend();
    check('the writer backend is reported', backend === 'used' || backend === 'fallback', backend);
    check('projectName strips the hash', projectName('demo-a-90d18ee4adaecf32') === 'demo-a');
    check('valid types are the five ZCode categories', JSON.stringify([...VALID_TYPES]) === JSON.stringify(['env', 'user', 'feedback', 'project', 'reference']));
  }

  // ------------------------------------------------- J. write routes (P1)
  section('J. write routes (create / update / delete)');
  {
    const dir = await mkdtemp(join(tmpdir(), 'memory-manager-write-'));
    const roots = { globalDir: join(dir, 'global'), projectsDir: join(dir, 'projects') };
    const store = createMemoryStore({ roots, logger: { warn() {} } });
    const projectCwd = 'D:\\work\\write-demo';
    const projectKey = projectKeyOf(projectCwd);
    const projectDir = store.projectDir(projectKey);
    const routes = [];
    let rejection;
    registerRoutes(
      {
        connection: { requestRejection: () => rejection },
        webServer: { register: (route) => { routes.push(route); return () => {}; } },
      },
      store,
      { openDirectory: async () => {} },
    );
    const route = (path) => routes.find((entry) => entry.path === `/memory-manager/api/${path}`);
    const call = async (path, { method = 'GET', url, body, headers } = {}) => {
      const response = mockResponse();
      await route(path).handler(
        mockRequest({
          method,
          url: url ?? `/memory-manager/api/${path}`,
          headers: headers ?? (body === undefined ? {} : { 'content-type': 'application/json' }),
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        response,
      );
      let json = null;
      try {
        json = JSON.parse(response.body);
      } catch {
        json = null;
      }
      return { status: response.statusCode, headers: response.headers, body: response.body, json };
    };
    const postEntry = (body) => call('entry', { method: 'POST', body });
    const getEntry = (query) => call('entry', { url: `/memory-manager/api/entry?${query}` });

    try {
      const created = await postEntry({
        action: 'create',
        scope: 'project',
        project: projectKey,
        name: 'write-note',
        description: 'write route note',
        content: 'create body',
        type: 'env',
      });
      check('POST /entry create answers 200', created.status === 200, created.body);
      check('create returns ok/name/scope/created', created.json?.ok === true && created.json.name === 'write-note' && created.json.scope === 'project' && created.json.created === true, created.body);
      check('the write response is path-free', created.json !== null && !('path' in created.json));
      check('the write response is no-store', created.headers['cache-control'] === 'no-store');
      check('the write response leaks no absolute memory path', !created.body.includes(roots.projectsDir) && !created.body.includes(roots.globalDir));
      check('the note file is written', existsSync(join(projectDir, 'write-note.md')));
      check('the index row is written', (await readFile(join(projectDir, INDEX_NAME), 'utf8')).includes('- [write-note](write-note.md) — write route note'));
      check('the digest cache was refreshed with the new note', store.digestFor(projectKey).includes('write-note'));

      const read = await getEntry(`scope=project&project=${projectKey}&name=write-note`);
      check('create → read round-trip', read.status === 200 && read.json?.found === true && read.json.content.trim() === 'create body' && read.json.description === 'write route note');

      const duplicate = await postEntry({ action: 'create', scope: 'project', project: projectKey, name: 'write-note', description: 'other', content: 'other body' });
      check('create with an existing name is a 409 conflict', duplicate.status === 409 && duplicate.json?.error?.code === 'conflict', duplicate.body);
      check('the rejected duplicate leaves the note intact', (await readFile(join(projectDir, 'write-note.md'), 'utf8')).includes('create body'));

      const missingUpdate = await postEntry({ action: 'update', scope: 'project', project: projectKey, name: 'missing-note', description: 'x' });
      check('update of a missing note is a 404', missingUpdate.status === 404 && missingUpdate.json?.error?.code === 'not-found', missingUpdate.body);

      const updated = await postEntry({ action: 'update', scope: 'project', project: projectKey, name: 'write-note', description: 'updated description' });
      check('a partial update merges over the note on disk', updated.status === 200 && updated.json?.created === false && updated.json.name === 'write-note', updated.body);
      const afterUpdate = await readFile(join(projectDir, 'write-note.md'), 'utf8');
      check('an omitted field keeps its previous value', afterUpdate.includes('create body'));
      check('the supplied field is replaced', afterUpdate.includes('description: updated description'));
      check('the index description follows the update', (await readFile(join(projectDir, INDEX_NAME), 'utf8')).includes('— updated description'));

      const searched = await call('entries', { url: `/memory-manager/api/entries?scope=project&project=${projectKey}&query=write` });
      check('search after create/update finds the note', searched.status === 200 && searched.json?.entries?.some((entry) => entry.name === 'write-note' && entry.description === 'updated description'));

      const badType = await postEntry({ action: 'create', scope: 'project', project: projectKey, name: 'bad-type-note', description: 'd', content: 'c', type: 'nonsense' });
      check('an invalid type is a 400', badType.status === 400 && badType.json?.error?.code === 'bad-request', badType.body);
      const badName = await postEntry({ action: 'create', scope: 'project', project: projectKey, name: 'MEMORY', description: 'd', content: 'c' });
      check('a reserved/invalid name is a 400', badName.status === 400 && badName.json?.error?.code === 'bad-request', badName.body);
      const emptyDescription = await postEntry({ action: 'create', scope: 'project', project: projectKey, name: 'empty-note', description: '   ', content: 'c' });
      check('an empty description is a 400', emptyDescription.status === 400, emptyDescription.body);
      const badAction = await postEntry({ action: 'archive', scope: 'project', project: projectKey, name: 'x' });
      check('an unknown action is a 400', badAction.status === 400 && badAction.json?.error?.code === 'bad-request');
      const badScope = await postEntry({ action: 'create', scope: 'galaxy', name: 'x', description: 'd', content: 'c' });
      check('an invalid scope is a 400', badScope.status === 400);

      // A corrupt note on disk must be refused rather than silently overwritten.
      await writeFile(join(projectDir, 'broken-note.md'), '---\nname: [broken\n---\nold body\n', 'utf8');
      const brokenUpdate = await postEntry({ action: 'update', scope: 'project', project: projectKey, name: 'broken-note', description: 'new' });
      check('updating a note with corrupt frontmatter is a 400', brokenUpdate.status === 400 && brokenUpdate.json?.error?.code === 'bad-request', brokenUpdate.body);
      check('the corrupt note was not rewritten', (await readFile(join(projectDir, 'broken-note.md'), 'utf8')).includes('name: [broken'));

      const secret = 'ghp_leak_secret_1234567890';
      const secretCreate = await postEntry({ action: 'create', scope: 'project', project: projectKey, name: 'secret-note', description: 'secret test', content: `content ${secret}` });
      check('a write response never echoes note content', secretCreate.status === 200 && !secretCreate.body.includes(secret));
      const secretUpdate = await postEntry({ action: 'update', scope: 'project', project: projectKey, name: 'secret-note', description: 'secret test 2' });
      check('an update response never echoes note content', secretUpdate.status === 200 && !secretUpdate.body.includes(secret));

      // Global scope through the same route.
      const globalCreate = await postEntry({ action: 'create', scope: 'global', name: 'write-global', description: 'global note', content: 'global body', type: 'reference' });
      check('create works in the global scope without a project context', globalCreate.status === 200 && globalCreate.json.scope === 'global' && existsSync(join(roots.globalDir, 'write-global.md')), globalCreate.body);
      const sameNameProject = await postEntry({ action: 'create', scope: 'project', project: projectKey, name: 'write-global', description: 'same name, project scope', content: 'project body' });
      check('the same name may exist in both scopes', sameNameProject.status === 200 && sameNameProject.json.scope === 'project');

      // Concurrent creates through the HTTP path: the lock + fresh index read must keep
      // every row (the acceptance test for the old MCP server's lost-update defect).
      const concurrentNames = Array.from({ length: 10 }, (_, index) => `route-concurrent-${index}`);
      const concurrent = await Promise.all(
        concurrentNames.map((name, index) =>
          postEntry({ action: 'create', scope: 'project', project: projectKey, name, description: `concurrent ${index}`, content: 'body', type: 'env' }),
        ),
      );
      check('ten concurrent creates all succeed', concurrent.every((result) => result.status === 200), concurrent.map((result) => result.status).join(','));
      const concurrentIndex = await readFile(join(projectDir, INDEX_NAME), 'utf8');
      check('ten concurrent creates all keep their index row', concurrentNames.every((name) => concurrentIndex.includes(`- [${name}](${name}.md)`)));
      check('ten concurrent creates created ten files', (await readdir(projectDir)).filter((name) => name.startsWith('route-concurrent-')).length === 10);
      const leftovers = (await readdir(projectDir)).filter((name) => name.endsWith('.lock') || name.endsWith('.tmp'));
      check('concurrent writes leave no lock or temp file', leftovers.length === 0, leftovers.join(','));

      const deleted = await postEntry({ action: 'delete', scope: 'project', project: projectKey, name: 'write-note' });
      check('delete answers ok/removed', deleted.status === 200 && deleted.json?.ok === true && deleted.json.removed === true, deleted.body);
      check('delete removes the file and its index row', !existsSync(join(projectDir, 'write-note.md')) && !(await readFile(join(projectDir, INDEX_NAME), 'utf8')).includes('write-note'));
      const gone = await getEntry(`scope=project&project=${projectKey}&name=write-note`);
      check('reading a deleted note is a 404', gone.status === 404 && gone.json?.error?.code === 'not-found');
      const deleteAgain = await postEntry({ action: 'delete', scope: 'project', project: projectKey, name: 'write-note' });
      check('deleting a missing note is a 404', deleteAgain.status === 404);

      // HTTP fences.
      rejection = 401;
      const denied = await postEntry({ action: 'create', scope: 'project', project: projectKey, name: 'x', description: 'd', content: 'c' });
      check('an unauthenticated write is refused before any work', denied.status === 401 && denied.body === '');
      rejection = undefined;
      const plain = mockResponse();
      await route('entry').handler(mockRequest({ method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }), plain);
      check('a non-JSON write is a 415', plain.statusCode === 415);
      const put = await call('entry', { method: 'PUT' });
      check('an unsupported /entry method is 405 with allow', put.status === 405 && put.headers.allow === 'GET, HEAD, POST');
      const readOnlyPost = await call('entries', { method: 'POST', body: {} });
      check('the other read routes still answer 403 to POST', readOnlyPost.status === 403 && readOnlyPost.json?.error?.code === 'read-only');

      const missingName = await postEntry({ action: 'create', scope: 'project', project: projectKey, description: 'd', content: 'c' });
      check('a write without a name is a 400', missingName.status === 400);
      const badProject = await postEntry({ action: 'create', scope: 'project', project: '..%2Fevil', name: 'x', description: 'd', content: 'c' });
      check('a malformed project key on write is a 400', badProject.status === 400);

      const diagnostics = await call('diagnostics', { url: `/memory-manager/api/diagnostics?project=${projectKey}` });
      check('diagnostics still reports the writer backend', diagnostics.status === 200 && ['used', 'fallback'].includes(diagnostics.json.writer), diagnostics.body.slice(0, 120));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ------------------------------------------- K. P1 recall / dream / extract
  section('K. P1 recall, dream candidates, extraction');
  {
    // ---- selector parsing (tolerant) -------------------------------------
    check('selector JSON parses from a code fence', JSON.stringify(parseSelection('```json\n{"selected_memories":["a","b","a"]}\n```')) === JSON.stringify(['a', 'b']));
    check('selector JSON parses from surrounding prose', JSON.stringify(parseSelection('Sure: {"selected_memories":["x"]} — done')) === JSON.stringify(['x']));
    check('a bare array is accepted', JSON.stringify(parseSelection('["x","y"]')) === JSON.stringify(['x', 'y']));
    check('garbage returns no selection', parseSelection('not json at all').length === 0);
    check('non-string entries are ignored', JSON.stringify(parseSelection('{"selected_memories":["a",5,null,"b"]}')) === JSON.stringify(['a', 'b']));
    check('the selection is capped', parseSelection('{"selected_memories":["1","2","3","4","5","6","7","8"]}', 5).length === 5);
    check('parseJsonLoose extracts a balanced object from prose', parseJsonLoose('x {"a":{"b":1}} y')?.a?.b === 1);
    check('parseJsonLoose returns null for invalid text', parseJsonLoose('{oops') === null);

    // ---- LlmInvoker strict → fallback ------------------------------------
    {
      const calls = [];
      const supporting = {
        prepareCall: async () => ({ config: { temperature: 0 } }),
        stream: async function* (options) {
          calls.push(options);
          yield '{"ok":1}';
        },
      };
      const invoker = createLlmInvoker({ llm: supporting, agentDefaultModel: { currentSelection: async () => ({ provider: 'p', model: 'm' }) } });
      const result = await invoker({ system: 's', prompt: 'p', schema: { type: 'object' } });
      check('a supporting host gets one strict-schema call', result.ok === true && result.strict === true && calls.length === 1, JSON.stringify(result));
      check('the strict call carries the schema', calls[0].responseJsonSchema !== undefined);
      check('the invoker passes the prompt as a user message', JSON.stringify(calls[0].messages).includes('"p"'));

      const fallbackCalls = [];
      const unsupporting = {
        prepareCall: async () => ({ config: {} }),
        stream: async function* (options) {
          fallbackCalls.push(options);
          if (options.responseJsonSchema !== undefined) throw new Error('structured output is not supported');
          yield { delta: { text: 'fallback text' } };
        },
      };
      const fallback = await createLlmInvoker({ llm: unsupporting })({ prompt: 'p', schema: { type: 'object' } });
      check('an unsupported strict call falls back to a plain completion', fallback.ok === true && fallback.strict === false && fallback.text === 'fallback text', JSON.stringify(fallback));
      check('the fallback retried without the schema', fallbackCalls.length === 2 && fallbackCalls[1].responseJsonSchema === undefined);
      check('a missing llm reports llm-unavailable', (await createLlmInvoker({})({ prompt: 'p' })).ok === false);
    }

    // ---- recall engine ---------------------------------------------------
    const { dir, roots } = await makeRoots();
    try {
      const store = createMemoryStore({ roots, logger: { warn() {} } });
      const projectCwd = 'D:\\work\\p1-demo';
      const projectKey = projectKeyOf(projectCwd);
      const projectDir = store.projectDir(projectKey);
      await store.writeNote({ scope: 'project', projectKey, name: 'recall-alpha', description: 'alpha recall note', content: `alpha ${'x'.repeat(800)}`, type: 'env' });
      await store.writeNote({ scope: 'project', projectKey, name: 'recall-beta', description: 'beta recall note', content: 'beta body', type: 'user' });
      await store.writeNote({ scope: 'global', name: 'recall-gamma', description: 'gamma global note', content: 'gamma body', type: 'reference' });
      const old = new Date(Date.now() - 3 * 86400000);
      await utimes(join(projectDir, 'recall-beta.md'), old, old);

      const disabledInvoke = async () => {
        throw new Error('recall must not call the model while disabled');
      };
      const disabled = createRecallEngine({ store, invoke: disabledInvoke, config: {}, logger: { warn() {} } });
      check('recall is disabled by default', disabled.enabled === false && resolveRecallConfig({}).enabled === false);
      check('a disabled engine never prefetches', (await disabled.prefetch({ sessionId: 's-off', projectKey, query: 'anything' })) === null);

      const selectorCalls = [];
      const selectorInvoke = async (request) => {
        selectorCalls.push(request);
        // First recall selects several notes; a later recall selects one that is
        // already injected, so it must be filtered and produce no reminder.
        return {
          ok: true,
          text:
            selectorCalls.length === 1
              ? '```json\n{"selected_memories":["recall-alpha","recall-beta","recall-gamma","ghost"]}\n```'
              : '{"selected_memories":["recall-alpha"]}',
        };
      };
      const engine = createRecallEngine({
        store,
        invoke: selectorInvoke,
        config: { recall: { enabled: true, contentBytes: 300, contentLines: 20 } },
        logger: { warn() {} },
      });
      const first = await engine.prefetch({ sessionId: 's-on', projectKey, query: 'what did we say about alpha?' });
      check('an enabled recall returns a reminder', first !== null && first.names.length === 3, JSON.stringify(first?.names));
      check('the reminder names every selected memory', first.text.includes('recall-alpha') && first.text.includes('recall-beta') && first.text.includes('recall-gamma'));
      check('unknown selected names are dropped', !first.text.includes('ghost'));
      check('an old memory carries a verify-first warning', /3-day-old observation/.test(first.text), first.text.split('\n')[0]);
      check('long content is truncated with a pointer', first.text.includes('(truncated — use memory_read for the full note)'));
      check('the selector prompt carries the manifest', selectorCalls[0].prompt.includes('recall-alpha') && selectorCalls[0].prompt.includes('Available memories'));
      const second = await engine.prefetch({ sessionId: 's-on', projectKey, query: 'alpha again' });
      check('a turn with nothing left to recall makes no second model call', second === null && selectorCalls.length === 1);

      resetReadTracker();
      markMemoryRead('recall-gamma');
      const readCalls = [];
      const readEngine = createRecallEngine({
        store,
        invoke: async (request) => {
          readCalls.push(request);
          return { ok: true, text: '{"selected_memories":["recall-gamma"]}' };
        },
        config: { recall: { enabled: true } },
        logger: { warn() {} },
      });
      check('a recently read memory is never recalled', (await readEngine.prefetch({ sessionId: 's-read', projectKey, query: 'gamma?' })) === null && readCalls.length === 1 && !readCalls[0].prompt.includes('recall-gamma'));
      resetReadTracker();

      check('recall limits match the contract defaults', (() => {
        const limits = resolveRecallConfig({});
        return limits.maxEntries === 5 && limits.sessionBudgetChars === 61440 && limits.contentBytes === 4096 && limits.contentLines === 200;
      })());

      // ---- model-free lexical selector ---------------------------------
      check('the selector defaults to auto', resolveRecallConfig({}).selector === 'auto' && DEFAULT_RECALL.selector === 'auto');
      check(
        'the selector accepts the three modes and ignores junk',
        resolveRecallConfig({ recall: { selector: 'lexical' } }).selector === 'lexical' &&
          resolveRecallConfig({ recall: { selector: 'llm' } }).selector === 'llm' &&
          resolveRecallConfig({ recall: { selector: 'nonsense' } }).selector === 'auto',
      );
      const lexicalCandidates = [
        { name: 'alpha-note', description: 'alpha facts', content: 'alpha body', type: 'env', scope: 'project' },
        { name: 'gamma-note', description: 'gamma facts', content: 'gamma body', type: 'env', scope: 'project' },
      ];
      const ranked = lexicalSelection(lexicalCandidates, 'gamma', 5);
      check('the lexical ranking reuses the search score', ranked.length === 1 && ranked[0].name === 'gamma-note', JSON.stringify(ranked.map((entry) => entry.name)));
      check('the lexical ranking returns nothing without a match', lexicalSelection(lexicalCandidates, 'zulu', 5).length === 0);

      const neverCalled = async () => {
        throw new Error('the lexical selector must not call the model');
      };
      const lexicalEngine = createRecallEngine({ store, invoke: neverCalled, config: { recall: { enabled: true, selector: 'lexical' } }, logger: { warn() {} } });
      const lexicalHit = await lexicalEngine.prefetch({ sessionId: 's-lex', projectKey, query: 'beta' });
      check('a lexical recall injects with no model call', lexicalHit !== null && lexicalHit.mode === 'lexical' && lexicalHit.names.includes('recall-beta'), JSON.stringify(lexicalHit));
      check('a lexical recall with no match injects nothing', (await lexicalEngine.prefetch({ sessionId: 's-lex', projectKey, query: 'zzzz-nothing' })) === null);

      const failingInvoke = async () => ({ ok: false, error: 'llm-unavailable' });
      const autoEngine = createRecallEngine({ store, invoke: failingInvoke, config: { recall: { enabled: true } }, logger: { warn() {} } });
      const autoHit = await autoEngine.prefetch({ sessionId: 's-auto', projectKey, query: 'beta' });
      check('auto falls back to the lexical selector when the model is unavailable', autoHit !== null && autoHit.mode === 'lexical', JSON.stringify(autoHit?.mode));
      const strictEngine = createRecallEngine({ store, invoke: failingInvoke, config: { recall: { enabled: true, selector: 'llm' } }, logger: { warn() {} } });
      check('selector=llm keeps the model-or-nothing behaviour', (await strictEngine.prefetch({ sessionId: 's-strict', projectKey, query: 'beta' })) === null);

      // A model that *answers* with an empty selection is abstaining, not failing: the
      // lexical selector must not second-guess it (`beta` has a lexical hit here).
      let abstainCalls = 0;
      const abstainEvents = [];
      const abstaining = createRecallEngine({
        store,
        invoke: async () => {
          abstainCalls += 1;
          return { ok: true, text: '{"selected_memories":[]}' };
        },
        config: { recall: { enabled: true } },
        logger: { warn() {} },
        onEvent: (event) => abstainEvents.push(event),
      });
      const abstained = await abstaining.prefetch({ sessionId: 's-abstain', projectKey, query: 'beta' });
      check('a model abstention is respected, not replaced by lexical hits', abstained === null && abstainCalls === 1, `${abstained?.mode}/${abstainCalls}`);
      check('the abstention is audited with its own reason', abstainEvents.length === 1 && abstainEvents[0].reason === 'abstained' && abstainEvents[0].mode === 'llm', JSON.stringify(abstainEvents));
      const unsureAbout = await createRecallEngine({
        store,
        invoke: async () => ({ ok: true, text: '{"selected_memories":["ghost"]}' }),
        config: { recall: { enabled: true } },
        logger: { warn() {} },
      }).prefetch({ sessionId: 's-ghost', projectKey, query: 'beta' });
      check('an answer naming only unknown/dropped notes also abstains', unsureAbout === null);

      // ---- dream consolidation → candidate bundle ----------------------
      const memoryBefore = await readFile(join(projectDir, 'recall-alpha.md'), 'utf8');
      let dreamSeq = 0;
      const dreamInvoke = async () => ({
        ok: true,
        text: [
          'Here is the consolidation:',
          '```json',
          JSON.stringify({
            candidates: [
              { action: 'create', name: `merged-note-${(dreamSeq += 1)}`, description: 'merged description', content: 'merged body', type: 'project', reason: 'merge two notes' },
              { action: 'update', name: 'recall-alpha', description: 'alpha updated by dream', reason: 'tighten' },
              { action: 'delete', name: 'recall-beta', reason: 'superseded' },
            ],
          }),
          '```',
        ].join('\n'),
      });
      const fixedNow = new Date('2026-10-18T05:00:00.000Z');
      const dream = await runConsolidation({ store, scope: 'project', projectKey, invoke: dreamInvoke, now: fixedNow, logger: { warn() {} } });
      check('a dream pass returns an id and candidate count', typeof dream.id === 'string' && dream.count === 3, JSON.stringify(dream));
      check('the dream bundle records the index health', dream.index.lines >= 2 && dream.index.bytes > 0 && Array.isArray(dream.index.warnings));
      const candidatesDir = join(projectDir, 'candidates');
      check('the candidate bundle is written outside the memory files', existsSync(join(candidatesDir, dream.id)));
      const bundle = await readCandidateBundle(store, { scope: 'project', projectKey, id: dream.id });
      check('the bundle records its source', bundle?.source === 'dream' && bundle.candidates.length === 3);
      check('dream never writes memory files', (await readFile(join(projectDir, 'recall-alpha.md'), 'utf8')) === memoryBefore && !existsSync(join(projectDir, 'merged-note-1.md')));

      const health = indexHealth({ indexRows: ['x'.repeat(151)], indexSize: 26000 });
      check('index health flags an oversized byte count', health.warnings.some((warning) => warning.includes('26000 bytes')));
      check('index health flags an over-long row', health.warnings.some((warning) => warning.includes('151 characters')));
      check('index health passes a healthy index', indexHealth({ indexRows: ['- [a](a.md) — d'], indexSize: 20 }).warnings.length === 0);

      const bundles = await listCandidateBundles(store, { scope: 'project', projectKey });
      check('candidate bundles are listable', bundles.length >= 1 && bundles[0].count === 3 && bundles[0].source === 'dream');

      const adoptedCreate = await adoptCandidate(store, { scope: 'project', projectKey, id: dream.id, index: 0 });
      check('adopting a create candidate writes the memory', adoptedCreate.action === 'create' && existsSync(join(projectDir, `${adoptedCreate.name}.md`)) && adoptedCreate.remaining === 2, JSON.stringify(adoptedCreate));
      const adoptedUpdate = await adoptCandidate(store, { scope: 'project', projectKey, id: dream.id, index: 0 });
      check('adopting an update candidate rewrites the memory', adoptedUpdate.action === 'update' && (await readFile(join(projectDir, 'recall-alpha.md'), 'utf8')).includes('alpha updated by dream') && adoptedUpdate.remaining === 1);
      const adoptedDelete = await adoptCandidate(store, { scope: 'project', projectKey, id: dream.id, index: 0 });
      check('adopting a delete candidate removes the memory', adoptedDelete.action === 'delete' && !existsSync(join(projectDir, 'recall-beta.md')) && adoptedDelete.remaining === 0);
      check('an emptied bundle file is removed', !existsSync(join(candidatesDir, dream.id)));
      let adoptMissing = '';
      try {
        await adoptCandidate(store, { scope: 'project', projectKey, id: dream.id, index: 0 });
      } catch (error) {
        adoptMissing = error.code;
      }
      check('adopting from a missing bundle is not-found', adoptMissing === 'not-found');

      const dream2 = await runConsolidation({ store, scope: 'project', projectKey, invoke: dreamInvoke, now: fixedNow, logger: { warn() {} } });
      const discarded = await discardCandidate(store, { scope: 'project', projectKey, id: dream2.id, index: 0 });
      check('discarding removes only the proposal', discarded.remaining === 2 && existsSync(join(candidatesDir, dream2.id)));
      let discardOutOfRange = '';
      try {
        await discardCandidate(store, { scope: 'project', projectKey, id: dream2.id, index: 99 });
      } catch (error) {
        discardOutOfRange = error.code;
      }
      check('an out-of-range candidate index is not-found', discardOutOfRange === 'not-found');

      // ---- extraction --------------------------------------------------
      const extractInvoke = async () => ({ ok: true, text: '{"candidates":[{"action":"create","name":"extract-note","description":"extracted fact","content":"absolute date fact","type":"project","reason":"durable"}]}' });
      const extracted = await runExtraction({ store, scope: 'project', projectKey, transcript: 'user: remember this\nassistant: ok', invoke: extractInvoke, now: fixedNow, logger: { warn() {} } });
      check('extraction writes a candidate bundle', typeof extracted?.id === 'string' && extracted.count === 1);
      const extractBundle = await readCandidateBundle(store, { scope: 'project', projectKey, id: extracted.id });
      check('the extract bundle records its source and never writes memory', extractBundle?.source === 'extract' && !existsSync(join(projectDir, 'extract-note.md')));
      check('an empty transcript does not call the model', (await runExtraction({ store, scope: 'project', projectKey, transcript: '   ', invoke: async () => { throw new Error('no call expected'); }, logger: { warn() {} } })) === null);
      check('a failed extraction is silent', (await runExtraction({ store, scope: 'project', projectKey, transcript: 'x', invoke: async () => ({ ok: false, error: 'boom' }), logger: { warn() {} } })) === null);

      // ---- candidate routes -------------------------------------------
      const candidateRoutes = [];
      registerRoutes(
        {
          connection: { requestRejection: () => undefined },
          webServer: { register: (entry) => { candidateRoutes.push(entry); return () => {}; } },
        },
        store,
        { openDirectory: async () => {}, invoke: dreamInvoke, now: () => fixedNow, logger: { warn() {} } },
      );
      const candidateRoute = (suffix) => candidateRoutes.find((entry) => entry.path === `/memory-manager/api/${suffix}`);
      const callCandidates = async (suffix, { method = 'GET', url, body } = {}) => {
        const response = mockResponse();
        await candidateRoute(suffix).handler(
          mockRequest({ method, url: url ?? `/memory-manager/api/${suffix}`, headers: method === 'POST' ? { 'content-type': 'application/json' } : {}, body: body === undefined ? undefined : JSON.stringify(body) }),
          response,
        );
        let json = null;
        try {
          json = JSON.parse(response.body);
        } catch {
          json = null;
        }
        return { status: response.statusCode, body: response.body, json };
      };
      const listResponse = await callCandidates('candidates', { url: `/memory-manager/api/candidates?scope=project&project=${projectKey}` });
      check('GET /candidates answers 200', listResponse.status === 200 && Array.isArray(listResponse.json.candidates));
      const consolidateResponse = await callCandidates('consolidate', { method: 'POST', body: { scope: 'project', project: projectKey } });
      check('POST /consolidate returns a candidate summary', consolidateResponse.status === 200 && typeof consolidateResponse.json.id === 'string' && consolidateResponse.json.count === 3, consolidateResponse.body);
      const adoptResponse = await callCandidates('candidates/adopt', { method: 'POST', body: { scope: 'project', project: projectKey, id: consolidateResponse.json.id, index: 0 } });
      check('POST /candidates/adopt applies one candidate', adoptResponse.status === 200 && adoptResponse.json.ok === true && adoptResponse.json.action === 'create');
      const discardResponse = await callCandidates('candidates/discard', { method: 'POST', body: { scope: 'project', project: projectKey, id: consolidateResponse.json.id, index: 0 } });
      check('POST /candidates/discard removes one candidate', discardResponse.status === 200 && discardResponse.json.ok === true);
      const badCandidate = await callCandidates('candidates/adopt', { method: 'POST', body: { scope: 'project', project: projectKey, id: 'candidates-nope.json', index: 0 } });
      check('a missing candidate bundle is a 404', badCandidate.status === 404 && badCandidate.json.error.code === 'not-found');
      const noInvokeRoutes = [];
      registerRoutes(
        { connection: { requestRejection: () => undefined }, webServer: { register: (entry) => { noInvokeRoutes.push(entry); return () => {}; } } },
        store,
        { openDirectory: async () => {} },
      );
      const noInvokeConsolidate = await (async () => {
        const entry = noInvokeRoutes.find((route) => route.path === '/memory-manager/api/consolidate');
        const response = mockResponse();
        await entry.handler(mockRequest({ method: 'POST', url: '/memory-manager/api/consolidate', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'project', project: projectKey }) }), response);
        return { status: response.statusCode, json: JSON.parse(response.body) };
      })();
      check('consolidation without a model is a 503 llm-unavailable', noInvokeConsolidate.status === 503 && noInvokeConsolidate.json.error.code === 'llm-unavailable');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    // ---- apply-level: default off, then opt-in ------------------------
    const makeApplyHarness = (rootsArg, config, hostOptions = {}) => {
      const tools = [];
      const routes = [];
      const sections = [];
      const effects = [];
      const events = new Map();
      const llmCalls = [];
      const injections = [];
      const llm = {
        prepareCall: async () => ({ config: {} }),
        stream: async function* (options) {
          llmCalls.push(options);
          const prompt = options.messages?.[0]?.content?.[0]?.text ?? '';
          if (prompt.includes('Recent conversation:')) {
            yield { type: 'text', text: '{"candidates":[{"action":"create","name":"auto-extract","description":"extracted","content":"body","type":"project"}]}' };
          } else {
            yield { type: 'text', text: '{"selected_memories":["recall-alpha","recall-beta"]}' };
          }
        },
      };
      const ctx = {
        tools: { register: (definition) => { tools.push(definition); return () => {}; } },
        systemPrompt: { section: (definition) => { sections.push(definition); return () => {}; } },
        webServer: { register: (route) => { routes.push(route); return () => {}; } },
        connection: { requestRejection: () => undefined },
        workingDirectory: { get: (session) => session?.cwd },
        llm,
        agentDefaultModel: { currentSelection: async () => ({ provider: 'fake', model: 'fake' }) },
        agents: { get: (id) => (id === 'sess-1' ? { session: hostOptions.session } : undefined) },
        effect: (fn) => { const dispose = fn(); effects.push(dispose); return dispose; },
        on: (event, handler) => { const handlers = events.get(event) ?? []; handlers.push(handler); events.set(event, handlers); return () => {}; },
        logger: { warn: () => {} },
        get: (name) => (name === 'agents' ? ctx.agents : undefined),
      };
      const emit = (session, event) => {
        for (const handler of events.get('session/event') ?? []) handler(session, event);
      };
      // `withoutLlm` reproduces a host that has no model service at all: recall must
      // still work through the lexical selector.
      if (hostOptions.withoutLlm === true) delete ctx.llm;
      apply(ctx, { memoryRoots: { global: rootsArg.globalDir, projects: rootsArg.projectsDir }, ...config }, {
        now: hostOptions.now,
        injectReminder: async (_agent, text) => {
          injections.push(text);
          return true;
        },
      });
      return { ctx, tools, routes, sections, effects, events, emit, llmCalls, injections };
    };

    const offRoots = await makeRoots();
    try {
      const session = { id: 'sess-1', cwd: 'D:\\work\\p1-off' };
      const harness = makeApplyHarness(offRoots.roots, {}, { session });
      harness.emit(session, { type: 'user/message', data: { content: [{ type: 'text', text: 'what about alpha?' }] } });
      harness.emit(session, { type: 'turn/start', data: { turn: 1 } });
      harness.emit(session, { type: 'turn/end', data: { turn: 1, reason: 'completed' } });
      await sleep(60);
      check('default config makes no model calls (recall + extract off)', harness.llmCalls.length === 0 && harness.injections.length === 0, String(harness.llmCalls.length));
    } finally {
      await rm(offRoots.dir, { recursive: true, force: true });
    }

    const onRoots = await makeRoots();
    try {
      const projectCwd = 'D:\\work\\p1-on';
      const projectKey = projectKeyOf(projectCwd);
      const pre = createMemoryStore({ roots: onRoots.roots, logger: { warn() {} } });
      await pre.writeNote({ scope: 'project', projectKey, name: 'recall-alpha', description: 'alpha', content: `alpha ${'y'.repeat(600)}`, type: 'env' });
      await pre.writeNote({ scope: 'project', projectKey, name: 'recall-beta', description: 'beta', content: 'beta', type: 'user' });
      const session = { id: 'sess-1', cwd: projectCwd };
      const harness = makeApplyHarness(onRoots.roots, { recall: { enabled: true, contentBytes: 256 } }, { session });
      harness.emit(session, { type: 'user/message', data: { content: [{ type: 'text', text: 'what about alpha?' }] } });
      harness.emit(session, { type: 'turn/start', data: { turn: 1 } });
      await sleep(120);
      check('enabled recall injects one reminder', harness.injections.length === 1 && harness.llmCalls.length === 1, `${harness.injections.length}/${harness.llmCalls.length}`);
      check('the injected reminder is the rendered recall text', harness.injections[0].includes('recall-alpha') && harness.injections[0].includes('Relevant memories were retrieved'));
      const recallEvents = await readAuditEvents(onRoots.roots);
      check(
        'the recall run is audited with its mode and size',
        recallEvents.some((event) => event.type === 'recall' && event.ok === true && event.mode === 'llm' && event.count >= 1 && typeof event.bytes === 'number'),
        JSON.stringify(recallEvents),
      );
      harness.emit(session, { type: 'turn/start', data: { turn: 2 } });
      await sleep(80);
      check('a second turn does not re-inject the same memories', harness.injections.length === 1);
      for (const dispose of harness.effects) dispose?.();
    } finally {
      await rm(onRoots.dir, { recursive: true, force: true });
    }

    // A host with no model service at all: `selector: 'auto'` must still recall.
    const lexicalRoots = await makeRoots();
    try {
      const projectCwd = 'D:\\work\\p1-lexical';
      const projectKey = projectKeyOf(projectCwd);
      const pre = createMemoryStore({ roots: lexicalRoots.roots, logger: { warn() {} } });
      await pre.writeNote({ scope: 'project', projectKey, name: 'lexical-hit', description: 'db schema notes', content: 'schema v3', type: 'project' });
      const session = { id: 'sess-1', cwd: projectCwd };
      const harness = makeApplyHarness(lexicalRoots.roots, { recall: { enabled: true } }, { session, withoutLlm: true });
      harness.emit(session, { type: 'user/message', data: { content: [{ type: 'text', text: 'what is the schema version?' }] } });
      harness.emit(session, { type: 'turn/start', data: { turn: 1 } });
      await sleep(150);
      check('recall works with no model service at all', harness.injections.length === 1 && harness.injections[0].includes('lexical-hit'), String(harness.injections.length));
      const lexicalEvents = await readAuditEvents(lexicalRoots.roots);
      check(
        'the model-free recall is audited as lexical',
        harness.llmCalls.length === 0 && lexicalEvents.some((event) => event.type === 'recall' && event.mode === 'lexical' && event.ok === true),
        JSON.stringify(lexicalEvents),
      );
      for (const dispose of harness.effects) dispose?.();
    } finally {
      await rm(lexicalRoots.dir, { recursive: true, force: true });
    }

    const extractRoots = await makeRoots();
    try {
      const projectCwd = 'D:\\work\\p1-extract';
      const projectKey = projectKeyOf(projectCwd);
      const session = { id: 'sess-1', cwd: projectCwd };
      const fixedTime = new Date('2026-10-18T06:00:00.000Z');
      const harness = makeApplyHarness(extractRoots.roots, { extract: { enabled: true } }, { session, now: () => fixedTime });
      harness.emit(session, { type: 'user/message', data: { content: [{ type: 'text', text: 'remember that the deadline is 2026-11-01' }] } });
      harness.emit(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'noted' }] } } });
      harness.emit(session, { type: 'turn/end', data: { turn: 1, reason: 'completed' } });
      await sleep(120);
      const extractCandidatesDir = join(createMemoryStore({ roots: extractRoots.roots }).projectDir(projectKey), 'candidates');
      const firstBundles = existsSync(extractCandidatesDir) ? (await readdir(extractCandidatesDir)).filter((name) => name.endsWith('.json')) : [];
      check('enabled extraction writes one candidate bundle after a turn', firstBundles.length === 1, String(firstBundles.length));
      const extractEvents = await readAuditEvents(extractRoots.roots);
      check(
        'the extraction run is audited with its candidate count',
        extractEvents.some((event) => event.type === 'extract' && event.ok === true && event.count === 1 && typeof event.ms === 'number'),
        JSON.stringify(extractEvents),
      );
      const callsAfterFirst = harness.llmCalls.length;
      harness.emit(session, { type: 'turn/end', data: { turn: 2, reason: 'completed' } });
      await sleep(120);
      const secondBundles = (await readdir(extractCandidatesDir)).filter((name) => name.endsWith('.json'));
      check('extraction is rate-limited per session', secondBundles.length === 1 && harness.llmCalls.length === callsAfterFirst, `${secondBundles.length}/${harness.llmCalls.length}`);
      const throttledEvents = await readAuditEvents(extractRoots.roots);
      check(
        'a throttled extraction turn is audited, not silent',
        throttledEvents.some((event) => event.type === 'extract' && event.reason === 'throttled'),
        JSON.stringify(throttledEvents),
      );
      for (const dispose of harness.effects) dispose?.();
    } finally {
      await rm(extractRoots.dir, { recursive: true, force: true });
    }
  }

  // ------------------------------- L. write-time dedupe: similar hints + aliases
  section('L. write-time dedupe (similar hints, aliases)');
  {
    const { dir, roots } = await makeRoots();
    try {
      const store = createMemoryStore({ roots, logger: { warn() {} } });
      const projectKey = projectKeyOf('D:\\work\\dedupe-demo');
      const projectDir = store.projectDir(projectKey);
      await store.writeNote({ scope: 'project', projectKey, name: 'hardware-overview', description: '台式机硬件配置一览', content: 'CPU i5-12400F；GPU RTX 4060 8GB。', type: 'env' });

      const similar = await store.similarNotes({ scope: 'project', projectKey, name: 'hardware', description: '台式机硬件配置', content: 'CPU i5-12400F' });
      check('similarNotes finds a near-duplicate', similar.length === 1 && similar[0].name === 'hardware-overview' && similar[0].score >= 0.3, JSON.stringify(similar));
      const unrelated = await store.similarNotes({ scope: 'project', projectKey, name: 'release-notes', description: '版本发布说明', content: 'v0.3 增加了导出功能' });
      check('similarNotes stays quiet for an unrelated note', unrelated.length === 0, JSON.stringify(unrelated));
      const selfHits = await store.similarNotes({ scope: 'project', projectKey, name: 'hardware-overview', description: '台式机硬件配置一览', content: 'CPU i5' });
      check('similarNotes never reports the note itself', selfHits.every((hit) => hit.name !== 'hardware-overview'));

      const aliased = await store.writeNote({
        scope: 'project',
        projectKey,
        name: 'hw',
        description: '硬件速查',
        content: 'CPU i5。',
        type: 'env',
        aliases: ['硬件', 'hardware-quickref', 'hw'],
      });
      check('aliases are stored in metadata.aliases', (await readFile(aliased.path, 'utf8')).includes('  aliases: ["硬件","hardware-quickref"]'));
      check('an alias equal to the note name is dropped', JSON.stringify(aliased.aliases) === JSON.stringify(['硬件', 'hardware-quickref']), JSON.stringify(aliased.aliases));
      check('readNote resolves an alias', (await store.readNote({ scope: 'project', projectKey, name: '硬件' }))?.note.name === 'hw');
      const aliasSearch = await store.search({ query: 'hardware-quickref', scope: 'project', projectKey });
      check('search scores an alias like a name', aliasSearch.hits[0]?.name === 'hw' && aliasSearch.hits[0].score >= 7, JSON.stringify(aliasSearch.hits[0]));

      const merged = await store.writeNote({ scope: 'project', projectKey, name: '硬件', description: '硬件速查（合并）', content: 'CPU i5；GPU RTX 4060。', type: 'env' });
      check(
        'writing an alias resolves to the canonical note',
        merged.name === 'hw' && merged.created === false && merged.path === aliased.path && merged.viaAlias === '硬件',
        JSON.stringify(merged),
      );
      // Metadata-only merge: the owner's own body is not this caller's to overwrite.
      const mergedText = await readFile(aliased.path, 'utf8');
      check('an alias write never overwrites the owner body', mergedText.includes('CPU i5。') && !mergedText.includes('GPU RTX 4060'), mergedText);
      check('an alias write reports that nothing was stored', merged.redacted === 0);
      check(
        'the alias write leaves one file per note',
        (await readdir(projectDir)).filter((name) => name.toLowerCase().endsWith('.md') && name !== INDEX_NAME).sort().join(',') === 'hardware-overview.md,hw.md',
      );
      check('the index keeps one row per note', (await readFile(join(projectDir, INDEX_NAME), 'utf8')).trim().split('\n').length === 2);
      check('the merged note keeps its alias', mergedText.includes('"硬件"'));

      // A plain rewrite under the canonical name must keep the aliases already on disk.
      const rewritten = await store.writeNote({ scope: 'project', projectKey, name: 'hw', description: '硬件速查（重写）', content: 'CPU i7。', type: 'env' });
      check('rewriting the canonical name keeps the aliases', JSON.stringify(rewritten.aliases) === JSON.stringify(['硬件', 'hardware-quickref']), JSON.stringify(rewritten.aliases));
      check('rewriting the canonical name still replaces the body', (await readFile(aliased.path, 'utf8')).includes('CPU i7。'));
      const partial = await store.updateNote({ scope: 'project', projectKey, name: 'hw', description: '硬件速查（局部）', aliases: [] });
      check('updateNote with an empty alias list keeps the existing aliases', JSON.stringify(partial.aliases) === JSON.stringify(['硬件', 'hardware-quickref']), JSON.stringify(partial.aliases));

      // An alias may contain characters `safeName` rewrites; matching must use the raw
      // request too, or the write creates `a-b.md` next to the note it meant to merge.
      await store.updateNote({ scope: 'project', projectKey, name: 'hw', aliases: ['硬件', 'hardware-quickref', 'a/b'] });
      const slashMerge = await store.writeNote({ scope: 'project', projectKey, name: 'a/b', description: 'x', content: 'y', type: 'env' });
      check('an alias with characters safeName rewrites still merges', slashMerge.name === 'hw' && slashMerge.viaAlias === 'a/b', JSON.stringify(slashMerge));
      check('no sanitized duplicate file was created', !existsSync(join(projectDir, 'a-b.md')));

      let aliasConflict = '';
      try {
        await store.writeNote({ scope: 'project', projectKey, name: '硬件', description: 'x', content: 'y', expect: 'absent' });
      } catch (error) {
        aliasConflict = error.code;
      }
      check('an expect=absent write under an alias is a conflict', aliasConflict === 'conflict');

      const deleted = await store.deleteNote({ scope: 'project', projectKey, name: 'hardware-quickref' });
      check('deleteNote resolves an alias', deleted.deleted === true && !existsSync(aliased.path));
      check('deleteNote reports the note it actually removed', deleted.name === 'hw' && deleted.viaAlias === 'hardware-quickref', JSON.stringify(deleted));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ---------------------------------------- M. secret redaction (write entry)
  section('M. secret redaction at the write entry');
  {
    check('the rule table is non-empty and every rule is global', REDACTION_RULES.length >= 8 && REDACTION_RULES.every((rule) => rule.pattern.global));
    check('a private key block is masked', redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----').text === '[REDACTED:private-key]');
    check('a bearer header is masked', redactSecrets('Authorization: Bearer abcdefghijklmnop1234').text === 'Authorization: [REDACTED:bearer]');
    check('URL basic auth keeps the scheme and host', redactSecrets('https://user:p4ssw0rd@example.com/x').text === 'https://[REDACTED:basic-auth]@example.com/x');
    check('a JWT is masked', redactSecrets('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U').text === '[REDACTED:jwt]');
    check('key prefixes are masked', ['sk-abcdefghijklmnopqrstuvwx', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'AKIAIOSFODNN7EXAMPLE', 'xoxb-123456789012-abcdefghij'].every((secret) => redactSecrets(`x ${secret} y`).text === 'x [REDACTED:api-key] y'));
    check('a name: value credential is masked, the name stays', redactSecrets('api_key = "abcdefgh12345"').text === 'api_key = "[REDACTED:credential]"');
    check('a harmless mention of the word token is untouched', redactSecrets('the token budget is fine').count === 0);
    check('CJK prose is untouched', redactSecrets('记忆管理器：写入前先查重').count === 0);
    check('redaction is idempotent', redactSecrets(redactSecrets('password: hunter2hunter2').text).count === 0);
    check('redactNote reports one count per replacement', redactNote({ description: 'token: abcdefgh1234', content: 'Bearer abcdefghijklmnop1234' }).count === 2);
    check('redactNote tolerates empty input', JSON.stringify(redactNote({})) === JSON.stringify({ description: '', content: '', aliases: [], count: 0, kinds: [] }));

    // False positives are expensive (masking is irreversible), so the credential rule
    // needs a digit in the value: names/words masquerading as assignments stay readable.
    check('a variable name used as a value is not masked', redactSecrets('token: GITHUB_TOKEN').count === 0);
    check('ordinary prose after a key name is not masked', redactSecrets('secret: handshake protocol').count === 0 && redactSecrets('password: changeme').count === 0);
    check('a digit-bearing value is still masked', redactSecrets('password: hunter2hunter2').count === 1);
    check('a masked value cannot be masked twice', redactSecrets('token: [REDACTED:credential]').count === 0);

    const { dir, roots } = await makeRoots();
    try {
      const store = createMemoryStore({ roots, logger: { warn() {} } });
      const projectKey = projectKeyOf('D:\\work\\redact-demo');
      const projectDir = store.projectDir(projectKey);
      const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
      const written = await store.writeNote({
        scope: 'project',
        projectKey,
        name: 'credentials-note',
        description: 'token: abcdefgh1234',
        content: `deploy with:\nAuthorization: Bearer abcdefghijklmnop1234\ngit token ${secret}`,
        type: 'env',
      });
      const stored = await readFile(written.path, 'utf8');
      check('the stored body is redacted', !stored.includes('abcdefghijklmnop1234') && !stored.includes(secret) && stored.includes('[REDACTED:bearer]'));
      check('the stored description is redacted too', !stored.includes('abcdefgh1234') && stored.includes('[REDACTED:credential]'));
      check('the index row carries the redacted description', !(await readFile(join(projectDir, INDEX_NAME), 'utf8')).includes('abcdefgh1234'));
      check('the write reports how many secrets were masked', written.redacted === 3, String(written.redacted));
      const updated = await store.updateNote({ scope: 'project', projectKey, name: 'credentials-note', description: 'note without secrets' });
      check('re-saving an already masked note masks nothing new', updated.redacted === 0 && (await readFile(written.path, 'utf8')).includes('[REDACTED:bearer]'));
      check('the replaced description no longer carries the old marker', !(await readFile(written.path, 'utf8')).includes('[REDACTED:credential]'));
      const readBack = await store.readNote({ scope: 'project', projectKey, name: 'credentials-note' });
      check('a masked note stays readable', readBack !== null && readBack.note.content.includes('[REDACTED:bearer]'));
      const innocent = await store.writeNote({ scope: 'project', projectKey, name: 'plain-note', description: 'token budget note', content: 'the token budget is 1200', type: 'project' });
      check('an innocent note is stored verbatim', innocent.redacted === 0 && (await readFile(innocent.path, 'utf8')).includes('the token budget is 1200'));

      // A description-only edit must not rewrite (and therefore re-redact) a body the
      // caller did not send — e.g. a note an external editor wrote.
      const externalPath = join(projectDir, 'external-note.md');
      await writeFile(externalPath, formatNote({ name: 'external-note', description: 'external edit', type: 'env', content: 'keep me token: keepthis123' }), 'utf8');
      const descOnly = await store.updateNote({ scope: 'project', projectKey, name: 'external-note', description: 'external edit 2' });
      check('a description-only update leaves the untouched body verbatim', (await readFile(externalPath, 'utf8')).includes('keep me token: keepthis123'), descOnly.redacted);
      check('a description-only update reports no masking', descOnly.redacted === 0);

      // Explicit opt-out for hosts that want byte-for-byte storage.
      const unredacted = createMemoryStore({ roots, config: { redaction: false }, logger: { warn() {} } });
      const rawWrite = await unredacted.writeNote({ scope: 'project', projectKey, name: 'raw-secret', description: 'raw', content: 'token: abcdefgh1234', type: 'env' });
      check('redaction can be switched off with config redaction:false', rawWrite.redacted === 0 && (await readFile(rawWrite.path, 'utf8')).includes('token: abcdefgh1234'));
      const halfOff = createMemoryStore({ roots, config: { redaction: { enabled: false } }, logger: { warn() {} } });
      check('redaction:{enabled:false} is the same switch', (await halfOff.writeNote({ scope: 'project', projectKey, name: 'raw-secret-2', description: 'raw', content: 'token: abcdefgh5678', type: 'env' })).redacted === 0);

      // Candidate bundles are files too: a proposal quoting a credential is masked at
      // bundle-write time and the count is reported when it is adopted.
      const proposal = await writeCandidateBundle(store, {
        scope: 'project',
        projectKey,
        source: 'extract',
        candidates: [{ action: 'create', name: 'leaky-candidate', description: 'token: abcdefgh1234', content: 'use token: abcdefgh9999', type: 'env' }],
        now: new Date('2026-10-18T07:00:00.000Z'),
      });
      const proposalText = await readFile(proposal.path, 'utf8');
      check('candidate bundles are stored masked', !proposalText.includes('abcdefgh1234') && !proposalText.includes('abcdefgh9999'), proposalText.slice(0, 160));
      const adopted = await adoptCandidate(store, { scope: 'project', projectKey, id: proposal.id, index: 0 });
      check('adoption reports how many secrets the proposal carried', adopted.redacted === 2, String(adopted.redacted));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // --------------------------------------------- N. bounded runtime audit log
  section('N. bounded runtime audit (events.jsonl + /events)');
  {
    const dir = await mkdtemp(join(tmpdir(), 'memory-manager-events-'));
    try {
      const file = join(dir, 'events.jsonl');
      const fixed = new Date('2026-10-18T06:00:00.000Z');
      const log = createEventLog({ file, now: () => fixed });
      check('an empty log reads as no events', (await log.read()).length === 0);
      await log.append({ type: 'recall', ok: true, mode: 'lexical', names: ['alpha', 'beta'], count: 2, bytes: 100, ms: 5, text: 'NOTE BODY MUST NOT LEAK' });
      const [firstEvent] = await log.read();
      check(
        'an event keeps its counters and timestamp',
        firstEvent.type === 'recall' && firstEvent.ok === true && firstEvent.mode === 'lexical' && firstEvent.count === 2 && firstEvent.bytes === 100 && firstEvent.ms === 5 && firstEvent.at === fixed.toISOString(),
        JSON.stringify(firstEvent),
      );
      check('note bodies never reach the audit log', !(await readFile(file, 'utf8')).includes('NOTE BODY MUST NOT LEAK') && JSON.stringify(firstEvent).includes('"names"'));
      check('normalizeEvent drops unknown fields', !('text' in normalizeEvent({ type: 'x', text: 'body' })) && normalizeEvent({ type: 'x', text: 'body' }).type === 'x');
      await log.append({ type: 'extract', ok: false, reason: 'model-unavailable', error: 'boom' });
      const latest = await log.read({ limit: 10 });
      check('events read newest first', latest[0].type === 'extract' && latest[1].type === 'recall', JSON.stringify(latest.map((event) => event.type)));
      check('read honours its limit', (await log.read({ limit: 1 })).length === 1);
      check('an unwritable log never throws', (await createEventLog({ file: join(dir, '\u0000bad', 'x.jsonl') }).append({ type: 'x' })) === null);

      // Bounding: rewrite to the newest `keep` lines once over budget (so the steady
      // state is at most keep+1 lines: the trimmed batch plus the line being appended).
      const boundedFile = join(dir, 'bounded.jsonl');
      const bounded = createEventLog({ file: boundedFile, maxBytes: 400, keep: 5 });
      for (let index = 0; index < 40; index += 1) await bounded.append({ type: 'recall', ok: true, count: index });
      const boundedLines = (await readFile(boundedFile, 'utf8')).split('\n').filter((line) => line.trim() !== '');
      check('the log is bounded once it is over budget', boundedLines.length <= 5 + 1, String(boundedLines.length));
      check('bounding keeps the newest events', JSON.parse(boundedLines[boundedLines.length - 1]).count === 39, boundedLines[boundedLines.length - 1]);
      check('the defaults are bounded too', DEFAULT_EVENTS.keep > 0 && DEFAULT_EVENTS.maxBytes > 0 && DEFAULT_EVENTS.maxRead > 0);

      // A dream pass is audited even when it dies before/at the model call, and the
      // failure still reaches the HTTP layer.
      const dreamFailRoots = await makeRoots();
      try {
        const dreamStore = createMemoryStore({ roots: dreamFailRoots.roots, logger: { warn() {} } });
        const dreamKey = projectKeyOf('D:\\work\\dream-fail');
        const brokenStore = { ...dreamStore, readScope: async () => { throw new Error('disk on fire'); } };
        const brokenEvents = [];
        let brokenThrew = false;
        try {
          await runConsolidation({
            store: brokenStore,
            scope: 'project',
            projectKey: dreamKey,
            invoke: async () => ({ ok: true, text: '{"candidates":[]}' }),
            onEvent: (event) => brokenEvents.push(event),
            logger: { warn() {} },
          });
        } catch {
          brokenThrew = true;
        }
        check(
          'a dream pass that fails before the model call is audited and rethrown',
          brokenThrew && brokenEvents.some((event) => event.type === 'dream' && event.ok === false && event.reason === 'error'),
          JSON.stringify(brokenEvents),
        );

        const unavailableEvents = [];
        let unavailableThrew = false;
        try {
          await runConsolidation({
            store: dreamStore,
            scope: 'project',
            projectKey: dreamKey,
            invoke: async () => ({ ok: false, error: 'nope' }),
            onEvent: (event) => unavailableEvents.push(event),
            logger: { warn() {} },
          });
        } catch {
          unavailableThrew = true;
        }
        check(
          'a model-unavailable dream is audited exactly once',
          unavailableThrew && unavailableEvents.length === 1 && unavailableEvents[0].reason === 'model-unavailable',
          JSON.stringify(unavailableEvents),
        );
      } finally {
        await rm(dreamFailRoots.dir, { recursive: true, force: true });
      }

      // Routes: the audit tail rides on /diagnostics and has its own GET /events.
      const { dir: rootDir, roots } = await makeRoots();
      try {
        const store = createMemoryStore({ roots, logger: { warn() {} } });
        check('the audit file is a dotfile beside the global root', EVENTS_FILE === '.events.jsonl');
        const routes = [];
        registerRoutes(
          { connection: { requestRejection: () => undefined }, webServer: { register: (route) => { routes.push(route); return () => {}; } } },
          store,
          { openDirectory: async () => {}, events: log },
        );
        const route = (suffix) => routes.find((entry) => entry.path === `/memory-manager/api/${suffix}`);
        const call = async (suffix, url) => {
          const response = mockResponse();
          await route(suffix).handler(mockRequest({ url: url ?? `/memory-manager/api/${suffix}` }), response);
          return { status: response.statusCode, headers: response.headers, json: JSON.parse(response.body) };
        };
        const eventsResponse = await call('events');
        check('GET /events answers 200 with the audit tail', eventsResponse.status === 200 && eventsResponse.json.enabled === true && eventsResponse.json.events.length === 2, JSON.stringify(eventsResponse.json).slice(0, 160));
        check('GET /events is no-store', eventsResponse.headers['cache-control'] === 'no-store');
        const limited = await call('events', '/memory-manager/api/events?limit=1');
        check('GET /events honours limit', limited.json.events.length === 1);
        const diagnosticsResponse = await call('diagnostics');
        check('GET /diagnostics carries the audit tail', Array.isArray(diagnosticsResponse.json.runtime?.events) && diagnosticsResponse.json.runtime.events.length === 2);

        const bare = [];
        registerRoutes(
          { connection: { requestRejection: () => undefined }, webServer: { register: (entry) => { bare.push(entry); return () => {}; } } },
          store,
          { openDirectory: async () => {} },
        );
        const bareResponse = mockResponse();
        await bare.find((entry) => entry.path === '/memory-manager/api/events').handler(mockRequest({ url: '/memory-manager/api/events' }), bareResponse);
        const bareBody = JSON.parse(bareResponse.body);
        check('a host without an audit log answers empty, not 500', bareResponse.statusCode === 200 && bareBody.enabled === false && bareBody.events.length === 0);
      } finally {
        await rm(rootDir, { recursive: true, force: true });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});

  tempDirs = [];

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exitCode = failures === 0 ? 0 : 1;
};

main().catch((error) => {
  console.error('SMOKE CRASHED', error);
  process.exitCode = 1;
});
