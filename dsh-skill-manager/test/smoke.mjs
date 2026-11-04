/**
 * dsh-skill-manager — host smoke test (no browser, no profile).
 *
 * Run from the plugin directory:
 *   D:\nodejs\node.exe test\smoke.mjs
 *
 * It exercises the scanner, the lint, the toggle/trash moves, conflict-checked
 * saves, creation, the invocation rewrite, the local import, the market install
 * ledger, the call ledger, and the market reader against a throwaway fixture
 * tree, plus a read-only pass over the real skill roots of this machine.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveRoots } from '../lib/roots.js';
import { scanAll } from '../lib/scan.js';
import { readSkill, saveSkill, createSkill, setInvocation } from '../lib/skill-file.js';
import { setSkillEnabled, trashSkill } from '../lib/toggle.js';
import { importSkillPackage } from '../lib/import.js';
import {
  clearMarketCache,
  installFromMarket,
  marketSummary,
  readInstallState,
  scanMarket,
} from '../lib/market.js';
import { clearUsageCache, collectUsage } from '../lib/usage.js';

let passed = 0;
const failures = [];

/** One assertion with a readable name. */
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`);
  }
}

/** A fixture root row shaped like `resolveRoots` output. */
function fixtureRoot(path, id = 'custom:0') {
  return {
    id,
    label: 'Fixture',
    source: 'custom',
    rank: 300,
    kind: 'custom',
    path,
    exists: true,
    writable: true,
  };
}

const goodFrontmatter = ['---', 'name: alpha', 'description: A well formed fixture skill.', '---', '', '# alpha', '', 'Body text.', ''].join('\n');

/** Build the fixture tree used by most checks. */
async function buildFixture(base) {
  const root = join(base, 'skills');
  await mkdir(join(root, 'alpha'), { recursive: true });
  await writeFile(join(root, 'alpha', 'SKILL.md'), goodFrontmatter, 'utf8');
  await mkdir(join(root, 'alpha', 'references'), { recursive: true });
  await writeFile(join(root, 'alpha', 'references', 'notes.md'), '# notes\n', 'utf8');

  await writeFile(
    join(root, 'flat-skill.md'),
    ['---', 'name: flat-skill', 'description: A flat file skill.', '---', '', 'flat body', ''].join('\n'),
    'utf8',
  );

  await mkdir(join(root, 'broken-yaml'), { recursive: true });
  await writeFile(join(root, 'broken-yaml', 'SKILL.md'), ['---', 'name: [unclosed', '---', '', 'x', ''].join('\n'), 'utf8');

  await mkdir(join(root, 'bom-skill'), { recursive: true });
  await writeFile(
    join(root, 'bom-skill', 'SKILL.md'),
    '\uFEFF' + ['---', 'name: bom-skill', 'description: Has a BOM.', '---', '', 'bom body', ''].join('\n'),
    'utf8',
  );

  await mkdir(join(root, 'no-description'), { recursive: true });
  await writeFile(join(root, 'no-description', 'SKILL.md'), ['---', 'name: no-description', '---', '', 'x', ''].join('\n'), 'utf8');

  await mkdir(join(root, '_disabled', 'parked'), { recursive: true });
  await writeFile(
    join(root, '_disabled', 'parked', 'SKILL.md'),
    ['---', 'name: parked', 'description: A disabled skill.', '---', '', 'parked body', ''].join('\n'),
    'utf8',
  );

  return root;
}

console.log('dsh-skill-manager smoke');

const base = await mkdtemp(join(tmpdir(), 'dsh-skill-manager-'));
try {
  const rootPath = await buildFixture(base);
  const root = fixtureRoot(rootPath);
  const { skills, diagnostics } = await scanAll({ roots: [root] });
  const byName = new Map(skills.map((skill) => [skill.dirName, skill]));

  await check('scanner finds directory + flat skills', () => {
    assert.ok(byName.has('alpha'), 'alpha missing');
    assert.ok(byName.has('flat-skill'), 'flat-skill missing');
    assert.equal(byName.get('alpha').kind, 'directory');
    assert.equal(byName.get('flat-skill').kind, 'file');
    assert.equal(byName.get('alpha').state, 'enabled');
  });

  await check('scanner reports the parked skill as disabled', () => {
    const parked = byName.get('parked');
    assert.ok(parked, 'parked missing');
    assert.equal(parked.state, 'disabled');
  });

  await check('BOM is an error issue', () => {
    const skill = byName.get('bom-skill');
    assert.equal(skill.state, 'invalid');
    assert.ok(skill.issues.some((issue) => issue.code === 'bom'));
  });

  await check('malformed YAML is an error issue with a line', () => {
    const skill = byName.get('broken-yaml');
    assert.equal(skill.state, 'invalid');
    assert.ok(skill.issues.some((issue) => issue.code === 'yaml-invalid'));
  });

  await check('missing description is an error issue', () => {
    const skill = byName.get('no-description');
    assert.equal(skill.state, 'invalid');
    assert.ok(skill.issues.some((issue) => issue.code === 'description-missing'));
  });

  await check('directory resources are counted', () => {
    const skill = byName.get('alpha');
    assert.equal(skill.resources.files >= 1, true);
  });

  await check('results are sorted by rank then name', () => {
    const names = skills.map((skill) => skill.name);
    assert.deepEqual(names, [...names].sort((left, right) => left.localeCompare(right)));
  });

  await check('detail read returns body, eol and hash', async () => {
    const detail = await readSkill({ roots: [root], rootId: 'custom:0', dirName: 'alpha', kind: 'directory', state: 'enabled' });
    assert.equal(detail.hasBom, false);
    assert.equal(detail.eol, 'lf');
    assert.match(detail.body, /Body text\./);
    assert.equal(detail.frontmatter.name, 'alpha');
    assert.equal(typeof detail.skill.hash, 'string');
  });

  await check('save with a stale hash is refused', async () => {
    const detail = await readSkill({ roots: [root], rootId: 'custom:0', dirName: 'alpha', kind: 'directory', state: 'enabled' });
    await writeFile(join(rootPath, 'alpha', 'SKILL.md'), goodFrontmatter.replace('Body text.', 'Body changed.'), 'utf8');
    await assert.rejects(
      () =>
        saveSkill({
          roots: [root],
          rootId: 'custom:0',
          dirName: 'alpha',
          kind: 'directory',
          state: 'enabled',
          expectedHash: detail.skill.hash,
          content: detail.content,
        }),
      /已变化/,
    );
  });

  await check('save with the current hash succeeds and strips BOM on request', async () => {
    const bomDetail = await readSkill({ roots: [root], rootId: 'custom:0', dirName: 'bom-skill', kind: 'directory', state: 'enabled' });
    const saved = await saveSkill({
      roots: [root],
      rootId: 'custom:0',
      dirName: 'bom-skill',
      kind: 'directory',
      state: 'enabled',
      expectedHash: bomDetail.skill.hash,
      content: bomDetail.content,
      stripBom: true,
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.issues.some((issue) => issue.code === 'bom'), false);
    const after = await readFile(join(rootPath, 'bom-skill', 'SKILL.md'), 'utf8');
    assert.equal(after.charCodeAt(0), '-'.charCodeAt(0));
  });

  await check('disable moves the entry into _disabled and back', async () => {
    await setSkillEnabled({ roots: [root], rootId: 'custom:0', dirName: 'flat-skill', kind: 'file', enabled: false });
    let scanned = await scanAll({ roots: [root] });
    assert.equal(scanned.skills.find((skill) => skill.dirName === 'flat-skill').state, 'disabled');
    await setSkillEnabled({ roots: [root], rootId: 'custom:0', dirName: 'flat-skill', kind: 'file', enabled: true });
    scanned = await scanAll({ roots: [root] });
    assert.equal(scanned.skills.find((skill) => skill.dirName === 'flat-skill').state, 'enabled');
  });

  await check('trash moves the entry into _trash', async () => {
    const result = await trashSkill({ roots: [root], rootId: 'custom:0', dirName: 'parked', kind: 'directory' });
    assert.match(result.trashed, /_trash/);
    const scanned = await scanAll({ roots: [root] });
    assert.equal(scanned.skills.some((skill) => skill.dirName === 'parked'), false);
  });

  await check('create writes a new directory skill', async () => {
    const created = await createSkill({
      roots: [root],
      rootId: 'custom:0',
      name: 'created-skill',
      description: 'Created by the smoke test.',
      whenToUse: 'When testing creation.',
    });
    assert.equal(created.skill.name, 'created-skill');
    const scanned = await scanAll({ roots: [root] });
    assert.equal(scanned.skills.find((skill) => skill.dirName === 'created-skill').state, 'enabled');
  });

  await check('create refuses a duplicate name', async () => {
    await assert.rejects(
      () => createSkill({ roots: [root], rootId: 'custom:0', name: 'alpha', description: 'dup' }),
      /已存在/,
    );
  });

  await check('create refuses a non-kebab name', async () => {
    await assert.rejects(
      () => createSkill({ roots: [root], rootId: 'custom:0', name: 'Bad Name', description: 'x' }),
      /kebab-case|路径段/,
    );
  });

  await check('writes to a read-only root are refused', async () => {
    const readOnlyRoot = { ...root, writable: false };
    await assert.rejects(
      () => setSkillEnabled({ roots: [readOnlyRoot], rootId: 'custom:0', dirName: 'alpha', kind: 'directory', enabled: false }),
      /只读/,
    );
  });

  /* ---------------- 三态调用策略（软禁用） ---------------- */

  await check('setInvocation writes only the invocation keys and keeps the rest byte-identical', async () => {
    await mkdir(join(rootPath, 'comment-skill'), { recursive: true });
    const original = [
      '---',
      '# 顶部注释必须保留',
      'name: comment-skill',
      'description: Keeps comments.',
      '---',
      '',
      'body 也原样保留',
      '',
    ].join('\n');
    await writeFile(join(rootPath, 'comment-skill', 'SKILL.md'), original, 'utf8');

    const result = await setInvocation({
      roots: [root], rootId: 'custom:0', dirName: 'comment-skill', kind: 'directory',
      state: 'enabled', model: false, user: true,
    });
    assert.deepEqual(result.invocation, { model: false, user: true });
    const after = await readFile(join(rootPath, 'comment-skill', 'SKILL.md'), 'utf8');
    assert.equal(after.includes('# 顶部注释必须保留'), true);
    assert.equal(after.includes('body 也原样保留'), true);
    assert.equal(after.includes('disable-model-invocation: true'), true);
    // 只是软禁用：条目仍在根目录里，没有进 _disabled/
    const scanned = await scanAll({ roots: [root] });
    const entry = scanned.skills.find((skill) => skill.dirName === 'comment-skill');
    assert.equal(entry.state, 'enabled');
    assert.deepEqual(entry.invocation, { model: false, user: true });
  });

  await check('setInvocation can turn both surfaces off and back on', async () => {
    const off = await setInvocation({
      roots: [root], rootId: 'custom:0', dirName: 'comment-skill', kind: 'directory',
      state: 'enabled', model: false, user: false,
    });
    assert.deepEqual(off.invocation, { model: false, user: false });
    const on = await setInvocation({
      roots: [root], rootId: 'custom:0', dirName: 'comment-skill', kind: 'directory',
      state: 'enabled', expectedHash: off.hash, model: true, user: true,
    });
    assert.deepEqual(on.invocation, { model: true, user: true });
  });

  await check('setInvocation refuses a stale hash and non-boolean input', async () => {
    await assert.rejects(
      () => setInvocation({
        roots: [root], rootId: 'custom:0', dirName: 'comment-skill', kind: 'directory',
        state: 'enabled', expectedHash: 'stale-hash', model: false, user: false,
      }),
      /已变化/,
    );
    await assert.rejects(
      () => setInvocation({ roots: [root], rootId: 'custom:0', dirName: 'comment-skill', kind: 'directory', model: 'no', user: true }),
      /布尔/,
    );
  });

  await check('setInvocation rewrites a parked (disabled) skill in place', async () => {
    await mkdir(join(rootPath, '_disabled', 'parked-two'), { recursive: true });
    await writeFile(
      join(rootPath, '_disabled', 'parked-two', 'SKILL.md'),
      ['---', 'name: parked-two', 'description: Parked.', '---', '', 'x', ''].join('\n'),
      'utf8',
    );
    const result = await setInvocation({
      roots: [root], rootId: 'custom:0', dirName: 'parked-two', kind: 'directory',
      state: 'disabled', model: false, user: true,
    });
    assert.deepEqual(result.invocation, { model: false, user: true });
    const scanned = await scanAll({ roots: [root] });
    const entry = scanned.skills.find((skill) => skill.dirName === 'parked-two');
    assert.equal(entry.state, 'disabled');
    assert.deepEqual(entry.invocation, { model: false, user: true });
  });

  await check('setInvocation keeps an inline comment on the rewritten key', async () => {
    await mkdir(join(rootPath, 'commented-keys'), { recursive: true });
    await writeFile(
      join(rootPath, 'commented-keys', 'SKILL.md'),
      ['---', 'name: commented-keys', 'description: Inline comments.', 'user-invocable: false  # only for /deploy', '---', '', 'x', ''].join('\n'),
      'utf8',
    );
    const result = await setInvocation({
      roots: [root], rootId: 'custom:0', dirName: 'commented-keys', kind: 'directory',
      state: 'enabled', model: false, user: true,
    });
    assert.deepEqual(result.invocation, { model: false, user: true });
    const after = await readFile(join(rootPath, 'commented-keys', 'SKILL.md'), 'utf8');
    assert.match(after, /user-invocable: true  # only for \/deploy/);
    assert.match(after, /disable-model-invocation: true/);
  });

  await check('setInvocation refuses a duplicate-key file instead of rewriting one of them', async () => {
    await mkdir(join(rootPath, 'dup-keys'), { recursive: true });
    await writeFile(
      join(rootPath, 'dup-keys', 'SKILL.md'),
      ['---', 'name: dup-keys', 'description: Dup.', 'user-invocable: false', 'user-invocable: true', '---', '', 'x', ''].join('\n'),
      'utf8',
    );
    await assert.rejects(
      () => setInvocation({ roots: [root], rootId: 'custom:0', dirName: 'dup-keys', kind: 'directory', model: false, user: true }),
      /frontmatter/,
    );
  });

  await check('setInvocation refuses a file the host would not parse', async () => {
    await mkdir(join(rootPath, 'bom-invocation'), { recursive: true });
    await writeFile(
      join(rootPath, 'bom-invocation', 'SKILL.md'),
      `\uFEFF${['---', 'name: bom-invocation', 'description: BOM.', '---', 'x'].join('\n')}`,
      'utf8',
    );
    await assert.rejects(
      () => setInvocation({ roots: [root], rootId: 'custom:0', dirName: 'bom-invocation', kind: 'directory', model: false, user: true }),
      /frontmatter/,
    );
  });

  /* ---------------- 本地技能包导入 ---------------- */

  await check('import flattens nested skills and reports per-item skips', async () => {
    const incoming = join(base, 'incoming');
    await mkdir(join(incoming, 'bundle', 'references'), { recursive: true });
    await writeFile(join(incoming, 'bundle', 'SKILL.md'), ['---', 'name: imported-bundle', 'description: Bundle.', '---', 'b'].join('\n'), 'utf8');
    await writeFile(join(incoming, 'bundle', 'references', 'notes.md'), '# notes\n', 'utf8');
    await writeFile(join(incoming, 'flat-import.md'), ['---', 'name: flat-import', 'description: Flat.', '---', 'f'].join('\n'), 'utf8');
    await mkdir(join(incoming, 'nest', 'deep'), { recursive: true });
    await writeFile(join(incoming, 'nest', 'deep', 'SKILL.md'), ['---', 'name: deep-import', 'description: Deep.', '---', 'd'].join('\n'), 'utf8');
    await mkdir(join(incoming, 'broken-import'), { recursive: true });
    await writeFile(join(incoming, 'broken-import', 'SKILL.md'), ['---', 'name: broken-import', '---', 'x'].join('\n'), 'utf8');
    await writeFile(join(incoming, 'readme.md'), '# not a skill\n', 'utf8');

    const result = await importSkillPackage({ root, sourcePath: incoming });
    assert.deepEqual(result.imported.map((entry) => entry.name).sort(), ['deep-import', 'flat-import', 'imported-bundle']);
    assert.ok(result.skipped.some((entry) => entry.code === 'invalid' && entry.issue === 'description-missing'));
    assert.ok(result.skipped.some((entry) => entry.code === 'invalid' && entry.name === 'readme'));
    // 整包复制：references 一起走
    assert.match(await readFile(join(rootPath, 'imported-bundle', 'references', 'notes.md'), 'utf8'), /notes/);
    const scanned = await scanAll({ roots: [root] });
    assert.equal(scanned.skills.filter((skill) => ['deep-import', 'flat-import', 'imported-bundle'].includes(skill.name)).length, 3);

    const again = await importSkillPackage({ root, sourcePath: incoming });
    assert.equal(again.imported.length, 0);
    assert.ok(again.skipped.filter((entry) => entry.code === 'exists').length >= 3);
  });

  await check('import refuses a source inside the target root and a missing source', async () => {
    await assert.rejects(
      () => importSkillPackage({ root, sourcePath: join(rootPath, 'alpha') }),
      /已在目标技能根内/,
    );
    await assert.rejects(
      () => importSkillPackage({ root, sourcePath: join(base, 'no-such-dir') }),
      /来源不存在/,
    );
  });

  await check('import reports an empty folder instead of pretending it worked', async () => {
    await mkdir(join(base, 'empty-pack'), { recursive: true });
    const result = await importSkillPackage({ root, sourcePath: join(base, 'empty-pack') });
    assert.equal(result.imported.length, 0);
    assert.equal(result.skipped[0].code, 'no-skill');
  });

  /* ---------------- 市场安装账本 ---------------- */

  await check('market install records a ledger entry, and a changed market copy reports an update', async () => {
    const marketDir = join(base, 'skills-management', 'market');
    const userRoot = join(base, 'user-skills');
    await mkdir(userRoot, { recursive: true });
    await mkdir(join(marketDir, 'skills', 'repo-a', 'demo'), { recursive: true });
    await writeFile(join(marketDir, 'skills', 'repo-a', 'demo', 'SKILL.md'), ['---', 'name: demo-skill', 'description: Demo.', '---', 'v1'].join('\n'), 'utf8');
    // 同名但来自另一个仓库：不能被当成「已安装」
    await mkdir(join(marketDir, 'skills', 'repo-b', 'demo-skill'), { recursive: true });
    await writeFile(join(marketDir, 'skills', 'repo-b', 'demo-skill', 'SKILL.md'), ['---', 'name: demo-skill', 'description: Other repo.', '---', 'o'].join('\n'), 'utf8');

    const userRootRow = { ...root, id: 'user-dsh', rank: 400, kind: 'user', path: userRoot, writable: true };

    let view = await scanMarket({ marketDir, installedNames: ['demo-skill'], installState: await readInstallState(marketDir) });
    let entry = view.repos.find((repo) => repo.repo === 'repo-a').skills.find((skill) => skill.name === 'demo-skill');
    assert.equal(entry.installed, false);
    assert.equal(entry.nameTaken, true, 'a hand-written same-name skill must not read as installed');

    const installed = await installFromMarket({ marketDir, repo: 'repo-a', folder: 'demo', root: userRootRow });
    assert.equal(installed.ok, true);
    assert.equal(installed.recorded, true);
    const state = await readInstallState(marketDir);
    const record = Object.values(state.installed)[0];
    assert.equal(record.repo, 'repo-a');
    assert.equal(record.folder, 'demo');
    assert.ok(Object.keys(record.files).length > 0);

    view = await scanMarket({ marketDir, installedNames: [], installState: await readInstallState(marketDir) });
    entry = view.repos.find((repo) => repo.repo === 'repo-a').skills.find((skill) => skill.name === 'demo-skill');
    const other = view.repos.find((repo) => repo.repo === 'repo-b').skills.find((skill) => skill.name === 'demo-skill');
    assert.equal(entry.installed, true);
    assert.equal(entry.updateAvailable, 'current');
    assert.equal(other.installed, false, 'same name from another repo must not read as installed');

    clearMarketCache();
    await writeFile(join(marketDir, 'skills', 'repo-a', 'demo', 'SKILL.md'), ['---', 'name: demo-skill', 'description: Demo.', '---', 'v2'].join('\n'), 'utf8');
    view = await scanMarket({ marketDir, installedNames: [], installState: await readInstallState(marketDir) });
    entry = view.repos.find((repo) => repo.repo === 'repo-a').skills.find((skill) => skill.name === 'demo-skill');
    assert.equal(entry.updateAvailable, 'different');

    const summary = await marketSummary({ marketDir, installedNames: [], installState: await readInstallState(marketDir) });
    assert.equal(summary.installed, 1);
  });

  await check('a flat .md market entry compares by content, not by file name', async () => {
    const marketDir = join(base, 'skills-management', 'market');
    const flatRoot = join(base, 'flat-user-skills');
    await mkdir(flatRoot, { recursive: true });
    await mkdir(join(marketDir, 'skills', 'repo-flat'), { recursive: true });
    // 市场文件名与 frontmatter name 不同：安装后会落成 <name>.md，文件名不可比。
    await writeFile(
      join(marketDir, 'skills', 'repo-flat', 'some-odd-file.md'),
      ['---', 'name: named-differently', 'description: Flat market entry.', '---', 'body'].join('\n'),
      'utf8',
    );
    const flatRootRow = { ...root, id: 'user-dsh', rank: 400, kind: 'user', path: flatRoot, writable: true };
    // 索引有 5 分钟缓存：测试直接改市场目录后必须显式清缓存。
    clearMarketCache();
    const installed = await installFromMarket({ marketDir, repo: 'repo-flat', folder: 'some-odd-file.md', root: flatRootRow });
    assert.equal(installed.name, 'named-differently');
    assert.equal(installed.targetPath, join(flatRoot, 'named-differently.md'));

    const view = await scanMarket({
      marketDir,
      installedNames: [],
      installState: await readInstallState(marketDir),
      rootPaths: [flatRoot],
    });
    const entry = view.repos.find((repo) => repo.repo === 'repo-flat').skills[0];
    assert.equal(entry.installed, true);
    assert.equal(entry.updateAvailable, 'current', 'identical bytes must not read as an update');
  });

  await check('an incomplete hash snapshot reads as unknown, never as an update', async () => {
    const marketDir = join(base, 'skills-management', 'market');
    const bigRoot = join(base, 'big-user-skills');
    await mkdir(bigRoot, { recursive: true });
    await mkdir(join(marketDir, 'skills', 'repo-big', 'big'), { recursive: true });
    await writeFile(join(marketDir, 'skills', 'repo-big', 'big', 'SKILL.md'), ['---', 'name: big-skill', 'description: Big.', '---', 'b'].join('\n'), 'utf8');
    // 超过单文件哈希上限（1 MiB）：内容一致也无法证明相等。
    await writeFile(join(marketDir, 'skills', 'repo-big', 'big', 'blob.bin'), Buffer.alloc(1024 * 1024 + 16, 7));
    const bigRootRow = { ...root, id: 'user-dsh', rank: 400, kind: 'user', path: bigRoot, writable: true };
    clearMarketCache();
    await installFromMarket({ marketDir, repo: 'repo-big', folder: 'big', root: bigRootRow });

    const state = await readInstallState(marketDir);
    const record = Object.values(state.installed).find((entry) => entry.repo === 'repo-big');
    assert.equal(record.complete, false, 'an oversized file must mark the snapshot incomplete');

    const view = await scanMarket({
      marketDir, installedNames: [], installState: state, rootPaths: [bigRoot],
    });
    const entry = view.repos.find((repo) => repo.repo === 'repo-big').skills[0];
    assert.equal(entry.installed, true);
    assert.equal(entry.updateAvailable, 'unknown');
  });

  await check('the install ledger is scoped to the roots of the current request', async () => {
    const marketDir = join(base, 'skills-management', 'market');
    const rootA = join(base, 'workspace-a-skills');
    const rootB = join(base, 'workspace-b-skills');
    await mkdir(rootA, { recursive: true });
    await mkdir(rootB, { recursive: true });
    await mkdir(join(marketDir, 'skills', 'repo-a', 'demo'), { recursive: true });
    await writeFile(join(marketDir, 'skills', 'repo-a', 'demo', 'SKILL.md'), ['---', 'name: demo-skill', 'description: Demo.', '---', 'same'].join('\n'), 'utf8');
    const rowA = { ...root, id: 'user-dsh', rank: 400, kind: 'user', path: rootA, writable: true };
    await installFromMarket({ marketDir, repo: 'repo-a', folder: 'demo', root: rowA });

    // 同一个市场的同一份账本，用 B 工作区的根去看：不能显示「已安装」。
    const state = await readInstallState(marketDir);
    const inB = await scanMarket({ marketDir, installedNames: ['demo-skill'], installState: state, rootPaths: [rootB] });
    const entryB = inB.repos.find((repo) => repo.repo === 'repo-a').skills.find((skill) => skill.name === 'demo-skill');
    assert.equal(entryB.installed, false);
    assert.equal(entryB.updateAvailable, undefined);
    assert.equal(entryB.nameTaken, true);
    const summaryB = await marketSummary({ marketDir, installedNames: [], installState: state, rootPaths: [rootB] });
    assert.equal(summaryB.installed, 0);

    // 回到 A 工作区：仍认这条安装记录。
    const inA = await scanMarket({ marketDir, installedNames: [], installState: state, rootPaths: [rootA] });
    const entryA = inA.repos.find((repo) => repo.repo === 'repo-a').skills.find((skill) => skill.name === 'demo-skill');
    assert.equal(entryA.installed, true);
  });

  /* ---------------- 调用账本 ---------------- */

  await check('usage ledger counts model calls and /name uses per window', async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const sessionQuery = {
      async listSessions() {
        return [
          { header: { id: 's-new', createdAt: now - day }, live: false, persisted: true },
          { header: { id: 's-old', createdAt: now - 40 * day }, live: false, persisted: true },
          { header: { id: 's-ancient', createdAt: now - 200 * day }, live: false, persisted: true },
        ];
      },
      async readSession(id) {
        if (id === 's-new') {
          return {
            session: { id },
            events: [
              { type: 'tool/call', time: now - 2 * day, seq: 1, data: { name: 'skill', arguments: JSON.stringify({ name: 'alpha' }) } },
              { type: 'tool/call', time: now - 2 * day, seq: 2, data: { name: 'skill', arguments: 'not json' } },
              { type: 'tool/call', time: now - 2 * day, seq: 3, data: { name: 'fs_read', arguments: '{"path":"a"}' } },
              { type: 'user/message', time: now - day, seq: 4, data: { role: 'user', source: { kind: 'skill-invocation', name: 'beta', form: 'instructions' } } },
              { type: 'user/message', time: now - day, seq: 5, data: { role: 'user', source: { kind: 'user' } } },
            ],
          };
        }
        if (id === 's-old') {
          return { session: { id }, events: [{ type: 'tool/call', time: now - 20 * day, seq: 1, data: { name: 'skill', arguments: JSON.stringify({ name: 'alpha' }) } }] };
        }
        return { session: { id }, events: [] };
      },
    };
    clearUsageCache();
    const ledger = await collectUsage({ sessionQuery });
    assert.equal(ledger.available, true);
    assert.equal(ledger.sessions.total, 2);
    const alpha = ledger.skills.find((row) => row.name === 'alpha');
    assert.deepEqual([alpha.d7, alpha.d30, alpha.d90, alpha.modelCalls, alpha.userCalls], [1, 2, 2, 2, 0]);
    const beta = ledger.skills.find((row) => row.name === 'beta');
    assert.deepEqual([beta.d7, beta.d90, beta.modelCalls, beta.userCalls], [1, 1, 0, 1]);
  });

  await check('usage ledger does not re-count fork-inherited events', async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const inheritedEvent = { type: 'tool/call', time: now - day, seq: 1, data: { name: 'skill', arguments: JSON.stringify({ name: 'from-parent' }) } };
    const ownEvent = { type: 'tool/call', time: now - day, seq: 2, data: { name: 'skill', arguments: JSON.stringify({ name: 'own-call' }) } };
    const sessionQuery = {
      async listSessions() {
        return [{ header: { id: 'fork', createdAt: now - 2 * day }, live: false, persisted: true }];
      },
      async readSession() {
        // 前 1 个事件是从父会话继承来的。
        return { session: { id: 'fork' }, inheritedEventCount: 1, events: [inheritedEvent, ownEvent] };
      },
    };
    clearUsageCache();
    const ledger = await collectUsage({ sessionQuery });
    assert.equal(ledger.available, true);
    assert.equal(ledger.skills.some((row) => row.name === 'from-parent'), false, 'inherited calls belong to the ancestor session');
    assert.equal(ledger.skills.find((row) => row.name === 'own-call').d7, 1);
  });

  await check('usage ledger degrades instead of throwing', async () => {
    const missing = await collectUsage({ sessionQuery: undefined });
    assert.equal(missing.available, false);
    assert.match(missing.error, /sessionQuery/);
    const broken = await collectUsage({
      sessionQuery: {
        listSessions: async () => { throw new Error('boom'); },
        readSession: async () => ({ events: [] }),
      },
    });
    assert.equal(broken.available, false);
    const partial = await collectUsage({
      sessionQuery: {
        listSessions: async () => [{ header: { id: 'x', createdAt: Date.now() } }],
        readSession: async () => { throw new Error('corrupt'); },
      },
    });
    assert.equal(partial.available, true);
    assert.equal(partial.sessions.skipped, 1);
  });
} finally {
  await rm(base, { recursive: true, force: true }).catch(() => {});
}

console.log('\nreal roots');
const resolved = resolveRoots({ options: {}, cwd: process.cwd() });
const real = await scanAll({ roots: resolved.roots });
console.log(`  roots: ${resolved.roots.map((root) => `${root.id}${root.exists ? '' : '(missing)'}`).join(', ')}`);
console.log(`  skills: ${real.skills.length} (enabled ${real.skills.filter((s) => s.state === 'enabled').length}, disabled ${real.skills.filter((s) => s.state === 'disabled').length}, invalid ${real.skills.filter((s) => s.state === 'invalid').length})`);
for (const skill of real.skills.slice(0, 8)) {
  console.log(`    - [${skill.state}] ${skill.name} · ${skill.source} · ${skill.description.slice(0, 48)}`);
}

await check('real user root scans without diagnostics of level error', () => {
  const errorDiagnostics = real.diagnostics.filter((entry) => entry.code === 'read-error');
  assert.equal(errorDiagnostics.length, 0);
});

const marketDir = join(resolved.dshHome, 'skills-management', 'market');
const summary = await marketSummary({ marketDir });
console.log(`  market: ${summary.available ? `${summary.repos} repos · ${summary.skills} skills` : 'not found'}`);
if (summary.available) {
  const limited = await scanMarket({ marketDir, limit: 5 });
  await check('market scan returns parsed skills', () => {
    assert.equal(limited.available, true);
    assert.ok(limited.repos.length > 0);
    assert.ok(limited.repos[0].skills.length > 0);
    assert.equal(typeof limited.repos[0].skills[0].name, 'string');
  });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(failure.error);
  process.exitCode = 1;
}
