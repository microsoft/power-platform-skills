#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validatePlan } = require('../../../scripts/lib/style-site-plan');
const { safePath, readText, hash, inspectSite, parseArgs, assertOutsideSite } = require('../../../scripts/lib/classic-site-style-context');
const { runValidation, approve, block } = require('../../../scripts/lib/validation-helpers');

function verify(plan, receipt) {
  validatePlan(plan);
  if (receipt && (receipt.planHash !== plan.planHash || receipt.siteRoot !== plan.siteRoot ||
      !['applied', 'already-applied', 'no-local-changes'].includes(receipt.status))) {
    throw new Error('Receipt is failed, incomplete, or belongs to another proposal.');
  }
  const writes = new Map(plan.writes.map((write) => [write.path, write]));
  const expectedPaths = new Set([...plan.inputs.map((input) => input.path), ...(receipt ? plan.writes.map((write) => write.path) : [])]);
  const current = inspectSite(plan.siteRoot);
  if (current.siteId !== plan.siteId || current.files.length !== expectedPaths.size || current.files.some((file) => !expectedPaths.has(file.path))) {
    throw new Error('Styling input inventory changed; regenerate the proposal instead of relying on the old preview.');
  }
  for (const input of plan.inputs) {
    const file = safePath(plan.siteRoot, input.path);
    const expected = receipt && writes.has(input.path) ? writes.get(input.path).afterHash : input.hash;
    if (!fs.existsSync(file) || hash(readText(file)) !== expected) throw new Error(`Input differs from the ${receipt ? 'applied' : 'reviewed'} snapshot: ${input.path}`);
  }
  for (const write of plan.writes) {
    const file = safePath(plan.siteRoot, write.path);
    const actual = fs.existsSync(file) ? hash(readText(file)) : null;
    if (actual !== (receipt ? write.afterHash : write.beforeHash)) throw new Error(`Unexpected target content: ${write.path}`);
  }
  return {
    status: receipt ? 'verified-local-files' : 'verified-proposal',
    planHash: plan.planHash, studioRuntime: 'pending-separate-live-verification',
  };
}

function main(argv) {
  const args = parseArgs(argv, ['plan', 'receipt']);
  if (!args.plan) throw new Error('--plan is required.');
  const plan = JSON.parse(readText(args.plan));
  assertOutsideSite(plan.siteRoot, args.plan);
  if (args.receipt) assertOutsideSite(plan.siteRoot, args.receipt);
  return verify(plan, args.receipt ? JSON.parse(readText(args.receipt)) : null);
}

if (require.main === module) {
  if (process.argv.length > 2) {
    try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
    catch (error) { console.error(`style-site: ${error.message}`); process.exitCode = 1; }
  } else {
    runValidation((cwd) => {
      // Hooks run at invocation, not completion. Only inspect the conventional
      // external workdir if present; the mandatory CLI Verify phase covers any
      // explicitly selected workdir (which the host hook cannot infer).
      const planFile = path.join(cwd, '.powerpages-style', 'style-site.plan.json');
      if (!fs.existsSync(planFile)) return approve();
      const receipt = path.join(cwd, '.powerpages-style', 'style-site.receipt.json');
      try { main(['--plan', planFile, ...(fs.existsSync(receipt) ? ['--receipt', receipt] : [])]); }
      catch (error) { return block(`style-site: ${error.message}`); }
      return approve();
    });
  }
}
module.exports = { main, verify };
