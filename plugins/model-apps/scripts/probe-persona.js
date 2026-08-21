#!/usr/bin/env node
'use strict';
// probe-persona: run authorization probes AS each persona, using Dataverse impersonation.
//
// `role-privileges` (in verify) proves the deployed role HOLDS the declared privileges. That is a
// metadata comparison and it stops there. Whether the persona can actually perform the operation
// also depends on record ownership, business-unit placement, team membership, sharing, and
// server-side plug-ins — none of which appear in `roleprivileges`. This probe executes real reads as
// the persona and reports what actually happens.
//
// It also probes the NEGATIVE direction, which nothing else does: for each persona it reads an
// entity that some OTHER persona declares and this one does not. An over-broad role is invisible
// from the inside — every operation the user tries succeeds — so it is only detectable by trying
// something that should fail.
//
// Usage:
//   node probe-persona.js --env <orgUrl> --spec @<app-folder>/app-spec.json
//                         [--workspace <dir>] [--allow-mutations]
//
// Read-only by default: only `read` privileges are executed. `--allow-mutations` additionally PLANS
// create/write/delete probes; they are reported as planned but still not executed, because writing
// to someone's environment to verify it is a trap that belongs behind its own explicit design.
//
// Output: { ok, personas, counts, failures, inconclusive, warnings }

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, readJsonArg, emitResult } = require('./lib/dataverse-auth.js');
const { createAzHttpClient } = require('./lib/sdk-http-client.js');
const { migrateAppSpec, validateAppSpec } = require('./lib/app-spec.js');
const { planProbes, executeProbes, summarize } = require('./lib/persona-probe.js');

const API = 'api/data/v9.2';

function makeProvision(env, workspaceDir) {
  const { createMakerSdk } = require('./vendor/cds-maker-sdk.cjs');
  const httpClient = createAzHttpClient(env);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const sdk = createMakerSdk({ workspacePath: workspaceDir, instanceUrl: env, httpClient });
  sdk.initWorkspace();
  return { sdk, httpClient };
}

// `WhoAmI` under impersonation is the canary for this whole tool.
//
// The dangerous failure is NOT a 403 — that is loud. It is the header being accepted and IGNORED:
// every probe would then run as the (System Administrator) caller, every allow-probe would pass,
// every deny-probe would report the role as over-broad or come back readable, and the run would look
// authoritative while proving nothing. `WhoAmI` returns the EFFECTIVE user id, so comparing it to
// the impersonated id detects that silently.
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/whoami
//
// `expectedSystemUserId` is the target's `systemuserid`, which is directly comparable to
// `WhoAmI().UserId`. It is checked FIRST and is the only positive proof, because "effective ==
// caller" is NOT by itself evidence of a dropped header: a persona's test user is allowed to BE the
// signed-in user (a single-account dev environment, or an admin validating their own persona), and
// treating that as a failure would block a legitimate configuration. Note the target is always
// known — `assignTo.users[]` carries a systemuserid even when the request upgrades to
// `CallerObjectId`, which sends the Entra object id instead.
async function checkImpersonation(httpClient, apiRoot, header, value, expectedSystemUserId) {
  const bare = await httpClient.get(`${apiRoot}/WhoAmI()`);
  if (!bare || bare.status < 200 || bare.status >= 300) {
    return { ok: false, detail: `WhoAmI failed as the signed-in user (status ${bare && bare.status}) — check --env and az login` };
  }
  const callerId = String((bare.body && bare.body.UserId) || '').toLowerCase();

  const asUser = await httpClient.get(`${apiRoot}/WhoAmI()`, { headers: { [header]: value } });
  if (asUser && asUser.status === 403) {
    return { ok: false, detail: 'impersonation refused (403) — the signed-in user needs prvActOnBehalfOfAnotherUser ("Act on Behalf of Another User"), assigned DIRECTLY and not inherited from a team' };
  }
  if (!asUser || asUser.status < 200 || asUser.status >= 300) {
    return { ok: false, detail: `impersonated WhoAmI failed (status ${asUser && asUser.status})` };
  }
  const effectiveId = String((asUser.body && asUser.body.UserId) || '').toLowerCase();
  const expected = String(expectedSystemUserId || '').toLowerCase();

  // Positive proof: the request really ran as the target. Correct even when the target IS the caller.
  if (expected && effectiveId && effectiveId === expected) return { ok: true, effectiveId };

  if (effectiveId && callerId && effectiveId === callerId) {
    return expected
      ? { ok: false, detail: `the ${header} header was accepted but IGNORED — the request ran as the signed-in user, not as the target persona user (${expected}); every probe would report false passes` }
      // No target to compare against, so this is the older, weaker heuristic: it cannot tell a
      // dropped header apart from a persona whose test user is the signed-in user.
      : { ok: false, detail: `the ${header} header appears to have been IGNORED — the request ran as the signed-in user, and no target systemuserid was available to confirm otherwise` };
  }
  if (expected && effectiveId && effectiveId !== expected) {
    return { ok: false, detail: `the ${header} header resolved to an unexpected principal (${effectiveId}, expected ${expected}) — probes would describe the wrong user` };
  }
  return { ok: true, effectiveId };
}

// Resolve the principal to impersonate for a persona.
//
// `personas[].assignTo.users[]` already carries Dataverse `systemuserid` GUIDs, which is exactly what
// the legacy `MSCRMCallerID` header takes — so in the common case no directory lookup is needed at
// all. `CallerObjectId` (the Entra object id) is the documented preference, so try to upgrade to it
// with one read of `azureactivedirectoryobjectid` and fall back when that is unavailable.
function makePrincipalResolver(spec, sdk, cache) {
  return (personaName) => {
    const persona = ((spec && spec.personas) || []).find((p) => p && p.persona === personaName);
    const users = (persona && persona.assignTo && persona.assignTo.users) || [];
    const systemUserId = users.find((u) => typeof u === 'string' && u.trim());
    if (!systemUserId) return null;
    const oid = cache.get(String(systemUserId).toLowerCase());
    // `systemUserId` is carried alongside the header regardless of which header is used: the
    // impersonation canary compares it to `WhoAmI().UserId`, and under `CallerObjectId` the header
    // value itself is an Entra object id that cannot be compared to a systemuserid.
    return oid
      ? { header: 'CallerObjectId', value: oid, systemUserId: String(systemUserId).trim() }
      : { header: 'MSCRMCallerID', value: String(systemUserId).trim(), systemUserId: String(systemUserId).trim() };
  };
}

async function loadObjectIds(sdk, spec) {
  // One query for every declared test user; a miss simply leaves the persona on MSCRMCallerID.
  const ids = new Set();
  for (const p of (spec && spec.personas) || []) {
    for (const u of (p && p.assignTo && p.assignTo.users) || []) {
      if (typeof u === 'string' && u.trim()) ids.add(u.trim().toLowerCase());
    }
  }
  const cache = new Map();
  for (const id of ids) {
    try {
      const rows = await sdk.queryRecords('systemuser', {
        select: ['systemuserid', 'azureactivedirectoryobjectid'],
        filter: `systemuserid eq ${id}`, // Edm.Guid — UNQUOTED
        top: 1,
      });
      const oid = rows && rows[0] && rows[0].azureactivedirectoryobjectid;
      if (oid) cache.set(id, String(oid));
    } catch {
      // A missing/unreadable user is not fatal: the probe falls back to MSCRMCallerID, and a truly
      // absent user surfaces later as an inconclusive finding naming the persona.
    }
  }
  return cache;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const env = typeof flags.env === 'string' ? flags.env : undefined;
  const specArg = typeof flags.spec === 'string' ? flags.spec : positional[0];
  if (!env || !specArg) {
    process.stderr.write('Usage: node probe-persona.js --env <orgUrl> --spec @<app-folder>/app-spec.json [--allow-mutations]\n');
    process.exit(1);
  }

  const specPath = path.resolve(specArg.startsWith('@') ? specArg.slice(1) : specArg);
  const spec = migrateAppSpec(readJsonArg('@' + specPath));
  const v = validateAppSpec(spec, { profile: 'deploy' });
  if (!v.ok) { emitResult(false, { ok: false, errors: v.errors }); return; }

  const workspaceDir = typeof flags.workspace === 'string'
    ? flags.workspace
    : path.join(path.dirname(specPath), '.maker-workspace');
  const apiRoot = `${String(env).replace(/\/+$/, '')}/${API}`;
  const { sdk, httpClient } = makeProvision(env, workspaceDir);

  const { probes, warnings } = planProbes(spec, { includeMutations: flags['allow-mutations'] === true });
  if (probes.length === 0) { emitResult(true, { ok: true, probes: 0, warnings }); return; }

  const oidCache = await loadObjectIds(sdk, spec);
  const principalFor = makePrincipalResolver(spec, sdk, oidCache);

  // Preflight once, on the first persona that actually has a principal. Impersonation is an
  // environment-wide capability, so a second check would cost a round trip and tell us nothing new.
  const firstPrincipal = [...new Set(probes.map((p) => p.persona))].map(principalFor).find(Boolean);
  if (!firstPrincipal) {
    emitResult(false, {
      ok: false,
      probes: 0,
      warnings: [...warnings, 'no persona declares assignTo.users[], so there is no principal to impersonate — nothing could be probed'],
    });
    return;
  }
  const pre = await checkImpersonation(httpClient, apiRoot, firstPrincipal.header, firstPrincipal.value, firstPrincipal.systemUserId);
  if (!pre.ok) { emitResult(false, { ok: false, preflight: pre.detail, warnings }); return; }

  const findings = await executeProbes(probes, {
    principalFor,
    entitySetName: async (entity) => {
      const meta = await sdk.fetchEntityMetadata(String(entity).toLowerCase());
      return (meta && (meta.entitySetName || meta.EntitySetName)) || null;
    },
    // `$top=1` is enough: we are testing authorization, not paging. `rowCount` only needs to
    // distinguish "some rows visible" from "none", which is what makes a negative probe conclusive.
    readOne: async (entitySet, headers) => {
      const res = await httpClient.get(`${apiRoot}/${entitySet}?$top=1`, { headers });
      const value = res && res.body && res.body.value;
      return {
        status: res && res.status,
        rowCount: Array.isArray(value) ? value.length : null,
      };
    },
  });

  const s = summarize(findings);
  for (const f of findings) {
    const mark = f.result === 'pass' ? '✓' : f.result === 'fail' ? '✗' : '?';
    process.stderr.write(`  ${mark} [${f.probe.persona}] ${f.probe.expect} ${f.probe.access} ${f.probe.entity} — ${f.detail}\n`);
  }
  process.stderr.write(`\n${s.ok ? '✓ probe PASS' : `✗ probe FAIL — ${s.counts.fail} failing`} (${s.counts.pass} pass, ${s.counts.fail} fail, ${s.counts.inconclusive} inconclusive)\n`);
  if (s.counts.inconclusive > 0) {
    process.stderr.write('  note: inconclusive probes proved nothing either way — they are not passes.\n');
  }

  emitResult(s.ok, {
    ok: s.ok,
    counts: s.counts,
    total: s.total,
    failures: s.failures.map((f) => `${f.probe.persona}:${f.probe.entity}:${f.probe.access} (${f.detail})`),
    inconclusive: s.inconclusive.map((f) => `${f.probe.persona}:${f.probe.entity}:${f.probe.access} (${f.detail})`),
    warnings,
  });
}

if (require.main === module) {
  main().catch((err) => emitResult(false, err));
}

module.exports = { checkImpersonation, makePrincipalResolver, main };
