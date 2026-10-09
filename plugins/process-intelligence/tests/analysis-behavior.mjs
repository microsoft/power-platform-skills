// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const fixtures = JSON.parse(await readFile(new URL('./analysis-scenarios.json', import.meta.url), 'utf8'));
const argsFor = (r, tool) => r.actions.filter(a => a.tool === tool).map(a => a.arguments);
const names = r => r.actions.filter(a => !['ask_user', 'stop'].includes(a.tool)).map(a => a.tool);
const exact = (r, tools) => assert.deepEqual(names(r), tools);
const call = (r, tool) => {
  const args = argsFor(r, tool);
  assert.ok(args.length, `Missing ${tool}`);
  return args[0];
};
const no = (r, pattern) => assert.ok(!names(r).some(t => pattern.test(t)), `Forbidden call matching ${pattern}`);
const cases = 'get_cases_with_metrics_v2';
const overall = 'get_process_overall_metrics_v2';
const stats = 'get_attribute_statistics';
const validate = 'validate_custom_metric_formula';
const operationLimitSeconds = 30 * 60;

const completedOperation = (r, scenario) => {
  const replies = scenario.replies.get_operation_result;
  exact(r, [overall, ...replies.map(() => 'get_operation_result')]);
  const polls = r.actions.filter(a => a.tool === 'get_operation_result');
  polls.forEach((action, i) => {
    const previous = i ? replies[i - 1] : scenario.replies[overall];
    assert.equal(action.arguments.operationId, 'OP');
    assert.ok(Number.isFinite(action.waitBeforeSeconds) && action.waitBeforeSeconds >= previous.retryAfterSeconds);
  });
  const elapsed = (scenario.contextOverrides?.operationElapsedSeconds ?? 0)
    + polls.reduce((sum, action) => sum + action.waitBeforeSeconds, 0);
  assert.ok(elapsed <= Math.min(operationLimitSeconds, scenario.contextOverrides?.waitBudgetSeconds ?? operationLimitSeconds),
    'Completion must fit within the original request deadline');
  for (const value of Object.values(replies.at(-1))) {
    assert.ok(JSON.stringify(r.retained).includes(String(value)), 'Keep completed data, not only OP');
  }
};

const unfinishedOperation = (r, scenario) => {
  const context = scenario.contextOverrides ?? {};
  let elapsed = context.operationElapsedSeconds ?? 0;
  if (elapsed >= operationLimitSeconds) {
    exact(r, []);
  } else {
    const polls = r.actions.filter(a => a.tool === 'get_operation_result');
    const repeated = scenario.replies.get_operation_result;
    assert.ok(polls.length > 0 && polls.length <= repeated.repeat, 'Use only supplied synthetic replies');
    exact(r, [...(context.pendingOperation ? [] : [overall]), ...polls.map(() => 'get_operation_result')]);
    polls.forEach((a, i) => {
      assert.equal(a.arguments.operationId, 'OP');
      const previous = i ? repeated.response : context.pendingOperation ?? scenario.replies[overall];
      assert.ok(Number.isFinite(a.waitBeforeSeconds) && a.waitBeforeSeconds >= previous.retryAfterSeconds);
      elapsed += a.waitBeforeSeconds;
    });
    const deadline = Math.min(operationLimitSeconds, context.waitBudgetSeconds ?? operationLimitSeconds);
    assert.ok(elapsed <= deadline, 'Respect the original 30-minute deadline and any earlier user deadline');
    assert.ok(elapsed + repeated.response.retryAfterSeconds > deadline, 'Do not stop early at a fixed polling cutoff');
  }
  assert.ok(JSON.stringify(r.retained).includes('OP'));
  assert.match(JSON.stringify(r.retained), /get_process_overall_metrics_v2/);
  assert.match(JSON.stringify(r.retained), /"processId":"P"/);
  assert.equal(r.retained.requestStartedAtSeconds, 0, 'Preserve original submission time across pauses');
  assert.equal(r.retained.requestDeadlineSeconds, operationLimitSeconds, 'Never reset the request deadline');
  if (elapsed >= operationLimitSeconds) {
    assert.equal(r.retained.status, 'timed-out');
    assert.match(r.answer, /timed out|timeout/i);
  } else {
    assert.match(r.answer, /pending|still processing/i);
  }
};

const checks = {
  overview: r => {
    exact(r, ['get_processes', 'get_process_details_v2', overall]);
    assert.match(r.answer, /mean|average/i);
  },
  'view-confirmation': r => {
    exact(r, ['get_views']);
    assert.ok(r.actions.some(a => a.tool === 'ask_user'), 'View must await confirmation');
  },
  'confirmed-view': r => {
    exact(r, ['get_process_details_v2', overall]);
    for (const a of r.actions) if (a.tool !== 'stop') {
      assert.equal(a.arguments.viewId, 'V');
      assert.equal(a.arguments.processId, undefined);
    }
  },
  'async-complete': completedOperation,
  'async-cold-start': completedOperation,
  'async-pending': unfinishedOperation,
  'async-timeout': unfinishedOperation,
  'async-resume-deadline': unfinishedOperation,
  'async-expired': unfinishedOperation,
  'async-conflicting-description': unfinishedOperation,
  'async-interrupted-unknown': r => {
    exact(r, []);
    assert.equal(r.retained.status, 'unknown');
    assert.equal(r.retained.operationId, undefined, 'Never invent an operation ID');
    assert.equal(r.retained.requestStartedAtSeconds, 0);
    assert.equal(r.retained.requestDeadlineSeconds, operationLimitSeconds);
    assert.deepEqual(r.retained.request, { tool: overall, arguments: { processId: 'P' } });
    assert.match(r.answer, /unknown outcome/i);
  },
  'tool-error': r => {
    exact(r, [overall]);
    assert.match(r.answer, /error|fail/i);
  },
  'duplicate-process': r => {
    exact(r, ['get_processes']);
    assert.ok(r.actions.some(a => a.tool === 'ask_user'));
  },
  'slow-activities': r => {
    exact(r, ['get_bottleneck_analysis_v2']);
    assert.equal(call(r, 'get_bottleneck_analysis_v2').itemsPerPage, 5);
    assert.match(r.answer, /average|mean/i);
  },
  'activity-workload': r => {
    exact(r, [stats]);
    const a = call(r, stats);
    assert.equal(a.attributeName, 'Step');
    assert.equal(a.metricToSortBy, 'TotalDuration');
  },
  'stats-unavailable': r => {
    names(r).forEach(t => assert.equal(t, 'get_bottleneck_analysis_v2'));
    assert.equal(new Set(names(r)).size, names(r).length, 'Do not repeat unchanged average-only evidence');
    no(r, /statistics|custom_metric/);
    assert.match(r.answer, /unavailable|cannot|not available|average.only|gap/i);
  },
  'edge-ranking': r => {
    exact(r, ['get_edges_with_metrics_v2']);
    assert.match(r.answer, /page|partial|sample/i);
  },
  'zero-duration-utilization': (r, s) => {
    exact(r, []);
    const evidence = s.contextOverrides.completedSummary;
    assert.equal(r.retained.rawUtilization, evidence.CaseUtilization);
    assert.equal(r.retained.zeroDurationCaseCount, evidence.zeroDuration.CaseCount);
    assert.equal(r.retained.positiveDurationCaseCount, evidence.positiveDuration.CaseCount);
    assert.equal(r.retained.reportedActiveTime, evidence.CaseActiveTime);
    assert.equal(r.retained.interpretation, 'zero-duration-convention');
    assert.equal(r.retained.productiveTimeMeasured, false);
    assert.equal(r.retained.zeroDurationCanHaveMultipleEvents, true);
    assert.match(r.answer, /0\.25|25\s*%/);
    assert.match(r.answer, /zero.duration convention/i);
    assert.match(r.answer, /start.only/i);
    assert.match(r.answer, /not measure|not evidence|cannot infer/i);
    assert.match(r.answer, /multiple events.*(?:same|one) timestamp/i);
  },
  'variant-ranking': r => {
    assert.ok(names(r).length > 0);
    names(r).forEach(t => assert.equal(t, 'get_variants_with_metrics_v2'));
    const a = argsFor(r, 'get_variants_with_metrics_v2');
    assert.equal(new Set(a.map(args => args.metricToSortBy)).size, a.length, 'The complete fixture needs no repeated ranking');
    a.forEach(args => assert.ok(['CaseCount', 'CaseDuration'].includes(args.metricToSortBy)));
    assert.equal(a[0].metricToSortBy, 'CaseCount');
    if (a[1]) assert.equal(a[1].metricToSortBy, 'CaseDuration');
  },
  rework: r => {
    exact(r, [cases]);
    const a = call(r, cases);
    assert.equal(a.metricToSortBy, 'ReworkCount');
    const f = a.filterOptions.caseMetricConditionFilters[0];
    assert.equal(f.metric, 'CaseReworkCount');
    assert.equal(f.comparisonOperator, 'GreaterThan');
    assert.deepEqual(f.values, [0]);
  },
  'specific-case': r => {
    exact(r, [cases]);
    const f = call(r, cases).filterOptions.attributeValueFilters[0];
    assert.equal(f.attributeName, 'RecordKey');
    assert.equal(f.dataType, 'String');
    assert.deepEqual(f.attributeValues, ['Demo-17']);
    assert.match(r.answer, /timeline|event trace/i);
    assert.match(r.answer, /not|cannot|unavailable|unsupported/i);
  },
  'case-influence': r => {
    assert.equal(names(r)[0], 'get_correlation_v2');
    names(r).forEach(t => assert.ok(['get_correlation_v2', stats].includes(t)));
    assert.equal(new Set(names(r)).size, names(r).length, 'No new fixture evidence supports repeating these calls');
    const a = call(r, 'get_correlation_v2');
    assert.equal(a.attributeName, 'Department');
    assert.equal(a.influenceFormula, 'WaitingTimeInfluence');
    assert.match(r.answer, /caus|confound/i);
  },
  'event-driver': r => {
    no(r, /correlation/);
    names(r).forEach(t => assert.equal(t, stats));
    assert.equal(new Set(names(r)).size, names(r).length, 'Do not repeat the same completed statistics');
    if (names(r).length) assert.equal(call(r, stats).attributeName, 'Resource');
  },
  'cohort-pair': r => {
    exact(r, [overall, overall]);
    const [a, b] = argsFor(r, overall);
    const fa = a.filterOptions.attributeValueFilters[0];
    const fb = b.filterOptions.attributeValueFilters[0];
    assert.equal(fa.attributeName, 'Department');
    assert.equal(fb.attributeName, 'Department');
    assert.deepEqual(fa.attributeValues, ['North']);
    assert.deepEqual(fb.attributeValues, ['South']);
    assert.deepEqual(a.filterOptions.caseMetricConditionFilters,
      [{ metric: 'CaseReworkCount', comparisonOperator: 'GreaterThan', values: [0], isInclusive: true }],
      'Preserve baseline rework scope');
    const normalized = structuredClone(b);
    normalized.filterOptions.attributeValueFilters[0].attributeValues = ['North'];
    assert.deepEqual(a, normalized, 'Only cohort membership differs');
  },
  'completed-period': r => {
    assert.equal(names(r).length, 0);
    assert.match(r.answer, /contained/i);
  },
  'version-drift': r => {
    call(r, 'get_process_details_v2');
    assert.match(r.answer, /version|refresh/i);
    assert.match(r.answer, /stop|rerun|re-run|not comparable|cannot|invalid/i);
  },
  'native-duration': r => {
    exact(r, [cases]);
    const f = call(r, cases).filterOptions.caseMetricConditionFilters[0];
    assert.equal(f.metric, 'CaseDuration');
    assert.deepEqual(f.values, ['1.00:00:00']);
  },
  'saved-filter': r => {
    exact(r, [overall]);
    const f = call(r, overall).filterOptions.caseMetricConditionFilters[0];
    assert.equal(f.metric, 'CustomMetric');
    assert.equal(f.customMetricId, 'C');
    assert.deepEqual(f.values, [true]);
  },
  'saved-column': r => {
    exact(r, [validate, cases]);
    assert.equal(call(r, validate).formula, 'EscalatedCase()');
    assert.equal(call(r, cases).formulaMetricInput.formula, 'EscalatedCase()');
  },
  'complete-scalar': r => {
    exact(r, []);
    assert.match(r.answer, /\b5\b/);
  },
  'conditional-formula': r => {
    exact(r, ['get_custom_metric_language_reference', validate, cases]);
    assert.equal(call(r, validate).formula, 'F_review');
    assert.equal(call(r, cases).formulaMetricInput.formula, 'F_review');
  },
  'schema-aware-reference': (r, s) => {
    exact(r, ['get_custom_metric_language_reference', 'get_custom_metric_language_reference']);
    const [first, second] = argsFor(r, 'get_custom_metric_language_reference');
    assert.deepEqual(first, { search: 'mean waiting time' });
    assert.deepEqual(second, { ...first, cursor: s.replies.get_custom_metric_language_reference[0].nextCursor });
    assert.equal(r.retained.catalogVersion, 'synthetic-v1');
    assert.equal(r.retained.signature, 'SyntheticMean(value)');
  },
  'edge-context': r => exact(r, [validate]),
  'column-gate': r => {
    exact(r, [validate, cases]);
    assert.match(JSON.stringify(r.retained), /column|formulaMetricInput/i);
    assert.match(r.answer, /disabled|unavailable/i);
  },
  'validation-budget': r => {
    const n = argsFor(r, validate).length;
    assert.ok(n >= 1 && n <= 3);
    no(r, /with_metrics|overall/);
    assert.match(r.answer, /outside|enable|not enabled|prerequisite/i);
  },
  'statistics-context': r => exact(r, [validate]),
  'validation-unavailable': r => exact(r, []),
  'object-analysis': r => {
    exact(r, ['get_ocpm_processes', 'get_process_details_v2', 'get_ocpm_object_types',
      'get_ocpm_process_execution_statistics', 'get_ocpm_process_executions']);
    assert.equal(call(r, 'get_ocpm_process_execution_statistics').leadingObjectTypeName, 'Invoice');
    assert.equal(call(r, 'get_ocpm_process_executions').leadingObjectTypeName, 'Invoice');
  },
  'object-unavailable': r => exact(r, []),
  'object-units': r => {
    exact(r, ['get_ocpm_process_executions']);
    const a = call(r, 'get_ocpm_process_executions');
    assert.equal(a.leadingObjectTypeName, 'Invoice');
    const f = a.filters;
    assert.equal(f.processExecutionFilters[0].timeBetweenEventsSeconds, 60);
    assert.equal(f.processExecutionFilters[0].timeBetweenEventsRelation, 'GreaterThan');
    assert.equal(f.objectTimeframeFilters[0].propagation, 'SelectedObjectTypeOnly');
    assert.equal(f.objectTimeframeFilters[0].propagationDepth, undefined);
  }
};

export function evaluate(group, results) {
  assert.ok(fixtures.groups[group], `Unknown scenario group: ${group}`);
  assert.ok(Array.isArray(results));
  assert.equal(new Set(results.map(r => r.id)).size, results.length, 'Duplicate scenario result');
  assert.deepEqual(results.map(r => r.id).sort(), fixtures.groups[group].map(s => s.id).sort());
  return fixtures.groups[group].map(s => {
    const r = results.find(r => r.id === s.id);
    try {
      assert.ok(Array.isArray(r.actions));
      assert.equal(typeof r.answer, 'string');
      const advertised = new Set([
        ...fixtures.defaultContext.advertisedTools.filter(t => !s.removeTools?.includes(t)),
        ...(s.addTools ?? []), 'ask_user', 'stop'
      ]);
      for (const a of r.actions) {
        assert.ok(advertised.has(a.tool), `Not advertised: ${a.tool}`);
        assert.ok(a.arguments && typeof a.arguments === 'object');
        assert.ok(!(a.arguments.processId && a.arguments.viewId), 'Send only one selector');
        if (a.tool.includes('edges') || a.tool.startsWith('get_ocpm_')) {
          assert.equal(a.arguments.metricToSortBy, undefined, 'No edge/OCPM sort input');
          assert.equal(a.arguments.sortOrder, undefined, 'No edge/OCPM sort input');
        }
        if (a.tool === 'get_correlation_v2') {
          assert.equal(a.arguments.itemsPerPage, undefined, 'Correlation has no paging');
          assert.equal(a.arguments.itemsToSkip, undefined, 'Correlation has no paging');
          assert.equal(a.arguments.top, undefined);
        }
        if (a.tool === 'get_bottleneck_analysis_v2') {
          assert.equal(a.arguments.filterOptions, undefined);
          assert.equal(a.arguments.attributeName, undefined, 'Bottleneck resolves its own activity attribute');
        }
        if (a.tool.startsWith('get_ocpm_')) assert.equal(a.arguments.filterOptions, undefined);
        if (a.tool === validate) {
          assert.equal(a.arguments.processVersionId, 'PV');
          assert.equal(a.arguments.processExtendedMetadataVersionId, 'PMV');
        } else if (!['ask_user', 'stop'].includes(a.tool)) {
          assert.equal(a.arguments.processVersionId, undefined, 'Versions are validation inputs, not analytics selectors');
          assert.equal(a.arguments.processExtendedMetadataVersionId, undefined);
        }
        for (const key of ['caseId', 'variantId', 'metrics', 'groupBy', 'aggregation', 'attributeLevel',
          'limit', 'offset', 'take', 'skip', 'top']) {
          assert.equal(a.arguments[key], undefined, `Unsupported argument: ${key}`);
        }
      }
      checks[s.id](r, s);
      return { id: s.id, pass: true, calls: names(r).length };
    } catch (e) {
      return { id: s.id, pass: false, calls: r.actions?.filter(a => a.tool !== 'ask_user' && a.tool !== 'stop').length,
        error: e.message };
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [group, file] = process.argv.slice(2);
  if (!group || !file) throw new Error('Usage: node tests/analysis-behavior.mjs GROUP RAW-TRACE-JSON');
  const report = evaluate(group, JSON.parse(await readFile(file, 'utf8')));
  console.log(JSON.stringify(report, null, 2));
  if (report.some(r => !r.pass)) process.exitCode = 1;
}
