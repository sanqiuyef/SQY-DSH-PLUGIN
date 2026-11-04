#!/usr/bin/env node
/**
 * dsh-mcp-manager — real probe runtime check (offline, no host).
 *
 * `scripts/smoke.mjs` drives the probe's wire protocol through a fake sink; this
 * file drives the whole `probeStdio` / `probeHttp` path against real processes and
 * a real HTTP server, because the interesting part is exactly the part a fake
 * cannot show: which stage a failure is attributed to.
 *
 * It supplies a minimal Node adapter for the one service the probe uses
 * (`ctx.subprocess.spawn`, shaped like `dsh-subprocess`'s handle) and asserts:
 *
 *   - a working stdio server (the repo's own fixture) succeeds with `stage: 'ok'`
 *     and its tool schema facts;
 *   - a command that does not exist is `spawn`, not a handshake failure;
 *   - a process that starts but never answers is `initialize`;
 *   - a missing command/url is `config`;
 *   - an HTTP 500 is `initialize`, an unreachable URL is `spawn`;
 *   - an HTTP `tools/list` keeps required/enum in `inputSchema`.
 *
 * Run:  node scripts/probe-runtime.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { probeHttp, probeStdio } = await import(pathToFileURL(join(here, '..', 'lib', 'probe.js')).href);

let failures = 0;
const check = (label, condition, detail = '') => {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

/** The subset of `ctx.subprocess` that `probeStdio` uses. */
function subprocessAdapter() {
  return {
    spawn({ argv, cwd, env, signal }) {
      const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], signal });
      // The host rejects `done` for a launch failure (ENOENT/EACCES); model that so
      // the stage correction is exercised, not bypassed.
      const done = new Promise((resolve, reject) => {
        child.once('exit', (code, sig) => resolve({ code, signal: sig }));
        child.once('error', (error) => reject(error));
      });
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        done,
        terminate() {
          child.kill();
        },
        waitForExit() {
          return new Promise((resolve) => {
            if (child.exitCode !== null) return resolve();
            child.once('close', resolve);
            setTimeout(resolve, 2000);
          });
        },
      };
    },
  };
}

const ctx = { subprocess: subprocessAdapter() };
const fixture = join(here, 'fixture-mcp.mjs');

console.log('# dsh-mcp-manager probe runtime check');

/* ---------------------------------------------------------------- stdio ok */

const okProbe = await probeStdio(ctx, { command: process.execPath, args: [fixture], env: {} });
const okTool = okProbe.tools?.[0];
check(
  'a real stdio probe succeeds',
  okProbe.ok === true && okProbe.stage === 'ok',
  JSON.stringify({ ok: okProbe.ok, stage: okProbe.stage, error: okProbe.error }),
);
check(
  'the tool carries its schema facts',
  okTool?.name === 'ping' && okTool.schemaBytes > 0 && okTool.estimatedTokens > 0,
  JSON.stringify(okTool),
);
check('the schema body is passed through when small', okTool?.inputSchema?.type === 'object' && okTool.schemaTruncated === false);
check('a successful probe has no hint', okProbe.hint === null);

/* ------------------------------------------------------------- stdio spawn */

const missing = await probeStdio(ctx, { command: 'definitely-not-a-real-command-xyz', args: [], env: {} });
check(
  'a missing command is attributed to spawn',
  missing.ok === false && missing.stage === 'spawn',
  JSON.stringify({ stage: missing.stage, error: missing.error?.slice(0, 120) }),
);
check('the spawn hint mentions PATH', typeof missing.hint === 'string' && missing.hint.includes('PATH'));

/* -------------------------------------------------------------- stdio init */

const notMcp = await probeStdio(
  ctx,
  { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: {} },
  { timeoutMs: 1500 },
);
check(
  'a process that never answers is attributed to initialize',
  notMcp.ok === false && notMcp.stage === 'initialize',
  JSON.stringify({ stage: notMcp.stage, error: notMcp.error?.slice(0, 80) }),
);
check('the initialize hint mentions the handshake', typeof notMcp.hint === 'string' && notMcp.hint.includes('handshake'));

/* ------------------------------------------------------------------ config */

const noCommand = await probeStdio(ctx, { command: '', args: [], env: {} });
check('a missing command definition is a config-stage failure', noCommand.ok === false && noCommand.stage === 'config', JSON.stringify(noCommand));
check('the config hint names the missing field', noCommand.hint.includes('command'));

/* -------------------------------------------------------------------- http */

const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => {
    let message = {};
    try {
      message = JSON.parse(body || '{}');
    } catch {
      message = {};
    }
    if (request.url === '/broken') {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('nope');
      return;
    }
    if (request.url === '/silent') return; // accepts, never answers: the client times out
    const headers = { 'content-type': 'application/json' };
    if (message.method === 'initialize') headers['mcp-session-id'] = 'test-session';
    const payload =
      message.method === 'initialize'
        ? { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fixture', version: '1.0.0' } } }
        : message.method === 'tools/list'
          ? {
              jsonrpc: '2.0',
              id: message.id,
              result: {
                tools: [
                  {
                    name: 'lookup',
                    description: 'Look something up',
                    inputSchema: {
                      type: 'object',
                      properties: { id: { type: 'string', enum: ['a', 'b'], description: 'identifier' }, limit: { type: 'number', default: 5 } },
                      required: ['id'],
                    },
                  },
                ],
              },
            }
          : { jsonrpc: '2.0', id: message.id, result: {} };
    response.writeHead(200, headers);
    response.end(JSON.stringify(payload));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const httpOk = await probeHttp({ url: `http://127.0.0.1:${port}/mcp` });
check(
  'a real http probe succeeds',
  httpOk.ok === true && httpOk.stage === 'ok',
  JSON.stringify({ ok: httpOk.ok, stage: httpOk.stage, error: httpOk.error }),
);
check(
  'http tools keep required and enum',
  httpOk.tools?.[0]?.required?.[0] === 'id' && httpOk.tools[0].inputSchema?.properties?.id?.enum?.length === 2,
  JSON.stringify(httpOk.tools?.[0]),
);

const httpBroken = await probeHttp({ url: `http://127.0.0.1:${port}/broken` });
check('an HTTP error is attributed to initialize', httpBroken.ok === false && httpBroken.stage === 'initialize', JSON.stringify({ stage: httpBroken.stage, error: httpBroken.error }));

const httpSilent = await probeHttp({ url: `http://127.0.0.1:${port}/silent` }, { timeoutMs: 1200 });
check(
  'a server that accepts but never answers is initialize, not spawn',
  httpSilent.ok === false && httpSilent.stage === 'initialize' && httpSilent.error.includes('timed out'),
  JSON.stringify({ stage: httpSilent.stage, error: httpSilent.error }),
);

const httpDown = await probeHttp({ url: `http://127.0.0.1:${port + 1}/mcp` });
check('an unreachable URL is attributed to spawn', httpDown.ok === false && httpDown.stage === 'spawn', JSON.stringify({ stage: httpDown.stage }));

const httpNoUrl = await probeHttp({ url: '' });
check('a missing url is a config-stage failure', httpNoUrl.ok === false && httpNoUrl.stage === 'config');

server.close();

console.log('');
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
