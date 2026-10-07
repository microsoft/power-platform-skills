// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError, isObject } from './errors.mjs';
import { runProcess, windowsUtility } from './process.mjs';

export const stateError = (message, code = 'STATE_ACCESS_DENIED') =>
  new BridgeError(message, 3, code);

export async function rejectLink(file) {
  const resolved = path.resolve(file);
  const parts = [];
  for (let cursor = resolved; path.dirname(cursor) !== cursor; cursor = path.dirname(cursor)) {
    parts.push(cursor);
  }
  for (const item of parts.reverse()) {
    try {
      const info = await fs.lstat(item);
      if (info.isSymbolicLink()) {
        throw stateError('Private state must not be a symlink or reparse point.');
      }
      if (item === resolved && info.nlink > 1 && info.isFile()) {
        throw stateError('Private state must not be a hard link.');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

export async function readText(file, limit = 65536) {
  await rejectLink(file);
  let handle;
  try {
    const before = await fs.lstat(file);
    if (!before.isFile() || before.size > limit) {
      throw stateError('Private state is invalid or exceeds its size limit.', 'STATE_INVALID');
    }
    handle = await fs.open(
      file,
      constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
    );
    const actual = await handle.stat();
    if (actual.ino !== before.ino || actual.dev !== before.dev || actual.nlink > 1) {
      throw stateError('Private state changed while opening.');
    }
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) {
        break;
      }
      total += bytesRead;
    }
    if (total > limit) {
      throw stateError('Private state is invalid or exceeds its size limit.', 'STATE_INVALID');
    }
    return buffer.subarray(0, total).toString('utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    if (error instanceof BridgeError) {
      throw error;
    }
    throw stateError('Private state could not be read safely.');
  } finally {
    await handle?.close();
  }
}

export async function readJson(file, missing = null) {
  const text = await readText(file);
  if (text === null) {
    return missing;
  }
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (isObject(value)) {
      return value;
    }
  } catch {}
  throw stateError('Private state JSON is invalid; reconfigure explicitly.', 'STATE_INVALID');
}

export async function atomicWrite(file, text) {
  await rejectLink(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rejectLink(file);
    await fs.rename(temporary, file);
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(file), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export class PrivateDirectory {
  #prepared;
  #sid;

  constructor(root) {
    this.root = path.resolve(root);
  }

  async #windows(args, signal) {
    const result = await runProcess(windowsUtility('icacls.exe'), args, { signal });
    if (result.code !== 0) {
      throw stateError(
        'Cannot establish private Windows state ACLs. Check ownership and permissions.'
      );
    }
    return result;
  }

  async prepare({ signal } = {}) {
    signal?.throwIfAborted();
    await rejectLink(this.root);
    this.#prepared ??= (async () => {
      signal?.throwIfAborted();
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      await rejectLink(this.root);
      signal?.throwIfAborted();
      if (process.platform !== 'win32') {
        await fs.chmod(this.root, 0o700);
        return;
      }
      const user = await runProcess(windowsUtility('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
        signal
      });
      this.#sid = /"(S-1-\d+(?:-\d+)+)"\s*$/.exec(user.stdout.trim())?.[1];
      if (user.code !== 0 || !this.#sid) {
        throw stateError('Cannot resolve current Windows user for private state.');
      }
      await this.#windows(
        [this.root, '/inheritance:r', '/grant:r', `*${this.#sid}:(OI)(CI)F`, '/q'],
        signal
      );
      await this.#windows([this.root, '/setowner', `*${this.#sid}`, '/q'], signal);
      await this.verifyPrivate(this.root, true, { signal });
    })();
    return this.#prepared;
  }

  async verifyPrivate(file = this.root, directory = true, { signal } = {}) {
    signal?.throwIfAborted();
    await rejectLink(file);
    if (process.platform !== 'win32') {
      if (((await fs.stat(file)).mode & 0o777) !== (directory ? 0o700 : 0o600)) {
        throw stateError('State permissions are not private.');
      }
      return;
    }
    const temporary = path.join(this.root, `.acl-${randomUUID()}.tmp`);
    try {
      await this.#windows([file, '/save', temporary, '/q'], signal);
      const text = (await fs.readFile(temporary)).toString('utf16le');
      const sddl = text.split(/\r?\n/).find(line => line.startsWith('D:'));
      const entries = sddl?.match(/\([^)]*\)/g) ?? [];
      const trustee = entries.length === 1
        ? new RegExp(`^\\(A;${directory ? 'OICI' : ''};FA;;;([A-Z]{2}|S-1-\\d+(?:-\\d+)+)\\)$`)
          .exec(entries[0])?.[1]
        : null;
      let matchesUser = trustee === this.#sid;
      if (sddl?.startsWith('D:P') && /^[A-Z]{2}$/.test(trustee ?? '')) {
        // icacls can export e.g. D:P(A;OICI;FA;;;LA) rather than a numeric SID.
        // Resolve the alias natively: a "-500" suffix alone does not distinguish
        // the machine Administrator from a different domain's Administrator.
        // Only a two-letter trustee is passed as data to this fixed inbox script;
        // no profile, input code, path search or permission changes are involved.
        // https://learn.microsoft.com/en-us/windows/win32/secauthz/sid-strings
        const script = "$ErrorActionPreference='Stop';" +
          "[System.Security.AccessControl.RawSecurityDescriptor]::new(" +
          "'D:(A;;FA;;;' + $env:PROCESS_INTELLIGENCE_ACL_TRUSTEE + ')')" +
          ".DiscretionaryAcl[0].SecurityIdentifier.Value";
        const resolved = await runProcess(windowsUtility('powershell.exe'), [
          '-NoProfile', '-NonInteractive', '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64')
        ], {
          signal,
          outputLimit: 8192,
          env: { ...process.env, PROCESS_INTELLIGENCE_ACL_TRUSTEE: trustee }
        });
        matchesUser = resolved.code === 0 && resolved.stdout.trim() === this.#sid;
      }
      if (
        !sddl?.startsWith('D:P') ||
        !trustee ||
        !matchesUser
      ) {
        throw stateError(
          'Windows state ACL verification failed; unexpected access entries were not ignored.'
        );
      }
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}
