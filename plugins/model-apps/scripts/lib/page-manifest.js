'use strict';
// Pure builder/parser/reconciler for the durable `<appUnique>_pagemanifest` web resource. The manifest
// carries the FULL design-time page semantics — { schemaVersion, pages:[{ key, name, pageId, purpose,
// dataSources, navigatesTo, pageInput, source }], design } — so a download→edit→rebuild round-trip
// restores intent + navigation that pac's page download (name + resolved-GUID source only) drops. It
// travels inside the solution and survives export/import. See docs/app-builder-design.md §7.3.
// PURE: the engine reads/writes the web-resource bytes; this module only shapes/parses strings (no I/O,
// no SDK handle).

// Manifest payload schema version. `parseManifest` rejects any other version fail-closed: an unknown
// version means an incompatible producer, so reconstruct from live state rather than mis-read the payload.
const MANIFEST_SCHEMA_VERSION = 1;

// Stable key grammar: lowercase alphanumeric, internal hyphens allowed, must not start or end with
// a hyphen. Matches the page-spec key rule in app-spec.js and references/rules.md.
// E.g. "overview", "wo-detail", "1st-run" are valid; "Overview", "wo_detail", "-lead" are not.
const KEY_GRAMMAR = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

// 36-char GUID pattern used to validate spec-supplied pageIds before treating them as live-page
// identity. Matches upper- and lower-case hex. See provenance guard (C3) in reconcilePageIds.
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

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

  const seen = new Set();       // duplicate key check
  const seenPageIds = new Set(); // duplicate pageId check: two keys → same id is a 1:1 violation (Imp11)
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

    // pageId uniqueness — a manifest where two keys share the same pageId is a 1:1 identity
    // violation (Imp11). Case-insensitive: 'ABC' and 'abc' are the same live page id.
    if (p.pageId !== undefined) {
      const pidLow = p.pageId.toLowerCase();
      if (seenPageIds.has(pidLow)) return null;
      seenPageIds.add(pidLow);
    }

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

// Reconcile the spec's declared pages against the durable manifest, the env-wide EXISTENCE set,
// and the app's own sitemap (MEMBERSHIP). Three-authority + provenance model (C3):
//
//   1. Spec page's own `pageId` — PROVENANCE-GATED (C3, SAFETY-critical):
//      A spec pageId may ONLY bind when its ownership is proven. Binding an unprovenanced GUID
//      that merely exists env-wide would silently overwrite an UNRELATED live page.
//      Binding is allowed ONLY when EITHER: (i) ∈ sitemapIds (proven this app's page via
//      membership), OR (ii) === manifest id (manifest confirms the same id). AND the id must be
//      ∈ existenceIds (page still exists). Stale or unprovenanced ids fall through to the manifest.
//
//   2. Manifest key→pageId — confirmed live: id still ∈ existenceIds. Crash-safe: a manifested id
//      that exists but is not yet in the sitemap (finalizer died) is reused, not recreated (C1).
//
//   3. Absent → create (mint a fresh id).
//
// `existenceIds` — array/Set of ALL page ids that EXIST in the environment (create-vs-reuse).
// `sitemapIds`   — array/Set of ids in THIS app's sitemap (membership / ownership proof).
//
// Conflicts (caller HALTs `pages-identity-conflict` when conflicts.length > 0):
//   { key, reason:'invalid-pageid', pageId }          — p.pageId is not a valid 36-char GUID.
//   { key, reason:'spec-manifest-disagree', pageId, manifestId }
//                                                     — both ids live and differ (C3).
//   { pageId, keys:[…] }                              — ≥2 distinct keys → same live id (1:1 violation).
//
// Returns { keyToId: Map<key,id>, absentKeys: string[], conflicts: object[] }.
// No name-based lookup; no `ambiguous` field — id matching is unambiguous.
function reconcilePageIds(pages, manifest, existenceIds, sitemapIds) {
  // Normalise id sets to lower-case for case-insensitive membership tests. Original-case ids are
  // preserved on source objects (mp.pageId, p.pageId) so keyToId and conflict payloads round-trip
  // the casing the caller provided.
  const existSet = new Set((existenceIds || []).map((id) => String(id).toLowerCase()));
  const sitemapSet = new Set((sitemapIds || []).map((id) => String(id).toLowerCase()));

  // Manifest pages indexed by key for O(1) lookup.
  const manifestByKey = new Map(
    ((manifest && manifest.pages) || [])
      .filter((p) => p && p.key)
      .map((p) => [p.key, p]),
  );

  const keyToId = new Map();
  const absentKeys = [];
  const conflicts = [];

  for (const p of pages || []) {
    const key = p.key || p.name;
    const mp = manifestByKey.get(key);
    // manId: lowercase manifest id for comparison; mp.pageId: original-case for conflict payloads.
    const manId = mp && mp.pageId ? String(mp.pageId).toLowerCase() : null;

    if (p.pageId !== undefined && p.pageId !== null) {
      const specId = p.pageId;

      // GUID format validation — a spec pageId that is not a valid 36-char GUID cannot be a real
      // page id. Reject early to prevent a malformed value from accidentally matching an existenceId.
      if (!GUID_RE.test(specId)) {
        conflicts.push({ key, reason: 'invalid-pageid', pageId: specId });
        continue;
      }

      const specIdLow = specId.toLowerCase();
      const specInExistence = existSet.has(specIdLow);
      // Evaluate manInExistence only when manId is present; avoids false-positive disagreements.
      const manInExistence = manId !== null && existSet.has(manId);

      // Disagreement HALT (C3): both the spec id and the manifest id are live and differ — binding
      // either would silently clobber the other's live page content. Caller must resolve.
      if (manId !== null && manId !== specIdLow && specInExistence && manInExistence) {
        conflicts.push({ key, reason: 'spec-manifest-disagree', pageId: specId, manifestId: mp.pageId });
        continue;
      }

      // Provenance-gated binding: adopt the spec pageId only when ownership is proven.
      //   (i)  ∈ sitemapIds → page is a confirmed member of THIS app.
      //   (ii) === manId    → manifest agrees (consistent edit-snapshot of this page).
      // An id that merely exists env-wide but satisfies neither condition is unprovenanced —
      // it could belong to an entirely different app. Fall through to the manifest instead.
      if (specInExistence && (sitemapSet.has(specIdLow) || specIdLow === manId)) {
        keyToId.set(key, specId);
        continue;
      }

      // Unprovenanced or stale spec pageId — do not bind; fall through to manifest lookup.
    }

    // Manifest authority (C1): a manifested id confirmed in existenceIds is reused even when the
    // sitemap finalizer died before writing the SubArea (crash-safe round-trip correctness).
    if (manId !== null && existSet.has(manId)) {
      keyToId.set(key, mp.pageId);
    } else {
      absentKeys.push(key);
    }
  }

  // 1:1 identity guard: two distinct keys resolving to the same live id means the manifest or
  // spec is corrupt (one page can only belong to one key). Surface as a conflict; caller HALTs.
  const idToKeys = new Map();
  for (const [k, id] of keyToId) {
    const idLow = id.toLowerCase();
    const arr = idToKeys.get(idLow) || [];
    arr.push(k);
    idToKeys.set(idLow, arr);
  }
  for (const [, keys] of idToKeys) {
    if (keys.length > 1) {
      conflicts.push({ pageId: keyToId.get(keys[0]), keys });
    }
  }

  return { keyToId, absentKeys, conflicts };
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
