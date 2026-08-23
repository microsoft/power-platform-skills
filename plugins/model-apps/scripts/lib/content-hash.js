'use strict';
// Content-aware phase diff (#2 / changed-only deliverable #2).
//
// The pages and web-resources phase slices in phase-diff.js only see the SPEC. A page carries its
// `source.codeFile` PATH but not the file BYTES; a web resource may carry a `contentPath` instead of
// inline `content`/`contentBase64`. So editing the .tsx (or the referenced web-resource file) while
// leaving the spec JSON identical was INVISIBLE to diffPhases — a real content change reported as "no
// change since last apply". That false negative is exactly what makes a naive partial apply unsafe, so
// the changed-only design (docs/app-builder-design.md) fixes it by hashing the on-disk content and
// folding the hash into the diffed slice.
//
// annotateContentHashes returns a SHALLOW-CLONED spec (the pages/webResources arrays are re-mapped;
// nothing is mutated in place — the real spec object is still handed to the build engine untouched)
// whose implemented pages and contentPath web resources each carry a stable `__contentSha`. Because the
// phase-diff pages/web-resources slices serialize the whole page/web-resource object, that field flows
// into the diff automatically; no change to phase-diff.js's pure slice logic is needed.
//
// I/O is INJECTED via `readFile(relPath) -> string|Buffer|null` so this module stays pure and unit
// testable. A null/undefined return or a throw (missing, unreadable, or permission-denied file) yields
// `__contentSha: null`, which still DIFFERS from any real hex hash — so a vanished or unreadable source
// reads as CHANGED (fail-closed), never as a silent no-op that could bless an un-deployed edit.

const { sha256 } = require('./hash.js');
const { normalizePageSource } = require('./app-spec.js');

// Resolve the on-disk source path a page's content lives at, or null for an intent (design-only) page
// that has nothing on disk to hash. Delegates to the canonical page-source normalizer so the legacy
// top-level `codeFile`, the `source:{kind:'tsx',codeFile}` shape, and whitespace-trimming rules are
// resolved identically to the build engine (app-spec.js normalizePageSource) — a second copy of that
// logic here could drift and hash the wrong path.
function pageContentPath(page) {
  const src = normalizePageSource(page);
  if (src && src.kind === 'tsx' && typeof src.codeFile === 'string' && src.codeFile) return src.codeFile;
  return null;
}

// Return a shallow clone of `spec` with `__contentSha` folded into every implemented page and every
// contentPath web resource. `readFile` performs the actual I/O (see module header). Inline-content web
// resources (content / contentBase64) are left untouched — their bytes already live in the spec, so the
// spec diff catches those edits without a hash.
function annotateContentHashes(spec, readFile) {
  if (!spec || typeof spec !== 'object' || typeof readFile !== 'function') return spec;
  const safeHash = (relPath) => {
    let bytes;
    try {
      bytes = readFile(relPath);
    } catch {
      // Missing / unreadable file: fail-closed to null (see header) rather than throwing out of a diff.
      return null;
    }
    if (bytes === null || bytes === undefined) return null;
    return sha256(bytes);
  };
  const clone = { ...spec };
  if (Array.isArray(spec.pages)) {
    clone.pages = spec.pages.map((p) => {
      const rel = p && typeof p === 'object' ? pageContentPath(p) : null;
      if (!rel) return p; // intent page (no tsx) — nothing on disk to hash
      return { ...p, __contentSha: safeHash(rel) };
    });
  }
  if (Array.isArray(spec.webResources)) {
    clone.webResources = spec.webResources.map((wr) => {
      // Only a contentPath web resource hides its bytes behind a path; inline ones diff via their own
      // content/contentBase64 fields already.
      if (!wr || typeof wr !== 'object' || !wr.contentPath) return wr;
      return { ...wr, __contentSha: safeHash(wr.contentPath) };
    });
  }
  return clone;
}

module.exports = { annotateContentHashes, pageContentPath };
