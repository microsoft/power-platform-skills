#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { contractHash } = require('./experience-patterns');

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function contextEnrichmentRevision(contract) {
  return crypto.createHash('sha256').update(stableStringify(contract)).digest('hex');
}

const OPPORTUNITY_PATTERNS = [
  ['active-journey', 'journey', /\b(?:journey|trip|route|in[-\s]?flight|onboard|travel(?:ing)?)\b/i],
  ['place-context', 'place', /\b(?:location|site|facility|venue|clinic|office|store|warehouse|gym|region|territory)\b/i],
  ['time-context', 'time', /\b(?:appointment|schedule|shift|deadline|time slot|date|period|upcoming)\b/i],
  ['identity-context', 'identity', /\b(?:accounts?|customers?|clients?|patients?|members?|passengers?|employees?|teams?|owners?|assignees?)\b/i],
  ['progress-context', 'progress', /\b(?:progress|step|stage|lesson|workflow|draft|resume|continue|complete|submit|finish|confirm)\b/i],
  ['fulfilment-context', 'fulfilment', /\b(?:delivery|pickup|fulfilment|receive|receiving|ship|shipment|transfer)\b/i],
  ['scope-context', 'scope', /\b(?:workspace|portfolio|category|collection|department|project|course|conversation)\b/i],
];

function contextOpportunities(brief) {
  return OPPORTUNITY_PATTERNS.flatMap(([id, kind, pattern]) => {
    const match = pattern.exec(brief);
    if (!match) return [];
    return [{
      id,
      kind,
      confidence: 'candidate',
      evidence: { signal: kind, text: match[0], start: match.index, end: match.index + match[0].length },
    }];
  });
}

function resolveContextEnrichment(briefText, experienceContract) {
  const brief = String(briefText || '').trim();
  if (!brief) throw new Error('confirmed brief must be non-empty');
  const base = {
    schemaVersion: 1,
    experienceContractSha256: contractHash(experienceContract),
    decisionOwner: 'deterministic-hint',
    contextMode: 'none',
    displayContext: [],
    ephemeralModel: null,
    assumptions: [],
    opportunities: contextOpportunities(brief),
    forbiddenInferences: ['Do not invent functionality, integrations, permissions, or persistent entities from illustrative context.'],
  };
  return base;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--brief') args.brief = argv[++index];
    else if (argv[index] === '--experience-contract') args.experienceContract = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.projectRoot) {
    process.stderr.write('Usage: node resolve-context-enrichment.js --project-root <dir> [--brief brief.md] [--experience-contract .tmp/experience-contract.json] [--output .tmp/context-enrichment-contract.json]\n');
    return 2;
  }
  try {
    const root = path.resolve(args.projectRoot);
    const briefPath = path.resolve(root, args.brief || 'brief.md');
    const experiencePath = path.resolve(root, args.experienceContract || '.tmp/experience-contract.json');
    const outputPath = path.resolve(root, args.output || '.tmp/context-enrichment-contract.json');
    const contract = resolveContextEnrichment(fs.readFileSync(briefPath, 'utf8'), JSON.parse(fs.readFileSync(experiencePath, 'utf8')));
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(contract, null, 2)}\n`);
    process.stdout.write(`Context enrichment written: ${outputPath} (${contract.contextMode})\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`resolve-context-enrichment: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { OPPORTUNITY_PATTERNS, contextEnrichmentRevision, contextOpportunities, resolveContextEnrichment, stableStringify };