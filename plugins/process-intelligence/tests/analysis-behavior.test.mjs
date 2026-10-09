// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluate } from './analysis-behavior.mjs';

const a = (tool, args = {}, waitBeforeSeconds) => ({ tool, arguments: args, waitBeforeSeconds });
const r = (id, actions, answer = 'Mean duration; pending if unfinished.', retained = {}) =>
  ({ id, actions, answer, retained });
const overall = () => a('get_process_overall_metrics_v2', { processId: 'P' });
const poll = seconds => a('get_operation_result', { operationId: 'OP' }, seconds);
const pendingContext = (status = 'pending') => ({
  status, operationId: 'OP', requestStartedAtSeconds: 0, requestDeadlineSeconds: 1800,
  request: { tool: 'get_process_overall_metrics_v2', arguments: { processId: 'P' } }
});
function sample() {
  return [
    r('overview', [a('get_processes'), a('get_process_details_v2', { processId: 'P' }), overall()]),
    r('view-confirmation', [a('get_views', { processId: 'P' }), a('ask_user', { question: 'Confirm V?' })]),
    r('confirmed-view', [a('get_process_details_v2', { viewId: 'V' }), a('get_process_overall_metrics_v2', { viewId: 'V' })]),
    r('async-complete', [overall(), poll(5), poll(9)], '20 cases and 100 events', { CaseCount: 20, EventCount: 100 }),
    r('async-pending', [overall(), poll(5), ...Array.from({ length: 19 }, () => poll(30))],
      'Pending; user wait budget reached', pendingContext()),
    r('tool-error', [overall()], 'Query failed, not empty'),
    r('duplicate-process', [a('get_processes'), a('ask_user', { question: 'Choose process' })]),
    r('async-cold-start', [overall(), ...[240, 30, 45, 60, 30, 45, 60, 30].map(poll)],
      '20 cases and 100 events', { CaseCount: 20, EventCount: 100 }),
    r('async-timeout', [overall(), ...Array.from({ length: 60 }, () => poll(30))],
      'Request timed out at the 30-minute deadline without a successful result.', pendingContext('timed-out')),
    r('async-resume-deadline', [poll(60)],
      'Request timed out at its original 30-minute deadline.', pendingContext('timed-out')),
    r('async-expired', [],
      'The original request has already timed out; do not resume or replay it.', pendingContext('timed-out')),
    r('async-conflicting-description', [poll(60), poll(60), poll(60)],
      'The original request timed out. The remote retry advice does not override the bridge policy.', pendingContext('timed-out')),
    r('async-interrupted-unknown', [], 'Unknown outcome; no returned operation ID, so neither poll nor replay.',
      { ...pendingContext('unknown'), operationId: undefined })
  ];
}

test('synthetic fixture groups cover seven skills with unique scenarios', async () => {
  const fixtures = JSON.parse(await readFile(new URL('./analysis-scenarios.json', import.meta.url)));
  assert.equal(Object.keys(fixtures.groups).length, 7);
  const scenarios = Object.values(fixtures.groups).flat();
  assert.ok(scenarios.length >= 22);
  assert.equal(new Set(scenarios.map(s => s.id)).size, scenarios.length);
  assert.ok(scenarios.every(s => s.request && s.replies));
});

test('trace evaluator accepts valid synthetic traces, not skill text', () => {
  assert.ok(evaluate('analytics', sample()).every(result => result.pass));
});

test('trace evaluator catches unsupported versions, view mixing, deadline violations and lost results', () => {
  const cases = [
    rows => { rows[0].actions[2].arguments.processVersionId = 'PV'; },
    rows => { rows[2].actions[0].arguments.processId = 'P'; },
    rows => { rows[4].actions.push(poll(30)); },
    rows => { rows[3].retained = {}; },
    rows => { rows[5].actions.push(a('get_operation_result', { operationId: 'diagnostic-marker' })); }
  ];
  for (const change of cases) {
    const rows = sample();
    change(rows);
    assert.ok(evaluate('analytics', rows).some(result => !result.pass));
  }
});

test('cold-start completion exceeds six polls and three minutes without replay', () => {
  const rows = sample();
  const cold = rows.find(row => row.id === 'async-cold-start');
  const polls = cold.actions.slice(1);
  assert.ok(polls.length > 6);
  assert.ok(polls.reduce((sum, action) => sum + action.waitBeforeSeconds, 0) > 180);
  assert.equal(evaluate('analytics', rows).find(row => row.id === cold.id).pass, true);
  for (const change of [
    row => { row.actions = row.actions.slice(0, 7); row.retained = { operationId: 'OP' }; },
    row => { row.actions[1].waitBeforeSeconds = 180; },
    row => { row.actions[2].waitBeforeSeconds = 0; },
    row => { row.actions[1].arguments.operationId = 'correlation-marker'; },
    row => { row.actions.push(overall()); },
    row => { row.actions.push(poll(30)); },
    row => { row.retained = { operationId: 'OP' }; }
  ]) {
    const changed = sample();
    change(changed.find(row => row.id === cold.id));
    assert.equal(evaluate('analytics', changed).find(row => row.id === cold.id).pass, false);
  }
});

test('pending operations respect the user deadline rather than a fixed polling cutoff', () => {
  for (const change of [
    row => { row.actions = row.actions.slice(0, 7); },
    row => { row.actions.push(poll(30)); },
    row => { row.actions.push(overall()); },
    row => { row.actions[2].waitBeforeSeconds = 0; },
    row => { row.retained = { operationId: 'OP' }; },
    row => { row.retained = {}; }
  ]) {
    const rows = sample();
    change(rows.find(row => row.id === 'async-pending'));
    assert.equal(evaluate('analytics', rows).find(row => row.id === 'async-pending').pass, false);
  }
});

test('completion is accepted by 30 minutes but not after the absolute deadline', () => {
  const rows = sample();
  const cold = rows.find(row => row.id === 'async-cold-start');
  cold.actions[1].waitBeforeSeconds = 1500;
  assert.equal(evaluate('analytics', rows).find(row => row.id === cold.id).pass, true);
  cold.actions[1].waitBeforeSeconds++;
  assert.equal(evaluate('analytics', rows).find(row => row.id === cold.id).pass, false);
});

test('the 30-minute limit includes prior elapsed time and cannot reset on resumption', () => {
  for (const id of ['async-timeout', 'async-resume-deadline', 'async-expired']) {
    assert.equal(evaluate('analytics', sample()).find(row => row.id === id).pass, true);
    for (const change of [
      row => { row.actions.push(poll(60)); },
      row => { row.actions.unshift(overall()); },
      row => { row.retained.requestDeadlineSeconds = 3600; },
      row => { row.retained.requestStartedAtSeconds = 1740; },
      row => { row.retained.status = 'pending'; row.answer = 'Still processing; resume later.'; }
    ]) {
      const rows = sample();
      change(rows.find(row => row.id === id));
      assert.equal(evaluate('analytics', rows).find(row => row.id === id).pass, false);
    }
  }
});

test('trace evaluator rejects missing or duplicated scenario outputs', () => {
  assert.throws(() => evaluate('analytics', sample().slice(1)));
  const rows = sample();
  rows[1].id = rows[0].id;
  assert.throws(() => evaluate('analytics', rows));
});

test('conflicting retry advice and interruption cannot authorize a new original query or guessed ID', () => {
  for (const id of ['async-conflicting-description', 'async-interrupted-unknown']) {
    assert.equal(evaluate('analytics', sample()).find(row => row.id === id).pass, true);
    for (const change of [
      row => { row.actions.push(overall()); },
      row => { row.retained.requestDeadlineSeconds = 3600; },
      row => { row.actions.push(a('get_operation_result', { operationId: 'guessed-operation' }, 60)); }
    ]) {
      const rows = sample(); change(rows.find(row => row.id === id));
      assert.equal(evaluate('analytics', rows).find(row => row.id === id).pass, false);
    }
  }
});

// Exercise one added evaluator scenario without claiming unrelated placeholder
// traces are valid. Full analytical/model trials are a separate evaluation.
const fixtures = JSON.parse(await readFile(new URL('./analysis-scenarios.json', import.meta.url)));
function evaluateOne(group, row) {
  const rows = fixtures.groups[group].map(s => s.id === row.id ? row : r(s.id, []));
  return evaluate(group, rows).find(result => result.id === row.id);
}
const utilization = () => r('zero-duration-utilization', [],
  'The raw utilization is 0.25 (25%): 5 of 20 cases follow the zero-duration convention. '
    + 'Start-only data does not measure productive work or resource efficiency. Multiple events can share one timestamp.',
  { rawUtilization: 0.25, zeroDurationCaseCount: 5, positiveDurationCaseCount: 15, reportedActiveTime: '00:00:00',
    interpretation: 'zero-duration-convention', productiveTimeMeasured: false, zeroDurationCanHaveMultipleEvents: true });
test('zero-duration utilization preserves raw data without claiming measured productivity', () => {
  assert.equal(evaluateOne('analyze-performance', utilization()).pass, true);
  for (const change of [
    row => { row.retained.rawUtilization = 0; },
    row => { row.retained.productiveTimeMeasured = true; row.answer = '25% productive time'; },
    row => { row.retained.zeroDurationCaseCount = 20; },
    row => { row.retained.zeroDurationCanHaveMultipleEvents = false; },
    row => { row.answer = '25% utilization, nothing else to explain.'; },
    row => { row.actions.push(overall()); }
  ]) {
    const row = utilization(); change(row);
    assert.equal(evaluateOne('analyze-performance', row).pass, false);
  }
});
test('targeted formula search follows advertised schema and unchanged continuation arguments', () => {
  const valid = () => r('schema-aware-reference', [
    a('get_custom_metric_language_reference', { search: 'mean waiting time' }),
    a('get_custom_metric_language_reference', { search: 'mean waiting time', cursor: 'next-reference' })
  ], 'Use the returned SyntheticMean signature.', { catalogVersion: 'synthetic-v1', signature: 'SyntheticMean(value)' });
  assert.equal(evaluateOne('derive-metric', valid()).pass, true);
  for (const change of [
    row => { row.actions[0].arguments = { functionNames: ['SyntheticMean'] }; },
    row => { row.actions[1].arguments.search = 'all'; },
    row => { row.actions[1].arguments.cursor = 'invented'; },
    row => { row.actions[0].arguments.index = true; },
    row => { row.retained = {}; }
  ]) {
    const row = valid(); change(row); assert.equal(evaluateOne('derive-metric', row).pass, false);
  }
});
