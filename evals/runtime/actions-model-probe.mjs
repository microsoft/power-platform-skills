import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clientEnvironment } from './offline-executor.mjs';

const require = createRequire(import.meta.url);
const cliLoader = path.join(path.dirname(require.resolve('@github/copilot/package.json')), 'npm-loader.js');
const efforts = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
const requested = ['claude-opus-5', 'claude-opus-5.5', 'claude-sonnet-5.5', 'gpt-6-astra', 'gpt-6.1-sol'];
if (!process.env.GITHUB_TOKEN) throw new Error('An explicit Actions token is required');

console.log('[DEBUG-catalog] versions', JSON.stringify({
  cli: require('@github/copilot/package.json').version,
  sdk: require('./package.json').dependencies['@github/copilot-sdk'],
}));

for (const mode of ['empty', 'copilot-cli']) {
  const home = await mkdtemp(path.join(tmpdir(), 'pp-actions-model-probe-'));
  const client = new CopilotClient({
    mode, baseDirectory: home, workingDirectory: home,
    connection: RuntimeConnection.forStdio({ path: process.execPath, args: [cliLoader] }),
    env: clientEnvironment(home), gitHubToken: process.env.GITHUB_TOKEN, useLoggedInUser: false,
  });
  let stage = 'start';
  try {
    await client.start();
    stage = 'authentication';
    const auth = await client.getAuthStatus();
    console.log('[DEBUG-catalog] auth', JSON.stringify({ mode, authenticated: auth.isAuthenticated ?? null }));
    stage = 'catalog';
    const models = await client.listModels();
    const catalog = models.map(model => {
      if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(model.id)) throw new Error('Unexpected model ID format');
      return {
        id: model.id,
        policy: ['enabled', 'disabled', 'unconfigured'].includes(model.policy?.state) ? model.policy.state : 'unreported',
        supportsReasoningEffort: model.capabilities?.supports?.reasoningEffort ?? null,
        reasoningEfforts: model.supportedReasoningEfforts?.filter(effort => efforts.has(effort)) ?? null,
      };
    });
    console.log('[DEBUG-catalog] models', JSON.stringify({ mode, catalog }));
    for (const model of requested) {
      const entry = models.find(item => item.id === model);
      console.log('[DEBUG-catalog] requested', JSON.stringify({
        mode, model, status: !entry ? 'missing' : entry.policy?.state === 'disabled' ? 'disabled' : 'listed',
      }));
    }
    if (mode === 'empty') {
      for (const model of ['claude-opus-4.8', 'claude-sonnet-5.5', 'gpt-6.1-sol']) {
        const entry = models.find(item => item.id === model);
        if (!entry || entry.policy?.state === 'disabled') continue;
        stage = `inference:${model}`;
        const session = await client.createSession({
          model, reasoningEffort: 'medium', availableTools: [], tools: [],
          workingDirectory: home, configDirectory: home,
          enableConfigDiscovery: false, enableFileHooks: false, requestExtensions: false,
          enableOnDemandInstructionDiscovery: false, enableHostGitOperations: false,
          enableSessionStore: false, requestCanvasRenderer: false,
          mcpServers: {}, disabledMcpServers: ['github'],
          skillDirectories: [], includedBuiltinSkills: [], enableSkills: false,
          onPermissionRequest: () => ({ kind: 'reject', feedback: 'No tools allowed in catalog probe' }),
        });
        try {
          const response = await session.sendAndWait({ prompt: 'Reply exactly ACTIONS_MODEL_OK. Do not use tools.' }, 120_000);
          const passed = response?.data?.content?.trim() === 'ACTIONS_MODEL_OK';
          console.log('[DEBUG-catalog] inference', JSON.stringify({ mode, model, passed }));
          if (!passed) process.exitCode = 1;
        } finally {
          await session.disconnect();
        }
      }
    }
  } catch (error) {
    console.error('[DEBUG-catalog] failure', JSON.stringify({
      mode, stage,
      kind: /^[A-Za-z]+Error$/.test(error.name) ? error.name : 'Error',
      status: Number.isInteger(error.status) ? error.status : null,
    }));
    process.exitCode = 1;
  } finally {
    try {
      const errors = await client.stop();
      if (errors?.length) throw new Error('Probe runtime cleanup failed');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}
