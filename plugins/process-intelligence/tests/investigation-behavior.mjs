// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { groups } from './investigation-scenarios.mjs';

const text = r => `${r.answer} ${JSON.stringify(r.retained)}`;
const refs = r => r.actions.filter(a => !['ask_user', 'stop'].includes(a.tool)).map(a => a.replyRef);
const exact = (r, expected) => assert.deepEqual(refs(r), expected);
const status = (r, value) => assert.equal(r.retained.status, value);
const mentions = (r, pattern) => assert.match(text(r), pattern);
const none = r => exact(r, []);
const audit = r => {
  const t = JSON.stringify(r.retained);
  for (const pattern of [/question/i, /provenance|definition/i, /PV/, /PMV/, /baseline/i, /evidence|Rsettled/]) {
    assert.match(t, pattern, `Incomplete audit context: ${pattern}`);
  }
};
const normalize = (input, tool) => {
  const a = structuredClone(input);
  const key = tool === 'get_bottleneck_analysis_v2' ? 'mcpFilterOptions'
    : tool === 'get_ocpm_process_executions' ? 'filters'
    : ['get_process_overall_metrics_v2', 'get_cases_with_metrics_v2', 'get_variants_with_metrics_v2',
      'get_edges_with_metrics_v2', 'get_correlation_v2', 'get_attribute_statistics'].includes(tool) ? 'filterOptions' : null;
  if (key && a[key] && typeof a[key] === 'object' && !Array.isArray(a[key])
      && Object.keys(a[key]).length === 0) delete a[key];
  if (a.itemsPerPage !== undefined && a.itemsToSkip === undefined) a.itemsToSkip = 0;
  // Only normalize defaults on tools that actually expose these arguments.
  if (['get_cases_with_metrics_v2', 'get_variants_with_metrics_v2', 'get_correlation_v2', 'get_attribute_statistics'].includes(tool)
      && a.sortOrder === 'Descending') delete a.sortOrder;
  if (tool === 'get_cases_with_metrics_v2' && a.metricToSortBy === 'Duration') delete a.metricToSortBy;
  return a;
};
const checks = {
  'payment-outcome': r => {
    exact(r, ['Rsettled']); status(r, 'contradicted'); audit(r);
    mentions(r, /\b8\b/); mentions(r, /\b50\b/);
    mentions(r, /partial|not fully|not all|does not|doesn't/i);
    assert.ok(r.retained.evidenceRefs?.includes('Rpresence') || JSON.stringify(r.retained).includes('Rpresence'));
  },
  'overlap-denominator': r => {
    none(r); status(r, 'inconclusive');
    mentions(r, /overlap|same cases/i);
    mentions(r, /unknown|missing|unavailable|cannot|not established/i);
    assert.equal(r.retained.affectedCount ?? null, null);
    assert.equal(r.retained.denominator ?? null, null);
  },
  'unsupported-rule': r => { none(r); status(r, 'inconclusive'); mentions(r, /interval|first.*last|deadline/i); },
  'pending-safeguard': (r, scenario) => {
    exact(r, scenario.replies.map(reply => reply.ref));
    const polls = r.actions.filter(a => a.tool === 'get_operation_result');
    polls.forEach((a, i) => {
      const delay = scenario.replies[i].result.retryAfterSeconds;
      assert.ok(Number.isFinite(a.waitBeforeSeconds) && a.waitBeforeSeconds >= delay);
    });
    const elapsed = polls.reduce((sum, a) => sum + a.waitBeforeSeconds, 0);
    const budget = Math.min(30 * 60, scenario.context.waitBudgetSeconds ?? 30 * 60);
    assert.ok(elapsed <= budget, 'Respect the explicit user deadline');
    assert.ok(elapsed + scenario.replies.at(-1).result.retryAfterSeconds > budget,
      'Do not stop early at a fixed polling cutoff');
    status(r, 'pending'); mentions(r, /OP/);
    assert.match(JSON.stringify(r.retained), /get_process_overall_metrics_v2/);
    assert.match(JSON.stringify(r.retained), /"processId":"P"/);
  },
  'consumed-result': r => { none(r); mentions(r, /\b20\b/); mentions(r, /Rcompleted/); },
  'evidence-refresh': r => {
    exact(r, ['Rdetails']); status(r, 'inconclusive');
    mentions(r, /invalid|stale|not current/i); mentions(r, /PV-new/);
  },
  'direct-ranking': r => {
    exact(r, ['Rbottleneck']);
    assert.equal(r.actions.some(a => a.tool === 'ask_user'), false);
    mentions(r, /mean|average/i);
  },
  'broad-routing': r => {
    none(r); assert.equal(r.retained.route, 'investigate-process');
    assert.ok(r.actions.some(a => a.tool === 'ask_user'));
  },
  'overview-continuation': r => {
    exact(r, ['Rv0', 'Rv1', 'Rv2']);
    mentions(r, /\b12\b/); mentions(r, /\b30\b/);
    if (r.retained.denominator !== undefined) assert.equal(r.retained.denominator, 30);
  },
  'appeal-outcome': r => {
    exact(r, ['Rappeal']); status(r, 'inconclusive');
    mentions(r, /\b6\b/); mentions(r, /not prove|does not|cannot|unknown|unproven/i);
    mentions(r, /dismissal|success/i);
  },
  'missing-event': r => {
    none(r); status(r, 'inconclusive');
    mentions(r, /recording|completeness/i);
    mentions(r, /censor|still running|legitimate|business rule/i);
  },
  'rework-continuation': r => {
    exact(r, Array.from({ length: 6 }, (_, i) => `Rrework${i}`));
    mentions(r, /\b30\b/); mentions(r, /distribution|each|frequency/i);
  },
  'snapshot-meaning': r => {
    none(r); status(r, 'inconclusive');
    assert.ok(r.actions.some(a => a.tool === 'ask_user'));
    mentions(r, /cumulative|snapshot/i); mentions(r, /order|authoritative|refund/i);
  },
  'reference-continuation': r => {
    exact(r, ['Rref0', 'Rref1', 'Rref2', 'Rref3', 'Rvalid', 'Rbalance0', 'Rbalance1']);
    mentions(r, /ephemeral|not saved/i); mentions(r, /\b10\b/);
  },
  'failed-repair': r => { exact(r, ['Rinvalid']); mentions(r, /dependency|prerequisite/i); },
  'contradicted-influence': r => {
    exact(r, ['Rnorth', 'Rsouth']); status(r, 'contradicted');
    mentions(r, /mix|confound|alternative|service/i); mentions(r, /causal|causation|cause/i);
  },
  'candidate-continuation': r => {
    assert.deepEqual(refs(r).sort(), ['Rsignal0', 'Rfrequency0', 'Rsignal1', 'Rfrequency1', 'Rsignal2', 'Rfrequency2'].sort());
    mentions(r, /hypothes|observation|association/i); mentions(r, /causal|cause|confound/i);
  },
  'frozen-baseline': r => {
    exact(r, ['RfullN', 'RfullS']); mentions(r, /matur|closure|censor/i);
    mentions(r, /unknown|not established|unproven|cannot|no evidence/i);
    assert.ok(JSON.stringify(r.retained).includes('baseline'));
  },
  'cohort-refresh': r => {
    exact(r, ['Rnew']); status(r, 'inconclusive'); mentions(r, /invalid|stale|rerun|re-run|not comparable/i);
  },
  'edge-continuation': r => {
    exact(r, Array.from({ length: 6 }, (_, i) => `Redge${i}`));
    mentions(r, /S119/); mentions(r, /mean|average/i); mentions(r, /\b120\b/);
  },
  'mean-not-savings': r => {
    none(r); mentions(r, /not|cannot|no evidence|unsupported/i); mentions(r, /saving|caus/i);
  },
  'object-continuation': r => {
    exact(r, Array.from({ length: 5 }, (_, i) => `Rexecution${i}`));
    mentions(r, /\b25\b/); mentions(r, /execution/i);
  },
  'object-interval': r => {
    none(r); status(r, 'inconclusive'); mentions(r, /interval|path/i);
    mentions(r, /not|cannot|unsupported/i);
  }
};

export function evaluateInvestigation(group, results) {
  assert.ok(groups[group], `Unknown group: ${group}`);
  assert.ok(Array.isArray(results));
  assert.equal(new Set(results.map(r => r.id)).size, results.length, 'Duplicate scenario output');
  assert.deepEqual(results.map(r => r.id).sort(), groups[group].map(s => s.id).sort());
  return groups[group].map(s => {
    const r = results.find(row => row.id === s.id);
    try {
      assert.ok(Array.isArray(r.actions));
      assert.equal(typeof r.answer, 'string');
      assert.ok(r.retained && typeof r.retained === 'object');
      const used = new Set();
      for (const a of r.actions) {
        assert.ok(a.arguments && typeof a.arguments === 'object');
        if (['ask_user', 'stop'].includes(a.tool)) continue;
        const reply = s.replies.find(candidate => candidate.ref === a.replyRef);
        assert.ok(reply, `No fixture response ${a.replyRef}`);
        assert.equal(a.tool, reply.tool);
        assert.deepEqual(normalize(a.arguments, a.tool), normalize(reply.arguments, reply.tool), 'Query scope/arguments must match the cited response');
        assert.ok(!used.has(a.replyRef), `Unjustified repeated result request: ${a.replyRef}`);
        used.add(a.replyRef);
      }
      checks[s.id](r, s);
      return { id: s.id, pass: true, calls: refs(r).length };
    } catch (error) {
      return { id: s.id, pass: false, calls: r.actions ? refs(r).length : 0, error: error.message };
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [group, file] = process.argv.slice(2);
  if (!file) throw new Error('Usage: node tests/investigation-behavior.mjs GROUP TRACE.json');
  const report = evaluateInvestigation(group, JSON.parse(await readFile(file, 'utf8')));
  console.log(JSON.stringify(report, null, 2));
  if (report.some(r => !r.pass)) process.exitCode = 1;
}
