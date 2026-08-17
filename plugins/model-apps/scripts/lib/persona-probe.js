// plugins/model-apps/scripts/lib/persona-probe.js
// PURE: plan and interpret impersonated authorization probes for each persona in an App Spec.
//
// WHY this exists. `role-privileges` proves the deployed role HOLDS the declared privileges — a
// metadata comparison. It cannot prove the persona can actually perform the operation: privilege
// depth interacts with record ownership, business-unit placement, team membership, sharing, and
// server-side plug-ins, none of which are visible in `roleprivileges`. This probe closes that gap by
// executing real Web API calls AS the persona and checking the outcome.
//
// Impersonation makes this cheap and human-free. The caller sends the target user's id on each
// request; effective privileges become the INTERSECTION of caller and target, so a System
// Administrator driving the probe cannot mask a permission the persona lacks:
//   CallerObjectId  -> the Entra object id  (preferred)
//   MSCRMCallerID   -> the Dataverse systemuserid  (legacy)
// The caller needs `prvActOnBehalfOfAnotherUser`, assigned DIRECTLY (a Team-inherited grant does not
// satisfy it). https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/impersonate-another-user-web-api
//
// WHAT THIS CANNOT DO — stated here so the report is never over-read. This exercises the Web API.
// It says nothing about UCI navigation, which form opens, control/field visibility, client-side
// script, the command bar, layout, accessibility, or whether a human can find the screen at all. A
// green probe run means "the data operations are authorized", never "the app works".
'use strict';

const { declaredPrivileges } = require('./role-privileges.js');

// Read is the only access we can exercise WITHOUT changing the environment, so it is the default.
// Everything else creates, mutates or destroys rows and is planned but not executed unless the
// caller opts in — a verification tool that silently writes to someone's environment is a trap.
const MUTATING_ACCESS = new Set(['create', 'write', 'delete', 'append', 'appendto', 'assign', 'share']);

const isMutating = (access) => MUTATING_ACCESS.has(String(access || '').trim().toLowerCase());

// Entities the platform grants broadly and which therefore prove nothing as a NEGATIVE probe: a
// persona that never declares `appmodule` still reads it, because the build injects that privilege
// (see declaredPrivileges) and the platform needs it to open any app at all.
const NEVER_PROBE_DENIED = new Set(['appmodule']);

/**
 * Plan the probes for every persona in the spec.
 *
 * Two probe kinds, and the negative one is the point:
 *  - `expect: 'allow'` — an entity+access the persona DECLARES. Proves the grant works end to end.
 *  - `expect: 'deny'`  — an entity another persona declares but THIS one does not. Proves isolation
 *                        between personas, which is the failure nobody notices: an over-broad role
 *                        looks perfect from the inside because everything the user tries succeeds.
 *
 * @param {object} spec  App Spec (already migrated/validated by the caller)
 * @param {object} [opts]
 * @param {boolean} [opts.includeMutations=false] plan mutating probes too (still not executed here)
 * @returns {{ probes: Array, warnings: string[] }}
 */
function planProbes(spec, opts = {}) {
  const includeMutations = opts.includeMutations === true;
  const personas = (spec && spec.personas) || [];
  const warnings = [];
  const probes = [];

  if (personas.length === 0) {
    warnings.push('spec declares no personas — nothing to probe');
    return { probes, warnings };
  }

  // Declared privileges per persona, computed once: used for the positive probes AND to derive each
  // persona's negative set by difference.
  const declaredByPersona = new Map();
  for (const p of personas) {
    const name = String((p && p.persona) || '').trim();
    if (!name) {
      warnings.push('skipped a persona with no name');
      continue;
    }
    declaredByPersona.set(name, declaredPrivileges(p));
  }

  // Every entity ANY persona declares. The negative probes are drawn from this set rather than from
  // the whole data model, because an entity nobody asked for tells us nothing about role design.
  const allEntities = new Set();
  for (const declared of declaredByPersona.values()) {
    for (const d of declared) allEntities.add(d.entity);
  }

  for (const [persona, declared] of declaredByPersona) {
    const ownEntities = new Set(declared.map((d) => d.entity));

    for (const d of declared) {
      if (isMutating(d.access) && !includeMutations) continue;
      probes.push({
        persona,
        entity: d.entity,
        access: d.access,
        scope: d.scope,
        expect: 'allow',
        mutating: isMutating(d.access),
        reason: `persona declares ${d.access} on ${d.entity} at ${d.scope} scope`,
      });
    }

    for (const entity of allEntities) {
      if (ownEntities.has(entity) || NEVER_PROBE_DENIED.has(entity)) continue;
      probes.push({
        persona,
        entity,
        access: 'read',
        scope: null,
        expect: 'deny',
        mutating: false,
        reason: `another persona declares ${entity}; this one does not, so it should not be readable`,
      });
    }
  }

  if (!includeMutations && probes.every((p) => !p.mutating)) {
    const skipped = [...declaredByPersona.values()].flat().filter((d) => isMutating(d.access)).length;
    if (skipped > 0) {
      warnings.push(`${skipped} mutating privilege(s) planned but NOT executed (read-only run; pass --allow-mutations to include them)`);
    }
  }

  return { probes, warnings };
}

/**
 * Turn one raw HTTP outcome into a finding.
 *
 * @param {object} probe   from planProbes
 * @param {object} outcome { status:number|null, rowCount:number|null, error?:string }
 * @returns {{ probe, result: 'pass'|'fail'|'inconclusive', detail: string }}
 *
 * The `inconclusive` result is the load-bearing part. Dataverse expresses "you may not see this"
 * two different ways:
 *   - NO privilege at all            -> 403 Forbidden
 *   - privilege at a NARROWER scope  -> 200 OK with the rows filtered out
 * So an empty 200 on a negative probe is genuinely ambiguous: it looks identical to "authorized, but
 * this table happens to be empty". Reporting that as a pass would manufacture false confidence in
 * exactly the direction that matters, so it is reported as inconclusive and the operator is told
 * what would disambiguate it (seed a row owned by someone else).
 */
function interpretOutcome(probe, outcome) {
  const status = outcome && outcome.status;
  const rowCount = outcome && outcome.rowCount;
  const finding = (result, detail) => ({ probe, result, detail });

  // A transport-level failure is never evidence about authorization.
  if (outcome && outcome.error && status == null) {
    return finding('inconclusive', `request failed before a status was returned: ${outcome.error}`);
  }

  if (probe.expect === 'allow') {
    if (status === 403) return finding('fail', 'denied (403) but the persona declares this privilege');
    if (status === 401) return finding('inconclusive', 'unauthorized (401) — impersonation or auth problem, not a role finding');
    if (status === 404) return finding('fail', 'not found (404) — the entity set does not exist for this persona');
    if (typeof status === 'number' && status >= 200 && status < 300) {
      // A scoped read legitimately returns zero rows; that is not a failure of the grant.
      return finding('pass', rowCount === 0 ? 'authorized (no rows visible at this scope)' : 'authorized');
    }
    return finding('inconclusive', `unexpected status ${status}`);
  }

  // expect === 'deny'
  if (status === 403) return finding('pass', 'correctly denied (403)');
  if (typeof status === 'number' && status >= 200 && status < 300) {
    if (rowCount > 0) {
      return finding('fail', `readable (${rowCount} row(s) visible) but no job declares this entity — the role is broader than the spec`);
    }
    return finding(
      'inconclusive',
      'returned 200 with no rows: cannot distinguish "denied by scope" from "authorized but empty". Seed a row owned by another user to disambiguate.',
    );
  }
  if (status === 401) return finding('inconclusive', 'unauthorized (401) — impersonation or auth problem, not a role finding');
  return finding('inconclusive', `unexpected status ${status}`);
}

/**
 * Roll findings up into a report.
 * `ok` is false when anything FAILED. Inconclusive results do not fail the run — they are genuine
 * unknowns, and failing on them would train the operator to ignore the tool — but they are counted
 * and listed so an all-inconclusive run cannot masquerade as a clean one.
 */
function summarize(findings) {
  const counts = { pass: 0, fail: 0, inconclusive: 0 };
  for (const f of findings) counts[f.result] = (counts[f.result] || 0) + 1;
  return {
    ok: counts.fail === 0,
    counts,
    total: findings.length,
    failures: findings.filter((f) => f.result === 'fail'),
    inconclusive: findings.filter((f) => f.result === 'inconclusive'),
  };
}

/**
 * Execute planned probes against injected IO. Kept here rather than in the CLI so the orchestration
 * — principal resolution, entity-set resolution, error containment — is testable without a network,
 * mirroring how `verifySpec` takes an injected reader.
 *
 * @param {Array} probes from planProbes
 * @param {object} io
 *   principalFor(persona)  -> { header:'CallerObjectId'|'MSCRMCallerID', value:string } | null
 *   entitySetName(entity)  -> Promise<string|null>   (the OData collection name, e.g. co_workorders)
 *   readOne(entitySet, hdr)-> Promise<{ status, rowCount, error? }>
 * @returns {Promise<Array>} findings
 *
 * Every failure mode here degrades to `inconclusive` rather than `fail`. A probe that could not be
 * RUN proves nothing about the role, and reporting it as a role failure would send the operator to
 * fix a security role when the real problem is a missing test user or an unresolvable entity.
 */
async function executeProbes(probes, io) {
  const findings = [];
  // One metadata read per entity, not per probe — the negative probes alone are O(personas × entities).
  const setNameCache = new Map();
  const principalCache = new Map();

  for (const probe of probes) {
    if (!principalCache.has(probe.persona)) {
      principalCache.set(probe.persona, io.principalFor(probe.persona));
    }
    const principal = principalCache.get(probe.persona);
    if (!principal) {
      findings.push({
        probe,
        result: 'inconclusive',
        detail: `no test user for persona '${probe.persona}' — declare assignTo.users[] or assign the role to a user`,
      });
      continue;
    }

    if (!setNameCache.has(probe.entity)) {
      let name = null;
      try {
        name = await io.entitySetName(probe.entity);
      } catch (err) {
        name = null;
        void err;
      }
      setNameCache.set(probe.entity, name);
    }
    const entitySet = setNameCache.get(probe.entity);
    if (!entitySet) {
      findings.push({
        probe,
        result: 'inconclusive',
        detail: `could not resolve the entity set name for '${probe.entity}'`,
      });
      continue;
    }

    let outcome;
    try {
      outcome = await io.readOne(entitySet, { [principal.header]: principal.value });
    } catch (err) {
      outcome = { status: null, rowCount: null, error: (err && err.message) || String(err) };
    }
    findings.push(interpretOutcome(probe, outcome));
  }

  return findings;
}

module.exports = { planProbes, interpretOutcome, executeProbes, summarize, isMutating };
