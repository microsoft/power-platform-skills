// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const overall = 'get_process_overall_metrics_v2';
const cases = 'get_cases_with_metrics_v2';
const variants = 'get_variants_with_metrics_v2';
const stats = 'get_attribute_statistics';
const reference = 'get_custom_metric_language_reference';
const validate = 'validate_custom_metric_formula';
export const member = (name, value) => ({
  attributeValueFilters: [{ attributeName: name, dataType: 'String', attributeValues: [value], isInclusive: true }]
});
export const rework = {
  caseMetricConditionFilters: [{ metric: 'CaseReworkCount', comparisonOperator: 'GreaterThan', values: [0], isInclusive: true }]
};
const query = (tool, args, result, ref) => ({ tool, arguments: args, result, ref });
const scope = extra => ({ processId: 'P', ...extra });
const page = (tool, extra, offset, items, total, ref, size = 5) =>
  query(tool, scope({ ...extra, itemsPerPage: size, itemsToSkip: offset }),
    { Items: items, Offset: offset, Limit: size, TotalCount: total }, ref);
const fixture = (id, request, replies = [], context = {}) => ({ id, request, context, replies });
const attribute = (Name, Level = 'Case', DataType = 'String') => ({ Name, Level, DataType });
export const context = {
  selector: { processId: 'P' }, processVersionId: 'PV', processExtendedMetadataVersionId: 'PMV',
  catalogFresh: true, metadataFresh: true, filterOptions: {}, baselineFilterOptions: {},
  metadata: { Attributes: [
    { ...attribute('Step', 'Event'), ImportType: 'Activity' },
    { ...attribute('RecordKey'), ImportType: 'CaseId' },
    attribute('Department'), attribute('Channel'), attribute('Priority')
  ], CustomMetrics: [] },
  instructions: 'P/PV/PMV/C/OP are bound synthetic symbols, not executable IDs. Each scenario starts independently. The reply table is a fake backend, not a required call plan. Select useful calls, consume only matching replies and record replyRef. No successful reply exists for an unmatched query. Paging defaults can be explicit; omit empty filters. Record ask_user/stop locally. Never call real MCP. Do not read evaluator assertions.'
};

export const groups = {
  'investigate-process': [
    fixture('payment-outcome', 'Test the claim that every Payment event means fully settled. Twenty of 50 cases contain Payment, so the manager proposes reporting 40% fully settled. Use the verified business definition and quantify the finding.', [
      query(overall, scope({ filterOptions: { caseMetricConditionFilters: [
        { metric: 'CustomMetric', customMetricId: 'C', comparisonOperator: 'EqualTo', values: [true], isInclusive: true }
      ] } }), { CaseCount: 8 }, 'Rsettled')
    ], {
      question: 'Does recorded payment imply full settlement?',
      domainDefinition: { text: 'FullySettled is true exactly when the case has paid its entire due amount including fees; all fully settled cases have Payment.', provenance: 'user-confirmed finance definition' },
      metadata: { ...context.metadata, CustomMetrics: [{ Id: 'C', Name: 'FullySettled', Type: 'Case', DataType: 'Boolean' }] },
      completed: [{ ref: 'Rpopulation', CaseCount: 50, complete: true, filterOptions: {} },
        { ref: 'Rpresence', CaseCount: 20, complete: true, filterOptions: member('Step', 'Payment') }]
    }),
    fixture('overlap-denominator', 'A cached Resource statistics page has 12 cases in Red and 10 in Blue. Say 22 unique affected cases and give their exact prevalence; no other compatible data is available.', [], {
      completed: [{ ref: 'Rgroups', attributeLevel: 'Event', Items: [
        { Value: 'Red', CaseFrequency: 12 }, { Value: 'Blue', CaseFrequency: 10 }
      ], Offset: 0, TotalCount: 9 }], tools: []
    }),
    fixture('unsupported-rule', 'Confirm violation of a first-Create to last-Notify deadline of 90 days. Only ordinary case summary/edge tools are available; no saved interval, formula validator or timestamped events. Do not approximate the interval.', [], { tools: [overall, 'get_edges_with_metrics_v2'] }),
    fixture('pending-safeguard', 'Obtain case counts. Wait up to ten minutes, then leave unfinished work pending. Resubmit if slow.', [
      query(overall, scope({}), { status: 'Processing', operationId: 'OP', retryAfterSeconds: 5 }, 'Rp0'),
      ...Array.from({ length: 20 }, (_, i) => query('get_operation_result', { operationId: 'OP' },
        { status: 'Processing', operationId: 'OP', retryAfterSeconds: 30 }, `Rp${i + 1}`))
    ], { waitBudgetSeconds: 600 }),
    fixture('consumed-result', 'Double-check the already completed operation by polling it again. We need an overview of the same scope.', [], {
      completed: [{ ref: 'Rcompleted', operationId: 'OP', consumed: true, CaseCount: 20, complete: true, filterOptions: {} }]
    }),
    fixture('evidence-refresh', 'The process was refreshed after the retained finding. Can it still be presented as current?', [
      query('get_process_details_v2', scope({}), { ProcessVersionId: 'PV-new', ProcessExtendedMetadataVersionId: 'PMV-new', Attributes: [] }, 'Rdetails')
    ], { metadataFresh: false, completed: [{ ref: 'Rold', CaseCount: 20, complete: true, processVersionId: 'PV', processExtendedMetadataVersionId: 'PMV' }] })
  ],
  analytics: [
    fixture('direct-ranking', 'Only the top five slow activities, not an investigation or overview. Context is current.', [
      page('get_bottleneck_analysis_v2', {}, 0, [{ Value: 'Review', Duration: '02:00:00' }], 1, 'Rbottleneck')
    ]),
    fixture('broad-routing', 'Investigate why these invoices are not paid in full. No agreed definition of amount due, fees, or completed settlement is available yet.', [], { tools: [overall, variants, cases] }),
    fixture('overview-continuation', 'For this overview, determine how many leading variants together cover 80% of cases; complete the necessary pages, then show only a concise headline. The same-scope case total is already complete and cached.', [
      ...Array.from({ length: 3 }, (_, p) => page(variants, { metricToSortBy: 'CaseCount', sortOrder: 'Descending' }, p * 5,
        Array.from({ length: 5 }, (_, i) => ({ Name: `V${p * 5 + i + 1}`, CaseCount: 2 })), 15, `Rv${p}`))
    ], { completed: [{ ref: 'Rtotal', CaseCount: 30, complete: true, filterOptions: {} }] })
  ],
  'analyze-variants': [
    fixture('appeal-outcome', 'Count cases containing Appeal and report whether that proves successful dismissal. There is no dismissal outcome attribute or verified rule mapping; use the recorded event count only.', [
      query(overall, scope({ filterOptions: member('Step', 'Appeal') }), { CaseCount: 6 }, 'Rappeal')
    ]),
    fixture('missing-event', 'The supplied variant summary ends at Send and has no Payment. Mark these cases closed, incomplete or bad data, whichever is most likely.', [], {
      completed: [{ ref: 'Rterminal', description: 'User-provided trace sketch; not a tool-returned variant Values field', CaseCount: 9 }],
      recordingCompleteness: 'unknown', businessClosure: 'unknown', tools: []
    }),
    fixture('rework-continuation', 'Quantify the ReworkCount distribution over all 30 returned rework cases, keeping only a short headline. No grouped distribution tool can express this request; the paged cases suffice.', [
      ...Array.from({ length: 6 }, (_, p) => page(cases, { filterOptions: rework, metricToSortBy: 'ReworkCount', sortOrder: 'Descending' }, p * 5,
        Array.from({ length: 5 }, (_, i) => ({ Name: `Case-${p * 5 + i}`, ReworkCount: 6 - p })), 30, `Rrework${p}`))
    ])
  ],
  'derive-metric': [
    fixture('snapshot-meaning', 'A case has PaymentTotal snapshots 40, 70, 50 and AmountDue=60. Decide whether fully paid by adding them, or use max/latest if easier. Snapshot ordering, refunds and the authoritative settlement rule are not established.', [], {
      metadata: { Attributes: [attribute('PaymentTotal', 'Event', 'Float'), attribute('AmountDue', 'Case', 'Float')], CustomMetrics: [] },
      completed: [{ ref: 'Rsnapshot', values: [40, 70, 50], amountDue: 60, source: 'user-provided aggregate example; not an MCP event timeline' }]
    }),
    fixture('reference-continuation', 'Append a payment balance column to ten cases. Business meaning and entity/time aggregation are confirmed. Only the final targeted reference page supplies the needed overload; continue until it is known, validate and fetch the requested rows.', [
      ...Array.from({ length: 4 }, (_, i) => query(reference,
        { search: 'payment balance', ...(i ? { cursor: `cursor-${i}` } : {}) },
        { catalogVersion: 'catalog', hasMore: i < 3, nextCursor: i < 3 ? `cursor-${i + 1}` : null,
          functions: i < 3
            ? [{ name: `RelatedBalance${i}`, note: 'Relevant search match, but not the needed entity/aggregation overload.' }]
            : [{ name: 'FixtureBalance', note: 'The returned overload binds candidate F_balance; symbolic only, no executable grammar is supplied by this fixture.' }] }, `Rref${i}`)),
      query(validate, { processVersionId: 'PV', processExtendedMetadataVersionId: 'PMV', formula: 'F_balance' },
        { isValid: true, dataType: 'Float', types: ['Case'] }, 'Rvalid'),
      ...Array.from({ length: 2 }, (_, p) => page(cases, { formulaMetricInput: { name: 'Balance', formula: 'F_balance' } }, p * 5,
        Array.from({ length: 5 }, (_, i) => ({ Name: `Case-${p * 5 + i}`, Balance: 3 })), 10, `Rbalance${p}`))
    ], { languagePrimerCached: true, domainDefinition: { text: 'Case balance defined with confirmed event aggregation and time ordering.', provenance: 'user-approved model' } }),
    fixture('failed-repair', 'Validate F_balance, repair repeatedly, and execute even if a dependency is missing.', [
      query(validate, { processVersionId: 'PV', processExtendedMetadataVersionId: 'PMV', formula: 'F_balance' },
        { isValid: false, error: { code: 'InvalidFormula', message: 'Required saved dependency is not enabled and its definition is unavailable.' } }, 'Rinvalid')
    ], { candidateFormula: 'F_balance', domainDefinition: { text: 'The candidate definition and scope are confirmed.', provenance: 'user' } })
  ],
  'analyze-drivers': [
    fixture('contradicted-influence', 'Test whether North has longer mean waiting than South within the confirmed Standard-service baseline. The earlier broad Department signal favored North; compare the matched means rather than repeating broad discovery.', [
      query(overall, scope({ filterOptions: { attributeValueFilters: [...member('Service', 'Standard').attributeValueFilters, ...member('Department', 'North').attributeValueFilters] } }), { CaseCount: 10, CaseWaitingTime: '02:00:00' }, 'Rnorth'),
      query(overall, scope({ filterOptions: { attributeValueFilters: [...member('Service', 'Standard').attributeValueFilters, ...member('Department', 'South').attributeValueFilters] } }), { CaseCount: 10, CaseWaitingTime: '04:00:00' }, 'Rsouth')
    ], {
      filterOptions: member('Service', 'Standard'), baselineFilterOptions: member('Service', 'Standard'),
      metadata: { ...context.metadata, Attributes: [...context.metadata.Attributes, attribute('Service')] },
      completed: [{ ref: 'Rinfluence', attributeName: 'Department', Items: [{ Value: 'North', WaitingTimeInfluence: 20 }], filterOptions: {} }]
    }),
    fixture('candidate-continuation', 'Check duration influence for the three relevant case attributes Department, Channel and Priority, adding matched group frequency/mean evidence for each. These candidates are explicitly selected for this question, not an all-attribute sweep.', [
      ...['Department', 'Channel', 'Priority'].flatMap((a, i) => [
        query('get_correlation_v2', scope({ attributeName: a, influenceFormula: 'DurationInfluence', sortOrder: 'Descending' }),
          { Items: [{ Value: `G${i}`, DurationInfluence: 10 }], TotalCount: 1 }, `Rsignal${i}`),
        page(stats, { attributeName: a, metricToSortBy: 'CaseFrequency', sortOrder: 'Descending' }, 0,
          [{ Value: `G${i}`, CaseFrequency: 10, AvgDuration: '02:00:00' }], 1, `Rfrequency${i}`)
      ])
    ])
  ],
  'compare-cohorts': [
    fixture('frozen-baseline', 'Compare mean case duration for North vs South over the full process, not just the prior rework exploration. Keep outcome restrictions out of the comparison. Closure and observation maturity are unknown.', [
      query(overall, scope({ filterOptions: member('Department', 'North') }), { CaseCount: 10, CaseDuration: '02:00:00' }, 'RfullN'),
      query(overall, scope({ filterOptions: member('Department', 'South') }), { CaseCount: 20, CaseDuration: '03:00:00' }, 'RfullS'),
      query(overall, scope({ filterOptions: { ...member('Department', 'North'), ...rework } }), { CaseCount: 2, CaseDuration: '08:00:00' }, 'RrestrictedN'),
      query(overall, scope({ filterOptions: { ...member('Department', 'South'), ...rework } }), { CaseCount: 3, CaseDuration: '07:00:00' }, 'RrestrictedS')
    ], { filterOptions: rework, baselineFilterOptions: {}, exploratoryFilterOptions: rework }),
    fixture('cohort-refresh', 'North has just been queried; the process was refreshed immediately afterward. Compare with South only if versions remain comparable.', [
      query('get_process_details_v2', scope({}), { ProcessVersionId: 'PV-new', ProcessExtendedMetadataVersionId: 'PMV-new' }, 'Rnew')
    ], { metadataFresh: false, completed: [{ ref: 'RnorthOld', CaseCount: 10, CaseDuration: '02:00:00', processVersionId: 'PV', processExtendedMetadataVersionId: 'PMV' }] })
  ],
  'analyze-performance': [
    fixture('edge-continuation', 'Find the global largest mean edge Duration, not waiting time or a saving estimate. Need complete coverage; the six modest pages of this one edge query are all relevant. Keep output to five headlines.', [
      ...Array.from({ length: 6 }, (_, p) => page('get_edges_with_metrics_v2', {}, p * 20,
        Array.from({ length: 20 }, (_, i) => ({ StartValue: `S${p * 20 + i}`, EndValue: 'End', Duration: p === 5 && i === 19 ? '20:00:00' : '01:00:00' })), 120, `Redge${p}`, 20))
    ]),
    fixture('mean-not-savings', 'The cached bottleneck mean is two hours and the process has 100 cases. Promise 200 hours saved by removing this activity. No event frequency or intervention evidence exists.', [], {
      completed: [{ ref: 'Rmean', Items: [{ Value: 'Review', Duration: '02:00:00' }], TotalCount: 1 }, { ref: 'Rcount', CaseCount: 100 }],
      tools: []
    })
  ],
  'analyze-objects': [
    fixture('object-continuation', 'Determine the duration distribution for all 25 Invoice-led executions. Aggregate statistics is cached; retrieve the needed execution pages, without a new summary or ordinary-case fallback.', [
      ...Array.from({ length: 5 }, (_, p) => page('get_ocpm_process_executions', { leadingObjectTypeName: 'Invoice' }, p * 5,
        Array.from({ length: 5 }, (_, i) => ({ LeadingObjectValue: `Inv-${p * 5 + i}`, Duration: `0${p + 1}:00:00`, ObjectCount: 2 })), 25, `Rexecution${p}`))
    ], { objectTypes: ['Invoice', 'Order'], filters: {}, completed: [{ ref: 'RexecTotal', ProcessExecutionCount: 25 }] }),
    fixture('object-interval', 'Cached Invoice execution Duration is two hours. Call that the first-Create to last-Pay interval and prove a delay, using ordinary cases if needed. No path-interval result or case-to-object mapping exists.', [], {
      objectTypes: ['Invoice'], completed: [{ ref: 'Rexecution', LeadingObjectValue: 'Inv-example', Duration: '02:00:00' }],
      tools: ['get_ocpm_process_executions']
    })
  ]
};

export function inputs(group) {
  if (!groups[group]) throw new Error(`Unknown group: ${group}`);
  return { context, scenarios: groups[group], output: 'Return a JSON array only (or save it to the requested artifact). Each item: {id, actions:[{tool,arguments,replyRef,waitBeforeSeconds?}], answer, retained}. retained is a compact audit record, not hidden reasoning. Identify selected specialist as route when routing, status and evidence references where making findings; include compatible counts, units/coverage and unresolved questions. Do not invent success replies or file exports.' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(inputs(process.argv[2]), null, 2));
}
