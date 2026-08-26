#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RECEIPT_PATH = '.tmp/mobile-plan-status.json';
const REQUIRED_ARTIFACTS = Object.freeze({
  plan: 'native-app-plan.md',
  experienceContract: '.tmp/experience-contract.json',
  contextEnrichment: '.tmp/context-enrichment-contract.json',
  workflowJourney: '.tmp/workflow-journey-contract.json',
  navigationContract: '.tmp/navigation-contract.json',
  screenContract: '.tmp/experience-screen-contract.json',
  foundationContract: '.tmp/experience-foundation-contract.json',
  prototypeDomainModel: '.tmp/prototype-domain-model.json',
  screenActionContract: '.tmp/screen-action-contract.json',
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function currentArtifacts(projectRoot) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const hashes = {};
  for (const [key, relativePath] of Object.entries(REQUIRED_ARTIFACTS)) {
    const filePath = path.join(root, relativePath);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`planning artifact is missing: ${relativePath}`);
    hashes[key] = sha256(fs.readFileSync(filePath));
  }
  return {
    root,
    hashes,
    revision: sha256(stableStringify(hashes)),
    receiptPath: path.join(root, RECEIPT_PATH),
  };
}

function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function pendingReceipt(artifacts, reason = 'prototype-review-pending') {
  return {
    schemaVersion: 1,
    workflow: 'create-mobile-prototype',
    reviewMode: 'consolidated',
    status: 'needs-user-approval',
    reason,
    approvalProtocol: 'textual-consolidated-review',
    planPath: path.join(artifacts.root, REQUIRED_ARTIFACTS.plan),
    artifactHashes: artifacts.hashes,
    artifactRevisionSha256: artifacts.revision,
    sections: ['prototype-review'],
    approvedSections: [],
    approvals: { prototypeReview: { status: 'pending' } },
    mayAuthorizeExternalMutations: false,
  };
}

function readReceipt(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function matchingReceipt(receipt, artifacts) {
  return receipt?.schemaVersion === 1
    && receipt.workflow === 'create-mobile-prototype'
    && receipt.reviewMode === 'consolidated'
    && receipt.artifactRevisionSha256 === artifacts.revision
    && stableStringify(receipt.artifactHashes) === stableStringify(artifacts.hashes)
    && receipt.mayAuthorizeExternalMutations === false;
}

function reviewState(projectRoot, action, options = {}) {
  const artifacts = currentArtifacts(projectRoot);
  const current = readReceipt(artifacts.receiptPath);
  if (action === 'draft') {
    if (matchingReceipt(current, artifacts) && current.status === 'approved') return current;
    const pending = pendingReceipt(artifacts, current ? 'plan-revision-changed' : 'prototype-review-pending');
    writeAtomic(artifacts.receiptPath, pending);
    return pending;
  }
  if (action === 'approve') {
    if (String(options.response || '').trim().toLowerCase() !== 'approve') throw new Error('prototype review requires explicit response approve');
    if (!matchingReceipt(current, artifacts) || current.status !== 'needs-user-approval') throw new Error('draft the current prototype review before approval');
    const approvedAt = options.now || new Date().toISOString();
    const approved = {
      ...current,
      status: 'approved',
      reason: null,
      approvedAt,
      approvedSections: ['prototype-review'],
      approvals: { prototypeReview: { status: 'approved', approvedAt, method: 'textual' } },
      mayAuthorizeExternalMutations: false,
    };
    writeAtomic(artifacts.receiptPath, approved);
    return approved;
  }
  if (action === 'status') {
    if (!matchingReceipt(current, artifacts)) return pendingReceipt(artifacts, current ? 'plan-revision-changed' : 'approval-receipt-missing');
    return current;
  }
  throw new Error(`unsupported action ${action}`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--action') args.action = argv[++index];
    else if (argv[index] === '--response') args.response = argv[++index];
    else if (argv[index] === '--now') args.now = argv[++index];
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.projectRoot || !['draft', 'approve', 'status'].includes(args.action)) {
    process.stderr.write('Usage: node prototype-plan-review.js --project-root <dir> --action draft|approve|status [--response approve]\n');
    return 2;
  }
  try {
    const state = reviewState(args.projectRoot, args.action, args);
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return state.status === 'approved' || args.action === 'draft' ? 0 : 2;
  } catch (error) {
    process.stderr.write(`prototype-plan-review: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { RECEIPT_PATH, REQUIRED_ARTIFACTS, currentArtifacts, matchingReceipt, pendingReceipt, reviewState, sha256, stableStringify, writeAtomic };
