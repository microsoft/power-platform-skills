'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { deriveExperienceFromBrief } = require('../experience-patterns');
const { resolveContextEnrichment } = require('../resolve-context-enrichment');
const { resolveWorkflowJourney, workflowJourneyRevision } = require('../resolve-workflow-journey');
const { validateWorkflowJourney } = require('../validate-workflow-journey');

function resolve(brief, screenContract = null) {
  const experience = deriveExperienceFromBrief(brief);
  const context = resolveContextEnrichment(brief, experience);
  const journey = resolveWorkflowJourney(brief, experience, context, { screenContract });
  return { brief, experience, context, journey };
}

test('staged resumable work emits ordered stages, guards, resume, and workflow signatures', () => {
  const value = resolve('Help field teams complete assigned work offline: identify the job, record required details, inspect the evidence, confirm the result, then review and submit it. Resume saved drafts after interruptions.');
  assert.equal(value.journey.journeyKind, 'linear-resumable');
  assert.deepEqual(value.journey.stages.map((stage) => stage.order), [1, 2, 3, 4, 5, 6]);
  assert.equal(value.journey.resume.supported, true);
  assert.ok(value.journey.signatureComponents.some((item) => item.kind === 'workflow-stepper'));
  assert.ok(value.journey.signatureComponents.some((item) => item.kind === 'resume-draft-module'));
  assert.ok(value.journey.completionGuards.some((guard) => guard.id === 'all-required-stages-complete'));
  assert.deepEqual(validateWorkflowJourney(value.journey, {
    briefText: value.brief,
    experienceContract: value.experience,
    contextContract: value.context,
  }).errors, []);
  assert.match(workflowJourneyRevision(value.journey), /^[a-f0-9]{64}$/);
});

test('discovery work remains non-staged and does not receive an artificial stepper', () => {
  const value = resolve('Help travelers browse and compare useful products, open details, and save choices for later.');
  assert.equal(value.journey.journeyKind, 'discovery-with-nested-flow');
  assert.equal(value.journey.stages.length, 1);
  assert.equal(value.journey.signatureComponents.some((item) => item.kind === 'workflow-stepper'), false);
  assert.equal(validateWorkflowJourney(value.journey, {
    briefText: value.brief,
    experienceContract: value.experience,
    contextContract: value.context,
  }).valid, true);
});

test('optional scanning resolves to on-demand composition with bounded fallback states', () => {
  const value = resolve('Help technicians identify an assigned task, optionally scan its QR code, inspect details, and confirm completion offline.');
  const scanner = value.journey.capabilityComposition.find((item) => item.capability === 'barcode-scanner');
  assert.equal(scanner.mode, 'on-demand');
  assert.ok(scanner.maxViewportShare <= 0.32);
  assert.ok(scanner.fallbackStates.includes('manual-entry'));
});

test('incomplete state cannot expose actions from a later required stage', () => {
  const value = resolve('Help staff complete assigned work: identify the task, record results, inspect them, then confirm and submit.');
  const incomplete = value.journey.stateActions.find((item) => item.state === 'incomplete');
  const laterAction = value.journey.actions.find((action) => action.stageId === value.journey.stages.at(-1).id);
  incomplete.disabledActions = incomplete.disabledActions.filter((actionId) => actionId !== laterAction.id);
  const errors = validateWorkflowJourney(value.journey, {
    briefText: value.brief,
    experienceContract: value.experience,
    contextContract: value.context,
  }).errors.join('\n');
  assert.match(errors, /exposes an action from a later required stage/);
});

test('journey validation binds stage screens to the screen contract', () => {
  const value = resolve('Help staff complete assigned work: identify the task, record results, inspect them, then confirm and submit.');
  const errors = validateWorkflowJourney(value.journey, {
    briefText: value.brief,
    experienceContract: value.experience,
    contextContract: value.context,
    screenContract: { screens: [{ id: 'unrelated-screen' }] },
  }).errors.join('\n');
  assert.match(errors, /is absent from the Screen Contract/);
});

test('guard expressions can reference only declared state fields', () => {
  const value = resolve('Help staff complete assigned work: identify the task, record results, then confirm and submit.');
  value.journey.completionGuards[0].referencedFields = ['undeclaredProgress'];
  value.journey.completionGuards[0].expression = 'undeclaredProgress == true';
  const errors = validateWorkflowJourney(value.journey, {
    briefText: value.brief,
    experienceContract: value.experience,
    contextContract: value.context,
  }).errors.join('\n');
  assert.match(errors, /references undeclared state field undeclaredProgress/);
});