'use strict';

const fs = require('node:fs');
const { readDescriptor } = require('./mobile-authoring-context');
const { createClient } = require('./mobile-authoring-transport');
const { atomicWrite, canonicalJson, digest, exists, inside, readFile, readJson } = require('./mobile-authoring-files');

const DISCOVERY_ARTIFACT = '.tmp/dataverse-discovery-target.json';
const SCHEMA_ARTIFACTS = [
  '.tmp/dataverse-schema-contract.json', '.tmp/dataverse-execution-contract.json',
  '.tmp/dataverse-operation-manifest.json', '.tmp/dataverse-execution-reconciliation.json', 'native-app-plan.md',
];
const REMOTE_JOURNAL = '.tmp/prototype-dataverse-remote-journal.json';
const PUBLISH_CHECKPOINT = '.tmp/dataverse-publish-pending.json';
const MAX_BYTES = 32 * 1024 * 1024;

function brokerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function officialPath(relative) {
  return relative === 'power.config.json' || relative === REMOTE_JOURNAL
    || /^(?:\.power\/schemas|src\/generated)\/[A-Za-z0-9_./-]+\.(?:json|ts)$/.test(relative);
}

function safeOutput(value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_BYTES
    || /\bBearer\s+[A-Za-z0-9._~+/=-]+|\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i.test(text)
    || /\\?["'](?:accessToken|access_token|refreshToken|refresh_token|clientSecret|client_secret|authorization)\\?["']\s*:/i.test(text)) {
    throw brokerError('unsafe-broker-output', 'The trusted broker returned an unsafe response.');
  }
}

function applyBrokerArtifacts(root, result) {
  safeOutput(result);
  const artifacts = result.artifacts || [];
  const remove = result.remove || [];
  if (!Array.isArray(artifacts) || artifacts.length > 512 || !Array.isArray(remove)
    || remove.some((relative) => relative !== PUBLISH_CHECKPOINT)
    || new Set(artifacts.map((entry) => entry.path)).size !== artifacts.length) {
    throw brokerError('invalid-broker-output', 'The broker returned an invalid official artifact set.');
  }
  const saved = new Map();
  for (const entry of artifacts) {
    if (!officialPath(entry.path) || typeof entry.content !== 'string' || digest(entry.content) !== entry.sha256
      || Object.keys(entry).some((key) => !['path', 'content', 'sha256', 'previousSha256'].includes(key))) {
      throw brokerError('invalid-broker-output', 'Only verified official artifacts and the remote journal may be installed.');
    }
    const before = exists(root, entry.path) ? readFile(inside(root, entry.path), MAX_BYTES) : null;
    if (entry.path !== REMOTE_JOURNAL && (before ? digest(before) : null) !== entry.previousSha256) {
      throw brokerError('stale-broker-output', 'An official artifact changed while the broker was working. Preserve the candidate and retry from a fresh approval.');
    }
    saved.set(entry.path, before);
  }
  for (const relative of remove) {
    saved.set(relative, exists(root, relative) ? readFile(inside(root, relative), MAX_BYTES) : null);
  }
  try {
    const precedingJournal = saved.get(REMOTE_JOURNAL);
    if (precedingJournal) {
      const history = `.tmp/prototype-dataverse-remote-history/${digest(precedingJournal)}.json`;
      if (!exists(root, history)) atomicWrite(root, history, precedingJournal, { bytes: true, exclusive: true });
    }
    for (const entry of artifacts) atomicWrite(root, entry.path, entry.content, { bytes: true });
    for (const relative of remove) if (exists(root, relative)) fs.unlinkSync(inside(root, relative));
  } catch (error) {
    // A local installation failure must not erase remote evidence. Preserve the
    // new journal even while rolling back generated source/configuration.
    for (const [relative, bytes] of saved) {
      if (relative === REMOTE_JOURNAL) continue;
      if (bytes === null) { if (exists(root, relative)) fs.unlinkSync(inside(root, relative)); }
      else atomicWrite(root, relative, bytes, { bytes: true });
    }
    throw error;
  }
}

class PlayerDataverse {
  constructor(client) {
    this.client = client;
    this.root = client.descriptor.workspaceDir;
    if (client.descriptor.operation !== 'connect') throw brokerError('wrong-operation', 'Only an explicit Player conversion may use Dataverse desktop execution.');
    this.discoveryPromise = null;
    this.schemaPromise = null;
  }

  async discovery(target) {
    if (this.discoveryPromise) return this.discoveryPromise;
    this.discoveryPromise = (async () => {
      await this.client.verify({ refresh: true });
      const { appInstanceId, jobId, attemptId } = this.client.descriptor;
      const value = { schemaVersion: 1, appInstanceId, jobId, attemptId, target };
      if (exists(this.root, DISCOVERY_ARTIFACT)) {
        const stored = readJson(this.root, DISCOVERY_ARTIFACT);
        if (canonicalJson(stored) !== canonicalJson(value)) {
          if (stored.schemaVersion === 1 && stored.appInstanceId === appInstanceId && stored.target === target
            && (stored.jobId !== jobId || stored.attemptId !== attemptId)) {
            // A retry must obtain new attempt-bound consent, without erasing
            // the prior question/decision journals or remote execution evidence.
            atomicWrite(this.root, DISCOVERY_ARTIFACT, value);
          } else throw brokerError('discovery-target-changed', 'The Player discovery target changed. Start a separately approved environment selection.');
        }
      } else atomicWrite(this.root, DISCOVERY_ARTIFACT, value);
      const approved = await this.client.requestQuestion({
        gateId: 'dataverse-discovery', kind: 'clarification', title: 'Allow read-only desktop Dataverse discovery?',
        summary: 'Use your existing desktop CLI sign-in for setup discovery of this selected environment and its bounded schema, solution and publisher metadata. No business records or remote writes are allowed.',
        items: [String(target),
          'Credentials remain on the trusted desktop; no account switching or automatic sign-in.',
          'Desktop setup is separate from the app’s existing native Microsoft sign-in. Neither sign-in nor this approval Applies a candidate or authorizes preview record writes.'],
        fields: [],
      }, { bind: [DISCOVERY_ARTIFACT] });
      if (approved.receipt.action !== 'approve') throw brokerError('discovery-not-approved', 'Desktop discovery was not approved.');
      return approved;
    })();
    return this.discoveryPromise;
  }

  async request(input) {
    const result = await this.client.dataverse(input);
    safeOutput(result);
    if (result.artifacts || result.remove) {
      await this.client.verify({ refresh: true });
      applyBrokerArtifacts(this.root, result);
    }
    if (result.ok === false) {
      const state = result.state === 'sign-in-required' ? 'sign-in-required' : 'dataverse-execution-failed';
      throw brokerError(state, state === 'sign-in-required'
        ? 'Desktop sign-in is required. Use the existing mobile skill’s trusted-desktop sign-in flow: `az login` for Dataverse, or `npx power-apps login` for official app commands, then retry. Never paste tokens into chat.'
        : 'Dataverse execution stopped. Preserve the remote journal, reconcile the current schema, and obtain fresh approval before retrying.');
    }
    const { artifacts: _artifacts, remove: _remove, ...publicResult } = result;
    return publicResult;
  }

  async resolveEnvironment(target, options = {}) {
    await this.discovery(target);
    const result = await this.request({ operation: 'resolve-environment', target });
    if (!result.environmentUrl || !result.tenantId) throw brokerError('invalid-environment', 'The desktop broker did not resolve the approved environment.');
    // This is non-secret environment metadata, not a credential cache. The
    // conversion coordinator needs it even before auth.config exists.
    if (!options.noCache) atomicWrite(this.root, '.resolved-environment.json', result);
    return result;
  }

  metadata(environmentUrl, method, apiPath, body = null) {
    if (method !== 'GET' || body !== null) {
      return Promise.reject(brokerError('read-only-broker', 'Use the exact approved operation-manifest executor for schema writes; metadata discovery is GET-only.'));
    }
    // Do not acquire a bearer token or follow nextLink URLs in the runner. The
    // bridge validates every endpoint, select, environment and continuation.
    return this.request({ operation: 'metadata', environmentUrl, method, apiPath });
  }

  async schema(manifest) {
    if (!this.schemaPromise) {
      this.schemaPromise = (async () => {
        const stored = readJson(this.root, '.tmp/dataverse-operation-manifest.json');
        if (canonicalJson(stored) !== canonicalJson(manifest)) throw brokerError('manifest-mismatch', 'Execute only the canonical operation manifest reviewed by the maker.');
        const result = await this.client.requestQuestion({
          gateId: 'dataverse-schema', kind: 'schema', title: 'Execute this exact Dataverse schema?',
          summary: 'Approve only the immutable schema and exact sequential operation manifest. Official connected configuration and services are generated on the trusted desktop. Local Undo cannot undo remote schema changes.',
          items: [
            String(manifest.binding.environmentUrl), `Solution: ${manifest.binding.solutionUniqueName}`,
            ...manifest.execution.phases.map((phase) => `${phase.name}: ${phase.operations.length} operation(s)`),
            'No sample records, media import, deployment or disposable test writes are included.',
            'The conversion skill owns planning, reconciliation and minimal adapter rewiring. Candidate Apply and preview record-write grants remain separate.',
          ],
          fields: [],
        }, { bind: SCHEMA_ARTIFACTS });
        if (result.receipt.action !== 'approve') throw brokerError('schema-not-approved', 'Dataverse schema execution was not approved.');
        return result;
      })();
    }
    return this.schemaPromise;
  }

  async initialize(manifest) {
    await this.schema(manifest);
    return this.request({ operation: 'init', environmentUrl: manifest.binding.environmentUrl });
  }

  async executeManifest(options) {
    await this.schema(options.manifest);
    return this.request({ operation: 'execute-manifest', environmentUrl: options.environmentUrl, manifestHash: options.manifest.integritySha256 });
  }

  async generateServices(options) {
    await this.schema(options.manifest);
    if (!exists(this.root, 'power.config.json')) await this.initialize(options.manifest);
    return this.request({ operation: 'generate-services', environmentUrl: options.environmentUrl, manifestHash: options.manifest.integritySha256 });
  }
}

function playerDataverse(options = {}) {
  if (Object.hasOwn(options, 'playerBroker')) return options.playerBroker;
  const loaded = readDescriptor(options);
  if (!loaded) return null;
  return new PlayerDataverse((options.createPlayerClient || createClient)(options));
}

module.exports = {
  playerDataverse, PlayerDataverse, applyBrokerArtifacts, officialPath,
  DISCOVERY_ARTIFACT, SCHEMA_ARTIFACTS, REMOTE_JOURNAL, PUBLISH_CHECKPOINT,
};
