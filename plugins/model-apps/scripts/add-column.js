#!/usr/bin/env node

// Adds a column (attribute) to an existing Dataverse table via Web API.
// Lookups go through create-relationship.js, not this script.
//
// Usage:
//   node add-column.js <envUrl> <tableLogicalName> <schemaName> <displayName> <type> [options]
//
// type:
//   string    — [--max-length 100] [--format Text|Email|Url|Phone|TickerSymbol]
//   memo      — [--max-length 2000] [--format TextArea|RichText|Email|Url|Phone]
//   integer   — [--min -2147483648] [--max 2147483647] [--format None|Duration|TimeZone|Language]
//   decimal   — [--min ...] [--max ...] [--precision 2]
//   money     — [--min 0] [--max 1000000000000] [--precision 2]
//   datetime  — [--format DateOnly|DateAndTime] [--behavior UserLocal|DateOnly|TimeZoneIndependent]
//   boolean   — [--true-label "Yes"] [--false-label "No"] [--default true|false]
//   picklist  — --options '[{"value":100000000,"label":"Active"}, ...]'  (or @options.json)
//
// Common options:
//   [--description <text>] [--required-level None|Recommended|ApplicationRequired]
//   [--solution <uniqueName>]
//
// Output: { "ok": true, "logicalName": "...", "schemaName": "...", "metadataId": "..." }

const {
  dataverseRequest,
  ensureOk,
  label,
  requiredLevel,
  parseArgs,
  readJsonArg,
  emitResult,
} = require('./lib/dataverse-auth');

function commonFields(schemaName, displayName, flags) {
  return {
    SchemaName: schemaName,
    DisplayName: label(displayName),
    Description: label(flags.description || displayName),
    RequiredLevel: requiredLevel(flags['required-level'] || 'None'),
  };
}

/**
 * Coerces a flag value to a finite number, or throws a useful error.
 * Catches the case where parseArgs treated the next token as boolean=true
 * because it started with --, leaving the user's intended numeric flag with
 * value `true` → Number(true) === 1 silently.
 */
function numericFlag(name, value, fallback) {
  if (value === undefined) return fallback;
  if (value === true || value === false) {
    throw new Error(`--${name} requires a numeric value (got a flag with no argument — check that the next token isn't another --flag)`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`--${name} must be a finite number (got "${value}")`);
  }
  return n;
}

function buildAttribute(type, schemaName, displayName, flags) {
  const common = commonFields(schemaName, displayName, flags);

  switch (type) {
    case 'string':
      return {
        '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
        AttributeType: 'String',
        AttributeTypeName: { Value: 'StringType' },
        MaxLength: numericFlag('max-length', flags['max-length'], 100),
        FormatName: { Value: flags.format || 'Text' },
        ...common,
      };
    case 'memo':
      return {
        '@odata.type': 'Microsoft.Dynamics.CRM.MemoAttributeMetadata',
        AttributeType: 'Memo',
        AttributeTypeName: { Value: 'MemoType' },
        MaxLength: numericFlag('max-length', flags['max-length'], 2000),
        Format: flags.format || 'TextArea',
        ...common,
      };
    case 'integer':
      return {
        '@odata.type': 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata',
        AttributeType: 'Integer',
        AttributeTypeName: { Value: 'IntegerType' },
        Format: flags.format || 'None',
        MinValue: numericFlag('min', flags.min, -2147483648),
        MaxValue: numericFlag('max', flags.max, 2147483647),
        ...common,
      };
    case 'decimal':
      return {
        '@odata.type': 'Microsoft.Dynamics.CRM.DecimalAttributeMetadata',
        AttributeType: 'Decimal',
        AttributeTypeName: { Value: 'DecimalType' },
        Precision: numericFlag('precision', flags.precision, 2),
        MinValue: numericFlag('min', flags.min, -100000000000),
        MaxValue: numericFlag('max', flags.max, 100000000000),
        ...common,
      };
    case 'money':
      return {
        '@odata.type': 'Microsoft.Dynamics.CRM.MoneyAttributeMetadata',
        AttributeType: 'Money',
        AttributeTypeName: { Value: 'MoneyType' },
        PrecisionSource: 2,
        MinValue: numericFlag('min', flags.min, 0),
        MaxValue: numericFlag('max', flags.max, 1000000000000),
        ...common,
      };
    case 'datetime':
      return {
        '@odata.type': 'Microsoft.Dynamics.CRM.DateTimeAttributeMetadata',
        AttributeType: 'DateTime',
        AttributeTypeName: { Value: 'DateTimeType' },
        Format: flags.format || 'DateAndTime',
        DateTimeBehavior: { Value: flags.behavior || 'UserLocal' },
        ...common,
      };
    case 'boolean': {
      const defaultVal = flags.default === 'true';
      return {
        '@odata.type': 'Microsoft.Dynamics.CRM.BooleanAttributeMetadata',
        AttributeType: 'Boolean',
        AttributeTypeName: { Value: 'BooleanType' },
        DefaultValue: defaultVal,
        OptionSet: {
          '@odata.type': 'Microsoft.Dynamics.CRM.BooleanOptionSetMetadata',
          TrueOption: {
            Value: 1,
            Label: label(flags['true-label'] || 'Yes'),
          },
          FalseOption: {
            Value: 0,
            Label: label(flags['false-label'] || 'No'),
          },
        },
        ...common,
      };
    }
    case 'picklist': {
      if (!flags.options) throw new Error('picklist requires --options <json|@path>');
      const optionsArr = readJsonArg(flags.options);
      if (!Array.isArray(optionsArr) || optionsArr.length === 0) {
        throw new Error('--options must be a non-empty JSON array of {value,label}');
      }
      return {
        '@odata.type': 'Microsoft.Dynamics.CRM.PicklistAttributeMetadata',
        AttributeType: 'Picklist',
        AttributeTypeName: { Value: 'PicklistType' },
        OptionSet: {
          '@odata.type': 'Microsoft.Dynamics.CRM.OptionSetMetadata',
          OptionSetType: 'Picklist',
          IsGlobal: false,
          Options: optionsArr.map((o) => ({
            Value: Number(o.value),
            Label: label(String(o.label)),
          })),
        },
        ...common,
      };
    }
    default:
      throw new Error(`Unsupported column type: ${type} (use create-relationship.js for lookups)`);
  }
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (positional.length < 5) {
    process.stderr.write(
      'Usage: node add-column.js <envUrl> <tableLogicalName> <schemaName> <displayName> <type> [options]\n'
    );
    process.exit(1);
  }

  const [envUrl, tableLogicalName, schemaName, displayName, type] = positional;

  let attribute;
  try {
    attribute = buildAttribute(type, schemaName, displayName, flags);
  } catch (e) {
    emitResult(false, e);
    return;
  }

  try {
    const res = await dataverseRequest(
      envUrl,
      'POST',
      `EntityDefinitions(LogicalName='${tableLogicalName}')/Attributes`,
      attribute,
      {
        includeHeaders: true,
        extraHeaders: flags.solution
          ? { 'MSCRM.SolutionUniqueName': String(flags.solution) }
          : {},
      }
    );
    ensureOk(res, `Add column ${schemaName} to ${tableLogicalName}`);

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
