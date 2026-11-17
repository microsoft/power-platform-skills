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
// step is tracked in docs/app-builder-capabilities.md; this module is its correct, testable foundation.
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
  // The configuration kinds (lib/configuration-artifacts.js FIELDS) are written in the solution and data-model phases, and the protected
  // opt-in decides how. They were missing here, so a spec whose only change was one of them diffed as "nothing changed" and
  // `--changed-only` applied nothing; as part of this slice a change to any of them is a full build (FULL_BUILD_PHASES). An absent field
  // compares as null on both sides, so a spec that declares none of them compares exactly as it did.
  'data-model': (s) => ({
    entities: s.entities, relationships: s.relationships, globalChoices: s.globalChoices,
    configurationIdentity: s.configurationIdentity, environmentVariables: s.environmentVariables, connectionReferences: s.connectionReferences,
    customApis: s.customApis, duplicateDetectionRules: s.duplicateDetectionRules,
  }),
  'sample-data': (s) => s.sampleData,
  'web-resources': (s) => s.webResources,
  views: (s) => s.views,
  charts: (s) => s.charts,
  forms: (s) => s.forms,
  // business-rules / business-process-flows were MISSING here, which made a spec whose only change
  // was a rule or a flow diff as "nothing changed" — so `--changed-only` classified a real edit as a
  // no-op and did nothing at all. Both phases are additive discover-reconcile (see classifyAdditive),
  // so their edits force a full build and record debt rather than a silent skip.
  'business-rules': (s) => s.businessRules,
  'business-process-flows': (s) => s.businessProcessFlows,
  // commandStates[] are applied in the commands phase. Only a spec that declares some compares them, ordered by row id (their order means
  // nothing): a spec without them diffs exactly as before. A change to them is a full build (classify-changes.js).
  commands: (s) => (hasCommandStates(s) ? { commands: s.commands, commandStates: commandStatesByRow(s.commandStates) } : s.commands),
  dashboards: (s) => s.dashboards,
  'app-shell': (s) => ({ app: s.app, appShell: s.appShell }),
  pages: (s) => s.pages,
  'ai-features': (s) => s.ai,
  // security consumes personas[] AND roleGrants[]. Both must be here: with only `personas`, a spec
  // whose ONLY change was adding a roleGrant diffed as "nothing changed", so `--changed-only`
  // reported "deployed app already matches the spec" and never called AddPrivilegesRole — the table
  // deployed and the role still had no access to it, which is the exact bug roleGrants[] fixes.
  // Neither has a safe partial-apply path yet, so a change here forces a FULL build via
  // FULL_BUILD_PHASES in classify-changes.js — never a silent changed-only no-op.
  security: (s) => ({ personas: s.personas, roleGrants: s.roleGrants }),
};

function hasCommandStates(s) {
  return !!s && Array.isArray(s.commandStates) && s.commandStates.length > 0;
}
function commandStatesByRow(states) {
  const key = (e) => String((e && e.rowId) || '').toLowerCase();
  return [...states].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

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
