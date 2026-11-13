import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertOfflineCatalog, clientEnvironment, createOfflineTools, OfflineExecutor, offlineSessionConfig, TOOL_NAMES,
} from '../offline-executor.mjs';
import { pluginRoot } from '../suites.mjs';
import { confinedPath } from '../paths.mjs';

async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'pp-executor-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const tool = (tools, name) => tools.find(item => item.name === name).handler;

test('file tools enforce workspace containment and hide every skill from baseline resource reads', async t => {
  const root = await workspace(t);
  const tools = createOfflineTools(root, pluginRoot);
  await tool(tools, 'eval_write')({ path: 'docs/plan.txt', content: 'Approval required' });
  assert.equal(await tool(tools, 'eval_read')({ root: 'workspace', path: 'docs/plan.txt' }), 'Approval required');
  for (const name of ['../secret', '/etc/passwd', 'C:\\Users\\secret', 'docs/../../secret']) {
    await assert.rejects(() => tool(tools, 'eval_write')({ path: name, content: 'x' }));
  }
  await assert.rejects(() => tool(tools, 'eval_read')({ root: 'plugin', path: 'skills/setup-auth/SKILL.md' }), /skill catalog/);
  await assert.rejects(() => tool(tools, 'eval_read')({ root: 'plugin', path: 'AGENTS.md' }), /skill catalog/);
  for (const name of ['skills/setup-auth/skill.md', 'agents.md', 'skills/setup-auth/Skill.Md',
    'skills/setup-auth/SKILL.md.', 'skills/setup-auth/SKILL.md::$DATA']) {
    await assert.rejects(() => tool(tools, 'eval_read')({ root: 'plugin', path: name }), /skill catalog/);
  }
  await assert.rejects(() => tool(tools, 'eval_render')({ renderer: 'deploy-site', data: 'x', output: 'y.html' }), /allowlisted/);
  const listed = await tool(tools, 'eval_list')({ root: 'plugin', path: 'skills/setup-auth' });
  assert.ok(!listed.some(entry => entry.name === 'SKILL.md'));
});

test('root confinement rejects symlinks before following their target', async t => {
  const root = await workspace(t);
  const outside = await workspace(t);
  await writeFile(path.join(outside, 'secret'), 'outside');
  try { await symlink(outside, path.join(root, 'link'), 'junction'); }
  catch (error) {
    if (error.code === 'EPERM') { t.skip('Windows runner does not grant symlink privileges'); return; }
    throw error;
  }
  await assert.rejects(() => confinedPath(root, 'link/secret'), /Symbolic links/);
});

test('real local renderer produces a document while inherited credentials and cloud operations are excluded', async t => {
  const root = await workspace(t);
  const tools = createOfflineTools(root, pluginRoot);
  await writeFile(path.join(root, 'data.json'), JSON.stringify({
    SITE_NAME: 'Contoso service', SUMMARY: 'Approval required before changing permissions.',
    ROLES_DATA: [], PERMISSIONS_DATA: [], RATIONALE_DATA: [],
  }));
  await tool(tools, 'eval_render')({
    renderer: 'render-permissions-plan', data: 'data.json', output: 'docs/permissions.html',
  });
  assert.match(await readFile(path.join(root, 'docs/permissions.html'), 'utf8'), /Contoso service/);
  const env = clientEnvironment(root, {
    PATH: '/bin', GITHUB_TOKEN: 'never-forward', GH_TOKEN: 'never-forward',
    AZURE_CLIENT_SECRET: 'never-forward', NODE_OPTIONS: '--require untrusted.js',
    COPILOT_PROVIDER_BASE_URL: 'https://forbidden.invalid',
  });
  assert.ok(!Object.values(env).includes('never-forward'));
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.COPILOT_PROVIDER_BASE_URL, undefined);
  assert.equal(env.HOME, root);
  const local = clientEnvironment(root, {
    GH_TOKEN: 'synthetic-native-auth', AZURE_CLIENT_SECRET: 'never-forward',
    NODE_OPTIONS: '--require untrusted.js',
  }, true);
  assert.equal(local.GH_TOKEN, 'synthetic-native-auth');
  assert.equal(local.AZURE_CLIENT_SECRET, undefined);
  assert.equal(local.NODE_OPTIONS, undefined);
});

test('offline session exposes no generic execution/network tools or ambient customization', () => {
  const config = offlineSessionConfig({
    home: '/isolated', workDir: '/workspace', pluginRoot: '/plugin', skills: [],
    model: 'test-model', tools: [],
  });
  assert.ok(!config.availableTools.some(name => /bash|shell|fetch|web|mcp|task/.test(name)));
  assert.equal(config.enableConfigDiscovery, false);
  assert.equal(config.enableFileHooks, false);
  assert.equal(config.enableOnDemandInstructionDiscovery, false);
  assert.equal(config.requestExtensions, false);
  assert.deepEqual(config.skillDirectories, []);
  assert.equal(config.enableSkills, false);
  assert.equal(config.onPermissionRequest({ kind: 'shell' }).kind, 'reject');
  const contained = offlineSessionConfig({
    home: '/isolated', workDir: '/workspace', pluginRoot: '/plugin', skills: [],
    model: 'test-model', tools: createOfflineTools('/workspace', '/plugin'),
  });
  assert.equal(contained.onPermissionRequest({ kind: 'custom-tool', toolName: 'eval_write' }).kind, 'approve-once');
  assert.equal(contained.onPermissionRequest({ kind: 'custom-tool', toolName: 'bash' }).kind, 'reject');
  assert.equal(contained.onPermissionRequest({ kind: 'write', toolName: 'eval_write' }).kind, 'reject');
});

test('executor stops the SDK and registers home cleanup even after a failed agent turn', async t => {
  const root = await workspace(t);
  let stopped = 0;
  let destroyed = 0;
  let captured;
  const cleanup = [];
  const executor = new OfflineExecutor({
    pluginRoot, token: 'test-native-token',
    clientFactory: options => {
      captured = options;
      return {
        start: async () => {},
        listModels: async () => [{ id: 'test-model', capabilities: { supports: { reasoningEffort: true } }, supportedReasoningEfforts: ['medium'] }],
        createSession: async () => ({
          sendAndWait: async () => { throw new Error('test agent failure'); },
          disconnect: async () => { destroyed++; },
          rpc: {
            tools: {
              initializeAndValidate: async () => {},
              getCurrentMetadata: async () => ({ tools: TOOL_NAMES.filter(name => name !== 'skill').map(name => ({ name })) }),
            }, skills: { list: async () => ({ skills: [] }) },
          },
        }),
        stop: async () => { stopped++; },
      };
    },
  });
  await assert.rejects(() => executor.execute({ name: 'failure', prompt: 'Prepare a local plan' }, {
    workDir: root, skills: [], model: 'test-model', timeout: 500,
    registerCleanup: callback => cleanup.push(callback),
  }), /test agent failure/);
  assert.equal(captured.mode, 'empty');
  assert.equal(captured.gitHubToken, 'test-native-token');
  assert.equal(captured.env.GITHUB_TOKEN, undefined);
  assert.equal(stopped, 1);
  assert.equal(destroyed, 1);
  for (const callback of cleanup) await callback();
  await assert.rejects(() => readFile(path.join(captured.baseDirectory, 'config.json')), { code: 'ENOENT' });
});

test('executor preserves reported SDK token counts and leaves missing cache counts unknown', async t => {
  const root = await workspace(t);
  const cleanup = [];
  const executor = new OfflineExecutor({
    pluginRoot,
    clientFactory: () => ({
      start: async () => {},
      listModels: async () => [{ id: 'test-model', capabilities: { supports: { reasoningEffort: true } }, supportedReasoningEfforts: ['high'] }],
      createSession: async ({ onEvent, reasoningEffort }) => {
        assert.equal(reasoningEffort, 'high');
        return {
        sessionId: 'test-session',
        sendAndWait: async () => {
          onEvent({ type: 'assistant.usage', timestamp: '2026-01-01T00:00:00Z', data: {
            inputTokens: 100, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 8,
          } });
          onEvent({ type: 'assistant.usage', timestamp: '2026-01-01T00:00:01Z', data: {
            inputTokens: 70, outputTokens: 6, cacheReadTokens: 0,
          } });
          return { data: { content: 'done' } };
        },
        disconnect: async () => {},
        rpc: {
          tools: {
            initializeAndValidate: async () => {},
            getCurrentMetadata: async () => ({ tools: TOOL_NAMES.filter(name => name !== 'skill').map(name => ({ name })) }),
          },
          skills: { list: async () => ({ skills: [] }) },
        },
        };
      },
      stop: async () => [],
    }),
  });
  const trajectory = await executor.execute({ name: 'usage', prompt: 'Prepare a local plan' }, {
    workDir: root, skills: [], model: 'test-model', reasoningEffort: 'high', timeout: 500,
    registerCleanup: callback => cleanup.push(callback),
  });
  assert.deepEqual(trajectory.metrics.reportedTokenUsage, {
    inputTokens: 170, outputTokens: 16, cacheReadTokens: 80, cacheWriteTokens: null,
  });
  for (const callback of cleanup) await callback();
});

test('unexpected native capabilities invalidate a trial before any model request', async () => {
  const session = {
    rpc: {
      tools: {
        initializeAndValidate: async () => {},
        getCurrentMetadata: async () => ({ tools: [{ name: 'bash' }] }),
      },
    },
  };
  await assert.rejects(() => assertOfflineCatalog(session, []), /offline allowlist/);
});

test('unsupported judge choices stop the executor before any agent inference', async t => {
  const root = await workspace(t);
  for (const [judgeModel, judgeReasoningEffort] of [['missing-judge', 'medium'], ['test-judge', 'max']]) {
    let stopped = false;
    const cleanup = [];
    const executor = new OfflineExecutor({
      pluginRoot, judgeModel, judgeReasoningEffort,
      clientFactory: () => ({
        start: async () => {},
        listModels: async () => ['test-agent', 'test-judge'].map(id => ({
          id, capabilities: { supports: { reasoningEffort: true } }, supportedReasoningEfforts: ['medium'],
        })),
        createSession: async () => { assert.fail('invalid judge must be rejected before inference'); },
        stop: async () => { stopped = true; return []; },
      }),
    });
    await assert.rejects(() => executor.execute({ prompt: 'Not sent' }, {
      workDir: root, model: 'test-agent', reasoningEffort: 'medium', registerCleanup: fn => cleanup.push(fn),
    }), /unavailable|does not support/);
    assert.equal(stopped, true);
    for (const fn of cleanup) await fn();
  }
});
