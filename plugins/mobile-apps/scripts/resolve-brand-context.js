#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BRAND_ROLES = ['app-brand', 'product-brand', 'integration', 'unknown'];
const BRAND_SOURCES = ['supplied', 'explicit', 'inferred', 'none'];

function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function addOrganization(organizations, name, role, evidence, confidence) {
  const normalizedName = normalizeName(name);
  if (!normalizedName || !BRAND_ROLES.includes(role)) return;
  const existing = organizations.find((organization) => organization.name.toLowerCase() === normalizedName.toLowerCase() && organization.role === role);
  if (existing) {
    if (!existing.evidence.includes(evidence)) existing.evidence.push(evidence);
    return;
  }
  organizations.push({ name: normalizedName, role, evidence: [evidence], confidence });
}

function namedOrganizationPatterns(brief) {
  const organizations = [];
  const name = '([A-Z][A-Za-z0-9&.\'’-]*(?:\s+[A-Z][A-Za-z0-9&.\'’-]*){0,2})';
  const patterns = [
    { role: 'app-brand', confidence: 'high', expression: new RegExp(`\\buse\\s+${name}\\s+branding\\b`, 'gi'), evidence: 'explicit branding instruction' },
    { role: 'app-brand', confidence: 'medium', expression: new RegExp(`\\b${name}-branded\\s+(?:[a-z]+\\s+){0,2}app\\b`, 'gi'), evidence: 'named branded app' },
    { role: 'app-brand', confidence: 'medium', expression: new RegExp(`\\b${name}\\s+(?:volunteer|member|customer|shopping)\\s+app\\b`, 'gi'), evidence: 'organization-specific app' },
    { role: 'product-brand', confidence: 'high', expression: new RegExp(`\\b(?:sell|selling|showcase|show|catalog|display)\\s+${name}\\s+(?:products?|items?)\\b`, 'gi'), evidence: 'brand named as product data' },
    { role: 'integration', confidence: 'high', expression: new RegExp(`\\b(?:connect(?:ed)?\\s+to|integrate(?:d)?\\s+with|sync(?:ed)?\\s+with|data\\s+from)\\s+${name}\\b`, 'gi'), evidence: 'brand named as integration' },
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.expression.exec(brief)) !== null) {
      if (!/^[A-Z]/.test(match[1].trim())) continue;
      addOrganization(organizations, match[1], pattern.role, pattern.evidence, pattern.confidence);
    }
  }
  return organizations;
}

function inferredPalette(appBrand, brief) {
  const text = `${appBrand?.name || ''} ${brief}`.toLowerCase();
  if (/\b(?:chanel|luxury|couture|premium)\b/.test(text)) {
    return { intent: 'luxury-neutral black/ivory', confidence: 'medium', note: 'Inferred visual direction only; official brand guidelines were not verified.' };
  }
  if (/\bred\s+cross\b/.test(text)) {
    return {
      intent: 'restrained red/white organization-aligned palette',
      confidence: 'medium',
      note: 'Inferred visual direction only; do not use protected emblems or claim official brand fidelity without approved reference material.',
    };
  }
  return null;
}

function resolveBrandContext({ brief, explicitBrand, suppliedBrand = false } = {}) {
  const sourceBrief = String(brief || '');
  const organizations = namedOrganizationPatterns(sourceBrief);
  if (explicitBrand) addOrganization(organizations, explicitBrand, 'app-brand', 'explicit branding instruction', 'high');

  const appBrand = organizations.find((organization) => organization.role === 'app-brand') || null;
  const brandRole = appBrand ? 'app-brand' : 'unknown';
  const brandSource = suppliedBrand
    ? 'supplied'
    : explicitBrand || appBrand?.evidence.includes('explicit branding instruction')
      ? 'explicit'
      : appBrand
        ? 'inferred'
        : 'none';
  const palette = brandSource === 'inferred' && appBrand ? inferredPalette(appBrand, sourceBrief) : null;

  return {
    schemaVersion: 1,
    brandRole,
    brandSource,
    evidence: appBrand?.evidence || [],
    confidence: suppliedBrand || brandSource === 'explicit' ? 'high' : appBrand?.confidence || 'low',
    organizations,
    inferredPalette: palette,
  };
}

function parseArgs(argv) {
  const args = { suppliedBrand: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--brief-file') args.briefFile = argv[++index];
    else if (argv[index] === '--explicit-brand') args.explicitBrand = argv[++index];
    else if (argv[index] === '--supplied-brand') args.suppliedBrand = true;
    else if (argv[index] === '--output') args.output = argv[++index];
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.briefFile || !args.output) {
    process.stderr.write('Usage: node resolve-brand-context.js --brief-file <brief.md> --output <brand-context.json> [--explicit-brand <name>] [--supplied-brand]\n');
    return 2;
  }
  const brief = fs.readFileSync(path.resolve(args.briefFile), 'utf8');
  const context = resolveBrandContext({ brief, explicitBrand: args.explicitBrand, suppliedBrand: args.suppliedBrand });
  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(context, null, 2)}\n`);
  process.stdout.write(`brand-context: ${context.brandRole}/${context.brandSource}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { resolveBrandContext };