#!/usr/bin/env node

// Creates a Dataverse custom table (entity) via Web API.
//
// Usage:
//   node create-table.js <envUrl> <schemaName> <displayName> <displayCollectionName>
//     [--description <text>]
//     [--primary-name <"PrimaryNameDisplayLabel">]      (default: "Name")
//     [--primary-name-logical <new_name>]               (default: <prefix>_name)
//     [--primary-name-max-length <n>]                   (default: 100)
//     [--ownership user|organization]                   (default: user)
//     [--has-activities true|false]                     (default: false)
//     [--has-notes true|false]                          (default: false)
//     [--solution <uniqueName>]                         (assigns publisher/solution context)
//
// schemaName MUST include the publisher prefix and PascalCase suffix
// (e.g. "cr69c_Candidate"). The logical name is derived as lowercase.
//
// Output (stdout): { "ok": true, "logicalName": "...", "schemaName": "...", "metadataId": "..." }
// Exit codes: 0 success, 1 failure.

const {
  dataverseRequest,
  ensureOk,
  label,
  requiredLevel,
  parseArgs,
  emitResult,
} = require('./lib/dataverse-auth');

function buildPrimaryNameAttribute(prefix, options) {
  const logical = options['primary-name-logical'] || `${prefix}_name`;
  const schemaName = logical
    .split('_')
    .map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join('_');
  const displayLabel = options['primary-name'] || 'Name';
  const maxLength = Number(options['primary-name-max-length'] || 100);

  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
    AttributeType: 'String',
    AttributeTypeName: { Value: 'StringType' },
    SchemaName: schemaName,
    DisplayName: label(displayLabel),
    Description: label(`Primary name for ${displayLabel}`),
    RequiredLevel: requiredLevel('ApplicationRequired'),
    MaxLength: maxLength,
    FormatName: { Value: 'Text' },
    IsPrimaryName: true,
  };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (positional.length < 4) {
    process.stderr.write(
      'Usage: node create-table.js <envUrl> <schemaName> <displayName> <displayCollectionName> [options]\n'
    );
    process.exit(1);
  }

  const [envUrl, schemaName, displayName, displayCollectionName] = positional;

  const prefixMatch = schemaName.match(/^([a-z][a-z0-9]+)_/i);
  if (!prefixMatch) {
    emitResult(false, new Error(`schemaName "${schemaName}" must include a publisher prefix (e.g. "new_Candidate")`));
  }
  const prefix = prefixMatch[1].toLowerCase();

  const body = {
    '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
    SchemaName: schemaName,
    DisplayName: label(displayName),
    DisplayCollectionName: label(displayCollectionName),
    Description: label(flags.description || displayName),
    OwnershipType: flags.ownership === 'organization' ? 'OrganizationOwned' : 'UserOwned',
    HasActivities: flags['has-activities'] === 'true',
    HasNotes: flags['has-notes'] === 'true',
    IsActivity: false,
    Attributes: [buildPrimaryNameAttribute(prefix, flags)],
  };

  try {
    const res = await dataverseRequest(
      envUrl,
      'POST',
      'EntityDefinitions?$select=LogicalName',
      body,
      {
        includeHeaders: true,
        extraHeaders: flags.solution
          ? { 'MSCRM.SolutionUniqueName': String(flags.solution) }
          : {},
      }
    );
    ensureOk(res, `Create table ${schemaName}`);

    const entityUrl = res.headers && (res.headers['odata-entityid'] || res.headers['OData-EntityId']);
    let metadataId = null;
    if (entityUrl) {
      const m = String(entityUrl).match(/\(([0-9a-f-]{36})\)/i);
      if (m) metadataId = m[1];
    }

    emitResult(true, {
      ok: true,
      schemaName,
      logicalName: schemaName.toLowerCase(),
      metadataId,
    });
  } catch (e) {
    emitResult(false, e);
  }
}

main();
