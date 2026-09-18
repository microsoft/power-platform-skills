'use strict';

const fs = require('node:fs');
const { inside, assertRevision, revision, atomicWrite } = require('./prototype-files');
const { canonicalJson, sha256Hex } = require('./product-experience-contracts');
const { readRegularFile } = require('./authoring-source');
const { validateDomain } = require('./prototype-domain');
const { validateRules, generateRulesRuntime } = require('./authoring-rules');

const RULES_FILE = 'src/data/rules.ts';
const PERMISSION_FILE = 'src/data/test-write-permission.json';
const REGISTRY_FILE = '.tmp/data-access-registry.json';
const MANIFEST_FILE = '.tmp/prototype-generated.json';
const CONTRACT_FILE = '.tmp/prototype-rules.json';
const CONNECTOR_STATE = '.tmp/prototype-connector-startup.json';
const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

function compileRulesPlan(root, proposedRules, { planning = false } = {}) {
  const inputs = new Map();
  const bytes = (relative) => {
    if (!inputs.has(relative)) {
      const file = inside(root, relative);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) {
        throw new Error(`Rules compiler requires a bounded regular file: ${relative}`);
      }
      inputs.set(relative, readRegularFile(file));
    }
    return inputs.get(relative);
  };
  const json = (relative) => JSON.parse(bytes(relative).toString('utf8'));
  const domain = validateDomain(json('.tmp/prototype-domain.json'));
  const originalContract = json(CONTRACT_FILE);
  const contract = planning ? structuredClone(proposedRules) : originalContract;
  const rules = validateRules(domain, contract);
  const registry = json(REGISTRY_FILE);
  const manifest = json(MANIFEST_FILE);
  if (registry.schemaVersion !== 1 || registry.contractType !== 'data-access-registry'
    || !['local-prototype', 'connected'].includes(registry.mode)
    || manifest.schemaVersion !== 1 || !manifest.files?.[RULES_FILE]) {
    throw new Error('Rules-only refresh requires an existing app-owned registry and rules runtime');
  }
  assertRevision(registry, 'registryRevision', 'Data-access registry');
  const persistence = json('.tmp/persistence-contract.json');
  const facts = json('.tmp/scenario-facts.json');
  assertRevision(persistence, 'persistenceRevision', 'Persistence contract');
  assertRevision(facts, 'scenarioRevision', 'Scenario facts');
  const stable = {
    domain: revision(domain),
    bindings: revision(json('.tmp/prototype-bindings.json')),
    persistence: persistence.persistenceRevision,
    scenario: facts.scenarioRevision,
  };
  if (registry.mode === 'connected') {
    const mapping = json('.tmp/prototype-dataverse-mapping.json');
    assertRevision(mapping, 'mappingRevision', 'Dataverse mapping');
    stable.mapping = mapping.mappingRevision;
    if (registry.mappingRevision !== stable.mapping) throw new Error('Rules-only refresh cannot change the connected mapping');
  }
  for (const [name, expected] of Object.entries(stable)) {
    if (registry.inputRevisions?.[name] !== expected
      || (manifest.inputRevisions?.[name] !== undefined && manifest.inputRevisions[name] !== expected)) {
      throw new Error(`Rules-only refresh cannot change ${name}; use its owning approved workflow`);
    }
  }
  if (manifest.inputRevisions?.domain !== stable.domain) throw new Error('Rules runtime belongs to another domain');
  if (planning) {
    const originalRules = validateRules(domain, originalContract);
    const originalRevision = revision(registry.mode === 'local-prototype' ? originalRules : originalContract);
    if (manifest.inputRevisions.rules !== originalRevision || registry.inputRevisions.rules !== originalRevision) {
      throw new Error('Rules planning requires the unchanged current canonical rules and owned metadata');
    }
  }
  const rulesRevision = revision(registry.mode === 'local-prototype' ? rules : contract);
  if (fs.existsSync(inside(root, CONNECTOR_STATE))) {
    const startup = assertRevision(json(CONNECTOR_STATE), 'startupRevision', 'Connector startup');
    if (startup.inputRevisions?.rules !== rulesRevision) {
      throw new Error('Rules-only refresh would require a retained connector startup write; use its separately approved owning workflow');
    }
  }
  const files = { [RULES_FILE]: generateRulesRuntime(domain, rules) };
  if (manifest.files[PERMISSION_FILE] || fs.existsSync(inside(root, PERMISSION_FILE))) {
    if (!manifest.files[PERMISSION_FILE]) throw new Error('Test-write permission is not compiler-owned');
    files[PERMISSION_FILE] = 'null\n';
  }
  for (const [relative, expectedHash] of Object.entries(manifest.files)) {
    if (!relative.startsWith('src/data/') || relative.includes('\\')
      || relative.split('/').some((part) => !part || part === '.' || part === '..')
      || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('Invalid app-owned rules manifest');
    const actual = sha256Hex(bytes(relative));
    const output = files[relative];
    // Exact new compiler output is allowed so an interrupted rules write can resume.
    if (actual !== expectedHash && (planning || output === undefined || actual !== sha256Hex(output))) {
      throw new Error(`Rules-only refresh found unrelated app-owned drift: ${relative}`);
    }
  }
  const inputRevisions = { ...manifest.inputRevisions, rules: rulesRevision };
  const updatedRegistry = { ...registry, inputRevisions: { ...registry.inputRevisions, rules: rulesRevision } };
  delete updatedRegistry.registryRevision;
  updatedRegistry.registryRevision = revision(updatedRegistry);
  const updatedManifest = {
    schemaVersion: 1, inputRevisions,
    files: { ...manifest.files, ...Object.fromEntries(Object.entries(files).map(([file, content]) => [file, sha256Hex(content)])) },
  };
  const outputs = {
    [CONTRACT_FILE]: serialize(JSON.parse(canonicalJson(contract))),
    ...files,
    [MANIFEST_FILE]: serialize(updatedManifest),
    [REGISTRY_FILE]: serialize(updatedRegistry),
  };
  const effects = Object.entries(outputs).map(([file, content]) => ({
    path: file, beforeSha256: sha256Hex(bytes(file)), afterSha256: sha256Hex(content), content,
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const boundInputs = [...inputs].map(([file, content]) => ({ path: file, sha256: sha256Hex(content) }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  for (const input of boundInputs) {
    if (sha256Hex(readRegularFile(inside(root, input.path))) !== input.sha256) {
      throw new Error(`Rules compiler input changed during planning: ${input.path}`);
    }
  }
  const plan = {
    schemaVersion: 1, operation: 'prototype-rules',
    rulesRevision, registryRevision: updatedRegistry.registryRevision, inputs: boundInputs, effects,
  };
  return { ...plan, planRevision: revision(plan) };
}

function planPrototypeRules(root, options = {}) {
  if (!Object.hasOwn(options, 'rules')) throw new Error('Rules planning requires the proposed rules contract');
  return compileRulesPlan(root, options.rules, { planning: true });
}

function generatePrototypeRules(root, { check = false } = {}) {
  const plan = compileRulesPlan(root);
  const byPath = new Map(plan.effects.map((effect) => [effect.path, effect]));
  const order = [RULES_FILE, ...(byPath.has(PERMISSION_FILE) ? [PERMISSION_FILE] : []), MANIFEST_FILE, REGISTRY_FILE];
  if (check) {
    if (order.some((file) => byPath.get(file).beforeSha256 !== byPath.get(file).afterSha256)) {
      throw new Error('Rules-only generated artifacts are stale');
    }
    return { ok: true, check: true, rulesRevision: plan.rulesRevision, registryRevision: plan.registryRevision, files: [] };
  }
  for (const file of order) atomicWrite(root, file, byPath.get(file).content);
  return {
    ok: true, rulesRevision: plan.rulesRevision, registryRevision: plan.registryRevision,
    files: order, testWritePermissionRevoked: byPath.has(PERMISSION_FILE), recordsChanged: false, remoteEffects: false,
  };
}

module.exports = { planPrototypeRules, generatePrototypeRules, refreshPrototypeRules: generatePrototypeRules };
