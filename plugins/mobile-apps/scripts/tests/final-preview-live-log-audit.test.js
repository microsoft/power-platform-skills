'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  COMPACT_PROJECTION,
  auditJsonl,
} = require('./helpers/audit-final-preview-live-log');

function jsonl(events) {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

test('live log audit ignores prose and accepts production-only reads', () => {
  const report = auditJsonl(jsonl([
    {
      type: 'user.message',
      data: { content: 'Do not read scripts/tests/fixtures/example.js.' },
    },
    {
      type: 'tool.execution_start',
      data: {
        toolCallId: 'production-view',
        toolName: 'view',
        arguments: { path: '/plugin/skills/design-system/references/auto-experience.md' },
      },
    },
    {
      type: 'tool.execution_complete',
      data: {
        toolCallId: 'production-view',
        toolName: 'view',
        result: { content: 'Approved workflow content.' },
      },
    },
  ]));
  assert.equal(report.ok, true);
  assert.equal(report.toolCallsScanned, 1);
  assert.deepEqual(report.violations, []);
});

test('live log audit rejects an explicit prohibited read target', () => {
  const report = auditJsonl(jsonl([{
    type: 'tool.execution_start',
    data: {
      toolCallId: 'fixture-view',
      toolName: 'view',
      arguments: { path: '/plugin/scripts/tests/fixtures/final-preview-output.js' },
    },
  }]));
  assert.equal(report.ok, false);
  assert.equal(report.prohibitedReadCount, 1);
  assert.equal(report.violations[0].phase, 'arguments');
});

test('live log audit rejects prohibited paths returned by a broad search', () => {
  const report = auditJsonl(jsonl([
    {
      type: 'tool.execution_start',
      data: {
        toolCallId: 'broad-search',
        toolName: 'rg',
        arguments: { pattern: 'export const tokens', path: '/plugin/scripts' },
      },
    },
    {
      type: 'tool.execution_complete',
      data: {
        toolCallId: 'broad-search',
        toolName: 'rg',
        result: {
          content: '/plugin/scripts/tests/final-preview.test.js:export const tokens = {',
        },
      },
    },
  ]));
  assert.equal(report.ok, false);
  assert.equal(report.prohibitedReadCount, 1);
  assert.equal(report.violations[0].phase, 'result');
  assert.match(report.violations[0].excerpts[0], /scripts\/tests\/final-preview/);
});

test('live log audit fails closed on malformed JSONL', () => {
  const report = auditJsonl('{not-json}\n');
  assert.equal(report.ok, false);
  assert.equal(report.parseErrors.length, 1);
});

test('live log audit allows packaged validator execution but rejects source inspection', () => {
  const executed = auditJsonl(jsonl([{
    type: 'tool.execution_start',
    data: {
      toolCallId: 'validator-execution',
      toolName: 'bash',
      arguments: {
        command: 'node /plugin/plugins/mobile-apps/scripts/validate-product-experience-preview.js --project-root /project',
      },
    },
  }]));
  assert.equal(executed.ok, true);

  const inspected = auditJsonl(jsonl([{
    type: 'tool.execution_start',
    data: {
      toolCallId: 'validator-read',
      toolName: 'view',
      arguments: {
        path: '/plugin/plugins/mobile-apps/scripts/validate-product-experience-preview.js',
      },
    },
  }]));
  assert.equal(inspected.ok, false);
  assert.equal(inspected.violations[0].code, 'preview-implementation-source-read');
});

test('live log audit permits only compact projection reads after preparation', () => {
  const events = [
    {
      type: 'tool.execution_complete',
      data: {
        toolCallId: 'prepare',
        toolName: 'bash',
        result: { content: '{"ok":true,"mode":"contract-preparation","authoringProjectionPath":".tmp/product-experience-preview-authoring.json"}' },
      },
    },
    {
      type: 'tool.execution_start',
      data: {
        toolCallId: 'compact-read',
        toolName: 'view',
        arguments: { path: '/project/.tmp/product-experience-preview-authoring.json' },
      },
    },
    {
      type: 'tool.execution_start',
      data: {
        toolCallId: 'full-read',
        toolName: 'view',
        arguments: { path: '/project/.tmp/product-experience-final-preview-contract.json' },
      },
    },
  ];
  const report = auditJsonl(jsonl(events));
  assert.equal(report.contractPrepared, true);
  assert.equal(report.ok, false);
  assert.ok(report.violations.some(
    (violation) => violation.code === 'full-contract-reread-after-projection',
  ));
  assert.ok(report.filesRead.some((file) => COMPACT_PROJECTION.test(file)));
});

test('live log audit rejects repeated automatic references and ad-hoc generators', () => {
  const reference = '/plugin/plugins/mobile-apps/skills/design-system/references/design-system-schema.md';
  const report = auditJsonl(jsonl([
    {
      type: 'tool.execution_start',
      data: { toolCallId: 'schema-1', toolName: 'view', arguments: { path: reference } },
    },
    {
      type: 'tool.execution_start',
      data: { toolCallId: 'schema-2', toolName: 'view', arguments: { path: reference } },
    },
    {
      type: 'tool.execution_start',
      data: {
        toolCallId: 'generator',
        toolName: 'bash',
        arguments: { command: 'node .tmp/generate-preview-contract.js' },
      },
    },
  ]));
  assert.equal(report.ok, false);
  assert.ok(report.violations.some(
    (violation) => violation.code === 'automatic-reference-reread',
  ));
  assert.ok(report.violations.some(
    (violation) => violation.code === 'ad-hoc-preview-generator',
  ));
});