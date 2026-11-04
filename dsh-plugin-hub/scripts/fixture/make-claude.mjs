/**
 * 生成 Claude 插件格式（`.claude-plugin/plugin.json`）的 fixture 插件。
 *
 * 与 ZCode fixture（make.mjs）分开维护：Claude 插件的清单位置、组件声明字段与
 * marketplace 语义都不一样，混在一个生成器里会让两边的断言互相牵连。
 *
 * 覆盖 V1 需要的 Claude 组件面：
 *  - skills/<name>/SKILL.md（frontmatter：name / description / allowed-tools）
 *  - commands/*.md（含「无 name 时回退文件名」的 Claude 常见写法）
 *  - agents/*.md
 *  - hooks/hooks.json（Claude 的顶层事件表：matcher 容器 / 扁平写法 / timeout 秒）
 *  - 根 .mcp.json（${CLAUDE_PLUGIN_ROOT} 变量只做形状校验，不展开）
 *  - manifest.lspServers（对象，键名即 LSP 组件名）
 *
 * 只写盘、不读盘、不联网；目标目录由调用方决定（冒烟里是系统临时目录下的唯一子目录）。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** fixture 插件名（同时用于清单 name 与测试断言）。 */
export const CLAUDE_FIXTURE_NAME = 'claude-fixture';

/** 默认清单内容；对象形式便于用例按需覆盖字段（传 `undefined` 等于删掉该字段）。 */
export function claudeManifest(overrides = {}) {
  return {
    name: CLAUDE_FIXTURE_NAME,
    version: '1.4.0',
    description: 'Claude 插件格式 fixture：skills / commands / agents / hooks / MCP / LSP 全量。',
    author: { name: 'plugin-hub tests', email: 'tests@example.com' },
    homepage: 'https://example.com/claude-fixture',
    license: 'MIT',
    // Claude 仓库里 LSP 常写在清单的 lspServers（对象：键名即组件名，值交给运行期）。
    lspServers: {
      'typescript-ls': {
        command: 'typescript-language-server',
        args: ['--stdio'],
        extensionToLanguage: { '.ts': 'typescript', '.tsx': 'typescriptreact' },
      },
      'python-ls': {
        command: 'pylsp',
        args: [],
        extensionToLanguage: { '.py': 'python' },
      },
    },
    ...overrides,
  };
}

/** 递归建目录后写文本文件。 */
async function writeFileAt(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

/** 写 JSON（带结尾换行，和仓库里的清单风格一致）。 */
async function writeJsonAt(filePath, value) {
  return writeFileAt(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * 只写 `.claude-plugin/plugin.json`（清单候选 / 拒绝用例需要的极简 fixture）。
 *
 * @param {string} root 插件根目录（会被创建）
 * @param {object} [manifest] 完整清单对象；缺省用 claudeManifest()
 * @returns {Promise<string>} 清单文件路径
 */
export async function writeClaudeManifest(root, manifest = claudeManifest()) {
  return writeJsonAt(join(root, '.claude-plugin', 'plugin.json'), manifest);
}

/**
 * 在 `root` 下写出完整的 Claude fixture 插件。
 *
 * @param {string} root 目标目录（会被创建）
 * @param {{ manifest?: object }} [options] manifest 覆盖项（与 claudeManifest() 合并）
 * @returns {Promise<string>} 插件根路径
 */
export async function makeClaudePlugin(root, options = {}) {
  const manifest = claudeManifest(options.manifest ?? {});
  await writeClaudeManifest(root, manifest);

  // skills：Claude 的 SKILL.md frontmatter 与 ZCode 同形；allowed-tools 属 Claude 扩展字段，
  // 解析器不认识就忽略，正好验证「未知字段不破坏组件枚举」。
  await writeFileAt(
    join(root, 'skills', 'echo', 'SKILL.md'),
    [
      '---',
      'name: echo',
      'description: Repeat the provided text back to the user.',
      'allowed-tools: Read',
      '---',
      '',
      '# Echo',
      '',
      'Say the text back once.',
      '',
    ].join('\n'),
  );
  await writeFileAt(
    join(root, 'skills', 'summarize', 'SKILL.md'),
    [
      '---',
      'name: summarize',
      'description: Summarize a long passage into three bullets.',
      'when_to_use: When the user pastes more than three paragraphs.',
      '---',
      '',
      '# Summarize',
      '',
      'Return three bullets.',
      '',
    ].join('\n'),
  );

  // commands：第二个故意不写 name，走 Claude 的「文件名即命令名」回退。
  await writeFileAt(
    join(root, 'commands', 'greet.md'),
    [
      '---',
      'name: greet',
      'description: Greet someone by name.',
      'argument-hint: <name>',
      '---',
      '',
      'Say hello to $ARGUMENTS in a friendly tone.',
      '',
    ].join('\n'),
  );
  await writeFileAt(
    join(root, 'commands', 'review.md'),
    ['---', 'description: Review the current diff for correctness.', '---', '', 'Review the diff.', ''].join('\n'),
  );

  await writeFileAt(
    join(root, 'agents', 'reviewer.md'),
    ['---', 'name: reviewer', 'description: Reviews changes for correctness.', 'model: sonnet', '---', '', 'Review the current diff.', ''].join('\n'),
  );

  // hooks：Claude 的 hooks/hooks.json 是顶层事件表。三种形态各一条：
  // matcher 容器（timeout 秒）、无 matcher 的容器、扁平写法。
  await writeJsonAt(join(root, 'hooks', 'hooks.json'), {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: 'node hooks/guard.mjs', timeout: 12 }],
      },
    ],
    PostToolUse: [{ hooks: [{ type: 'command', command: 'node hooks/audit.mjs' }] }],
    Stop: [{ command: 'node hooks/stop.mjs' }],
  });

  // MCP：Claude 插件把服务器写在根 .mcp.json，变量只做形状校验。
  await writeJsonAt(join(root, '.mcp.json'), {
    mcpServers: {
      'fixture-claude': {
        type: 'stdio',
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs'],
        env: { FIXTURE_LABEL: 'claude' },
      },
    },
  });

  return root;
}
