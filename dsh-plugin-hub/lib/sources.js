/**
 * dsh-plugin-hub — 来源物化（SPEC §4 sources.js）。
 *
 * 职责：
 *  - materialize({ source, destDir, log, signal, ctx })：把 SourceSpec 变成 cache 里的真实目录，
 *    返回 `{ rootPath, sha256 }`；失败抛 SourceError（code ∈ source-unreachable / source-invalid / source-empty）。
 *  - downloadTo(url, filePath, { signal })：http(s) 流式下载，file: 走本地复制（市场里"本地 zip"用它）。
 *  - sha256Dir(rootPath)：稳定目录指纹。契约禁止本模块 import util.js（该文件归 Lead），
 *    所以这里保留一份**逐行同算法**的实现：跳过 .git/node_modules，路径排序，
 *    文件记 `F\0rel\0` + 内容 + `\0`，目录记 `D\0rel\0`，链接只记 `L\0rel\0` 不跟随。
 *    Lead 的 util.sha256Dir 与本函数对同一棵树必须得到同一摘要。
 *  - isArchivePath(path)：按扩展名判断归档（market.js 用它区分 directory / archive）。
 *
 * 安全口径：源目录复制、git 克隆、tar 解压产出的树里出现符号链接/junction 一律判
 * `source-invalid` 而不是跳过——静默跳过会让插件少文件却"看起来装成功"，而跟随链接
 * 会把根外内容带进 cache。
 *
 * 子进程：优先用注入执行器 `ctx.subprocess.spawn(cmd, args, opts)`（宿主可统一 sandbox/审计），
 * 否则回退 node:child_process.spawn；参数始终数组形式，Windows 不拼 shell 字符串。
 */

import { spawn as spawnProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, parse as parsePath, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isRecord, resolveInside } from './manifest.js';

const GIT_TIMEOUT_MS = 120_000;
const ARCHIVE_TIMEOUT_MS = 180_000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_CHARS = 4000;
const MAX_COPY_DEPTH = 64;
const SKIP_COPY_ENTRIES = new Set(['.git']);

/** 归档扩展名；`tar -xf`（Windows 自带 bsdtar）能同时吃 zip/tar 系列。 */
const ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.tar.gz', '.tgz', '.tar.bz2', '.tbz2', '.tar.xz', '.txz'];

/** 物化失败的结构化错误：附带稳定 code，路由层可直接映射成 `{ error: { code, message } }`。 */
export class SourceError extends Error {
  /**
   * @param {'source-unreachable'|'source-invalid'|'source-empty'} code
   * @param {string} message
   * @param {string} [path]
   */
  constructor(code, message, path) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    if (typeof path === 'string' && path !== '') this.path = path;
  }

  /** 让错误在 JSON 响应里仍是结构化对象，而不是 `{}`。 */
  toJSON() {
    return this.path ? { code: this.code, message: this.message, path: this.path } : { code: this.code, message: this.message };
  }
}

/** 是否本模块抛出的结构化错误（路由层用它决定是否原样透传 code）。 */
export function isSourceError(error) {
  return error instanceof SourceError;
}

/** 扩展名判定是否归档；不 stat（market.resolveMarketSource 是纯函数，不能触碰文件系统）。 */
export function isArchivePath(filePath) {
  if (typeof filePath !== 'string') return false;
  const lower = filePath.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// ============================================================
// materialize
// ============================================================

/**
 * 把来源物化到 destDir（覆盖式、幂等），返回稳定指纹。
 *
 * 流程：先在 destDir 同级的临时工作目录里准备内容 → 校验非空 → 计算 sha256 →
 * 提交（删旧目标 + rename）。任一步失败都只留下垃圾临时目录，不会出现"半装好的目标目录"。
 *
 * @param {{source: object, destDir: string, log?: Function, signal?: AbortSignal, ctx?: object}} options
 * @returns {Promise<{rootPath: string, sha256: string}>}
 */
export async function materialize(options = {}) {
  const { source, destDir, log, signal, ctx } = options ?? {};
  throwIfAborted(signal);

  if (!isRecord(source)) throw new SourceError('source-invalid', 'source 必须是 SourceSpec 对象');
  const destText = typeof destDir === 'string' ? destDir.trim() : '';
  if (destText === '') throw new SourceError('source-invalid', 'destDir 不能为空');

  const absoluteDest = resolve(destText);
  await assertSafeDest(absoluteDest);
  await mkdir(dirname(absoluteDest), { recursive: true });

  // 工作目录放在目标同级：同卷 rename 才是原子且不跨盘拷贝。
  const workDir = await mkdtemp(join(dirname(absoluteDest), '.materialize-'));
  try {
    const contentRoot = await prepareSource(source, workDir, { log, signal, ctx });
    throwIfAborted(signal);

    // 解压/克隆可能带出符号链接：提交前统一拒绝，避免 cache 里出现指向根外的链接。
    await assertNoSymlinks(contentRoot);

    const stats = await hashDirectory(contentRoot);
    if (stats.fileCount === 0) {
      throw new SourceError('source-empty', `来源没有产生任何文件：${labelOf(source)}`, contentRoot);
    }

    await commitContent(contentRoot, absoluteDest);
    return { rootPath: absoluteDest, sha256: stats.sha256 };
  } finally {
    // 失败时清掉工作目录；成功时 contentRoot 已被 rename 走，剩下的只是空壳。
    // 目标目录保持调用前状态（可能是上一次的旧版本）：原子替换只在 commitContent 里做。
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 按 kind 分发到具体物化器，返回"内容根"（可能位于 workDir 内部）。 */
async function prepareSource(source, workDir, context) {
  const kind = typeof source.kind === 'string' ? source.kind : '';
  switch (kind) {
    case 'directory':
      return prepareDirectory(source, workDir, context);
    case 'git':
      return prepareGit(source, workDir, context);
    case 'archive':
      return prepareArchive(source, workDir, context);
    case 'market':
      // market 源只是"归属标记"，真正来源必须由调用方先解析成 directory/git/archive。
      throw new SourceError('source-invalid', 'market 源需要先 resolveMarketSource 成具体来源再物化');
    default:
      throw new SourceError('source-invalid', `不支持的 SourceSpec.kind：${kind || '(缺失)'}`);
  }
}

/** directory：递归复制（拒符号链接），复制到 workDir/content。 */
async function prepareDirectory(source, workDir, { signal }) {
  const sourcePath = typeof source.path === 'string' ? source.path.trim() : '';
  if (sourcePath === '' || sourcePath.includes('\0')) {
    throw new SourceError('source-invalid', 'directory 源缺少合法的 path');
  }
  const absoluteSource = resolve(sourcePath);
  const info = await lstatOrNull(absoluteSource);
  if (info === null) {
    throw new SourceError('source-unreachable', `来源目录不存在：${absoluteSource}`, absoluteSource);
  }
  if (info.isSymbolicLink()) {
    throw new SourceError('source-invalid', `来源目录本身是符号链接，已拒绝：${absoluteSource}`, absoluteSource);
  }
  if (!info.isDirectory()) {
    throw new SourceError('source-invalid', `来源不是目录：${absoluteSource}`, absoluteSource);
  }

  const contentRoot = join(workDir, 'content');
  await copyDirectory(absoluteSource, contentRoot, { signal });
  return contentRoot;
}

/** git：`git clone --depth 1 [--branch ref] -- url dest`，可选只取仓库内 subdir。 */
async function prepareGit(source, workDir, { log, signal, ctx }) {
  const url = typeof source.url === 'string' ? source.url.trim() : '';
  if (url === '') throw new SourceError('source-invalid', 'git 源缺少 url');
  const ref = typeof source.ref === 'string' && source.ref.trim() !== '' ? source.ref.trim() : undefined;
  const subPath = typeof source.path === 'string' && source.path.trim() !== ''
    ? source.path.trim().replace(/^\.\/+/, '')
    : undefined;

  const contentRoot = join(workDir, 'content');
  const args = ['clone', '--depth', '1'];
  if (ref) args.push('--branch', ref);
  // `--` 终止选项解析：仓库 URL 以 - 开头（罕见）时不会被 git 当成旗标。
  args.push('--', url, contentRoot);

  await runProcess('git', args, { timeoutMs: GIT_TIMEOUT_MS, signal, log, ctx });

  const cloneDir = contentRoot;
  const entries = await readdirSafe(cloneDir);
  if (entries.length === 0) throw new SourceError('source-empty', `git 克隆结果为空：${url}`, cloneDir);

  if (!subPath) return cloneDir;

  const inner = resolveInside(cloneDir, subPath);
  if (!inner) throw new SourceError('source-invalid', `git 源 path 越出仓库：${subPath}`, cloneDir);
  const innerInfo = await lstatOrNull(inner);
  if (innerInfo === null || !innerInfo.isDirectory() || innerInfo.isSymbolicLink()) {
    throw new SourceError('source-invalid', `git 源 path 不是仓库内的真实目录：${subPath}`, inner);
  }
  return inner;
}

/** archive：下载 → 系统 tar 解压 → 取唯一顶层目录（多顶层即判 source-invalid）。 */
async function prepareArchive(source, workDir, { log, signal, ctx }) {
  const url = typeof source.url === 'string' ? source.url.trim() : '';
  if (url === '') throw new SourceError('source-invalid', 'archive 源缺少 url');

  const downloadPath = join(workDir, 'download.bin');
  await downloadTo(url, downloadPath, { signal });

  const extractDir = join(workDir, 'extract');
  await mkdir(extractDir, { recursive: true });
  // 用系统 tar（Windows 自带 libarchive bsdtar）而不是引入解压依赖：SPEC 要求零依赖。
  await runProcess('tar', ['-xf', downloadPath, '-C', extractDir], {
    timeoutMs: ARCHIVE_TIMEOUT_MS,
    signal,
    log,
    ctx,
  });

  const entries = (await readdirSafe(extractDir)).filter(
    (entry) => entry.name !== '__MACOSX' && entry.name !== '.DS_Store',
  );
  if (entries.length === 0) throw new SourceError('source-empty', `压缩包解压后为空：${url}`, extractDir);
  if (entries.length > 1) {
    throw new SourceError(
      'source-invalid',
      `压缩包含多个顶层条目（${entries.map((entry) => entry.name).join(', ')}），无法确定插件根：${url}`,
      extractDir,
    );
  }

  const top = join(extractDir, entries[0].name);
  const topInfo = await lstatOrNull(top);
  if (topInfo === null || topInfo.isSymbolicLink() || !topInfo.isDirectory()) {
    throw new SourceError('source-invalid', `压缩包顶层条目不是普通目录：${entries[0].name}`, top);
  }
  return top;
}

// ============================================================
// 目录复制 / 提交
// ============================================================

/** 递归复制目录；条目级 lstat 拒绝符号链接与特殊文件，跳过 `.git`（历史对插件运行没有意义）。 */
async function copyDirectory(from, to, { signal, depth = 0 } = {}) {
  throwIfAborted(signal);
  if (depth > MAX_COPY_DEPTH) throw new SourceError('source-invalid', `目录层级过深（>${MAX_COPY_DEPTH}）：${from}`, from);

  await mkdir(to, { recursive: true });
  let entries;
  try {
    entries = await readdir(from, { withFileTypes: true });
  } catch (error) {
    throw new SourceError('source-invalid', `来源目录读取失败：${messageOf(error)}`, from);
  }
  entries.sort(byName);

  for (const entry of entries) {
    throwIfAborted(signal);
    if (SKIP_COPY_ENTRIES.has(entry.name)) continue;
    const sourcePath = join(from, entry.name);
    const targetPath = join(to, entry.name);
    // 用 lstat 而不是 Dirent 判断：Dirent 在部分平台上对 junction 的类型判定不稳，
    // 而 lstat 对 symlink 与 junction 一律 isSymbolicLink() === true。
    const info = await lstatOrNull(sourcePath);
    if (info === null) continue;
    if (info.isSymbolicLink()) {
      throw new SourceError('source-invalid', `来源含符号链接，已拒绝复制：${sourcePath}`, sourcePath);
    }
    if (info.isDirectory()) {
      await copyDirectory(sourcePath, targetPath, { signal, depth: depth + 1 });
      continue;
    }
    if (!info.isFile()) {
      throw new SourceError('source-invalid', `来源含不支持的文件类型（设备/管道）：${sourcePath}`, sourcePath);
    }
    try {
      await copyFile(sourcePath, targetPath);
    } catch (error) {
      throw new SourceError('source-invalid', `文件复制失败：${messageOf(error)}`, sourcePath);
    }
  }
}

/** 提交：删旧目标再 rename；跨卷（EXDEV）时退化为复制。 */
async function commitContent(contentRoot, absoluteDest) {
  await rm(absoluteDest, { recursive: true, force: true });
  try {
    await rename(contentRoot, absoluteDest);
    return;
  } catch (error) {
    if (error?.code !== 'EXDEV') {
      throw new SourceError('source-invalid', `写入目标目录失败：${messageOf(error)}`, absoluteDest);
    }
  }
  await copyDirectory(contentRoot, absoluteDest, {});
}

/**
 * 目标目录前置检查。
 * 拒绝文件系统根与符号链接目标：rm -rf 一个链接虽然通常只删链接本身，但"目标由调用方
 * 传入"时不能假设它一定在 cache 内，先挡掉最危险的两类。
 */
async function assertSafeDest(absoluteDest) {
  if (absoluteDest.includes('\0')) throw new SourceError('source-invalid', 'destDir 含非法字符');
  const { root } = parsePath(absoluteDest);
  if (root !== '' && resolve(absoluteDest) === resolve(root)) {
    throw new SourceError('source-invalid', `拒绝把文件系统根作为 destDir：${absoluteDest}`, absoluteDest);
  }
  const info = await lstatOrNull(absoluteDest);
  if (info?.isSymbolicLink()) {
    throw new SourceError('source-invalid', `目标目录是符号链接，拒绝覆盖：${absoluteDest}`, absoluteDest);
  }
}

/** 递归拒绝符号链接（git/archive 产出树用；directory 在复制时已逐条拒绝）。 */
async function assertNoSymlinks(rootPath, depth = 0) {
  if (depth > MAX_COPY_DEPTH) throw new SourceError('source-invalid', `目录层级过深：${rootPath}`, rootPath);
  let entries;
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch (error) {
    throw new SourceError('source-invalid', `目录读取失败：${messageOf(error)}`, rootPath);
  }
  for (const entry of entries) {
    if (SKIP_COPY_ENTRIES.has(entry.name)) continue;
    const entryPath = join(rootPath, entry.name);
    const info = await lstatOrNull(entryPath);
    if (info === null) continue;
    if (info.isSymbolicLink()) {
      throw new SourceError('source-invalid', `来源含符号链接，已拒绝：${entryPath}`, entryPath);
    }
    if (info.isDirectory()) await assertNoSymlinks(entryPath, depth + 1);
  }
}

// ============================================================
// 指纹
// ============================================================

/** 稳定目录指纹（hex）。与 util.sha256Dir 同算法，便于 store 侧交叉校验。 */
export async function sha256Dir(rootPath) {
  const stats = await hashDirectory(rootPath);
  return stats.sha256;
}

/** 遍历一次同时产出指纹与文件数（fileCount 用于判断 source-empty）。 */
async function hashDirectory(rootPath) {
  const hash = createHash('sha256');
  let fileCount = 0;

  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // 单目录不可读不影响其余部分：与 util.sha256Dir 行为一致（静默跳过）。
      return;
    }
    entries.sort(byName);
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      const rel = relativePosix(rootPath, full);
      if (entry.isSymbolicLink()) {
        hash.update(`L\0${rel}\0`);
        continue;
      }
      if (entry.isDirectory()) {
        hash.update(`D\0${rel}\0`);
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      hash.update(`F\0${rel}\0`);
      try {
        hash.update(await readFile(full));
      } catch {
        hash.update('unreadable');
      }
      hash.update('\0');
      fileCount += 1;
    }
  };

  if (typeof rootPath !== 'string' || rootPath === '') return { sha256: '', fileCount: 0 };
  const info = await lstatOrNull(rootPath);
  if (info === null || !info.isDirectory() || info.isSymbolicLink()) return { sha256: '', fileCount: 0 };
  await walk(rootPath);
  return { sha256: hash.digest('hex'), fileCount };
}

/** 相对路径统一成 `/` 分隔，避免 Windows 反斜杠改变指纹。 */
function relativePosix(rootPath, fullPath) {
  const rel = fullPath.slice(rootPath.length).replace(/^[\\/]+/, '');
  return rel.split('\\').join('/');
}

// ============================================================
// 下载
// ============================================================

/**
 * 下载（或本地复制）到指定文件。
 * http(s) 走流式写入，file: 直接 copyFile——市场里的"本地 zip 源"经 pathToFileURL 编码后落到这里。
 */
export async function downloadTo(url, filePath, { signal } = {}) {
  if (typeof url !== 'string' || url.trim() === '') throw new SourceError('source-invalid', '下载地址为空');
  if (typeof filePath !== 'string' || filePath.trim() === '') throw new SourceError('source-invalid', '下载目标路径为空');
  const target = resolve(filePath);
  await mkdir(dirname(target), { recursive: true });
  throwIfAborted(signal);

  if (/^file:/i.test(url)) {
    let localPath;
    try {
      localPath = fileURLToPath(url);
    } catch (error) {
      throw new SourceError('source-invalid', `file: 地址非法：${messageOf(error)}`, url);
    }
    const info = await lstatOrNull(localPath);
    if (info === null || info.isSymbolicLink() || !info.isFile()) {
      throw new SourceError('source-unreachable', `本地文件不存在或不是普通文件：${localPath}`, localPath);
    }
    await copyFile(localPath, target);
    return target;
  }

  if (!/^https?:\/\//i.test(url)) {
    throw new SourceError('source-unreachable', `只支持 http(s):// 与 file:// 地址：${url}`);
  }

  let response;
  try {
    response = await fetch(url, { signal, redirect: 'follow' });
  } catch (error) {
    throw new SourceError('source-unreachable', `下载失败：${messageOf(error)}`, url);
  }
  if (!response.ok) {
    throw new SourceError('source-unreachable', `下载失败（HTTP ${response.status}）：${url}`, url);
  }

  try {
    if (response.body === null || response.body === undefined) {
      // 极端情况下（某些代理/空响应）没有 body 流，退化为一次性读取。
      const buffer = Buffer.from(await response.arrayBuffer());
      await pipeline(Readable.from([buffer]), createWriteStream(target));
      return target;
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
  } catch (error) {
    if (error?.name === 'AbortError') throw new SourceError('source-unreachable', '下载已取消', url);
    throw new SourceError('source-unreachable', `下载写入失败：${messageOf(error)}`, url);
  }
  return target;
}

// ============================================================
// 子进程
// ============================================================

/**
 * 统一执行外部命令。
 *
 * 注入执行器（ctx.subprocess.spawn）优先：宿主可统一 sandbox、权限与审计。假定其签名是
 * `spawn(cmd, args, opts) -> Promise<{exitCode|code, stdout, stderr}> | ChildProcess`；
 * 返回值形态无法识别时按成功处理，由调用方的产物校验（克隆/解压结果非空）兜底。
 */
async function runProcess(command, args, { ctx, timeoutMs, signal, log, cwd, env } = {}) {
  const injected = ctx?.subprocess?.spawn;
  if (typeof injected === 'function') {
    return runInjected(injected, ctx.subprocess, command, args, { timeoutMs, signal, cwd, env });
  }
  return runNodeChild(spawnProcess(command, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }), { command, timeoutMs, signal });
}

/** 走注入执行器；抛错直接转契约错误码，不 fallback 重跑（可能重复副作用）。 */
async function runInjected(spawnFn, thisArg, command, args, { timeoutMs, signal, cwd, env }) {
  let result;
  try {
    result = await spawnFn.call(thisArg, command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      timeoutMs,
      signal,
      stdio: 'pipe',
    });
  } catch (error) {
    const code = error?.code === 'ENOENT' ? 'source-unreachable' : 'source-invalid';
    throw new SourceError(code, `${command} 执行失败：${messageOf(error)}`);
  }

  if (result && typeof result === 'object' && typeof result.once === 'function' && typeof result.pid === 'number') {
    return runNodeChild(result, { command, timeoutMs, signal });
  }
  const exitCode = typeof result === 'number'
    ? result
    : isRecord(result) && typeof result.exitCode === 'number'
      ? result.exitCode
      : isRecord(result) && typeof result.code === 'number'
        ? result.code
        : null;
  if (exitCode !== null && exitCode !== 0) {
    const stderr = isRecord(result) && typeof result.stderr === 'string' ? result.stderr : '';
    throw new SourceError('source-invalid', `${command} 退出码 ${exitCode}${stderr ? `：${tail(stderr)}` : ''}`);
  }
  return { code: exitCode ?? 0 };
}

/** 等一个 Node ChildProcess 结束，带超时与取消（kill 进程树，避免 git 派生的子进程残留）。 */
function runNodeChild(child, { command, timeoutMs, signal }) {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    let onAbort = null;

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const fail = (code, message) => finish(rejectPromise, new SourceError(code, message));

    if (signal?.aborted) {
      killTree(child);
      fail('source-invalid', `${command} 已取消`);
      return;
    }
    if (signal) {
      onAbort = () => {
        killTree(child);
        fail('source-invalid', `${command} 已取消`);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
      timer = setTimeout(() => {
        killTree(child);
        fail('source-unreachable', `${command} 超时（${timeoutMs}ms）`);
      }, timeoutMs);
    }

    // 注入执行器返回的 ChildProcess 可能没有管道，读不到输出也不该崩。
    child.stdout?.on('data', (chunk) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = appendCapped(stderr, chunk);
    });
    child.once('error', (error) => {
      const code = error?.code === 'ENOENT' ? 'source-unreachable' : 'source-invalid';
      fail(code, `${command} 无法执行：${messageOf(error)}`);
    });
    child.once('close', (code) => {
      if (code === 0) {
        finish(resolvePromise, { code, stdout, stderr });
      } else {
        fail('source-invalid', `${command} 退出码 ${code ?? 'signal'}${stderr ? `：${tail(stderr)}` : ''}`);
      }
    });
  });
}

/**
 * 杀进程树。
 * Windows 的 child.kill() 只结束直接子进程，git clone 的 git-remote-* 会残留并握着重试资源，
 * 所以额外用 taskkill /T /F（失败无妨，至少直接子进程已死）。
 */
function killTree(child) {
  if (!child || typeof child.kill !== 'function') return;
  try {
    child.kill('SIGKILL');
  } catch {
    /* 进程已退出 */
  }
  if (process.platform === 'win32' && typeof child.pid === 'number') {
    try {
      const killer = spawnProcess('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => {});
      killer.unref?.();
    } catch {
      /* taskkill 不可用时忽略 */
    }
  }
}

// ============================================================
// 小工具
// ============================================================

/** 取消信号检查：spec 只允许三类 code，取消归到 source-invalid 并给出明确文案。 */
function throwIfAborted(signal) {
  if (signal?.aborted) throw new SourceError('source-invalid', '操作已取消（aborted）');
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

async function readdirSafe(dirPath) {
  try {
    return await readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    throw new SourceError('source-invalid', `目录读取失败：${messageOf(error)}`, dirPath);
  }
}

function byName(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function appendCapped(current, chunk) {
  if (current.length >= MAX_CAPTURE_CHARS) return current;
  const next = `${current}${String(chunk)}`;
  return next.length > MAX_CAPTURE_CHARS ? next.slice(0, MAX_CAPTURE_CHARS) : next;
}

function tail(text) {
  return text.trim().split(/\r?\n/).slice(-3).join(' | ');
}

function labelOf(source) {
  if (typeof source.path === 'string' && source.path !== '') return source.path;
  if (typeof source.url === 'string' && source.url !== '') return source.url;
  return String(source.kind ?? '');
}

function messageOf(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
