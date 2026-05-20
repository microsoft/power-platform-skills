#!/usr/bin/env node

// Walks a PAC-downloaded EDM website-data root and emits every Dataverse metadata
// reference it can find (tables, columns, relationships, optionset values, lookup
// targets) along with source evidence. The migration-static-analyzer agent calls this
// in analyze Phase 3 so column / table / relationship names land in the canonical
// model from source files — not from agent inference. The verify script then
// cross-references this output against the Dataverse snapshot; any reference in the
// extractor's output that is missing from the snapshot is a finding (typo in the
// source, deprecated column, or — when the agent inferred a name — a hallucination
// that never matched reality).
//
// Source folders observed (see references/pac-edm-structure.md):
//   - lists/                  — entity lists: `entitylogicalname`, `adx_columns`, view-column refs
//   - basic-forms/            — basic forms: `entityname`, form section field refs
//   - advanced-forms/         — multistep forms: step field refs
//   - web-templates/          — Liquid source (FetchXML, `entity.<column>` tokens)
//   - web-pages/              — copy HTML + JS sidecars (same Liquid patterns as templates)
//   - content-snippets/       — usually copy-only but occasionally token Liquid refs
//   - table-permissions/      — table-permission records w/ entitylogicalname + relationships
//
// Usage:
//   node extract-edm-metadata-references.js \
//     --edmRoot ./legacy-site \
//     --output ./migration-artifacts/edm-metadata-references.json
//
// Exit codes:
//   0 — output written
//   1 — fatal error (missing flags, non-readable edmRoot)

const fs = require('fs');
const path = require('path');

// -- Regexes ------------------------------------------------------------------

// PAC YAML uses `<key>: <value>` at the top level (no quoting in the common case). The
// key name we want is the value's identifier; e.g. `entitylogicalname: faq_article`. We
// purposely scan line-by-line rather than importing a YAML parser so the script stays
// dependency-free and resilient to half-broken YAML in real-world exports.
const YAML_VALUE = /^\s*([a-z0-9_]+)\s*:\s*(?:["']?)([^#\n"']+?)(?:["']?)\s*(?:#.*)?$/i;

// Liquid `{{ entity.<columnname> }}` and `{{ <row>.<columnname> }}` patterns. We collect
// any identifier in the second position as a potential column reference — over-collecting
// here is safe because the verify script filters against the authoritative snapshot.
const LIQUID_COLUMN_TOKEN = /\{\{\s*(?:entity|row|item|page|record|user|contact)\.([a-z0-9_]+)\s*[}|]/gi;

// `{% fetchxml %}` blocks declare entity + attribute names inline. Common shapes:
//   <entity name="faq_article">
//   <attribute name="faq_articlebody" />
const FETCHXML_ENTITY = /<entity\s+name=["']([a-z0-9_]+)["']/gi;
const FETCHXML_ATTRIBUTE = /<attribute\s+name=["']([a-z0-9_]+)["']/gi;

// JSON-shaped column lists embedded in `adx_columns:` values:
//   '[{"name":"faq_articletitle"},{"name":"createdon"}]'
const JSON_COLUMN_NAME = /"(?:name|attribute|column|field)"\s*:\s*"([a-z0-9_]+)"/gi;

// Bare comma-delimited column lists (the older shape of `adx_columns:`)
// e.g. `value: faq_articleid,faq_articletitle,faq_articlebody`
const BARE_COLUMN_LIST = /^[a-z0-9_,\s]+$/i;

// -- Evidence + finding model -------------------------------------------------

// Findings are deduped at the (kind, name, parentTable) tuple so the same column
// referenced from N source files reports once with N evidence rows attached.
function findingKey({ kind, name, parentTable, parentColumn }) {
  return [kind, parentTable || '', parentColumn || '', name].join('::').toLowerCase();
}

function makeIndex() {
  return new Map();
}

function recordFinding(index, finding) {
  const key = findingKey(finding);
  const existing = index.get(key);
  if (existing) {
    // Limit evidence to first 5 occurrences per finding — keeps the output JSON small
    // when a column is referenced from dozens of pages/templates. Five is enough to make
    // grep-ability obvious without flooding the artifact.
    if (existing.evidence.length < 5) existing.evidence.push(finding.evidence[0]);
    return;
  }
  index.set(key, finding);
}

function indexValues(index) {
  // Group by kind for downstream readability. Within each kind, sort by parentTable then
  // name so diffs across analyze re-runs are stable.
  const grouped = {};
  for (const finding of index.values()) {
    const k = finding.kind;
    if (!grouped[k]) grouped[k] = [];
    grouped[k].push(finding);
  }
  for (const k of Object.keys(grouped)) {
    grouped[k].sort((a, b) => {
      const aKey = (a.parentTable || '') + a.name;
      const bKey = (b.parentTable || '') + b.name;
      return aKey.localeCompare(bKey);
    });
  }
  return grouped;
}

// -- Walkers ------------------------------------------------------------------

// Recursively yields every regular file under `dir` (depth-first). Returns an empty
// array when `dir` doesn't exist so a missing optional source folder (e.g. no
// advanced-forms/) just produces no findings rather than throwing.
function walkFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

// Reads a file and returns lines + the relative path used for evidence. Mutes I/O errors
// because half-broken PAC exports occasionally contain unreadable binary blobs alongside
// the YAML; we'd rather skip those than fail the whole extraction.
function readLines(filePath, edmRoot) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { lines: content.split(/\r?\n/), content, relativePath: path.relative(edmRoot, filePath) };
  } catch {
    return null;
  }
}

// scanYamlForKeys — pulls every value matching one of the YAML keys we care about. The
// keys are PAC's lowercased field names: `entitylogicalname`, `entityname`, `entity1`,
// `entity2`, `intersectentityname`, etc.
function scanYamlForKeys(lines, relativePath, kindByKey, onMatch) {
  lines.forEach((line, idx) => {
    const m = line.match(YAML_VALUE);
    if (!m) return;
    const key = m[1].toLowerCase();
    if (!(key in kindByKey)) return;
    const value = m[2].trim();
    if (!value) return;
    onMatch({ key, value, line: idx + 1, snippet: line.trim(), relativePath });
  });
}

// scanLiquidPatterns — Liquid in web-templates / web-pages / web-files content tokens.
// Collects FetchXML entity/attribute names and `{{ entity.<col> }}` accessors.
function scanLiquidPatterns(content, relativePath, onTable, onColumn) {
  let match;
  // FetchXML first — these are unambiguous: `<entity name="...">` is always a table,
  // `<attribute name="..."/>` is always a column on the surrounding entity.
  // Re-initialize the regex's lastIndex because /g state persists across calls.
  FETCHXML_ENTITY.lastIndex = 0;
  let currentEntity = null;
  while ((match = FETCHXML_ENTITY.exec(content)) !== null) {
    currentEntity = match[1].toLowerCase();
    onTable({ name: currentEntity, snippet: match[0], relativePath });
  }
  FETCHXML_ATTRIBUTE.lastIndex = 0;
  while ((match = FETCHXML_ATTRIBUTE.exec(content)) !== null) {
    const col = match[1].toLowerCase();
    onColumn({ name: col, parentTable: currentEntity, snippet: match[0], relativePath });
  }
  // Liquid tokens — `entity.<col>` access. parentTable is unknown for these (Liquid
  // doesn't carry the entity name on the token), so we record them with parentTable=null.
  // The verify script tolerates null and reports "column referenced from Liquid in <file>"
  // without trying to bind it to a specific table.
  LIQUID_COLUMN_TOKEN.lastIndex = 0;
  while ((match = LIQUID_COLUMN_TOKEN.exec(content)) !== null) {
    onColumn({ name: match[1].toLowerCase(), parentTable: null, snippet: match[0], relativePath });
  }
}

// -- Main extractor -----------------------------------------------------------

function extractEdmReferences(edmRoot) {
  const findings = makeIndex();

  // Map of key → finding kind. The keys are PAC's canonical YAML field names.
  const tableKeys = {
    entitylogicalname: 'table',
    entityname: 'table',
    entity1: 'table',
    entity2: 'table',
    intersectentityname: 'table',
    targetentityname: 'table',
    'adx_targetentitylogicalname': 'table',
    'adx_entityname': 'table',
  };
  const relationshipKeys = {
    parentrelationship: 'relationship',
    contactrelationship: 'relationship',
    accountrelationship: 'relationship',
    relationship: 'relationship',
    'adx_relationship': 'relationship',
  };
  const columnKeys = {
    // basic-form field-list keys
    primarykey: 'column',
    primaryfield: 'column',
    'adx_primaryfield': 'column',
    'adx_attributelogicalname': 'column',
    attributelogicalname: 'column',
    fieldname: 'column',
  };

  // 1) YAML records under known source folders. Walk each folder once.
  const yamlFolders = [
    'lists',
    'basic-forms',
    'advanced-forms',
    'table-permissions',
    'web-pages',
    'web-templates',
    'content-snippets',
    'sitemarker.yml',
    'sitesetting.yml',
    'webrole.yml',
    'website.yml',
  ];
  for (const rel of yamlFolders) {
    const full = path.join(edmRoot, rel);
    const files = walkFiles(full);
    // Include the root-level YAML files (sitesetting.yml, etc.) when they exist as files
    // not directories.
    if (fs.existsSync(full) && !fs.statSync(full).isDirectory() && full.endsWith('.yml')) {
      files.push(full);
    }
    for (const file of files) {
      if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
      const r = readLines(file, edmRoot);
      if (!r) continue;
      scanYamlForKeys(r.lines, r.relativePath, tableKeys, ({ value, snippet, line, relativePath }) => {
        recordFinding(findings, {
          kind: 'table',
          name: value.toLowerCase(),
          evidence: [{ file: relativePath, line, snippet }],
        });
      });
      scanYamlForKeys(r.lines, r.relativePath, relationshipKeys, ({ value, snippet, line, relativePath }) => {
        recordFinding(findings, {
          kind: 'relationship',
          name: value,
          evidence: [{ file: relativePath, line, snippet }],
        });
      });
      scanYamlForKeys(r.lines, r.relativePath, columnKeys, ({ value, snippet, line, relativePath }) => {
        recordFinding(findings, {
          kind: 'column',
          name: value.toLowerCase(),
          parentTable: null, // column key/value alone doesn't tell us the parent table
          evidence: [{ file: relativePath, line, snippet }],
        });
      });

      // `adx_columns:` carries a column list — either bare comma-separated values or a
      // JSON array of {name,...}. Collect both shapes.
      r.lines.forEach((line, idx) => {
        const m = line.match(/^\s*(adx_columns|adx_attributes|columns|attributes)\s*:\s*(.*)$/i);
        if (!m) return;
        const rawValue = m[2].trim().replace(/^['"]|['"]$/g, '');
        if (!rawValue) return;
        if (rawValue.startsWith('[')) {
          // JSON-array shape — pull every {"name": "<col>"}
          let match;
          JSON_COLUMN_NAME.lastIndex = 0;
          while ((match = JSON_COLUMN_NAME.exec(rawValue)) !== null) {
            recordFinding(findings, {
              kind: 'column',
              name: match[1].toLowerCase(),
              parentTable: null,
              evidence: [{ file: r.relativePath, line: idx + 1, snippet: line.trim() }],
            });
          }
        } else if (BARE_COLUMN_LIST.test(rawValue)) {
          for (const part of rawValue.split(',').map((s) => s.trim()).filter(Boolean)) {
            recordFinding(findings, {
              kind: 'column',
              name: part.toLowerCase(),
              parentTable: null,
              evidence: [{ file: r.relativePath, line: idx + 1, snippet: line.trim() }],
            });
          }
        }
      });
    }
  }

  // 2) Liquid in web-templates / web-pages — sidecars are typically `.html` next to a
  // `.webtemplate.yml` or `.webpage.copy.html` next to `.webpage.yml`. Walk both
  // folders and read every text file looking for FetchXML + Liquid tokens.
  for (const rel of ['web-templates', 'web-pages']) {
    const full = path.join(edmRoot, rel);
    const files = walkFiles(full);
    for (const file of files) {
      if (!/\.(html|js|liquid|txt)$/i.test(file)) continue;
      const r = readLines(file, edmRoot);
      if (!r) continue;
      scanLiquidPatterns(
        r.content,
        r.relativePath,
        ({ name, snippet, relativePath }) => {
          recordFinding(findings, {
            kind: 'table',
            name,
            evidence: [{ file: relativePath, snippet }],
          });
        },
        ({ name, parentTable, snippet, relativePath }) => {
          recordFinding(findings, {
            kind: 'column',
            name,
            parentTable,
            evidence: [{ file: relativePath, snippet }],
          });
        },
      );
    }
  }

  return indexValues(findings);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--edmRoot') args.edmRoot = argv[++i];
    else if (argv[i] === '--output') args.output = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.edmRoot) {
    process.stderr.write('Usage: extract-edm-metadata-references.js --edmRoot <path> --output <path.json>\n');
    process.exit(1);
  }
  if (!fs.existsSync(args.edmRoot)) {
    process.stderr.write(`EDM source root does not exist: ${args.edmRoot}\n`);
    process.exit(1);
  }
  const grouped = extractEdmReferences(args.edmRoot);
  const out = {
    version: 1,
    capturedAt: new Date().toISOString(),
    edmRoot: path.resolve(args.edmRoot),
    references: grouped,
  };
  if (args.output) {
    fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
    fs.writeFileSync(args.output, JSON.stringify(out, null, 2));
    process.stdout.write(JSON.stringify({ ok: true, output: args.output, kinds: Object.keys(grouped) }));
  } else {
    process.stdout.write(JSON.stringify(out, null, 2));
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, extractEdmReferences };
