#!/usr/bin/env node
'use strict';

/**
 * Portable four-section textual plan review protocol. It works without a
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

const CHECKPOINTS = [
  { key: 'dataModel', label: 'data-model' },
  { key: 'nativeCapabilities', label: 'native-capabilities' },
  { key: 'connectors', label: 'connectors' },
  { key: 'screenPlan', label: 'screen-plan' },
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function approvalId(revision, workflow) {
  return sha256(stableJson({
    workflow,
    artifactRevisionSha256: revision.artifactRevisionSha256,
  }));
}

function requireCompletePlanningArtifacts(revision) {
  const missing = Object.entries(revision.artifactHashes)
    .filter(([, hash]) => !hash)
    .map(([key]) => key);
  if (missing.length) {
    throw new Error(`Planning artifacts are missing: ${missing.join(', ')}`);
  }
}

function checkpointKey(value, { allowAll = false } = {}) {
  if (!value) return null;
  const normalized = String(value).trim().toLowerCase().replace(/[-_\s]+/g, '');
  if (normalized === 'all') return allowAll ? 'all' : null;
  const match = CHECKPOINTS.find((checkpoint) => checkpoint.key.toLowerCase() === normalized);
  return match ? match.key : null;
}

function approvedSections(approvals) {
  return CHECKPOINTS
    .filter((checkpoint) => approvals?.[checkpoint.key]?.status === 'approved')
    .map((checkpoint) => checkpoint.label);
}

function summary(workflow) {
  return workflow === 'create-mobile-prototype'
    ? 'Local prototype draft is ready for four textual plan checkpoints.'
    : 'Real app draft is ready for textual approval before external mutation.';
}

function pendingState(revision, workflow, reason = 'plan-draft') {
  return {
    schemaVersion: 1,
    workflow,
    status: 'needs-user-approval',
    approvalProtocol: 'textual-checkpoints',
    approvalId: approvalId(revision, workflow),
    planPath: revision.paths.planPath,
    planRevisionSha256: revision.planSha256,
    contractRevisionSha256: revision.contractSha256,
    artifactRevisionSha256: revision.artifactRevisionSha256,
    artifactHashes: revision.artifactHashes,
    sections: CHECKPOINTS.map((checkpoint) => checkpoint.label),
    mayAuthorizeExternalMutations: false,
    summary: summary(workflow),
    reason,
    approvals: Object.fromEntries(CHECKPOINTS.map((checkpoint) => [checkpoint.key, { status: 'pending' }])),
  };
}

function matchingRevision(receipt, revision, workflow) {
  return receipt
    && receipt.workflow === workflow
    && receipt.planRevisionSha256 === revision.planSha256
    && receipt.contractRevisionSha256 === revision.contractSha256
    && receipt.artifactRevisionSha256 === revision.artifactRevisionSha256
    && receipt.approvalId === approvalId(revision, workflow);
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
  receipt.artifactRevisionSha256 = revision.artifactRevisionSha256;
  receipt.artifactHashes = revision.artifactHashes;
  receipt.sections = CHECKPOINTS.map((checkpoint) => checkpoint.label);
  receipt.mayAuthorizeExternalMutations = true;
  receipt.summary = summary(workflow);
  receipt.approvedSections = CHECKPOINTS.map((checkpoint) => checkpoint.label);
  receipt.integritySha256 = receiptIntegrity(receipt);
  return receipt;
}

function stateForStatus(revision, workflow, receipt) {
  if (!matchingRevision(receipt, revision, workflow)) {
    return { status: 'needs-user-approval', reason: 'plan-revision-changed' };
  }
  if (workflow === 'create-mobile-prototype') {
    const complete = CHECKPOINTS.every((checkpoint) => receipt.approvals?.[checkpoint.key]?.status === 'approved');
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
  requireCompletePlanningArtifacts(revision);
  const receiptPath = revision.paths.receiptPath;
  if (!fs.existsSync(receiptPath)) {
    return { ...pendingState(revision, options.workflow), status: 'needs-user-approval', reason: 'approval-receipt-missing', revision };
  }
  let receipt;
  try {
    receipt = readJson(receiptPath);
  } catch (error) {
    return { ...pendingState(revision, options.workflow, `approval-receipt-invalid:${error.message}`), status: 'needs-user-approval', revision };
  }
  const status = stateForStatus(revision, options.workflow, receipt);
  return { ...receipt, ...status, revision };
}

function publicResult(state) {
  const mayAuthorizeExternalMutations = state.workflow === 'create-mobile-app'
    && state.status === 'approved'
    && state.reason === null
    && state.mayAuthorizeExternalMutations === true;
  return {
    status: state.status,
    reason: state.reason || null,
    planPath: state.planPath || state.revision?.paths?.planPath || null,
    approvalId: state.approvalId || approvalId(state.revision, state.workflow),
    sections: state.sections || CHECKPOINTS.map((checkpoint) => checkpoint.label),
    approvedSections: approvedSections(state.approvals),
    mayAuthorizeExternalMutations,
    summary: state.summary || summary(state.workflow),
    planRevisionSha256: state.planRevisionSha256 || state.revision?.planSha256 || null,
    contractRevisionSha256: state.contractRevisionSha256 || state.revision?.contractSha256 || null,
    artifactRevisionSha256: state.artifactRevisionSha256 || state.revision?.artifactRevisionSha256 || null,
  };
}

function writePending(revision, workflow, reason) {
  const state = pendingState(revision, workflow, reason);
  writeJson(revision.paths.receiptPath, state);
  return state;
}

function approveCheckpoint(revision, workflow, existing, section, approvedAt) {
  if (workflow === 'create-mobile-prototype' && section === 'all') {
    throw new Error('Prototype checkpoint approval requires exactly one named section.');
  }
  if (section !== 'all' && !CHECKPOINTS.some((checkpoint) => checkpoint.key === section)) {
    throw new Error('Checkpoint approval requires a valid named section.');
  }
  const state = matchingRevision(existing, revision, workflow)
    ? { ...existing, approvals: structuredClone(existing.approvals || {}) }
    : pendingState(revision, workflow);
  const targets = section === 'all' ? CHECKPOINTS.map((checkpoint) => checkpoint.key) : [section];
  for (const key of targets) {
    state.approvals[key] = { status: 'approved', approvedAt, method: 'textual' };
  }
  const complete = CHECKPOINTS.every((checkpoint) => state.approvals[checkpoint.key]?.status === 'approved');
  if (!complete) {
    state.status = 'needs-user-approval';
    state.reason = workflow === 'create-mobile-prototype'
      ? 'prototype-checkpoints-pending'
      : 'textual-checkpoints-pending';
    state.approvedSections = approvedSections(state.approvals);
    return state;
  }
  if (workflow === 'create-mobile-prototype') {
    state.status = 'approved';
    state.reason = null;
    state.approvedAt = approvedAt;
    state.approvedPlanSha256 = revision.planSha256;
    state.approvedSections = approvedSections(state.approvals);
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
    process.stderr.write('Usage: node plan-checkpoints.js --project-root <dir> --action draft|approve|status --workflow create-mobile-app|create-mobile-prototype [--section data-model|native-capabilities|connectors|screen-plan|all (real app only)] [--response approve] [--plan <path>] [--contract <path>] [--execution-contract <path>] [--receipt <path>]\n');
    return 2;
  }
  try {
    const revision = currentRevision(args.projectRoot, args);
    requireCompletePlanningArtifacts(revision);
    if (args.action === 'draft') {
      const current = checkpointStatus(args.projectRoot, args);
      if (current.status === 'approved') {
        process.stdout.write(`${JSON.stringify(publicResult(current), null, 2)}\n`);
        return 0;
      }
      const state = writePending(revision, args.workflow, current.reason === 'plan-revision-changed' ? 'plan-revision-changed' : 'plan-draft');
      process.stdout.write(`${JSON.stringify(publicResult({ ...state, revision }), null, 2)}\n`);
      return 0;
    }
    if (args.action === 'approve') {
      if (!textApprovalResponse(args.response)) {
        const state = writePending(revision, args.workflow, 'textual-approve-required');
        process.stdout.write(`${JSON.stringify(publicResult({ ...state, revision }), null, 2)}\n`);
        return 2;
      }
      const section = checkpointKey(
        args.section || (args.workflow === 'create-mobile-app' ? 'all' : null),
        { allowAll: args.workflow === 'create-mobile-app' },
      );
      if (!section) {
        throw new Error(args.workflow === 'create-mobile-prototype'
          ? 'Prototype checkpoint approval requires exactly one named --section.'
          : 'A valid --section is required for real app checkpoint approval.');
      }
      const existing = fs.existsSync(revision.paths.receiptPath) ? readJson(revision.paths.receiptPath) : null;
      const state = approveCheckpoint(revision, args.workflow, existing, section, args.now || new Date().toISOString());
      writeJson(revision.paths.receiptPath, state);
      process.stdout.write(`${JSON.stringify(publicResult({ ...state, revision }), null, 2)}\n`);
      return 0;
    }
    const state = checkpointStatus(args.projectRoot, args);
    if (state.status !== 'approved' && state.reason === 'plan-revision-changed') {
      const pending = writePending(revision, args.workflow, 'plan-revision-changed');
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
  APPROVAL_KEYS: CHECKPOINTS.map((checkpoint) => checkpoint.key),
  approvalId,
  approveCheckpoint,
  checkpointStatus,
  pendingState,
};
