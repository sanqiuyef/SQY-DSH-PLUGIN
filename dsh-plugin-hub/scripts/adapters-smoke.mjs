#!/usr/bin/env node
/**
 * adapters-smoke.mjs — 适配器层冒烟测试（SPEC §8）。
 *
 * 覆盖：
 *  1. 完整 fixture 插件（.zcode-plugin/plugin.json + 两个技能 + command + agent + hooks.json
 *     + mcpServers + ui.surfaces）的清单解析与组件枚举；
 *  2. 等价声明形态：skills 字符串 / commands 数组 / mcpServers 指向文件 / 根 plugin.json 回退；
 *  3. 拒绝用例：技能目录符号链接、非法 name、manifest 声明 `..` 路径（进 diagnostics 且不抛）；
 *  4. marketplace.json 解析 + resolveMarketSource（字符串源 / 对象源 / npm 拒绝）；
 *  5. sources.materialize 真实复制与 sha256 稳定性（另含 archive/tar 与文件下载）。
 *
 * 运行：node scripts/adapters-smoke.mjs   （全部通过时退出码 0 且打印 ALL PASS）
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readManifest } from '../lib/manifest.js';
import { enumerateComponents, parseFrontmatter, readMarkdownFrontmatter } from '../lib/components.js';
import { isSourceError, materialize, sha256Dir, SourceError } from '../lib/sources.js';
import { isMarketError, MarketError, parseMarketIndex, readLocalIndex, resolveMarketSource } from '../lib/market.js';

const results = { passed: 0, failed: 0, skipped: 0 };
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.passed += 1;
      console.log(`PASS ${String(results.passed + results.failed).padStart(2, '0')} ${name}`);
    })
    .catch((error) => {
      results.failed += 1;
      failures.push({ name, error });
      console.log(`FAIL ${String(results.passed + results.failed).padStart(2, '0')} ${name}`);
      console.log(`     ${error instanceof Error ? error.message : String(error)}`);
    });
}

function skip(name, reason) {
  results.skipped += 1;
  console.log(`SKIP ${String(results.passed + results.failed + results.skipped).padStart(2, '0')} ${name} — ${reason}`);
}

// ============================================================
// fixture 辅助
// ============================================================

async function writeFileAt(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

async function writeJsonAt(filePath, value) {
  return writeFileAt(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/** 目录链接（Windows junction 不需要开发者模式）；平台不允许时返回 false，用例降级为 SKIP。 */
async function tryCreateDirLink(target, linkPath) {
  try {
    await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

/** fixture A：ZCode 完整形态。 */
async function makePluginA(fixtureRoot) {
  const root = join(fixtureRoot, 'smoke-zcode');
  await writeJsonAt(join(root, '.zcode-plugin', 'plugin.json'), {
    name: 'smoke-zcode',
    version: '0.1.0',
    description: '适配器冒烟 fixture（ZCode 形态）',
    skills: 'skills',
    mcpServers: {
      demo: { type: 'stdio', command: 'node', args: ['${ZCODE_PLUGIN_ROOT}/server.mjs'] },
    },
    ui: {
      surfaces: [
        {
          id: 'demo-panel',
          title: { 'zh-CN': '示例面板', 'en-US': 'Demo panel' },
          icon: 'library',
          server: 'demo',
          resourceUri: 'ui://demo/panel.html',
          availability: 'session',
        },
      ],
    },
  });
  // 根 plugin.json 故意写错 name：用于断言 .zcode-plugin 优先。
  await writeJsonAt(join(root, 'plugin.json'), { name: 'shadow-root', version: '9.9.9' });

  await writeFileAt(
    join(root, 'skills', 'a', 'SKILL.md'),
    ['---', 'name: a', 'description: 技能 A 的单行描述。', '---', '', '# A', '', '正文。', ''].join('\n'),
  );
  await writeFileAt(
    join(root, 'skills', 'b-cn', 'SKILL.md'),
    [
      '---',
      'name: b-cn',
      'description: >',
      '  技能 B 的折叠块描述，',
      '  跨两行应该在解析后合并成一行。',
      'when_to_use: >-',
      '  当用户要处理中文文献时使用。',
      '---',
      '',
      '# B',
      '',
    ].join('\n'),
  );
  await writeFileAt(
    join(root, 'commands', 'hello.md'),
    ['---', 'name: hello', 'description: 打招呼命令', 'argument-hint: [name]', '---', '', 'Hello $ARGUMENTS', ''].join('\n'),
  );
  await writeFileAt(
    join(root, 'agents', 'reviewer.md'),
    ['---', 'name: reviewer', 'description: 代码评审 agent', '---', '', 'Review the diff.', ''].join('\n'),
  );
  await writeJsonAt(join(root, 'hooks', 'hooks.json'), {
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node hooks/check.mjs', timeout: 5 }] },
      ],
      UserPromptSubmit: [{ command: 'node hooks/prompt.mjs' }],
    },
  });
  return root;
}

/** fixture B：等价语义的"另一种声明形态"（根 plugin.json、skills 字符串、commands 数组、mcp 走文件）。 */
async function makePluginB(fixtureRoot) {
  const root = join(fixtureRoot, 'smoke-flat');
  await writeJsonAt(join(root, 'plugin.json'), {
    name: 'smoke-flat',
    version: '0.2.0',
    skills: 'skills-alt',
    commands: ['commands-alt'],
    mcpServers: './mcp.json',
  });
  await writeFileAt(join(root, 'skills-alt', 'a', 'SKILL.md'), '---\nname: a\ndescription: 技能 A 的单行描述。\n---\n');
  await writeFileAt(
    join(root, 'skills-alt', 'b-cn', 'SKILL.md'),
    '---\nname: b-cn\ndescription: 技能 B 的折叠块描述，跨两行应该在解析后合并成一行。\nwhen_to_use: 当用户要处理中文文献时使用。\n---\n',
  );
  await writeFileAt(
    join(root, 'commands-alt', 'hello.md'),
    '---\nname: hello\ndescription: 打招呼命令\nargument-hint: [name]\n---\n\nHello $ARGUMENTS\n',
  );
  await writeJsonAt(join(root, 'mcp.json'), {
    mcpServers: {
      demo: { type: 'stdio', command: 'node', args: ['${ZCODE_PLUGIN_ROOT}/server.mjs'] },
    },
  });
  return root;
}

/** 递归收集组件名（断言用）。 */
function namesOf(items) {
  return items.map((item) => item.name);
}

function assertJsonRoundTrip(value, label) {
  const roundTripped = JSON.parse(JSON.stringify(value));
  assert.deepEqual(roundTripped, value, `${label} 必须可无损 JSON 序列化`);
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  const tmpRoot = await mkdtemp(join(os.tmpdir(), 'dsh-plugin-hub-adapters-'));
  console.log(`[adapters-smoke] fixture root: ${tmpRoot}`);
  console.log(`[adapters-smoke] node ${process.version} / ${process.platform}`);

  const pluginA = await makePluginA(tmpRoot);
  const pluginB = await makePluginB(tmpRoot);
  const outsideSkills = join(tmpRoot, 'outside-skills');
  await writeFileAt(join(outsideSkills, 'leaked', 'SKILL.md'), '---\nname: leaked\n---\n');

  let symlinkOk = false;

  // ---------- 用例 1：清单优先级与组件枚举 ----------
  let componentsA = null;
  await test('readManifest: .zcode-plugin/plugin.json 优先于根 plugin.json', async () => {
    const outcome = await readManifest(pluginA);
    assert.equal(outcome.ok, true, outcome.message);
    assert.equal(outcome.format, 'zcode');
    assert.equal(outcome.manifest.name, 'smoke-zcode');
    assert.equal(outcome.manifest.version, '0.1.0');
    assert.ok(outcome.manifestPath.endsWith(join('.zcode-plugin', 'plugin.json')));
  });

  await test('enumerateComponents: fixture A 组件数量与名字', async () => {
    const outcome = await readManifest(pluginA);
    componentsA = await enumerateComponents(pluginA, outcome.manifest, { manifestPath: outcome.manifestPath });

    assert.deepEqual(namesOf(componentsA.skills), ['a', 'b-cn']);
    assert.deepEqual(namesOf(componentsA.commands), ['hello']);
    assert.deepEqual(namesOf(componentsA.agents), ['reviewer']);
    assert.deepEqual(componentsA.hooks.map((hook) => hook.event), ['PreToolUse', 'UserPromptSubmit']);
    assert.deepEqual(Object.keys(componentsA.mcpServers), ['demo']);
    assert.deepEqual(componentsA.uiSurfaces.map((surface) => surface.id), ['demo-panel']);

    assert.deepEqual(componentsA.diagnostics, [], '干净 fixture 不应有 diagnostics');
    assert.deepEqual(componentsA.groups.map((group) => group.kind), ['agent', 'command', 'skill', 'hook', 'mcp']);
    assert.deepEqual(namesOf(componentsA.groups.find((group) => group.kind === 'skill').items), ['a', 'b-cn']);
    assertJsonRoundTrip(componentsA, 'components A');
  });

  await test('enumerateComponents: 技能 frontmatter（折叠块 description / when_to_use）', async () => {
    const skillB = componentsA.skills.find((skill) => skill.name === 'b-cn');
    // YAML 折叠块（`>`）把换行折成**一个空格**，所以原样拼接后逗号后面会有一个空格。
    assert.equal(skillB.description, '技能 B 的折叠块描述， 跨两行应该在解析后合并成一行。');
    assert.equal(skillB.whenToUse, '当用户要处理中文文献时使用。');
    assert.equal(skillB.root, join(pluginA, 'skills', 'b-cn'));
    assert.ok(skillB.path.endsWith('SKILL.md'));

    const command = componentsA.commands[0];
    assert.equal(command.description, '打招呼命令');
    assert.equal(command.argumentHint, '[name]');
    assert.equal(componentsA.agents[0].description, '代码评审 agent');
  });

  await test('enumerateComponents: hook 形状归一（matcher / timeout 秒→毫秒 / 扁平写法）', async () => {
    const pre = componentsA.hooks.find((hook) => hook.event === 'PreToolUse');
    assert.equal(pre.matcher, 'Bash');
    assert.equal(pre.command, 'node hooks/check.mjs');
    assert.equal(pre.timeoutMs, 5000, 'timeout 单位是秒，应归一成毫秒');
    const prompt = componentsA.hooks.find((hook) => hook.event === 'UserPromptSubmit');
    assert.equal(prompt.command, 'node hooks/prompt.mjs');
    assert.equal('matcher' in prompt, false, '无可选字段时不应留 undefined 键');
  });

  await test('enumerateComponents: MCP 形状校验但不展开 ${...}；ui.surfaces 本地化标题', async () => {
    assert.deepEqual(componentsA.mcpServers.demo, {
      type: 'stdio',
      command: 'node',
      args: ['${ZCODE_PLUGIN_ROOT}/server.mjs'],
    });
    const surface = componentsA.uiSurfaces[0];
    assert.equal(surface.title, '示例面板');
    assert.equal(surface.icon, 'library');
    assert.equal(surface.server, 'demo');
    assert.equal(surface.resourceUri, 'ui://demo/panel.html');
    assert.equal('availability' in surface, false, 'V1 uiSurfaces 形状不含 availability');
  });

  // ---------- 用例 2：等价声明形态 ----------
  await test('readManifest: 根 plugin.json 回退（format=root）', async () => {
    const outcome = await readManifest(pluginB);
    assert.equal(outcome.ok, true, outcome.message);
    assert.equal(outcome.format, 'root');
    assert.equal(outcome.manifest.name, 'smoke-flat');
  });

  await test('enumerateComponents: skills 字符串 / commands 数组 / mcpServers 指向文件 等价解析', async () => {
    const outcome = await readManifest(pluginB);
    const componentsB = await enumerateComponents(pluginB, outcome.manifest, { manifestPath: outcome.manifestPath });

    assert.deepEqual(namesOf(componentsB.skills), namesOf(componentsA.skills));
    assert.equal(componentsB.skills.find((skill) => skill.name === 'b-cn').whenToUse, '当用户要处理中文文献时使用。');
    assert.deepEqual(namesOf(componentsB.commands), namesOf(componentsA.commands));
    assert.deepEqual(componentsB.mcpServers, componentsA.mcpServers);
    assert.deepEqual(componentsB.agents, [], '未声明 agents 且无 agents/ 目录时应为空');
    assert.deepEqual(componentsB.diagnostics, []);
    assertJsonRoundTrip(componentsB, 'components B');
  });

  // ---------- 用例 3：拒绝用例 ----------
  await test('拒绝：技能目录符号链接不跟随，且进 diagnostics 不抛', async () => {
    const root = join(tmpRoot, 'smoke-symlink');
    await writeJsonAt(join(root, '.zcode-plugin', 'plugin.json'), { name: 'smoke-symlink' });
    await writeFileAt(join(root, 'skills', 'good', 'SKILL.md'), '---\nname: good\n---\n');
    symlinkOk = await tryCreateDirLink(outsideSkills, join(root, 'skills', 'evil'));
    if (!symlinkOk) {
      skip('拒绝：技能目录符号链接不跟随，且进 diagnostics 不抛', '当前环境无法创建目录符号链接/junction');
      return;
    }

    const outcome = await readManifest(root);
    assert.equal(outcome.ok, true);
    const components = await enumerateComponents(root, outcome.manifest, { manifestPath: outcome.manifestPath });
    assert.deepEqual(namesOf(components.skills), ['good'], '链接目录不能变成技能');
    assert.ok(
      components.diagnostics.some((item) => item.code === 'plugin_symlink_rejected'),
      `应记录 plugin_symlink_rejected，实际：${JSON.stringify(components.diagnostics)}`,
    );
    assertJsonRoundTrip(components, 'components symlink');
  });

  await test('拒绝：manifest name 非法（reason=name，不抛）', async () => {
    const root = join(tmpRoot, 'smoke-bad-name');
    await writeJsonAt(join(root, '.zcode-plugin', 'plugin.json'), { name: 'Bad Name!' });
    const outcome = await readManifest(root);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'name');
    assert.match(outcome.message, /name 非法/);
  });

  await test('拒绝：manifest 声明 ../outside 路径 → diagnostics 且不读到根外技能', async () => {
    const root = join(tmpRoot, 'smoke-escape');
    await writeJsonAt(join(root, '.zcode-plugin', 'plugin.json'), {
      name: 'smoke-escape',
      skills: '../outside-skills',
      commands: ['../../etc'],
    });
    const outcome = await readManifest(root);
    assert.equal(outcome.ok, true, outcome.message);

    const components = await enumerateComponents(root, outcome.manifest, { manifestPath: outcome.manifestPath });
    assert.deepEqual(namesOf(components.skills), [], '../outside-skills 不能被解析成技能根');
    assert.ok(
      components.diagnostics.some((item) => item.code === 'plugin_component_path_invalid'),
      `应记录 plugin_component_path_invalid，实际：${JSON.stringify(components.diagnostics)}`,
    );
    assert.ok(!JSON.stringify(components).includes('leaked'), '根外技能名不能出现在枚举结果里');
    assertJsonRoundTrip(components, 'components escape');
  });

  await test('拒绝：清单缺失 / 非法 JSON 都以 reason 返回（不抛）', async () => {
    const empty = join(tmpRoot, 'smoke-empty');
    await mkdir(empty, { recursive: true });
    const missing = await readManifest(empty);
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'missing');

    const broken = join(tmpRoot, 'smoke-broken');
    await writeFileAt(join(broken, 'plugin.json'), '{ "name": ');
    const invalid = await readManifest(broken);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.reason, 'invalid');
    assert.equal(invalid.format, undefined);
  });

  await test('parseFrontmatter: 单行 / 引号 / | 字面块 / > 折叠块 / 无 frontmatter', async () => {
    assert.deepEqual(parseFrontmatter('no frontmatter here'), {});
    assert.deepEqual(parseFrontmatter('---\nname: a\ndescription: "带引号: 描述"\n---\n'), {
      name: 'a',
      description: '带引号: 描述',
    });
    assert.deepEqual(
      parseFrontmatter('---\nname: lit\ndescription: |\n  line1\n  line2\n---\n'),
      { name: 'lit', description: 'line1\nline2' },
    );
    assert.deepEqual(
      parseFrontmatter('---\nname: fold\ndescription: >-\n  one\n  two\n---\n'),
      { name: 'fold', description: 'one two' },
    );
    assert.deepEqual(
      parseFrontmatter('---\nname: c\nargument-hint: [file]\nwhenToUse: 需要时\n---\n'),
      { name: 'c', argumentHint: '[file]', whenToUse: '需要时' },
    );
    // 文件级入口：不存在/不可读时返回空对象而不是抛错。
    assert.deepEqual(readMarkdownFrontmatter(join(tmpRoot, 'nope.md')), {});
  });

  // ---------- 用例 4：market ----------
  const marketDir = join(tmpRoot, 'market');
  const indexPath = join(marketDir, 'marketplace.json');
  await writeJsonAt(indexPath, {
    name: 'smoke-market',
    description: '冒烟市场',
    owner: { name: 'Lead' },
    plugins: [
      { name: 'alpha', description: '本地目录源', version: '1.2.0', source: './plugins/alpha' },
      { name: 'beta', description: 'GitHub 源', version: 2, source: { source: 'github', repo: 'acme/beta', ref: 'v1.2.3' } },
      { name: 'gamma', description: 'npm 源（V1 不支持）', source: { source: 'npm', package: 'gamma' } },
    ],
  });
  const marketText = await readFile(indexPath, 'utf8');

  await test('parseMarketIndex: 顶层元数据 + entry 保留原始 source（解析推迟）', async () => {
    const parsed = parseMarketIndex(marketText, { indexPath });
    assert.equal(parsed.name, 'smoke-market');
    assert.equal(parsed.description, '冒烟市场');
    assert.equal(parsed.owner, 'Lead');
    assert.deepEqual(namesOf(parsed.plugins), ['alpha', 'beta', 'gamma']);
    assert.deepEqual(parsed.diagnostics, []);

    const alpha = parsed.plugins.find((entry) => entry.name === 'alpha');
    assert.equal(alpha.source, './plugins/alpha', 'plugins[].source 必须是原始字段');
    assert.equal(alpha.description, '本地目录源');
    assert.equal(alpha.version, '1.2.0');
    const beta = parsed.plugins.find((entry) => entry.name === 'beta');
    assert.deepEqual(beta.source, { source: 'github', repo: 'acme/beta', ref: 'v1.2.3' });
    assert.equal(beta.version, '2', '数字 version 归一成字符串');
    assertJsonRoundTrip(parsed, 'market index');
  });

  await test('resolveMarketSource: 字符串相对路径按索引目录解析 → directory', async () => {
    const parsed = parseMarketIndex(marketText, { indexPath });
    const spec = resolveMarketSource(parsed.plugins.find((entry) => entry.name === 'alpha'), { indexPath });
    assert.deepEqual(spec, { kind: 'directory', path: resolve(marketDir, 'plugins/alpha') });
  });

  await test('resolveMarketSource: 索引在 .claude-plugin/ 时相对路径按仓库根解析', async () => {
    // Claude 官方目录：marketplace.json 在 .claude-plugin/，条目写 "./plugins/x" 指仓库根。
    const pluginIndex = resolve(marketDir, '.claude-plugin/marketplace.json');
    const parsed = parseMarketIndex(marketText, { indexPath: pluginIndex });
    const spec = resolveMarketSource(parsed.plugins.find((entry) => entry.name === 'alpha'), {
      indexPath: pluginIndex,
    });
    assert.deepEqual(spec, { kind: 'directory', path: resolve(marketDir, 'plugins/alpha') });
  });

  await test('resolveMarketSource: github 对象源 → git SourceSpec（保留 ref）', async () => {
    const parsed = parseMarketIndex(marketText, { indexPath });
    const spec = resolveMarketSource(parsed.plugins.find((entry) => entry.name === 'beta'), { indexPath });
    assert.deepEqual(spec, { kind: 'git', url: 'https://github.com/acme/beta.git', ref: 'v1.2.3' });
  });

  await test('resolveMarketSource: npm 源抛 market-source-unsupported（结构化错误）', async () => {
    const parsed = parseMarketIndex(marketText, { indexPath });
    let thrown = null;
    try {
      resolveMarketSource(parsed.plugins.find((entry) => entry.name === 'gamma'), { indexPath });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, 'npm 源应抛错');
    assert.ok(isMarketError(thrown), '应是 MarketError');
    assert.equal(thrown.code, 'market-source-unsupported');
    assert.equal(JSON.parse(JSON.stringify(thrown)).code, 'market-source-unsupported');
  });

  await test('resolveMarketSource: git-subdir / 字符串 URL / 相对无基准 三种边界', async () => {
    assert.deepEqual(
      resolveMarketSource({ source: { source: 'git-subdir', url: 'https://example.com/repo.git', path: 'plugins/p', ref: 'main' } }, { indexPath }),
      { kind: 'git', url: 'https://example.com/repo.git', ref: 'main', path: 'plugins/p' },
    );
    assert.deepEqual(
      resolveMarketSource({ source: 'https://example.com/plugins/p.zip' }, { indexPath }),
      { kind: 'archive', url: 'https://example.com/plugins/p.zip' },
    );
    let thrown = null;
    try {
      resolveMarketSource({ source: './plugins/p' }, {});
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown && thrown.code === 'market-index-missing', '缺 indexPath 的相对路径必须拒绝而不是按 cwd 猜');
  });

  await test('readLocalIndex: 从 indexPath 读回；缺失索引抛错', async () => {
    const parsed = await readLocalIndex({ indexPath, name: 'smoke-market' });
    assert.equal(parsed.name, 'smoke-market');
    assert.deepEqual(namesOf(parsed.plugins), ['alpha', 'beta', 'gamma']);

    let thrown = null;
    try {
      await readLocalIndex({ indexPath: join(tmpRoot, 'does-not-exist', 'marketplace.json') });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown && thrown.code === 'market-index-missing', '缺失索引必须抛 market-index-missing');

    const invalid = parseMarketIndex('{ not json', { indexPath });
    assert.equal(invalid.plugins.length, 0);
    assert.ok(invalid.diagnostics.some((item) => item.code === 'market-index-invalid'));
  });

  // ---------- 用例 5：sources ----------
  let shaA = '';
  const destA = join(tmpRoot, 'cache', 'smoke-zcode', '0.1.0');

  await test('materialize(directory): 内容直接落在 destDir，rootPath 恒等 destDir', async () => {
    const outcome = await materialize({ source: { kind: 'directory', path: pluginA }, destDir: destA });
    assert.equal(outcome.rootPath, resolve(destA));
    assert.match(outcome.sha256, /^[0-9a-f]{64}$/);
    shaA = outcome.sha256;

    assert.ok(existsSync(join(destA, '.zcode-plugin', 'plugin.json')), '清单应直接落在 destDir');
    assert.ok(existsSync(join(destA, 'skills', 'a', 'SKILL.md')));
    assert.ok(!existsSync(join(destA, 'smoke-zcode')), '不应把源目录本身再套一层');
    assert.equal(await sha256Dir(destA), shaA, 'materialize 的 sha256 应与 sha256Dir 一致');
  });

  await test('materialize(directory): 重复物化幂等，sha256 稳定', async () => {
    const second = await materialize({ source: { kind: 'directory', path: pluginA }, destDir: destA });
    assert.equal(second.sha256, shaA, '同一来源重复物化摘要必须一致');
    const copy = await materialize({ source: { kind: 'directory', path: pluginA }, destDir: join(tmpRoot, 'cache2', 'p') });
    assert.equal(copy.sha256, shaA, '不同目标目录的摘要也必须一致');
  });

  await test('materialize(directory): 来源含符号链接 → source-invalid（复制不跟随）', async () => {
    if (!symlinkOk) {
      skip('materialize(directory): 来源含符号链接 → source-invalid（复制不跟随）', '当前环境无法创建目录符号链接/junction');
      return;
    }
    const leakySource = join(tmpRoot, 'leaky-source');
    await writeJsonAt(join(leakySource, '.zcode-plugin', 'plugin.json'), { name: 'leaky-source' });
    symlinkOk = await tryCreateDirLink(outsideSkills, join(leakySource, 'linked'));
    if (!symlinkOk) {
      skip('materialize(directory): 来源含符号链接 → source-invalid（复制不跟随）', '创建 junction 失败');
      return;
    }
    let thrown = null;
    try {
      await materialize({ source: { kind: 'directory', path: leakySource }, destDir: join(tmpRoot, 'cache', 'leaky') });
    } catch (error) {
      thrown = error;
    }
    assert.ok(isSourceError(thrown), `应抛 SourceError，实际：${thrown}`);
    assert.equal(thrown.code, 'source-invalid');
    assert.ok(!existsSync(join(tmpRoot, 'cache', 'leaky', 'linked')), '失败时不应留下链接内容');
  });

  await test('materialize: 来源不存在 → source-unreachable；未知 kind → source-invalid', async () => {
    let missing = null;
    try {
      await materialize({ source: { kind: 'directory', path: join(tmpRoot, 'nowhere') }, destDir: join(tmpRoot, 'cache', 'x') });
    } catch (error) {
      missing = error;
    }
    assert.ok(missing instanceof SourceError);
    assert.equal(missing.code, 'source-unreachable');

    let unsupported = null;
    try {
      await materialize({ source: { kind: 'npm' }, destDir: join(tmpRoot, 'cache', 'y') });
    } catch (error) {
      unsupported = error;
    }
    assert.ok(unsupported instanceof SourceError);
    assert.equal(unsupported.code, 'source-invalid');
  });

  await test('downloadTo: file:// 走本地复制（本地包下载链路）', async () => {
    const { downloadTo } = await import('../lib/sources.js');
    const sourceFile = join(pluginA, '.zcode-plugin', 'plugin.json');
    const target = join(tmpRoot, 'downloads', 'plugin.json');
    const written = await downloadTo(pathToFileURL(sourceFile).href, target);
    assert.equal(written, resolve(target));
    assert.equal(await readFile(target, 'utf8'), await readFile(sourceFile, 'utf8'));
  });

  await test('materialize(archive): tar 解压 → 唯一顶层目录提升到 destDir', async () => {
    const tarPath = join(tmpRoot, 'smoke-zcode.tar');
    const tar = spawnSync('tar', ['-cf', tarPath, '-C', tmpRoot, 'smoke-zcode'], { encoding: 'utf8' });
    if (tar.status !== 0 || !existsSync(tarPath)) {
      skip('materialize(archive): tar 解压 → 唯一顶层目录提升到 destDir', `系统 tar 不可用（${tar.error?.message ?? tar.stderr}）`);
      return;
    }
    const destTar = join(tmpRoot, 'cache-tar', 'smoke-zcode', '0.1.0');
    const outcome = await materialize({
      source: { kind: 'archive', url: pathToFileURL(tarPath).href },
      destDir: destTar,
    });
    assert.equal(outcome.rootPath, resolve(destTar));
    assert.ok(existsSync(join(destTar, '.zcode-plugin', 'plugin.json')), '顶层目录内容应被提升');
    assert.ok(!existsSync(join(destTar, 'smoke-zcode')), '不应残留压缩包顶层目录');
    assert.equal(outcome.sha256, shaA, '同一内容的目录复制与归档解压摘要应一致');
  });

  await test('materialize(archive): 多顶层条目 → source-invalid', async () => {
    const multiRoot = join(tmpRoot, 'multi');
    await writeFileAt(join(multiRoot, 'one', 'a.txt'), 'a');
    await writeFileAt(join(multiRoot, 'two', 'b.txt'), 'b');
    const tarPath = join(tmpRoot, 'multi.tar');
    const tar = spawnSync('tar', ['-cf', tarPath, '-C', multiRoot, 'one', 'two'], { encoding: 'utf8' });
    if (tar.status !== 0 || !existsSync(tarPath)) {
      skip('materialize(archive): 多顶层条目 → source-invalid', `系统 tar 不可用（${tar.error?.message ?? tar.stderr}）`);
      return;
    }
    let thrown = null;
    try {
      await materialize({ source: { kind: 'archive', url: pathToFileURL(tarPath).href }, destDir: join(tmpRoot, 'cache-tar', 'multi') });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof SourceError, `应抛 SourceError，实际：${thrown}`);
    assert.equal(thrown.code, 'source-invalid');
    assert.match(thrown.message, /多个顶层条目/);
  });

  // ---------- 汇总 ----------
  const total = results.passed + results.failed + results.skipped;
  console.log('-'.repeat(72));
  console.log(`${total} cases: ${results.passed} passed, ${results.skipped} skipped, ${results.failed} failed`);

  if (results.failed > 0) {
    console.log(`[adapters-smoke] fixture 保留在 ${tmpRoot}（便于排查）`);
    for (const failure of failures) {
      console.log(`\n--- ${failure.name} ---\n${failure.error instanceof Error ? failure.error.stack : failure.error}`);
    }
    process.exitCode = 1;
    return;
  }

  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  console.log('ALL PASS');
}

main().catch((error) => {
  console.error('[adapters-smoke] 未捕获异常：', error);
  process.exitCode = 1;
});
