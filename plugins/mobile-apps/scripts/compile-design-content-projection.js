#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { domainModelRevision, stableStringify, validatePrototypeDomainModel } = require('./lib/prototype-domain-model');

const MAX_ENTITIES = 12;
const MAX_FIELDS_PER_ENTITY = 12;
const MAX_RECORDS_PER_ENTITY = 3;
const MAX_LONG_STRINGS = 10;
const MAX_STRING_LENGTH = 160;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function boundedString(value) {
  return String(value).replace(/\s+/g, ' ').trim().slice(0, MAX_STRING_LENGTH);
}

function projectValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return boundedString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 5).map(projectValue);
  if (typeof value !== 'object') return boundedString(value);
  if (typeof value.amount === 'number' && typeof value.currencyCode === 'string') {
    return { amount: value.amount, currencyCode: value.currencyCode };
  }
  if (typeof value.imageAltText === 'string') {
    return {
      imageAltText: boundedString(value.imageAltText),
      ...(typeof value.imageAssetKey === 'string' ? { imageAssetKey: boundedString(value.imageAssetKey) } : {}),
    };
  }
  if (typeof value.fileName === 'string') {
    return {
      fileName: boundedString(value.fileName),
      ...(typeof value.mimeType === 'string' ? { mimeType: boundedString(value.mimeType) } : {}),
    };
  }
  return Object.fromEntries(Object.entries(value).slice(0, 8).map(([key, child]) => [key, projectValue(child)]));
}

function collectStrings(value, source, output) {
  if (typeof value === 'string') {
    const text = boundedString(value);
    if (text) output.push({ source, value: text, length: text.length });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStrings(item, `${source}[${index}]`, output));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) collectStrings(child, `${source}.${key}`, output);
}

function compileDesignContentProjection(model) {
  const validation = validatePrototypeDomainModel(model);
  if (!validation.valid) throw new Error(`Prototype domain model is invalid: ${validation.errors.join('; ')}`);
  const choices = new Map((model.choices || []).map((choice) => [choice.key, choice]));
  const stringCandidates = [];
  const entities = (model.entities || []).slice(0, MAX_ENTITIES).map((entity) => {
    const fields = (entity.fields || []).slice(0, MAX_FIELDS_PER_ENTITY);
    const records = (model.fixtures?.[entity.key] || []).slice(0, MAX_RECORDS_PER_ENTITY).map((record) => {
      const projected = {};
      for (const field of fields) {
        if (!Object.prototype.hasOwnProperty.call(record, field.key)) continue;
        projected[field.key] = projectValue(record[field.key]);
        collectStrings(record[field.key], `${entity.key}.${field.key}`, stringCandidates);
      }
      return projected;
    });
    for (const field of fields) collectStrings(field.displayName, `${entity.key}.field.${field.key}`, stringCandidates);
    return {
      key: entity.key,
      displayName: entity.displayName,
      displayPluralName: entity.displayPluralName,
      primaryNameField: entity.primaryNameField,
      recordCount: (model.fixtures?.[entity.key] || []).length,
      fields: fields.map((field) => ({
        key: field.key,
        displayName: field.displayName,
        type: field.type,
        required: field.required,
        ...(field.choiceKey ? { choiceKey: field.choiceKey } : {}),
        ...(field.mediaIntent ? { mediaIntent: field.mediaIntent } : {}),
      })),
      representativeRecords: records,
      representativeFieldSets: records.map((record) => Object.keys(record)),
    };
  });
  const choiceVocabulary = (model.choices || []).map((choice) => {
    for (const option of choice.options || []) collectStrings(option.label, `choice.${choice.key}.${option.key}`, stringCandidates);
    const usedBy = entities.flatMap((entity) => entity.fields
      .filter((field) => field.choiceKey === choice.key)
      .map((field) => `${entity.key}.${field.key}`));
    return {
      key: choice.key,
      usedBy,
      options: (choices.get(choice.key)?.options || []).map((option) => ({ key: option.key, label: option.label })),
    };
  });
  const longestStrings = [...new Map(stringCandidates.map((item) => [`${item.source}:${item.value}`, item])).values()]
    .sort((left, right) => right.length - left.length || left.source.localeCompare(right.source))
    .slice(0, MAX_LONG_STRINGS);
  const scenarios = (model.fixtureScenarios || [])
    .filter((scenario) => scenario.state !== 'offline')
    .map(({ key, state, description, entity, recordIds }) => ({
      key,
      state,
      description: boundedString(description),
      ...(entity ? { entity } : {}),
      ...(Array.isArray(recordIds) ? { recordIds: recordIds.slice(0, 5) } : {}),
    }));
  const projection = {
    schemaVersion: 1,
    kind: 'mobile-design-content-projection',
    domainModelRevision: domainModelRevision(model),
    limits: {
      maxEntities: MAX_ENTITIES,
      maxFieldsPerEntity: MAX_FIELDS_PER_ENTITY,
      maxRecordsPerEntity: MAX_RECORDS_PER_ENTITY,
      maxLongestStrings: MAX_LONG_STRINGS,
      maxStringLength: MAX_STRING_LENGTH,
    },
    entities,
    choiceVocabulary,
    longestStrings,
    scenarios,
  };
  return { ...projection, contentFingerprint: sha256(stableStringify(projection)) };
}

function validateDesignContentProjection(model, projection) {
  const expected = compileDesignContentProjection(model);
  return stableStringify(expected) === stableStringify(projection)
    ? { valid: true, expected }
    : { valid: false, expected };
}

function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--domain-model') args.domainModel = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
    else if (argv[index] === '--check') args.check = true;
  }
  if (!args.projectRoot) {
    process.stderr.write('Usage: node compile-design-content-projection.js --project-root <dir> [--domain-model .tmp/prototype-domain-model.json] [--output .tmp/design-content-projection.json] [--check]\n');
    return 2;
  }
  try {
    const root = fs.realpathSync(path.resolve(args.projectRoot));
    const domainPath = path.resolve(root, args.domainModel || '.tmp/prototype-domain-model.json');
    const outputPath = path.resolve(root, args.output || '.tmp/design-content-projection.json');
    if (!domainPath.startsWith(`${root}${path.sep}`) || !outputPath.startsWith(`${root}${path.sep}`)) throw new Error('input and output must remain inside project root');
    const model = JSON.parse(fs.readFileSync(domainPath, 'utf8'));
    const projection = compileDesignContentProjection(model);
    if (args.check) {
      if (!fs.existsSync(outputPath)) throw new Error(`design content projection is missing: ${outputPath}`);
      const current = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      if (!validateDesignContentProjection(model, current).valid) throw new Error('design content projection is stale; regenerate it after domain validation');
      process.stdout.write(`Design content projection current: ${outputPath} (${current.contentFingerprint})\n`);
      return 0;
    }
    writeAtomic(outputPath, projection);
    process.stdout.write(`Design content projection written: ${outputPath} (${projection.contentFingerprint})\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`compile-design-content-projection: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  MAX_ENTITIES,
  MAX_FIELDS_PER_ENTITY,
  MAX_LONG_STRINGS,
  MAX_RECORDS_PER_ENTITY,
  MAX_STRING_LENGTH,
  compileDesignContentProjection,
  main,
  projectValue,
  validateDesignContentProjection,
  writeAtomic,
};
