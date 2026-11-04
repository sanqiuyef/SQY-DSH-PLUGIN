#!/usr/bin/env node
/**
 * 重新生成 index.json（DSH format-1 插件市场索引）。
 *
 * 用法：node scripts/build-index.mjs
 * 从各插件目录的 package.json 读取 name/version/engines，把版本来源固定到当前 HEAD 提交。
 * 修改插件（版本号/代码）并提交后运行本脚本，再提交 index.json 即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REMOTE = 'https://github.com/sanqiuyef/SQY-DSH-PLUGIN';

const commit = cp.execSync('git rev-parse HEAD', { cwd: REPO, encoding: 'utf8' }).trim();
const commitTime = Number(cp.execSync('git show -s --format=%ct HEAD', { cwd: REPO, encoding: 'utf8' }).trim());
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`bad commit ${commit}`);

const META = {
  'dsh-mcp-manager': {
    title: { zh: 'MCP 服务器管理', en: 'MCP Server Manager' },
    description: {
      zh: '在设置页管理 MCP 服务器：清单、启停、编辑、新增/删除（含手写行）、连接健康度、就地重连、探测阶段归因与导入导出。',
      en: 'Manage MCP servers from Settings: list, enable/disable, edit, add/remove (including hand-written rows), connection health, in-place reconnect, probe diagnostics and import/export.',
    },
    category: 'mcp',
    keywords: ['mcp', 'settings', 'gateway', 'probe', 'health'],
  },
  'dsh-memory-manager': {
    title: { zh: '记忆管理', en: 'Memory Manager' },
    description: {
      zh: '全局与项目级记忆：memory_* 工具、system prompt 摘要注入（时间倒序 + 近期带）、写去重提示、别名并条、写入脱敏与运行审计。',
      en: 'Global and project-scoped memory: memory_* tools, system-prompt digest (newest-first + recency band), write de-duplication hints, aliases, write redaction and run audit.',
    },
    category: 'memory',
    keywords: ['memory', 'project-memory', 'global-memory', 'redaction', 'digest'],
  },
  'dsh-mcp-gateway': {
    title: { zh: 'MCP 工具网关', en: 'MCP Tool Gateway' },
    description: {
      zh: 'MCP 工具渐进披露：mcp_catalog / mcp_search / mcp_describe 三个元工具，支持裸名与拼名解析、批量描述、参数名检索与 select: 精确取用；不隐藏原有工具。',
      en: 'Progressive disclosure for MCP tools: mcp_catalog / mcp_search / mcp_describe meta-tools with bare and qualified name resolution, batch describe, parameter-name search and select: exact fetch; no existing tool is hidden.',
    },
    category: 'mcp',
    keywords: ['mcp', 'tool-search', 'progressive-disclosure', 'token-saving'],
  },
  'dsh-skill-manager': {
    title: { zh: '技能管理', en: 'Skill Manager' },
    description: {
      zh: '设置页技能管理：根扫描、_disabled 启停、三态调用策略（软禁用）、批量操作、调用账本、本地技能包导入、安装来源账本与插件同名提示。',
      en: 'Skill management in Settings: root scan, _disabled toggling, three-state invocation policy (soft disable), batch operations, usage ledger, local skill import, install provenance and plugin-duplicate hints.',
    },
    category: 'skills',
    keywords: ['skills', 'skill-manager', 'settings', 'import'],
  },
  'dsh-plugin-hub': {
    title: { zh: '插件中心', en: 'Plugin Hub' },
    description: {
      zh: '插件市场与插件管理双标签：安装 ZCode 格式插件包并把 skills / commands / hooks / MCP 按 Agent 投影进会话；版本历史与回滚、故障诊断、项目信任门、MCP 重名冲突让位。',
      en: 'Plugin market and manager in one panel: install ZCode-format plugin bundles and project their skills / commands / hooks / MCP into sessions; version history and rollback, diagnostics, project trust gate and MCP name-conflict yielding.',
    },
    category: 'market',
    keywords: ['plugins', 'marketplace', 'zcode-plugins', 'projection'],
  },
  'dsh-tool-search-mode': {
    title: { zh: '工具搜索', en: 'Tool Search' },
    description: {
      zh: 'ZCode 式工具搜索：自动/本地/关闭三模式，把模型可见工具目录收缩为核心工具 + 延迟目录清单，其余工具经 tool_search 按需加载、tool_call 同轮执行；模式按会话快照生效。',
      en: 'ZCode-style tool search: auto/local/off modes that shrink the model-visible catalog to core tools plus a deferred manifest; other tools load on demand through tool_search and run in the same turn via tool_call. The mode is captured per session.',
    },
    category: 'mcp',
    keywords: ['tool-search', 'context', 'token-saving', 'progressive-disclosure', 'settings'],
  },
};

const ICON_OWNERS = new Set(['dsh-skill-manager', 'dsh-plugin-hub']);

const plugins = [];
for (const [dir, meta] of Object.entries(META)) {
  const pj = JSON.parse(fs.readFileSync(path.join(REPO, dir, 'package.json'), 'utf8'));
  const engine = pj.engines?.dsh;
  if (!engine) throw new Error(`${dir} has no engines.dsh`);
  plugins.push({
    name: pj.name,
    title: meta.title,
    description: meta.description,
    ...(ICON_OWNERS.has(dir) ? { icon: `${dir}/icon.svg` } : {}),
    author: 'sanqiuyef',
    homepage: REMOTE,
    repository: { url: REMOTE, directory: dir },
    metadata: { category: meta.category, keywords: meta.keywords },
    'dist-tags': { latest: pj.version },
    versions: [
      {
        version: pj.version,
        publishTimestamp: commitTime,
        source: { type: 'git', url: REMOTE, commit, path: dir },
        engines: { dsh: engine },
      },
    ],
  });
}

const index = {
  format: 1,
  title: { zh: 'SQY DSH 插件集', en: 'SQY DSH Plugins' },
  description: {
    zh: 'sanqiuyef 自研的 DeepSeek Harness 插件集合（MCP 管理 / 记忆 / 工具网关 / 技能管理 / 插件中心 / 工具搜索）。',
    en: 'A collection of DeepSeek Harness plugins by sanqiuyef (MCP manager, memory, tool gateway, skill manager, plugin hub, tool search).',
  },
  metadata: {
    categories: {
      mcp: { title: { zh: 'MCP 与工具', en: 'MCP & Tools' } },
      memory: { title: { zh: '记忆', en: 'Memory' } },
      skills: { title: { zh: '技能', en: 'Skills' } },
      market: { title: { zh: '插件生态', en: 'Plugin Ecosystem' } },
    },
  },
  plugins,
};

// —— 按 DSH 读取器规则自检 ——
const errors = [];
const okName = /^[a-z0-9][a-z0-9._-]*$/;
const okSemver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const seen = new Set();
for (const [i, p] of plugins.entries()) {
  const at = `plugins[${i}]`;
  if (!okName.test(p.name)) errors.push(`${at}.name invalid`);
  if (seen.has(p.name)) errors.push(`${at}.name duplicated`);
  seen.add(p.name);
  if (!Array.isArray(p.versions) || p.versions.length === 0) errors.push(`${at}.versions empty`);
  if (!p.metadata || !index.metadata.categories[p.metadata.category]) errors.push(`${at}.metadata.category undeclared`);
  for (const [j, v] of p.versions.entries()) {
    if (!okSemver.test(v.version)) errors.push(`${at}.versions[${j}].version not semver`);
    if (!Number.isInteger(v.publishTimestamp) || v.publishTimestamp < 0) errors.push(`${at}.versions[${j}].publishTimestamp`);
    const s = v.source;
    if (s.type !== 'git' && s.type !== 'npm') errors.push(`${at}.versions[${j}].source.type`);
    if (s.type === 'git') {
      if (!s.url.startsWith('https://') || s.url.length < 12) errors.push(`${at}.versions[${j}].source.url`);
      if (s.url.endsWith('.tgz') || s.url.endsWith('.tar.gz')) errors.push(`${at}.versions[${j}].source.url suffix`);
      if (!/^[0-9a-f]{40}$/.test(s.commit)) errors.push(`${at}.versions[${j}].source.commit`);
      if (s.path !== undefined && !/^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/.test(s.path)) errors.push(`${at}.versions[${j}].source.path`);
    }
    if (!v.engines || typeof v.engines.dsh !== 'string' || !v.engines.dsh.trim()) errors.push(`${at}.versions[${j}].engines.dsh`);
  }
  const tag = p['dist-tags']?.latest;
  if (!tag || !p.versions.some((v) => v.version === tag)) errors.push(`${at}.dist-tags.latest target`);
}
if (errors.length) {
  console.error('INVALID:\n' + errors.join('\n'));
  process.exit(1);
}

fs.writeFileSync(path.join(REPO, 'index.json'), JSON.stringify(index, null, 2) + '\n');
console.log(`index.json written | commit=${commit} | plugins=${plugins.map((p) => `${p.name}@${p['dist-tags'].latest}`).join(', ')}`);
