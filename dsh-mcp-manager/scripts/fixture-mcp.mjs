#!/usr/bin/env node
/**
 * Minimal stdio MCP server used by the project-scope smoke test.
 *
 * Speaks just enough of the protocol for `@deepseek-ai/dsh-mcp-client` to connect
 * and discover one tool (`ping`), so a test can prove that a project-scope server
 * mounted on an Agent's context really contributes `mcp__<name>__ping`.
 *
 * Not shipped in the plugin tarball.
 */

import { createInterface } from 'node:readline';

const tools = [
  {
    name: 'ping',
    description: 'Return the word pong.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  const text = line.trim();
  if (text === '') return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'mcp-manager-project-fixture', version: '1.0.0' },
    });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') {
    reply(id, { tools });
    return;
  }
  if (method === 'tools/call') {
    reply(id, { content: [{ type: 'text', text: 'pong' }] });
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } });
  }
});
