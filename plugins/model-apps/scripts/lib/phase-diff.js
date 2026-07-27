'use strict';
// Spec-diff → changed build phases (#3, "track the diff so a small edit doesn't re-run everything").
//
// PURE + I/O-free. Given the CURRENT spec and the spec that was LAST APPLIED to the env (persisted by
// build-model-app.js after a successful --apply as <workspace>/last-applied.json), it reports which
// build phases' inputs actually changed. Today this is ADVISORY — surfaced in the dry-run so the
// author/agent can SEE that "only pages changed" instead of re-reading 85 steps. It does NOT yet gate
// --apply: running ONLY the changed phases safely requires each phase to self-hydrate its cross-phase
// dependencies (e.g. the pages phase currently HALTS unless app-shell ran in the same invocation —
// sdk-build.js "pages-requires-app"), which needs a per-phase audit + live validation. That execution
// step is tracked in docs/app-builder-roadmap.md; this module is its correct, testable foundation.
//
// Comparison is a stable-stringify deep-equal (key-order-independent), so re-ordering keys in the spec
// file does NOT report a false change. Any real value change in a phase's slice marks it changed. When
// no prior snapshot exists (first build, or a spec authored elsewhere), every phase is "changed".

// The slice of the spec each phase consumes. `publish` is intentionally absent — it always runs (it's
// the final flush) and has no author-owned input to diff. Order matches the engine's PHASES pipeline.
const PHASE_SLICES = {
  solution: (s) => s.solution,
  // data-model owns the whole schema; a change here can ripple into everything downstream (views,
  // charts, forms reference columns; app-shell references entities), so callers treat a data-model
  // change as "recommend a full build", not "run only data-model".
  'data-model': (s) => ({ entities: s.entities, relationships: s.relationships, globalChoices: s.globalChoices }),
  'sample-data': (s) => s.sampleData,
  'web-resources': (s) => s.webResources,
  views: (s) => s.views,
  charts: (s) => s.charts,
  forms: (s) => s.forms,
  commands: (s) => s.commands,
  dashboards: (s) => s.dashboards,
  'app-shell': (s) => ({ app: s.app, appShell: s.appShell }),
  pages: (s) => s.pages,
  'ai-features': (s) => s.ai,
};

// Deterministic, key-order-independent JSON so a reordered-but-equal slice compares equal. Arrays keep
// their order (order is semantic for views/columns/sitemap); only object KEYS are sorted.
function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

// Returns the phases whose input slice differs between `current` and `lastApplied`. With no prior
// snapshot (lastApplied falsy), returns ALL diffable phases (a first apply builds everything).
function diffPhases(current, lastApplied) {
  const cur = current || {};
  if (!lastApplied) return Object.keys(PHASE_SLICES);
  const changed = [];
  for (const [phase, slice] of Object.entries(PHASE_SLICES)) {
    if (stableStringify(slice(cur)) !== stableStringify(slice(lastApplied))) changed.push(phase);
  }
  return changed;
}

// A one-line human summary for the dry-run. `changed` is diffPhases(...) output.
function summarizeDiff(changed) {
  if (!changed.length) return 'No spec changes since the last apply — a re-run would be a full no-op (every phase reuses what exists).';
  if (changed.includes('data-model')) {
    return `Changed since last apply: ${changed.join(', ')}. The data model changed, so a FULL build is recommended (downstream views/charts/forms/app may reference changed columns).`;
  }
  return `Changed since last apply: ${changed.join(', ')}. (Data model unchanged.) Only these phases have new input; the rest reuse what exists idempotently.`;
}

module.exports = { diffPhases, summarizeDiff, stableStringify, PHASE_SLICES };
