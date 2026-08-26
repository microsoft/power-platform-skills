#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { contractHash } = require('./experience-patterns');
const { contextEnrichmentRevision, resolveContextEnrichment, stableStringify } = require('./resolve-context-enrichment');

const ROOT_KEYS = ['schemaVersion', 'experienceContractSha256', 'contextMode', 'displayContext', 'ephemeralModel', 'assumptions', 'forbiddenInferences'];
const ITEM_KEYS = ['id', 'label', 'sampleValue', 'valueType', 'source', 'placementIntent', 'evidence', 'assumption'];
const MODES = new Set(['none', 'active-journey', 'learning-progress', 'availability-context', 'active-assignment', 'financial-period', 'workspace-presence', 'capture-session']);

function exactKeys(value, allowed, required, label, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  const keys = Object.keys(value);
  const missing = required.filter((key) => !keys.includes(key));
  const unknown = keys.filter((key) => !allowed.includes(key));
  if (missing.length) errors.push(`${label} is missing keys: ${missing.join(', ')}`);
  if (unknown.length) errors.push(`${label} has unknown keys: ${unknown.join(', ')}`);
}

function validateContextEnrichment(contract, context = {}) {
  const errors = [];
  exactKeys(contract, ROOT_KEYS, ROOT_KEYS, 'contextEnrichment', errors);
  if (contract?.schemaVersion !== 1) errors.push('contextEnrichment.schemaVersion must be 1');
  if (!/^[a-f0-9]{64}$/.test(String(contract?.experienceContractSha256 || ''))) errors.push('contextEnrichment.experienceContractSha256 is invalid');
  if (context.experienceContract && contract?.experienceContractSha256 !== contractHash(context.experienceContract)) errors.push('context enrichment does not match the Experience Contract');
  if (!MODES.has(contract?.contextMode)) errors.push('contextEnrichment.contextMode is invalid');
  const entries = Array.isArray(contract?.displayContext) ? contract.displayContext : [];
  if (!Array.isArray(contract?.displayContext) || entries.length > 5) errors.push('contextEnrichment.displayContext must contain at most five entries');
  const ids = new Set();
  for (const [index, entry] of entries.entries()) {
    const label = `contextEnrichment.displayContext[${index}]`;
    exactKeys(entry, ITEM_KEYS, ITEM_KEYS, label, errors);
    if (!/^[a-z][a-z0-9-]*$/.test(String(entry?.id || '')) || ids.has(entry.id)) errors.push(`${label}.id is invalid or duplicated`);
    ids.add(entry?.id);
    if (typeof entry?.label !== 'string' || !entry.label.trim()) errors.push(`${label}.label is required`);
    if (typeof entry?.sampleValue !== 'string' || !entry.sampleValue.trim()) errors.push(`${label}.sampleValue is required`);
    if (!['text', 'status', 'progress', 'date-time'].includes(entry?.valueType)) errors.push(`${label}.valueType is invalid`);
    if (entry?.source !== 'inferred-prototype-fixture') errors.push(`${label}.source must be inferred-prototype-fixture`);
    if (!['primary-screen-context-rail', 'inline-label', 'supporting-section'].includes(entry?.placementIntent)) errors.push(`${label}.placementIntent is invalid`);
    if (typeof entry?.assumption !== 'string' || entry.assumption.trim().length < 10) errors.push(`${label}.assumption is required`);
    exactKeys(entry?.evidence, ['signal', 'text', 'start', 'end'], ['signal', 'text', 'start', 'end'], `${label}.evidence`, errors);
    if (context.briefText && Number.isInteger(entry?.evidence?.start) && Number.isInteger(entry?.evidence?.end)) {
      if (context.briefText.slice(entry.evidence.start, entry.evidence.end) !== entry.evidence.text) errors.push(`${label}.evidence does not match the confirmed brief`);
    }
  }
  if (contract?.contextMode === 'none') {
    if (entries.length || contract.ephemeralModel !== null || (contract.assumptions || []).length) errors.push('none context mode must not invent display or ephemeral context');
  } else {
    if (!entries.length) errors.push('enriched context mode requires displayContext');
    exactKeys(contract?.ephemeralModel, ['key', 'persistence', 'fields'], ['key', 'persistence', 'fields'], 'contextEnrichment.ephemeralModel', errors);
    if (contract?.ephemeralModel?.persistence !== 'prototype-session') errors.push('context enrichment may only use prototype-session persistence');
    if (!Array.isArray(contract?.assumptions) || !contract.assumptions.length) errors.push('enriched context requires explicit assumptions');
    for (const entry of entries) if (!contract.assumptions?.includes(entry.assumption)) errors.push(`contextEnrichment.assumptions must include the assumption for ${entry.id}`);
  }
  if (!Array.isArray(contract?.forbiddenInferences) || !contract.forbiddenInferences.length) errors.push('context enrichment requires forbiddenInferences');
  if (context.experienceContract && context.briefText) {
    const expected = resolveContextEnrichment(context.briefText, context.experienceContract);
    if (stableStringify(contract) !== stableStringify(expected)) errors.push('context enrichment does not match deterministic evidence-bound foreground resolution');
  }
  return { valid: errors.length === 0, errors, revision: errors.length ? null : contextEnrichmentRevision(contract) };
}

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--contract') args.contract = argv[++index];
    else if (argv[index] === '--brief') args.brief = argv[++index];
    else if (argv[index] === '--experience-contract') args.experienceContract = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  if (!args.projectRoot) {
    process.stderr.write('Usage: node validate-context-enrichment.js --project-root <dir> [--contract .tmp/context-enrichment-contract.json] [--brief brief.md] [--experience-contract .tmp/experience-contract.json] [--json]\n');
    return 2;
  }
  try {
    const root = path.resolve(args.projectRoot);
    const contract = JSON.parse(fs.readFileSync(path.resolve(root, args.contract || '.tmp/context-enrichment-contract.json'), 'utf8'));
    const experience = JSON.parse(fs.readFileSync(path.resolve(root, args.experienceContract || '.tmp/experience-contract.json'), 'utf8'));
    const brief = fs.readFileSync(path.resolve(root, args.brief || 'brief.md'), 'utf8');
    const result = validateContextEnrichment(contract, { experienceContract: experience, briefText: brief });
    if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.valid) {
      if (!args.json) result.errors.forEach((error) => process.stderr.write(`- ${error}\n`));
      return 2;
    }
    if (!args.json) process.stdout.write(`Context enrichment valid: ${result.revision}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`validate-context-enrichment: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { validateContextEnrichment };