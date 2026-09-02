#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  canonicalJson,
  contractRevision,
  sha256Hex,
} = require('./lib/product-experience-contracts');

const DEFAULT_PATHS = {
  input: '.tmp/scenario-facts-input.json',
  scope: '.tmp/product-scope-contract.json',
  journey: '.tmp/workflow-journey-contract.json',
  compiled: '.tmp/compiled-screen-build-pack.json',
  persistence: '.tmp/persistence-contract.json',
  navigation: '.tmp/navigation-manifest.json',
  output: '.tmp/scenario-facts.json',
};
const INVARIANT_OPERATORS = new Set([
  'field-absent-when-equals',
  'field-lte-field',
  'field-references-record',
]);

function finding(code, message, pointer = null) {
  return pointer ? { code, message, pointer } : { code, message };
}

function uniqueIndex(items, field, label, errors) {
  const result = new Map();
  for (const [index, item] of (items || []).entries()) {
    const id = String(item?.[field] || '').trim();
    if (!id) {
      errors.push(finding(`${label}-id-missing`, `${label} requires ${field}`, `${label}s[${index}]`));
      continue;
    }
    if (result.has(id)) {
      errors.push(finding(`${label}-id-duplicate`, `${label} id ${id} is duplicated`, `${label}s[${index}]`));
      continue;
    }
    result.set(id, item);
  }
  return result;
}

function sourceBindings(source) {
  return {
    scopeRevision: contractRevision(source.scope),
    journeyRevision: contractRevision(source.journey),
    screenPackRevision: source.compiled.compiledRevision,
    ...(source.persistence?.persistenceRevision
      ? { persistenceRevision: source.persistence.persistenceRevision }
      : {}),
    ...(source.navigation?.manifestRevision
      ? { navigationRevision: source.navigation.manifestRevision }
      : {}),
  };
}

function resolveValue(reference, records, errors, pointer) {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
    errors.push(finding('preview-value-reference-invalid', 'preview value must reference a record field', pointer));
    return null;
  }
  const record = records.get(reference.recordId);
  if (!record) {
    errors.push(finding('preview-record-missing', `preview references missing record ${reference.recordId}`, pointer));
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(record.fields || {}, reference.field)) {
    errors.push(finding(
      'preview-field-missing',
      `preview references missing field ${reference.recordId}.${reference.field}`,
      pointer,
    ));
    return null;
  }
  return structuredClone(record.fields[reference.field]);
}

function validateInvariant(invariant, records, errors, pointer) {
  if (!INVARIANT_OPERATORS.has(invariant.operator)) {
    errors.push(finding(
      'scenario-invariant-invalid',
      `unsupported invariant operator ${invariant.operator || '(missing)'}`,
      pointer,
    ));
    return;
  }
  const record = records.get(invariant.recordId);
  if (!record) {
    errors.push(finding('scenario-invariant-invalid', `invariant references missing record ${invariant.recordId}`, pointer));
    return;
  }
  const fields = record.fields || {};
  let valid = true;
  if (invariant.operator === 'field-absent-when-equals') {
    valid = fields[invariant.field] !== invariant.equals
      || fields[invariant.forbiddenField] === null
      || fields[invariant.forbiddenField] === undefined
      || fields[invariant.forbiddenField] === '';
  } else if (invariant.operator === 'field-lte-field') {
    const left = Number(fields[invariant.leftField]);
    const right = Number(fields[invariant.rightField]);
    valid = Number.isFinite(left) && Number.isFinite(right) && left <= right;
  } else if (invariant.operator === 'field-references-record') {
    valid = typeof fields[invariant.field] === 'string' && records.has(fields[invariant.field]);
  }
  if (!valid) {
    errors.push(finding(
      'scenario-invariant-failed',
      `scenario invariant ${invariant.id || invariant.operator} failed for ${invariant.recordId}`,
      pointer,
    ));
  }
}

function compilePreview(binding, records, mediaAssets, errors, pointer) {
  const preview = binding.preview || {};
  const compiled = {
    headline: resolveValue(preview.headline, records, errors, `${pointer}.headline`),
    supportingText: resolveValue(
      preview.supportingText,
      records,
      errors,
      `${pointer}.supportingText`,
    ),
    records: [],
    fields: [],
    metrics: [],
    summaryRows: [],
  };
  for (const [index, item] of (preview.records || []).entries()) {
    const record = records.get(item.recordId);
    if (!record) {
      errors.push(finding('preview-record-missing', `preview references missing record ${item.recordId}`, `${pointer}.records[${index}]`));
      continue;
    }
    const field = (name) => {
      if (!name) return null;
      if (!Object.prototype.hasOwnProperty.call(record.fields || {}, name)) {
        errors.push(finding('preview-field-missing', `preview references missing field ${item.recordId}.${name}`, `${pointer}.records[${index}]`));
        return null;
      }
      return record.fields[name];
    };
    if (item.mediaAssetKey && !mediaAssets.has(item.mediaAssetKey)) {
      errors.push(finding(
        'media-asset-missing',
        `preview record ${item.recordId} references missing media asset ${item.mediaAssetKey}`,
        `${pointer}.records[${index}]`,
      ));
    }
    compiled.records.push({
      recordId: item.recordId,
      title: String(field(item.titleField) ?? ''),
      subtitle: (item.subtitleFields || []).map(field).filter((value) => value != null).join(' · '),
      ...(item.metaField ? { meta: String(field(item.metaField) ?? '') } : {}),
      ...(item.badgeField ? { badge: String(field(item.badgeField) ?? '') } : {}),
      ...(item.mediaAssetKey ? { mediaAssetKey: item.mediaAssetKey } : {}),
    });
  }
  for (const key of ['fields', 'metrics', 'summaryRows']) {
    compiled[key] = (preview[key] || []).map((item, index) => ({
      label: String(item.label || ''),
      value: String(resolveValue(item.value, records, errors, `${pointer}.${key}[${index}].value`) ?? ''),
    }));
  }
  return compiled;
}

function compileScenarioFacts(input, source) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || input.schemaVersion !== 1) {
    return {
      errors: [finding('scenario-input-invalid', 'scenario input must be a schemaVersion 1 object')],
      compiled: null,
    };
  }
  for (const field of ['records', 'relationships', 'scenarios', 'mediaAssets', 'screenBindings', 'invariants']) {
    if (!Array.isArray(input[field])) {
      errors.push(finding('scenario-input-invalid', `${field} must be an array`));
    }
  }
  if (errors.length > 0) return { errors, compiled: null };

  const records = uniqueIndex(input.records, 'id', 'record', errors);
  const scenarios = uniqueIndex(input.scenarios, 'id', 'scenario', errors);
  const mediaAssets = uniqueIndex(input.mediaAssets, 'key', 'media-asset', errors);
  const scopeScreens = new Set((source.scope.screens || []).map((screen) => screen.id));
  const compiledScreens = new Map((source.compiled.screens || []).map(
    (screen) => [screen.screenId, screen],
  ));
  const journeys = new Map((source.journey.journeys || []).map(
    (journey) => [journey.id, journey],
  ));

  for (const [index, relationship] of input.relationships.entries()) {
    for (const field of ['fromRecordId', 'toRecordId']) {
      if (!records.has(relationship[field])) {
        errors.push(finding(
          'relationship-record-missing',
          `relationship ${relationship.id || index} references missing record ${relationship[field]}`,
          `relationships[${index}].${field}`,
        ));
      }
    }
  }
  for (const [index, scenario] of input.scenarios.entries()) {
    if (!journeys.has(scenario.journeyId)) {
      errors.push(finding('scenario-journey-missing', `scenario ${scenario.id} references missing journey ${scenario.journeyId}`, `scenarios[${index}]`));
    }
    for (const recordId of scenario.recordIds || []) {
      if (!records.has(recordId)) {
        errors.push(finding('scenario-record-missing', `scenario ${scenario.id} references missing record ${recordId}`, `scenarios[${index}]`));
      }
    }
  }

  const compiledBindings = [];
  const bindingKeys = new Set();
  for (const [index, binding] of input.screenBindings.entries()) {
    const pointer = `screenBindings[${index}]`;
    if (bindingKeys.has(binding.screenId)) {
      errors.push(finding('screen-binding-duplicate', `screen ${binding.screenId} has multiple scenario bindings`, pointer));
    }
    bindingKeys.add(binding.screenId);
    if (!scopeScreens.has(binding.screenId) || !compiledScreens.has(binding.screenId)) {
      errors.push(finding('screen-binding-screen-missing', `binding references missing screen ${binding.screenId}`, pointer));
    }
    if (!scenarios.has(binding.scenarioId)) {
      errors.push(finding('screen-binding-scenario-missing', `binding references missing scenario ${binding.scenarioId}`, pointer));
    }
    for (const recordId of binding.recordIds || []) {
      if (!records.has(recordId)) {
        errors.push(finding('screen-binding-record-missing', `binding references missing record ${recordId}`, pointer));
      }
    }
    const assets = [];
    for (const key of binding.mediaAssetKeys || []) {
      const asset = mediaAssets.get(key);
      if (!asset) {
        errors.push(finding('media-asset-missing', `screen ${binding.screenId} references missing media asset ${key}`, pointer));
        continue;
      }
      if (!asset.fallback) {
        errors.push(finding('media-fallback-missing', `media asset ${key} requires a fallback`, pointer));
      }
      assets.push(structuredClone(asset));
    }
    const mediaRole = compiledScreens.get(binding.screenId)?.pack?.media?.role;
    const mediaBinding = compiledScreens.get(binding.screenId)?.pack?.media?.assetKeyOrFieldBinding;
    if (mediaRole && mediaRole !== 'none' && assets.length === 0) {
      errors.push(finding('required-media-binding-missing', `screen ${binding.screenId} requires canonical media`, pointer));
    }
    if (mediaRole && mediaRole !== 'none' && mediaBinding?.startsWith('asset:')) {
      const expectedKey = mediaBinding.slice('asset:'.length);
      if (!(binding.mediaAssetKeys || []).includes(expectedKey)) {
        errors.push(finding(
          'screen-media-binding-mismatch',
          `screen ${binding.screenId} requires canonical media asset ${expectedKey}`,
          pointer,
        ));
      }
    }
    if (mediaRole && mediaRole !== 'none' && mediaBinding?.startsWith('field:')) {
      const expectedField = mediaBinding.slice('field:'.length);
      const fieldAvailable = (binding.recordIds || []).some((recordId) => (
        Object.prototype.hasOwnProperty.call(records.get(recordId)?.fields || {}, expectedField)
      ));
      if (!fieldAvailable) {
        errors.push(finding(
          'screen-media-binding-mismatch',
          `screen ${binding.screenId} requires record field ${expectedField}`,
          pointer,
        ));
      }
    }
    compiledBindings.push({
      screenId: binding.screenId,
      scenarioId: binding.scenarioId,
      recordIds: [...new Set(binding.recordIds || [])],
      mediaAssetKeys: [...new Set(binding.mediaAssetKeys || [])],
      preview: compilePreview(binding, records, mediaAssets, errors, `${pointer}.preview`),
    });
  }

  for (const [scenarioId, scenario] of scenarios) {
    const journey = journeys.get(scenario.journeyId);
    if (!journey || scenario.kind !== 'happy-path') continue;
    const requiredScreens = [...new Set([...(journey.steps || [])]
      .sort((left, right) => left.order - right.order)
      .map((step) => step.surface?.screenId)
      .filter(Boolean))];
    const boundScreens = new Set(input.screenBindings
      .filter((binding) => binding.scenarioId === scenarioId)
      .map((binding) => binding.screenId));
    const missing = requiredScreens.filter((screenId) => !boundScreens.has(screenId));
    if (missing.length > 0) {
      errors.push(finding(
        'scenario-journey-coverage-missing',
        `scenario ${scenarioId} has no bindings for journey screen(s): ${missing.join(', ')}`,
      ));
    }
  }
  input.invariants.forEach((invariant, index) => (
    validateInvariant(invariant, records, errors, `invariants[${index}]`)
  ));

  const compiled = {
    schemaVersion: 1,
    contractType: 'scenario-facts',
    ...sourceBindings(source),
    records: [...records.values()].map((item) => structuredClone(item)),
    relationships: input.relationships.map((item) => structuredClone(item)),
    scenarios: input.scenarios.map((item) => structuredClone(item)),
    mediaAssets: [...mediaAssets.values()].map((item) => structuredClone(item)),
    screenBindings: compiledBindings,
    invariants: input.invariants.map((item) => structuredClone(item)),
  };
  compiled.scenarioRevision = sha256Hex(canonicalJson(compiled));
  return { errors, compiled: errors.length === 0 ? compiled : null };
}

function projectScreenFacts(compiled, screenId) {
  const binding = (compiled.screenBindings || []).find((item) => item.screenId === screenId);
  if (!binding) return null;
  const assets = new Map((compiled.mediaAssets || []).map((asset) => [asset.key, asset]));
  const recordIds = new Set(binding.recordIds || []);
  const preview = structuredClone(binding.preview);
  preview.records = (preview.records || []).map((record) => ({
    ...record,
    ...(record.mediaAssetKey && assets.has(record.mediaAssetKey)
      ? { media: structuredClone(assets.get(record.mediaAssetKey)) }
      : {}),
  }));
  return {
    screenId,
    scenarioRevision: compiled.scenarioRevision,
    ...preview,
    recordIds: [...binding.recordIds],
    referencedRecords: (compiled.records || [])
      .filter((record) => recordIds.has(record.id))
      .map((record) => structuredClone(record)),
    relationships: (compiled.relationships || [])
      .filter((relationship) => (
        recordIds.has(relationship.fromRecordId) && recordIds.has(relationship.toRecordId)
      ))
      .map((relationship) => structuredClone(relationship)),
    invariants: (compiled.invariants || [])
      .filter((invariant) => recordIds.has(invariant.recordId))
      .map((invariant) => structuredClone(invariant)),
    media: binding.mediaAssetKeys.map((key) => structuredClone(assets.get(key))).filter(Boolean),
  };
}

function validateScenarioFacts(compiled, source) {
  const errors = [];
  if (!compiled || compiled.contractType !== 'scenario-facts') {
    return { ok: false, errors: [finding('scenario-contract-invalid', 'scenario-facts contract is required')] };
  }
  const expected = sourceBindings(source);
  const codes = {
    scopeRevision: 'stale-scope-binding',
    journeyRevision: 'stale-journey-binding',
    screenPackRevision: 'stale-screen-pack-binding',
    persistenceRevision: 'stale-persistence-binding',
    navigationRevision: 'stale-navigation-binding',
  };
  for (const [field, value] of Object.entries(expected)) {
    if (compiled[field] !== value) {
      errors.push(finding(codes[field], `${field} does not match the current canonical artifact`));
    }
  }
  const copy = structuredClone(compiled);
  const revision = copy.scenarioRevision;
  delete copy.scenarioRevision;
  if (revision !== sha256Hex(canonicalJson(copy))) {
    errors.push(finding('scenario-revision-mismatch', 'scenarioRevision does not match content'));
  }
  return { ok: errors.length === 0, errors };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--input') args.input = argv[++index];
    else if (argv[index] === '--scope') args.scope = argv[++index];
    else if (argv[index] === '--journey') args.journey = argv[++index];
    else if (argv[index] === '--compiled') args.compiled = argv[++index];
    else if (argv[index] === '--persistence') args.persistence = argv[++index];
    else if (argv[index] === '--navigation') args.navigation = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
    else if (argv[index] === '--check') args.check = true;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!args.projectRoot) throw new Error('--project-root is required');
  return args;
}

function optionalJson(projectRoot, requested, fallback) {
  const file = path.resolve(projectRoot, requested || fallback);
  return fs.existsSync(file) ? readJson(file) : null;
}

function main(argv = process.argv) {
  try {
    const args = parseArgs(argv);
    const projectRoot = path.resolve(args.projectRoot);
    const source = {
      scope: readJson(path.resolve(projectRoot, args.scope || DEFAULT_PATHS.scope)),
      journey: readJson(path.resolve(projectRoot, args.journey || DEFAULT_PATHS.journey)),
      compiled: readJson(path.resolve(projectRoot, args.compiled || DEFAULT_PATHS.compiled)),
      persistence: optionalJson(projectRoot, args.persistence, DEFAULT_PATHS.persistence),
      navigation: optionalJson(projectRoot, args.navigation, DEFAULT_PATHS.navigation),
    };
    const output = path.resolve(projectRoot, args.output || DEFAULT_PATHS.output);
    if (args.check) {
      const result = validateScenarioFacts(readJson(output), source);
      if (!result.ok) result.errors.forEach((item) => process.stderr.write(`${item.code}: ${item.message}\n`));
      else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok ? 0 : 1;
    }
    const result = compileScenarioFacts(
      readJson(path.resolve(projectRoot, args.input || DEFAULT_PATHS.input)),
      source,
    );
    if (result.errors.length > 0) {
      result.errors.forEach((item) => process.stderr.write(`${item.code}: ${item.message}\n`));
      return 1;
    }
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const temporary = `${output}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(result.compiled, null, 2)}\n`);
      fs.renameSync(temporary, output);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      output,
      revision: result.compiled.scenarioRevision,
      recordCount: result.compiled.records.length,
      screenBindingCount: result.compiled.screenBindings.length,
    }, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`validate-fixture-scenarios: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  INVARIANT_OPERATORS,
  compileScenarioFacts,
  main,
  projectScreenFacts,
  validateScenarioFacts,
};
