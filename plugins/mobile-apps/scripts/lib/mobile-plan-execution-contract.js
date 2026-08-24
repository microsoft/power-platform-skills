'use strict';

const crypto = require('node:crypto');
const EXECUTION_SCHEMA = require('../schema-mobile-plan-execution-contract.json');
const PREFLIGHT_CATALOG = require('../mobile-plan-preflight-catalog.json');

const SHA256 = /^[a-f0-9]{64}$/i;
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const RUNTIME_BANNED_PACKAGES = new Set(PREFLIGHT_CATALOG.runtimeBannedPackages);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function packageCatalogRevision(packageJson) {
  return sha256(stableStringify({
    dependencies: packageJson?.dependencies || {},
    devDependencies: packageJson?.devDependencies || {},
    preflightCatalog: PREFLIGHT_CATALOG,
  }));
}

function normalizedSource(value) {
  return String(value || '')
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractBriefRequirements(briefText) {
  const requirements = [];
  let ignoredSection = false;
  for (const rawLine of String(briefText || '').replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line || /^```/.test(line)) continue;
    if (/^#{1,6}\s+/.test(line)) {
      ignoredSection = /^#{1,6}\s+(?:visual reference|metadata)\b/i.test(line);
      continue;
    }
    if (ignoredSection || /^mode\s*:/i.test(line)) continue;
    if (/^(?:sources?|fidelity|design intake(?: path)?|reference intent)\s*:/i.test(line)) continue;
    const value = normalizedSource(line);
    if (value.length < 3) continue;
    requirements.push(value);
    const signalMatches = PREFLIGHT_CATALOG.requirementSignals.flatMap((signal) => {
      const match = value.match(new RegExp(signal.pattern, 'i'));
      return match ? [{ id: signal.id, source: match[0] }] : [];
    });
    if (new Set(signalMatches.map((match) => match.id)).size >= 2) {
      requirements.push(...signalMatches.map((match) => normalizedSource(match.source)));
    }
  }
  return [...new Set(requirements)];
}

function exactKeys(value, allowed, label, errors, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  const actual = Object.keys(value);
  const missing = required.filter((key) => !actual.includes(key));
  const unknown = actual.filter((key) => !allowed.includes(key));
  if (missing.length) errors.push(`${label} is missing keys: ${missing.join(', ')}`);
  if (unknown.length) errors.push(`${label} has unknown keys: ${unknown.join(', ')}`);
}

function unique(values, label, errors) {
  const seen = new Set();
  for (const value of values) {
    const normalized = String(value || '').toLowerCase();
    if (!normalized) continue;
    if (seen.has(normalized)) errors.push(`${label} contains duplicate ${value}`);
    seen.add(normalized);
  }
}

function screenTargets(screenContract) {
  const targets = new Set();
  for (const screen of screenContract?.screens || []) {
    if (!screen?.id) continue;
    targets.add(`screen:${screen.id}`);
    targets.add(`screen:${String(screen.id).toLowerCase()}`);
    if (screen.route) targets.add(`screen:${screen.route}`);
    for (const operation of screen.data?.operations || []) {
      if (operation?.id) targets.add(`operation:${operation.id}`);
    }
  }
  return targets;
}

function executionTargets(contract, screenContract, dataContract) {
  const targets = new Set([
    'asset-policy',
    'data-model',
    'design',
    'experience-contract',
    'native-capabilities',
    'screen-plan',
  ]);
  for (const target of screenTargets(screenContract)) targets.add(target);
  for (const table of dataContract?.tables || []) {
    if (table?.logicalName) targets.add(`data:${table.logicalName}`);
  }
  for (const entity of dataContract?.entities || []) {
    if (entity?.key) targets.add(`data:${entity.key}`);
  }
  for (const operation of dataContract?.operations || []) {
    if (operation?.key) targets.add(`operation:${operation.key}`);
  }
  for (const item of contract?.nativeCapabilities || []) {
    if (item?.id) {
      targets.add(item.id);
      targets.add(`native:${item.id}`);
    }
  }
  for (const item of contract?.javascriptDependencies || []) {
    if (item?.package) targets.add(`dependency:${item.package}`);
  }
  for (const item of contract?.connectorOperations || []) {
    if (item?.id) {
      targets.add(item.id);
      targets.add(`connector:${item.id}`);
    }
  }
  return targets;
}

function referenceTargets(contract, screenContract) {
  const targets = new Set((contract?.requirements || []).map((item) => item.id));
  for (const screen of screenContract?.screens || []) {
    if (!screen?.id) continue;
    targets.add(`screen:${screen.id}`);
    targets.add(`screen:${String(screen.id).toLowerCase()}`);
    if (screen.route) targets.add(`screen:${screen.route}`);
  }
  return targets;
}

function validateRequirement(requirement, index, expectedSources, targets, errors) {
  const label = `executionContract.requirements[${index}]`;
  exactKeys(
    requirement,
    Object.keys(EXECUTION_SCHEMA.definitions.requirement.properties),
    label,
    errors,
    EXECUTION_SCHEMA.definitions.requirement.required,
  );
  if (!/^req-[a-z0-9][a-z0-9-]*$/.test(String(requirement?.id || ''))) errors.push(`${label}.id is invalid`);
  const source = normalizedSource(requirement?.source);
  if (!source || !expectedSources.has(source)) errors.push(`${label}.source is not an exact confirmed-brief requirement`);
  if (!['required', 'optional'].includes(requirement?.priority)) errors.push(`${label}.priority is invalid`);
  if (!['job', 'data', 'screen', 'native', 'connector', 'dependency', 'constraint', 'quality'].includes(requirement?.kind)) errors.push(`${label}.kind is invalid`);
  if (!['planned', 'not-planned'].includes(requirement?.status)) errors.push(`${label}.status is invalid`);
  if (!Array.isArray(requirement?.satisfiedBy)) errors.push(`${label}.satisfiedBy must be an array`);
  if (requirement?.status === 'planned' && !requirement?.satisfiedBy?.length) errors.push(`${label} is planned but has no satisfiedBy target`);
  if (requirement?.status === 'not-planned' && !String(requirement?.reason || '').trim()) errors.push(`${label} is not planned but has no user-visible reason`);
  for (const target of requirement?.satisfiedBy || []) {
    if (!targets.has(target)) errors.push(`${label}.satisfiedBy references unknown target ${target}`);
  }
  const requiredTargetPrefix = { native: 'native', connector: 'connector:', dependency: 'dependency:' }[requirement?.kind];
  if (requirement?.status === 'planned' && requiredTargetPrefix) {
    const matched = (requirement.satisfiedBy || []).some((target) => (
      requiredTargetPrefix === 'native' ? target.startsWith('native-') || target.startsWith('native:') : target.startsWith(requiredTargetPrefix)
    ));
    if (!matched) errors.push(`${label} kind ${requirement.kind} has no ${requiredTargetPrefix} execution target`);
  }
}

function validateNativeCapability(item, index, requirementIds, packageJson, catalogRevision, errors) {
  const label = `executionContract.nativeCapabilities[${index}]`;
  exactKeys(item, EXECUTION_SCHEMA.definitions.nativeCapability.required, label, errors);
  const supportSchema = EXECUTION_SCHEMA.definitions.nativeCapability.properties.support;
  exactKeys(
    item?.support,
    Object.keys(supportSchema.properties),
    `${label}.support`,
    errors,
    supportSchema.required,
  );
  if (!/^native-[a-z0-9][a-z0-9-]*$/.test(String(item?.id || ''))) errors.push(`${label}.id is invalid`);
  if (!Array.isArray(item?.requiredBy) || !item.requiredBy.length) errors.push(`${label}.requiredBy must be non-empty`);
  for (const requirementId of item?.requiredBy || []) {
    if (!requirementIds.has(requirementId)) errors.push(`${label}.requiredBy references unknown requirement ${requirementId}`);
  }
  if (!Array.isArray(item?.platforms) || !item.platforms.length || item.platforms.some((platform) => !['ios', 'android', 'web'].includes(platform))) errors.push(`${label}.platforms is invalid`);
  if (item?.support?.status !== 'supported') errors.push(`${label} is not supported and cannot enter an approvable plan`);
  if (!SHA256.test(String(item?.support?.catalogRevision || ''))) errors.push(`${label}.support.catalogRevision is invalid`);
  if (item?.support?.reason !== undefined && typeof item.support.reason !== 'string') errors.push(`${label}.support.reason must be a string when supplied`);
  if (catalogRevision && item?.support?.catalogRevision !== catalogRevision) errors.push(`${label}.support.catalogRevision is stale`);
  const packageName = item?.support?.templatePackage;
  if (RUNTIME_BANNED_PACKAGES.has(packageName)) errors.push(`${label} selects runtime-banned package ${packageName}`);
  if (packageJson && packageName) {
    const installed = packageJson.dependencies?.[packageName] || packageJson.devDependencies?.[packageName];
    if (!installed) errors.push(`${label}.support.templatePackage ${packageName} is absent from the selected template`);
    else if (item.support.templateVersion !== installed) errors.push(`${label}.support.templateVersion does not match ${packageName}@${installed}`);
  }
  if (!['add-native', 'existing-runtime', 'none'].includes(item?.execution)) errors.push(`${label}.execution is invalid`);
  if (item?.support?.status === 'supported' && item.execution === 'add-native'
    && (!String(item.support.templatePackage || '').trim() || !String(item.support.templateVersion || '').trim())) {
    errors.push(`${label} supported add-native capability requires templatePackage and templateVersion`);
  }
}

function validateJavascriptDependency(item, index, references, packageJson, errors) {
  const label = `executionContract.javascriptDependencies[${index}]`;
  exactKeys(item, EXECUTION_SCHEMA.definitions.javascriptDependency.required, label, errors);
  if (!String(item?.package || '').trim()) errors.push(`${label}.package is required`);
  if (!EXACT_SEMVER.test(String(item?.version || ''))) errors.push(`${label}.version must be exact semver`);
  if (item?.classification !== 'pure-js') errors.push(`${label}.classification must be pure-js`);
  if (!['installed', 'approved-before-build'].includes(item?.resolution)) errors.push(`${label}.resolution is invalid`);
  if (!Array.isArray(item?.requiredBy) || !item.requiredBy.length) errors.push(`${label}.requiredBy must be non-empty`);
  for (const target of item?.requiredBy || []) {
    if (!references.has(target)) errors.push(`${label}.requiredBy references unknown target ${target}`);
  }
  if (RUNTIME_BANNED_PACKAGES.has(item?.package)) errors.push(`${label} selects runtime-banned package ${item.package}`);
  if (packageJson && item?.resolution === 'installed') {
    const installed = packageJson.dependencies?.[item.package] || packageJson.devDependencies?.[item.package];
    if (installed !== item.version) errors.push(`${label} says installed, but package.json does not contain exact ${item.package}@${item.version}`);
  }
}

function validateConnectorOperation(item, index, references, errors) {
  const label = `executionContract.connectorOperations[${index}]`;
  exactKeys(item, EXECUTION_SCHEMA.definitions.connectorOperation.required, label, errors);
  if (!/^connector-[a-z0-9][a-z0-9-]*$/.test(String(item?.id || ''))) errors.push(`${label}.id is invalid`);
  if (!String(item?.connector || '').trim() || !/^[a-z0-9][a-z0-9_-]*$/.test(String(item?.apiName || '')) || !/^[A-Za-z_$][A-Za-z0-9_$]*Service$/.test(String(item?.service || '')) || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(item?.operation || ''))) errors.push(`${label} requires connector, API name, service, and callable operation identifiers`);
  if (!Array.isArray(item?.requiredBy) || !item.requiredBy.length) errors.push(`${label}.requiredBy must be non-empty`);
  for (const target of item?.requiredBy || []) {
    if (!references.has(target)) errors.push(`${label}.requiredBy references unknown target ${target}`);
  }
  if (!item?.input || typeof item.input !== 'object' || Array.isArray(item.input)) errors.push(`${label}.input must be an object`);
  if (!item?.output || typeof item.output !== 'object' || Array.isArray(item.output) || !Object.keys(item.output).length) errors.push(`${label}.output must be a non-empty object`);
  if (!['empty', 'error', 'offline', 'unavailable'].includes(item?.failure?.state) || !String(item?.failure?.userAction || '').trim()) errors.push(`${label}.failure is incomplete`);
  if (item?.prototype?.behavior !== 'typed-throw-stub') errors.push(`${label}.prototype.behavior must be typed-throw-stub`);
}

function connectorFactContent(item) {
  const copy = { ...item };
  delete copy.requiredBy;
  return copy;
}

function validateMobilePlanExecutionContract(contract, context = {}) {
  const errors = [];
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return { valid: false, errors: ['executionContract must be an object'] };
  exactKeys(contract, Object.keys(EXECUTION_SCHEMA.properties), 'executionContract', errors, EXECUTION_SCHEMA.required);
  if (contract.schemaVersion !== 1) errors.push('executionContract.schemaVersion must be 1');
  if (!SHA256.test(String(contract.experienceContractSha256 || ''))) errors.push('executionContract.experienceContractSha256 is invalid');
  if (contract.contextEnrichmentSha256 !== undefined && !SHA256.test(String(contract.contextEnrichmentSha256))) errors.push('executionContract.contextEnrichmentSha256 is invalid');
  if (contract.domainModelSha256 !== undefined && !SHA256.test(String(contract.domainModelSha256))) errors.push('executionContract.domainModelSha256 is invalid');
  if (!SHA256.test(String(contract.briefSha256 || ''))) errors.push('executionContract.briefSha256 is invalid');
  if (context.experienceContractSha256 && contract.experienceContractSha256 !== context.experienceContractSha256) errors.push('executionContract does not match the foreground Experience Contract');
  if (Object.prototype.hasOwnProperty.call(context, 'contextEnrichmentSha256')) {
    if (context.contextEnrichmentSha256 && contract.contextEnrichmentSha256 !== context.contextEnrichmentSha256) errors.push('executionContract does not match the Context Enrichment Contract');
    if (!context.contextEnrichmentSha256 && contract.contextEnrichmentSha256 !== undefined) errors.push('executionContract retains a Context Enrichment hash without a context contract');
  }
  if (Object.prototype.hasOwnProperty.call(context, 'domainModelSha256')) {
    if (context.domainModelSha256 && contract.domainModelSha256 !== context.domainModelSha256) errors.push('executionContract does not match the Prototype Domain Model');
    if (!context.domainModelSha256 && contract.domainModelSha256 !== undefined) errors.push('executionContract retains a Domain Model hash without a domain contract');
  }
  if (typeof context.briefText === 'string' && contract.briefSha256 !== sha256(context.briefText)) errors.push('executionContract does not match the confirmed brief bytes');

  const preflight = context.preflight;
  if (preflight) {
    if (preflight.kind !== 'mobile-plan-execution-preflight' || preflight.schemaVersion !== 1) errors.push('execution preflight is invalid');
    if (contract.experienceContractSha256 !== preflight.experienceContractSha256 || contract.briefSha256 !== preflight.briefSha256) errors.push('executionContract hashes do not match the foreground preflight');
  }

  const expectedSources = new Set(extractBriefRequirements(context.briefText));
  const requirements = Array.isArray(contract.requirements) ? contract.requirements : [];
  if (!requirements.length) errors.push('executionContract.requirements must be non-empty');
  unique(requirements.map((item) => item?.id), 'executionContract.requirements', errors);
  if (preflight) {
    const finalById = new Map(requirements.map((item) => [item.id, item]));
    const preflightIds = new Set((preflight.requirements || []).map((item) => item.id));
    for (const expected of preflight.requirements || []) {
      const actual = finalById.get(expected.id);
      if (!actual || normalizedSource(actual.source) !== normalizedSource(expected.source)) errors.push(`executionContract did not preserve preflight requirement ${expected.id}`);
    }
    for (const requirement of requirements) {
      if (!preflightIds.has(requirement.id)) errors.push(`executionContract contains requirement not present in preflight: ${requirement.id}`);
    }
  }
  const actualSources = new Set(requirements.map((item) => normalizedSource(item?.source)).filter(Boolean));
  for (const source of expectedSources) {
    if (!actualSources.has(source)) errors.push(`executionContract dropped confirmed brief requirement: ${source}`);
  }
  const targets = executionTargets(contract, context.screenContract, context.dataContract);
  requirements.forEach((item, index) => validateRequirement(item, index, expectedSources, targets, errors));
  const requirementIds = new Set(requirements.map((item) => item?.id));
  const references = referenceTargets(contract, context.screenContract);
  const catalogRevision = context.packageJson ? packageCatalogRevision(context.packageJson) : null;

  const nativeCapabilities = Array.isArray(contract.nativeCapabilities) ? contract.nativeCapabilities : [];
  unique(nativeCapabilities.map((item) => item?.id), 'executionContract.nativeCapabilities', errors);
  nativeCapabilities.forEach((item, index) => validateNativeCapability(item, index, requirementIds, context.packageJson, catalogRevision, errors));
  if (preflight) {
    const finalNative = new Map(nativeCapabilities.map((item) => [item.id, item]));
    for (const expected of preflight.nativeCapabilities || []) {
      const actual = finalNative.get(expected.id);
      if (!actual || actual.capability !== expected.capability || actual.support?.templatePackage !== expected.support?.templatePackage || actual.support?.templateVersion !== expected.support?.templateVersion || actual.support?.catalogRevision !== expected.support?.catalogRevision) errors.push(`executionContract did not preserve native preflight fact ${expected.id}`);
    }
  }

  const dependencies = Array.isArray(contract.javascriptDependencies) ? contract.javascriptDependencies : [];
  unique(dependencies.map((item) => item?.package), 'executionContract.javascriptDependencies', errors);
  dependencies.forEach((item, index) => validateJavascriptDependency(item, index, references, context.packageJson, errors));
  if (preflight) {
    const candidates = new Map((preflight.javascriptDependencies || []).map((item) => [item.package, item]));
    for (const dependency of dependencies) {
      const candidate = candidates.get(dependency.package);
      if (!candidate || candidate.version !== dependency.version) errors.push(`executionContract dependency ${dependency.package}@${dependency.version} was not resolved by the foreground preflight`);
    }
  }

  const connectors = Array.isArray(contract.connectorOperations) ? contract.connectorOperations : [];
  unique(connectors.map((item) => item?.id), 'executionContract.connectorOperations', errors);
  connectors.forEach((item, index) => validateConnectorOperation(item, index, references, errors));
  if (preflight) {
    if ((preflight.blockers || []).length) errors.push(...preflight.blockers.map((blocker) => `execution preflight blocker: ${blocker}`));
    const expectedConnectors = new Map((preflight.connectorOperations || []).map((item) => [item.id, item]));
    const hintedApis = new Set((preflight.connectorHints || []).map((item) => item.apiName));
    for (const expected of expectedConnectors.values()) {
      const actual = connectors.find((item) => item.id === expected.id);
      if (!actual || stableStringify(connectorFactContent(actual)) !== stableStringify(connectorFactContent(expected))) {
        errors.push(`executionContract did not preserve connector preflight fact ${expected.id}`);
      } else {
        for (const requirementId of expected.requiredBy || []) {
          if (!actual.requiredBy.includes(requirementId)) errors.push(`executionContract connector ${expected.id} dropped preflight consumer ${requirementId}`);
        }
      }
    }
    if (connectors.length !== expectedConnectors.size) errors.push('executionContract connector operation count does not match the foreground preflight');
    for (const connector of connectors) {
      if (!hintedApis.has(connector.apiName)) errors.push(`executionContract connector ${connector.apiName} was not resolved by the foreground preflight`);
    }
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  extractBriefRequirements,
  packageCatalogRevision,
  sha256,
  validateMobilePlanExecutionContract,
};