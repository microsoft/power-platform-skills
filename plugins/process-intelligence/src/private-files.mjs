// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError, isObject } from './errors.mjs';

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
    const handle = await fs.open(temporary, 'wx');
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

  constructor(root) {
    this.root = path.resolve(root);
  }

  async prepare({ signal } = {}) {
    signal?.throwIfAborted();
    await rejectLink(this.root);
    this.#prepared ??= (async () => {
      signal?.throwIfAborted();
      await fs.mkdir(this.root, { recursive: true });
      await rejectLink(this.root);
      signal?.throwIfAborted();
    })();
    return this.#prepared;
  }
}
