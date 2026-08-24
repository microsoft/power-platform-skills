#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const BUNDLE_SCHEMA = require('./schema-plan-artifact-bundle.json');
const {
  contractHash,
  foundationContract,
  primaryComposition,
  validateExperienceContract,
} = require('./experience-patterns');
const { validateContract } = require('./build-dataverse-operation-manifest');
const { validateExperienceScreenContract } = require('./lib/experience-screen-contract');
const { validateMobilePlanExecutionContract } = require('./lib/mobile-plan-execution-contract');
const { domainModelRevision, validatePrototypeDomainModel } = require('./lib/prototype-domain-model');
const { contextEnrichmentRevision } = require('./resolve-context-enrichment');
const { validateContextEnrichment } = require('./validate-context-enrichment');

const TOP_LEVEL_KEYS = BUNDLE_SCHEMA.required;
const ARTIFACT_KEYS = BUNDLE_SCHEMA.properties.artifacts.required;
const SECTION_KEYS = BUNDLE_SCHEMA.properties.sections.required;
const SECTION_FIELDS = BUNDLE_SCHEMA.definitions.section.required;
const FORBIDDEN_BUNDLE_KEYS = new Set([
  'approvalid',
  'mobileplanstatus',
  'mobileplanstatuspath',
  'outputpath',
  'planpath',
  'statuspath',
  'targetpath',
  'writepath',
]);
const REQUIRED_HEADINGS = [
  'Overview',
  'App Requirements',
  'Data Model',
  'Native Capabilities',
  'Design',
  'Connectors',
  'Screens',
  'Approvals',
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ownKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
}

function exactKeys(value, expected, label, errors) {
  const actual = ownKeys(value);
  const missing = expected.filter((key) => !actual.includes(key));
  const unknown = actual.filter((key) => !expected.includes(key));
  if (missing.length) errors.push(`${label} is missing keys: ${missing.join(', ')}`);
  if (unknown.length) errors.push(`${label} has unknown keys: ${unknown.join(', ')}`);
}

function containsUnsafeInstruction(value) {
  const text = String(value || '');
  return /(?:^|\n)\s*(?:node|npm|npx|git|cat|cp|mv|rm|mkdir|curl|wget)\b|(?:^|\n)\s*(?:Write|Edit)\s+(?:file|path)|(?:^|\s)(?:\/(?:Users|tmp|home)\/|file:\/\/|[A-Za-z]:[\\/])|\.\.[/\\]/m.test(text);
}

function stringsIn(value, strings = []) {
  if (typeof value === 'string') {
    strings.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) stringsIn(item, strings);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) stringsIn(item, strings);
  }
  return strings;
}

function collectForbiddenBundleMetadata(value, errors) {
  if (typeof value === 'string') {
    if (/mobile-plan-status\.json|approval\s*id\b/i.test(value)) {
      errors.push('bundle must not include checkpoint state or approval IDs');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectForbiddenBundleMetadata(item, errors);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_BUNDLE_KEYS.has(key.replace(/[-_\s]/g, '').toLowerCase())) {
      errors.push(`bundle must not include ${key}`);
    }
    collectForbiddenBundleMetadata(child, errors);
  }
}

function validatePlanHeadings(markdown, errors) {
  for (const heading of REQUIRED_HEADINGS) {
    if (!new RegExp(`^##\\s+${heading}\\s*$`, 'm').test(markdown)) {
      errors.push(`nativeAppPlanMarkdown is missing ## ${heading}`);
    }
  }
}

function validateScreenContract(contract, screenContract, context, errors) {
  if (!screenContract || typeof screenContract !== 'object' || Array.isArray(screenContract)) {
    errors.push('experienceScreenContract must be an object');
    return;
  }
  if (screenContract.schemaVersion !== 3) errors.push('experienceScreenContract schemaVersion must be 3 for a plan bundle version 2');
  errors.push(...validateExperienceScreenContract(screenContract, contract, context).map((error) => `experienceScreenContract: ${error}`));
  if (screenContract.experienceContractSha256 !== contractHash(contract)) {
    errors.push('experienceScreenContract does not match the foreground experience contract hash; use contractHash() on parsed JSON, not the JSON file checksum');
  }
  const composition = primaryComposition(contract);
  const primary = screenContract.primaryScreen;
  const expectedPrimary = {
    route: contract.primaryScreen.route,
    file: contract.primaryScreen.file,
    ...composition,
  };
  for (const [field, expected] of Object.entries(expectedPrimary)) {
    const actual = primary?.[field];
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual) || actual.length !== expected.length || expected.some((value, index) => actual[index] !== value)) {
        errors.push(`experienceScreenContract primaryScreen.${field} does not match primaryComposition()`);
      }
    } else if (expected && typeof expected === 'object') {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) errors.push(`experienceScreenContract primaryScreen.${field} does not match primaryComposition()`);
    } else if (actual !== expected) {
      errors.push(`experienceScreenContract primaryScreen.${field} does not match primaryComposition()`);
    }
  }
  if (!screenContract.keyFlow || typeof screenContract.keyFlow.route !== 'string' || screenContract.keyFlow.route === contract.primaryScreen.route) {
    errors.push('experienceScreenContract requires a non-primary keyFlow');
  }
}

function validateFoundation(contract, foundation, errors) {
  if (!foundation || typeof foundation !== 'object' || Array.isArray(foundation)) {
    errors.push('experienceFoundationContract must be an object');
    return;
  }
  const expected = foundationContract(contract);
  if (foundation.schemaVersion !== 1) errors.push('experienceFoundationContract schemaVersion must be 1');
  if (foundation.experienceContractSha256 !== expected.experienceContractSha256) {
    errors.push('experienceFoundationContract does not match the foreground experience contract hash; use foundationContract() on parsed JSON, not the JSON file checksum');
  }
  for (const primitive of expected.primitives) {
    if (!Array.isArray(foundation.primitives) || !foundation.primitives.some((candidate) => candidate?.motif === primitive.motif && candidate.component === primitive.component && candidate.file === primitive.file && candidate.testID === primitive.testID)) {
      errors.push(`experienceFoundationContract is missing primitive ${primitive.motif}`);
    }
  }
}

const REMOTE_MEDIA_FIELDS = Object.freeze({
  imageurl: 'imageUrl',
  imagealttext: 'imageAltText',
  imagecachekey: 'imageCacheKey',
  imageassetkey: 'imageAssetKey',
});

function normalizedIdentities(value, fields) {
  return fields
    .map((field) => String(value?.[field] || '').replace(/[^a-z0-9]/gi, '').toLowerCase())
    .filter(Boolean);
}

function semanticMediaFields(table) {
  const present = new Set();
  for (const column of Array.isArray(table?.columns) ? table.columns : []) {
    const identities = normalizedIdentities(column, [
      'logicalName',
      'schemaName',
      'adaptedLogicalName',
      'adaptedSchemaName',
      'displayName',
    ]);
    for (const semanticName of Object.keys(REMOTE_MEDIA_FIELDS)) {
      if (identities.some((identity) => identity.endsWith(semanticName))) present.add(semanticName);
    }
  }
  return present;
}

function mediaEntityTable(table, publisherPrefix, presentFields) {
  if (presentFields.size > 0) return true;
  const normalizedPrefix = String(publisherPrefix || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const identities = normalizedIdentities(table, [
    'logicalName',
    'schemaName',
    'adaptedLogicalName',
    'adaptedSchemaName',
    'displayName',
    'displayCollectionName',
  ]).flatMap((identity) => (
    normalizedPrefix && identity.startsWith(normalizedPrefix)
      ? [identity, identity.slice(normalizedPrefix.length)]
      : [identity]
  ));
  return identities.some((identity) => /^(?:products?|productmedia|productimages?|productassets?|media)$/.test(identity));
}

function planContradictsRemoteMedia(plan) {
  return String(plan || '').split(/\r?\n/).some((line) => {
    const text = line.replace(/`/g, '').trim().toLowerCase();
    if (!text) return false;
    const explicitReplacement = /(?:replace|supersed)(?:es|ed|ing)?[^.|]{0,100}remote[- ]?cdn|bundled(?:-only| local)?[^.|]{0,80}(?:rather than|instead of)[^.|]{0,40}(?:cdn|remote)/i.test(text);
    const remoteDisabled = /(?:cdn|remote[- ]cdn|remote (?:media|images?))[^.|]{0,80}(?:excluded|disabled|forbidden|not (?:used|required)|unnecessary)/i.test(text)
      || /(?:no|without) (?:runtime )?(?:cdn|remote (?:media|images?))/i.test(text);
    const localRuntime = /runtime media (?:is|are|remains?) (?:fully )?(?:local|bundled)/i.test(text);
    if (explicitReplacement || localRuntime) return true;
    return remoteDisabled && !/fallback|when offline|after (?:the )?initial|once cached|cache miss/i.test(text);
  });
}

function validateMediaDataAgreement(contract, schema, plan, errors) {
  if (contract?.assetPolicy?.media !== 'remote-cdn-cached') return;

  for (const table of schema?.tables || []) {
    const presentFields = semanticMediaFields(table);
    if (!mediaEntityTable(table, schema.publisherPrefix, presentFields)) continue;
    for (const [semanticName, displayName] of Object.entries(REMOTE_MEDIA_FIELDS)) {
      if (!presentFields.has(semanticName)) {
        errors.push(`remote-cdn-cached table ${table.logicalName || table.schemaName || '<unknown>'} is missing media field ${displayName}`);
      }
    }
  }

  if (typeof plan !== 'string') return;
  if (!/remote-cdn-cached/i.test(plan)) {
    errors.push('nativeAppPlanMarkdown must preserve remote-cdn-cached media policy');
  }
  if (contract?.mediaIntent?.source === 'approved-cdn' && !/approved[- ]cdn/i.test(plan)) {
    errors.push('nativeAppPlanMarkdown must preserve approved-cdn media source');
  }
  if (contract?.mediaIntent?.delivery === 'device-cached' && !/device[- ]cached/i.test(plan)) {
    errors.push('nativeAppPlanMarkdown must preserve device-cached media delivery');
  }
  if (planContradictsRemoteMedia(plan)) {
    errors.push('nativeAppPlanMarkdown contradicts remote-cdn-cached media policy');
  }
}

function prototypeFixtureValues(column) {
  if (Array.isArray(column?.fixtureValues)) return column.fixtureValues;
  if (Array.isArray(column?.sampleValues)) return column.sampleValues;
  if (Object.prototype.hasOwnProperty.call(column || {}, 'fixtureValue')) return [column.fixtureValue];
  if (Object.prototype.hasOwnProperty.call(column || {}, 'defaultValue')) return [column.defaultValue];
  return [];
}

function prototypeTableActive(table) {
  return table?.serviceRequired !== false
    && String(table?.plannedDecision || table?.decision || '').toLowerCase() !== 'defer';
}

function genericFixtureName(value, table) {
  const normalized = String(value || '').trim();
  if (!normalized) return true;
  const tableName = String(table?.displayName || table?.logicalName || 'item')
    .replace(/^[a-z0-9]+_/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  const escaped = tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return /^(?:item|record|row|sample|test|example)\s*#?\d+$/i.test(normalized)
    || /^lorem\b/i.test(normalized)
    || (escaped && new RegExp(`^${escaped}\\s*#?\\d+$`, 'i').test(normalized));
}

function validatePrototypeFixtures(schema, errors) {
  for (const table of schema?.tables || []) {
    if (!prototypeTableActive(table)) continue;
    const label = table.logicalName || table.schemaName || '<unknown>';
    const rowCount = table.fixtureRowCount ?? table.prototypeRowCount;
    if (!Number.isInteger(rowCount) || rowCount < 0 || rowCount > 50) {
      errors.push(`prototype table ${label} requires fixtureRowCount between 0 and 50`);
      continue;
    }
    const semanticTable = `${table.logicalName || ''} ${table.displayName || ''}`.toLowerCase();
    if (/(?:cart|basket|order|selection|saved|favorite)[ _-]?(?:line|item)$|(?:line|selection)[ _-]?item$/.test(semanticTable) && rowCount > 5) {
      errors.push(`prototype selection/line-item table ${label} must keep its populated fixtureRowCount at 5 or fewer`);
    }
    if (rowCount === 0) continue;
    const activeColumns = (table.columns || []).filter((column) => String(column.plannedDecision || column.decision || '').toLowerCase() !== 'defer');
    const primary = activeColumns.find((column) => column.primaryName === true);
    const names = prototypeFixtureValues(primary);
    const minimumNames = Math.min(rowCount, 8);
    if (!primary || names.length < minimumNames) {
      errors.push(`prototype table ${label} primary-name fixture data requires ${minimumNames} prompt-derived value(s)`);
    } else {
      const checkedNames = names.slice(0, minimumNames);
      const normalizedNames = checkedNames.map((value) => String(value || '').trim().toLowerCase());
      if (new Set(normalizedNames).size !== normalizedNames.length || checkedNames.some((value) => genericFixtureName(value, table))) {
        errors.push(`prototype table ${label} primary-name fixture values must be unique and domain-readable`);
      }
    }
    for (const column of activeColumns) {
      const semanticColumn = `${column.logicalName || ''} ${column.displayName || ''}`.toLowerCase();
      const values = prototypeFixtureValues(column);
      if (/(?:description|summary|notes?|comment|reason)/.test(semanticColumn)) {
        if (!values.length || values.some((value) => String(value || '').trim().length < 12)) {
          errors.push(`prototype column ${label}.${column.logicalName || '<unknown>'} requires realistic fixtureValues`);
        }
      }
      if (/currency.*code|code.*currency/.test(semanticColumn)) {
        if (!values.length || values.some((value) => !/^[A-Z]{3}$/.test(String(value || '').trim().toUpperCase()))) {
          errors.push(`prototype currency column ${label}.${column.logicalName || '<unknown>'} requires a three-letter ISO fixtureValue`);
        }
      }
      if (/(?:^|[_\s])(?:quantity|qty)(?:$|[_\s])/.test(semanticColumn)) {
        if (!values.length || values.some((value) => !Number.isInteger(value) || value <= 0 || value > 99)) {
          errors.push(`prototype quantity column ${label}.${column.logicalName || '<unknown>'} requires small positive integer fixtureValues`);
        }
      }
    }
  }
}

function validateSections(bundle, errors) {
  exactKeys(bundle.sections, SECTION_KEYS, 'sections', errors);
  const headings = {
    dataModel: 'Data Model',
    nativeCapabilities: 'Native Capabilities',
    connectors: 'Connectors',
    screenPlan: 'Screens',
  };
  for (const key of SECTION_KEYS) {
    const section = bundle.sections?.[key];
    exactKeys(section, SECTION_FIELDS, `sections.${key}`, errors);
    if (!section || typeof section.summary !== 'string' || !section.summary.trim() || typeof section.markdown !== 'string' || !section.markdown.trim()) {
      errors.push(`sections.${key} requires non-empty summary and markdown`);
      continue;
    }
    if (!new RegExp(`^##\\s+${headings[key]}\\s*$`, 'm').test(section.markdown)) {
      errors.push(`sections.${key}.markdown must include ## ${headings[key]}`);
    }
    if (typeof bundle.artifacts?.nativeAppPlanMarkdown === 'string'
      && !bundle.artifacts.nativeAppPlanMarkdown.includes(section.markdown)) {
      errors.push(`sections.${key}.markdown must be present verbatim in nativeAppPlanMarkdown`);
    }
  }
}

function validatePlanArtifactBundle(projectRoot, bundle) {
  const errors = [];
  const root = path.resolve(projectRoot);
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    return { valid: false, errors: ['bundle must be an object'] };
  }
  exactKeys(bundle, TOP_LEVEL_KEYS, 'bundle', errors);
  if (bundle.version !== 3) errors.push('bundle version must be 3');
  if (bundle.kind !== 'mobile-plan-artifact-bundle') errors.push('bundle kind must be mobile-plan-artifact-bundle');
  if (!['create-mobile-app', 'create-mobile-prototype'].includes(bundle.workflow)) errors.push('bundle workflow is invalid');
  if (!['required', 'prototype', 'connector-only'].includes(bundle.planningMode)) errors.push('bundle planningMode is invalid');
  if (bundle.workflow === 'create-mobile-prototype' && bundle.planningMode !== 'prototype') {
    errors.push('create-mobile-prototype bundle planningMode must be prototype');
  }
  if (bundle.workflow === 'create-mobile-app' && !['required', 'connector-only'].includes(bundle.planningMode)) {
    errors.push('create-mobile-app bundle planningMode must be required or connector-only');
  }
  exactKeys(bundle.artifacts, ARTIFACT_KEYS, 'artifacts', errors);
  validateSections(bundle, errors);
  if (!Array.isArray(bundle.warnings) || bundle.warnings.some((warning) => typeof warning !== 'string')) errors.push('warnings must be a string array');

  const plan = bundle.artifacts?.nativeAppPlanMarkdown;
  if (typeof plan !== 'string' || !plan.trim()) errors.push('nativeAppPlanMarkdown must be non-empty');
  else validatePlanHeadings(plan, errors);

  for (const value of stringsIn(bundle)) {
    if (containsUnsafeInstruction(value)) errors.push('bundle contains a path, command, traversal, or arbitrary file-write instruction');
  }
  collectForbiddenBundleMetadata(bundle, errors);

  const experiencePath = path.join(root, '.tmp', 'experience-contract.json');
  if (!fs.existsSync(experiencePath)) {
    errors.push('foreground experience contract is missing');
    return { valid: false, errors };
  }
  let experience;
  try {
    experience = readJson(experiencePath);
  } catch (error) {
    errors.push(`foreground experience contract is invalid JSON: ${error.message}`);
    return { valid: false, errors };
  }
  for (const error of validateExperienceContract(experience)) errors.push(`foreground experience contract: ${error}`);
  const briefPath = [
    path.join(root, '.tmp', 'experience-brief.md'),
    path.join(root, 'brief.md'),
  ].find((candidate) => fs.existsSync(candidate));
  const contextContract = bundle.artifacts?.contextEnrichmentContract;
  if (!contextContract || typeof contextContract !== 'object' || Array.isArray(contextContract)) {
    errors.push('contextEnrichmentContract must be an object');
  } else {
    const contextValidation = validateContextEnrichment(contextContract, {
      experienceContract: experience,
      briefText: briefPath ? fs.readFileSync(briefPath, 'utf8') : null,
    });
    if (!contextValidation.valid) errors.push(...contextValidation.errors.map((error) => `contextEnrichmentContract: ${error}`));
  }
  const domainModel = bundle.artifacts?.prototypeDomainModel;
  const schema = bundle.artifacts?.dataverseSchemaContract;
  if (bundle.planningMode === 'connector-only') {
    if (domainModel !== null) errors.push('connector-only bundle prototypeDomainModel must be null');
  } else if (!domainModel || typeof domainModel !== 'object' || Array.isArray(domainModel)) {
    errors.push('prototypeDomainModel must be an object for domain-backed workflows');
  } else {
    const validation = validatePrototypeDomainModel(domainModel, {
      experienceContractSha256: contractHash(experience),
      contextEnrichmentSha256: contextContract && typeof contextContract === 'object' ? contextEnrichmentRevision(contextContract) : null,
    });
    if (!validation.valid) errors.push(...validation.errors.map((error) => `prototypeDomainModel: ${error}`));
    if (domainModel.mediaPolicy?.mode !== experience.assetPolicy?.media) errors.push('prototypeDomainModel mediaPolicy does not match the Experience Contract');
  }
  if (bundle.planningMode === 'connector-only') {
    if (schema !== null) errors.push('connector-only bundle dataverseSchemaContract must be null');
  } else if (bundle.planningMode === 'prototype') {
    if (schema !== null) errors.push('prototype bundle dataverseSchemaContract must be null');
  } else {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      errors.push('dataverseSchemaContract must be an object');
    } else {
      const schemaValidation = validateContract(schema);
      if (!schemaValidation.valid) errors.push(...schemaValidation.errors.map((error) => `dataverseSchemaContract: ${error}`));
      validateMediaDataAgreement(experience, schema, plan, errors);
    }
  }
  if (bundle.planningMode !== 'required') validateMediaDataAgreement(experience, null, plan, errors);

  const packagePath = path.join(root, 'package.json');
  const preflightPath = path.join(root, '.tmp', 'mobile-plan-execution-preflight.json');
  const executionContract = bundle.artifacts?.executionContract;
  if (!briefPath) {
    errors.push('confirmed brief is missing');
  }
  if (!fs.existsSync(packagePath)) {
    errors.push('package.json is missing for template capability validation');
  }
  if (!fs.existsSync(preflightPath)) {
    errors.push('mobile plan execution preflight is missing');
  }
  if (!executionContract || typeof executionContract !== 'object' || Array.isArray(executionContract)) {
    errors.push('executionContract must be an object');
  } else if (briefPath && fs.existsSync(packagePath) && fs.existsSync(preflightPath)) {
    const executionValidation = validateMobilePlanExecutionContract(executionContract, {
      briefText: fs.readFileSync(briefPath, 'utf8'),
      experienceContractSha256: contractHash(experience),
      contextEnrichmentSha256: contextContract && typeof contextContract === 'object' ? contextEnrichmentRevision(contextContract) : null,
      domainModelSha256: domainModel && typeof domainModel === 'object' ? domainModelRevision(domainModel) : null,
      screenContract: bundle.artifacts?.experienceScreenContract,
      dataContract: domainModel,
      packageJson: readJson(packagePath),
      preflight: readJson(preflightPath),
    });
    errors.push(...executionValidation.errors);
  }
  validateScreenContract(experience, bundle.artifacts?.experienceScreenContract, {
    dataContract: domainModel,
    executionContract,
    contextContract,
  }, errors);
  validateFoundation(experience, bundle.artifacts?.experienceFoundationContract, errors);
  return { valid: errors.length === 0, errors };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--bundle') args.bundle = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.projectRoot || !args.bundle) {
    process.stderr.write('Usage: node validate-plan-artifact-bundle.js --project-root <dir> --bundle <bundle.json> [--json]\n');
    return 2;
  }
  try {
    const bundle = readJson(path.resolve(args.bundle));
    const result = validatePlanArtifactBundle(args.projectRoot, bundle);
    if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.valid) {
      if (!args.json) result.errors.forEach((error) => process.stderr.write(`- ${error}\n`));
      return 2;
    }
    if (!args.json) process.stdout.write('Plan artifact bundle valid.\n');
    return 0;
  } catch (error) {
    process.stderr.write(`validate-plan-artifact-bundle: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { validatePlanArtifactBundle, validatePrototypeFixtures };
