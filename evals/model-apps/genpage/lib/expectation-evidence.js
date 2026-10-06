'use strict';

// Structured readers for the evidence a /genpage run leaves behind, used by the per-eval Phase
// expectations about discovery, provisioning, schema generation and deployment.
//
// Every reader turns ONE artifact into plain data so a check compares values instead of re-grepping
// prose: commands come from workflowCalls (a contract-2 fixture's ordered tool-results.json, or the
// command lines of a historical workflow-log.md), entity definitions from the plan's
// `## Entity Creation Required`, transactions from genpage-entity-creation-log.md, and choice enums
// from the RuntimeTypes.ts that `pac model genpage generate-types` wrote from the LIVE schema.
//
// Nothing here executes evidence: command text is tokenized by commandInfo, never evaluated.

const { workflowCalls, isUpload } = require('./workflow-evidence.js');
const { commandInfo, fileName } = require('./evidence-utils.js');
const { planSection, parseMarkdownRows } = require('./plan-evidence.js');

const PAC = String.raw`\bpac(?:\.exe|\.cmd)?\s+model\s+`;
const LIST_TABLES = new RegExp(`${PAC}list-tables\\b`);
const LIST_LANGUAGES = new RegExp(`${PAC}list-languages\\b`);
const GENERATE_TYPES = new RegExp(`${PAC}genpage\\s+generate-types\\b`);
const GENPAGE_LIST = new RegExp(`${PAC}genpage\\s+list\\b`);
const PROVISION = /\bprovision-entities\.js\b/;
// The pre-SDK entity-builder created each table, column, relationship and row with its own script.
const LEGACY_PROVISION = /\b(?:create-table|add-column|create-relationship|create-record)\.js\b/;

// A list-tables result that says the searched table is absent. The captures phrase it as
//   `pac model list-tables --search 'cr_candidate'` — exact logical-name match: NOT FOUND
//   No tables found matching the specified criteria. / Result: cr_ticket does NOT exist
const NOT_FOUND = /\bNOT\s+FOUND\b|\bdoes\s+not\s+exist\b|\bdo\s+not\s+exist\b|\bNo\s+tables?\s+found\b/i;

// `--data-sources 'incident,contact'` → ['incident', 'contact']. commandInfo already removed the
// one pair of quotes that wrapped the token; stray backticks from a Markdown code span go here.
function csvList(value) {
  if (typeof value !== 'string') return [];
  return value.split(',').map((item) => item.trim().replace(/^[`'"]+|[`'"]+$/g, '').toLowerCase()).filter(Boolean);
}

const sameSet = (a, b) => a.length === b.length && a.every((item) => b.includes(item));
const containsAll = (have, wanted) => wanted.every((item) => have.includes(item));

// A logical name's suffix: `cr_candidate` → `candidate`. The plan stores suffixes only and the
// prefix comes from the SELECTED solution's publisher, so a run that picked a `cnt` publisher
// correctly creates `cnt_widget` for a prompt that said `cr_widget`.
const suffixOf = (name) => String(name).toLowerCase().replace(/^[a-z0-9]+_/, '');

// Commands matching `pattern`, each with its parsed flags and the text recorded with it (the
// result lines that follow a historical log command, or a contract-2 event's result).
function commandCalls(fixture, pattern) {
  return workflowCalls(fixture).filter((call) => pattern.test(call.command)).map((call) => {
    // A historical log wraps the command in a Markdown code span and keeps going after it:
    //   - Command: `pac model genpage generate-types --data-sources "task" --output-file "D:/x/RuntimeTypes.ts"`
    //   `node …/provision-entities.js --env https://… --input @…/provision-input.json --apply --sample-data`
    // The closing backtick would otherwise glue onto the last token (`--sample-data\`` is then no
    // flag at all), so drop the span delimiters before tokenizing. Recorded argv is used untouched.
    const info = commandInfo(call.argv ? call : { ...call, command: String(call.command).replace(/`/g, ' ') });
    const result = typeof call.result === 'string' ? call.result : call.result ? JSON.stringify(call.result) : '';
    return { call, flags: info.flags, text: [call.text || call.command, result].join('\n') };
  });
}

function listTablesSearches(fixture) {
  return commandCalls(fixture, LIST_TABLES).filter((c) => typeof c.flags.search === 'string')
    .map((c) => ({ ...c, terms: csvList(c.flags.search) }));
}

function generateTypesCalls(fixture) {
  return commandCalls(fixture, GENERATE_TYPES).map((c) => ({ ...c, sources: csvList(c.flags['data-sources']) }));
}

// Both transports — raw `pac model genpage upload` and scripts/genpage-upload.js — take the same
// `--code-file` / `--data-sources` / `--page-id` flags, so one reader serves both (isUpload).
function uploadCalls(fixture) {
  return commandCalls(fixture, /./).filter((c) => isUpload(c.call.command))
    .map((c) => ({ ...c, file: fileName(c.flags['code-file']), sources: csvList(c.flags['data-sources']), update: Boolean(c.flags['page-id']) }));
}

function provisionCalls(fixture) {
  return commandCalls(fixture, PROVISION);
}

function legacyProvisionCalls(fixture) {
  return commandCalls(fixture, LEGACY_PROVISION);
}

function envField(text, label) {
  const section = planSection(text, 'Environment') || '';
  const match = new RegExp(`^\\s*[-*]?\\s*${label}:\\s*(\\S+)`, 'mi').exec(section);
  return match ? match[1].trim() : null;
}

const planPrefix = (plan) => envField(plan, 'Publisher Prefix')?.toLowerCase() || null;
const planSolution = (plan) => envField(plan, 'Solution');

// Rows of a markdown table, minus the `| none | none |` placeholder rows plan-schema.md allows for
// an empty Choice Columns or Relationships table.
function tableRows(text, columns) {
  return parseMarkdownRows(text, columns).filter((row) => !Object.values(row).every((cell) => /^(none|)$/i.test(cell)));
}

// `Low (100000000), Medium (100000001)` → [{ label: 'Low', value: 100000000 }, …]
function parseOptions(cell) {
  return [...String(cell || '').matchAll(/([^,()]+?)\s*\((\d+)\)/g)].map((m) => ({ label: m[1].trim(), value: Number(m[2]) }));
}

// The `### <suffix>` blocks of `## Entity Creation Required` (plan-schema.md), e.g.
//   ### candidate
//   - Columns:
//     | Suffix | Type | Required | Notes |
//   - Choice Columns:
//     | Column Suffix | Options |
//   - Relationships:
//     | Type | Related Table | Lookup Suffix | Cascade |
// A Relationships row lives in the block of the REFERENCING table and names the referenced one.
function planEntityBlocks(plan) {
  const section = planSection(plan, 'Entity Creation Required');
  if (!section || /No entity creation required/i.test(section)) return [];
  const blocks = [];
  let current = null;
  for (const line of section.split(/\r?\n/)) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { suffix: heading[1].trim().toLowerCase(), lines: [] };
      blocks.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return blocks.map(({ suffix, lines }) => {
    const text = lines.join('\n');
    return {
      suffix,
      columns: tableRows(text, ['Suffix', 'Type']).map((row) => ({ suffix: row.suffix.toLowerCase(), type: row.type })),
      choices: tableRows(text, ['Column Suffix', 'Options']).map((row) => ({ suffix: row['column suffix'].toLowerCase(), options: parseOptions(row.options) })),
      relationships: tableRows(text, ['Type', 'Related Table', 'Lookup Suffix']).map((row) => ({
        type: row.type, related: suffixOf(row['related table']), lookup: row['lookup suffix'].toLowerCase(),
      })),
    };
  });
}

// `## Existing Entities` holds a comma/line separated list, `None.` or a sentence about mock data.
function existingEntities(plan) {
  const section = planSection(plan, 'Existing Entities') || '';
  return (section.match(/\b[a-z][a-z0-9_]*\b/g) || []).filter((word) => !/^(none|mock|data|page)$/.test(word));
}

// genpage-entity-creation-log.md as written by agents/genpage-entity-builder.md Step 5:
//   ## Environment            - Solution: Crdec34 / - Publisher Prefix: cr
//   ## Created Tables         ### Ticket / - Resolved Full Name: cr_ticket / - Metadata ID: n/a
//   ## Created Columns        | Table | Display Name | Schema Name | Resolved Full Name | Metadata ID |
//   ## Created Relationships  | Type | From | To | Lookup Schema Name | Resolved Full Name |
// Table order is kept: it is the order the transactions were recorded in.
function entityLog(text) {
  if (!text) return null;
  const tables = [];
  let current = null;
  for (const line of (planSection(text, 'Created Tables') || '').split(/\r?\n/)) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { title: heading[1], resolved: null, metadataId: null };
      tables.push(current);
      continue;
    }
    const field = /^\s*[-*]\s*(Resolved Full Name|Metadata ID):\s*(.*?)\s*$/i.exec(line);
    if (current && field) current[/^Resolved/i.test(field[1]) ? 'resolved' : 'metadataId'] = field[2].toLowerCase() || null;
  }
  return {
    solution: envField(text, 'Solution'),
    prefix: envField(text, 'Publisher Prefix')?.toLowerCase() || null,
    tables,
    columns: parseMarkdownRows(planSection(text, 'Created Columns') || '', ['Table', 'Resolved Full Name'])
      .map((row) => ({ table: row.table.toLowerCase(), resolved: row['resolved full name'].toLowerCase(), metadataId: row['metadata id'] ?? null })),
    relationships: parseMarkdownRows(planSection(text, 'Created Relationships') || '', ['From', 'To'])
      .map((row) => ({ from: row.from.toLowerCase(), to: row.to.toLowerCase(), resolved: (row['resolved full name'] || '').toLowerCase() })),
  };
}

// The tables a run actually created: the transaction log's resolved names (Dataverse may normalize
// them), else the plan's `<prefix>_<suffix>` when no log was captured.
function createdTableNames(fixture) {
  const log = entityLog(fixture.entityCreationLog);
  const resolved = (log?.tables || []).map((t) => t.resolved).filter(Boolean);
  if (resolved.length) return resolved;
  const prefix = planPrefix(fixture.genpagePlan);
  return prefix ? planEntityBlocks(fixture.genpagePlan).map((b) => `${prefix}_${b.suffix}`) : [];
}

// RuntimeTypes.ts as `pac model genpage generate-types` writes it:
//   export interface EnumRegistrations extends BaseEnumRegistrations {
//       "cr_ticket-cr_priority": cr_ticket_cr_priority,
//   }
//   const enum cr_ticket_cr_priority {
//   "Low" = 100000000,
//   }
// Members are quoted labels (they may contain spaces); a bare identifier is accepted too.
function runtimeEnums(source) {
  const text = String(source || '');
  const registrations = new Map();
  const block = /interface\s+EnumRegistrations\b[^{]*\{([^}]*)\}/.exec(text);
  for (const m of (block?.[1] || '').matchAll(/"([^"]+)"\s*:\s*([A-Za-z_$][\w$]*)/g)) registrations.set(m[1].toLowerCase(), m[2]);
  const enums = new Map();
  for (const m of text.matchAll(/\benum\s+([A-Za-z_$][\w$]*)\s*\{([^}]*)\}/g)) {
    enums.set(m[1], [...m[2].matchAll(/(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*=\s*(-?\d+)/g)]
      .map((x) => ({ label: x[1] ?? x[2], value: Number(x[3]) })));
  }
  return { registrations, enums };
}

// The enum registered for `<table>-<column>`, matched on suffixes (see suffixOf).
function choiceEnum(source, tableSuffix, columnSuffix) {
  const { registrations, enums } = runtimeEnums(source);
  for (const [key, name] of registrations) {
    const [table, column] = key.split('-');
    if (suffixOf(table) === tableSuffix && suffixOf(column) === columnSuffix) return { key, name, members: enums.get(name) || null };
  }
  return null;
}

// The rows of a PAC listing — apps from `pac model list`, pages from `pac model genpage list` — as
// { id, name }. Three recorded shapes:
//   App ID                                Display Name   Unique Name        (raw PAC table)
//   11111111-2222-3333-4444-555555555555  Sales Hub      SalesHub
//   - Sales Hub — 11111111-2222-3333-4444-555555555555 (SalesHub)          (log bullet)
//   { "apps": [ { "appId": "…", "displayName": "…" } ] }                     (structured result)
const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function listingRows(call) {
  const rows = [];
  const result = call.result;
  if (result && typeof result === 'object' && !call.historical) {
    for (const value of Object.values(result)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        const id = item && Object.values(item).find((v) => typeof v === 'string' && GUID_RE.test(v));
        if (id) rows.push({ id: GUID_RE.exec(id)[0].toLowerCase(), name: String(item.displayName || item.name || '').trim() });
      }
    }
    return rows;
  }
  const text = typeof result === 'string' && !call.historical ? result : String(call.text || '').split(/\r?\n/).slice(1).join('\n');
  for (const line of text.split(/\r?\n/)) {
    const m = GUID_RE.exec(line);
    if (!m) continue;
    const before = line.slice(0, m.index).replace(/^[\s*-]+/, '').replace(/[\s`(—–-]+$/, '').trim();
    const after = line.slice(m.index + m[0].length).split(/\s{2,}/).map((s) => s.trim()).filter(Boolean)[0] || '';
    rows.push({ id: m[0].toLowerCase(), name: before || after.replace(/[`)]+$/, '') });
  }
  return rows;
}

// The run in order, one entry per step, for requirements that span commands AND the conversation
// (questions, plan presentations). A contract-2 fixture that records its AskUserQuestion turns as
// tool-result events is read from those events; otherwise the workflow-log's lines are the record,
// since contract-2 events of the other fixtures hold commands only.
function conversationSteps(fixture) {
  const events = Array.isArray(fixture.events) ? fixture.events : null;
  if (events && events.some((e) => /^AskUserQuestion\b/.test(e.command))) {
    return events.map((e) => `${e.command}\n${typeof e.result === 'string' ? e.result : JSON.stringify(e.result ?? '')}`);
  }
  return String(fixture.workflowLog || '').split(/\r?\n/);
}

module.exports = {
  LIST_LANGUAGES, GENPAGE_LIST, NOT_FOUND, GUID_RE,
  csvList, sameSet, containsAll, suffixOf, commandCalls, listTablesSearches, generateTypesCalls, uploadCalls,
  provisionCalls, legacyProvisionCalls, planPrefix, planSolution, planEntityBlocks, existingEntities, entityLog,
  createdTableNames, runtimeEnums, choiceEnum, parseOptions, listingRows, conversationSteps,
};
