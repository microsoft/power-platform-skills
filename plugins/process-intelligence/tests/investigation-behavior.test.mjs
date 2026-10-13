// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateInvestigation } from './investigation-behavior.mjs';
import { groups } from './investigation-scenarios.mjs';

const direct = () => ({
  id: 'direct-ranking',
  actions: [{ tool: 'get_bottleneck_analysis_v2', arguments: { processId: 'P', itemsPerPage: 5, itemsToSkip: 0 }, replyRef: 'Rbottleneck' }],
  answer: 'Review has a mean activity duration of two hours.',
  retained: { route: 'analyze-performance' }
});
const analytics = () => [direct(),
  { id: 'broad-routing', actions: [{ tool: 'ask_user', arguments: { question: 'How is full settlement defined?' } }],
    answer: 'Confirm the business outcome.', retained: { route: 'investigate-process', status: 'inconclusive' } },
  { id: 'overview-continuation', actions: groups.analytics[2].replies.map(r => ({ tool: r.tool, arguments: r.arguments, replyRef: r.ref })),
    answer: '12 leading variants cover 24 of 30 cases (80%).', retained: { affectedCount: 24, denominator: 30 } }
];
test('investigation fixtures cover eight workflows and distinct decision cases', () => {
  assert.equal(Object.keys(groups).length, 8);
  const rows = Object.values(groups).flat();
  assert.equal(new Set(rows.map(s => s.id)).size, rows.length);
  assert.ok(rows.length >= 20);
});
test('checker accepts continued evidence and minimal direct query', () => {
  assert.ok(evaluateInvestigation('analytics', analytics()).every(r => r.pass));
});
test('checker rejects invented arguments, missing coverage and mandatory ceremony', () => {
  for (const change of [
    rows => { rows[0].actions[0].arguments.attributeName = 'Step'; },
    rows => { rows[2].actions.pop(); },
    rows => { rows[0].actions.unshift({ tool: 'ask_user', arguments: { question: 'First list three hypotheses?' } }); },
    rows => { rows[2].retained.denominator = 15; }
  ]) {
    const rows = analytics(); change(rows);
    assert.ok(evaluateInvestigation('analytics', rows).some(r => !r.pass));
  }
});
test('checker rejects duplicate and missing scenarios', () => {
  assert.throws(() => evaluateInvestigation('analytics', analytics().slice(1)));
  const rows = analytics(); rows[1].id = rows[0].id;
  assert.throws(() => evaluateInvestigation('analytics', rows));
});

const actions = scenario => scenario.replies.map(reply => ({
  tool: reply.tool, arguments: reply.arguments, replyRef: reply.ref
}));
test('six justified analytical pages pass but replay and early quota stops fail', () => {
  const rows = [
    { id: 'edge-continuation', actions: actions(groups['analyze-performance'][0]),
      answer: 'S119 has the largest mean Duration across 120 edges.', retained: {} },
    { id: 'mean-not-savings', actions: [], answer: 'Cannot infer guaranteed savings.', retained: {} }
  ];
  assert.ok(evaluateInvestigation('analyze-performance', rows).every(r => r.pass));
  const limited = structuredClone(rows); limited[0].actions = limited[0].actions.slice(0, 4);
  assert.ok(evaluateInvestigation('analyze-performance', limited).some(r => !r.pass));
  rows[0].actions.push(rows[0].actions[0]);
  assert.ok(evaluateInvestigation('analyze-performance', rows).some(r => !r.pass));
});
test('outcome-conditioned filter leakage fails even with genuine fixture replies', () => {
  const s = groups['compare-cohorts'];
  const rows = [
    { id: 'frozen-baseline', actions: actions(s[0]).slice(0, 2),
      answer: 'Maturity and closure are unknown.', retained: { baselineFilters: {} } },
    { id: 'cohort-refresh', actions: actions(s[1]),
      answer: 'Stale evidence; rerun the pair.', retained: { status: 'inconclusive' } }
  ];
  assert.ok(evaluateInvestigation('compare-cohorts', rows).every(r => r.pass));
  rows[0].actions = actions(s[0]).slice(2);
  assert.equal(evaluateInvestigation('compare-cohorts', rows)[0].pass, false);
});

test('pending and consumed-result safeguards are independent of analytical call counts', () => {
  const s = groups['investigate-process'];
  const rows = s.map(scenario => ({
    id: scenario.id, actions: actions(scenario), answer: 'Placeholder for unrelated checks in this focused mutation test.',
    retained: { status: 'inconclusive' }
  }));
  const pending = rows.find(r => r.id === 'pending-safeguard');
  pending.retained = { status: 'pending', operationId: 'OP',
    request: { tool: 'get_process_overall_metrics_v2', arguments: { processId: 'P' } } };
  pending.actions.slice(1).forEach((a, i) => { a.waitBeforeSeconds = i ? 30 : 5; });
  const completed = rows.find(r => r.id === 'consumed-result');
  completed.answer = '20 cases from Rcompleted.';
  const result = () => evaluateInvestigation('investigate-process', rows);
  assert.equal(result().find(r => r.id === pending.id).pass, true);
  assert.equal(result().find(r => r.id === completed.id).pass, true);
  const early = structuredClone(rows);
  early.find(r => r.id === pending.id).actions = pending.actions.slice(0, 7);
  assert.equal(evaluateInvestigation('investigate-process', early).find(r => r.id === pending.id).pass, false);
  const rushed = structuredClone(rows);
  rushed.find(r => r.id === pending.id).actions[1].waitBeforeSeconds = 0;
  assert.equal(evaluateInvestigation('investigate-process', rushed).find(r => r.id === pending.id).pass, false);
  pending.actions.push(pending.actions[1]);
  completed.actions.push({ tool: 'get_operation_result', arguments: { operationId: 'OP' }, replyRef: 'Rcompleted' });
  assert.equal(result().find(r => r.id === pending.id).pass, false);
  assert.equal(result().find(r => r.id === completed.id).pass, false);
});

test('default normalization never permits unsupported edge sort or filter arguments', () => {
  for (const invalid of [{ sortOrder: 'Descending' }, { metricToSortBy: 'Duration' },
    { filters: {} }, { filterOptions: [] }]) {
    const rows = [
      { id: 'edge-continuation', actions: structuredClone(actions(groups['analyze-performance'][0])),
        answer: 'S119 has the largest mean Duration across 120 edges.', retained: {} },
      { id: 'mean-not-savings', actions: [], answer: 'Cannot infer guaranteed savings.', retained: {} }
    ];
    Object.assign(rows[0].actions[0].arguments, invalid);
    assert.equal(evaluateInvestigation('analyze-performance', rows)[0].pass, false);
  }
});
