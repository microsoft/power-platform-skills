import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk';
import { parseSkill } from '@microsoft/vally';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertOfflineCatalog, clientEnvironment, createOfflineTools, offlineSessionConfig,
} from '../offline-executor.mjs';
import { pluginRoot } from '../suites.mjs';

test('pinned native CLI keeps both arms isolated, including after real skill activation', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pp-native-test-'));
  const requests = [];
  // No model or credential is needed to exercise session creation, catalog RPCs,
  // skill activation and teardown. A local provider prevents real inference.
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ object: 'list', data: [] }));
  });
  let client;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const require = createRequire(import.meta.url);
    const cli = path.join(path.dirname(require.resolve('@github/copilot/package.json')), 'npm-loader.js');
    client = new CopilotClient({
      mode: 'empty', baseDirectory: root, env: clientEnvironment(root), useLoggedInUser: false,
      connection: RuntimeConnection.forStdio({ path: process.execPath, args: [cli] }),
    });
    await client.start();
    const selected = await parseSkill(path.join(pluginRoot, 'skills/setup-auth/SKILL.md'));
    for (const skills of [[], [selected]]) {
      const workDir = path.join(root, skills.length ? 'skilled' : 'baseline');
      await mkdir(workDir);
      const session = await client.createSession({
        ...offlineSessionConfig({
          home: root, workDir, pluginRoot, skills, model: 'offline-test-model',
          tools: createOfflineTools(workDir, pluginRoot),
        }),
        provider: {
          type: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          apiKey: 'local-dummy-key',
        },
      });
      try {
        await assertOfflineCatalog(session, skills);
        const content = JSON.stringify({
          SITE_NAME: 'Contoso test-only site', SUMMARY: 'Approval required before changing permissions.',
          ROLES_DATA: [], PERMISSIONS_DATA: [], RATIONALE_DATA: [],
        });
        const written = await session.rpc.tools.execute({
          name: 'eval_write', arguments: { path: 'input.json', content },
        });
        assert.equal(written.resultType, 'success');
        assert.equal(await readFile(path.join(workDir, 'input.json'), 'utf8'), content);
        const rendered = await session.rpc.tools.execute({
          name: 'eval_render', arguments: {
            renderer: 'render-permissions-plan', data: 'input.json', output: 'docs/permissions.html',
          },
        });
        assert.equal(rendered.resultType, 'success', rendered.textResultForLlm);
        assert.match(await readFile(path.join(workDir, 'docs/permissions.html'), 'utf8'), /Contoso test-only site/);
        const duplicate = await session.rpc.tools.execute({
          name: 'eval_render', arguments: {
            renderer: 'render-permissions-plan', data: 'input.json', output: 'docs/permissions.html',
          },
        });
        assert.equal(duplicate.resultType, 'failure');
        assert.match(duplicate.textResultForLlm, /Output file already exists/);
        if (skills.length) {
          const result = await session.rpc.tools.execute({ name: 'skill', arguments: { skill: selected.name } });
          assert.equal(result.resultType, 'success');
          await assertOfflineCatalog(session, skills);
        }
      } finally {
        await session.disconnect();
      }
    }
    assert.ok(!requests.some(request => /completions|responses/.test(request)), 'no model generation was requested');
  } finally {
    try {
      const errors = await client?.stop();
      assert.deepEqual(errors ?? [], []);
    } finally {
      await new Promise(resolve => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  }
});
