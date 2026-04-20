#!/usr/bin/env node
// Helper: takes an estimate blob + site-level metadata and produces a full planData JSON
// that the renderer can consume. Used for producing sample ALM plans.
//
// Usage: node build-sample.js --estimate <path> --meta <path> --output <path>

'use strict';

const fs = require('fs');
const path = require('path');
const { computeSplitPlan } = require('../../../scripts/lib/compute-split-plan');
const { loadConfig } = require('../../../scripts/lib/alm-thresholds');

function parseArgs(argv) {
  const a = argv.slice(2);
  const out = { estimate: null, meta: null, output: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--estimate' && a[i + 1]) out.estimate = a[++i];
    else if (a[i] === '--meta' && a[i + 1]) out.meta = a[++i];
    else if (a[i] === '--output' && a[i + 1]) out.output = a[++i];
  }
  return out;
}

const args = parseArgs(process.argv);
if (!args.estimate || !args.meta || !args.output) {
  console.error('Usage: build-sample.js --estimate <path> --meta <path> --output <path>');
  process.exit(1);
}

const estimate = JSON.parse(fs.readFileSync(args.estimate, 'utf8'));
const meta = JSON.parse(fs.readFileSync(args.meta, 'utf8'));
const config = loadConfig(path.dirname(args.meta));

const plan = computeSplitPlan({
  estimate,
  config,
  meta: { baseName: meta.baseName, siteName: meta.siteName, publisherPrefix: estimate.publisherPrefix },
});

const planData = {
  SITE_NAME: meta.siteName,
  GENERATED_AT: new Date().toISOString(),
  STRATEGY: meta.STRATEGY || 'pp-pipelines',
  EXPORT_TYPE: 'managed',
  APPROVAL_MODE: meta.APPROVAL_MODE || 'Staging auto-approve, production requires approval',
  GIT_STATUS: meta.GIT_STATUS || 'yes',
  PLAN_STATUS: meta.PLAN_STATUS || 'Draft',
  APPROVED_BY: '',
  APPROVAL_DATE: '',
  stages: meta.stages || [],
  steps: meta.steps || [],
  risks: meta.risks || [],
  envVars: meta.envVars || [],
  breakdown: estimate.breakdown || {},
  estimationMethod: estimate.estimationMethod || 'metadata-based',
  estimationAccuracyPct: estimate.estimationAccuracyPct || 15,
  ...plan,
};

fs.writeFileSync(args.output, JSON.stringify(planData, null, 2), 'utf8');
console.log(JSON.stringify({ status: 'ok', output: args.output, strategy: plan.splitStrategy, solutions: plan.proposedSolutions.length }));
