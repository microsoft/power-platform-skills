#!/usr/bin/env node

// Cross-checks a migration's canonical model (built in analyze Phase 5) against the
// authoritative Dataverse schema snapshot and the EDM source-side reference index.
// This is the deterministic gate that catches the hallucination class the screenshot
// surfaced:
//   - the migration plan whitelisted `faq_body` and `faq_isfeatured` as Web API fields
//   - Dataverse actually exposes `faq_articlebody` (and no `faq_isfeatured` at all)
//   - the plan-written sitesetting then 400'd at runtime
//
// Inputs:
//   --canonicalModel   <path>  — canonical-site-model.json from analyze Phase 5
//   --snapshot         <path>  — dataverse-schema-snapshot.json from snapshot-dataverse-schema.js
//   --edmReferences    <path>  — edm-metadata-references.json from extract-edm-metadata-references.js (optional;
//                                used to surface "plan references a column the SOURCE never used either" hints)
//   --output           <path>  — canonical-model-vs-dataverse.json
//
// Output JSON shape:
//   {
//     "version": 1,
//     "verdict": "ok" | "fail",
//     "findings": [
//       { "severity": "error" | "warning", "kind": "...", "name": "...", "parentTable": "...", "message": "...", "suggestion": "..." }
//     ],
//     "summary": { "errors": <n>, "warnings": <n>, "tablesChecked": <n>, "columnsChecked": <n> }
//   }
//
// Exit codes:
//   0 — verdict: "ok" — no error-severity findings. Warnings may still be present.
//   1 — input load failure / fatal error
//   2 — verdict: "fail" — at least one error-severity finding. The five Phase 8 gates
//       (gate-tables-match-dataverse, gate-webapi-fields-match-dataverse, etc.) treat
//       exit code 2 as a blocker.

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--canonicalModel') args.canonicalModel = argv[++i];
    else if (argv[i] === '--snapshot') args.snapshot = argv[++i];
    else if (argv[i] === '--edmReferences') args.edmReferences = argv[++i];
    else if (argv[i] === '--output') args.output = argv[++i];
  }
  return args;
}

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    throw new Error(`Could not load ${filePath}: ${e.message}`);
  }
}

// Suggest the closest snapshot column name when the model references a column the table
// doesn't have. Levenshtein-ish prefix scoring is sufficient for catching the common
// failure mode (faq_body → faq_articlebody, faq_isfeatured → no suggestion).
function suggestClosest(target, candidates, maxDistance = 4) {
  if (!candidates || !candidates.length) return null;
  let best = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const score = levenshtein(target.toLowerCase(), c.toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore <= maxDistance ? best : null;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  // Two-row rolling matrix — O(min(a,b)) memory.
  let prev = Array(b.length + 1).fill(0).map((_, i) => i);
  let curr = Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

// Pull every column the canonical model claims for a given table. The canonical model
// is intentionally accepting of a handful of shapes here so the same script verifies
// migrations built before/after schema reorgs:
//   - dataverseEntities[table].fields[].logicalName
//   - dataverseEntities[table].webApiFields[]
//   - componentMapping[].dataverseFields[].logicalName
// Returns the union, deduped.
function collectModelColumns(canonicalModel, table) {
  const out = new Set();
  const entities = canonicalModel.dataverseEntities || canonicalModel.tables || {};
  const entityEntry = entities[table];
  if (entityEntry) {
    for (const f of entityEntry.fields || []) {
      if (typeof f === 'string') out.add(f.toLowerCase());
      else if (f && f.logicalName) out.add(String(f.logicalName).toLowerCase());
    }
    for (const f of entityEntry.webApiFields || []) {
      if (typeof f === 'string') out.add(f.toLowerCase());
    }
  }
  // Search componentMapping entries (one per SPA route/component) for column refs tied
  // to this table.
  for (const cm of canonicalModel.componentMapping || canonicalModel.routes || []) {
    const cmTable = (cm.dataverseEntity || cm.entity || cm.table || '').toLowerCase();
    if (cmTable && cmTable !== table.toLowerCase()) continue;
    for (const f of cm.dataverseFields || cm.fields || []) {
      if (typeof f === 'string') out.add(f.toLowerCase());
      else if (f && f.logicalName) out.add(String(f.logicalName).toLowerCase());
    }
  }
  return Array.from(out);
}

function collectModelTables(canonicalModel) {
  const out = new Set();
  const entities = canonicalModel.dataverseEntities || canonicalModel.tables || {};
  for (const key of Object.keys(entities)) out.add(key.toLowerCase());
  for (const cm of canonicalModel.componentMapping || canonicalModel.routes || []) {
    const t = (cm.dataverseEntity || cm.entity || cm.table || '').toLowerCase();
    if (t) out.add(t);
  }
  return Array.from(out);
}

function collectModelRelationships(canonicalModel, table) {
  const out = new Set();
  const entities = canonicalModel.dataverseEntities || canonicalModel.tables || {};
  const entry = entities[table];
  if (entry && Array.isArray(entry.relationships)) {
    for (const r of entry.relationships) {
      if (typeof r === 'string') out.add(r);
      else if (r && r.schemaName) out.add(r.schemaName);
    }
  }
  return Array.from(out);
}

function collectModelLookupTargets(canonicalModel, table) {
  // Map { columnLogicalName: [target1, target2] } the plan declared for each lookup.
  const entry = (canonicalModel.dataverseEntities || canonicalModel.tables || {})[table];
  if (!entry) return {};
  const out = {};
  for (const f of entry.fields || []) {
    if (f && f.attributeType && /lookup|customer|owner/i.test(f.attributeType) && Array.isArray(f.targets)) {
      out[String(f.logicalName).toLowerCase()] = f.targets.map((t) => String(t).toLowerCase());
    }
  }
  return out;
}

function collectModelOptionsetValues(canonicalModel, table) {
  // Map { columnLogicalName: [value1, value2] } the plan claims for each choice column.
  const entry = (canonicalModel.dataverseEntities || canonicalModel.tables || {})[table];
  if (!entry) return {};
  const out = {};
  for (const f of entry.fields || []) {
    if (f && Array.isArray(f.optionsetValues)) {
      out[String(f.logicalName).toLowerCase()] = f.optionsetValues.map((v) =>
        typeof v === 'object' && v ? v.value : v,
      );
    }
  }
  return out;
}

// -- The verification itself --------------------------------------------------

function verify({ canonicalModel, snapshot, edmReferences }) {
  const findings = [];
  const modelTables = collectModelTables(canonicalModel);
  const snapshotTablesByName = new Map(
    (snapshot.allTables || []).map((t) => [t.logicalName.toLowerCase(), t]),
  );
  const snapshotTableNames = Array.from(snapshotTablesByName.keys());
  const snapshotPerTable = snapshot.tables || {};

  let columnsChecked = 0;

  // Tables -------------------------------------------------------------------
  for (const t of modelTables) {
    if (!snapshotTablesByName.has(t)) {
      findings.push({
        severity: 'error',
        kind: 'table',
        name: t,
        message: `Canonical model references table "${t}" but it does not exist in Dataverse.`,
        suggestion: suggestClosest(t, snapshotTableNames),
      });
    }
  }

  // Columns ------------------------------------------------------------------
  for (const t of modelTables) {
    const tableSnap = snapshotPerTable[t];
    if (!tableSnap || !tableSnap.columns) continue; // already flagged above
    const dataverseColumnNames = tableSnap.columns.map((c) => c.logicalName.toLowerCase());
    const modelColumns = collectModelColumns(canonicalModel, t);
    columnsChecked += modelColumns.length;
    for (const col of modelColumns) {
      if (dataverseColumnNames.includes(col)) continue;
      // Hallucinated column. This is the exact bug the screenshot showed (faq_body /
      // faq_isfeatured).
      findings.push({
        severity: 'error',
        kind: 'column',
        name: col,
        parentTable: t,
        message: `Canonical model references column "${col}" on table "${t}", but Dataverse reports no such column.`,
        suggestion: suggestClosest(col, dataverseColumnNames),
      });
    }

    // EDM-source over-permissive whitelist (warning):
    // The model includes a column the Dataverse table HAS, but the source EDM never
    // referenced it from any page/form/template. That's a sign the WebAPI fields
    // whitelist was widened beyond what the source actually used — not a runtime bug,
    // but a security-surface caveat worth flagging.
    if (edmReferences && edmReferences.references && Array.isArray(edmReferences.references.column)) {
      const edmReferencedColumns = new Set(
        edmReferences.references.column.map((r) => r.name.toLowerCase()),
      );
      for (const col of modelColumns) {
        if (!dataverseColumnNames.includes(col)) continue;
        if (edmReferencedColumns.has(col)) continue;
        findings.push({
          severity: 'warning',
          kind: 'column',
          name: col,
          parentTable: t,
          message: `Column "${col}" on "${t}" is included in the SPA Web API whitelist but is never referenced by the source EDM site — consider trimming.`,
        });
      }
    }
  }

  // Relationships ------------------------------------------------------------
  for (const t of modelTables) {
    const tableSnap = snapshotPerTable[t];
    if (!tableSnap || !tableSnap.relationships) continue;
    const allDataverseRelationships = new Set(
      [
        ...(tableSnap.relationships.oneToMany || []).map((r) => r.schemaName),
        ...(tableSnap.relationships.manyToOne || []).map((r) => r.schemaName),
        ...(tableSnap.relationships.manyToMany || []).map((r) => r.schemaName),
      ].map((s) => String(s).toLowerCase()),
    );
    const modelRels = collectModelRelationships(canonicalModel, t);
    for (const r of modelRels) {
      if (allDataverseRelationships.has(r.toLowerCase())) continue;
      findings.push({
        severity: 'error',
        kind: 'relationship',
        name: r,
        parentTable: t,
        message: `Canonical model references relationship "${r}" on "${t}", but Dataverse has no such relationship.`,
        suggestion: suggestClosest(r, Array.from(allDataverseRelationships)),
      });
    }
  }

  // Optionset values --------------------------------------------------------
  for (const t of modelTables) {
    const tableSnap = snapshotPerTable[t];
    if (!tableSnap || !tableSnap.optionsets) continue;
    const planValuesByColumn = collectModelOptionsetValues(canonicalModel, t);
    for (const [column, planValues] of Object.entries(planValuesByColumn)) {
      const snapshotValues = (tableSnap.optionsets[column] || []).map((o) => o.value);
      for (const v of planValues) {
        if (snapshotValues.includes(v)) continue;
        findings.push({
          severity: 'error',
          kind: 'optionset',
          name: String(v),
          parentTable: t,
          parentColumn: column,
          message: `Canonical model references option value "${v}" on choice column "${column}" of "${t}", but Dataverse does not list that value.`,
        });
      }
    }
  }

  // Lookup targets ----------------------------------------------------------
  for (const t of modelTables) {
    const tableSnap = snapshotPerTable[t];
    if (!tableSnap || !tableSnap.lookups) continue;
    const planTargets = collectModelLookupTargets(canonicalModel, t);
    for (const [column, modelTargets] of Object.entries(planTargets)) {
      const dataverseTargets = (tableSnap.lookups[column] || {}).targets || [];
      const dataverseSet = new Set(dataverseTargets.map((s) => String(s).toLowerCase()));
      for (const tgt of modelTargets) {
        if (dataverseSet.has(tgt)) continue;
        findings.push({
          severity: 'error',
          kind: 'lookup-target',
          name: tgt,
          parentTable: t,
          parentColumn: column,
          message: `Canonical model says lookup column "${column}" on "${t}" can point at "${tgt}", but Dataverse only allows: ${Array.from(dataverseSet).join(', ') || '(none)'}.`,
        });
      }
    }
  }

  // Snapshot errors propagate as findings so the canonical model is never accepted on
  // top of a partial / failed snapshot.
  for (const e of snapshot.errors || []) {
    findings.push({
      severity: 'error',
      kind: 'snapshot-error',
      name: e.table || e.scope,
      parentTable: e.table,
      message: `Dataverse snapshot did not capture ${e.scope}${e.table ? ` for "${e.table}"` : ''}: ${e.message}`,
    });
  }

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  return {
    version: 1,
    verdict: errors === 0 ? 'ok' : 'fail',
    findings,
    summary: {
      errors,
      warnings,
      tablesChecked: modelTables.length,
      columnsChecked,
    },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.canonicalModel || !args.snapshot) {
    process.stderr.write(
      'Usage: verify-canonical-model-against-dataverse.js --canonicalModel <path> --snapshot <path> [--edmReferences <path>] [--output <path>]\n',
    );
    process.exit(1);
  }
  let canonicalModel, snapshot, edmReferences;
  try {
    canonicalModel = loadJson(args.canonicalModel);
    snapshot = loadJson(args.snapshot);
    if (args.edmReferences) edmReferences = loadJson(args.edmReferences);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }

  const result = verify({ canonicalModel, snapshot, edmReferences });

  if (args.output) {
    fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
    fs.writeFileSync(args.output, JSON.stringify(result, null, 2));
  }
  process.stdout.write(JSON.stringify(result, null, 2));
  // exit 2 on fail so Phase 8 gates can branch without re-parsing
  process.exit(result.verdict === 'ok' ? 0 : 2);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  verify,
  collectModelTables,
  collectModelColumns,
  suggestClosest,
};
