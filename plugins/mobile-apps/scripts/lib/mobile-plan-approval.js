'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  contractApprovalContent,
  declaredServiceRequiredTableNames,
  sha256,
  stableJson,
  validateApprovalReceipt,
} = require('../build-dataverse-operation-manifest');
const {
  contractRevision,
  sha256Hex,
} = require('./product-experience-contracts');
const { readRegularFile } = require('./authoring-source');
const { htmlCompanionsEnabled } = require('./html-companions');

const APPROVAL_PATH = '.tmp/mobile-plan-status.json';
const PLAN_PATH = 'native-app-plan.md';
const ARTIFACT_PATHS = {
  experience: '.tmp/product-experience-contract.json',
  scope: '.tmp/product-scope-contract.json',
  navigation: '.tmp/navigation-manifest.json',
  architecture: '.tmp/architecture-decisions.json',
  persistence: '.tmp/persistence-contract.json',
  dataModel: '.tmp/dataverse-schema-contract.json',
  journey: '.tmp/workflow-journey-contract.json',
  buildPack: '.tmp/compiled-screen-build-pack.json',
  scenarioFacts: '.tmp/scenario-facts.json',
  dataModelUsage: '.tmp/data-model-usage.json',
  preview: '_plan_preview.html',
};
const PROTOTYPE_ARTIFACT_PATHS = {
  prototypeDomain: '.tmp/prototype-domain.json',
  prototypeBindings: '.tmp/prototype-bindings.json',
  prototypeRules: '.tmp/prototype-rules.json',
};
const DESIGN_ARTIFACT_PATHS = {
  designSystem: 'brand/design-system.md',
  designTokens: 'brand/tokens.ts',
  signatureComponents: 'brand/signature-components.ts',
  designContract: '.tmp/product-experience-final-preview-contract.json',
};
const GATE_SECTIONS = {
  1: [
    'App Requirements',
    'Product Experience',
    'Product Scope',
    'Native Capabilities',
    'Connectors',
    'Persistence',
  ],
  2: ['Data Model', 'Screens'],
  3: ['Design', 'Screens'],
  4: [],
};

function resolveInsideProject(projectRoot, relativePath) {
  const root = path.resolve(projectRoot);
  const file = path.resolve(root, relativePath);
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Approval artifact is outside project root: ${relativePath}`);
  }
  return file;
}

function readJson(projectRoot, relativePath, { required = true } = {}) {
  const file = resolveInsideProject(projectRoot, relativePath);
  if (!fs.existsSync(file)) {
    if (!required) return null;
    throw new Error(`Approval artifact not found: ${relativePath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Approval artifact is not valid JSON: ${relativePath}: ${error.message}`);
  }
}

function readBytes(projectRoot, relativePath, { required = true } = {}) {
  const file = resolveInsideProject(projectRoot, relativePath);
  if (!fs.existsSync(file)) {
    if (!required) return null;
    throw new Error(`Approval artifact not found: ${relativePath}`);
  }
  return fs.readFileSync(file);
}

function atomicWriteJson(projectRoot, relativePath, value) {
  const file = resolveInsideProject(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, stableJson(value), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function planSection(plan, heading) {
  const marker = `## ${heading}`;
  const start = plan.indexOf(marker);
  if (start < 0) throw new Error(`native-app-plan.md is missing ${marker}`);
  const bodyStart = start + marker.length;
  const next = plan.indexOf('\n## ', bodyStart);
  return plan.slice(bodyStart, next < 0 ? plan.length : next).trim();
}

function sectionHashes(plan, headings) {
  return Object.fromEntries(headings.map((heading) => [
    heading,
    sha256(planSection(plan, heading)),
  ]));
}

function artifactRevision(value) {
  if (!value) return null;
  return value.persistenceRevision
    || value.navigationRevision
    || value.scenarioRevision
    || value.usageRevision
    || value.compiledRevision
    || contractRevision(value);
}

function loadArtifacts(projectRoot, { planRequired = true, htmlCompanions = htmlCompanionsEnabled() } = {}) {
  const artifacts = Object.fromEntries(Object.entries(ARTIFACT_PATHS).map(([name, file]) => [
    name,
    name === 'preview'
      ? htmlCompanions ? readBytes(projectRoot, file, { required: false }) : null
      : readJson(projectRoot, file, { required: false }),
  ]));
  artifacts.planBytes = readBytes(projectRoot, PLAN_PATH, { required: planRequired });
  artifacts.plan = artifacts.planBytes ? artifacts.planBytes.toString('utf8') : null;
  return artifacts;
}

function designRevisions(projectRoot) {
  return Object.fromEntries(Object.entries(DESIGN_ARTIFACT_PATHS).map(([name, relative]) => {
    const bytes = readRegularFile(resolveInsideProject(projectRoot, relative));
    if (!bytes.toString('utf8').trim()) throw new Error(`Gate 3 requires materialized ${relative}`);
    return [name, sha256(bytes)];
  }));
}

function assertPresentationCurrent(projectRoot, receipt, artifacts, htmlCompanions) {
  const gate = receipt.gates?.gate3;
  if (gate?.status !== 'approved') return;
  if ((gate.htmlCompanions ?? true) !== htmlCompanions) {
    throw new Error('HTML companion mode changed; reopen Gate 3 and Gate 4');
  }
  if (htmlCompanions && (!artifacts.preview || sha256(artifacts.preview) !== gate.previewSha256)) {
    throw new Error('Gate 3 HTML preview changed and requires reapproval');
  }
  if (!htmlCompanions && stableJson(gate.designRevisions) !== stableJson(designRevisions(projectRoot))) {
    throw new Error('Gate 3 materialized design changed and requires reapproval');
  }
  if (gate.artifactRevisions && stableJson(gate.artifactRevisions) !== stableJson(currentRevisions(artifacts))) {
    throw new Error('Gate 3 canonical design inputs changed and require reapproval');
  }
}

function validatePresentationApprovals(projectRoot, receipt, options = {}) {
  try {
    if (receipt.gates?.gate3?.status !== 'approved') return { valid: true, errors: [] };
    const htmlCompanions = htmlCompanionsEnabled(options.htmlCompanions);
    assertPresentationCurrent(projectRoot, receipt, loadArtifacts(projectRoot, { htmlCompanions }), htmlCompanions);
    return { valid: true, errors: [] };
  } catch (error) { return { valid: false, errors: [error.message] }; }
}

function prototypeRevisions(projectRoot) {
  const entries = Object.entries(PROTOTYPE_ARTIFACT_PATHS).map(([name, relative]) => {
    const file = resolveInsideProject(projectRoot, relative);
    try { return { name, relative, file, stat: fs.lstatSync(file) }; }
    catch (error) {
      if (error.code === 'ENOENT') return { name, relative, file, stat: null };
      throw error;
    }
  });
  const present = entries.filter((entry) => entry.stat !== null);
  if (present.length && present.length !== entries.length) {
    throw new Error('The logical domain review requires its complete domain, bindings, and rules');
  }
  return Object.fromEntries(present.map(({ name, relative, file, stat }) => {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) {
      throw new Error(`Prototype approval requires a bounded regular sidecar: ${relative}`);
    }
    const bytes = readRegularFile(file);
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); }
    catch { throw new Error(`Prototype approval sidecar is not valid JSON: ${relative}`); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) {
      throw new Error(`Prototype approval sidecar requires a schemaVersion 1 object: ${relative}`);
    }
    return [name, sha256Hex(bytes)];
  }));
}

function assertPrototypeGatesCurrent(receipt, current, beforeGate = 5) {
  for (let gate = 2; gate < beforeGate; gate += 1) {
    const record = receipt.gates?.[`gate${gate}`];
    if (record?.status !== 'approved') continue;
    // Bind absence too: adding a local domain after a data gate is a new review.
    if (stableJson(record.prototypeRevisions || {}) !== stableJson(current)) {
      throw new Error(`Gate ${gate} prototype domain, bindings, or rules changed and require reapproval`);
    }
  }
}

function validatePrototypeApprovals(projectRoot, receipt) {
  const approved = [2, 3, 4].some((gate) => receipt.gates?.[`gate${gate}`]?.status === 'approved');
  if (!approved) return { valid: true, errors: [] };
  try {
    assertPrototypeGatesCurrent(receipt, prototypeRevisions(projectRoot));
    return { valid: true, errors: [] };
  } catch (error) {
    return { valid: false, errors: [error.message] };
  }
}

function baseReceipt(existing = null) {
  return existing ? structuredClone(existing) : {
    schemaVersion: 1,
    workflow: 'create-mobile-app',
    receiptState: 'partial',
    approvals: {
      requirements: { status: 'pending' },
      dataModel: { status: 'pending' },
      dataModelUsage: { status: 'pending' },
      scenarioFacts: { status: 'pending' },
      nativeCapabilities: { status: 'pending' },
      connectors: { status: 'pending' },
      screenPlan: { status: 'pending' },
    },
    gates: {
      gate1: { status: 'pending' },
      gate2: { status: 'pending' },
      gate3: { status: 'pending' },
      gate4: { status: 'pending' },
    },
    experience: { status: 'pending' },
    screenPlan: { status: 'pending' },
    implementation: { status: 'pending' },
  };
}

function sealReceipt(receipt) {
  const sealed = structuredClone(receipt);
  delete sealed.integritySha256;
  sealed.integritySha256 = sha256(stableJson(sealed));
  return sealed;
}

function validateIntegrity(receipt) {
  if (!receipt || receipt.schemaVersion !== 1 || receipt.workflow !== 'create-mobile-app') {
    return { valid: false, errors: ['approval receipt identity is invalid'] };
  }
  const unsigned = structuredClone(receipt);
  const integrity = unsigned.integritySha256;
  delete unsigned.integritySha256;
  const expected = sha256(stableJson(unsigned));
  return {
    valid: integrity === expected,
    errors: integrity === expected ? [] : ['approval receipt integrity hash does not match'],
  };
}

function assertGateOrder(receipt, gate) {
  for (let current = 1; current < gate; current += 1) {
    if (receipt.gates?.[`gate${current}`]?.status !== 'approved') {
      throw new Error(`Gate ${current} must be approved before Gate ${gate}`);
    }
  }
}

function assertPriorSectionsCurrent(receipt, artifacts, gate) {
  for (let current = 1; current < gate; current += 1) {
    const stored = receipt.gates?.[`gate${current}`]?.sectionHashes || {};
    if (Object.keys(stored).length > 0) {
      const expected = sectionHashes(artifacts.plan, GATE_SECTIONS[current]);
      if (stableJson(stored) !== stableJson(expected)) {
        throw new Error(`Gate ${current} plan sections changed and require reapproval`);
      }
      continue;
    }
    const storedRevisions = receipt.gates?.[`gate${current}`]?.artifactRevisions || {};
    for (const [name, revision] of Object.entries(storedRevisions)) {
      if (artifactRevision(artifacts[name]) !== revision) {
        throw new Error(`Gate ${current} artifact ${name} changed and requires reapproval`);
      }
    }
  }
}

function architectureSummary(architecture) {
  return {
    nativeCapabilities: (architecture?.nativeCapabilities || [])
      .filter((item) => item.approved === true)
      .map((item) => item.displayName || item.id),
    connectors: (architecture?.connectors || [])
      .filter((item) => item.approved === true)
      .map((item) => item.displayName || item.apiName),
  };
}

function dependencyConsumers(usage, requestedLogicalName) {
  const table = (usage?.tables || []).find((item) => (
    String(item.tableLogicalName).toLowerCase() === String(requestedLogicalName).toLowerCase()
  ));
  return [...new Set((table?.consumers || []).map((consumer) => (
    `${consumer.kind}:${consumer.id}`
  )))].sort();
}

function serviceDependencies(contract, usage) {
  const effectiveToRequested = new Map(contract.tables.map((table) => [
    table.plannedDecision === 'adapt' ? table.adaptedLogicalName : table.logicalName,
    table.logicalName,
  ]));
  const relationships = new Map();
  for (const table of contract.tables) {
    for (const relationship of table.relationships || []) {
      if (relationship.kind !== 'many-to-many' || !relationship.serviceRequired) continue;
      const effective = relationship.plannedDecision === 'adapt'
        ? relationship.adaptedIntersectTable
        : relationship.intersectTable;
      relationships.set(effective, { table: table.logicalName, schemaName: relationship.schemaName });
    }
  }
  return declaredServiceRequiredTableNames(contract).map((logicalName) => {
    const requested = effectiveToRequested.get(logicalName);
    let consumers = requested ? dependencyConsumers(usage, requested) : [];
    if (!requested && relationships.has(logicalName)) {
      const relationship = relationships.get(logicalName);
      const table = (usage?.tables || []).find((item) => (
        String(item.tableLogicalName).toLowerCase() === relationship.table
      ));
      const usageRelationship = (table?.relationships || []).find((item) => (
        String(item.schemaName).toLowerCase() === relationship.schemaName.toLowerCase()
      ));
      consumers = [...new Set((usageRelationship?.consumers || []).map((consumer) => (
        `${consumer.kind}:${consumer.id}`
      )))].sort();
    }
    if (consumers.length === 0) {
      throw new Error(`Service-required table ${logicalName} has no compiled usage consumer`);
    }
    return { logicalName, consumers };
  });
}

function currentRevisions(artifacts) {
  return Object.fromEntries(Object.entries(artifacts)
    .filter(([name, value]) => !['plan', 'planBytes', 'preview'].includes(name) && value)
    .map(([name, value]) => [name, artifactRevision(value)]));
}

function approveGate(projectRoot, gate, options = {}) {
  const numericGate = Number(gate);
  if (![1, 2, 3, 4].includes(numericGate)) throw new Error('gate must be 1, 2, 3, or 4');
  const htmlCompanions = htmlCompanionsEnabled(options.htmlCompanions);
  const artifacts = loadArtifacts(projectRoot, { planRequired: numericGate > 1, htmlCompanions });
  const existing = readJson(projectRoot, APPROVAL_PATH, { required: false });
  if (existing) {
    const integrity = validateIntegrity(existing);
    if (!integrity.valid) throw new Error(integrity.errors.join('; '));
  }
  const receipt = baseReceipt(numericGate === 3 && existing?.gates?.gate4?.status === 'approved'
    ? invalidateApprovalReceipt(existing, { fromGate: 4, now: options.now, reason: 'design-reapproved' }) : existing);
  assertGateOrder(receipt, numericGate);
  assertPriorSectionsCurrent(receipt, artifacts, numericGate);
  if (numericGate === 4) assertPresentationCurrent(projectRoot, receipt, artifacts, htmlCompanions);
  const localRevisions = numericGate > 1 ? prototypeRevisions(projectRoot) : null;
  if (localRevisions) assertPrototypeGatesCurrent(receipt, localRevisions, numericGate);
  const approvedAt = options.now || new Date().toISOString();
  const gateRecord = {
    status: 'approved',
    approvedAt,
    ...(localRevisions && Object.keys(localRevisions).length ? { prototypeRevisions: localRevisions } : {}),
    ...(artifacts.planBytes ? {
      planSha256: sha256(artifacts.planBytes),
      sectionHashes: sectionHashes(artifacts.plan, GATE_SECTIONS[numericGate]),
    } : { sectionHashes: {} }),
  };

  if (numericGate === 1) {
    for (const required of ['experience', 'scope', 'navigation', 'architecture', 'persistence']) {
      if (!artifacts[required]) throw new Error(`Gate 1 requires ${ARTIFACT_PATHS[required]}`);
    }
    receipt.approvals.requirements = { status: 'approved', approvedAt };
    receipt.approvals.nativeCapabilities = { status: 'approved', approvedAt };
    receipt.approvals.connectors = { status: 'approved', approvedAt };
    receipt.architectureSummary = architectureSummary(artifacts.architecture);
    gateRecord.artifactRevisions = Object.fromEntries([
      'experience',
      'scope',
      'navigation',
      'architecture',
      'persistence',
    ].map((name) => [name, artifactRevision(artifacts[name])]));
  } else if (numericGate === 2) {
    for (const required of ['journey', 'buildPack', 'scenarioFacts', 'dataModelUsage']) {
      if (!artifacts[required]) throw new Error(`Gate 2 requires ${ARTIFACT_PATHS[required]}`);
    }
    const dataverseMode = ['dataverse', 'mixed'].includes(artifacts.persistence?.mode);
    if (dataverseMode && !artifacts.dataModel) {
      throw new Error(`Gate 2 requires ${ARTIFACT_PATHS.dataModel}`);
    }
    receipt.approvals.dataModel = dataverseMode ? {
      status: 'approved',
      approvedAt,
      approvedContractSha256: sha256(stableJson(contractApprovalContent(artifacts.dataModel))),
    } : { status: 'not-applicable', approvedAt };
    receipt.approvals.dataModelUsage = { status: 'approved', approvedAt };
    receipt.approvals.scenarioFacts = { status: 'approved', approvedAt };
  } else if (numericGate === 3) {
    if (!artifacts.buildPack || (htmlCompanions && !artifacts.preview)) {
      throw new Error(`Gate 3 requires the compiled build pack${htmlCompanions ? ' and _plan_preview.html' : ''}`);
    }
    receipt.approvals.screenPlan = { status: 'approved', approvedAt };
    receipt.experience = { status: 'approved', approvedAt };
    receipt.screenPlan = { status: 'approved', approvedAt };
    gateRecord.htmlCompanions = htmlCompanions;
    gateRecord.artifactRevisions = currentRevisions(artifacts);
    if (htmlCompanions) gateRecord.previewSha256 = sha256(artifacts.preview);
    else gateRecord.designRevisions = designRevisions(projectRoot);
  } else {
    receipt.implementation = { status: 'approved', approvedAt };
    receipt.receiptState = 'complete';
    receipt.approvedPlanSha256 = sha256(artifacts.planBytes);
    if (artifacts.dataModel) {
      receipt.approvedContract = contractApprovalContent(artifacts.dataModel);
      receipt.approvedContractSha256 = sha256(stableJson(receipt.approvedContract));
      receipt.serviceRequiredTables = serviceDependencies(
        artifacts.dataModel,
        artifacts.dataModelUsage,
      );
      receipt.approvals.dataModel.approvedContractSha256 = receipt.approvedContractSha256;
    }
  }

  receipt.gates[`gate${numericGate}`] = gateRecord;
  if (artifacts.planBytes) receipt.currentPlanSha256 = sha256(artifacts.planBytes);
  receipt.artifactRevisions = { ...currentRevisions(artifacts), ...(localRevisions || {}) };
  const sealed = sealReceipt(receipt);
  if (numericGate === 4 && artifacts.dataModel) {
    const validation = validateApprovalReceipt(sealed, {
      contract: artifacts.dataModel,
      planBytes: artifacts.planBytes,
    });
    if (!validation.valid) {
      throw new Error(`Final approval receipt is invalid: ${validation.errors.join('; ')}`);
    }
  }
  atomicWriteJson(projectRoot, APPROVAL_PATH, sealed);
  return sealed;
}

function invalidateApprovalReceipt(receipt, nowOrOptions = {}) {
  if (!receipt) return null;
  const options = typeof nowOrOptions === 'string'
    ? { now: nowOrOptions, fromGate: 2, reason: 'data-model-edited' }
    : nowOrOptions;
  const fromGate = Number(options.fromGate || 2);
  if (![1, 2, 3, 4].includes(fromGate)) throw new Error('fromGate must be 1, 2, 3, or 4');
  const now = options.now || new Date().toISOString();
  const reason = options.reason || 'approved-artifact-changed';
  const next = structuredClone(receipt);
  const defaults = baseReceipt();
  next.gates = { ...defaults.gates, ...(next.gates || {}) };
  next.approvals = { ...defaults.approvals, ...(next.approvals || {}) };
  for (let gate = fromGate; gate <= 4; gate += 1) {
    next.gates[`gate${gate}`] = {
      status: 'pending',
      invalidatedAt: now,
      invalidationReason: reason,
    };
  }
  const pending = (key) => {
    next[key] = { status: 'pending', invalidatedAt: now, invalidationReason: reason };
  };
  const pendingApproval = (key) => {
    next.approvals[key] = { status: 'pending', invalidatedAt: now, invalidationReason: reason };
  };
  if (fromGate <= 1) {
    for (const key of ['requirements', 'nativeCapabilities', 'connectors']) pendingApproval(key);
    delete next.architectureSummary;
  }
  if (fromGate <= 2) {
    for (const key of ['dataModel', 'dataModelUsage', 'scenarioFacts']) pendingApproval(key);
  }
  if (fromGate <= 3) {
    pendingApproval('screenPlan');
    pending('experience');
    pending('screenPlan');
  }
  pending('implementation');
  next.receiptState = 'partial';
  delete next.approvedPlanSha256;
  delete next.approvedContractSha256;
  delete next.approvedContract;
  delete next.serviceRequiredTables;
  delete next.integritySha256;
  next.invalidatedAt = now;
  next.invalidationReason = reason;
  return sealReceipt(next);
}

module.exports = {
  APPROVAL_PATH,
  ARTIFACT_PATHS,
  PROTOTYPE_ARTIFACT_PATHS,
  DESIGN_ARTIFACT_PATHS,
  GATE_SECTIONS,
  approveGate,
  invalidateApprovalReceipt,
  planSection,
  sealReceipt,
  serviceDependencies,
  validateIntegrity,
  validatePrototypeApprovals,
  validatePresentationApprovals,
};