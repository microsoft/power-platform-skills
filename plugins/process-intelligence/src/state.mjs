// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BridgeError } from './errors.mjs';
import { profile, validateName } from './configuration.mjs';
import { PrivateDirectory, rejectLink, readJson, atomicWrite } from './private-files.mjs';

export function defaultStateRoot(
  platform = process.platform,
  env = process.env,
  home = os.homedir()
) {
  if (platform === 'win32') {
    if (!env.LOCALAPPDATA || !path.win32.isAbsolute(env.LOCALAPPDATA)) {
      throw new BridgeError(
        'A per-user LocalApplicationData directory is required.',
        3,
        'STATE_ACCESS_DENIED'
      );
    }
    return path.win32.join(env.LOCALAPPDATA, 'ProcessIntelligenceBridgeAzureCli');
  }
  if (!path.posix.isAbsolute(home)) {
    throw new BridgeError(
      'A per-user home directory is required.',
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
    'Profile/account changed. Explicitly call pi_activate_profile with the selected profile; the old connection is invalid.',
    3,
    'PROFILE_CHANGED'
  );

export function preferenceScope(client, installationRoot, env = process.env) {
  if (!client?.name || typeof client.name !== 'string' || client.name.length > 128) {
    throw new BridgeError('MCP client identity is required to remember a profile.', 3, 'STATE_INVALID');
  }
  const hostRoot = client.name === 'copilot-cli'
    ? env.COPILOT_HOME || path.join(os.homedir(), '.copilot')
    : client.name.startsWith('claude')
      ? env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
      : '';
  const normalize = value => {
    const absolute = path.resolve(value);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  // Client name (not version) plus installation and host config scope keeps updates
  // reusable without making another client or installation adopt a last-used profile.
  return createHash('sha256')
    .update(JSON.stringify([client.name, normalize(installationRoot), hostRoot ? normalize(hostRoot) : '']))
    .digest('hex');
}

export class ProfilePreferences extends PrivateDirectory {
  constructor(root, scope) {
    super(root);
    if (!/^[a-f0-9]{64}$/.test(scope)) {
      throw new BridgeError('Invalid profile preference scope.', 3, 'STATE_INVALID');
    }
    this.file = path.join(this.root, scope + '.json');
  }

  async load() {
    const value = await readJson(this.file);
    if (value === null) {
      return null;
    }
    if (Object.keys(value).length !== 1 || !Object.hasOwn(value, 'profile')) {
      throw new BridgeError(
        'Remembered profile metadata is invalid. Explicitly activate the intended profile again.',
        3,
        'STATE_INVALID'
      );
    }
    validateName(value.profile);
    return value.profile;
  }

  async save(name) {
    validateName(name);
    await this.prepare();
    await atomicWrite(this.file, JSON.stringify({ profile: name }));
  }
}

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
      handle = await fs.open(file, 'wx');
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

  async configure(value) {
    return this.save(value, undefined, { configurationOnly: true });
  }

  async save(value, expectedRevision, { configurationOnly = false } = {}) {
    const selected = profile(value);
    return this.withLock(selected.Name, async () => {
      if (
        expectedRevision !== undefined &&
        (await this.load(selected.Name)).Revision !== expectedRevision
      ) {
        throw changed();
      }
      if (configurationOnly) {
        try {
          const current = await readJson(this.file(selected.Name));
          if (current !== null) {
            const saved = profile(current);
            if (isDeepStrictEqual(
              { ...saved, HomeAccountId: null, Revision: '' },
              { ...selected, HomeAccountId: null, Revision: '' }
            )) {
              return saved;
            }
          }
        } catch (error) {
          // Explicit config repairs invalid data as before; only a valid unchanged
          // profile retains its binding. Access/link failures must still stop it.
          if (!['STATE_INVALID', 'INVALID_CONFIGURATION'].includes(error.errorCode)) {
            throw error;
          }
        }
      }
      const saved = { ...selected, Revision: randomUUID().replaceAll('-', '') };
      await atomicWrite(this.file(saved.Name), JSON.stringify(saved));
      return saved;
    });
  }
}
