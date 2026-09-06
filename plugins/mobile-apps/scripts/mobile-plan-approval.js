#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  APPROVAL_PATH,
  approveGate,
  invalidateApprovalReceipt,
  validateIntegrity,
} = require('./lib/mobile-plan-approval');
const { stableJson } = require('./build-dataverse-operation-manifest');

function parseArgs(argv) {
  const args = { command: argv[2] };
  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--project-root') args.projectRoot = argv[++index];
    else if (token === '--gate') args.gate = argv[++index];
    else if (token === '--from-gate') args.fromGate = argv[++index];
    else if (token === '--reason') args.reason = argv[++index];
    else if (token === '--now') args.now = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!args.projectRoot) throw new Error('--project-root is required');
  return args;
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, stableJson(value), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function main(argv = process.argv) {
  try {
    const args = parseArgs(argv);
    const projectRoot = path.resolve(args.projectRoot);
    const receiptPath = path.resolve(projectRoot, APPROVAL_PATH);
    if (args.command === 'approve') {
      if (!args.gate) throw new Error('--gate is required for approve');
      const receipt = approveGate(projectRoot, args.gate, { now: args.now });
      process.stdout.write(`${JSON.stringify({
        ok: true,
        gate: Number(args.gate),
        receipt: APPROVAL_PATH,
        state: receipt.receiptState,
        integritySha256: receipt.integritySha256,
      })}\n`);
      return 0;
    }
    if (args.command === 'validate') {
      const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      const result = validateIntegrity(receipt);
      if (!result.valid) result.errors.forEach((error) => process.stderr.write(`${error}\n`));
      else process.stdout.write(`${JSON.stringify({ ok: true, receipt: APPROVAL_PATH })}\n`);
      return result.valid ? 0 : 1;
    }
    if (args.command === 'invalidate') {
      if (!args.fromGate) throw new Error('--from-gate is required for invalidate');
      const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      const invalidated = invalidateApprovalReceipt(receipt, {
        fromGate: args.fromGate,
        reason: args.reason,
        now: args.now,
      });
      atomicWrite(receiptPath, invalidated);
      process.stdout.write(`${JSON.stringify({
        ok: true,
        fromGate: Number(args.fromGate),
        receipt: APPROVAL_PATH,
        integritySha256: invalidated.integritySha256,
      })}\n`);
      return 0;
    }
    throw new Error('command must be approve, validate, or invalidate');
  } catch (error) {
    process.stderr.write(`mobile-plan-approval: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { main, parseArgs };