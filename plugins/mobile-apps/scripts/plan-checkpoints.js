#!/usr/bin/env node
'use strict';

/**
 * Portable textual plan review protocol. It works without a
 * host-specific question or plan-mode UI: the outer workflow presents each
 * checkpoint in ordinary chat text, then records `approve` against this local
 * status artifact. Real app approval becomes the receipt consumed by Dataverse
 * mutation gates; prototype approval records local review only and can never
 * emit `mayAuthorizeExternalMutations: true`.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  approvedReceipt,
  currentRevision,
  textApprovalResponse,
} = require('./plan-approval');
const {
  sha256,
  stableJson,
  validateApprovalReceipt,
} = require('./build-dataverse-operation-manifest');

const REAL_CHECKPOINTS = [
  { key: 'dataModel', label: 'data-model' },
  { key: 'nativeCapabilities', label: 'native-capabilities' },
  { key: 'connectors', label: 'connectors' },
  { key: 'screenPlan', label: 'screen-plan' },
];
const PROTOTYPE_CHECKPOINTS = [
  { key: 'prototypeReview', label: 'prototype-review' },
];
const PROTOTYPE_FULL_CHECKPOINTS = [
  { key: 'dataModel', label: 'domain-context' },
  { key: 'nativeCapabilities', label: 'native-capabilities' },
  { key: 'connectors', label: 'connectors' },
  { key: 'screenPlan', label: 'screen-composition' },
];

function reviewMode(workflow, value) {
  return workflow === 'create-mobile-prototype' && value === 'full' ? 'full' : 'consolidated';
}

function checkpoints(workflow, mode = 'consolidated') {
  if (workflow !== 'create-mobile-prototype') return REAL_CHECKPOINTS;
  return mode === 'full' ? PROTOTYPE_FULL_CHECKPOINTS : PROTOTYPE_CHECKPOINTS;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function approvalId(revision, workflow, mode = 'consolidated') {
  return sha256(stableJson({
    workflow,
    artifactRevisionSha256: revision.artifactRevisionSha256,
    ...(workflow === 'create-mobile-prototype' && mode === 'full' ? { reviewMode: mode } : {}),
  }));
}

function requireCompletePlanningArtifacts(revision, workflow) {
  const required = [
    'nativeAppPlanSha256',
    'contextEnrichmentContractSha256',
    'experienceContractSha256',
    'experienceScreenContractSha256',
    'experienceFoundationContractSha256',
    'mobilePlanExecutionContractSha256',
    'mobilePlanExecutionPreflightSha256',
  ];
  if (workflow === 'create-mobile-prototype' || revision.contract) required.push('prototypeDomainModelSha256');
  if (workflow !== 'create-mobile-prototype' && revision.contract) required.push('dataverseSchemaContractSha256');
  const missing = required.filter((key) => !revision.artifactHashes[key]);
  if (missing.length) {
    throw new Error(`Planning artifacts are missing: ${missing.join(', ')}`);
  }
}

function checkpointKey(value, workflow, { allowAll = false, mode = 'consolidated' } = {}) {
  if (!value) return null;
  const normalized = String(value).trim().toLowerCase().replace(/[-_\s]+/g, '');
  if (normalized === 'all') return allowAll ? 'all' : null;
  const match = checkpoints(workflow, mode).find((checkpoint) => [checkpoint.key, checkpoint.label].some((candidate) => candidate.toLowerCase().replace(/[-_\s]+/g, '') === normalized));
  return match ? match.key : null;
}

function approvedSections(approvals, workflow, mode = 'consolidated') {
  return checkpoints(workflow, mode)
    .filter((checkpoint) => approvals?.[checkpoint.key]?.status === 'approved')
    .map((checkpoint) => checkpoint.label);
}

function summary(workflow, mode = 'consolidated') {
  return workflow === 'create-mobile-prototype'
    ? mode === 'full'
      ? 'Local prototype draft is ready for four domain/context, native, connector, and screen/composition reviews.'
      : 'Local prototype draft is ready for one consolidated domain, context, native, connector, and screen/composition review.'
    : 'Real app draft is ready for textual approval before external mutation.';
}

function pendingState(revision, workflow, reason = 'plan-draft', mode = 'consolidated') {
  return {
    schemaVersion: 1,
    workflow,
    status: 'needs-user-approval',
    approvalProtocol: 'textual-checkpoints',
    approvalId: approvalId(revision, workflow, mode),
    reviewMode: mode,
    planPath: revision.paths.planPath,
    planRevisionSha256: revision.planSha256,
    contractRevisionSha256: revision.contractSha256,
    domainModelRevisionSha256: revision.domainModelSha256,
    artifactRevisionSha256: revision.artifactRevisionSha256,
    artifactHashes: revision.artifactHashes,
    sections: checkpoints(workflow, mode).map((checkpoint) => checkpoint.label),
    mayAuthorizeExternalMutations: false,
    summary: summary(workflow, mode),
    reason,
    approvals: Object.fromEntries(checkpoints(workflow, mode).map((checkpoint) => [checkpoint.key, { status: 'pending' }])),
  };
}

function matchingRevision(receipt, revision, workflow, mode = 'consolidated') {
  return receipt
    && receipt.workflow === workflow
    && receipt.planRevisionSha256 === revision.planSha256
    && receipt.contractRevisionSha256 === revision.contractSha256
    && receipt.artifactRevisionSha256 === revision.artifactRevisionSha256
    && reviewMode(workflow, receipt.reviewMode) === mode
    && receipt.approvalId === approvalId(revision, workflow, mode);
}

function receiptIntegrity(receipt) {
  const copy = { ...receipt };
  delete copy.integritySha256;
  return sha256(stableJson(copy));
}

function enrichRealReceipt(revision, workflow, approvedAt) {
  const receipt = approvedReceipt(revision, workflow, approvedAt);
  receipt.approvalProtocol = 'textual-checkpoints';
  receipt.approvalId = approvalId(revision, workflow);
  receipt.planPath = revision.paths.planPath;
  receipt.planRevisionSha256 = revision.planSha256;
  receipt.contractRevisionSha256 = revision.contractSha256;
  receipt.domainModelRevisionSha256 = revision.domainModelSha256;
  receipt.artifactRevisionSha256 = revision.artifactRevisionSha256;
  receipt.artifactHashes = revision.artifactHashes;
  receipt.sections = REAL_CHECKPOINTS.map((checkpoint) => checkpoint.label);
  receipt.mayAuthorizeExternalMutations = true;
  receipt.summary = summary(workflow);
  receipt.approvedSections = REAL_CHECKPOINTS.map((checkpoint) => checkpoint.label);
  receipt.integritySha256 = receiptIntegrity(receipt);
  return receipt;
}

function stateForStatus(revision, workflow, receipt, mode = 'consolidated') {
  if (!matchingRevision(receipt, revision, workflow, mode)) {
    return { status: 'needs-user-approval', reason: 'plan-revision-changed' };
  }
  if (workflow === 'create-mobile-prototype') {
    const complete = checkpoints(workflow, mode).every((checkpoint) => receipt.approvals?.[checkpoint.key]?.status === 'approved');
    return complete && receipt.mayAuthorizeExternalMutations === false
      ? { status: 'approved', reason: null }
      : { status: 'needs-user-approval', reason: 'prototype-checkpoints-pending' };
  }
  if (!revision.contract) {
    return receipt.status === 'approved' && receipt.mayAuthorizeExternalMutations === true
      ? { status: 'approved', reason: null }
      : { status: 'needs-user-approval', reason: 'textual-checkpoints-pending' };
  } else if (receipt.status !== 'approved' || receipt.mayAuthorizeExternalMutations !== true) {
    return { status: 'needs-user-approval', reason: 'textual-checkpoints-pending' };
  }
  const validation = validateApprovalReceipt(receipt, {
    contract: revision.contract,
    planBytes: revision.planBytes,
  });
  return validation.valid
    ? { status: 'approved', reason: null }
    : { status: 'needs-user-approval', reason: validation.errors.join('; ') };
}

function checkpointStatus(projectRoot, options = {}) {
  const revision = currentRevision(projectRoot, options);
  requireCompletePlanningArtifacts(revision, options.workflow);
  const mode = reviewMode(options.workflow, options.reviewMode);
  const receiptPath = revision.paths.receiptPath;
  if (!fs.existsSync(receiptPath)) {
    return { ...pendingState(revision, options.workflow, 'plan-draft', mode), status: 'needs-user-approval', reason: 'approval-receipt-missing', revision };
  }
  let receipt;
  try {
    receipt = readJson(receiptPath);
  } catch (error) {
    return { ...pendingState(revision, options.workflow, `approval-receipt-invalid:${error.message}`, mode), status: 'needs-user-approval', revision };
  }
  const status = stateForStatus(revision, options.workflow, receipt, mode);
  return { ...receipt, ...status, revision };
}

function publicResult(state) {
  const mode = reviewMode(state.workflow, state.reviewMode);
  const mayAuthorizeExternalMutations = state.workflow === 'create-mobile-app'
    && state.status === 'approved'
    && state.reason === null
    && state.mayAuthorizeExternalMutations === true;
  return {
    status: state.status,
    reason: state.reason || null,
    planPath: state.planPath || state.revision?.paths?.planPath || null,
    approvalId: state.approvalId || approvalId(state.revision, state.workflow, mode),
    reviewMode: mode,
    sections: state.sections || checkpoints(state.workflow, mode).map((checkpoint) => checkpoint.label),
    approvedSections: approvedSections(state.approvals, state.workflow, mode),
    mayAuthorizeExternalMutations,
    summary: state.summary || summary(state.workflow, mode),
    planRevisionSha256: state.planRevisionSha256 || state.revision?.planSha256 || null,
    contractRevisionSha256: state.contractRevisionSha256 || state.revision?.contractSha256 || null,
    domainModelRevisionSha256: state.domainModelRevisionSha256 || state.revision?.domainModelSha256 || null,
    artifactRevisionSha256: state.artifactRevisionSha256 || state.revision?.artifactRevisionSha256 || null,
  };
}

function writePending(revision, workflow, reason, mode = 'consolidated') {
  const state = pendingState(revision, workflow, reason, mode);
  writeJson(revision.paths.receiptPath, state);
  return state;
}

function approveCheckpoint(revision, workflow, existing, section, approvedAt, mode = 'consolidated') {
  if (section !== 'all' && !checkpoints(workflow, mode).some((checkpoint) => checkpoint.key === section)) {
    throw new Error('Checkpoint approval requires a valid named section.');
  }
  const state = matchingRevision(existing, revision, workflow, mode)
    ? { ...existing, approvals: structuredClone(existing.approvals || {}) }
    : pendingState(revision, workflow, 'plan-draft', mode);
  const targets = section === 'all' ? checkpoints(workflow, mode).map((checkpoint) => checkpoint.key) : [section];
  for (const key of targets) {
    state.approvals[key] = { status: 'approved', approvedAt, method: 'textual' };
  }
  const complete = checkpoints(workflow, mode).every((checkpoint) => state.approvals[checkpoint.key]?.status === 'approved');
  if (!complete) {
    state.status = 'needs-user-approval';
    state.reason = workflow === 'create-mobile-prototype'
      ? 'prototype-checkpoints-pending'
      : 'textual-checkpoints-pending';
    state.approvedSections = approvedSections(state.approvals, workflow, mode);
    return state;
  }
  if (workflow === 'create-mobile-prototype') {
    state.status = 'approved';
    state.reason = null;
    state.approvedAt = approvedAt;
    state.approvedPlanSha256 = revision.planSha256;
    state.approvedSections = approvedSections(state.approvals, workflow, mode);
    state.mayAuthorizeExternalMutations = false;
    return state;
  }
  return enrichRealReceipt(revision, workflow, approvedAt);
}

function parseArgs(argv) {
  const args = { workflow: 'create-mobile-app' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--action') args.action = argv[++index];
    else if (argv[index] === '--workflow') args.workflow = argv[++index];
    else if (argv[index] === '--review-mode') args.reviewMode = argv[++index];
    else if (argv[index] === '--section') args.section = argv[++index];
    else if (argv[index] === '--response') args.response = argv[++index];
    else if (argv[index] === '--plan') args.plan = argv[++index];
    else if (argv[index] === '--contract') args.contract = argv[++index];
    else if (argv[index] === '--execution-contract') args.executionContract = argv[++index];
    else if (argv[index] === '--execution-preflight') args.executionPreflight = argv[++index];
    else if (argv[index] === '--receipt') args.receipt = argv[++index];
    else if (argv[index] === '--now') args.now = argv[++index];
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.projectRoot || !['draft', 'approve', 'status'].includes(args.action)
    || !['create-mobile-app', 'create-mobile-prototype'].includes(args.workflow)) {
    process.stderr.write('Usage: node plan-checkpoints.js --project-root <dir> --action draft|approve|status --workflow create-mobile-app|create-mobile-prototype [--review-mode consolidated|full] [--section prototype-review|domain-context|native-capabilities|connectors|screen-composition|all (real app only)] [--response approve] [--plan <path>] [--contract <path>] [--execution-contract <path>] [--receipt <path>]\n');
    return 2;
  }
  try {
    const mode = reviewMode(args.workflow, args.reviewMode);
    const revision = currentRevision(args.projectRoot, args);
    requireCompletePlanningArtifacts(revision, args.workflow);
    if (args.action === 'draft') {
      const current = checkpointStatus(args.projectRoot, args);
      if (current.status === 'approved') {
        process.stdout.write(`${JSON.stringify(publicResult(current), null, 2)}\n`);
        return 0;
      }
      const state = writePending(revision, args.workflow, current.reason === 'plan-revision-changed' ? 'plan-revision-changed' : 'plan-draft', mode);
      process.stdout.write(`${JSON.stringify(publicResult({ ...state, revision }), null, 2)}\n`);
      return 0;
    }
    if (args.action === 'approve') {
      if (!textApprovalResponse(args.response)) {
        const state = writePending(revision, args.workflow, 'textual-approve-required', mode);
        process.stdout.write(`${JSON.stringify(publicResult({ ...state, revision }), null, 2)}\n`);
        return 2;
      }
      const section = checkpointKey(
        args.section || (args.workflow === 'create-mobile-app' ? 'all' : null),
        args.workflow,
        { allowAll: args.workflow === 'create-mobile-app', mode },
      );
      if (!section) {
        throw new Error(args.workflow === 'create-mobile-prototype'
          ? mode === 'full'
            ? 'Full prototype approval requires --section domain-context, native-capabilities, connectors, or screen-composition.'
            : 'Prototype approval requires --section prototype-review.'
          : 'A valid --section is required for plan approval.');
      }
      const existing = fs.existsSync(revision.paths.receiptPath) ? readJson(revision.paths.receiptPath) : null;
      const state = approveCheckpoint(revision, args.workflow, existing, section, args.now || new Date().toISOString(), mode);
      writeJson(revision.paths.receiptPath, state);
      process.stdout.write(`${JSON.stringify(publicResult({ ...state, revision }), null, 2)}\n`);
      return 0;
    }
    const state = checkpointStatus(args.projectRoot, args);
    if (state.status !== 'approved' && state.reason === 'plan-revision-changed') {
      const pending = writePending(revision, args.workflow, 'plan-revision-changed', mode);
      process.stdout.write(`${JSON.stringify(publicResult({ ...pending, revision }), null, 2)}\n`);
      return 2;
    }
    process.stdout.write(`${JSON.stringify(publicResult(state), null, 2)}\n`);
    return state.status === 'approved' ? 0 : 2;
  } catch (error) {
    process.stderr.write(`plan-checkpoints: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  APPROVAL_KEYS: REAL_CHECKPOINTS.map((checkpoint) => checkpoint.key),
  PROTOTYPE_APPROVAL_KEYS: PROTOTYPE_CHECKPOINTS.map((checkpoint) => checkpoint.key),
  approvalId,
  approveCheckpoint,
  checkpointStatus,
  pendingState,
};
