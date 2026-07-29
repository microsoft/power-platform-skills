'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTemplateOutcomeEvent, emitTemplateOutcome, normalizeBool, sanitizeTemplateOutcomeInfo } = require('../lib/create-site-template-telemetry');
const { parseArgs } = require('../emit-create-site-template-outcome');

test('buildTemplateOutcomeEvent emits non-PII template eventInfo through the existing skill event shape', () => {
  const event = buildTemplateOutcomeEvent({
    mode: 'template',
    templateId: 'company-portal',
    templateKind: 'spa',
    framework: 'react',
    audience: 'internal',
    importOutcome: 'success',
    activationOutcome: 'success',
    seedApplied: 'true',
    correlationId: 'corr',
    sessionId: 'session',
    osName: 'darwin',
    osVersion: '1',
    nodeVersion: 'v24',
  }, {
    readPacAuth: () => ({ orgId: 'org', tenantId: 'tenant' }),
    readAgentInfo: () => ({ aiAgentName: 'Copilot CLI', aiAgentVersion: '1.0.76-0', pacCliVersion: '2.10.1' }),
    pluginVersion: '2.7.0',
    randomUUID: () => 'ignored',
  });

  assert.equal(event.name, 'PagesAIPluginEvent');
  assert.equal(event.data.eventName, 'template_used');
  assert.equal(event.data.skillName, 'create-site');
  assert.equal(event.data.pluginVersion, '2.7.0');
  assert.equal(event.data.sessionId, 'session');
  assert.equal(event.data.aiAgentName, 'Copilot CLI');
  assert.equal(event.data.aiAgentVersion, '1.0.76-0');
  assert.equal(event.data.pacCliVersion, '2.10.1');
  assert.deepEqual(event.data.eventInfo, {
    mode: 'template',
    framework: 'react',
    audience: 'internal',
    templateId: 'company-portal',
    templateKind: 'spa',
    importOutcome: 'success',
    activationOutcome: 'success',
    seedApplied: true,
  });
  assert.equal('siteUrl' in event.data.eventInfo, false);
});

test('buildTemplateOutcomeEvent emits scratch branch adoption signal', () => {
  const event = buildTemplateOutcomeEvent({
    mode: 'scratch',
    framework: 'vue',
    audience: 'external',
    correlationId: 'corr',
  }, {
    readPacAuth: () => null,
    readAgentInfo: () => ({}),
    randomUUID: () => 'corr',
    env: { COPILOT_AGENT_SESSION_ID: 'copilot-session' },
    pluginVersion: '2.7.0',
  });

  assert.deepEqual(event.data.eventInfo, { mode: 'scratch', framework: 'vue', audience: 'external' });
  assert.equal(event.data.sessionId, 'copilot-session');
});

test('emitTemplateOutcome is fail-closed and delegates to telemetry dispatcher seam', () => {
  const emitted = [];
  const opts = [];
  const result = emitTemplateOutcome({ mode: 'scratch', framework: 'react', audience: 'internal' }, {
    readPacAuth: () => ({ cloud: 'Public' }),
    readAgentInfo: () => ({}),
    randomUUID: () => 'corr',
    fireAndForget: (event, options) => {
      emitted.push(event);
      opts.push(options);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(emitted.length, 1);
  assert.equal(opts[0].cloud, 'Public');

  const failure = emitTemplateOutcome({}, { readPacAuth: () => null, fireAndForget: () => { throw new Error('nope'); } });
  assert.equal(failure.ok, false);
});

test('parseArgs and normalizeBool handle CLI values', () => {
  assert.deepEqual(parseArgs(['--mode', 'template', '--templateKind', 'spa', '--seedApplied', '1']), { mode: 'template', templateKind: 'spa', seedApplied: '1' });
  assert.equal(normalizeBool('1'), true);
  assert.equal(normalizeBool('false'), false);
});

test('sanitizeTemplateOutcomeInfo drops invalid dynamic telemetry values', () => {
  assert.deepEqual(sanitizeTemplateOutcomeInfo({
    mode: 'template',
    templateId: 'Company Portal',
    templateKind: 'liquid',
    framework: 'nextjs',
    audience: 'everyone',
    importOutcome: 'maybe',
    activationOutcome: 'pending',
    seedApplied: '0',
    siteUrl: 'https://example.test',
  }), { mode: 'template', seedApplied: false });
});
