#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_POOLS = {
  person: [8, 10],
  company: [6, 8],
  location: [4, 6],
  door: [6, 8],
  title: [6, 8],
  note: [5, 6],
  role: [1, 12],
};

const REQUIRED_FORMAT_PLACEHOLDERS = {
  serial: ['seq4'],
  reference: ['year', 'seq4'],
  code: ['ALPHA2', 'seq3'],
};

const ALLOWED_PLACEHOLDERS = new Set(['seq3', 'seq4', 'year', 'ALPHA2']);

function normalize(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON: ${error.message}`);
  }
}

function validateStringPool(poolName, values, errors, bounds) {
  if (!Array.isArray(values)) {
    errors.push(`pools.${poolName} must be an array`);
    return [];
  }
  const [minimum, maximum] = bounds;
  if (values.length < minimum || values.length > maximum) {
    errors.push(`pools.${poolName} must contain ${minimum}-${maximum} values`);
  }
  const normalized = [];
  for (const [index, value] of values.entries()) {
    if (typeof value !== 'string' || !value.trim()) {
      errors.push(`pools.${poolName}[${index}] must be a non-empty string`);
      continue;
    }
    normalized.push(normalize(value));
  }
  if (new Set(normalized).size !== normalized.length) {
    errors.push(`pools.${poolName} must not contain duplicate values`);
  }
  return normalized;
}

function validateVocabulary(vocabulary, { briefText } = {}) {
  const errors = [];
  if (!vocabulary || typeof vocabulary !== 'object' || Array.isArray(vocabulary)) {
    return { valid: false, errors: ['vocabulary must be a JSON object'], summary: null };
  }

  const domain = typeof vocabulary.domain === 'string' ? vocabulary.domain.trim() : '';
  if (!domain) errors.push('domain must be a non-empty string');
  if (!Number.isInteger(vocabulary.rowCount) || vocabulary.rowCount < 1 || vocabulary.rowCount > 100) {
    errors.push('rowCount must be an integer from 1 to 100');
  }
  if (!vocabulary.pools || typeof vocabulary.pools !== 'object' || Array.isArray(vocabulary.pools)) {
    errors.push('pools must be an object');
  }

  const normalizedPools = {};
  for (const [poolName, bounds] of Object.entries(REQUIRED_POOLS)) {
    normalizedPools[poolName] = validateStringPool(
      poolName,
      vocabulary.pools?.[poolName],
      errors,
      bounds,
    );
  }
  for (const [poolName, values] of Object.entries(vocabulary.pools || {})) {
    if (Object.hasOwn(REQUIRED_POOLS, poolName)) continue;
    normalizedPools[poolName] = validateStringPool(poolName, values, errors, [1, 100]);
  }

  if (!vocabulary.idFormats || typeof vocabulary.idFormats !== 'object' || Array.isArray(vocabulary.idFormats)) {
    errors.push('idFormats must be an object');
  }
  for (const [formatName, requiredPlaceholders] of Object.entries(REQUIRED_FORMAT_PLACEHOLDERS)) {
    const format = vocabulary.idFormats?.[formatName];
    if (typeof format !== 'string' || !format.trim()) {
      errors.push(`idFormats.${formatName} must be a non-empty string`);
      continue;
    }
    const placeholders = [...format.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    for (const placeholder of requiredPlaceholders) {
      if (!placeholders.includes(placeholder)) {
        errors.push(`idFormats.${formatName} must contain {${placeholder}}`);
      }
    }
    for (const placeholder of placeholders) {
      if (!ALLOWED_PLACEHOLDERS.has(placeholder)) {
        errors.push(`idFormats.${formatName} uses unsupported placeholder {${placeholder}}`);
      }
    }
  }

  if (briefText !== undefined) {
    const normalizedBrief = normalize(briefText);
    const normalizedDomain = normalize(domain);
    if (normalizedDomain && !normalizedBrief.includes(normalizedDomain)) {
      errors.push('domain must be a phrase present in the brief');
    }
    for (const role of normalizedPools.role || []) {
      if (role && !normalizedBrief.includes(role)) {
        errors.push(`role "${role}" must use wording present in the brief`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    summary: {
      domain,
      rowCount: vocabulary.rowCount,
      poolCounts: Object.fromEntries(
        Object.entries(vocabulary.pools || {}).map(([poolName, values]) => [
          poolName,
          Array.isArray(values) ? values.length : 0,
        ]),
      ),
      poolSamples: Object.fromEntries(
        Object.entries(vocabulary.pools || {}).map(([poolName, values]) => [
          poolName,
          Array.isArray(values) ? values.slice(0, 2) : [],
        ]),
      ),
    },
  };
}

function compareVocabularies(entries) {
  const errors = [];
  const seenDomains = new Map();
  const seenValues = new Map();
  for (const entry of entries) {
    const label = entry.label || entry.vocabulary?.domain || '<unnamed>';
    const domain = normalize(entry.vocabulary?.domain);
    if (domain) {
      const prior = seenDomains.get(domain);
      if (prior) errors.push(`domain overlap: ${label} and ${prior} both use "${domain}"`);
      else seenDomains.set(domain, label);
    }
    for (const values of Object.values(entry.vocabulary?.pools || {})) {
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        const normalizedValue = normalize(value);
        if (!normalizedValue) continue;
        const prior = seenValues.get(normalizedValue);
        if (prior && prior !== label) {
          errors.push(`pool overlap: ${label} and ${prior} both use "${value}"`);
        } else {
          seenValues.set(normalizedValue, label);
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function parseArgs(argv) {
  const json = argv.includes('--json');
  const compareIndex = argv.indexOf('--compare');
  if (compareIndex >= 0) {
    const vocabularyPaths = argv
      .slice(compareIndex + 1)
      .filter((argument) => !argument.startsWith('--'));
    return { mode: 'compare', vocabularyPaths, json };
  }
  const briefIndex = argv.indexOf('--brief');
  const briefPath = briefIndex >= 0 ? argv[briefIndex + 1] : null;
  const vocabularyPath = argv.find((argument, index) => (
    !argument.startsWith('--') && index !== briefIndex + 1
  ));
  return { mode: 'validate', vocabularyPath, briefPath, json };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'compare') {
    if (args.vocabularyPaths.length < 2) {
      console.error('Usage: validate-seed-vocabulary.js --compare <vocabulary-a.json> <vocabulary-b.json> [more.json]');
      process.exit(1);
    }
    const entries = args.vocabularyPaths.map((vocabularyPath) => ({
      label: path.basename(vocabularyPath),
      vocabulary: readJson(path.resolve(vocabularyPath)),
    }));
    const individual = entries.map((entry) => ({
      label: entry.label,
      ...validateVocabulary(entry.vocabulary),
    }));
    const comparison = compareVocabularies(entries);
    const report = {
      valid: individual.every((entry) => entry.valid) && comparison.valid,
      vocabularies: individual,
      comparison,
    };
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else if (report.valid) console.log(`seed-vocabulary: PASS (${entries.length} disjoint vocabularies)`);
    else {
      for (const entry of individual) {
        for (const error of entry.errors) console.error(`${entry.label}: ${error}`);
      }
      for (const error of comparison.errors) console.error(error);
    }
    process.exit(report.valid ? 0 : 1);
  }

  if (!args.vocabularyPath || !args.briefPath) {
    console.error('Usage: validate-seed-vocabulary.js <seed-vocabulary.json> --brief <brief.md> [--json]');
    process.exit(1);
  }
  const vocabularyPath = path.resolve(args.vocabularyPath);
  const briefPath = path.resolve(args.briefPath);
  const report = validateVocabulary(readJson(vocabularyPath), {
    briefText: fs.readFileSync(briefPath, 'utf8'),
  });
  if (args.json) console.log(JSON.stringify({ vocabularyPath, briefPath, ...report }, null, 2));
  else if (report.valid) {
    console.log(`seed-vocabulary: PASS (${report.summary.domain}, ${report.summary.rowCount} rows)`);
  } else {
    console.error('seed-vocabulary: FAIL');
    for (const error of report.errors) console.error(`- ${error}`);
  }
  process.exit(report.valid ? 0 : 1);
}

if (require.main === module) main();

module.exports = {
  compareVocabularies,
  normalize,
  parseArgs,
  validateVocabulary,
};