'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTemplateOutcomeEvent, emitTemplateOutcome, normalizeBool, sanitizeTemplateOutcomeInfo } = require('../lib/create-site-template-telemetry');
const { parseArgs } = require('../emit-create-site-template-outcome');

test('buildTemplateOutcomeEvent emits non-PII template eventInfo through the existing skill event shape', () => {
  const event = buildTemplateOutcomeEvent({
    mode: 'template',
    templateId: 'company-portal',
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
    randomUUID: () => 'ignored',
  });

  assert.equal(event.name, 'PagesAIPluginEvent');
  assert.equal(event.data.eventName, 'template_outcome');
  assert.equal(event.data.skillName, 'create-site');
  assert.deepEqual(event.data.eventInfo, {
    mode: 'template',
    framework: 'react',
    audience: 'internal',
    templateId: 'company-portal',
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
  }, { readPacAuth: () => null, randomUUID: () => 'corr' });

  assert.deepEqual(event.data.eventInfo, { mode: 'scratch', framework: 'vue', audience: 'external' });
});

test('emitTemplateOutcome is fail-closed and delegates to telemetry dispatcher seam', () => {
  const emitted = [];
  const opts = [];
  const result = emitTemplateOutcome({ mode: 'scratch', framework: 'react', audience: 'internal' }, {
    readPacAuth: () => ({ cloud: 'Public' }),
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
  assert.deepEqual(parseArgs(['--mode', 'template', '--seedApplied', '1']), { mode: 'template', seedApplied: '1' });
  assert.equal(normalizeBool('1'), true);
  assert.equal(normalizeBool('false'), false);
});

test('sanitizeTemplateOutcomeInfo drops invalid dynamic telemetry values', () => {
  assert.deepEqual(sanitizeTemplateOutcomeInfo({
    mode: 'template',
    templateId: 'Company Portal',
    framework: 'nextjs',
    audience: 'everyone',
    importOutcome: 'maybe',
    activationOutcome: 'pending',
    seedApplied: '0',
    siteUrl: 'https://example.test',
  }), { mode: 'template', seedApplied: false });
});
