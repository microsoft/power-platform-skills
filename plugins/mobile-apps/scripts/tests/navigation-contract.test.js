'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { deriveExperienceFromBrief } = require('../experience-patterns');
const { resolveContextEnrichment } = require('../resolve-context-enrichment');
const { resolveWorkflowJourney } = require('../resolve-workflow-journey');
const { resolveNavigationContract } = require('../resolve-navigation-contract');
const { validateNavigationContract } = require('../validate-navigation-contract');
const { validateNavigationContinuity } = require('../validate-navigation-continuity');

const resolverScript = path.resolve(__dirname, '..', 'resolve-navigation-contract.js');

function candidate(overrides = {}) {
  return {
    hasStableRoot: true,
    revisitedIndependently: true,
    preservesOwnState: true,
    crossSessionValue: true,
    peerToOtherDestinations: true,
    isNotAFlowStep: true,
    isNotAnAction: true,
    supportedByBriefOrSafeProductInference: true,
    ...overrides,
  };
}

function screen(id, role, purpose, navigation = {}, route = `/(app)/${id.toLowerCase()}`) {
  return { id, role, purpose, route, file: `app/(app)/${id.toLowerCase()}.tsx`, routeParameters: [], header: { mode: role === 'primary' ? 'root' : 'back', title: id }, navigation: { kind: role === 'primary' ? 'stack-root' : 'pushed', intent: role === 'primary' ? 'replace' : 'push', ...navigation } };
}

function contracts(brief, screens, stages = []) {
  const experience = deriveExperienceFromBrief(brief);
  const context = resolveContextEnrichment(brief, experience);
  const workflow = resolveWorkflowJourney(brief, experience, context);
  workflow.stages = stages.length ? stages : workflow.stages;
  const preliminary = { schemaVersion: 3, screens };
  const result = resolveNavigationContract(brief, experience, workflow, preliminary);
  return { brief, experience, context, workflow, preliminary, ...result };
}

test('multi-record resumable work resolves durable peers to tabs and keeps capture/review nested', () => {
  const brief = 'Help multiple roles revisit Home, Records, saved Drafts, and History while completing offline work. Users may capture evidence and review the current task.';
  const screens = [
    screen('Home', 'primary', 'Understand current state and resume work.', { candidate: candidate(), tabLabel: 'Home' }),
    screen('Records', 'supporting', 'Find and revisit ongoing records.', { kind: 'stack-root', candidate: candidate(), tabLabel: 'Records' }),
    screen('Drafts', 'supporting', 'Resume saved offline drafts.', { kind: 'stack-root', candidate: candidate(), tabLabel: 'Drafts' }),
    screen('Capture', 'key-flow', 'Capture evidence for the active record.', { kind: 'modal', candidate: candidate({ revisitedIndependently: false, peerToOtherDestinations: false, isNotAFlowStep: false, isNotAnAction: false }), parentRoute: '/(app)/records' }),
    screen('Review', 'supporting', 'Review the current task before completion.', { candidate: candidate({ hasStableRoot: false, revisitedIndependently: false, peerToOtherDestinations: false, isNotAFlowStep: false }), parentRoute: '/(app)/records' }),
  ];
  const value = contracts(brief, screens, [{ id: 'capture', label: 'Capture', order: 1, screenIds: ['Capture'], completionRuleId: 'stage-capture-complete' }, { id: 'review', label: 'Review', order: 2, screenIds: ['Review'], completionRuleId: 'stage-review-complete' }]);
  assert.equal(value.contract.model, 'tabs-stack');
  assert.deepEqual(value.contract.destinations.map((item) => item.label), ['Home', 'Records', 'Drafts']);
  assert.equal(value.contract.destinations.some((item) => /Capture|Review/.test(item.label)), false);
  assert.equal(value.contract.flows.find((flow) => flow.screenIds.includes('Capture')).presentation, 'full-screen-modal');
  assert.equal(value.screenContract.screens.find((item) => item.id === 'Capture').navigation.destinationId, 'records');
  assert.deepEqual(validateNavigationContract(value.contract, { experienceContract: value.experience, workflowJourney: value.workflow, screenContract: value.screenContract }).errors, []);
});

test('multiple roles and records cannot be locked to stack by an active capture workflow', () => {
  const brief = 'Field staff, reviewers, and planners manage many ongoing assignments. They capture new work, resume saved offline drafts, and revisit history.';
  const screens = [
    screen('Today', 'primary', 'Understand current state and switch to ongoing work.', { candidate: candidate(), tabLabel: 'Today' }),
    screen('Assignments', 'supporting', 'Find and revisit ongoing assignments across roles.', { kind: 'stack-root', candidate: candidate(), tabLabel: 'Assignments' }),
    screen('Drafts', 'supporting', 'Resume saved incomplete work offline.', { kind: 'stack-root', candidate: candidate(), tabLabel: 'Drafts' }),
    screen('History', 'supporting', 'Revisit completed work independently.', { kind: 'stack-root', candidate: candidate(), tabLabel: 'History' }),
    screen('Capture', 'key-flow', 'Capture evidence for one assignment.', { kind: 'modal', parentRoute: '/(app)/assignments', candidate: candidate({ revisitedIndependently: false, peerToOtherDestinations: false, isNotAFlowStep: false, isNotAnAction: false }) }),
    screen('Review', 'supporting', 'Review the active assignment before completion.', { parentRoute: '/(app)/assignments', candidate: candidate({ hasStableRoot: false, revisitedIndependently: false, peerToOtherDestinations: false, isNotAFlowStep: false }) }),
  ];
  const value = contracts(brief, screens, [
    { id: 'capture', label: 'Capture', order: 1, screenIds: ['Capture'], completionRuleId: 'stage-capture-complete' },
    { id: 'review', label: 'Review', order: 2, screenIds: ['Review'], completionRuleId: 'stage-review-complete' },
  ]);
  value.experience.navigationModel = 'stack';
  value.experience.provisionalNavigationHint = 'stack';
  const resolved = resolveNavigationContract(brief, value.experience, value.workflow, value.preliminary);
  assert.equal(resolved.contract.model, 'tabs-stack');
  assert.deepEqual(resolved.contract.destinations.map((item) => item.label), ['Today', 'Assignments', 'Drafts', 'History']);
  assert.equal(resolved.contract.destinations.some((item) => /Capture|Review/.test(item.label)), false);
  assert.equal(resolved.contract.flows.find((flow) => flow.screenIds.includes('Capture')).ownerDestinationId, 'assignments');
  assert.equal(resolved.contract.flows.find((flow) => flow.screenIds.includes('Review')).ownerDestinationId, 'assignments');
});

test('single bounded capture utility remains an evidence-backed stack', () => {
  const brief = 'Scan one item, review it, and submit the result. This is one bounded session.';
  const screens = [
    screen('Capture', 'primary', 'Scan one item and continue.', { candidate: candidate() }, '/(app)/capture'),
    screen('Review', 'key-flow', 'Review the captured item.', { candidate: candidate({ hasStableRoot: false, revisitedIndependently: false, peerToOtherDestinations: false, isNotAFlowStep: false }), parentRoute: '/(app)/capture' }, '/(app)/review'),
  ];
  const value = contracts(brief, screens);
  assert.equal(value.contract.model, 'stack');
  assert.match(value.contract.decision.stackOnlyReason, /Fewer than three durable peer destinations/);
  assert.ok(value.contract.decision.stackOnlyEvidence.length > 0);
  assert.equal(value.contract.destinations.length, 1);
});

test('navigation resolution is independent of domain adapters and overrides a coarse stack hint', () => {
  const brief = 'Let people revisit Home, Library, Progress, and Profile while lessons remain nested.';
  const screens = [
    screen('Home', 'primary', 'See the next useful learning action.', { candidate: candidate(), tabLabel: 'Home' }),
    screen('Library', 'supporting', 'Browse and revisit the learning library.', { kind: 'stack-root', candidate: candidate(), tabLabel: 'Library' }),
    screen('Progress', 'supporting', 'Understand progress across sessions.', { kind: 'stack-root', candidate: candidate(), tabLabel: 'Progress' }),
    screen('Lesson', 'key-flow', 'Complete the current lesson.', { candidate: candidate({ hasStableRoot: false, revisitedIndependently: false, peerToOtherDestinations: false, isNotAFlowStep: false }), parentRoute: '/(app)/library' }),
  ];
  const value = contracts(brief, screens);
  value.experience.navigationModel = 'stack';
  value.experience.provisionalNavigationHint = 'stack';
  const first = resolveNavigationContract(brief, value.experience, value.workflow, value.preliminary);
  const second = resolveNavigationContract(brief, value.experience, value.workflow, structuredClone(value.preliminary));
  assert.equal(first.contract.model, 'tabs-stack');
  assert.deepEqual(first.contract, second.contract);
  assert.equal(first.contract.decision.provisionalHint, 'stack');
});

test('validation rejects action destinations and unowned screens', () => {
  const value = contracts('Open Home and saved Drafts, then submit current work.', [
    screen('Home', 'primary', 'Open current state.', { candidate: candidate() }),
    screen('Drafts', 'supporting', 'Resume saved drafts.', { kind: 'stack-root', candidate: candidate() }),
  ]);
  value.contract.destinations[0].label = 'Submit';
  value.contract.flows = [];
  value.screenContract.screens.push(screen('Orphan', 'supporting', 'Unowned screen.'));
  const errors = validateNavigationContract(value.contract, { experienceContract: value.experience, workflowJourney: value.workflow, screenContract: value.screenContract }).errors.join('\n');
  assert.match(errors, /represents an action/);
  assert.match(errors, /has no destination or flow owner/);
});

test('continuity rejects ordinary details that lose tabs or destination ownership', () => {
  const brief = 'Use Home, Records, and Drafts to revisit ongoing work.';
  const screens = [
    screen('Home', 'primary', 'Understand current work.', { candidate: candidate(), tabLabel: 'Home' }),
    screen('Records', 'supporting', 'Find ongoing records.', { kind: 'stack-root', candidate: candidate(), tabLabel: 'Records' }),
    screen('Drafts', 'supporting', 'Resume saved drafts.', { kind: 'stack-root', candidate: candidate(), tabLabel: 'Drafts' }),
    screen('RecordDetail', 'key-flow', 'Inspect one record.', { parentRoute: '/(app)/records' }, '/(app)/records/[id]'),
  ];
  const value = contracts(brief, screens);
  const pack = { navigation: value.contract, journey: value.workflow, screens: value.screenContract.screens };
  assert.deepEqual(validateNavigationContinuity(pack), []);
  const detail = pack.screens.find((item) => item.id === 'RecordDetail');
  detail.navigation.tabVisibility = 'covered-by-modal';
  detail.navigation.destinationId = 'missing';
  const rules = new Set(validateNavigationContinuity(pack).map((item) => item.rule));
  assert.ok(rules.has('screen-owner-missing'));
  assert.ok(rules.has('ordinary-detail-hides-tabs'));
});

test('foreground CLI attaches Navigation and the aligned Screen Graph to a staged bundle', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'navigation-resolver-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  const brief = 'Use Home, Records, and Drafts to revisit ongoing work.';
  const screens = [
    screen('Home', 'primary', 'Understand current work.', { candidate: candidate(), tabLabel: 'Home' }),
    screen('Records', 'supporting', 'Find ongoing records.', { kind: 'stack-root', candidate: candidate(), tabLabel: 'Records' }),
    screen('Drafts', 'supporting', 'Resume saved drafts.', { kind: 'stack-root', candidate: candidate(), tabLabel: 'Drafts' }),
  ];
  const value = contracts(brief, screens);
  fs.writeFileSync(path.join(root, 'brief.md'), brief);
  fs.writeFileSync(path.join(root, '.tmp', 'experience-contract.json'), JSON.stringify(value.experience));
  const bundlePath = path.join(root, '.tmp', 'plan-artifact-bundle.json');
  fs.writeFileSync(bundlePath, JSON.stringify({ artifacts: { workflowJourneyContract: value.workflow, experienceScreenContract: value.preliminary, navigationContract: null } }));
  const result = spawnSync(process.execPath, [resolverScript, '--project-root', root, '--bundle', '.tmp/plan-artifact-bundle.json', '--update-bundle'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  assert.equal(bundle.artifacts.navigationContract.model, 'tabs-stack');
  assert.equal(bundle.artifacts.experienceScreenContract.screens.every((item) => item.navigation.destinationId), true);
  assert.equal(fs.existsSync(path.join(root, '.tmp', 'navigation-contract.json')), false);
});