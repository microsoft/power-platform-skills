'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { canonicalJson, sha256Hex } = require('./product-experience-contracts');

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_INPUT_BYTES = 48 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const STATUSES = new Set(['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED']);
const FIELDS = new Set([
  'schemaVersion',
  'runId',
  'screenId',
  'route',
  'targetPath',
  'pack',
  'routeContract',
  'typedSkeleton',
  'serviceSignatures',
  'tokenInterfaces',
  'signatureComponentInterfaces',
  'states',
  'testIds',
  'accessibilityRequirements',
  'inputFingerprint',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))].sort();
}

function safeTarget(projectRoot, targetPath, fileSystem = fs) {
  const root = path.resolve(projectRoot);
  const target = path.resolve(root, targetPath);
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`targetPath must be a file inside project root: ${targetPath}`);
  }
  let current = root;
  for (const segment of path.dirname(relative).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fileSystem.existsSync(current) && fileSystem.lstatSync(current).isSymbolicLink()) {
      throw new Error(`targetPath traverses a symbolic link: ${targetPath}`);
    }
  }
  if (fileSystem.existsSync(target) && fileSystem.lstatSync(target).isSymbolicLink()) {
    throw new Error(`targetPath must not be a symbolic link: ${targetPath}`);
  }
  return target;
}

function normalizeWorkOrder(value, { projectRoot, fileSystem = fs } = {}) {
  if (!projectRoot) throw new Error('projectRoot is required');
  if (!isPlainObject(value)) throw new Error('screen work order must be an object');
  for (const key of Object.keys(value)) {
    if (!FIELDS.has(key)) throw new Error(`unsupported screen work-order field: ${key}`);
  }
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error('schemaVersion must equal 1');
  const runId = requiredString(value.runId, 'runId');
  const screenId = requiredString(value.screenId, 'screenId');
  const route = requiredString(value.route, 'route');
  if (!route.startsWith('/')) throw new Error('route must start with /');
  if (!isPlainObject(value.pack) || value.pack.screenId !== screenId) {
    throw new Error('pack must be the assigned screen build-pack entry');
  }
  if (!isPlainObject(value.routeContract)) throw new Error('routeContract must be an object');
  const targetPath = safeTarget(projectRoot, requiredString(value.targetPath, 'targetPath'), fileSystem);
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    screenId,
    route,
    targetPath,
    pack: value.pack,
    routeContract: value.routeContract,
    typedSkeleton: requiredString(value.typedSkeleton, 'typedSkeleton'),
    serviceSignatures: stringArray(value.serviceSignatures, 'serviceSignatures'),
    tokenInterfaces: stringArray(value.tokenInterfaces, 'tokenInterfaces'),
    signatureComponentInterfaces: stringArray(
      value.signatureComponentInterfaces,
      'signatureComponentInterfaces',
    ),
    states: value.states,
    testIds: stringArray(value.testIds, 'testIds'),
    accessibilityRequirements: stringArray(
      value.accessibilityRequirements,
      'accessibilityRequirements',
    ),
  };
  if (!isPlainObject(normalized.states)) throw new Error('states must be an object');
  return normalized;
}

function workOrderFingerprint(value) {
  const clone = structuredClone(value);
  delete clone.inputFingerprint;
  return sha256Hex(canonicalJson(clone));
}

function sealWorkOrder(value, options = {}) {
  const normalized = normalizeWorkOrder(value, options);
  const sealed = { ...normalized, inputFingerprint: workOrderFingerprint(normalized) };
  const payloadBytes = Buffer.byteLength(`${JSON.stringify(sealed)}\n`, 'utf8');
  const maxInputBytes = options.maxInputBytes || DEFAULT_MAX_INPUT_BYTES;
  if (payloadBytes > maxInputBytes) {
    throw new Error(`screen work order is ${payloadBytes} bytes; maximum is ${maxInputBytes}`);
  }
  return { sealed, payloadBytes };
}

function validateSealedWorkOrder(value, options = {}) {
  const normalized = normalizeWorkOrder(value, options);
  if (!/^[a-f0-9]{64}$/.test(String(value.inputFingerprint || ''))) {
    throw new Error('inputFingerprint must be a SHA-256 value');
  }
  if (workOrderFingerprint(normalized) !== value.inputFingerprint) {
    throw new Error('inputFingerprint does not match the screen work order');
  }
  return { ...normalized, inputFingerprint: value.inputFingerprint };
}

function delimiters(workOrder) {
  const key = `${workOrder.runId}:${workOrder.inputFingerprint}`;
  return {
    resultBegin: `<<<MOBILE_SCREEN_RESULT:${key}:BEGIN>>>`,
    resultEnd: `<<<MOBILE_SCREEN_RESULT:${key}:END>>>`,
    contentBegin: `<<<MOBILE_SCREEN_CONTENT:${workOrder.inputFingerprint}:BEGIN>>>`,
    contentEnd: `<<<MOBILE_SCREEN_CONTENT:${workOrder.inputFingerprint}:END>>>`,
  };
}

function validateGeneratedScreenContent(content, workOrder) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('generated screen content is empty');
  }
  const missingTestIds = workOrder.testIds.filter((testId) => !content.includes(testId));
  if (missingTestIds.length) {
    throw new Error(`generated screen is missing required test IDs: ${missingTestIds.join(', ')}`);
  }

  const allowedNamedTokens = new Set(workOrder.tokenInterfaces.flatMap((entry) => (
    entry.match(/\$[A-Za-z][A-Za-z0-9.]*/g) || []
  )));
  if (allowedNamedTokens.size) {
    const usedNamedTokens = new Set(content.match(/\$[A-Za-z][A-Za-z0-9.]*/g) || []);
    const unsupported = [...usedNamedTokens]
      .filter((token) => !allowedNamedTokens.has(token))
      .sort();
    if (unsupported.length) {
      throw new Error(`generated screen uses tokens outside the sealed interface: ${unsupported.join(', ')}`);
    }
  }

  const suppliedSymbols = [...workOrder.serviceSignatures, ...workOrder.signatureComponentInterfaces]
    .map((entry) => entry.match(/^\s*([A-Za-z_$][A-Za-z0-9_$]*)/u)?.[1])
    .filter(Boolean);
  const locallyShadowed = [...new Set(suppliedSymbols)].filter((symbol) => {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b(?:const|let|var|function|class)\\s+${escaped}\\b`, 'u').test(content);
  });
  if (locallyShadowed.length) {
    throw new Error(
      `generated screen locally reimplements supplied interfaces: ${locallyShadowed.sort().join(', ')}`,
    );
  }

  if (!Object.prototype.hasOwnProperty.call(workOrder.states, 'offline')) {
    const offlineCopy = /(?:['"`][^'"`\n]*\boffline\b[^'"`\n]*['"`]|>[^<\n]*\boffline\b[^<\n]*<)/i;
    if (offlineCopy.test(content)) {
      throw new Error('generated screen includes offline copy but the sealed work order has no offline state');
    }
  }
  return { contentHash: sha256Hex(content) };
}

function parseHeader(text) {
  const values = {};
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^([A-Z_]+):\s*(.*)$/);
    if (!match) throw new Error(`invalid return-only header line: ${line}`);
    if (Object.prototype.hasOwnProperty.call(values, match[1])) {
      throw new Error(`duplicate return-only header: ${match[1]}`);
    }
    values[match[1]] = match[2];
  }
  return values;
}

function parseReturnOnly(responseText, sealedWorkOrder, options = {}) {
  const workOrder = validateSealedWorkOrder(sealedWorkOrder, options);
  if (typeof responseText !== 'string' || !responseText.trim()) {
    throw new Error('return-only response is empty');
  }
  const outputBytes = Buffer.byteLength(responseText, 'utf8');
  const maxOutputBytes = options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;
  if (outputBytes > maxOutputBytes) {
    throw new Error(`return-only response is ${outputBytes} bytes; maximum is ${maxOutputBytes}`);
  }
  const marker = delimiters(workOrder);
  const trimmed = responseText.trim();
  if (!trimmed.startsWith(marker.resultBegin) || !trimmed.endsWith(marker.resultEnd)) {
    throw new Error('return-only response has missing or mismatched run-scoped delimiters');
  }
  const body = trimmed.slice(marker.resultBegin.length, -marker.resultEnd.length).trim();
  const contentStart = body.indexOf(marker.contentBegin);
  const contentEnd = body.indexOf(marker.contentEnd);
  const hasContent = contentStart >= 0 || contentEnd >= 0;
  if ((contentStart >= 0) !== (contentEnd >= 0) || contentEnd < contentStart) {
    throw new Error('return-only content delimiters are incomplete');
  }
  const headerText = hasContent ? body.slice(0, contentStart).trim() : body;
  const header = parseHeader(headerText);
  if (!STATUSES.has(header.STATUS)) throw new Error(`unsupported screen status: ${header.STATUS}`);
  if (path.resolve(header.TARGET || '') !== workOrder.targetPath) {
    throw new Error('return-only target does not match the assigned screen');
  }
  let concerns;
  try {
    concerns = JSON.parse(header.CONCERNS || '[]');
  } catch (error) {
    throw new Error(`CONCERNS must be a JSON string array: ${error.message}`);
  }
  concerns = stringArray(concerns, 'CONCERNS');
  const content = hasContent
    ? body.slice(contentStart + marker.contentBegin.length, contentEnd).replace(/^\r?\n|\r?\n$/g, '')
    : null;
  if (['DONE', 'DONE_WITH_CONCERNS'].includes(header.STATUS) && !content?.trim()) {
    throw new Error(`${header.STATUS} requires complete TSX content`);
  }
  if (!['DONE', 'DONE_WITH_CONCERNS'].includes(header.STATUS) && content !== null) {
    throw new Error(`${header.STATUS} must not return partial TSX content`);
  }
  if (header.STATUS === 'DONE' && concerns.length > 0) {
    throw new Error('DONE must not include concerns');
  }
  if (header.STATUS === 'DONE_WITH_CONCERNS' && concerns.length === 0) {
    throw new Error('DONE_WITH_CONCERNS requires at least one concern');
  }
  const contentValidation = content
    ? validateGeneratedScreenContent(content, workOrder)
    : { contentHash: null };
  return {
    status: header.STATUS,
    screenId: workOrder.screenId,
    targetPath: workOrder.targetPath,
    inputFingerprint: workOrder.inputFingerprint,
    concerns,
    detail: header.DETAIL || null,
    content,
    contentHash: contentValidation.contentHash,
    outputBytes,
  };
}

function validateDirectWrite(sealedWorkOrder, result, options = {}) {
  const workOrder = validateSealedWorkOrder(sealedWorkOrder, options);
  if (!isPlainObject(result)) throw new Error('direct-write result must be an object');
  if (result.inputFingerprint !== workOrder.inputFingerprint) {
    throw new Error('direct-write result fingerprint does not match the work order');
  }
  if (path.resolve(result.targetPath || '') !== workOrder.targetPath) {
    throw new Error('direct-write result target does not match the assigned screen');
  }
  if (!STATUSES.has(result.status)) throw new Error(`unsupported screen status: ${result.status}`);
  const changedFiles = stringArray(result.changedFiles, 'changedFiles').map((file) => path.resolve(file));
  const ready = ['DONE', 'DONE_WITH_CONCERNS'].includes(result.status);
  if (ready && (changedFiles.length !== 1 || changedFiles[0] !== workOrder.targetPath)) {
    throw new Error(`direct-write may change only ${workOrder.targetPath}`);
  }
  if (!ready && changedFiles.length !== 0) {
    throw new Error(`${result.status} must not report partial direct-write changes`);
  }
  const concerns = stringArray(result.concerns || [], 'concerns');
  if (result.status === 'DONE' && concerns.length > 0) {
    throw new Error('DONE must not include concerns');
  }
  if (result.status === 'DONE_WITH_CONCERNS' && concerns.length === 0) {
    throw new Error('DONE_WITH_CONCERNS requires at least one concern');
  }
  const contentValidation = ready
    ? validateGeneratedScreenContent(fs.readFileSync(workOrder.targetPath, 'utf8'), workOrder)
    : { contentHash: null };
  return { ...result, changedFiles, concerns, contentHash: contentValidation.contentHash };
}

module.exports = {
  DEFAULT_MAX_INPUT_BYTES,
  DEFAULT_MAX_OUTPUT_BYTES,
  SCHEMA_VERSION,
  delimiters,
  normalizeWorkOrder,
  parseReturnOnly,
  sealWorkOrder,
  validateGeneratedScreenContent,
  validateDirectWrite,
  validateSealedWorkOrder,
  workOrderFingerprint,
};