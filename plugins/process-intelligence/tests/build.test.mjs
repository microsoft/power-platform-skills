// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = ['server/mcp.mjs', 'server/bundle-meta.json'];

for (const autocrlf of ['true', 'false']) {
  test(`generated artifact gate is byte-exact with core.autocrlf=${autocrlf}`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-build-git-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const config = path.join(root, 'empty-git-config');
    await fs.writeFile(config, '');
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config
    };
    const git = args => {
      const result = spawnSync('git', ['-c', `core.autocrlf=${autocrlf}`, ...args], {
        cwd: root, env, encoding: 'utf8', windowsHide: true
      });
      assert.ifError(result.error);
      assert.ok([0, 1].includes(result.status), result.stderr);
      return result.status;
    };
    await fs.mkdir(path.join(root, 'src'));
    await fs.mkdir(path.join(root, 'server'));
    await assert.doesNotReject(fs.copyFile(path.join(plugin, '.gitattributes'),
      path.join(root, '.gitattributes')), 'Build inputs and artifacts need explicit line-ending rules');
    // Check every first-party input esbuild actually consumed, including imported
    // JSON. Restricting this to .mjs misses package.json's recorded input size.
    const meta = JSON.parse(await fs.readFile(path.join(plugin, 'server', 'bundle-meta.json'), 'utf8'));
    const inputs = Object.keys(meta.inputs).filter(file => !file.startsWith('node_modules/'));
    assert.ok(inputs.includes('package.json'));
    const expectedInputs = new Map();
    for (const file of inputs) {
      const source = (await fs.readFile(path.join(plugin, file), 'utf8')).replace(/\r\n/g, '\n');
      expectedInputs.set(file, source);
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.copyFile(path.join(plugin, file), path.join(root, file));
    }
    for (const file of artifacts) await fs.writeFile(path.join(root, file), 'fixture\n');
    // A temporary index is sufficient for the same working-tree diff CI uses.
    // No commit, identity configuration or remote is needed in this owned fixture.
    assert.equal(git(['init', '--quiet', '--template=']), 0);
    assert.equal(git(['add', '--', '.gitattributes', ...inputs, ...artifacts]), 0);
    for (const file of inputs) await fs.rm(path.join(root, file));
    assert.equal(git(['checkout-index', '--', ...inputs]), 0);
    for (const [file, source] of expectedInputs) {
      assert.equal(await fs.readFile(path.join(root, file), 'utf8'), source,
        `${file}: every actual build input needs stable checkout bytes`);
      assert.equal(meta.inputs[file].bytes, Buffer.byteLength(source),
        `${file}: committed metadata must describe the canonical checkout bytes`);
    }
    const gate = ['diff', '--exit-code', '--', ...artifacts];
    assert.equal(git(gate), 0);
    for (const file of artifacts) {
      for (const changed of ['stale\n', 'fixture\r\n']) {
        await fs.writeFile(path.join(root, file), changed);
        assert.equal(git(gate), 1, `${file}: content and line-ending drift must both fail`);
      }
      await fs.writeFile(path.join(root, file), 'fixture\n');
      assert.equal(git(gate), 0);
    }
  });
}
