#!/usr/bin/env node
'use strict';

/**
 * Host-neutral textual approval protocol for plans that can trigger external
 * mutations. A draft is always safe to write; only an explicit textual approve
 * creates the receipt consumed by Dataverse mutation gates. The plan, schema,
 * Experience Contract, screen contract, and foundation contract hashes are
 * recomputed on every status call, so editing any planning artifact immediately
 * invalidates an earlier approval.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  APPROVAL_RECEIPT_SCHEMA_VERSION,
  contractApprovalContent,
  declaredServiceRequiredTableNames,
  sha256,
  stableJson,
  validateApprovalReceipt,
  validateContract,
} = require('./build-dataverse-operation-manifest');
const { validateProjectExecutionContract } = require('./validate-mobile-plan-execution-contract');

const APPROVAL_KEYS = ['dataModel', 'nativeCapabilities', 'connectors', 'screenPlan'];

function readBytes(filePath) {
  return fs.readFileSync(filePath);
}

function readJson(filePath) {
  return JSON.parse(readBytes(filePath).toString('utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function resolvePaths(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  return {
    root,
    planPath: path.resolve(root, options.plan || 'native-app-plan.md'),
    contractPath: options.contract ? path.resolve(root, options.contract) : path.join(root, '.tmp', 'dataverse-schema-contract.json'),
    experienceContractPath: path.resolve(root, options.experienceContract || '.tmp/experience-contract.json'),
    experienceScreenContractPath: path.resolve(root, options.experienceScreenContract || '.tmp/experience-screen-contract.json'),
    experienceFoundationContractPath: path.resolve(root, options.experienceFoundationContract || '.tmp/experience-foundation-contract.json'),
    executionContractPath: path.resolve(root, options.executionContract || '.tmp/mobile-plan-execution-contract.json'),
    executionPreflightPath: path.resolve(root, options.executionPreflight || '.tmp/mobile-plan-execution-preflight.json'),
    receiptPath: path.resolve(root, options.receipt || '.tmp/mobile-plan-status.json'),
  };
}

function textApprovalResponse(value) {
  return /^(?:approve|approved)$/i.test(String(value || '').trim());
}

function optionalFileSha256(filePath) {
  return fs.existsSync(filePath) ? sha256(readBytes(filePath)) : null;
}

function artifactHashes(paths, planBytes) {
  return {
    nativeAppPlanSha256: sha256(planBytes),
    dataverseSchemaContractSha256: optionalFileSha256(paths.contractPath),
    experienceContractSha256: optionalFileSha256(paths.experienceContractPath),
    experienceScreenContractSha256: optionalFileSha256(paths.experienceScreenContractPath),
    experienceFoundationContractSha256: optionalFileSha256(paths.experienceFoundationContractPath),
    mobilePlanExecutionContractSha256: optionalFileSha256(paths.executionContractPath),
    mobilePlanExecutionPreflightSha256: optionalFileSha256(paths.executionPreflightPath),
  };
}

function currentRevision(projectRoot, options = {}) {
  const paths = resolvePaths(projectRoot, options);
  if (!fs.existsSync(paths.planPath)) throw new Error(`Plan is missing: ${paths.planPath}`);
  const executionValidation = validateProjectExecutionContract(paths.root, paths.executionContractPath);
  if (!executionValidation.valid) {
    throw new Error(`Mobile plan execution contract is invalid: ${executionValidation.errors.join('; ')}`);
  }
  const planBytes = readBytes(paths.planPath);
  const revision = {
    planSha256: sha256(planBytes),
    contractSha256: null,
    contract: null,
    planBytes,
    paths,
  };
  if (fs.existsSync(paths.contractPath)) {
    const contract = readJson(paths.contractPath);
    if (contract !== null) {
      const validation = validateContract(contract);
      if (!validation.valid) throw new Error(`Schema contract is invalid: ${validation.errors.join('; ')}`);
      const approvedContract = contractApprovalContent(contract);
      revision.contract = contract;
      revision.contractSha256 = sha256(stableJson(approvedContract));
    }
  }
  revision.artifactHashes = artifactHashes(paths, planBytes);
  revision.artifactRevisionSha256 = sha256(stableJson(revision.artifactHashes));
  return revision;
}

function pendingApprovalState(revision, workflow, reason = 'plan-draft') {
  return {
    schemaVersion: APPROVAL_RECEIPT_SCHEMA_VERSION,
    workflow,
    status: 'needs-user-approval',
    approvalProtocol: 'textual',
    reason,
    planRevisionSha256: revision.planSha256,
    contractRevisionSha256: revision.contractSha256,
    artifactRevisionSha256: revision.artifactRevisionSha256,
    artifactHashes: revision.artifactHashes,
    approvals: Object.fromEntries(APPROVAL_KEYS.map((key) => [key, { status: 'pending' }])),
  };
}

function approvedReceipt(revision, workflow, approvedAt) {
  if (!revision.contract) {
    // Connector-only and other schema-free flows still need a revision-bound
    // textual approval. Dataverse never consumes this shape because no schema
    // mutation is eligible without a normalized contract.
    return {
      ...pendingApprovalState(revision, workflow, 'approved-schema-free-plan'),
      status: 'approved',
      approvedAt,
      approvals: Object.fromEntries(APPROVAL_KEYS.map((key) => [key, {
        status: 'approved',
        approvedAt,
        method: 'textual',
      }])),
      approvedPlanSha256: revision.planSha256,
    };
  }

  const approvedContract = contractApprovalContent(revision.contract);
  const approvedContractSha256 = sha256(stableJson(approvedContract));
  const serviceRequiredTables = declaredServiceRequiredTableNames(approvedContract).map((logicalName) => ({
    logicalName,
    consumers: [`contract:${logicalName}`],
  }));
  const receipt = {
    schemaVersion: APPROVAL_RECEIPT_SCHEMA_VERSION,
    workflow,
    status: 'approved',
    approvalProtocol: 'textual',
    approvedAt,
    approvals: {
      dataModel: {
        status: 'approved',
        approvedAt,
        method: 'textual',
        approvedContractSha256,
      },
      nativeCapabilities: { status: 'approved', approvedAt, method: 'textual' },
      connectors: { status: 'approved', approvedAt, method: 'textual' },
      screenPlan: { status: 'approved', approvedAt, method: 'textual' },
    },
    approvedPlanSha256: revision.planSha256,
    approvedContractSha256,
    artifactRevisionSha256: revision.artifactRevisionSha256,
    artifactHashes: revision.artifactHashes,
    approvedContract,
    serviceRequiredTables,
  };
  receipt.integritySha256 = sha256(stableJson(receipt));
  return receipt;
}

function approvalStatus(projectRoot, options = {}) {
  const revision = currentRevision(projectRoot, options);
  const { receiptPath } = revision.paths;
  if (!fs.existsSync(receiptPath)) {
    return { status: 'needs-user-approval', reason: 'approval-receipt-missing', revision };
  }
  let receipt;
  try {
    receipt = readJson(receiptPath);
  } catch (error) {
    return { status: 'needs-user-approval', reason: `approval-receipt-invalid:${error.message}`, revision };
  }
  if (receipt.approvedPlanSha256 !== revision.planSha256
    || receipt.contractRevisionSha256 && receipt.contractRevisionSha256 !== revision.contractSha256
    || receipt.artifactRevisionSha256 !== revision.artifactRevisionSha256) {
    return { status: 'needs-user-approval', reason: 'plan-revision-changed', revision, receipt };
  }
  if (revision.contract) {
    const validation = validateApprovalReceipt(receipt, {
      contract: revision.contract,
      planBytes: revision.planBytes,
    });
    if (!validation.valid) {
      return { status: 'needs-user-approval', reason: validation.errors.join('; '), revision, receipt };
    }
  } else if (receipt.status !== 'approved') {
    return { status: 'needs-user-approval', reason: 'approval-receipt-pending', revision, receipt };
  }
  return { status: 'approved', reason: null, revision, receipt };
}

function parseArgs(argv) {
  const args = { workflow: 'create-mobile-app' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--action') args.action = argv[++index];
    else if (argv[index] === '--workflow') args.workflow = argv[++index];
    else if (argv[index] === '--plan') args.plan = argv[++index];
    else if (argv[index] === '--contract') args.contract = argv[++index];
    else if (argv[index] === '--execution-contract') args.executionContract = argv[++index];
    else if (argv[index] === '--execution-preflight') args.executionPreflight = argv[++index];
    else if (argv[index] === '--receipt') args.receipt = argv[++index];
    else if (argv[index] === '--response') args.response = argv[++index];
    else if (argv[index] === '--now') args.now = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  return args;
}

function publicResult(result) {
  return {
    status: result.status,
    reason: result.reason,
    planRevisionSha256: result.revision?.planSha256 || null,
    contractRevisionSha256: result.revision?.contractSha256 || null,
    artifactRevisionSha256: result.revision?.artifactRevisionSha256 || null,
  };
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.projectRoot || !['draft', 'approve', 'status'].includes(args.action)) {
    process.stderr.write('Usage: node plan-approval.js --project-root <dir> --action draft|approve|status [--workflow create-mobile-app] [--response approve] [--plan <path>] [--contract <path>] [--execution-contract <path>] [--receipt <path>] [--json]\n');
    return 2;
  }
  try {
    const revision = currentRevision(args.projectRoot, args);
    if (args.action === 'draft') {
      const existing = approvalStatus(args.projectRoot, args);
      if (existing.status === 'approved') {
        process.stdout.write(`${JSON.stringify(publicResult(existing), null, 2)}\n`);
        return 0;
      }
      const receipt = pendingApprovalState(revision, args.workflow);
      writeJson(revision.paths.receiptPath, receipt);
      const result = { status: 'needs-user-approval', reason: 'plan-draft', revision };
      process.stdout.write(`${JSON.stringify(publicResult(result), null, 2)}\n`);
      return 0;
    }
    if (args.action === 'approve') {
      if (!textApprovalResponse(args.response)) {
        const result = { status: 'needs-user-approval', reason: 'textual-approve-required', revision };
        process.stdout.write(`${JSON.stringify(publicResult(result), null, 2)}\n`);
        return 2;
      }
      const receipt = approvedReceipt(revision, args.workflow, args.now || new Date().toISOString());
      writeJson(revision.paths.receiptPath, receipt);
      const result = { status: 'approved', reason: null, revision };
      process.stdout.write(`${JSON.stringify(publicResult(result), null, 2)}\n`);
      return 0;
    }
    const result = approvalStatus(args.projectRoot, args);
    process.stdout.write(`${JSON.stringify(publicResult(result), null, 2)}\n`);
    return args.json || result.status === 'approved' ? 0 : 2;
  } catch (error) {
    process.stderr.write(`plan-approval: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  approvalStatus,
  approvedReceipt,
  currentRevision,
  pendingApprovalState,
  textApprovalResponse,
};