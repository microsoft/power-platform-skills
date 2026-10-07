// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BridgeError } from './errors.mjs';
import { profile, validateName } from './configuration.mjs';
import { normalizeClaims } from './http-auth.mjs';
import { PrivateDirectory, rejectLink, readJson, atomicWrite, stateError } from './private-files.mjs';

export function defaultStateRoot(
  platform = process.platform,
  env = process.env,
  home = os.homedir()
) {
  if (platform === 'win32') {
    if (!env.LOCALAPPDATA || !path.win32.isAbsolute(env.LOCALAPPDATA)) {
      throw new BridgeError(
        'A private per-user LocalApplicationData directory is required.',
        3,
        'STATE_ACCESS_DENIED'
      );
    }
    return path.win32.join(env.LOCALAPPDATA, 'ProcessIntelligenceBridgeAzureCli');
  }
  if (!path.posix.isAbsolute(home)) {
    throw new BridgeError(
      'A private per-user home directory is required.',
      3,
      'STATE_ACCESS_DENIED'
    );
  }
  const base =
    platform === 'darwin'
      ? path.posix.join(home, 'Library', 'Application Support')
      : env.XDG_DATA_HOME && path.posix.isAbsolute(env.XDG_DATA_HOME)
        ? env.XDG_DATA_HOME
        : path.posix.join(home, '.local', 'share');
  return path.posix.join(base, 'ProcessIntelligenceBridgeAzureCli');
}

const changed = () =>
  new BridgeError(
    'Profile/account changed. Restart MCP with the selected profile; the old connection is invalid.',
    3,
    'PROFILE_CHANGED'
  );

export class StateStore extends PrivateDirectory {
  constructor(root = defaultStateRoot()) {
    super(root);
  }

  file(name, suffix = '.json') {
    validateName(name);
    return path.join(this.root, name + suffix);
  }

  async load(name) {
    const value = await readJson(this.file(name));
    if (value === null) {
      throw new BridgeError(
        'Profile is not configured. Run config with an explicit --profile first.',
        3,
        'PROFILE_MISSING'
      );
    }
    return profile(value);
  }

  async ensureCurrent(selected) {
    if (!isDeepStrictEqual(await this.load(selected.Name), profile(selected))) {
      throw changed();
    }
  }

  async withLock(name, operation) {
    await this.prepare();
    const file = this.file(name, '.node-lock');
    await rejectLink(file);
    let handle;
    try {
      handle = await fs.open(file, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
      const owner = await readJson(file);
      let active = false;
      if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
        try {
          process.kill(owner.pid, 0);
          active = true;
        } catch (e) {
          if (e.code !== 'ESRCH') {
            active = true;
          }
        }
      }
      throw new BridgeError(
        active
          ? 'Another Node process is changing this profile. Retry after it finishes.'
          : 'Stale Node mutation lock detected. Verify the owner and stop affected profile sessions before manually removing only its stale .node-lock file; no profile was changed.',
        3,
        'STATE_LOCKED'
      );
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
      await handle.sync();
      return await operation();
    } finally {
      await handle.close();
      await fs.unlink(file);
    }
  }

  async #write(file, value) {
    await atomicWrite(file, JSON.stringify(value));
  }

  async save(value, expectedRevision, expectedClaims) {
    const selected = profile(value);
    return this.withLock(selected.Name, async () => {
      if (
        expectedRevision !== undefined &&
        (await this.load(selected.Name)).Revision !== expectedRevision
      ) {
        throw changed();
      }
      // A new challenge can arrive during terminal login without changing the profile revision.
      // Compare the claims used for that login while holding the same lock as saveChallenge.
      if (
        expectedClaims !== undefined &&
        (await this.loadChallenge(selected)) !== expectedClaims
      ) {
        throw new BridgeError(
          'Conditional-access challenge changed during login. Run login again; no profile was saved.',
          3,
          'PROFILE_CHANGED'
        );
      }
      const saved = { ...selected, Revision: randomUUID().replaceAll('-', '') };
      await this.#write(this.file(saved.Name), saved);
      // Keep the old challenge if profile publication fails. Once the new revision is saved,
      // every prior challenge is unusable; remove it before another writer can publish a new one.
      await this.#removeChallenge(saved.Name);
      return saved;
    });
  }

  async #removeChallenge(name) {
    const file = this.file(name, '.challenge.json');
    try {
      await rejectLink(file);
      const info = await fs.lstat(file);
      if (!info.isFile() || info.nlink > 1) {
        throw stateError('Pending claims must be an unlinked regular file.');
      }
      // Do not parse obsolete claims: explicit config/logout can also remove malformed or
      // oversized files. Never follow links or recursively remove an unexpected directory.
      await fs.unlink(file);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw stateError(
          'Profile was saved, but pending claims cleanup failed. Stop affected bridge sessions ' +
            'and safely remove only this profile\'s challenge file before reconnecting.'
        );
      }
    }
  }

  async loadChallenge(selected) {
    const pending = await readJson(this.file(selected.Name, '.challenge.json'));
    return pending?.Revision === selected.Revision ? normalizeClaims(pending.Claims) : null;
  }

  async saveChallenge(selected, claims) {
    const normalized = normalizeClaims(claims);
    await this.withLock(selected.Name, async () => {
      await this.ensureCurrent(selected);
      await this.#write(this.file(selected.Name, '.challenge.json'), {
        Revision: selected.Revision,
        Claims: normalized
      });
    });
  }
}
