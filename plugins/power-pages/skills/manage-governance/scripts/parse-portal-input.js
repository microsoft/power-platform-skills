#!/usr/bin/env node

// parse-portal-input.js — Parses free-text portal input from the user during
// Phase 4.2 (apply) or Phase 4.4 (fetch portal) of the manage-governance skill
// into a structured policy spec.
//
// Accepted inputs (case-insensitive on keywords; case-insensitive name match):
//   "all"                          → { policyValue: "All",     portalIds: [] }
//   "none"                         → { policyValue: "None",    portalIds: [] }
//   "<id>" / "<id>, <id>, …"       → { policyValue: "Include", portalIds: [...] }
//   "<name>" / "<name>, <name>, …" → { policyValue: "Include", portalIds: [...] }
//   "<id>, <name>, …"              → mixed ids and names — both work, in any order
//   "not <id|name>, …"             → { policyValue: "Exclude", portalIds: [...] }
//   "except <id|name>, …"          → alias for "not"
//
// When `validIds` is supplied, every parsed token is matched (case-insensitive)
// against the list — by `portalId` first, then by `name`. Unknown tokens land
// in `errors`. Names resolved from `validIds` (when entries are objects with
// {portalId, name}) land in `resolvedNames` so callers can echo a friendly
// summary on the consent gate.
//
// Without `validIds`, only UUIDs are accepted as portal tokens; names cannot
// be resolved with no list to match against and are rejected.
//
// Use it like:
//   const parsed = parsePortalInput(text, { validIds: portalList });
//   if (parsed.errors.length) { /* tell user; reprompt */ }

'use strict';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const NOT_RE = /^\s*(not|except)\b\s*/i;

/**
 * @param {string} input
 * @param {object} [opts]
 * @param {Array<string|{portalId:string,name?:string}>} [opts.validIds]
 * @returns {{ policyValue: string, portalIds: string[], resolvedNames?: string[], errors: string[] }}
 */
function parsePortalInput(input, opts = {}) {
  const errors = [];
  if (input == null) {
    errors.push('Empty input. Expected "all", "none", "<id>, <id>", or "not <id>, <id>".');
    return makeResult(null, [], [], errors);
  }
  let s = String(input).trim();
  if (s === '') {
    errors.push('Empty input. Expected "all", "none", "<id>, <id>", or "not <id>, <id>".');
    return makeResult(null, [], [], errors);
  }
  if (/^all$/i.test(s)) return makeResult('All', [], [], []);
  if (/^none$/i.test(s)) return makeResult('None', [], [], []);

  let mode = 'Include';
  if (NOT_RE.test(s)) {
    mode = 'Exclude';
    s = s.replace(NOT_RE, '');
  }

  const rawTokens = s
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (rawTokens.length === 0) {
    errors.push('No portal ids found after the keyword. Provide at least one id.');
    return makeResult(null, [], [], errors);
  }

  const valid = normalizeValidIds(opts.validIds);
  const portalIds = [];
  const resolvedNames = [];
  const seen = new Set();

  for (const tok of rawTokens) {
    const isUuid = UUID_RE.test(tok);

    if (isUuid) {
      const id = (tok.match(UUID_RE) || [''])[0];
      const lower = id.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      if (valid) {
        const entry = valid.byId.get(lower);
        if (!entry) {
          errors.push(`Site id not in the listed sites: ${id}.`);
          continue;
        }
        portalIds.push(entry.portalId);
        if (entry.name) resolvedNames.push(entry.name);
      } else {
        portalIds.push(id);
      }
      continue;
    }

    // Not a UUID — try to resolve by name from the validIds list.
    if (!valid) {
      errors.push(`Not a valid site id and no site list was provided to resolve "${tok}" by name.`);
      continue;
    }
    const entry = valid.byName.get(tok.toLowerCase());
    if (!entry) {
      errors.push(`No site matched "${tok}" — not a known id or name.`);
      continue;
    }
    const lower = entry.portalId.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    portalIds.push(entry.portalId);
    if (entry.name) resolvedNames.push(entry.name);
  }

  if (errors.length > 0) return makeResult(null, [], [], errors);
  if (portalIds.length === 0) {
    errors.push('No usable portal ids parsed.');
    return makeResult(null, [], [], errors);
  }
  return makeResult(mode, portalIds, resolvedNames, []);
}

function normalizeValidIds(validIds) {
  if (!Array.isArray(validIds) || validIds.length === 0) return null;
  const byId = new Map();
  const byName = new Map();
  for (const entry of validIds) {
    if (!entry) continue;
    if (typeof entry === 'string') {
      const lower = entry.toLowerCase();
      byId.set(lower, { portalId: entry, name: null });
    } else if (typeof entry === 'object' && entry.portalId) {
      const lower = String(entry.portalId).toLowerCase();
      const rec = { portalId: entry.portalId, name: entry.name || null };
      byId.set(lower, rec);
      if (entry.name) byName.set(String(entry.name).toLowerCase(), rec);
    }
  }
  return { byId, byName };
}

function makeResult(policyValue, portalIds, resolvedNames, errors) {
  const out = { policyValue, portalIds, errors };
  if (resolvedNames.length > 0) out.resolvedNames = resolvedNames;
  return out;
}

if (require.main === module) {
  // CLI mode: read user input from stdin (or --input <text>). With
  // --portalsStdin, stdin instead carries list-portals.js JSON so callers can
  // validate names without creating a temporary file.
  const argv = process.argv;
  const arg = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const readStdin = async () => {
    return new Promise((resolve) => {
      let buf = '';
      process.stdin.on('data', (c) => (buf += c));
      process.stdin.on('end', () => resolve(buf));
    });
  };
  (async () => {
    let validIds;
    const file = arg('--portalsFile');
    const portalsStdin = argv.includes('--portalsStdin');
    if (file || portalsStdin) {
      try {
        const raw = file ? require('fs').readFileSync(file, 'utf8') : await readStdin();
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : parsed.portals;
        if (Array.isArray(list)) {
          validIds = list.map((p) => ({ portalId: p.portalId || p.Id, name: p.name || p.Name }));
        }
      } catch (e) {
        process.stderr.write(`Failed to read portal list: ${e.message}\n`);
        process.exit(1);
      }
    }
    const inline = arg('--input');
    if (portalsStdin && inline == null) {
      process.stderr.write('--portalsStdin requires --input <text> because stdin contains the portal list.\n');
      process.exit(1);
      return;
    }
    const input = (inline != null ? inline : await readStdin()).trim();
    const result = parsePortalInput(input, { validIds });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.errors.length > 0 ? 1 : 0);
  })();
}

module.exports = { parsePortalInput };
