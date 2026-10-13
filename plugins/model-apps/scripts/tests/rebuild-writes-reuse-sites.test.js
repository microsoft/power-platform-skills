'use strict';
// Rebuild writes, continued — the reuse sites of the business-rules and business-process-flows phases. A reused rule or
// flow joins the solution again only when the solution is not PROVEN to hold it (solution-membership.js); the views,
// charts, forms, app, sitemap, page manifest and persona roles are pinned in sdk-build.test.js, and the wire-level
// behaviour in rebuild-writes-real-bundle.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { makeSimpleMockSdk } = require('./helpers/mock-sdk.js');

const SOLUTION_ID = '5011c0de-0000-4000-8000-000000000002';
const WORKFLOW = 29; // a business rule and a process flow are both `workflow` rows

function baseSpec() {
  return {
    solution: { uniqueName: 'ContosoReuse', displayName: 'Contoso Reuse', publisherPrefix: 'new' },
    app: { name: 'Reuse App', description: '' },
    entities: [{ schemaName: 'new_ticket', displayName: 'Ticket', pluralName: 'Tickets', primaryAttribute: { schemaName: 'new_subject', displayName: 'Subject' }, columns: [{ schemaName: 'new_notes', displayName: 'Notes', type: 'Memo' }] }],
  };
}
const ruleSpec = () => ({ ...baseSpec(), businessRules: [{ entity: 'new_ticket', name: 'Hide notes', conditions: [{ field: 'new_notes', operator: 'Equals', value: 'x', dataType: 'String' }], actions: [{ type: 'SetVisibility', field: 'new_notes', visible: false }] }] });
const flowSpec = () => ({ ...baseSpec(), businessProcessFlows: [{ name: 'Ticket Handling', entity: 'new_ticket', stages: [{ name: 'Triage', steps: [{ name: 'Subject', field: 'new_subject' }] }] }] });

// Just the surface those two phases touch: the workflow lookup, the membership read, and the add.
function provisionOver({ rows, members, readFails = false }) {
  const adds = [];
  const reads = [];
  return {
    adds,
    reads,
    provision: {
      queryRecords: async (entity, options) => {
        reads.push(entity);
        if (entity === 'workflow') return typeof rows === 'function' ? rows(options) : rows;
        if (entity === 'solution') return [{ solutionid: SOLUTION_ID }];
        if (entity === 'solutioncomponent') {
          if (readFails) throw new Error('membership unreadable');
          return members.map(([componenttype, objectid]) => ({ componenttype, objectid }));
        }
        return [{ publisherid: 'pub-1' }];
      },
      updateRecord: async () => undefined,
      createArtifact: () => { throw new Error('a reused artifact must not be created'); },
      addSolutionComponent: async (o) => { adds.push(o); },
    },
  };
}

const existingRule = { workflowid: 'rule-1', statecode: 1, createdon: '2026-01-01T00:00:00Z' };
const existingFlow = { workflowid: 'flow-1', statecode: 1, createdon: '2026-01-01T00:00:00Z', uniquename: 'new_tickethandling' };

async function build(spec, phase, over) {
  const { sdk } = makeSimpleMockSdk();
  const warnings = [];
  const res = await runSdkBuild(spec, { sdk, provisionSdk: over.provision, apply: true, phases: [phase], warn: (w) => warnings.push(w) });
  assert.equal(res.ok, true);
  return warnings;
}

test('rebuild writes: a reused business rule the solution already holds is not added again', async () => {
  const over = provisionOver({ rows: [existingRule], members: [[WORKFLOW, 'rule-1']] });
  await build(ruleSpec(), 'business-rules', over);
  assert.deepEqual(over.adds, []);
});

test('rebuild writes: a reused business rule the solution lacks is added again — the repair this re-assert exists for', async () => {
  const over = provisionOver({ rows: [existingRule], members: [[WORKFLOW, 'some-other-rule'], [26, 'rule-1']] });
  await build(ruleSpec(), 'business-rules', over);
  assert.deepEqual(over.adds, [{ componentId: 'rule-1', componentType: WORKFLOW, solutionUniqueName: 'ContosoReuse' }]);
});

test('rebuild writes: a reused business rule is re-added when the membership cannot be read', async () => {
  const over = provisionOver({ rows: [existingRule], members: [], readFails: true });
  await build(ruleSpec(), 'business-rules', over);
  assert.equal(over.adds.length, 1);
});

test('rebuild writes: a reused process flow the solution already holds is not added again', async () => {
  const over = provisionOver({ rows: [existingFlow], members: [[WORKFLOW, 'flow-1']] });
  await build(flowSpec(), 'business-process-flows', over);
  assert.deepEqual(over.adds, []);
});

test('rebuild writes: a reused process flow the solution lacks is added again, and a failed add still only warns', async () => {
  const over = provisionOver({ rows: [existingFlow], members: [] });
  await build(flowSpec(), 'business-process-flows', over);
  assert.deepEqual(over.adds, [{ componentId: 'flow-1', componentType: WORKFLOW, solutionUniqueName: 'ContosoReuse' }]);

  const failing = provisionOver({ rows: [existingFlow], members: [] });
  failing.provision.addSolutionComponent = async () => { throw new Error('component add refused'); };
  const warnings = await build(flowSpec(), 'business-process-flows', failing);
  assert.ok(warnings.some((w) => /could not be added to solution/.test(w)), warnings.join('\n'));
});

test('rebuild writes: the rule and the flow of one build share a single membership read', async () => {
  // One `workflow` lookup serves both phases in this double: a flow is the category-4 row, a rule the other.
  const over = provisionOver({
    rows: (options) => (/category eq 4/.test((options && options.filter) || '') ? [existingFlow] : [existingRule]),
    members: [[WORKFLOW, 'rule-1'], [WORKFLOW, 'flow-1']],
  });
  const { sdk } = makeSimpleMockSdk();
  await runSdkBuild({ ...ruleSpec(), ...flowSpec() }, { sdk, provisionSdk: over.provision, apply: true, phases: ['business-rules', 'business-process-flows'], warn: () => undefined });
  assert.deepEqual(over.adds, []);
  assert.equal(over.reads.filter((e) => e === 'solutioncomponent').length, 1);
});
