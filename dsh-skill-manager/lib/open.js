/**
 * dsh-skill-manager — "open in the OS file manager".
 *
 * Opening a folder is navigation, not a mutation: the panel never edits through
 * the OS shell. The child is detached and its stdio ignored, because Windows
 * `explorer.exe` exits with a non-zero code even when it succeeds.
 */

import { spawn } from 'node:child_process';

/**
 * Open a directory (or select a file's folder) in the platform file manager.
 *
 * @param {string} target - absolute path
 * @returns {string} the path that was handed to the OS
 */
export function openInFileManager(target) {
  const platform = process.platform;
  const command = platform === 'win32' ? 'explorer.exe' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? [target] : [target];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      /* a missing opener must not fail the request; the UI shows the path anyway */
    });
    child.unref();
  } catch {
    /* same as above */
  }
  return target;
}
