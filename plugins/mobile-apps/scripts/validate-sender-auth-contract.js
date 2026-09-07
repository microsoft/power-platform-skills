#!/usr/bin/env node

'use strict';

// Validates the project-local handoff between sender-auth setup and flow authoring.
// The file is deliberately strict and non-secret: setup workflows must pass only
// stable resource identifiers and short-lived proof metadata, never credentials.

const fs = require('node:fs');
const path = require('node:path');

const CONTRACT_VERSION = 1;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_PROOF_AGE_MS = 24 * 60 * 60 * 1000;
const FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIREBASE_PROJECT_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const GOOGLE_ID_RE = /^[a-z][a-z0-9-]{2,31}$/;
const SERVICE_ACCOUNT_RE =
  /^[a-z][a-z0-9-]{2,29}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;
const SAFE_LABEL_RE = /^[A-Za-z][A-Za-z0-9_-]{0,99}$/;
const SECRET_KEY_RE =
  /^(private[_-]?key|private[_-]?key[_-]?id|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|password|authorization|credential|service[_-]?account[_-]?json)$/i;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/;

class SafeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function issue(code, field, message) {
  return { code, field, message };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkKeys(value, allowed, required, field, issues) {
  if (!isObject(value)) {
    issues.push(issue('object-required', field, 'Value must be an object.'));
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      issues.push(issue('unknown-field', `${field}.${key}`, 'Unknown field is not allowed.'));
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      issues.push(issue('missing-field', `${field}.${key}`, 'Required field is missing.'));
    }
  }
  return true;
}

function requiredString(value, field, pattern, issues, message = 'Value is malformed.') {
  if (typeof value !== 'string' || value.trim() !== value || value === '') {
    issues.push(issue('invalid-string', field, 'Value must be a non-empty trimmed string.'));
    return false;
  }
  if (pattern && !pattern.test(value)) {
    issues.push(issue('malformed-resource-id', field, message));
    return false;
  }
  return true;
}

function validatePlainHttpsUrl(value, field, issues, options = {}) {
  if (!requiredString(value, field, null, issues)) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    issues.push(issue('invalid-https-url', field, 'Value must be a valid HTTPS URL.'));
    return null;
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.search
    || url.hash
    || (!options.allowPath && !['', '/'].includes(url.pathname))
  ) {
    issues.push(issue(
      'invalid-https-url',
      field,
      'URL must use HTTPS without embedded credentials, query, fragment, or an unsupported path.',
    ));
    return null;
  }
  return url;
}

function validateAudience(value, field, issues) {
  if (!requiredString(value, field, null, issues)) return;
  if (value.startsWith('api://')) {
    const suffix = value.slice('api://'.length);
    if (!suffix || /[\s?#@]/.test(suffix)) {
      issues.push(issue('invalid-audience', field, 'api:// audience is malformed.'));
    }
    return;
  }
  validatePlainHttpsUrl(value, field, issues, { allowPath: true });
}

function expectedProviderIssuer(issuer, tenantId, issues) {
  const url = validatePlainHttpsUrl(
    issuer,
    'wif.observedClaimShape.issuer',
    issues,
    { allowPath: true },
  );
  if (!url || !GUID_RE.test(tenantId || '')) return null;
  const segments = url.pathname.split('/').filter(Boolean);
  const host = url.hostname.toLowerCase();
  if (host === 'sts.windows.net') {
    if (segments.length !== 1 || segments[0].toLowerCase() !== tenantId.toLowerCase()) {
      issues.push(issue('issuer-tenant-mismatch', 'wif.observedClaimShape.issuer', 'Observed issuer must identify the configured Entra tenant.'));
      return null;
    }
    return `https://sts.windows.net/${tenantId}`;
  }
  if (host === 'login.microsoftonline.com') {
    if (
      segments.length < 1
      || segments.length > 2
      || segments[0].toLowerCase() !== tenantId.toLowerCase()
      || (segments[1] && segments[1] !== 'v2.0')
    ) {
      issues.push(issue('issuer-tenant-mismatch', 'wif.observedClaimShape.issuer', 'Observed issuer must identify the configured Entra tenant.'));
      return null;
    }
    return issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
  }
  issues.push(issue('unsupported-entra-issuer', 'wif.observedClaimShape.issuer', 'Observed issuer must use a supported Microsoft Entra authority.'));
  return null;
}

function findForbiddenContent(value, field = '$', seen = new Set()) {
  const findings = [];
  if (value && typeof value === 'object') {
    if (seen.has(value)) return findings;
    seen.add(value);
    if (!Array.isArray(value)) {
      for (const key of Object.keys(value)) {
        if (SECRET_KEY_RE.test(key)) {
          findings.push(issue('secret-field-forbidden', `${field}.${key}`, 'Secret-bearing field is forbidden.'));
        }
      }
    }
    for (const [key, child] of Object.entries(value)) {
      findings.push(...findForbiddenContent(child, `${field}.${key}`, seen));
    }
    return findings;
  }
  if (typeof value !== 'string') return findings;
  if (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)
    || JWT_RE.test(value)
    || /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i.test(value)
    || /\bya29\.[A-Za-z0-9._-]+/.test(value)
  ) {
    findings.push(issue('secret-value-forbidden', field, 'Token or private-key material is forbidden.'));
    return findings;
  }
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      findings.push(issue('embedded-credentials-forbidden', field, 'URL credentials are forbidden.'));
    }
  } catch {
    // Most resource identifiers are not URLs; their format is validated separately.
  }
  return findings;
}

function validateProof(proof, firebaseProjectId, now, issues) {
  const expectedVerifier = 'setup-push-wif';
  const stepNames = [
    'entraTokenIssued',
    'googleStsExchanged',
    'serviceAccountImpersonated',
    'fcmValidateOnly',
  ];
  if (!checkKeys(
    proof,
    ['firebaseProjectId', 'verifiedAt', 'validUntil', 'verifier', 'steps'],
    ['firebaseProjectId', 'verifiedAt', 'validUntil', 'verifier', 'steps'],
    'proof',
    issues,
  )) return;

  if (proof.firebaseProjectId !== firebaseProjectId) {
    issues.push(issue('proof-project-mismatch', 'proof.firebaseProjectId', 'Proof is for a different Firebase project.'));
  }
  requiredString(proof.verifier, 'proof.verifier', SAFE_LABEL_RE, issues);
  if (proof.verifier !== expectedVerifier) {
    issues.push(issue(
      'proof-verifier-mismatch',
      'proof.verifier',
      `WIF proof must be produced by ${expectedVerifier}.`,
    ));
  }
  if (checkKeys(proof.steps, stepNames, stepNames, 'proof.steps', issues)) {
    for (const step of stepNames) {
      if (proof.steps[step] !== true) {
        issues.push(issue('proof-step-incomplete', `proof.steps.${step}`, 'Proof step must be true.'));
      }
    }
  }

  const verifiedAt = Date.parse(proof.verifiedAt);
  const validUntil = Date.parse(proof.validUntil);
  if (!Number.isFinite(verifiedAt)) {
    issues.push(issue('invalid-timestamp', 'proof.verifiedAt', 'Timestamp must be valid ISO 8601.'));
  }
  if (!Number.isFinite(validUntil)) {
    issues.push(issue('invalid-timestamp', 'proof.validUntil', 'Timestamp must be valid ISO 8601.'));
  }
  if (!Number.isFinite(verifiedAt) || !Number.isFinite(validUntil)) return;
  if (
    new Date(verifiedAt).toISOString() !== proof.verifiedAt
    || new Date(validUntil).toISOString() !== proof.validUntil
  ) {
    issues.push(issue('non-canonical-timestamp', 'proof', 'Proof timestamps must use canonical UTC ISO 8601.'));
  }
  if (verifiedAt > now.getTime() + FUTURE_CLOCK_SKEW_MS) {
    issues.push(issue('proof-from-future', 'proof.verifiedAt', 'Proof time is too far in the future.'));
  }
  if (validUntil <= verifiedAt || validUntil - verifiedAt > MAX_PROOF_AGE_MS) {
    issues.push(issue('invalid-proof-window', 'proof.validUntil', 'Proof validity window must be positive and at most 24 hours.'));
  }
  if (now.getTime() > validUntil || now.getTime() - verifiedAt > MAX_PROOF_AGE_MS) {
    issues.push(issue('stale-proof', 'proof', 'Proof is stale and must be renewed.'));
  }
}

function validateWif(contract, now, issues) {
  const wif = contract.wif;
  if (!checkKeys(
    wif,
    [
      'googleProjectNumber', 'workloadIdentityPoolId', 'workloadIdentityProviderId',
      'serviceAccountEmail', 'entra', 'keyVaultSecretReference', 'observedClaimShape',
    ],
    [
      'googleProjectNumber', 'workloadIdentityPoolId', 'workloadIdentityProviderId',
      'serviceAccountEmail', 'entra', 'keyVaultSecretReference', 'observedClaimShape',
    ],
    'wif',
    issues,
  )) return;
  requiredString(wif.googleProjectNumber, 'wif.googleProjectNumber', /^[1-9][0-9]{5,19}$/, issues);
  requiredString(wif.workloadIdentityPoolId, 'wif.workloadIdentityPoolId', GOOGLE_ID_RE, issues);
  requiredString(wif.workloadIdentityProviderId, 'wif.workloadIdentityProviderId', GOOGLE_ID_RE, issues);
  requiredString(wif.serviceAccountEmail, 'wif.serviceAccountEmail', SERVICE_ACCOUNT_RE, issues);

  if (checkKeys(
    wif.entra,
    ['tenantId', 'clientId', 'audience'],
    ['tenantId', 'clientId', 'audience'],
    'wif.entra',
    issues,
  )) {
    requiredString(wif.entra.tenantId, 'wif.entra.tenantId', GUID_RE, issues);
    requiredString(wif.entra.clientId, 'wif.entra.clientId', GUID_RE, issues);
    validateAudience(wif.entra.audience, 'wif.entra.audience', issues);
  }

  if (checkKeys(
    wif.keyVaultSecretReference,
    ['vaultUri', 'secretName'],
    ['vaultUri', 'secretName'],
    'wif.keyVaultSecretReference',
    issues,
  )) {
    const vault = validatePlainHttpsUrl(
      wif.keyVaultSecretReference.vaultUri,
      'wif.keyVaultSecretReference.vaultUri',
      issues,
    );
    if (vault && !/^[a-z0-9-]{3,24}\.vault\.azure\.net$/i.test(vault.hostname)) {
      issues.push(issue('invalid-key-vault-uri', 'wif.keyVaultSecretReference.vaultUri', 'Vault URI must identify Azure Key Vault.'));
    }
    requiredString(
      wif.keyVaultSecretReference.secretName,
      'wif.keyVaultSecretReference.secretName',
      /^[A-Za-z0-9-]{1,127}$/,
      issues,
    );
  }

  const claims = wif.observedClaimShape;
  if (checkKeys(
    claims,
    ['issuer', 'googleProviderIssuer', 'audience', 'appIdentityClaim', 'appIdentityValue'],
    ['issuer', 'googleProviderIssuer', 'audience', 'appIdentityClaim', 'appIdentityValue'],
    'wif.observedClaimShape',
    issues,
  )) {
    const providerIssuer = expectedProviderIssuer(claims.issuer, wif.entra?.tenantId, issues);
    validatePlainHttpsUrl(
      claims.googleProviderIssuer,
      'wif.observedClaimShape.googleProviderIssuer',
      issues,
      { allowPath: true },
    );
    validateAudience(claims.audience, 'wif.observedClaimShape.audience', issues);
    if (!['appid', 'azp'].includes(claims.appIdentityClaim)) {
      issues.push(issue('invalid-claim-shape', 'wif.observedClaimShape.appIdentityClaim', 'Claim must be appid or azp.'));
    }
    requiredString(claims.appIdentityValue, 'wif.observedClaimShape.appIdentityValue', GUID_RE, issues);
    if (claims.audience !== wif.entra?.audience) {
      issues.push(issue('claim-audience-mismatch', 'wif.observedClaimShape.audience', 'Observed audience must match Entra audience.'));
    }
    if (claims.appIdentityValue?.toLowerCase() !== wif.entra?.clientId?.toLowerCase()) {
      issues.push(issue('claim-client-mismatch', 'wif.observedClaimShape.appIdentityValue', 'Observed app identity must match Entra client ID.'));
    }
    if (providerIssuer && claims.googleProviderIssuer !== providerIssuer) {
      issues.push(issue('provider-issuer-mismatch', 'wif.observedClaimShape.googleProviderIssuer', 'Google provider issuer must match the normalized observed issuer.'));
    }
  }
  validateProof(contract.proof, contract.firebaseProjectId, now, issues);
}

function validateContract(contract, { expectedFirebaseProject, now = new Date() } = {}) {
  const issues = findForbiddenContent(contract);
  if (!checkKeys(
    contract,
    ['version', 'mode', 'firebaseProjectId', 'wif', 'proof'],
    ['version', 'mode', 'firebaseProjectId', 'wif', 'proof'],
    '$',
    issues,
  )) return issues;
  if (contract.version !== CONTRACT_VERSION) {
    issues.push(issue('unsupported-version', 'version', `Only contract version ${CONTRACT_VERSION} is supported.`));
  }
  if (contract.mode !== 'wif') {
    issues.push(issue('unsupported-mode', 'mode', 'Mode must be wif.'));
  }
  requiredString(contract.firebaseProjectId, 'firebaseProjectId', FIREBASE_PROJECT_RE, issues);
  if (expectedFirebaseProject && contract.firebaseProjectId !== expectedFirebaseProject) {
    issues.push(issue('firebase-project-mismatch', 'firebaseProjectId', 'Firebase project does not match the expected project.'));
  }
  if (contract.mode === 'wif') {
    validateWif(contract, now, issues);
  }
  return issues;
}

function isWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveContractFile(projectRootArg, fileArg) {
  const requestedRoot = path.resolve(projectRootArg);
  const root = fs.realpathSync(requestedRoot);
  if (!fs.statSync(root).isDirectory()) throw new SafeError('project-root-not-directory', 'Project root must be a directory.');
  const requested = path.resolve(root, fileArg);
  if (!isWithinRoot(requested, root)) {
    throw new SafeError('file-outside-project-root', 'Contract file must be inside project root.');
  }
  const stat = fs.lstatSync(requested);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new SafeError('file-not-regular', 'Contract path must be a regular non-symbolic-link file.');
  }
  const resolved = fs.realpathSync(requested);
  if (!isWithinRoot(resolved, root)) {
    throw new SafeError('file-outside-project-root', 'Contract file must be inside project root.');
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new SafeError('file-too-large', `Contract exceeds ${MAX_FILE_BYTES} bytes.`);
  }
  return { root, file: resolved };
}

function parseArgs(argv, cwd = process.cwd()) {
  const args = { projectRoot: cwd, file: 'sender-auth.json', expectedFirebaseProject: null, now: null, help: false };
  const names = {
    '--project-root': 'projectRoot',
    '--file': 'file',
    '--expected-firebase-project': 'expectedFirebaseProject',
    '--now': 'now',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (!names[arg]) throw new SafeError('unknown-argument', `Unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new SafeError('missing-argument-value', `${arg} requires a value.`);
    }
    args[names[arg]] = value;
    index += 1;
  }
  if (args.now && !Number.isFinite(Date.parse(args.now))) {
    throw new SafeError('invalid-now', '--now must be a valid ISO 8601 timestamp.');
  }
  if (args.expectedFirebaseProject && !FIREBASE_PROJECT_RE.test(args.expectedFirebaseProject)) {
    throw new SafeError('invalid-expected-project', 'Expected Firebase project ID is malformed.');
  }
  return args;
}

function usage() {
  return [
    'Usage: node validate-sender-auth-contract.js [--project-root <path>]',
    '  [--file <project-relative-path>] [--expected-firebase-project <id>]',
    '  [--now <ISO-8601>] ',
    '',
    'Defaults to sender-auth.json in the project root. Emits structured JSON.',
  ].join('\n');
}

function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  try {
    const args = parseArgs(argv, cwd);
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    const resolved = resolveContractFile(args.projectRoot, args.file);
    let contract;
    try {
      contract = JSON.parse(fs.readFileSync(resolved.file, 'utf8'));
    } catch {
      throw new SafeError('invalid-json', 'Contract file is not valid JSON.');
    }
    const issues = validateContract(contract, {
      expectedFirebaseProject: args.expectedFirebaseProject,
      now: args.now ? new Date(args.now) : new Date(),
    });
    const result = {
      status: issues.length === 0 ? 'valid' : 'invalid',
      contract: path.relative(resolved.root, resolved.file).split(path.sep).join('/'),
      version: contract?.version,
      mode: contract?.mode,
      firebaseProjectId: contract?.firebaseProjectId,
      issues,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return issues.length === 0 ? 0 : 2;
  } catch (error) {
    const safe = error instanceof SafeError
      ? error
      : new SafeError('unable-to-validate', 'Unable to validate sender-auth contract.');
    process.stdout.write(`${JSON.stringify({
      status: 'error',
      issues: [issue(safe.code, 'input', safe.message)],
    }, null, 2)}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  CONTRACT_VERSION,
  MAX_PROOF_AGE_MS,
  findForbiddenContent,
  isWithinRoot,
  main,
  parseArgs,
  validateContract,
};
