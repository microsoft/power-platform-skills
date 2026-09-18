'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  bindContractToPlan, buildManifest, contractApprovalContent, normalizedContract, reconciliationScope, sha256, stableJson,
} = require('../../build-dataverse-operation-manifest');
const { createReconciliationSnapshot } = require('../../create-dataverse-snapshot');

function write(root, relative, content) {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), content);
}

async function approvedSchema(root, context, request) {
  const now = new Date().toISOString();
  const schema = normalizedContract({
    schemaVersion: 1, publisherPrefix: 'new',
    tables: [{
      logicalName: 'new_item', schemaName: 'new_item', displayName: 'Item', displayCollectionName: 'Items',
      plannedDecision: 'create', dependencyTier: 0, serviceRequired: true, ownershipType: 'UserOwned',
      columns: [{
        logicalName: 'new_name', schemaName: 'new_name', displayName: 'Name', type: 'string',
        plannedDecision: 'create', primaryName: true, requiredLevel: 'ApplicationRequired', maxLength: 200,
      }],
      relationships: [], alternateKeys: [],
    }],
  });
  const planBytes = Buffer.from('# Approved connected fixture\n');
  const approvedContract = contractApprovalContent(schema);
  const hash = sha256(stableJson(approvedContract));
  const approvalReceipt = {
    schemaVersion: 1, workflow: 'create-mobile-app',
    approvals: {
      dataModel: { status: 'approved', approvedAt: now, approvedContractSha256: hash },
      nativeCapabilities: { status: 'approved', approvedAt: now },
      connectors: { status: 'approved', approvedAt: now },
      screenPlan: { status: 'approved', approvedAt: now },
    },
    approvedPlanSha256: sha256(planBytes), approvedContractSha256: hash, approvedContract,
    serviceRequiredTables: [{ logicalName: 'new_item', consumers: ['screen:home'] }],
  };
  approvalReceipt.integritySha256 = sha256(stableJson(approvalReceipt));
  const contract = bindContractToPlan(schema, planBytes, approvalReceipt);
  const scope = reconciliationScope(contract);
  const reconciliation = await createReconciliationSnapshot({
    environmentUrl: context.environmentUrl, tenantId: context.tenantId,
    tableNames: scope.exactTables, proposedTableNames: scope.proposedTables,
    request: request || (async () => ({ status: 200, data: { value: [] } })),
  });
  const contractBytes = Buffer.from(stableJson(contract));
  const reconciliationBytes = Buffer.from(stableJson(reconciliation));
  const manifest = buildManifest({
    contract, contractBytes, planBytes, approvalReceipt, reconciliation, reconciliationBytes, context, now,
  });
  for (const [relative, bytes] of [
    ['native-app-plan.md', planBytes], ['.tmp/dataverse-schema-contract.json', stableJson(schema)],
    ['.tmp/dataverse-execution-contract.json', contractBytes], ['.tmp/mobile-plan-status.json', stableJson(approvalReceipt)],
    ['.tmp/dataverse-execution-reconciliation.json', reconciliationBytes], ['.tmp/dataverse-operation-manifest.json', stableJson(manifest)],
  ]) write(root, relative, bytes);
  return manifest;
}

module.exports = { approvedSchema, write };
