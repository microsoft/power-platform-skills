'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const protocol = require('./authoring-protocol');
const { digest, plainDirectory, within, readFile, readJson } = require('./mobile-authoring-files');

const PROTOCOL_FILE = path.join(__dirname, 'authoring-protocol.js');

function protocolHash() {
  return digest(readFile(PROTOCOL_FILE));
}

function bridgeOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid authoring bridge origin'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash
    || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) {
    throw new Error('The runner requires a loopback bridge origin without credentials or URL data');
  }
  return url.origin;
}

function publicKey(value) {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('-----BEGIN PUBLIC KEY-----')) {
    throw new Error('The authoring descriptor requires a public decision key');
  }
  let key;
  try { key = crypto.createPublicKey(value); } catch { throw new Error('Invalid authoring decision public key'); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 authoring decisions are required');
  return key;
}

function readDescriptor({ env = process.env, projectRoot, cwd = process.cwd() } = {}) {
  const descriptorFile = env.MOBILE_AUTHORING_CONTEXT;
  if (!descriptorFile) {
    if (env.MOBILE_AUTHORING_RUNNER_TOKEN) throw new Error('Runner credentials require an authoring descriptor');
    return null;
  }
  if (typeof descriptorFile !== 'string' || !path.isAbsolute(descriptorFile)) {
    throw new Error('MOBILE_AUTHORING_CONTEXT must identify a bridge-owned descriptor');
  }
  plainDirectory(path.dirname(descriptorFile));
  const stat = fs.lstatSync(descriptorFile);
  if (stat.mode & 0o222) throw new Error('The authoring descriptor must not be runner-writable');
  let value;
  try { value = JSON.parse(readFile(descriptorFile, 32 * 1024).toString('utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('Invalid authoring descriptor JSON');
    throw error;
  }
  protocol.object(value, 'authoring descriptor');
  if (value.protocolVersion !== protocol.PROTOCOL_VERSION || value.protocolHash !== protocolHash()) {
    throw new Error('Authoring protocol identity does not match the installed skills');
  }
  if (typeof value.workspaceDir !== 'string' || !path.isAbsolute(value.workspaceDir)) {
    throw new Error('The authoring descriptor requires an absolute candidate workspace');
  }
  const workspaceDir = plainDirectory(value.workspaceDir);
  if (workspaceDir !== value.workspaceDir || within(workspaceDir, descriptorFile)) {
    throw new Error('The bridge descriptor must be outside the candidate workspace');
  }
  if ((projectRoot && plainDirectory(projectRoot) !== workspaceDir) || !within(workspaceDir, plainDirectory(cwd))) {
    throw new Error('The authoring descriptor does not match the selected project');
  }
  const operation = protocol.enumeration(value.operation, protocol.OPERATIONS, 'descriptor.operation');
  const descriptor = {
    protocolVersion: protocol.PROTOCOL_VERSION,
    protocolHash: value.protocolHash,
    bridgeUrl: bridgeOrigin(value.bridgeUrl),
    appInstanceId: protocol.id(value.appInstanceId, 'descriptor.appInstanceId'),
    jobId: protocol.id(value.jobId, 'descriptor.jobId'),
    attemptId: protocol.id(value.attemptId, 'descriptor.attemptId'),
    operation,
    baseRevision: protocol.revision(value.baseRevision, 'descriptor.baseRevision', operation === 'prototype'),
    workspaceDir,
    decisionPublicKey: publicKey(value.decisionPublicKey).export({ format: 'pem', type: 'spki' }).toString(),
  };
  if (value.context !== undefined && value.contextFile !== undefined) {
    throw new Error('The descriptor must not provide conflicting context sources');
  }
  if (value.context !== undefined) descriptor.context = validateContext(value.context, descriptor);
  if (value.contextFile !== undefined) {
    descriptor.context = validateContext(readJson(workspaceDir, value.contextFile), descriptor);
  }
  if (value.integration !== undefined) {
    if (operation !== 'edit') throw new Error('A catalogue selection requires an explicit edit operation');
    descriptor.integration = protocol.assertIntegrationSelection(value.integration);
  }
  const token = env.MOBILE_AUTHORING_RUNNER_TOKEN;
  if (typeof token !== 'string' || token.length < 24 || token.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(token)) {
    throw new Error('A scoped per-attempt runner credential is required');
  }
  assertNoCredential(value, token);
  assertNoCredential(descriptor, token);
  // Credentials are deliberately absent from the descriptor and from every
  // serializable result. OS runner policy, not file mode alone, protects the
  // issuer file and its containing directory from replacement.
  return { descriptor, token, descriptorFile };
}

function validateContext(value, descriptor) {
  const context = protocol.assertContext(value);
  // Runtime jobId identifies the published preview that supplied this context,
  // not the newly-created edit job. The read-only issuer descriptor carries
  // that association; app identity and exact base preview must still match.
  if (context.appInstanceId !== descriptor.appInstanceId || context.previewRevision !== descriptor.baseRevision) {
    throw new Error('Authoring context is stale or belongs to another app revision');
  }
  const allowed = new Set([
    'protocolVersion', 'appInstanceId', 'jobId', 'previewRevision', 'scope', 'screenId',
    'route', 'targetId', 'actionId', 'label', 'recordRef', 'hasUnsavedChanges',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))
    || (value.recordRef && Object.keys(value.recordRef).some((key) => !['conceptId', 'recordId', 'label'].includes(key)))) {
    throw new Error('Context may contain only registered identity and a minimal record reference');
  }
  return context;
}

function assertNoCredential(value, token) {
  if (JSON.stringify(value).includes(token)) throw new Error('Authoring payload must not contain runner credentials');
}

module.exports = { PROTOCOL_FILE, protocolHash, bridgeOrigin, publicKey, readDescriptor, validateContext, assertNoCredential };
