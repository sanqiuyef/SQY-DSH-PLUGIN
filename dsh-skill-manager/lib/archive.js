/**
 * dsh-skill-manager — 技能包打包与解压（v3.1，契约 §8.7 / §8.8）。
 *
 * 用系统自带的 `tar`，不新增 npm 依赖：
 *
 *   - 解压：`tar -xf <archive> -C <target>`（bsdtar 按**内容**识别格式，zip 也读）；
 *   - 打包：`tar -a -c -f <target> -C <parent> <basename>`（`-a` 按扩展名选格式与压缩）。
 *
 * Windows 10+ 自带 `tar.exe`（bsdtar + libarchive），macOS 与主流 Linux 的 bsdtar/GNU
 * tar 对这两个调用都兼容；`-a` 是 bsdtar 的扩展，GNU tar 不认，那种环境会落到
 * {@link runTar} 的 500 分支（明确报错，不静默降级成无压缩 tar）。
 *
 * 安全约束（契约 §8.8：「解压项必须留在目标目录内，越界即整包拒绝」）分两层：
 *
 *   1. 解压前用 `tar -tf` 读成员名，`..` 段、绝对路径、盘符开头的条目整包 400。
 *      bsdtar 自己也拦一部分，但它是「报错退出前已经解出了前面的条目」，
 *      既会留下半成品，也会把契约要的 400 变成 500。
 *   2. 解压后遍历目标目录，每个条目 `realpath` 后必须仍在目标目录内，符号链接条目
 *      直接拒绝——链接是绕过字符串前缀检查的正路（tar 在 Linux/macOS 上会原样建链）。
 *
 * 参数一律走 `execFile` 的数组形式：没有 shell 字符串拼接，路径里的空格、引号、
 * `&`、`|` 都不会被解释。
 */

import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { ApiError, badRequest, exists, notFound } from './errors.js';
import { isInside, isInsideReal } from './scan.js';

/** 支持的压缩包扩展名，大小写不敏感。 */
const ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.tar.gz', '.tgz'];

/** `tar` 单次调用的 stdout/stderr 上限：大包的成员列表也撑不爆管道。 */
const TAR_MAX_BUFFER = 32 * 1024 * 1024;

/** `tar` 单次调用的墙钟上限。 */
const TAR_TIMEOUT_MS = 120 * 1000;

/** 错误信息里保留多少字符的 stderr。 */
const STDERR_SUMMARY_CHARS = 500;

/**
 * 是否是本模块支持的压缩包（`.zip` / `.tar` / `.tar.gz` / `.tgz`，大小写不敏感）。
 *
 * @param {unknown} path - 文件路径
 * @returns {boolean}
 */
export function isArchivePath(path) {
  if (typeof path !== 'string') return false;
  const lower = path.trim().toLowerCase();
  return ARCHIVE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * 解压一个技能包到目标目录。
 *
 * 目标目录必须事先不存在，或者是空目录（契约 §8.8 的临时目录由调用方建好）。
 * 任何一步失败都把目标目录恢复到调用前的状态：新建的整个删掉，原本就有的空目录
 * 重新建回来再抛错——失败不会留下半包内容。
 *
 * @param {string} archivePath - 压缩包路径
 * @param {string} targetDir - 解压目标目录
 * @returns {Promise<{ entries: number }>} `entries` = 解出来的条目数（文件 + 目录）
 */
export async function extractArchive(archivePath, targetDir) {
  if (typeof archivePath !== 'string' || archivePath.trim() === '') throw badRequest('缺少压缩包路径');
  if (typeof targetDir !== 'string' || targetDir.trim() === '') throw badRequest('缺少解压目标目录');

  const archive = resolve(archivePath.trim());
  if (!isArchivePath(archive)) {
    throw badRequest(`不支持的压缩包格式（只支持 .zip / .tar / .tar.gz / .tgz）：${archive}`);
  }
  const info = await statOrUndefined(archive);
  if (info === undefined || info.isFile() !== true) throw notFound(`压缩包不存在：${archive}`);

  const target = resolve(targetDir);
  const created = await prepareTarget(target);

  try {
    const listing = await runTar(['-tf', archive], '解压');
    assertSafeMembers(listing.stdout);
    await runTar(['-xf', archive, '-C', target], '解压');
    return { entries: await verifyExtraction(target) };
  } catch (error) {
    await discardTarget(target, created);
    throw error;
  }
}

/**
 * 把一个目录或单个文件打包成压缩包（扩展名决定格式）。
 *
 * @param {string} sourcePath - 要打包的目录或文件（技能条目本身）
 * @param {string} targetArchivePath - 目标压缩包路径；父目录必须已存在
 * @returns {Promise<{ files: number, path: string }>} `files` = 包内文件数
 */
export async function createArchive(sourcePath, targetArchivePath) {
  if (typeof sourcePath !== 'string' || sourcePath.trim() === '') throw badRequest('缺少要打包的路径');
  if (typeof targetArchivePath !== 'string' || targetArchivePath.trim() === '') throw badRequest('缺少目标压缩包路径');

  const source = resolve(sourcePath.trim());
  const info = await statOrUndefined(source);
  if (info === undefined) throw notFound(`来源不存在：${source}`);

  const target = resolve(targetArchivePath.trim());
  if (!isArchivePath(target)) {
    throw badRequest(`目标必须以 .zip / .tar / .tar.gz / .tgz 结尾：${target}`);
  }
  // 目标写在源目录里的话，tar 会把正在写的压缩包自己也读进去，产出坏包。
  if (info.isDirectory() && isInside(source, target)) {
    throw badRequest(`目标压缩包不能在要打包的目录里：${target}`);
  }
  const parentDir = dirname(target);
  const parentInfo = await statOrUndefined(parentDir);
  if (parentInfo === undefined || parentInfo.isDirectory() !== true) throw notFound(`目标目录不存在：${parentDir}`);
  if ((await statOrUndefined(target)) !== undefined) throw exists(`目标已存在：${target}`);

  const files = await countFiles(source, info);
  try {
    // `-C` 必须是**源**的父目录（操作数 `basename(source)` 相对它解析），目标压缩包写
    // 绝对路径，所以源与目标可以分别在任意两个目录里。
    await runTar(['-a', '-c', '-f', target, '-C', dirname(source), basename(source)], '打包');
  } catch (error) {
    // 失败不留半成品：写了一半的压缩包会被当成可用产物。
    await rm(target, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { files, path: target };
}

/**
 * 跑一次系统 `tar`。
 *
 * 非零退出、超时、`tar` 不存在都归成同一个 500「系统 tar 不可用」：对调用方来说三者
 * 含义相同，而本模块没有别的实现可退（不新增 npm 依赖）。
 *
 * @param {string[]} args - 参数数组（不经过 shell）
 * @param {string} action - 错误信息里的动作名（`解压` / `打包`）
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function runTar(args, action) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'tar',
      args,
      { maxBuffer: TAR_MAX_BUFFER, timeout: TAR_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error === undefined || error === null) {
          resolvePromise({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
          return;
        }
        const detail = String(stderr ?? '').trim().replace(/\s+/g, ' ').slice(0, STDERR_SUMMARY_CHARS);
        const reason = detail === '' ? String(error?.message ?? error) : detail;
        reject(new ApiError('internal', `系统 tar 不可用或${action}失败：${reason}`, 500));
      },
    );
  });
}

/**
 * 准备解压目标：不存在就建，存在必须是空目录。
 *
 * @param {string} target - 目标绝对路径
 * @returns {Promise<boolean>} `true` 表示这次新建的（失败时要整个删掉）
 */
async function prepareTarget(target) {
  const info = await statOrUndefined(target);
  if (info === undefined) {
    await mkdir(target, { recursive: true });
    return true;
  }
  if (info.isDirectory() !== true) throw badRequest(`解压目标不是目录：${target}`);
  const entries = await readdir(target);
  if (entries.length > 0) throw badRequest(`解压目标目录不为空：${target}`);
  return false;
}

/**
 * 把失败的解压结果丢掉，目标目录恢复成调用前的样子。
 *
 * @param {string} target - 目标绝对路径
 * @param {boolean} created - 是否本次新建
 * @returns {Promise<void>}
 */
async function discardTarget(target, created) {
  await rm(target, { recursive: true, force: true }).catch(() => {});
  if (!created) await mkdir(target, { recursive: true }).catch(() => {});
}

/**
 * 校验 `tar -tf` 列出的成员名——越界条目整包拒绝，一个都不解。
 *
 * 判据只有三类：盘符开头（`C:\x`、`C:/x`）、以分隔符开头（`/x`、`\x`、`\\srv\share`）、
 * 含 `..` 段。Windows 上 `/` 与 `\` 都可能是分隔符，所以两种都切段比较。
 *
 * @param {string} listing - `tar -tf` 的 stdout
 * @returns {void}
 */
function assertSafeMembers(listing) {
  for (const line of String(listing ?? '').split(/\r?\n/)) {
    const name = line.trim();
    if (name === '') continue;
    if (isUnsafeMember(name)) throw badRequest('压缩包含有越界条目，已拒绝');
  }
}

/** 一个成员名是否会落到目标目录之外。 */
function isUnsafeMember(name) {
  if (/^[a-zA-Z]:/.test(name)) return true;
  if (name.startsWith('/') || name.startsWith('\\')) return true;
  return name.split(/[\\/]+/).includes('..');
}

/**
 * 解压后复核：每个条目 `realpath` 后必须仍在目标目录内，符号链接条目直接拒绝。
 *
 * 字符串前缀挡不住链接与重定向：tar 在 Linux/macOS 上会把符号链接条目原样建出来，
 * 之后的读写就全在目标目录外。这里按物理路径复核。
 *
 * @param {string} target - 目标绝对路径
 * @returns {Promise<number>} 条目数（文件 + 目录）
 */
async function verifyExtraction(target) {
  let entries = 0;
  const queue = [target];
  while (queue.length > 0) {
    const dir = queue.shift();
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
      throw error;
    }
    for (const dirent of dirents) {
      const full = join(dir, dirent.name);
      entries += 1;
      if (dirent.isSymbolicLink()) throw badRequest('压缩包含有符号链接条目，已拒绝');
      if (!(await isInsideReal(target, full))) throw badRequest('压缩包含有越界条目，已拒绝');
      if (dirent.isDirectory()) queue.push(full);
    }
  }
  return entries;
}

/**
 * 先数一遍要打包的文件数（打包成功后没有第二次遍历）。
 *
 * 符号链接按「文件」计：tar 会把它存成链接条目，用户看到的是包里有这一项。
 *
 * @param {string} source - 源绝对路径
 * @param {object} info - `source` 的 `stat` 结果
 * @returns {Promise<number>}
 */
async function countFiles(source, info) {
  if (info.isFile()) return 1;
  if (info.isDirectory() !== true) return 0;
  let files = 0;
  const queue = [source];
  while (queue.length > 0) {
    const dir = queue.shift();
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (dirent.isDirectory()) queue.push(join(dir, dirent.name));
      else files += 1;
    }
  }
  return files;
}

/** `stat` 遇 ENOENT/ENOTDIR 归为 `undefined`（与 `lib/market.js` / `lib/trash.js` 同款）。 */
async function statOrUndefined(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined;
    throw error;
  }
}
