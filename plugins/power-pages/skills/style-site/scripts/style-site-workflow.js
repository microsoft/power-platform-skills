#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { preparePlan, validatePlan, saveJson } = require('../../../scripts/lib/style-site-plan');
const { resolveSiteRoot, assertOutsideSite, parseArgs, readText } = require('../../../scripts/lib/classic-site-style-context');
const { compactSummary, reviewPlan } = require('../../../scripts/lib/style-site-summary');
const { applyPlan } = require('./apply-style-plan');
const { verify } = require('./validate-style-site');
const { needsContrastReview } = require('../../../scripts/lib/style-site-contrast');

function prepare({ siteRoot, request, out }) {
  if (!request || !out) throw new Error('Prepare requires --siteRoot, --request and a new external --out directory.');
  const root = resolveSiteRoot(siteRoot);
  assertOutsideSite(root, request);
  const directory = assertOutsideSite(root, out);
  if (fs.existsSync(directory)) throw new Error('Revision directory already exists; select a new --out directory.');
  const plan = preparePlan(root, JSON.parse(readText(request)));
  validatePlan(plan);
  const review = reviewPlan(plan);
  review.contrastReview = needsContrastReview(plan.request) ? 'required-before-approval' : 'not-triggered';
  // Reserve one revision directory, never overwrite an earlier approval artifact.
  // Failure may leave review artifacts, but cannot leave any edits in the site.
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  fs.mkdirSync(directory);
  const artifacts = {
    plan: path.join(directory, 'style-site.plan.json'),
    review: path.join(directory, 'style-site.review.json'),
  };
  saveJson(artifacts.plan, plan, root);
  saveJson(artifacts.review, review, root);
  // Per-property explanations belong in the full review. Keep the actionable
  // warning in normal stdout without duplicating the catalog assessment there.
  const { studioSupport: detailedSupport, ...summary } = review;
  return compactSummary({ ...summary, artifacts, verification: 'validated-proposal; rendering is not verified; fresh write checks still required' });
}

function apply({ plan: planFile, approvedHash, receipt }) {
  if (!planFile || !approvedHash || !receipt) throw new Error('Apply requires --plan, --approvedHash and a new external --receipt.');
  const plan = JSON.parse(readText(planFile));
  validatePlan(plan);
  assertOutsideSite(plan.siteRoot, planFile);
  const result = applyPlan(plan, { apply: true, approvedHash, receipt });
  // This is a distinct implementation and a fresh scan, not the writer asserting
  // its own success. A failure is reported with the persisted recovery receipt.
  let verification;
  try { verification = verify(plan, JSON.parse(readText(result.receipt))); }
  catch (error) { throw new Error(`Independent verification failed: ${error.message}. Inspect receipt ${result.receipt}; keep current local state.`); }
  return compactSummary({ ...result, verification, planHash: plan.planHash });
}

function main(argv) {
  const args = parseArgs(argv, ['operation', 'siteRoot', 'request', 'out', 'plan', 'approvedHash', 'receipt']);
  const allowed = args.operation === 'prepare' ? ['operation', 'siteRoot', 'request', 'out'] :
    args.operation === 'apply' ? ['operation', 'plan', 'approvedHash', 'receipt'] : null;
  if (!allowed) throw new Error('--operation must be prepare or apply. HTML preview generation has been removed.');
  if (Object.keys(args).some((key) => !allowed.includes(key))) throw new Error(`Unexpected argument for ${args.operation}.`);
  return args.operation === 'prepare' ? prepare(args) : apply(args);
}

if (require.main === module) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) {
    console.error(JSON.stringify({ status: 'blocked', message: error.message, next: 'Resolve the reported input/target issue. Changed proposals need a new diff review and exact-hash approval.' }));
    process.exitCode = 1;
  }
}
module.exports = { main, prepare, apply };
