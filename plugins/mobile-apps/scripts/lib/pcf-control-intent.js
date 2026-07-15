'use strict';

const crypto = require('node:crypto');

const PCF_DISPOSITIONS = Object.freeze([
  'native-replacement',
  'server-dependency',
  'explicit-unsupported',
  'blocker',
]);

const REVIEW_ROLES = new Set([
  'component-review',
  'pcf-review',
  'repeating-records-review',
]);

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function unique(values) {
  return [...new Set(toArray(values).filter(Boolean))];
}

function normalizedDispositionSignal(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
}

function summarizeDependencies(value) {
  return toArray(value).map((dependency) => ({
    kind: dependency && dependency.kind || null,
    name: dependency && dependency.name || null,
    operation: dependency && dependency.operation || null,
    connectionRequirementId: dependency && dependency.connectionRequirementId || null,
  }));
}

/**
 * Keep the builder projection compact and raw-free. PCF target strategies can
 * be edited at Gate 2b, so copy only the allowlisted execution contract rather
 * than arbitrary user/source fields into every screen shard.
 */
function summarizeTargetStrategy(value) {
  if (!value || typeof value !== 'object') return null;
  const summary = {
    type: value.type || null,
    primitive: value.primitive || null,
    uiPrimitive: value.uiPrimitive || null,
    capability: value.capability || null,
    implementationOwner: value.implementationOwner || null,
    packages: toArray(value.packages).filter((entry) => typeof entry === 'string'),
    preserves: toArray(value.preserves).filter((entry) => typeof entry === 'string'),
    dependencies: summarizeDependencies(value.dependencies),
  };
  if (value.nativeSupport && typeof value.nativeSupport === 'object') {
    summary.nativeSupport = summarizeTargetStrategy(value.nativeSupport);
  }
  return summary;
}

function approvedPcfSemanticRole(pcfRow) {
  const approval = pcfRow && pcfRow.approval || {};
  if (approval.status === 'blocked' || approval.disposition === 'blocker') return 'pcf-blocker';
  if (approval.status !== 'approved') return 'pcf-review';
  if (approval.disposition === 'server-dependency') return 'pcf-server-backed';
  if (approval.disposition === 'explicit-unsupported') return 'pcf-optional-unsupported';
  if (approval.disposition === 'native-replacement') {
    const target = approval.targetStrategy || {};
    // Add-native and navigation-owned replacements are known platform
    // capabilities. A screen-owned primitive is still a native rebuild even
    // when the adapter recognized its shape.
    if (target.capability
        || ['add-native', 'navigation-orchestrator'].includes(target.implementationOwner)) {
      return 'pcf-known-capability';
    }
    return 'pcf-native-rebuild';
  }
  return 'pcf-review';
}

function pcfSupportForRole(role) {
  return ({
    'pcf-known-capability': 'approved-native-capability',
    'pcf-native-rebuild': 'approved-native-replacement',
    'pcf-server-backed': 'approved-server-dependency',
    'pcf-optional-unsupported': 'approved-visible-unsupported',
    'pcf-blocker': 'blocked',
    'pcf-review': 'explicit-pcf-approval-required',
  })[role] || 'explicit-pcf-approval-required';
}

function pcfSuggestionForRole(role, pcfRow) {
  const approval = pcfRow && pcfRow.approval || {};
  const proposal = pcfRow && pcfRow.proposal || {};
  const target = approval.status === 'approved' ? approval.targetStrategy : proposal.targetStrategy;
  const primitive = target && (target.primitive || target.uiPrimitive);
  if (role === 'pcf-blocker') return 'hard blocker until Gate 2b supplies a supported strategy';
  if (role === 'pcf-optional-unsupported') return 'render the exact user-approved visible unavailable state';
  if (approval.status !== 'approved') {
    return `Gate 2b approval required${proposal.disposition ? `; proposed ${proposal.disposition}` : ''}`;
  }
  return primitive || 'implement the exact approved PCF target strategy';
}

function publicContractSummary(pcfRow) {
  const contract = pcfRow && pcfRow.sourceContract || {};
  return {
    propertyNames: Object.keys(contract.properties || {}).sort(),
    eventNames: unique(contract.events).sort(),
    dataBindings: unique(contract.dataBindings).sort(),
  };
}

function projectedPcfContract(pcfRow, role) {
  const approval = pcfRow && pcfRow.approval || {};
  const proposal = pcfRow && pcfRow.proposal || {};
  const approved = approval.status === 'approved';
  return {
    pcfId: pcfRow.pcfId,
    templateName: pcfRow.templateName || null,
    isPremium: !!pcfRow.isPremium,
    approvalStatus: approval.status || 'pending',
    authority: approved ? 'user-approval' : (approval.status === 'blocked' ? 'blocked-gate' : 'gate-required'),
    disposition: approved || approval.status === 'blocked' ? approval.disposition || null : null,
    proposedDisposition: proposal.disposition || null,
    essentiality: approved ? approval.essentiality || null : pcfRow.essentiality?.level || null,
    semanticRole: role,
    publicContract: publicContractSummary(pcfRow),
    proposal: {
      disposition: proposal.disposition || null,
      targetStrategy: summarizeTargetStrategy(proposal.targetStrategy),
    },
    approvedTargetStrategy: approved ? summarizeTargetStrategy(approval.targetStrategy) : null,
    unsupportedUx: approved && approval.disposition === 'explicit-unsupported'
      ? approval.unsupportedUx || null
      : null,
    approvalReason: approved || approval.status === 'blocked' ? approval.reason || null : null,
  };
}

function pcfMatchKey(value) {
  return JSON.stringify([
    value && value.screen || null,
    value && value.path || null,
    value && value.control || null,
  ]);
}

function pcfSourceInventorySha256(controls) {
  const inventory = toArray(controls).map((row) => ({
    pcfId: row && row.pcfId || null,
    screen: row && row.screen || null,
    control: row && row.control || null,
    path: row && row.path || null,
    templateName: row && row.templateName || null,
    isPremium: !!(row && row.isPremium),
    publicContract: publicContractSummary(row),
    dependencies: summarizeDependencies(row && row.dependencies),
  })).sort((a, b) =>
    String(a.screen).localeCompare(String(b.screen))
    || String(a.path).localeCompare(String(b.path))
    || String(a.pcfId).localeCompare(String(b.pcfId)));
  return crypto.createHash('sha256').update(JSON.stringify(inventory)).digest('hex');
}

function recomputeRoleStats(coverage) {
  const rows = toArray(coverage && coverage.rows);
  const byRole = new Map();
  const pcfByRole = new Map();
  let semanticReviewControls = 0;
  for (const row of rows) {
    const role = row && row.role || 'unknown';
    byRole.set(role, (byRole.get(role) || 0) + 1);
    if (row?.flags?.isPcf) pcfByRole.set(role, (pcfByRole.get(role) || 0) + 1);
    if (REVIEW_ROLES.has(role)) semanticReviewControls += 1;
  }
  coverage.stats = {
    ...(coverage.stats || {}),
    totalControls: rows.length,
    semanticReviewControls,
    byRole: Object.fromEntries([...byRole.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    pcfByRole: Object.fromEntries([...pcfByRole.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
  };
  return coverage;
}

/**
 * Project the authoritative Gate 2b state into the one-row-per-control ledger.
 * This function is deliberately idempotent: all approval-derived fields are
 * overwritten, so resetting imported approvals cannot leave a stale approved
 * role hidden in a builder shard.
 */
function projectPcfControlIntents(coverage, pcfPlan) {
  const projected = deepClone(coverage || {});
  const controls = toArray(pcfPlan && pcfPlan.controls);
  const inventorySha256 = pcfSourceInventorySha256(controls);
  if (projected.pcfProjection?.sourceInventorySha256
      && projected.pcfProjection.sourceInventorySha256 !== inventorySha256) {
    throw new Error('PCF plan and control-intent coverage come from different source inventories');
  }
  if (projected.generatedAt && pcfPlan?.generatedAt && projected.generatedAt !== pcfPlan.generatedAt) {
    throw new Error(`PCF plan timestamp ${pcfPlan.generatedAt} does not match control-intent coverage timestamp ${projected.generatedAt}`);
  }
  const byKey = new Map();
  for (const pcfRow of controls) {
    const key = pcfMatchKey(pcfRow);
    if (byKey.has(key)) throw new Error(`duplicate PCF plan row for ${pcfRow.screen}/${pcfRow.path || pcfRow.control}`);
    byKey.set(key, pcfRow);
  }

  const matched = new Set();
  for (const row of toArray(projected.rows)) {
    if (!row?.flags?.isPcf) continue;
    const key = pcfMatchKey(row);
    const pcfRow = byKey.get(key);
    if (!pcfRow) throw new Error(`PCF control-intent row has no disposition plan: ${row.screen}/${row.path || row.control}`);
    matched.add(key);
    const role = approvedPcfSemanticRole(pcfRow);
    const approvalStatus = pcfRow.approval?.status || 'pending';
    row.role = role;
    row.support = pcfSupportForRole(role);
    row.businessRisk = 'high';
    row.uiFreedom = role === 'pcf-blocker'
      ? 'blocked'
      : (approvalStatus === 'approved' ? 'approved-strategy-only' : 'gate-approval-required');
    row.nativeSuggestion = pcfSuggestionForRole(role, pcfRow);
    row.roleEvidence = {
      classifier: 'pcf-disposition-v1',
      confidence: approvalStatus === 'approved' ? 'authoritative' : (approvalStatus === 'blocked' ? 'blocked' : 'review'),
      signals: unique([
        `PCF_${String(approvalStatus).toUpperCase()}`,
        pcfRow.proposal?.disposition
          ? `PROPOSED_${normalizedDispositionSignal(pcfRow.proposal.disposition)}`
          : null,
        approvalStatus !== 'pending' && pcfRow.approval?.disposition
          ? `DECIDED_${normalizedDispositionSignal(pcfRow.approval.disposition)}`
          : null,
      ]),
    };
    row.pcf = projectedPcfContract(pcfRow, role);
    row.notesForAI = approvalStatus === 'approved'
      ? 'The projected PCF disposition is user-approved and binding. Implement only this strategy and preserve the compact public contract.'
      : (approvalStatus === 'blocked'
        ? 'This PCF is blocked. Do not generate the affected app path.'
        : 'Gate 2b is unresolved. Do not implement the adapter proposal as though it were approved.');
    row.flags = {
      ...(row.flags || {}),
      isPcf: true,
      requiresSemanticReview: role === 'pcf-review' || role === 'pcf-blocker',
    };
  }

  for (const [key, pcfRow] of byKey) {
    if (!matched.has(key)) throw new Error(`PCF disposition plan has no matching control-intent row: ${pcfRow.screen}/${pcfRow.path || pcfRow.control}`);
  }
  projected.pcfProjection = {
    plan: 'pcf-plan.json',
    schema: pcfPlan && pcfPlan.$schema || null,
    generatedAt: pcfPlan && pcfPlan.generatedAt || null,
    sourceInventorySha256: inventorySha256,
    totalControls: controls.length,
    discoveryComplete: pcfPlan?.discovery?.complete === true,
  };
  return recomputeRoleStats(projected);
}

function derivePcfStats(pcfPlan) {
  const controls = toArray(pcfPlan && pcfPlan.controls);
  const byDisposition = Object.fromEntries(PCF_DISPOSITIONS.map((disposition) => [
    disposition,
    controls.filter((row) => row?.approval?.disposition === disposition).length,
  ]));
  const proposed = Object.fromEntries(PCF_DISPOSITIONS.map((disposition) => [
    disposition,
    controls.filter((row) => row?.proposal?.disposition === disposition).length,
  ]));
  return {
    ...(pcfPlan && pcfPlan.stats || {}),
    total: controls.length,
    discoveryComplete: pcfPlan?.discovery?.complete === true,
    pendingApproval: controls.filter((row) => row?.approval?.status === 'pending').length,
    approved: controls.filter((row) => row?.approval?.status === 'approved').length,
    blocked: controls.filter((row) => row?.approval?.status === 'blocked').length,
    byDisposition,
    proposed,
  };
}

module.exports = {
  PCF_DISPOSITIONS,
  REVIEW_ROLES,
  approvedPcfSemanticRole,
  derivePcfStats,
  pcfSourceInventorySha256,
  projectPcfControlIntents,
  recomputeRoleStats,
  summarizeTargetStrategy,
};
