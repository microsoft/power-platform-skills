'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTemplateOutcomeEvent, emitTemplateOutcome, normalizeBool, sanitizeTemplateOutcomeInfo } = require('../lib/create-site-template-telemetry');
const { parseArgs, run } = require('../emit-create-site-template-outcome');

test('buildTemplateOutcomeEvent emits non-PII template eventInfo through the existing skill event shape', () => {
  const event = buildTemplateOutcomeEvent({
    eventName: 'template_used',
    templateId: 'company-portal',
    templateKind: 'spa',
    framework: 'react',
    audience: 'internal',
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
    framework: 'react',
    audience: 'internal',
    templateId: 'company-portal',
    templateKind: 'spa',
  });
  assert.equal('siteUrl' in event.data.eventInfo, false);
});

test('buildTemplateOutcomeEvent emits import result details separately from template selection', () => {
  const success = buildTemplateOutcomeEvent({
    eventName: 'template_import_success',
    templateId: 'company-portal',
    templateKind: 'spa',
    framework: 'react',
    audience: 'internal',
    seedApplied: 'true',
    correlationId: 'corr',
  }, {
    readPacAuth: () => null,
    readAgentInfo: () => ({}),
    randomUUID: () => 'corr',
  });
  assert.equal(success.data.eventName, 'template_import_success');
  assert.deepEqual(success.data.eventInfo, {
    framework: 'react',
    audience: 'internal',
    templateId: 'company-portal',
    templateKind: 'spa',
    seedApplied: true,
  });

  const failure = buildTemplateOutcomeEvent({
    eventName: 'template_import_failure',
    templateId: 'company-portal',
    templateKind: 'spa',
    framework: 'react',
    audience: 'internal',
    outcome: 'failure',
    errorClass: 'ImportSolutionAsync',
    errorDescription: 'Async operation failed',
    correlationId: 'corr',
  }, {
    readPacAuth: () => null,
    readAgentInfo: () => ({}),
    randomUUID: () => 'corr',
  });
  assert.equal(failure.data.eventName, 'template_import_failure');
  assert.equal(failure.data.outcome, 'failure');
  assert.equal(failure.data.errorClass, 'ImportSolutionAsync');
  assert.equal(failure.data.errorDescription, 'Async operation failed');
  assert.equal(failure.data.severity, 'Error');
});

test('buildTemplateOutcomeEvent emits clone result events separately from import events', () => {
  const success = buildTemplateOutcomeEvent({
    eventName: 'template_clone_success',
    templateId: 'supplier-portal',
    templateKind: 'spa',
    framework: 'vue',
    audience: 'external',
    correlationId: 'corr',
  }, {
    readPacAuth: () => null,
    readAgentInfo: () => ({}),
    randomUUID: () => 'corr',
  });

  assert.equal(success.data.eventName, 'template_clone_success');
  assert.deepEqual(success.data.eventInfo, {
    framework: 'vue',
    audience: 'external',
    templateId: 'supplier-portal',
    templateKind: 'spa',
  });

  const failure = buildTemplateOutcomeEvent({
    eventName: 'template_clone_failure',
    templateId: 'supplier-portal',
    templateKind: 'spa',
    framework: 'vue',
    audience: 'external',
    outcome: 'failure',
    errorClass: 'PacPagesClone',
    errorDescription: 'clone failed',
    correlationId: 'corr',
  }, {
    readPacAuth: () => null,
    readAgentInfo: () => ({}),
    randomUUID: () => 'corr',
  });

  assert.equal(failure.data.eventName, 'template_clone_failure');
  assert.equal(failure.data.outcome, 'failure');
  assert.equal(failure.data.errorClass, 'PacPagesClone');
  assert.equal(failure.data.errorDescription, 'clone failed');
  assert.equal(failure.data.severity, 'Error');
});

test('buildTemplateOutcomeEvent emits scratch branch adoption signal', () => {
  const event = buildTemplateOutcomeEvent({
    eventName: 'create_site_from_scratch',
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

  assert.equal(event.data.eventName, 'create_site_from_scratch');
  assert.deepEqual(event.data.eventInfo, { framework: 'vue', audience: 'external' });
  assert.equal(event.data.sessionId, 'copilot-session');
});

test('emitTemplateOutcome is fail-closed and delegates to telemetry dispatcher seam', () => {
  const emitted = [];
  const opts = [];
  const result = emitTemplateOutcome({ eventName: 'create_site_from_scratch', framework: 'react', audience: 'internal' }, {
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
  assert.deepEqual(parseArgs(['--eventName', 'template_import_success', '--templateKind', 'spa', '--seedApplied', '1', '--quiet']), { eventName: 'template_import_success', templateKind: 'spa', seedApplied: '1', quiet: true });
  assert.equal(normalizeBool('1'), true);
  assert.equal(normalizeBool('false'), false);
});

test('run ignores quiet flag when building the telemetry event', () => {
  const result = run(['--eventName', 'template_used', '--templateId', 'company-portal', '--framework', 'react', '--templateKind', 'spa', '--audience', 'internal', '--quiet'], {
    readPacAuth: () => null,
    readAgentInfo: () => ({}),
    randomUUID: () => 'corr',
    fireAndForget: () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.event.data.eventName, 'template_used');
});

test('sanitizeTemplateOutcomeInfo drops invalid dynamic telemetry values', () => {
  assert.deepEqual(sanitizeTemplateOutcomeInfo({
    eventName: 'template_used',
    templateId: 'Company Portal',
    templateKind: 'liquid',
    framework: 'nextjs',
    audience: 'everyone',
    importOutcome: 'maybe',
    activationOutcome: 'pending',
    seedApplied: '0',
    siteUrl: 'https://example.test',
  }), {});
});
