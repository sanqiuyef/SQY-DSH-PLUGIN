/**
 * 生成一个 ZCode 格式的 fixture 插件（供冒烟与手工联调用）。
 *
 * 覆盖 V1 的全部组件：skill / command / agent / hook / MCP / ui.surfaces，
 * 外加一个"默认值 + 引用变量"的 userConfig，用来验证 `${user_config.KEY}` 展开。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 最小的 stdio MCP 服务器：initialize / tools/list / tools/call。 */
const MCP_SERVER = `import { createInterface } from 'node:readline';

const tools = [
  {
    name: 'echo',
    description: 'Repeat the given text.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  if (line.trim() === '') return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = request;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture-mcp', version: '1.0.0' },
    } });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools } });
    return;
  }
  if (method === 'tools/call') {
    const text = String(params?.arguments?.text ?? '');
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'echo:' + text }] } });
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown method ' + method } });
});
`;

export const FIXTURE_NAME = 'hub-fixture';

/**
 * 在 `root` 下写出 fixture 插件目录。
 *
 * @param {string} root 目标目录（会被创建）
 * @param {{ version?: string }} [options] 版本号（默认 0.1.0；版本历史/回滚用例需要第二个版本）
 * @returns {Promise<string>} 插件根路径
 */
export async function makeFixturePlugin(root, options = {}) {
  const version = typeof options.version === 'string' && options.version !== '' ? options.version : '0.1.0';
  await mkdir(join(root, '.zcode-plugin'), { recursive: true });
  await mkdir(join(root, 'skills', 'echo'), { recursive: true });
  await mkdir(join(root, 'skills', 'summarize'), { recursive: true });
  await mkdir(join(root, 'commands'), { recursive: true });
  await mkdir(join(root, 'agents'), { recursive: true });
  await mkdir(join(root, 'hooks'), { recursive: true });
  await mkdir(join(root, 'mcp'), { recursive: true });

  await writeFile(
    join(root, '.zcode-plugin', 'plugin.json'),
    `${JSON.stringify(
      {
        name: FIXTURE_NAME,
        version,
        description: 'Fixture plugin covering every component kind.',
        author: { name: 'plugin-hub fixture' },
        license: 'MIT',
        skills: 'skills',
        commands: 'commands',
        agents: 'agents',
        hooks: './hooks/hooks.json',
        mcpServers: {
          fixture: {
            type: 'stdio',
            command: 'node',
            args: ['${ZCODE_PLUGIN_ROOT}/mcp/server.mjs'],
            cwd: '${ZCODE_PROJECT_DIR}',
            env: { FIXTURE_LABEL: '${user_config.label}' },
          },
        },
        userConfig: {
          label: {
            type: 'string',
            default: 'default-label',
            title: 'Fixture label',
            description: 'Used by the fixture MCP server environment.',
          },
        },
        ui: {
          surfaces: [
            {
              id: 'fixture-panel',
              title: { 'zh-CN': '夹具面板', 'en-US': 'Fixture panel' },
              server: 'fixture',
              resourceUri: 'ui://fixture/panel.html',
              availability: 'session',
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  await writeFile(
    join(root, 'skills', 'echo', 'SKILL.md'),
    '---\nname: echo\ndescription: Repeat the provided text back to the user.\n---\n\n# Echo\n\nSay the text back once.\n',
    'utf8',
  );
  await writeFile(
    join(root, 'skills', 'summarize', 'SKILL.md'),
    '---\nname: summarize\ndescription: Summarize a long passage.\nwhenToUse: When the user pastes more than three paragraphs.\n---\n\n# Summarize\n\nReturn three bullets.\n',
    'utf8',
  );
  await writeFile(
    join(root, 'commands', 'greet.md'),
    '---\nname: greet\ndescription: Greet someone by name.\nargument-hint: <name>\n---\n\nSay hello to $ARGUMENTS in a friendly tone.\n',
    'utf8',
  );
  await writeFile(
    join(root, 'agents', 'reviewer.md'),
    '---\nname: reviewer\ndescription: Reviews changes for correctness.\n---\n\nReview the current diff.\n',
    'utf8',
  );
  await writeFile(
    join(root, 'hooks', 'hooks.json'),
    `${JSON.stringify(
      {
        PreToolUse: [
          {
            matcher: 'bash',
            hooks: [{ type: 'command', command: 'node -e "process.exit(0)"', timeout: 5 }],
          },
        ],
        PostToolUse: [{ hooks: [{ type: 'command', command: 'node -e "process.exit(0)"' }] }],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(join(root, 'mcp', 'server.mjs'), MCP_SERVER, 'utf8');

  return root;
}
