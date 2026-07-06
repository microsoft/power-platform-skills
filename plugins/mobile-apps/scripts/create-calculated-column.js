#!/usr/bin/env node

// Creates a Dataverse calculated column on a parent table that resolves a value
// from a related entity via an N:1 dotted-path navigation chain.
//
// Companion to /add-dataverse Step 5c and /setup-datamodel Phase 5.
// See `shared/references/data-performance.md` § Cross-entity Reads for the
// runtime constraint that motivates this helper (the SDK has no $expand).
//
// Usage:
//   node create-calculated-column.js <envUrl> \
//     --table <primary_entity_logical_name> \
//     --column <prefix>_<resolved_field>_calc \
//     --type string|datetime|decimal|integer|boolean \
//     --formula "<navigation>.<...>.<resolved_field>" \
//     [--display "Display Name"] \
//     [--solution <solution-unique-name>] \
//     [--formula-xml '<full workflow xml>']
//
// Exit codes:
//   0 — created successfully
//   1 — bad args, auth failure, network failure, or HTTP 4xx/5xx from Dataverse
//
// Output (JSON to stdout, single line):
//   Success: { "status": 204, "table": "...", "column": "...", "type": "..." }
//   Failure: { "status": <code>, "table": "...", "column": "...", "error": "..." }

const { getAuthToken, makeRequest } = require('./lib/validation-helpers');

// ─── arg parsing ────────────────────────────────────────────────────────────

function parseArgs() {
  const argv = process.argv.slice(2);
  if (argv.length < 1 || argv[0].startsWith('--')) {
    usage('envUrl is required as the first positional argument');
  }

  const out = {
    envUrl: argv[0].replace(/\/+$/, ''),
    table: null,
    column: null,
    type: null,
    formula: null,
    formulaXml: null,
    display: null,
    solution: null,
  };

  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case '--table':       out.table = next; i++; break;
      case '--column':      out.column = next; i++; break;
      case '--type':        out.type = (next || '').toLowerCase(); i++; break;
      case '--formula':     out.formula = next; i++; break;
      case '--formula-xml': out.formulaXml = next; i++; break;
      case '--display':     out.display = next; i++; break;
      case '--solution':    out.solution = next; i++; break;
      default:
        usage(`Unknown flag: ${flag}`);
    }
  }

  if (!out.table)   usage('--table is required');
  if (!out.column)  usage('--column is required');
  if (!out.type)    usage('--type is required (string|datetime|decimal|integer|boolean)');
  if (!out.formula && !out.formulaXml) {
    usage('--formula (dotted path) or --formula-xml (full workflow XML) is required');
  }

  if (!/^[a-z0-9_]+$/.test(out.column)) {
    usage(`--column must be lowercase alphanumeric + underscores: got "${out.column}"`);
  }
  if (!/^(string|datetime|decimal|integer|boolean)$/.test(out.type)) {
    usage(`--type must be one of string|datetime|decimal|integer|boolean: got "${out.type}"`);
  }

  // Default display name: strip _calc suffix, title-case the rest
  if (!out.display) {
    const base = out.column.replace(/^[a-z0-9]+_/, '').replace(/_calc$/i, '');
    out.display = base
      .split('_')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ') || out.column;
  }

  return out;
}

function usage(msg) {
  process.stderr.write(`Error: ${msg}\n\n`);
  process.stderr.write(
    'Usage:\n' +
      '  node create-calculated-column.js <envUrl> \\\n' +
      '    --table <table> --column <col> --type string|datetime|decimal|integer|boolean \\\n' +
      '    --formula "<nav.path.field>" [--display "..."] [--solution <name>] [--formula-xml <xml>]\n'
  );
  process.exit(1);
}

// ─── payload construction ───────────────────────────────────────────────────

const TYPE_MAP = {
  string:   { odataType: 'Microsoft.Dynamics.CRM.StringAttributeMetadata',   attrType: 'String',     extra: { MaxLength: 200, FormatName: { Value: 'Text' } } },
  datetime: { odataType: 'Microsoft.Dynamics.CRM.DateTimeAttributeMetadata', attrType: 'DateTime',   extra: { Format: 'DateAndTime', DateTimeBehavior: { Value: 'UserLocal' } } },
  decimal:  { odataType: 'Microsoft.Dynamics.CRM.DecimalAttributeMetadata',  attrType: 'Decimal',    extra: { MinValue: -100000000000, MaxValue: 100000000000, Precision: 2 } },
  integer:  { odataType: 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata',  attrType: 'Integer',    extra: { MinValue: -2147483648, MaxValue: 2147483647, Format: 'None' } },
  boolean:  { odataType: 'Microsoft.Dynamics.CRM.BooleanAttributeMetadata',  attrType: 'Boolean',    extra: {
    DefaultValue: false,
    OptionSet: {
      TrueOption:  { Value: 1, Label: { LocalizedLabels: [{ Label: 'Yes', LanguageCode: 1033 }] } },
      FalseOption: { Value: 0, Label: { LocalizedLabels: [{ Label: 'No',  LanguageCode: 1033 }] } },
    },
  } },
};

// Build the calculated-column payload. SourceType: 1 = Calculated.
function buildPayload({ column, type, display, formulaXml }) {
  const t = TYPE_MAP[type];
  if (!t) throw new Error(`unsupported type: ${type}`);

  // Schema name = column with the publisher prefix kept lowercase but the
  // remainder PascalCase (Dataverse convention for calc columns).
  const schemaName = toSchemaName(column);

  return {
    '@odata.type': t.odataType,
    AttributeType: t.attrType,
    AttributeTypeName: { Value: `${t.attrType}Type` },
    SchemaName: schemaName,
    LogicalName: column,
    DisplayName: { LocalizedLabels: [{ Label: display, LanguageCode: 1033 }] },
    Description: {
      LocalizedLabels: [
        { Label: 'Calculated read-only column auto-derived from screen plan (cross-entity read).', LanguageCode: 1033 },
      ],
    },
    RequiredLevel: { Value: 'None' },
    SourceType: 1,
    SourceTypeMask: 1,
    FormulaDefinition: formulaXml,
    IsValidForCreate: false,
    IsValidForUpdate: false,
    ...t.extra,
  };
}

// Dataverse schema-name convention for calc columns: keep the publisher prefix
// lowercase, PascalCase the remainder, drop any trailing _calc → _calc kept as-is.
function toSchemaName(logical) {
  const m = logical.match(/^([a-z0-9]+)_(.+)$/);
  if (!m) return logical;
  const [, prefix, rest] = m;
  const parts = rest.split('_');
  const pascal = parts
    .map((p, idx) => (idx === parts.length - 1 && p === 'calc' ? 'calc' : p.charAt(0).toUpperCase() + p.slice(1)))
    .join('');
  return `${prefix}_${pascal}`;
}

// ─── formula → workflow XML ─────────────────────────────────────────────────
//
// Dataverse calculated-column formulas are stored as workflow-style XML, NOT as
// a plain dotted-path string. v0 of this helper supports the most common shape:
// an N:1 navigation chain that ends in a primitive read.
//
// For complex formulas (conditionals, arithmetic, string concat), the caller
// MUST pass the full workflow XML via --formula-xml and skip the dotted-path
// translation.
//
// Reference: the canonical workflow XML produced by the maker portal for a
// simple lookup-field calc column. We emit a minimal-but-valid variant.

function dottedPathToWorkflowXml({ table, column, formula, type }) {
  const t = TYPE_MAP[type];
  if (!t) throw new Error(`unsupported type for formula synthesis: ${type}`);
  const segments = formula.split('.').map((s) => s.trim()).filter(Boolean);
  if (segments.length < 2) {
    throw new Error(
      `--formula must traverse at least one navigation hop. Got "${formula}". ` +
        'For a non-related field, use a regular (non-calc) column.'
    );
  }
  // Last segment = target attribute; everything before = navigation chain.
  const targetAttr = segments[segments.length - 1];
  const navChain = segments.slice(0, -1);

  // Build the GetEntityProperty chain in reverse: innermost reads from the
  // first hop's related entity, outermost wraps the final target attribute.
  // Dataverse's calculated-column engine accepts a flat single-Read activity
  // for an N-hop chain by referencing the dotted attribute name directly on
  // the first navigation property — this is the "shortcut" form supported on
  // modern envs. Older orgs may require a nested Read tree; we emit the flat
  // form first and surface a 400 with a clear message if it's rejected.

  const dottedTail = navChain.length === 1
    ? targetAttr
    : `${navChain.slice(1).join('.')}.${targetAttr}`;

  // XML-escape attribute values
  const xe = (s) => String(s).replace(/[<>&"']/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  }[c]));

  return [
    '<?xml version="1.0" encoding="utf-16"?>',
    '<Workflow ',
    '  xmlns:mxsw="clr-namespace:Microsoft.Xrm.Sdk.Workflow;assembly=Microsoft.Xrm.Sdk.Workflow" ',
    '  xmlns:s="http://schemas.microsoft.com/winfx/2006/xaml" ',
    '  xmlns="http://schemas.microsoft.com/winfx/2006/xaml/workflow">',
    '  <mxsw:GetEntityProperty.Target>',
    `    <s:Reference>${xe(`${table}.${navChain[0]}`)}</s:Reference>`,
    '  </mxsw:GetEntityProperty.Target>',
    `  <mxsw:GetEntityProperty Attribute="${xe(dottedTail)}" EntityName="${xe(navChain[0])}" TargetType="${xe(t.attrType)}" />`,
    '  <mxsw:SetEntityProperty.Target>',
    `    <s:Reference>${xe(table)}</s:Reference>`,
    '  </mxsw:SetEntityProperty.Target>',
    `  <mxsw:SetEntityProperty Attribute="${xe(column)}" EntityName="${xe(table)}" TargetType="${xe(t.attrType)}" />`,
    '</Workflow>',
  ].join('\n');
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

async function postAttribute({ envUrl, table, payload, token, solution }) {
  const url = `${envUrl}/api/data/v9.2/EntityDefinitions(LogicalName='${encodeURIComponent(table)}')/Attributes`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (solution) headers['MSCRM.SolutionUniqueName'] = solution;

  const res = await makeRequest({
    url,
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    includeHeaders: true,
    timeout: 30000,
  });
  return res;
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  let token = await getAuthToken(args.envUrl);
  if (!token) {
    process.stderr.write('Failed to get Azure CLI token. Run `az login` first.\n');
    process.exit(1);
  }

  let formulaXml;
  try {
    formulaXml = args.formulaXml
      ? args.formulaXml
      : dottedPathToWorkflowXml({
          table: args.table,
          column: args.column,
          formula: args.formula,
          type: args.type,
        });
  } catch (e) {
    console.log(JSON.stringify({
      status: 0,
      table: args.table,
      column: args.column,
      error: `formula synthesis failed: ${e.message}`,
    }));
    process.exit(1);
  }

  const payload = buildPayload({
    column: args.column,
    type: args.type,
    display: args.display,
    formulaXml,
  });

  // Up to 3 attempts on 401 (token refresh) or 429 (rate-limit backoff).
  let lastRes = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await postAttribute({
      envUrl: args.envUrl,
      table: args.table,
      payload,
      token,
      solution: args.solution,
    });
    lastRes = res;

    if (res.error) {
      // Network-level failure — retry once
      if (attempt < 2) continue;
      break;
    }

    // Treat 2xx as success (POST to /Attributes returns 204 No Content normally)
    if (res.statusCode >= 200 && res.statusCode < 300) {
      console.log(JSON.stringify({
        status: res.statusCode,
        table: args.table,
        column: args.column,
        type: args.type,
        display: args.display,
        solution: args.solution || null,
      }));
      process.exit(0);
    }

    // Token refresh on 401
    if (res.statusCode === 401 && attempt < 2) {
      const fresh = await getAuthToken(args.envUrl);
      if (!fresh) break;
      // mutate token via closure for next iteration
      // (simpler than rewriting the loop body)
      // eslint-disable-next-line no-func-assign, no-unused-vars
      // re-assign by shadowing
      // Note: token is const above; re-bind via a let variable here.
      // Restart loop with fresh token.
      // Using a small inline trampoline to keep the change minimal.
      return retryWithFreshToken(args, fresh, formulaXml);
    }

    // 429 backoff (15s)
    if (res.statusCode === 429 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 15000));
      continue;
    }

    // Other 4xx/5xx — don't retry, surface error
    break;
  }

  // Failure path
  let errMsg = lastRes?.error || `HTTP ${lastRes?.statusCode}`;
  if (lastRes?.body) {
    try {
      const parsed = JSON.parse(lastRes.body);
      const dvErr = parsed?.error?.message;
      if (dvErr) errMsg = `${errMsg}: ${dvErr}`;
    } catch {
      errMsg = `${errMsg}: ${lastRes.body.slice(0, 500)}`;
    }
  }
  console.log(JSON.stringify({
    status: lastRes?.statusCode || 0,
    table: args.table,
    column: args.column,
    error: errMsg,
  }));
  process.exit(1);
}

// Token-refresh trampoline — replays the POST once with a fresh token.
async function retryWithFreshToken(args, freshToken, formulaXml) {
  const payload = buildPayload({
    column: args.column,
    type: args.type,
    display: args.display,
    formulaXml,
  });
  const res = await postAttribute({
    envUrl: args.envUrl,
    table: args.table,
    payload,
    token: freshToken,
    solution: args.solution,
  });

  if (res.statusCode >= 200 && res.statusCode < 300) {
    console.log(JSON.stringify({
      status: res.statusCode,
      table: args.table,
      column: args.column,
      type: args.type,
      display: args.display,
      solution: args.solution || null,
    }));
    process.exit(0);
  }

  let errMsg = res.error || `HTTP ${res.statusCode}`;
  if (res.body) {
    try {
      const parsed = JSON.parse(res.body);
      const dvErr = parsed?.error?.message;
      if (dvErr) errMsg = `${errMsg}: ${dvErr}`;
    } catch {
      errMsg = `${errMsg}: ${res.body.slice(0, 500)}`;
    }
  }
  console.log(JSON.stringify({
    status: res.statusCode || 0,
    table: args.table,
    column: args.column,
    error: errMsg,
  }));
  process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`Unhandled error: ${e.stack || e.message}\n`);
  process.exit(1);
});
