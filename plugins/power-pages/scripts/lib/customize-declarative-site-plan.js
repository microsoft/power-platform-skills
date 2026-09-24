const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { UUID_REGEX } = require('./validation-helpers');

const PLAN_SCHEMA_VERSION = 1;
const EXECUTION_SCHEMA_VERSION = 1;
const ALLOWED_SKILLS = new Set([
  'author-web-file',
  'author-content-snippet',
  'author-web-template',
  'author-page-template',
  'author-webpage',
  'author-webpage-content',
  'style-site',
]);
const ASSET_KINDS = new Set([
  'photograph',
  'logo',
  'favicon',
  'icon',
  'illustration',
  'pattern',
  'font',
  'other-image',
]);
const ASSET_ROLES = new Set([
  'brand',
  'informative',
  'editorial',
  'structural',
  'functional',
  'decorative',
]);
const ASSET_SOURCE_TYPES = new Set([
  'existing-site',
  'user-provided',
  'agent-authored',
  'unsplash',
]);

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw new Error(`${label} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`);
  }
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }
}

function assertEnum(value, allowed, label) {
  assertString(value, label);
  if (!allowed.has(value)) {
    throw new Error(`${label} must be one of: ${[...allowed].join(', ')}`);
  }
}

function assertProjectRelativePath(value, label) {
  assertString(value, label);
  if (path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
    throw new Error(`${label} must be a project-relative path without parent traversal`);
  }
}

function validateExternalImageUrl(value, label) {
  assertString(value, label);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid absolute HTTPS image URL`);
  }
  // URL parsing normalizes e.g. "https:\\host" and embedded newlines. Reject those
  // raw forms before handing the exact approved string to native HTML/CSS owners.
  // This validates the address only; it never fetches or attests to remote bytes.
  if (!/^https:\/\//i.test(value) || /[\\\s\u0000-\u001f\u007f]/.test(value) ||
      url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`${label} must use absolute HTTPS without credentials, whitespace, or backslashes`);
  }
}

function containsExactValue(value, expected) {
  if (value === expected) return true;
  return value !== null && typeof value === 'object' &&
    Object.values(value).some((child) => containsExactValue(child, expected));
}

function validateAsset(asset, plan, operationsById) {
  assertObject(asset, 'every asset');
  if (typeof asset.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(asset.id)) {
    throw new Error('every asset id must be kebab-case');
  }
  for (const key of ['name', 'purpose']) assertString(asset[key], `asset ${asset.id}.${key}`);
  assertEnum(asset.kind, ASSET_KINDS, `asset ${asset.id}.kind`);
  assertEnum(asset.role, ASSET_ROLES, `asset ${asset.id}.role`);
  assertObject(asset.source, `asset ${asset.id}.source`);
  assertEnum(
    asset.source.type,
    ASSET_SOURCE_TYPES,
    `asset ${asset.id}.source.type`
  );
  const external = asset.delivery === 'external-url';
  if (!external && asset.delivery !== 'web-file') {
    throw new Error(`asset ${asset.id}.delivery must be web-file or external-url`);
  }
  if (!Array.isArray(asset.placements) || asset.placements.length === 0) {
    throw new Error(`asset ${asset.id}.placements must be a non-empty array`);
  }
  for (const [index, placement] of asset.placements.entries()) {
    assertObject(placement, `asset ${asset.id}.placements[${index}]`);
    for (const key of ['page', 'section', 'usage', 'scope']) {
      assertString(placement[key], `asset ${asset.id}.placements[${index}].${key}`);
    }
    if (!['page', 'sitewide'].includes(placement.scope)) {
      throw new Error(
        `asset ${asset.id}.placements[${index}].scope must be page or sitewide`
      );
    }
  }
  assertObject(asset.visual, `asset ${asset.id}.visual`);
  assertString(asset.visual.rationale, `asset ${asset.id}.visual.rationale`);
  assertObject(asset.accessibility, `asset ${asset.id}.accessibility`);
  if (typeof asset.accessibility.decorative !== 'boolean') {
    throw new Error(`asset ${asset.id}.accessibility.decorative must be a boolean`);
  }
  assertObject(asset.accessibility.altByLocale, `asset ${asset.id}.accessibility.altByLocale`);
  for (const locale of plan.site.languages) {
    if (!(locale in asset.accessibility.altByLocale)) {
      throw new Error(`asset ${asset.id} is missing alt text for locale ${locale}`);
    }
    assertString(
      asset.accessibility.altByLocale[locale],
      `asset ${asset.id}.accessibility.altByLocale.${locale}`,
      { allowEmpty: true }
    );
    if (
      !asset.accessibility.decorative &&
      asset.kind !== 'font' &&
      asset.accessibility.altByLocale[locale].trim() === ''
    ) {
      throw new Error(`asset ${asset.id} requires non-empty alt text for locale ${locale}`);
    }
  }
  assertObject(asset.preparation, `asset ${asset.id}.preparation`);
  assertString(asset.preparation.status, `asset ${asset.id}.preparation.status`);
  const statuses = external ? ['remote'] : ['existing', 'staged'];
  if (!statuses.includes(asset.preparation.status)) {
    throw new Error(`asset ${asset.id}.preparation.status must be ${statuses.join(' or ')}`);
  }
  if (external) {
    if (asset.kind === 'font' || !['user-provided', 'unsplash'].includes(asset.source.type)) {
      throw new Error(`asset ${asset.id} external-url delivery requires a user-provided or Unsplash image`);
    }
    validateExternalImageUrl(asset.externalUrl, `asset ${asset.id}.externalUrl`);
    assertString(asset.source.license, `asset ${asset.id}.source.license`);
    if ('webFileOperationId' in asset || 'existingPublicUrl' in asset ||
        Object.keys(asset.preparation).some((key) => key !== 'status')) {
      throw new Error(`asset ${asset.id} external images must not carry Web File or staged-file metadata`);
    }
    const consumer = [...operationsById.values()].find((operation) =>
      operation.skill !== 'author-web-file' && containsExactValue(operation.inputs, asset.externalUrl)
    );
    if (!consumer) {
      throw new Error(`asset ${asset.id} externalUrl must be consumed as an exact approved static input`);
    }
  }

  if (asset.source.type === 'unsplash') {
    const sourceKeys = ['sourcePage', 'photographer', 'license'];
    if (!external) sourceKeys.push('downloadUrl');
    for (const key of sourceKeys) {
      assertString(asset.source[key], `asset ${asset.id}.source.${key}`);
    }
    if (external && 'downloadUrl' in asset.source && asset.source.downloadUrl !== asset.externalUrl) {
      throw new Error(`asset ${asset.id} Unsplash downloadUrl must match externalUrl when supplied`);
    }
    let sourcePage;
    let downloadUrl;
    try {
      sourcePage = new URL(asset.source.sourcePage);
      downloadUrl = new URL(external ? asset.externalUrl : asset.source.downloadUrl);
    } catch {
      throw new Error(`asset ${asset.id} Unsplash URLs must be valid absolute URLs`);
    }
    if (
      sourcePage.protocol !== 'https:' ||
      sourcePage.username ||
      sourcePage.password ||
      sourcePage.port ||
      !['unsplash.com', 'www.unsplash.com'].includes(sourcePage.hostname.toLowerCase()) ||
      downloadUrl.protocol !== 'https:' ||
      downloadUrl.username ||
      downloadUrl.password ||
      downloadUrl.port ||
      downloadUrl.hostname.toLowerCase() !== 'images.unsplash.com'
    ) {
      throw new Error(
        `asset ${asset.id} Unsplash sourcePage and downloadUrl must use approved Unsplash HTTPS hosts without credentials or custom ports`
      );
    }
  }

  if (external) return;
  if ('externalUrl' in asset) {
    throw new Error(`asset ${asset.id}.externalUrl requires external-url delivery`);
  }
  if (asset.preparation.status === 'staged') {
    if (asset.source.type === 'existing-site') {
      throw new Error(`asset ${asset.id} existing-site sources must use existing preparation`);
    }
    for (const key of ['cachePath', 'sha256', 'mimeType', 'fileName']) {
      assertString(asset.preparation[key], `asset ${asset.id}.preparation.${key}`);
    }
    assertProjectRelativePath(
      asset.preparation.cachePath,
      `asset ${asset.id}.preparation.cachePath`
    );
    if (!/^[a-f0-9]{64}$/.test(asset.preparation.sha256)) {
      throw new Error(`asset ${asset.id}.preparation.sha256 must be a lowercase SHA-256`);
    }
    if (
      asset.source.type === 'agent-authored' &&
      asset.preparation.mimeType !== 'image/svg+xml'
    ) {
      throw new Error(`asset ${asset.id} agent-authored assets must be SVG`);
    }
    for (const key of ['width', 'height']) {
      if (
        asset.preparation[key] !== null &&
        asset.preparation[key] !== undefined &&
        (!Number.isInteger(asset.preparation[key]) || asset.preparation[key] <= 0)
      ) {
        throw new Error(`asset ${asset.id}.preparation.${key} must be a positive integer or null`);
      }
    }
    assertString(asset.webFileOperationId, `asset ${asset.id}.webFileOperationId`);
    const operation = operationsById.get(asset.webFileOperationId);
    if (!operation || operation.skill !== 'author-web-file') {
      throw new Error(
        `asset ${asset.id}.webFileOperationId must reference an author-web-file operation`
      );
    }
    if (!operation.expectedOutputs.includes('publicUrl')) {
      throw new Error(
        `asset ${asset.id} web-file operation must declare the publicUrl output`
      );
    }
    const operationPaths = [
      operation.inputs.sourcePath,
      ...(Array.isArray(operation.inputs.sourcePaths) ? operation.inputs.sourcePaths : []),
    ].filter(Boolean);
    if (!operationPaths.includes(asset.preparation.cachePath)) {
      throw new Error(
        `asset ${asset.id} cachePath must be an input to ${asset.webFileOperationId}`
      );
    }
    const consumer = [...operationsById.values()].find((candidate) =>
      Object.values(candidate.outputBindings).some(
        (binding) =>
          binding.sourceOperation === asset.webFileOperationId && binding.output === 'publicUrl'
      )
    );
    if (!consumer) {
      throw new Error(
        `asset ${asset.id} publicUrl must be consumed through an approved output binding`
      );
    }
  } else {
    if (asset.source.type !== 'existing-site') {
      throw new Error(`asset ${asset.id} new asset sources must use staged preparation`);
    }
    assertString(asset.existingPublicUrl, `asset ${asset.id}.existingPublicUrl`);
    if (
      !asset.existingPublicUrl.startsWith('/') ||
      asset.existingPublicUrl.startsWith('//') ||
      asset.existingPublicUrl.includes('\\')
    ) {
      throw new Error(`asset ${asset.id}.existingPublicUrl must be site-root-relative`);
    }
  }
}

function validateNewSiteDesign(plan, operationsById) {
  if (!('newSiteDesign' in plan)) return;
  const design = plan.newSiteDesign;
  assertObject(design, 'newSiteDesign');
  // The explicit policy is mandatory in new creation handoffs. Its absence leaves
  // previously approved schema-1 Web File plans resumable without rewriting consent.
  if ('imageDelivery' in design) {
    if (design.imageDelivery !== 'external-url') {
      throw new Error('newSiteDesign.imageDelivery must be external-url when supplied');
    }
    if (plan.assets.some((asset) =>
      asset.kind !== 'font' && asset.source.type !== 'existing-site' && asset.delivery !== 'external-url'
    )) {
      throw new Error('newSiteDesign.imageDelivery requires external URLs for added images, not Web File imports');
    }
  }
  if (![3, 5].includes(design.bootstrapMajor)) {
    throw new Error('newSiteDesign.bootstrapMajor must be the verified Bootstrap major: 3 or 5');
  }
  if (design.bootstrapMajor === 3) {
    assertString(design.compatibilityReason, 'newSiteDesign.compatibilityReason');
  }
  for (const key of ['typography', 'palette', 'spacing', 'composition', 'responsive']) {
    assertString(design[key], `newSiteDesign.${key}`);
  }
  for (const key of ['aesthetic', 'mood']) assertString(plan[key], key);
  assertEnum(design.imagery, new Set(['required', 'user-declined']), 'newSiteDesign.imagery');
  if (design.imagery === 'user-declined') {
    assertString(design.imageryReason, 'newSiteDesign.imageryReason');
  } else if (!plan.assets.some((asset) =>
    ['photograph', 'illustration', 'other-image'].includes(asset.kind) &&
    ['informative', 'editorial'].includes(asset.role) &&
    !asset.accessibility.decorative
  )) {
    throw new Error('newSiteDesign requires meaningful content imagery, not only branding or decoration');
  }

  const styling = plan.operations.filter((operation) => operation.skill === 'style-site');
  if (styling.length === 0) {
    throw new Error('newSiteDesign requires a style-site operation for the coordinated visual treatment');
  }
  const structuralIds = plan.operations
    .filter((operation) => operation.skill !== 'style-site')
    .map((operation) => operation.id);
  // Earlier-operation validation makes this a DAG. Check transitive dependencies so
  // the resumable executor cannot start styling while independent structure is pending.
  for (const operation of styling) {
    const dependencies = new Set();
    const pending = [...operation.dependsOn];
    while (pending.length > 0) {
      const id = pending.pop();
      if (dependencies.has(id)) continue;
      dependencies.add(id);
      pending.push(...operationsById.get(id).dependsOn);
    }
    if (structuralIds.some((id) => !dependencies.has(id))) {
      throw new Error(`newSiteDesign styling operation ${operation.id} must depend on all structural operations`);
    }
  }
}

function validateCustomizationPlan(plan) {
  assertObject(plan, 'plan');

  const required = [
    'schemaVersion',
    'site',
    'summary',
    'preservation',
    'aesthetic',
    'mood',
    'capabilities',
    'assets',
    'operations',
    'warnings',
    'verification',
    'deployment',
  ];
  const missing = required.filter((key) => !(key in plan));
  if (missing.length > 0) {
    throw new Error(`Missing required plan keys: ${missing.join(', ')}`);
  }
  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION) {
    throw new Error(`unsupported schemaVersion ${plan.schemaVersion}`);
  }
  if ('modelVersion' in plan) {
    throw new Error('modelVersion is deployment-only and must not appear in a customization plan');
  }

  assertObject(plan.site, 'site');
  if ('modelVersion' in plan.site) {
    throw new Error(
      'site.modelVersion is deployment-only and must not appear in a customization plan'
    );
  }
  for (const key of ['name', 'websiteRecordId', 'siteRoot', 'languages']) {
    if (!(key in plan.site)) throw new Error(`site.${key} is required`);
  }
  assertString(plan.site.name, 'site.name');
  assertString(plan.site.websiteRecordId, 'site.websiteRecordId');
  if (!UUID_REGEX.test(plan.site.websiteRecordId)) {
    throw new Error('site.websiteRecordId must be a UUID');
  }
  assertString(plan.site.siteRoot, 'site.siteRoot');
  assertProjectRelativePath(plan.site.siteRoot, 'site.siteRoot');
  assertStringArray(plan.site.languages, 'site.languages');
  for (const key of ['summary', 'preservation']) assertString(plan[key], key);
  for (const key of ['aesthetic', 'mood']) {
    if (plan[key] !== null) assertString(plan[key], key);
  }
  for (const key of ['capabilities', 'operations', 'warnings', 'verification', 'deployment']) {
    if (!Array.isArray(plan[key])) throw new Error(`${key} must be an array`);
  }

  const operationIds = new Set();
  const operationsById = new Map();
  for (const operation of plan.operations) {
    assertObject(operation, 'every operation');
    if (typeof operation.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(operation.id)) {
      throw new Error('every operation id must be kebab-case');
    }
    if (operationIds.has(operation.id)) {
      throw new Error(`duplicate operation id ${operation.id}`);
    }
    if (!ALLOWED_SKILLS.has(operation.skill)) {
      throw new Error(`unsupported operation skill ${operation.skill}`);
    }
    assertString(operation.action, `operation ${operation.id}.action`);
    for (const key of ['target', 'inputs', 'outputBindings']) {
      assertObject(operation[key], `operation ${operation.id}.${key}`);
    }
    for (const key of ['locales', 'dependsOn', 'preserve', 'expectedOutputs']) {
      if (!Array.isArray(operation[key])) {
        throw new Error(`operation ${operation.id}.${key} must be an array`);
      }
    }
    assertStringArray(operation.locales, `operation ${operation.id}.locales`);
    assertStringArray(operation.dependsOn, `operation ${operation.id}.dependsOn`);
    assertStringArray(operation.preserve, `operation ${operation.id}.preserve`);
    assertStringArray(operation.expectedOutputs, `operation ${operation.id}.expectedOutputs`);

    for (const dependency of operation.dependsOn) {
      if (!operationIds.has(dependency)) {
        throw new Error(
          `operation ${operation.id} depends on ${dependency}, which must appear earlier`
        );
      }
    }
    for (const [inputName, binding] of Object.entries(operation.outputBindings)) {
      assertString(inputName, `operation ${operation.id}.outputBindings key`);
      if (inputName in operation.inputs) {
        throw new Error(
          `operation ${operation.id} input ${inputName} cannot be both static and output-bound`
        );
      }
      assertObject(binding, `operation ${operation.id}.outputBindings.${inputName}`);
      assertString(
        binding.sourceOperation,
        `operation ${operation.id}.outputBindings.${inputName}.sourceOperation`
      );
      assertString(binding.output, `operation ${operation.id}.outputBindings.${inputName}.output`);
      if (!operation.dependsOn.includes(binding.sourceOperation)) {
        throw new Error(
          `operation ${operation.id} output binding ${inputName} must reference an operation in dependsOn`
        );
      }
      const sourceOperation = operationsById.get(binding.sourceOperation);
      if (!sourceOperation.expectedOutputs.includes(binding.output)) {
        throw new Error(
          `operation ${operation.id} output binding ${inputName} references undeclared output ` +
            `${binding.output} from ${binding.sourceOperation}`
        );
      }
    }
    operationIds.add(operation.id);
    operationsById.set(operation.id, operation);
  }
  if ('assets' in plan) {
    if (!Array.isArray(plan.assets)) throw new Error('assets must be an array');
    const assetIds = new Set();
    for (const asset of plan.assets) {
      validateAsset(asset, plan, operationsById);
      if (assetIds.has(asset.id)) throw new Error(`duplicate asset id ${asset.id}`);
      assetIds.add(asset.id);
    }
  }

  validateNewSiteDesign(plan, operationsById);
  return plan;
}

function canonicalPlanJson(plan) {
  validateCustomizationPlan(plan);
  return `${JSON.stringify(plan, null, 2)}\n`;
}

function hashText(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function planHash(plan) {
  return hashText(canonicalPlanJson(plan));
}

function createRunId(now = new Date()) {
  return `customize-${now.toISOString().replace(/[-:.]/g, '').replace('T', '-')}`;
}

function createExecutionReceipt(plan, runId, hash, now = new Date()) {
  const timestamp = now.toISOString();
  return {
    schemaVersion: EXECUTION_SCHEMA_VERSION,
    runId,
    planHash: hash,
    status: 'approved',
    site: {
      websiteRecordId: plan.site.websiteRecordId,
      siteRoot: plan.site.siteRoot,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    operations: plan.operations.map((operation) => ({
      id: operation.id,
      status: 'pending',
      attempt: 0,
      outputs: {},
      error: null,
    })),
  };
}

function customizationPaths(projectRoot) {
  const root = path.join(path.resolve(projectRoot), 'docs', 'customize-declarative-site');
  return {
    root,
    historyRoot: path.join(root, 'history'),
    currentJson: path.join(root, 'current-plan.json'),
    currentHtml: path.join(root, 'current-plan.html'),
    currentExecution: path.join(root, 'current-execution.json'),
    currentIcon: path.join(root, 'power-pages-icon.png'),
  };
}

function writeFileAtomic(filePath, content) {
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tempPath, content, { encoding: 'utf8', flag: 'wx' });
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {}
    throw error;
  }
}

function writeJsonAtomic(filePath, value) {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

module.exports = {
  ALLOWED_SKILLS,
  ASSET_KINDS,
  ASSET_ROLES,
  ASSET_SOURCE_TYPES,
  EXECUTION_SCHEMA_VERSION,
  PLAN_SCHEMA_VERSION,
  canonicalPlanJson,
  createExecutionReceipt,
  createRunId,
  customizationPaths,
  hashText,
  planHash,
  validateCustomizationPlan,
  writeFileAtomic,
  writeJsonAtomic,
};
