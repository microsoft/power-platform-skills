#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { contractHash } = require('./experience-patterns');
const { contextEnrichmentRevision, stableStringify } = require('./resolve-context-enrichment');

const ACTION_FAMILIES = [
  { id: 'identify', label: 'Identify', pattern: /\b(?:identify|find|locate|open|view)\b/i },
  { id: 'select', label: 'Select', pattern: /\b(?:select|choose|book|reserve)\b/i },
  { id: 'record', label: 'Record', pattern: /\b(?:capture|scan|record|enter|add|log|edit)\b/i },
  { id: 'inspect', label: 'Inspect', pattern: /\b(?:inspect|check|verify|assess|evaluate|test)\b/i },
  { id: 'review', label: 'Review', pattern: /\b(?:review|summarize|preview)\b/i },
  { id: 'confirm', label: 'Confirm', pattern: /\b(?:confirm|approve|acknowledge|sign(?:\s+off)?)\b/i },
  { id: 'complete', label: 'Complete', pattern: /\b(?:submit|complete|finish|finalize)\b/i },
];

const ORDERED_KINDS = new Set(['linear-resumable', 'capture-led-linear', 'progress-resumable', 'staged-choice']);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function workflowJourneyRevision(contract) {
  return sha256(stableStringify(contract));
}

function slug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'primary-job';
}

function journeyKind(experience) {
  const surface = experience?.primarySurface;
  if (surface === 'product-led-discovery' || surface === 'content-led-feed' || surface === 'detail-led-decision') return 'discovery-with-nested-flow';
  if (surface === 'learning-journey') return 'progress-resumable';
  if (surface === 'availability-led-discovery') return 'staged-choice';
  if (surface === 'task-led-workflow' || surface === 'guided-onboarding') return 'linear-resumable';
  if (surface === 'capture-led-utility') return 'capture-led-linear';
  if (surface === 'conversation-led-inbox') return 'durable-destinations';
  return 'stateful-overview';
}

function actionEvidence(brief, family) {
  const match = family.pattern.exec(brief);
  if (!match) return null;
  const sentenceStart = Math.max(0, brief.lastIndexOf('.', match.index) + 1);
  const sentenceEndMatch = brief.slice(match.index).search(/[.;\n]/);
  const sentenceEnd = sentenceEndMatch < 0 ? brief.length : match.index + sentenceEndMatch;
  const phrase = brief.slice(sentenceStart, sentenceEnd).trim().replace(/^[-*\d.)\s]+/, '');
  const text = phrase.length <= 100 ? phrase : match[0];
  const start = phrase.length <= 100 ? brief.indexOf(phrase, sentenceStart) : match.index;
  return { text, start, end: start + text.length, matchIndex: match.index };
}

function singleStage(kind, brief) {
  const values = {
    'discovery-with-nested-flow': ['discover', 'Discover'],
    'durable-destinations': ['communicate', 'Communicate'],
    'stateful-overview': ['understand', 'Understand'],
    'staged-choice': ['choose', 'Choose'],
    'progress-resumable': ['continue', 'Continue'],
    'capture-led-linear': ['capture', 'Capture'],
    'linear-resumable': ['work', 'Work'],
  };
  const [id, label] = values[kind];
  const text = brief.slice(0, Math.min(brief.length, 100)).trim();
  return [{ id, label, evidence: { text, start: 0, end: text.length } }];
}

function deriveStages(brief, kind) {
  if (!ORDERED_KINDS.has(kind)) return singleStage(kind, brief);
  const candidates = ACTION_FAMILIES
    .map((family) => ({ ...family, evidence: actionEvidence(brief, family) }))
    .filter((family) => family.evidence)
    .sort((left, right) => left.evidence.matchIndex - right.evidence.matchIndex);
  const explicitOrder = /\b(?:then|before|after|next|finally|stage|step|progress|resume|draft|must\b[^.\n]*\bbefore)\b/i.test(brief);
  const meaningfulSequence = candidates.length >= 3 || (candidates.length >= 2 && explicitOrder);
  if (!meaningfulSequence) return singleStage(kind, brief);
  return candidates.map(({ id, label, evidence }) => ({
    id,
    label,
    evidence: { text: evidence.text, start: evidence.start, end: evidence.end },
  }));
}

function screenIdForStage(stage, screenContract, used, stageIndex) {
  const screens = screenContract?.screens || [];
  const terms = new Set([stage.id, stage.label.toLowerCase()]);
  const match = screens.find((screen) => {
    if (used.has(screen.id)) return false;
    const semantic = `${screen.id} ${screen.purpose || ''} ${screen.header?.title || ''}`.toLowerCase();
    return [...terms].some((term) => semantic.includes(term));
  });
  if (match) {
    used.add(match.id);
    return match.id;
  }
  const fallback = stageIndex === 0
    ? screens.find((screen) => screen.role === 'primary' && !used.has(screen.id))
    : screens.find((screen) => !used.has(screen.id));
  if (fallback) {
    used.add(fallback.id);
    return fallback.id;
  }
  return stage.id;
}

function resolveWorkflowJourney(briefText, experienceContract, contextContract, options = {}) {
  const brief = String(briefText || '').trim();
  if (!brief) throw new Error('confirmed brief must be non-empty');
  const kind = journeyKind(experienceContract);
  const stageDrafts = deriveStages(brief, kind);
  const usedScreens = new Set();
  const stages = stageDrafts.map((stage, index) => ({
    ...stage,
    order: index + 1,
    screenIds: [screenIdForStage(stage, options.screenContract, usedScreens, index)],
    completionRuleId: `stage-${stage.id}-complete`,
  }));
  const resumeSupported = /\b(?:offline|limited connectivity|resume|draft|saved|continue|progress|interrupted)\b/i.test(brief)
    || ['linear-resumable', 'progress-resumable'].includes(kind) && stages.length > 1;
  const stageFields = stages.map((stage) => `stage.${stage.id}.complete`);
  const contextFields = (contextContract?.ephemeralModel?.fields || []).map((field) => `context.${field}`);
  const declaredStateFields = [...new Set([
    'primaryRecordId',
    'displayReference',
    'offlineState',
    'currentStageId',
    'completedStageCount',
    'requiredStageCount',
    ...(resumeSupported ? ['draftState'] : []),
    ...contextFields,
    ...stageFields,
  ])];
  const completionGuards = stages.map((stage) => ({
    id: stage.completionRuleId,
    expression: `stage.${stage.id}.complete == true`,
    referencedFields: [`stage.${stage.id}.complete`],
    blockingMessage: `Complete ${stage.label.toLowerCase()} before continuing.`,
  }));
  if (stages.length > 1) {
    completionGuards.push({
      id: 'all-required-stages-complete',
      expression: stageFields.map((field) => `${field} == true`).join(' && '),
      referencedFields: stageFields,
      blockingMessage: 'Complete every required stage before finishing.',
    });
  }
  const actions = [];
  const stateActions = [];
  for (const [index, stage] of stages.entries()) {
    const currentScreen = stage.screenIds[0];
    const plannedScreen = options.screenContract?.screens?.find((screen) => screen.id === currentScreen);
    const nextStage = stages[index + 1];
    const workAction = plannedScreen?.primaryAction?.id || `work-${stage.id}`;
    const advanceAction = nextStage ? `continue-${stage.id}` : `complete-${stage.id}`;
    actions.push({
      id: workAction,
      label: plannedScreen?.primaryAction?.label || `Continue ${stage.label.toLowerCase()}`,
      kind: 'local',
      target: currentScreen,
      stageId: stage.id,
      semanticRole: 'primary',
    });
    actions.push({
      id: advanceAction,
      label: nextStage ? `Continue to ${nextStage.label}` : 'Complete workflow',
      kind: nextStage ? 'route' : 'local',
      target: nextStage?.screenIds[0] || currentScreen,
      stageId: stage.id,
      semanticRole: 'primary',
    });
    const laterActions = [
      advanceAction,
      ...stages.slice(index + 1).flatMap((candidate, laterIndex) => [
        options.screenContract?.screens?.find((screen) => screen.id === candidate.screenIds[0])?.primaryAction?.id || `work-${candidate.id}`,
        stages[index + laterIndex + 2] ? `continue-${candidate.id}` : `complete-${candidate.id}`,
      ]),
    ];
    stateActions.push({
      screenId: currentScreen,
      state: 'incomplete',
      primaryAction: workAction,
      guardId: null,
      enabledActions: [workAction],
      disabledActions: [...new Set(laterActions)],
      hiddenActions: [],
    });
    stateActions.push({
      screenId: currentScreen,
      state: 'complete',
      primaryAction: advanceAction,
      guardId: nextStage ? stage.completionRuleId : (stages.length > 1 ? 'all-required-stages-complete' : stage.completionRuleId),
      enabledActions: [advanceAction],
      disabledActions: [],
      hiddenActions: [],
    });
  }
  const signatureComponents = [];
  if (ORDERED_KINDS.has(kind) && stages.length > 1) {
    signatureComponents.push({
      kind: 'workflow-stepper',
      placement: 'task-screen-header',
      requiredOnStageScreens: true,
      requiredWhen: null,
      testId: 'journey-primary-stepper',
      semanticRole: 'progress',
    });
  }
  if (resumeSupported) {
    signatureComponents.push({
      kind: 'resume-draft-module',
      placement: 'primary-screen',
      requiredOnStageScreens: false,
      requiredWhen: 'resume.supported && draftState != empty',
      testId: 'journey-resume-draft',
      semanticRole: 'resume',
    });
  }
  if (/\b(?:offline|limited connectivity|saved on device|pending sync)\b/i.test(brief)) {
    signatureComponents.push({
      kind: 'offline-status',
      placement: 'task-context',
      requiredOnStageScreens: true,
      requiredWhen: 'offlineState != online',
      testId: 'journey-offline-status',
      semanticRole: 'status',
    });
  }
  const capabilityComposition = [];
  if (/\b(?:camera|scan|barcode|qr|photo|photograph)\b/i.test(brief)) {
    const primaryCapture = kind === 'capture-led-linear'
      && stages.length === 1
      && !/\b(?:optional|alternative|identify|find|select|inspect|review|confirm|edit)\b/i.test(brief);
    capabilityComposition.push({
      capability: /\b(?:barcode|qr|scan)\b/i.test(brief) ? 'barcode-scanner' : 'camera',
      mode: primaryCapture ? 'primary' : 'on-demand',
      fallbackStates: ['loading', 'permission-denied', 'unavailable', 'offline', 'manual-entry'],
      maxViewportShare: primaryCapture ? 0.42 : 0.24,
    });
  }
  const displayEntries = contextContract?.displayContext || [];
  const firstDomainEntity = options.domainModel?.entities?.[0];
  const firstDomainRecord = firstDomainEntity ? options.domainModel?.fixtures?.[firstDomainEntity.key]?.[0] : null;
  const domainRecordId = firstDomainRecord?.id || 'fixture-primary';
  const domainDisplayReference = firstDomainRecord?.[firstDomainEntity?.primaryNameField] || null;
  const locationEntry = displayEntries.find((entry) => /(?:location|site|facility|workspace)/i.test(`${entry.id} ${entry.label}`));
  const statusEntry = displayEntries.find((entry) => entry.valueType === 'status');
  const continuityValues = Object.fromEntries(declaredStateFields.map((field) => {
    if (field === 'primaryRecordId') return [field, domainRecordId];
    if (field === 'displayReference') return [field, domainDisplayReference || displayEntries[0]?.sampleValue || experienceContract.primaryJob];
    if (field === 'offlineState') return [field, /\b(?:offline|limited connectivity|saved on device)\b/i.test(brief) ? 'saved-locally' : 'online'];
    if (field === 'currentStageId') return [field, stages[0].id];
    if (field === 'completedStageCount') return [field, 0];
    if (field === 'requiredStageCount') return [field, stages.length];
    if (field === 'draftState') return [field, resumeSupported ? 'saved-draft' : 'not-applicable'];
    if (field.startsWith('stage.')) return [field, false];
    if (field.startsWith('context.')) {
      const contextField = field.slice('context.'.length);
      const entry = displayEntries.find((candidate) => candidate.id === slug(contextField) || candidate.id.replace(/-/g, '') === contextField.toLowerCase());
      return [field, entry?.sampleValue || null];
    }
    return [field, null];
  }));
  const scenarios = [{
    id: 'primary-scenario',
    actor: experienceContract.audience || 'user',
    currentSituation: experienceContract.primaryJob,
    primaryRecordId: continuityValues.primaryRecordId,
    displayReference: continuityValues.displayReference,
    locationName: locationEntry?.sampleValue || null,
    priorityStatus: statusEntry?.sampleValue || 'Active',
    offlineState: continuityValues.offlineState,
    currentStageId: continuityValues.currentStageId,
    completedStageCount: continuityValues.completedStageCount,
    requiredStageCount: continuityValues.requiredStageCount,
    draftState: continuityValues.draftState || 'not-applicable',
    completionBlockers: [stages[0].completionRuleId],
    continuityValues,
  }];
  return {
    schemaVersion: 1,
    experienceContractSha256: contractHash(experienceContract),
    contextEnrichmentSha256: contextEnrichmentRevision(contextContract),
    journeyId: 'primary-job',
    journeyKind: kind,
    primaryOutcome: experienceContract.primaryJob,
    entryPoints: resumeSupported ? ['home', 'saved-draft'] : ['home'],
    resume: {
      supported: resumeSupported,
      restoreLastCompletedStage: resumeSupported,
      restoreDraftData: resumeSupported,
      visibleOnPrimaryScreen: resumeSupported,
    },
    declaredStateFields,
    stages,
    completionGuards,
    actions,
    stateActions,
    signatureComponents,
    continuityKeys: [...new Set([
      'primaryRecordId',
      'displayReference',
      'offlineState',
      'currentStageId',
      'completedStageCount',
      'requiredStageCount',
      ...(resumeSupported ? ['draftState'] : []),
      ...contextFields,
    ])],
    scenarios,
    capabilityComposition,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--brief') args.brief = argv[++index];
    else if (argv[index] === '--experience-contract') args.experienceContract = argv[++index];
    else if (argv[index] === '--context-contract') args.contextContract = argv[++index];
    else if (argv[index] === '--screen-contract') args.screenContract = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.projectRoot) {
    process.stderr.write('Usage: node resolve-workflow-journey.js --project-root <dir> [--brief brief.md] [--experience-contract .tmp/experience-contract.json] [--context-contract .tmp/context-enrichment-contract.json] [--screen-contract .tmp/experience-screen-contract.json] [--output .tmp/workflow-journey-contract.json]\n');
    return 2;
  }
  try {
    const root = path.resolve(args.projectRoot);
    const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.resolve(root, relativePath), 'utf8'));
    const screenPath = path.resolve(root, args.screenContract || '.tmp/experience-screen-contract.json');
    const contract = resolveWorkflowJourney(
      fs.readFileSync(path.resolve(root, args.brief || 'brief.md'), 'utf8'),
      readJson(args.experienceContract || '.tmp/experience-contract.json'),
      readJson(args.contextContract || '.tmp/context-enrichment-contract.json'),
      { screenContract: fs.existsSync(screenPath) ? JSON.parse(fs.readFileSync(screenPath, 'utf8')) : null },
    );
    const outputPath = path.resolve(root, args.output || '.tmp/workflow-journey-contract.json');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(contract, null, 2)}\n`);
    process.stdout.write(`Workflow journey written: ${outputPath} (${contract.journeyKind})\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`resolve-workflow-journey: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { journeyKind, resolveWorkflowJourney, workflowJourneyRevision };