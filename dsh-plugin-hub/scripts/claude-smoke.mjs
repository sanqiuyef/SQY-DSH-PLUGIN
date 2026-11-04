#!/usr/bin/env node
/**
 * claude-smoke.mjs — Claude 插件格式兼容冒烟（独立于既有 4 套冒烟）。
 *
 * 覆盖：
 *  1. 清单候选：`.zcode-plugin/plugin.json` > 根 `plugin.json` > `.claude-plugin/plugin.json`
 *     （format='claude'），以及 Claude 清单同样走符号链接 / 体积 / 非法 JSON 校验；
 *  2. market：`{source:'url', url:'…git'}` 与 git@ URL 落成 git 克隆（不再当 archive）、
 *     非 git URL 仍走 archive、`{source:'pip'}` 明确 unsupported、条目 lspServers →
 *     componentTypes 含 lsp（合并去重 / 白名单顺序）、author 归一与 homepage/license 透传；
 *  3. components：manifest.lspServers → components.lsp，并进 groups（kind='lsp'，排 mcp 之后）；
 *  4. 端到端：完整 Claude fixture（skills/commands/agents/hooks/.mcp.json/lspServers）的
 *     清单解析、四类组件数量与名字、hook 事件归一、MCP server 名、无 diagnostics。
 *
 * 全部 fixture 建在系统临时目录下的唯一子目录里，跑完（含失败）在 finally 清理；
 * 不联网、不依赖真实 Claude 仓库。
 *
 * 运行：node scripts/claude-smoke.mjs   （全部通过时退出码 0 且打印 ALL PASS）
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join } from 'node:path';

import { enumerateComponents } from '../lib/components.js';
import { readManifest } from '../lib/manifest.js';
import { isMarketError, parseMarketIndex, resolveMarketSource } from '../lib/market.js';
import { CLAUDE_FIXTURE_NAME, claudeManifest, makeClaudePlugin, writeClaudeManifest } from './fixture/make-claude.mjs';

const results = { passed: 0, failed: 0, skipped: 0 };
const failures = [];
/** test() 回调返回它表示跳过（避免把 skip 同时计成 pass）。 */
const SKIP = Symbol('skip');

const caseNumber = () => String(results.passed + results.failed + results.skipped + 1).padStart(2, '0');

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((outcome) => {
      if (outcome && outcome[SKIP]) {
        results.skipped += 1;
        console.log(`SKIP ${caseNumber()} ${name} — ${outcome.reason}`);
        return;
      }
      results.passed += 1;
      console.log(`PASS ${caseNumber()} ${name}`);
    })
    .catch((error) => {
      results.failed += 1;
      failures.push({ name, error });
      console.log(`FAIL ${caseNumber()} ${name}`);
      console.log(`     ${error instanceof Error ? error.message : String(error)}`);
    });
}

/** 标记当前用例跳过（环境不支持时使用）。 */
function skip(reason) {
  return { [SKIP]: true, reason };
}

// ============================================================
// fixture 辅助（只写系统临时目录）
// ============================================================

async function writeFileAt(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

async function writeJsonAt(filePath, value) {
  return writeFileAt(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/** 目录链接（Windows junction 不需要开发者模式）；平台不允许时返回 false。 */
async function tryCreateDirLink(target, linkPath) {
  try {
    await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

/** 文件链接（Windows 需要开发者模式/权限）；不允许时返回 false。 */
async function tryCreateFileLink(target, linkPath) {
  try {
    await symlink(target, linkPath, 'file');
    return true;
  } catch {
    return false;
  }
}

function namesOf(items) {
  return items.map((item) => item.name);
}

/** components.lsp 的元素是 lspServers 的键名（字符串）；兼容展示层可能用 { name } 包装。 */
function lspNamesOf(list) {
  return list.map((item) => (typeof item === 'string' ? item : item?.name));
}

function assertJsonRoundTrip(value, label) {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${label} 必须可无损 JSON 序列化`);
}

function outcomeMessage(outcome) {
  return `readManifest 实际返回：${JSON.stringify(outcome)}`;
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  const startedAt = Date.now();
  const tmpRoot = await mkdtemp(join(os.tmpdir(), 'dsh-plugin-hub-claude-'));
  console.log(`[claude-smoke] fixture root: ${tmpRoot}`);
  console.log(`[claude-smoke] node ${process.version} / ${process.platform}`);

  try {
    // 完整 fixture：端到端与组件用例共用（只读，不会互相污染）。
    const claudeRoot = await makeClaudePlugin(join(tmpRoot, 'claude-fixture'));

    // ----------------------------------------------------------
    // 用例 1：Claude 清单候选
    // ----------------------------------------------------------
    await test('readManifest: .claude-plugin/plugin.json → format=claude', async () => {
      const outcome = await readManifest(claudeRoot);
      assert.equal(outcome.ok, true, outcomeMessage(outcome));
      assert.equal(outcome.format, 'claude', `format 应为 claude，实际：${outcome.format}`);
      assert.equal(outcome.manifest.name, CLAUDE_FIXTURE_NAME);
      assert.equal(outcome.manifest.version, '1.4.0');
      assert.equal(outcome.manifest.author.name, 'plugin-hub tests', 'author 对象应原样保留');
      assert.equal(outcome.manifest.homepage, 'https://example.com/claude-fixture');
      assert.equal(outcome.manifest.license, 'MIT');
      assert.deepEqual(Object.keys(outcome.manifest.lspServers), ['typescript-ls', 'python-ls']);
      assert.ok(
        outcome.manifestPath.endsWith(join('.claude-plugin', 'plugin.json')),
        `manifestPath 应指向 .claude-plugin/plugin.json，实际：${outcome.manifestPath}`,
      );
    });

    await test('readManifest: 候选优先级 .zcode-plugin > 根 plugin.json > .claude-plugin', async () => {
      const all = join(tmpRoot, 'priority-all');
      await writeJsonAt(join(all, '.zcode-plugin', 'plugin.json'), { name: 'p-zcode' });
      await writeJsonAt(join(all, 'plugin.json'), { name: 'p-root' });
      await writeClaudeManifest(all, claudeManifest({ name: 'p-claude' }));
      const first = await readManifest(all);
      assert.equal(first.ok, true, outcomeMessage(first));
      assert.equal(first.format, 'zcode', `三份清单并存应取 zcode，实际：${first.format}`);
      assert.equal(first.manifest.name, 'p-zcode');

      const rootFirst = join(tmpRoot, 'priority-root');
      await writeJsonAt(join(rootFirst, 'plugin.json'), { name: 'p-root' });
      await writeClaudeManifest(rootFirst, claudeManifest({ name: 'p-claude' }));
      const second = await readManifest(rootFirst);
      assert.equal(second.ok, true, outcomeMessage(second));
      assert.equal(second.format, 'root', `根 plugin.json 与 .claude-plugin 并存应取 root，实际：${second.format}`);
      assert.equal(second.manifest.name, 'p-root');
    });

    await test('拒绝：.claude-plugin/plugin.json 是符号链接 → reason=invalid', async () => {
      const outside = join(tmpRoot, 'outside-claude-file');
      await writeClaudeManifest(outside, claudeManifest({ name: 'outside-claude' }));
      const root = join(tmpRoot, 'claude-symlink-file');
      await mkdir(join(root, '.claude-plugin'), { recursive: true });
      const linked = await tryCreateFileLink(
        join(outside, '.claude-plugin', 'plugin.json'),
        join(root, '.claude-plugin', 'plugin.json'),
      );
      if (!linked) return skip('当前环境无法创建文件符号链接');

      const outcome = await readManifest(root);
      assert.equal(outcome.ok, false, `符号链接清单不能被读取，${outcomeMessage(outcome)}`);
      assert.equal(outcome.reason, 'invalid', `reason 应为 invalid，实际：${outcome.reason}`);
    });

    await test('拒绝：.claude-plugin 目录是符号链接 → 不从根外读清单', async () => {
      const outside = join(tmpRoot, 'outside-claude-dir');
      await writeClaudeManifest(outside, claudeManifest({ name: 'outside-claude-dir' }));
      const root = join(tmpRoot, 'claude-symlink-dir');
      await mkdir(root, { recursive: true });
      const linked = await tryCreateDirLink(join(outside, '.claude-plugin'), join(root, '.claude-plugin'));
      if (!linked) return skip('当前环境无法创建目录符号链接/junction');

      const outcome = await readManifest(root);
      assert.equal(outcome.ok, false, `父目录链接指向的清单不能被读取，${outcomeMessage(outcome)}`);
      assert.equal(outcome.reason, 'invalid', `reason 应为 invalid，实际：${outcome.reason}`);
    });

    await test('拒绝：.claude-plugin 清单超过 1MiB → reason=invalid', async () => {
      const root = join(tmpRoot, 'claude-huge');
      await writeClaudeManifest(root, { name: 'claude-huge', description: 'x'.repeat(1024 * 1024 + 64) });
      const outcome = await readManifest(root);
      assert.equal(outcome.ok, false, '超大清单不应被读取');
      assert.equal(outcome.reason, 'invalid', `reason 应为 invalid，实际：${outcome.reason}`);
      assert.match(outcome.message, /过大|MiB|1MiB/, `错误信息应说明体积上限，实际：${outcome.message}`);
    });

    await test('拒绝：.claude-plugin 清单非法 JSON → reason=invalid', async () => {
      const root = join(tmpRoot, 'claude-broken');
      await writeFileAt(join(root, '.claude-plugin', 'plugin.json'), '{ "name": ');
      const outcome = await readManifest(root);
      assert.equal(outcome.ok, false, '非法 JSON 不应被读取');
      assert.equal(outcome.reason, 'invalid', `reason 应为 invalid，实际：${outcome.reason}`);
    });

    // ----------------------------------------------------------
    // 用例 2：market source 形态与条目元数据
    // ----------------------------------------------------------
    const marketIndexPath = join(tmpRoot, 'market', 'marketplace.json');

    await test('resolveMarketSource: {source:url, url:…git} → git（不再当 archive）', async () => {
      const entry = { source: { source: 'url', url: 'https://github.com/anthropics/claude-plugins-official.git' } };
      assert.deepEqual(
        resolveMarketSource(entry, { indexPath: marketIndexPath }),
        { kind: 'git', url: 'https://github.com/anthropics/claude-plugins-official.git' },
        '.git 结尾的 url 源应解析成 git SourceSpec',
      );
    });

    await test('resolveMarketSource: git@ / git:// URL 同样落成 git', async () => {
      for (const url of ['git@github.com:anthropics/claude-plugins-official.git', 'git://example.com/acme/plugin.git']) {
        assert.deepEqual(
          resolveMarketSource({ source: { source: 'url', url } }, { indexPath: marketIndexPath }),
          { kind: 'git', url },
          `${url} 应解析成 git SourceSpec`,
        );
      }
    });

    await test('resolveMarketSource: 非 git 的 url 源仍是 archive（zip 下载不变）', async () => {
      const url = 'https://example.com/plugins/claude-plugin.zip';
      assert.deepEqual(
        resolveMarketSource({ source: { source: 'url', url } }, { indexPath: marketIndexPath }),
        { kind: 'archive', url },
      );
    });

    await test('resolveMarketSource: {source:pip} 抛 market-source-unsupported', async () => {
      let thrown = null;
      try {
        resolveMarketSource({ source: { source: 'pip', package: 'some-claude-plugin' } }, { indexPath: marketIndexPath });
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown, 'pip 源应抛错');
      assert.ok(isMarketError(thrown), `应是 MarketError，实际：${thrown}`);
      assert.equal(thrown.code, 'market-source-unsupported');
      assert.equal(JSON.parse(JSON.stringify(thrown)).code, 'market-source-unsupported');
    });

    const marketText = JSON.stringify({
      name: 'claude-market',
      owner: { name: 'Anthropic' },
      plugins: [
        {
          name: 'lsp-only',
          source: './plugins/lsp-only',
          lspServers: { 'ts-ls': { command: 'typescript-language-server', args: ['--stdio'] } },
        },
        {
          name: 'mixed',
          source: './plugins/mixed',
          description: '混合组件条目',
          componentTypes: ['skill', 'lsp', 'command', 'not-a-kind'],
          lspServers: { 'py-ls': { command: 'pylsp' } },
          author: { name: 'Acme Tooling', email: 'tools@example.com' },
          homepage: 'https://example.com/mixed',
          license: 'Apache-2.0',
        },
        { name: 'author-string', source: './plugins/author-string', author: 'Someone' },
      ],
    });

    await test('parseMarketIndex: 条目 lspServers → componentTypes 含 lsp 且与已有合并去重', async () => {
      const parsed = parseMarketIndex(marketText, { indexPath: marketIndexPath });
      assert.deepEqual(parsed.diagnostics, [], `干净索引不应有 diagnostics：${JSON.stringify(parsed.diagnostics)}`);

      const lspOnly = parsed.plugins.find((entry) => entry.name === 'lsp-only');
      assert.deepEqual(lspOnly.componentTypes, ['lsp'], '只有 lspServers 的条目也要产出 componentTypes=[lsp]');

      const mixed = parsed.plugins.find((entry) => entry.name === 'mixed');
      assert.ok(mixed.componentTypes.includes('lsp'), `componentTypes 应含 lsp，实际：${JSON.stringify(mixed.componentTypes)}`);
      assert.deepEqual(
        [...mixed.componentTypes].sort(),
        ['command', 'lsp', 'skill'],
        `已有 componentTypes 与 lsp 应合并去重，实际：${JSON.stringify(mixed.componentTypes)}`,
      );
      assert.equal(mixed.componentTypes.length, new Set(mixed.componentTypes).size, 'componentTypes 不能有重复项');
      assert.ok(!mixed.componentTypes.includes('not-a-kind'), '白名单外的类型不能透传');
      assertJsonRoundTrip(parsed, 'market index');
    });

    await test('parseMarketIndex: componentTypes 按 COMPONENT_TYPES 白名单顺序输出', async () => {
      // 白名单顺序取自 COMPONENT_TYPES：agent, command, skill, hook, mcp, lsp, ui。
      const text = JSON.stringify({
        plugins: [
          {
            name: 'ordered',
            source: './plugins/ordered',
            componentTypes: ['ui', 'skill', 'mcp', 'hook', 'agent', 'command'],
            lspServers: { 'ts-ls': { command: 'typescript-language-server' } },
          },
        ],
      });
      const parsed = parseMarketIndex(text, { indexPath: marketIndexPath });
      assert.deepEqual(
        parsed.plugins[0].componentTypes,
        ['agent', 'command', 'skill', 'hook', 'mcp', 'lsp', 'ui'],
        `应按白名单顺序输出，实际：${JSON.stringify(parsed.plugins[0].componentTypes)}`,
      );
    });

    await test('parseMarketIndex: author 对象/字符串归一，homepage/license 透传且有体积上限', async () => {
      const parsed = parseMarketIndex(marketText, { indexPath: marketIndexPath });
      const mixed = parsed.plugins.find((entry) => entry.name === 'mixed');
      assert.equal(mixed.author, 'Acme Tooling', 'author 对象应归一成 name 字符串');
      assert.equal(mixed.homepage, 'https://example.com/mixed');
      assert.equal(mixed.license, 'Apache-2.0');

      const authorString = parsed.plugins.find((entry) => entry.name === 'author-string');
      assert.equal(authorString.author, 'Someone', 'author 字符串应原样透传');

      const huge = 'h'.repeat(10000);
      const oversized = parseMarketIndex(
        JSON.stringify({
          plugins: [{ name: 'oversized', source: './plugins/oversized', homepage: `https://example.com/${huge}`, license: huge }],
        }),
        { indexPath: marketIndexPath },
      ).plugins[0];
      assert.ok(
        oversized.homepage === undefined || oversized.homepage.length < 10000,
        `超长 homepage 应被截断或丢弃，实际长度：${oversized.homepage?.length}`,
      );
      assert.ok(
        oversized.license === undefined || oversized.license.length < 10000,
        `超长 license 应被截断或丢弃，实际长度：${oversized.license?.length}`,
      );
    });

    // ----------------------------------------------------------
    // 用例 3：components.lsp
    // ----------------------------------------------------------
    await test('enumerateComponents: manifest.lspServers 键名 → components.lsp', async () => {
      const outcome = await readManifest(claudeRoot);
      assert.equal(outcome.ok, true, outcomeMessage(outcome));
      const components = await enumerateComponents(claudeRoot, outcome.manifest, {
        manifestPath: outcome.manifestPath,
      });
      assert.ok(Array.isArray(components.lsp), `components.lsp 必须是数组，实际：${typeof components.lsp}`);
      assert.deepEqual(lspNamesOf(components.lsp), ['typescript-ls', 'python-ls'], 'LSP 组件名应等于 lspServers 键名');
      assertJsonRoundTrip(components, 'claude components');
    });

    await test('enumerateComponents: 无 lspServers 时 components.lsp 为空数组且无 lsp 分组', async () => {
      const root = join(tmpRoot, 'claude-no-lsp');
      await makeClaudePlugin(root, { manifest: { lspServers: undefined } });
      const outcome = await readManifest(root);
      assert.equal(outcome.ok, true, outcomeMessage(outcome));
      const components = await enumerateComponents(root, outcome.manifest, { manifestPath: outcome.manifestPath });
      assert.deepEqual(components.lsp, []);
      assert.ok(!components.groups.some((group) => group.kind === 'lsp'), '无 LSP 组件时不应出现 lsp 分组');
    });

    await test('enumerateComponents: lsp 进 groups 且排在 mcp 之后', async () => {
      const outcome = await readManifest(claudeRoot);
      const components = await enumerateComponents(claudeRoot, outcome.manifest, {
        manifestPath: outcome.manifestPath,
      });
      assert.deepEqual(
        components.groups.map((group) => group.kind),
        ['agent', 'command', 'skill', 'hook', 'mcp', 'lsp'],
        '分组顺序应是 agent → command → skill → hook → mcp → lsp',
      );
      const lspGroup = components.groups.find((group) => group.kind === 'lsp');
      assert.deepEqual(namesOf(lspGroup.items), ['typescript-ls', 'python-ls']);
    });

    // ----------------------------------------------------------
    // 用例 4：端到端
    // ----------------------------------------------------------
    await test('端到端: Claude fixture 清单解析（format=claude + 展示字段）', async () => {
      const outcome = await readManifest(claudeRoot);
      assert.equal(outcome.ok, true, outcomeMessage(outcome));
      assert.equal(outcome.format, 'claude');
      assert.equal(outcome.manifest.name, CLAUDE_FIXTURE_NAME);
      assert.equal(outcome.manifest.description, 'Claude 插件格式 fixture：skills / commands / agents / hooks / MCP / LSP 全量。');
    });

    let e2eComponents = null;

    await test('端到端: 四类组件数量与名字（skills / commands / agents / hooks）', async () => {
      const outcome = await readManifest(claudeRoot);
      e2eComponents = await enumerateComponents(claudeRoot, outcome.manifest, {
        manifestPath: outcome.manifestPath,
      });

      assert.equal(e2eComponents.skills.length, 2, `skills 数量，实际：${namesOf(e2eComponents.skills)}`);
      assert.deepEqual(namesOf(e2eComponents.skills), ['echo', 'summarize']);
      assert.equal(e2eComponents.commands.length, 2, `commands 数量，实际：${namesOf(e2eComponents.commands)}`);
      assert.deepEqual(namesOf(e2eComponents.commands), ['greet', 'review'], '无 name 的 command 应回退文件名');
      assert.equal(e2eComponents.agents.length, 1, `agents 数量，实际：${namesOf(e2eComponents.agents)}`);
      assert.deepEqual(namesOf(e2eComponents.agents), ['reviewer']);
      assert.deepEqual(
        e2eComponents.hooks.map((hook) => hook.event),
        ['PreToolUse', 'PostToolUse', 'Stop'],
        'hook 事件顺序应保持 hooks.json 的声明顺序',
      );
    });

    await test('端到端: hooks 事件归一（matcher / timeout 秒→毫秒 / 扁平写法）', async () => {
      if (!e2eComponents) {
        const outcome = await readManifest(claudeRoot);
        e2eComponents = await enumerateComponents(claudeRoot, outcome.manifest, {
          manifestPath: outcome.manifestPath,
        });
      }
      const pre = e2eComponents.hooks.find((hook) => hook.event === 'PreToolUse');
      assert.equal(pre.matcher, 'Bash');
      assert.equal(pre.command, 'node hooks/guard.mjs');
      assert.equal(pre.timeoutMs, 12000, 'Claude 的 timeout 单位是秒，应归一成毫秒');

      const post = e2eComponents.hooks.find((hook) => hook.event === 'PostToolUse');
      assert.equal(post.command, 'node hooks/audit.mjs');
      assert.equal('matcher' in post, false, '没有 matcher 时不应留 undefined 键');

      const stop = e2eComponents.hooks.find((hook) => hook.event === 'Stop');
      assert.equal(stop.command, 'node hooks/stop.mjs', '扁平写法 { command } 也要被识别');
    });

    await test('端到端: .mcp.json 的 MCP server 名与 LSP 组件名', async () => {
      if (!e2eComponents) {
        const outcome = await readManifest(claudeRoot);
        e2eComponents = await enumerateComponents(claudeRoot, outcome.manifest, {
          manifestPath: outcome.manifestPath,
        });
      }
      assert.deepEqual(Object.keys(e2eComponents.mcpServers), ['fixture-claude']);
      assert.equal(e2eComponents.mcpServers['fixture-claude'].command, 'node');
      assert.deepEqual(
        e2eComponents.mcpServers['fixture-claude'].args,
        ['${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs'],
        '${...} 变量只做形状校验，不应被展开',
      );
      assert.deepEqual(lspNamesOf(e2eComponents.lsp), ['typescript-ls', 'python-ls']);
    });

    await test('端到端: 干净 fixture 无 diagnostics，且枚举结果可无损 JSON 往返', async () => {
      if (!e2eComponents) {
        const outcome = await readManifest(claudeRoot);
        e2eComponents = await enumerateComponents(claudeRoot, outcome.manifest, {
          manifestPath: outcome.manifestPath,
        });
      }
      assert.deepEqual(e2eComponents.diagnostics, [], `干净 fixture 不应有 diagnostics：${JSON.stringify(e2eComponents.diagnostics)}`);
      assertJsonRoundTrip(e2eComponents, 'claude e2e components');
    });
  } finally {
    // 无论成败都清理：fixture 只属于本次运行的临时目录。
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }

  // ----------------------------------------------------------
  // 汇总
  // ----------------------------------------------------------
  const total = results.passed + results.failed + results.skipped;
  const elapsed = Date.now() - startedAt;
  console.log('-'.repeat(72));
  console.log(`${total} cases: ${results.passed} passed, ${results.skipped} skipped, ${results.failed} failed (${elapsed}ms)`);

  if (results.failed > 0) {
    for (const failure of failures) {
      console.log(`\n--- ${failure.name} ---\n${failure.error instanceof Error ? failure.error.stack : failure.error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('ALL PASS');
}

main().catch((error) => {
  console.error('[claude-smoke] 未捕获异常：', error);
  process.exitCode = 1;
});
