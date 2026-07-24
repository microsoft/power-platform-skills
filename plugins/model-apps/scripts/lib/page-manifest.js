'use strict';
// Pure builder/parser/reconciler for the durable `<appUnique>_pagemanifest` web resource. The manifest
// carries the FULL design-time page semantics — { schemaVersion, pages:[{ key, name, pageId, purpose,
// dataSources, navigatesTo, pageInput, source }], design } — so a download→edit→rebuild round-trip
// restores intent + navigation that pac's page download (name + resolved-GUID source only) drops. It
// travels inside the solution and survives export/import. See docs/app-builder-staged-flow-design.md §7.3.
// PURE: the engine reads/writes the web-resource bytes; this module only shapes/parses strings (no I/O,
// no SDK handle).

// Manifest payload schema version. `parseManifest` rejects any other version fail-closed: an unknown
// version means an incompatible producer, so reconstruct from live state rather than mis-read the payload.
const MANIFEST_SCHEMA_VERSION = 1;

// Stable key grammar: lowercase alphanumeric, internal hyphens allowed, must not start or end with
// a hyphen. Matches the page-spec key rule in app-spec.js and references/rules.md.
// E.g. "overview", "wo-detail", "1st-run" are valid; "Overview", "wo_detail", "-lead" are not.
const KEY_GRAMMAR = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function manifestResourceName(appUnique) {
  return `${appUnique}_pagemanifest`;
}

// Build the manifest payload from the spec + reconciled key→pageId map. Keyed by the stable page key
// (falling back to name for a legacy page with no key). Empty/undefined optional fields are omitted so
// the serialized manifest stays minimal and diff-friendly (content-dedup depends on stable output).
function buildManifest(spec, keyToId) {
  const km = keyToId || new Map();
  const pages = ((spec && spec.pages) || []).map((p) => {
    const key = p.key || p.name;
    const entry = { key, name: p.name };
    const id = km.get(key);
    if (id) entry.pageId = id;
    if (p.purpose !== undefined) entry.purpose = p.purpose;
    if (p.dataSources && p.dataSources.length) entry.dataSources = p.dataSources;
    if (p.navigatesTo && p.navigatesTo.length) entry.navigatesTo = p.navigatesTo;
    if (p.pageInput !== undefined) entry.pageInput = p.pageInput;
    // Carry the source discriminant so the download round-trip can reconstruct the full spec shape
    // (§7.3): intent pages stay intent, tsx pages remember their codeFile. Omit when absent.
    if (p.source !== undefined) entry.source = p.source;
    return entry;
  });
  const m = { schemaVersion: MANIFEST_SCHEMA_VERSION, pages };
  if (spec && spec.design !== undefined) m.design = spec.design;
  return m;
}

function serializeManifest(manifest) {
  return JSON.stringify(manifest, null, 2);
}

// Validate a `source` discriminant. Valid shapes (mirrors app-spec.js normalizePageSource):
//   { kind: 'intent' }
//   { kind: 'tsx', codeFile: <non-empty string> }
// Any other shape is a corrupt manifest entry — return false so the caller yields null.
function isValidSource(src) {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return false;
  if (src.kind === 'intent') return true;
  if (src.kind === 'tsx') return typeof src.codeFile === 'string' && src.codeFile.length > 0;
  return false; // unknown kind
}

// Parse a manifest string FAIL-CLOSED with FULL per-page schema validation (addendum I5):
// bad JSON, unknown schemaVersion, non-array pages, a page missing a string key/name, a key that
// violates grammar, a DUPLICATE key, or any malformed optional field all yield null so the caller
// reconstructs from live enumeration rather than trusting a corrupt/incompatible payload.
//
// Per-page field validation summary:
//   key        — string, non-empty, grammar ^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$
//   name       — string, non-empty
//   pageId     — string, non-empty (when present)
//   purpose    — string (when present)
//   dataSources— array of strings (when present); each element must be a string
//   navigatesTo— array of { targetKey:string, data?:plain-object } (when present); each entry validated
//   pageInput  — non-null, non-array object (when present)
//   source     — discriminated { kind:'intent' } | { kind:'tsx', codeFile:string } (when present)
// top-level:
//   design     — non-null, non-array object (when present)
function parseManifest(text) {
  let m;
  try { m = JSON.parse(String(text)); } catch { return null; }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  if (m.schemaVersion !== MANIFEST_SCHEMA_VERSION) return null;
  if (!Array.isArray(m.pages)) return null;

  // Top-level `design` must be a plain object when present (not null, not array).
  if (m.design !== undefined) {
    if (!m.design || typeof m.design !== 'object' || Array.isArray(m.design)) return null;
  }

  const seen = new Set();
  for (const p of m.pages) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;

    // key — required, must be a non-empty string matching the stable grammar
    if (typeof p.key !== 'string' || !p.key) return null;
    if (!KEY_GRAMMAR.test(p.key)) return null;

    // name — required, non-empty string
    if (typeof p.name !== 'string' || !p.name) return null;

    // key uniqueness — a duplicate key means the manifest is corrupt; reconstruct from live state
    if (seen.has(p.key)) return null;
    seen.add(p.key);

    // pageId — when present, must be a non-empty string
    if (p.pageId !== undefined && (typeof p.pageId !== 'string' || !p.pageId)) return null;

    // purpose — when present, must be a string
    if (p.purpose !== undefined && typeof p.purpose !== 'string') return null;

    // dataSources — when present, must be an array; every element must be a string (not null/number/object)
    if (p.dataSources !== undefined) {
      if (!Array.isArray(p.dataSources)) return null;
      for (const ds of p.dataSources) {
        if (typeof ds !== 'string') return null;
      }
    }

    // navigatesTo — when present, must be an array; every entry must be { targetKey:string, data?:object }
    if (p.navigatesTo !== undefined) {
      if (!Array.isArray(p.navigatesTo)) return null;
      for (const edge of p.navigatesTo) {
        if (!edge || typeof edge !== 'object' || Array.isArray(edge)) return null;
        if (typeof edge.targetKey !== 'string') return null;
        // `data` is optional, but when present must be a plain non-null object (not array)
        if (edge.data !== undefined) {
          if (!edge.data || typeof edge.data !== 'object' || Array.isArray(edge.data)) return null;
        }
      }
    }

    // pageInput — when present, must be a plain non-null, non-array object
    if (p.pageInput !== undefined) {
      if (!p.pageInput || typeof p.pageInput !== 'object' || Array.isArray(p.pageInput)) return null;
    }

    // source — when present, must be a valid discriminated intent|tsx shape
    if (p.source !== undefined && !isValidSource(p.source)) return null;
  }

  return m;
}

// Dataverse stores webresource.content as base64. Decode to utf8, then parse (same fail-closed
// contract — bad base64 yields utf8 garbage that JSON.parse rejects → null).
function parseManifestBase64(b64) {
  if (typeof b64 !== 'string' || !b64) return null;
  let text;
  try { text = Buffer.from(b64, 'base64').toString('utf8'); } catch { return null; }
  return parseManifest(text);
}

// Reconcile the spec's declared pages against the durable manifest AND the fail-closed live
// enumeration (§7.3, §9). Authority order, highest first (C5):
//
//   1. manifest key→pageId — ONLY when that id is still present in the live enumeration. A confirmed
//      identity is truth even if the display name drifted, and it must NOT be overridden by a DIFFERENT
//      live page that merely shares the name (that is the exact overwrite bug C5 fixes).
//   2. exactly ONE live page with this display name — unique-name adoption / stale-imported-id fallback.
//   3. absent — needs a create (mint a fresh id).
//   4. duplicate/ambiguous live names (and no confirmed manifest id) — returned in `ambiguous`; the
//      caller HALTS. Never silently collapsed into a Map (which would pick an arbitrary page to overwrite).
//
// Returns { keyToId: Map<key,id>, absentKeys: string[], ambiguous: [{ key, name, matches:[id…] }] }.
function reconcilePageIds(pages, manifest, livePages) {
  const live = livePages || [];

  // Build a case-preserving id lookup from live pages (lower-case key for case-insensitive match).
  const liveById = new Map(
    live.filter((p) => p.pageId).map((p) => [String(p.pageId).toLowerCase(), p.pageId]),
  );

  // Group live pages by name so duplicate names are detected rather than collapsed.
  // name -> [id…] (all live ids that carry this name)
  const idsByName = new Map();
  for (const p of live) {
    if (p.name && p.pageId) {
      const arr = idsByName.get(p.name) || [];
      arr.push(p.pageId);
      idsByName.set(p.name, arr);
    }
  }

  // Manifest pages indexed by key for O(1) lookup.
  const manifestByKey = new Map(
    ((manifest && manifest.pages) || [])
      .filter((p) => p && p.key)
      .map((p) => [p.key, p]),
  );

  const keyToId = new Map();
  const absentKeys = [];
  const ambiguous = [];

  for (const p of pages || []) {
    const key = p.key || p.name;
    const mp = manifestByKey.get(key);

    // (1) manifest key→id, confirmed live (case-insensitive id match)
    let id = mp && mp.pageId && liveById.has(String(mp.pageId).toLowerCase())
      ? liveById.get(String(mp.pageId).toLowerCase())
      : undefined;

    if (!id) {
      // (2 / 4) look up by display name in the live enumeration
      const matches = idsByName.get(p.name) || [];
      if (matches.length > 1) {
        // (4) HALT — caller must not proceed; returning ambiguous signals this
        ambiguous.push({ key, name: p.name, matches: matches.slice() });
        continue;
      }
      if (matches.length === 1) {
        // (2) exactly one live name-match — adopt it
        id = matches[0];
      }
    }

    if (id) {
      keyToId.set(key, id);
    } else {
      // (3) not found anywhere — must be created
      absentKeys.push(key);
    }
  }

  return { keyToId, absentKeys, ambiguous };
}

module.exports = {
  MANIFEST_SCHEMA_VERSION,
  manifestResourceName,
  buildManifest,
  serializeManifest,
  parseManifest,
  parseManifestBase64,
  reconcilePageIds,
};
