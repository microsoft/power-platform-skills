#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const generateUuid = require('../../../scripts/generate-uuid');
const { preparePlan, validatePlan, saveJson } = require('../../../scripts/lib/style-site-plan');
const {
  safePath, readText, hash, resolveSiteRoot, inspectSite, assertOutsideSite, parseArgs,
} = require('../../../scripts/lib/classic-site-style-context');

function currentHash(root, relative) {
  const file = safePath(root, relative);
  return fs.existsSync(file) ? hash(readText(file)) : null;
}

function preflight(plan) {
  validatePlan(plan);
  if (resolveSiteRoot(plan.siteRoot) !== plan.siteRoot) throw new Error('Site location changed; regenerate the proposal.');
  const changed = plan.writes.filter((write) => write.before !== write.after);
  const applied = changed.length > 0 && changed.every((write) => currentHash(plan.siteRoot, write.path) === write.afterHash);
  const byPath = new Map(plan.writes.map((write) => [write.path, write]));
  if (applied) {
    const expectedPaths = new Set([...plan.inputs.map((input) => input.path), ...plan.writes.map((write) => write.path)]);
    const actualPaths = inspectSite(plan.siteRoot).files.map((file) => file.path);
    if (actualPaths.length !== expectedPaths.size || actualPaths.some((file) => !expectedPaths.has(file))) {
      throw new Error('Site inventory changed after application; inspect it and prepare a new proposal.');
    }
  }
  for (const input of plan.inputs) {
    const expected = applied && byPath.has(input.path) ? byPath.get(input.path).afterHash : input.hash;
    if (currentHash(plan.siteRoot, input.path) !== expected) throw new Error(`Source changed since preview: ${input.path}. Regenerate and obtain approval again.`);
  }
  for (const write of plan.writes) {
    const expected = applied ? write.afterHash : write.beforeHash;
    if (currentHash(plan.siteRoot, write.path) !== expected) throw new Error(`Conflicting local edit: ${write.path}. No changes applied.`);
  }
  if (!applied) {
    // Rebuild from current source and the original request, not only a supplied
    // hash. A recomputed hash alone must not authorize arbitrary metadata writes.
    const rebuilt = preparePlan(plan.siteRoot, plan.request, plan.allocatedIds);
    if (rebuilt.planHash !== plan.planHash) throw new Error('Proposal does not match its request/current inventory. Regenerate it.');
  }
  return { applied, changed };
}

function applyPlan(plan, options = {}) {
  const { applied, changed } = preflight(plan);
  if (!options.apply) return { status: applied ? 'already-applied' : 'dry-run', planHash: plan.planHash, files: changed.map((write) => write.path) };
  if (options.approvedHash !== plan.planHash) throw new Error('Explicit approval of this exact planHash is required before local writes.');
  if (!options.receipt) throw new Error('--receipt is required for local apply.');
  const receiptPath = assertOutsideSite(plan.siteRoot, options.receipt);
  if (fs.existsSync(receiptPath)) throw new Error('Receipt already exists; choose a new path.');
  const receipt = {
    schemaVersion: 1, planHash: plan.planHash, siteRoot: plan.siteRoot,
    status: applied ? 'already-applied' : 'prepared', completed: [],
    changes: changed.map(({ path: file, before, beforeHash, afterHash }) => ({ path: file, before, beforeHash, afterHash })),
  };
  saveJson(receiptPath, receipt, plan.siteRoot);
  if (applied || changed.length === 0) {
    receipt.status = applied ? 'already-applied' : 'no-local-changes';
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    return { status: receipt.status, receipt: receiptPath, files: [] };
  }
  const staged = [];
  try {
    for (const write of changed) {
      const target = safePath(plan.siteRoot, write.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const temporary = `${target}.style-site-${generateUuid()}.tmp`;
      fs.writeFileSync(temporary, write.after, { flag: 'wx' });
      staged.push({ ...write, target, temporary });
    }
    preflight(plan);
    for (const write of staged) {
      if (currentHash(plan.siteRoot, write.path) !== write.beforeHash) throw new Error(`Concurrent edit detected: ${write.path}`);
      safePath(plan.siteRoot, write.path);
      fs.renameSync(write.temporary, write.target);
      receipt.completed.push(write.path);
    }
    for (const write of changed) {
      if (currentHash(plan.siteRoot, write.path) !== write.afterHash) throw new Error(`Written content differs: ${write.path}`);
    }
    receipt.status = 'applied';
  } catch (error) {
    // Multiple files cannot be atomically replaced as a group. Preserve the exact
    // completed set and original bytes, never conceal a partial write or reset Git.
    receipt.status = 'failed';
    receipt.error = error.message;
    throw new Error(`${error.message}. Local receipt: ${receiptPath}; ${receipt.completed.length} file(s) written. No automatic rollback.`);
  } finally {
    for (const write of staged) if (fs.existsSync(write.temporary)) fs.unlinkSync(write.temporary);
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  }
  return { status: receipt.status, receipt: receiptPath, files: receipt.completed };
}

function main(argv) {
  const args = parseArgs(argv, ['plan', 'apply', 'approvedHash', 'receipt']);
  if (!args.plan) throw new Error('--plan is required.');
  const plan = JSON.parse(readText(args.plan));
  return applyPlan(plan, args);
}

if (require.main === module) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(`style-site: ${error.message}`); process.exitCode = 1; }
}
module.exports = { main, applyPlan, preflight };
