'use strict';
// The build's runtime for the configuration kinds (lib/configuration-artifacts.js): environment variables, connection
// references, Custom APIs, duplicate-detection rules and the solution's version. sdk-build.js constructs ONE runtime
// per build, only when the App Spec uses these fields, and calls it at three points:
//   apply('solution')        right after the solution step: the solution's version
//   apply('data-model')      after the tables, columns and relationships: every other kind, in dependency order
//   beforePages(pages)       before the first page that names a reference or a Custom API is written
// and stops the build with throwIfIncomplete(step) when requested work did not happen.
//
// Why a separate module: the helper is pure feature logic (plan, apply, read back, observe) and must stay usable
// outside the build (the standalone connection-reference writer, verify, download). What only the build has — its
// create port, its managed-artifact recorder, its BuildHalt and retry policy, the maker's --authorize tokens — is
// closed over here, once, so the build calls three methods and holds no configuration state of its own. This module
// never requires sdk-build.js (that would be a cycle: sdk-build requires this).

const C = require('./configuration-artifacts.js');
const { BuildHalt } = require('./entity-provision.js');
const { RETRY } = require('./retry-policy.js');

const lower = (v) => String(v).toLowerCase();

// The intent of every declared item is computed BEFORE any write: two entries with the same identity (or an entry
// the helper cannot select) stop the build in preflight, not halfway through the data-model phase.
function precomputeIntents(spec) {
  const lists = [
    ['environmentVariable', spec.environmentVariables, 'schemaName'],
    ['connectionReference', spec.connectionReferences, 'logicalName'],
    ['customApi', spec.customApis, 'uniqueName'],
    ['duplicateRule', spec.duplicateDetectionRules, 'key'],
  ];
  for (const [kind, list, field] of lists) {
    for (const entry of Array.isArray(list) ? list : []) {
      if (!entry || typeof entry[field] !== 'string') continue;
      try {
        C.configurationIntentOf(spec, kind, entry[field]);
      } catch (error) {
        throw new BuildHalt(`configuration ${kind} ${entry[field]} cannot be built: ${error.code}. Each item must be declared exactly once. The build stopped before writing anything.`, {
          phase: 'preflight', code: 'configuration-intent-invalid', recoverable: false, cause: error, retry: RETRY.NEVER,
        });
      }
    }
  }
}

// The declarations a set of pages names: a reference by connectorBindings[].logicalName, a Custom API by
// actionBindings[].name (`pages` is what page-binding-targets.js pagesStatingBindings answers).
function namedByPages(pages) {
  const references = new Set();
  const apis = new Set();
  for (const page of pages || []) {
    for (const b of (page && page.connectorBindings) || []) if (b && b.logicalName != null) references.add(lower(b.logicalName));
    for (const b of (page && page.actionBindings) || []) if (b && b.name != null) apis.add(lower(b.name));
  }
  return { references, apis };
}

/**
 * @param {object} parts
 * @param {object} parts.spec           the App Spec (normalized, validated)
 * @param {object} parts.sdk            the build's solution-scoped maker SDK (header-ful, workspace initialised)
 * @param {object} [parts.provision]    the header-less client; reads only (unused for writes: the creates must join the solution)
 * @param {object} parts.opts           the build's opts: creates, managed, managedIdOf, configurationBindings, authorizedDestructive (Set), connections
 * @param {string} parts.appUniqueName  the app's unique name (sdk-build appUniqueName(spec)), for the management records
 */
function createConfigurationRuntime({ spec, sdk, provision, opts = {}, appUniqueName } = {}) {
  if (!spec || !sdk) throw new TypeError('createConfigurationRuntime: spec and sdk are required');
  precomputeIntents(spec);
  const ctx = C.configurationContext({
    sdk,
    // The build's create port only when it can stand in for the configuration kinds' own (it protects every one of
    // them and resolves: C.configurationAcceptsPort). The build's port protects the kinds of its own catalog or none
    // (the plain pass-through), and half using it would send these creates under random ids; otherwise the helper
    // uses its default, the plain pass-through (lib/creates-passthrough.js): the configuration kinds load no
    // stable-id module in this release. Ordinary creation never depends on a port being supplied.
    creates: C.configurationAcceptsPort(opts.creates) ? opts.creates : undefined,
    managed: opts.managed,
    bindings: opts.configurationBindings,
    solutionUniqueName: spec.solution && spec.solution.uniqueName,
    authorizedDestructive: opts.authorizedDestructive,
    connections: opts.connections,
    // The id the managed-artifacts manifest records for an item (synchronous), so a bound item keeps its id.
    boundIdOf: opts.managedIdOf,
  });
  // What this run last observed of each item a page can name, `<kind>:<lower key>` -> blocker | null. Filled by
  // apply('data-model') from its own reads and by beforePages from fresh reads; an apply replaces what it covers.
  const observed = new Map();
  let applied = false;

  const remember = (kinds, keysOf, blocking) => {
    for (const [kind, keys] of kinds) for (const key of keys) observed.set(`${kind}:${key}`, null);
    for (const b of blocking) if (keysOf.has(b.kind)) observed.set(`${b.kind}:${lower(b.key)}`, b);
  };

  // Record what this run confirmed BEFORE any halt: a step that created two items and then met an unknown third
  // must still remember the two. A record that cannot be kept is reported, never swallowed.
  async function record(outcome) {
    if (!opts.managed || typeof opts.managed.recordApplied !== 'function') return;
    let records;
    try {
      records = C.configurationManagedRecords(outcome, spec);
    } catch {
      records = null;
    }
    if (!records) {
      for (const b of outcome.managedBindings) outcome.unknown.push({ kind: b.kind, key: b.key, id: b.id, code: 'CONFIGURATION_RECORD_UNCONFIRMED', unit: 'management' });
      return;
    }
    for (const rec of records) {
      try {
        await opts.managed.recordApplied({ ...rec, appUniqueName });
      } catch {
        // A child's record is as required as its root's: a child nobody recorded is one no later build can account for.
        outcome.unknown.push({ kind: rec.kind, key: rec.key, id: rec.id, code: 'CONFIGURATION_RECORD_UNCONFIRMED', unit: 'management' });
      }
    }
  }

  return {
    ctx,
    // Plan, apply and observe ONE phase's items. Returns {outcome, blocking, halt, plan}.
    async apply(phase) {
      if (phase !== 'solution' && phase !== 'data-model') throw new TypeError(`configuration runtime: unknown phase ${phase}`);
      const step = await C.runConfigurationStep(spec, ctx, phase);
      const before = step.outcome.unknown.length;
      await record(step.outcome);
      let halt = step.halt;
      if (step.outcome.unknown.length > before) {
        const items = [...(halt ? halt.items : []), ...step.outcome.unknown.slice(before).map(({ kind, key, code }) => ({ kind, key, code }))];
        halt = {
          phase, code: 'configuration-incomplete', retry: 'never', items,
          message: `${items.length} configuration item${items.length === 1 ? '' : 's'} not completed: ${items.map((p) => `${p.kind} ${p.key} (${p.code})`).join(', ')}`,
        };
      }
      if (phase === 'data-model') {
        applied = true;
        const keys = (list, field) => (Array.isArray(list) ? list.map((e) => lower(e[field])) : []);
        remember([['connectionReference', keys(spec.connectionReferences, 'logicalName')], ['customApi', keys(spec.customApis, 'uniqueName')]],
          new Set(['connectionReference', 'customApi']), step.blocking);
      }
      return { outcome: step.outcome, blocking: step.blocking, halt, plan: step.plan };
    },

    // Stop the build when a step left requested work undone. Every configuration halt is RETRY.NEVER: an unknown
    // outcome is inspected by its handle, never replayed by a whole-build retry, and a refusal will refuse again.
    throwIfIncomplete(step) {
      if (!step || !step.halt) return;
      const { phase, code: haltCode, message } = step.halt;
      throw new BuildHalt(message, { phase, code: haltCode, recoverable: false, retry: RETRY.NEVER });
    },

    // Gate the pages that name a reference or a Custom API on what was OBSERVED (never on the settings): items this
    // run's data-model step read back are taken from that read; any other item the pages name is read now (GET
    // only). Call it before the first page write, and again for a page found later (a changed-only target).
    async beforePages(pages) {
      const { references, apis } = namedByPages(pages);
      const declared = (list, field, wanted) => (Array.isArray(list) ? list.filter((e) => e && wanted.has(lower(e[field])) && !observed.has(`${field === 'logicalName' ? 'connectionReference' : 'customApi'}:${lower(e[field])}`)) : []);
      const freshReferences = declared(spec.connectionReferences, 'logicalName', references);
      const freshApis = declared(spec.customApis, 'uniqueName', apis);
      if (freshReferences.length || freshApis.length) {
        const blocking = await C.configurationBlocking({ connectionReferences: freshReferences, customApis: freshApis }, ctx);
        remember([['connectionReference', freshReferences.map((e) => lower(e.logicalName))], ['customApi', freshApis.map((e) => lower(e.uniqueName))]],
          new Set(['connectionReference', 'customApi']), blocking);
      }
      const blocking = [...observed.values()].filter(Boolean);
      const blockers = C.configurationPageBlockers(blocking, pages);
      if (!blockers.length) return { blockers, applied };
      const first = blockers[0];
      throw new BuildHalt(
        `page "${first.page}" cannot be written: ${blockers.map((b) => `${b.kind} ${b.key} (${b.cause})`).join(', ')}. ${applied ? 'The configuration step did not leave it usable.' : 'This run did not apply configuration; run the data-model phase (or fix the item) first.'}`,
        { phase: 'pages', code: 'configuration-prerequisite-not-applied', recoverable: false, retry: RETRY.NEVER },
      );
    },
  };
}

module.exports = { createConfigurationRuntime };
