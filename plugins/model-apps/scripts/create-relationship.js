#!/usr/bin/env node

// Creates a Dataverse relationship via Web API.
//   POST /RelationshipDefinitions with the full metadata payload
//   - 1:N (lookup): @odata.type = OneToManyRelationshipMetadata + embedded Lookup attribute
//   - N:N (many-to-many): @odata.type = ManyToManyRelationshipMetadata
//
// Usage (1:N / lookup):
//   node create-relationship.js 1n <envUrl> <schemaName> <referencedTable> <referencingTable>
//     <lookupSchemaName> <lookupDisplayName>
//     [--lookup-required None|Recommended|ApplicationRequired]   (default: None)
//     [--cascade-delete Cascade|RemoveLink|Restrict|NoCascade]   (default: RemoveLink)
//     [--cascade-assign Cascade|NoCascade]                       (default: NoCascade)
//     [--cascade-share  Cascade|NoCascade]                       (default: NoCascade)
//     [--cascade-unshare Cascade|NoCascade]                      (default: NoCascade)
//     [--cascade-reparent Cascade|NoCascade]                     (default: NoCascade)
//     [--solution <uniqueName>]
//
// Usage (N:N):
//   node create-relationship.js nn <envUrl> <schemaName> <entity1> <entity2>
//     [--intersect <name>]      (default: <schemaName>)
//     [--solution <uniqueName>]
//
// schemaName MUST include a publisher prefix (e.g. "cr69c_candidate_cr69c_skill").
//
// Output: { "ok": true, "kind": "1n"|"nn", "schemaName": "...", "metadataId": "..." }

const {
  dataverseRequest,
  ensureOk,
  label,
  requiredLevel,
  parseArgs,
  emitResult,
} = require('./lib/dataverse-auth');

// Relationships are created by POSTing the full metadata to /RelationshipDefinitions.
// For 1:N the body must include an embedded `Lookup` attribute (LookupAttributeMetadata)
// describing the lookup column that will be created on the referencing table.
function build1NPayload(args, flags) {
  const [schemaName, referencedTable, referencingTable, lookupSchemaName, lookupDisplayName] = args;
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata',
    SchemaName: schemaName,
    ReferencedEntity: referencedTable,
    ReferencingEntity: referencingTable,
    AssociatedMenuConfiguration: {
      Behavior: 'UseCollectionName',
      Group: 'Details',
      Label: label(lookupDisplayName),
      Order: 10000,
    },
    CascadeConfiguration: {
      Assign: flags['cascade-assign'] || 'NoCascade',
      Share: flags['cascade-share'] || 'NoCascade',
      Unshare: flags['cascade-unshare'] || 'NoCascade',
      Reparent: flags['cascade-reparent'] || 'NoCascade',
      Delete: flags['cascade-delete'] || 'RemoveLink',
      Merge: 'NoCascade',
    },
    Lookup: {
      '@odata.type': 'Microsoft.Dynamics.CRM.LookupAttributeMetadata',
      AttributeType: 'Lookup',
      AttributeTypeName: { Value: 'LookupType' },
      SchemaName: lookupSchemaName,
      DisplayName: label(lookupDisplayName),
      Description: label(`Lookup to ${referencedTable}`),
      RequiredLevel: requiredLevel(flags['lookup-required'] || 'None'),
    },
  };
}

function buildNNPayload(args, flags) {
  const [schemaName, entity1, entity2] = args;
  const intersectName = flags.intersect || schemaName.toLowerCase();
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata',
    SchemaName: schemaName,
    Entity1LogicalName: entity1,
    Entity2LogicalName: entity2,
    Entity1AssociatedMenuConfiguration: {
      Behavior: 'UseCollectionName',
      Group: 'Details',
      Order: 10000,
    },
    Entity2AssociatedMenuConfiguration: {
      Behavior: 'UseCollectionName',
      Group: 'Details',
      Order: 10000,
    },
    IntersectEntityName: intersectName,
  };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (positional.length < 2) {
    process.stderr.write(
      'Usage:\n' +
      '  node create-relationship.js 1n <envUrl> <schemaName> <referencedTable> <referencingTable> <lookupSchemaName> <lookupDisplayName> [options]\n' +
      '  node create-relationship.js nn <envUrl> <schemaName> <entity1> <entity2> [options]\n'
    );
    process.exit(1);
  }
  const kind = positional[0];
  const envUrl = positional[1];
  const args = positional.slice(2);

  let body, schemaName;
  if (kind === '1n') {
    if (args.length < 5) {
      emitResult(false, new Error('1n requires: schemaName referencedTable referencingTable lookupSchemaName lookupDisplayName'));
      return;
    }
    body = build1NPayload(args, flags);
    schemaName = args[0];
  } else if (kind === 'nn') {
    if (args.length < 3) {
      emitResult(false, new Error('nn requires: schemaName entity1 entity2'));
      return;
    }
    body = buildNNPayload(args, flags);
    schemaName = args[0];
  } else {
    emitResult(false, new Error(`Unknown relationship kind: ${kind} (use "1n" or "nn")`));
    return;
  }

  try {
    const res = await dataverseRequest(envUrl, 'POST', 'RelationshipDefinitions', body, {
      includeHeaders: true,
      extraHeaders: flags.solution
        ? { 'MSCRM.SolutionUniqueName': String(flags.solution) }
        : {},
    });
    ensureOk(res, `Create ${kind} relationship ${schemaName}`);

    const entityUrl = res.headers && (res.headers['odata-entityid'] || res.headers['OData-EntityId']);
    let metadataId = null;
    if (entityUrl) {
      const m = String(entityUrl).match(/\(([0-9a-f-]{36})\)/i);
      if (m) metadataId = m[1];
    }
    emitResult(true, {
      ok: true,
      kind,
      schemaName,
      metadataId,
    });
  } catch (e) {
    emitResult(false, e);
  }
}

main();
