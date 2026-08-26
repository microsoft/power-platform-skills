#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { contractHash } = require('./experience-patterns');
const { fixtureDataRevision } = require('./lib/prototype-domain-model');
const { contextEnrichmentRevision } = require('./resolve-context-enrichment');

const ROOT_KEYS = ['schemaVersion', 'experienceContractSha256', 'fixtureDataSha256', 'decisionOwner', 'contextMode', 'displayContext', 'ephemeralModel', 'assumptions', 'opportunities', 'forbiddenInferences'];
const REQUIRED_ROOT_KEYS = ['schemaVersion', 'experienceContractSha256', 'contextMode', 'displayContext', 'ephemeralModel', 'assumptions', 'forbiddenInferences'];
const ITEM_KEYS = ['id', 'label', 'sampleValue', 'valueType', 'source', 'sourceBinding', 'placementIntent', 'evidence', 'assumption'];

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

function resolveJsonPointer(value, pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('#/')) return { found: false, value: undefined };
  let current = value;
  for (const rawSegment of pointer.slice(2).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment) || Number(segment) >= current.length) return { found: false, value: undefined };
      current = current[Number(segment)];
    } else if (current && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = current[segment];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: current };
}

function validateContextEnrichment(contract, context = {}) {
  const errors = [];
  exactKeys(contract, ROOT_KEYS, REQUIRED_ROOT_KEYS, 'contextEnrichment', errors);
  if (contract?.schemaVersion !== 1) errors.push('contextEnrichment.schemaVersion must be 1');
  if (!/^[a-f0-9]{64}$/.test(String(contract?.experienceContractSha256 || ''))) errors.push('contextEnrichment.experienceContractSha256 is invalid');
  if (context.experienceContract && contract?.experienceContractSha256 !== contractHash(context.experienceContract)) errors.push('context enrichment does not match the Experience Contract');
  if (!/^[a-z][a-z0-9-]*$/.test(String(contract?.contextMode || ''))) errors.push('contextEnrichment.contextMode is invalid');
  if (contract?.decisionOwner !== undefined && !['deterministic-hint', 'model', 'legacy'].includes(contract.decisionOwner)) errors.push('contextEnrichment.decisionOwner is invalid');
  const opportunities = Array.isArray(contract?.opportunities) ? contract.opportunities : [];
  if (contract?.opportunities !== undefined && (!Array.isArray(contract.opportunities) || opportunities.length > 8)) errors.push('contextEnrichment.opportunities must contain at most eight entries');
  const opportunityIds = new Set();
  for (const [index, opportunity] of opportunities.entries()) {
    const label = `contextEnrichment.opportunities[${index}]`;
    exactKeys(opportunity, ['id', 'kind', 'confidence', 'evidence'], ['id', 'kind', 'confidence', 'evidence'], label, errors);
    if (!/^[a-z][a-z0-9-]*$/.test(String(opportunity?.id || '')) || opportunityIds.has(opportunity.id)) errors.push(`${label}.id is invalid or duplicated`);
    opportunityIds.add(opportunity?.id);
    if (!['candidate', 'selected', 'rejected'].includes(opportunity?.confidence)) errors.push(`${label}.confidence is invalid`);
    exactKeys(opportunity?.evidence, ['signal', 'text', 'start', 'end'], ['signal', 'text', 'start', 'end'], `${label}.evidence`, errors);
    if (context.briefText && Number.isInteger(opportunity?.evidence?.start) && Number.isInteger(opportunity?.evidence?.end)
      && context.briefText.slice(opportunity.evidence.start, opportunity.evidence.end) !== opportunity.evidence.text) errors.push(`${label}.evidence does not match the confirmed brief`);
  }
  const entries = Array.isArray(contract?.displayContext) ? contract.displayContext : [];
  if (!Array.isArray(contract?.displayContext) || entries.length > 5) errors.push('contextEnrichment.displayContext must contain at most five entries');
  const ids = new Set();
  const domainEntries = [];
  for (const [index, entry] of entries.entries()) {
    const label = `contextEnrichment.displayContext[${index}]`;
    exactKeys(entry, ITEM_KEYS, ['id', 'label', 'sampleValue', 'valueType', 'source', 'placementIntent', 'evidence', 'assumption'], label, errors);
    if (!/^[a-z][a-z0-9-]*$/.test(String(entry?.id || '')) || ids.has(entry.id)) errors.push(`${label}.id is invalid or duplicated`);
    ids.add(entry?.id);
    if (typeof entry?.label !== 'string' || !entry.label.trim()) errors.push(`${label}.label is required`);
    if (typeof entry?.sampleValue !== 'string' || !entry.sampleValue.trim()) errors.push(`${label}.sampleValue is required`);
    if (!['text', 'status', 'progress', 'date-time'].includes(entry?.valueType)) errors.push(`${label}.valueType is invalid`);
    if (!['prompt-explicit', 'domain-fixture', 'illustrative-session', 'connector', 'inferred-prototype-fixture'].includes(entry?.source)) errors.push(`${label}.source is invalid`);
    if (['domain-fixture', 'connector'].includes(entry?.source) && (typeof entry.sourceBinding !== 'string' || !entry.sourceBinding.trim())) errors.push(`${label}.sourceBinding is required for ${entry.source}`);
    if (entry?.source === 'domain-fixture') domainEntries.push({ entry, label });
    if (!['primary-screen-context-rail', 'inline-label', 'supporting-section'].includes(entry?.placementIntent)) errors.push(`${label}.placementIntent is invalid`);
    if (typeof entry?.assumption !== 'string' || entry.assumption.trim().length < 10) errors.push(`${label}.assumption is required`);
    exactKeys(entry?.evidence, ['signal', 'text', 'start', 'end'], ['signal', 'text', 'start', 'end'], `${label}.evidence`, errors);
    if (context.briefText && Number.isInteger(entry?.evidence?.start) && Number.isInteger(entry?.evidence?.end)) {
      if (context.briefText.slice(entry.evidence.start, entry.evidence.end) !== entry.evidence.text) errors.push(`${label}.evidence does not match the confirmed brief`);
    }
  }
  if (domainEntries.length) {
    if (!/^[a-f0-9]{64}$/.test(String(contract?.fixtureDataSha256 || ''))) errors.push('contextEnrichment.fixtureDataSha256 is required for domain-fixture context');
    if (!context.domainModel) {
      errors.push('domain-fixture context requires the prototype Domain model');
    } else {
      if (contract.fixtureDataSha256 !== fixtureDataRevision(context.domainModel)) errors.push('context enrichment does not match the prototype fixture data');
      for (const { entry, label } of domainEntries) {
        if (!String(entry.sourceBinding || '').startsWith('#/fixtures/')) {
          errors.push(`${label}.sourceBinding must be a JSON pointer under #/fixtures`);
          continue;
        }
        const resolved = resolveJsonPointer(context.domainModel, entry.sourceBinding);
        if (!resolved.found) errors.push(`${label}.sourceBinding does not resolve in prototype fixtures`);
        else if (!['string', 'number', 'boolean'].includes(typeof resolved.value)) errors.push(`${label}.sourceBinding must resolve to a scalar fixture value`);
        else if (String(resolved.value) !== entry.sampleValue) errors.push(`${label}.sampleValue does not match its fixture binding`);
      }
    }
  } else if (contract?.fixtureDataSha256 !== undefined) {
    errors.push('contextEnrichment.fixtureDataSha256 is allowed only with domain-fixture context');
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
  return { valid: errors.length === 0, errors, revision: errors.length ? null : contextEnrichmentRevision(contract) };
}

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--contract') args.contract = argv[++index];
    else if (argv[index] === '--brief') args.brief = argv[++index];
    else if (argv[index] === '--experience-contract') args.experienceContract = argv[++index];
    else if (argv[index] === '--domain-model') args.domainModel = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  if (!args.projectRoot) {
    process.stderr.write('Usage: node validate-context-enrichment.js --project-root <dir> [--contract .tmp/context-enrichment-contract.json] [--brief brief.md] [--experience-contract .tmp/experience-contract.json] [--domain-model .tmp/prototype-domain-model.json] [--json]\n');
    return 2;
  }
  try {
    const root = path.resolve(args.projectRoot);
    const contract = JSON.parse(fs.readFileSync(path.resolve(root, args.contract || '.tmp/context-enrichment-contract.json'), 'utf8'));
    const experience = JSON.parse(fs.readFileSync(path.resolve(root, args.experienceContract || '.tmp/experience-contract.json'), 'utf8'));
    const brief = fs.readFileSync(path.resolve(root, args.brief || 'brief.md'), 'utf8');
    const domainPath = path.resolve(root, args.domainModel || '.tmp/prototype-domain-model.json');
    const domainModel = fs.existsSync(domainPath) ? JSON.parse(fs.readFileSync(domainPath, 'utf8')) : null;
    const result = validateContextEnrichment(contract, { experienceContract: experience, briefText: brief, domainModel });
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

module.exports = { resolveJsonPointer, validateContextEnrichment };