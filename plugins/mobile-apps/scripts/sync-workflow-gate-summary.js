#!/usr/bin/env node
'use strict';

/** Regenerate the compact Gate 2c review feed after workflow approvals change. */
const fs = require('node:fs');
const path = require('node:path');
const { pathContains } = require('./lib/modernizer-paths.js');
const { deriveWorkflowGateSummary } = require('./lib/workflow-gate-summary.js');
const { WORKFLOW_APPROVAL_STATUSES } = require('./lib/workflow-plan.js');

const MAX_FILE_BYTES = 64 * 1024 * 1024;

function parseArgs(argv) {
  const args = { dir: '', check: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--dir') args.dir = argv[++index] || '';
    else if (argv[index] === '--check') args.check = true;
    else if (argv[index] === '--json') args.json = true;
    else if (argv[index] === '--help' || argv[index] === '-h') {
      process.stdout.write('Usage: node scripts/sync-workflow-gate-summary.js --dir <migration-package> [--check] [--json]\n');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!args.dir) throw new Error('Missing required --dir <migration-package>');
  return args;
}

function readJson(root, relative, label) {
  const file = path.resolve(root, relative);
  if (!pathContains(root, file)) throw new Error(`${label} escapes the migration package: ${relative}`);
  if (!fs.existsSync(file)) throw new Error(`${label} is missing: ${relative}`);
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file: ${relative}`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`${label} exceeds ${MAX_FILE_BYTES} bytes: ${relative}`);
  return { file, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function synchronizeWorkflowGateSummary(directory, options = {}) {
  const absolute = path.resolve(directory);
  if (!fs.existsSync(absolute)) throw new Error(`migration package does not exist: ${absolute}`);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`migration package must be a real directory: ${absolute}`);
  const root = fs.realpathSync(absolute);
  const input = readJson(root, 'mobile-plugin-input.json', 'mobile-plugin-input.json').value;
  const planRelative = input.workflowPlan && input.workflowPlan.file || 'workflows.json';
  const summaryRelative = input.workflowPlan && input.workflowPlan.gateSummaryFile || 'workflow-gate-summary.json';
  const plan = readJson(root, planRelative, 'workflow plan').value;
  const allowedStatuses = new Set(WORKFLOW_APPROVAL_STATUSES);
  for (const [index, workflow] of (plan.workflows || []).entries()) {
    if (!allowedStatuses.has(workflow && workflow.approval && workflow.approval.status)) {
      throw new Error(`workflows[${index}].approval.status is invalid: ${workflow?.approval?.status || 'missing'}`);
    }
  }
  const expected = `${JSON.stringify(deriveWorkflowGateSummary(plan), null, 2)}\n`;
  const summaryFile = path.resolve(root, summaryRelative);
  if (!pathContains(root, summaryFile)) throw new Error(`workflow gate summary escapes the migration package: ${summaryRelative}`);
  const actual = fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf8') : null;
  const changed = actual !== expected;
  if (changed && options.write !== false) {
    if (fs.existsSync(summaryFile)) {
      const summaryStat = fs.lstatSync(summaryFile);
      if (summaryStat.isSymbolicLink() || !summaryStat.isFile()) throw new Error(`workflow gate summary must be a regular file: ${summaryRelative}`);
    }
    const token = `${process.pid}-${Date.now()}`;
    const temp = `${summaryFile}.workflow-summary-${token}.tmp`;
    const backup = `${summaryFile}.workflow-summary-${token}.bak`;
    fs.writeFileSync(temp, expected, { encoding: 'utf8', flag: 'wx' });
    let backedUp = false;
    try {
      if (fs.existsSync(summaryFile)) {
        fs.renameSync(summaryFile, backup);
        backedUp = true;
      }
      fs.renameSync(temp, summaryFile);
    } catch (error) {
      fs.rmSync(temp, { force: true });
      if (backedUp && fs.existsSync(backup) && !fs.existsSync(summaryFile)) fs.renameSync(backup, summaryFile);
      throw error;
    }
    if (backedUp) {
      try { fs.rmSync(backup, { force: true }); } catch (_error) { /* harmless backup */ }
    }
  }
  return {
    packageDir: root,
    summaryFile: summaryRelative,
    changed,
    workflows: plan.workflows && plan.workflows.length || 0,
    bytes: Buffer.byteLength(expected),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = synchronizeWorkflowGateSummary(args.dir, { write: !args.check });
  const output = { ok: !args.check || !result.changed, mode: args.check ? 'check' : 'write', ...result };
  if (args.json || args.check) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else process.stdout.write(`Synchronized ${result.summaryFile} (${result.workflows} workflows, ${result.bytes} bytes).\n`);
  if (args.check && result.changed) process.exitCode = 1;
}

if (require.main === module) {
  try { main(); }
  catch (error) { process.stderr.write(`Workflow gate-summary sync failed: ${error.message}\n`); process.exit(1); }
}

module.exports = { synchronizeWorkflowGateSummary };
