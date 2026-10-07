// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdtemp, mkdir, realpath, rm, writeFile, cp, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { StateStore, defaultStateRoot } from '../src/state.mjs';
import { bound } from './helpers.mjs';

export const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function bundleFixture(t) {
  const temp = await mkdtemp(path.join(await realpath(os.tmpdir()), 'pm isolated & (bundle) ')), cleanup = [];
  t.after(async () => { for (const close of cleanup) await close(); await rm(temp, { recursive: true, force: true }); });
  const plugin = path.join(temp, 'plugin'), home = path.join(temp, 'user'), bin = path.join(temp, 'bin');
  await mkdir(path.join(plugin, 'server'), { recursive: true }); await mkdir(home); await mkdir(bin);
  await cp(path.join(pluginRoot, 'server', 'mcp.mjs'), path.join(plugin, 'server', 'mcp.mjs'));
  await cp(path.join(pluginRoot, '.mcp.json'), path.join(plugin, '.mcp.json'));
  const configDir = path.join(home, '.power-platform-skills');
  const env = { ...process.env, PATH: bin, PLUGIN_ROOT: plugin, CLAUDE_PLUGIN_ROOT: '', PM_BRIDGE_PROFILE: 'sample',
    LOCALAPPDATA: home, HOME: home, USERPROFILE: home, XDG_DATA_HOME: home, AZURE_CONFIG_DIR: path.join(home, '.azure'),
    FIXTURE_REPORT: path.join(temp, 'report.json') };
  const state = new StateStore(defaultStateRoot(process.platform, env, home)); await state.save(bound);
  const az = path.join(bin, process.platform === 'win32' ? 'az.cmd' : 'az');
  await writeFile(az, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${path.join(pluginRoot, 'tests', 'az-fixture.mjs')}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${path.join(pluginRoot, 'tests', 'az-fixture.mjs')}" "$@"\n`);
  if (process.platform !== 'win32') await chmod(az, 0o700);
  return { temp, plugin, home, configDir, env, state, az, cleanup };
}
