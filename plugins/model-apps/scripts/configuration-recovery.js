#!/usr/bin/env node
'use strict';
// Read-only recovery of interrupted default configuration creates (#807).
//
// WHY. A default build saves a receipt in the app workspace (lib/configuration-create-state.js) before it creates environment
// variables, connection references, Custom APIs or duplicate detection rules, and every build, changed-only run and teardown stops
// while that receipt holds an unfinished unit (lib/configuration-create-guard.js). This command is the one way forward: it reads the
// environment with GETs only, says what it found, and changes nothing but the local receipt. It never creates, updates or deletes a
// service row, never adds solution membership and never publishes; a missing row is described for a person to complete by hand, never
// sent from here.
//
// Usage:
//   node configuration-recovery.js inspect --app-dir <app-folder> [--env <envUrl>]
//   node configuration-recovery.js prepare --app-dir <app-folder> --env <envUrl> --unit <unitId>
//        --resolution accept-current|defer|cancel-unsent [--deployment-settings <file>]
//   node configuration-recovery.js resolve --app-dir <app-folder> --env <envUrl> --unit <unitId>
//        --resolution accept-current|defer|cancel-unsent --approval-token <token> [--accept-current-private-state]
//        [--deployment-settings <file>]
//   node configuration-recovery.js resolve --app-dir <app-folder> --resolution quarantine-unreadable
//        --acknowledge-unknown-dispatch [--quarantine-id <id>]
// `--spec @<app-folder>/app-spec.json` and `--workspace <dir>` may stand for `--app-dir`, as the build accepts them; the workspace is the
// build's (`<app-folder>/.maker-workspace` unless --workspace names another). `--language-code <lcid>` overrides the receipt's language.
//
// `--env` is required for prepare and resolve of a unit, even a deferral that reads nothing: the receipt keeps only a fingerprint of the
// environment, and a resolution must be checked against the environment it is meant for BEFORE anything is read or changed. Inspect
// without `--env` reports only what the workspace holds.
//
// Result contract: stdout is one JSON object. Inspect and prepare exit 0 with `ok: true`. Every refusal exits 1 with
// `{ ok: false, code, retry: 'never', error, unitId?, rootId?, rootKind?, reason?, nextStep? }`. A completed resolution is NOT a build
// success: it exits 1 with `code: 'configuration-create-reconciled'`, and the next build is a fresh invocation.

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, validateFlags, readJsonArg, emitResult, dataverseOrigin } = require('./lib/dataverse-auth.js');
const { migrateAppSpec } = require('./lib/app-spec.js');
const { appUniqueName } = require('./lib/app-unique-name.js');
const { withAppBuildLease } = require('./lib/app-operation-lease.js');
const { readOnlyHttpClient } = require('./lib/readonly-operations.js');
const { isRestrictedSolution } = require('./lib/system-solutions.js');
const A = require('./lib/configuration-artifacts.js');
const B = require('./lib/configuration-create-bindings.js');
const P = require('./lib/configuration-create-plan.js');
const S = require('./lib/configuration-create-state.js');
const R = require('./lib/configuration-create-recovery.js');
const { createDeclarationsOf } = require('./lib/configuration-create-guard.js');
const { legacyConfigurationArtifacts, checkLegacyConfigurationPair } = require('./lib/workspace-configuration-memory.js');

const USAGE = 'Usage: node scripts/configuration-recovery.js inspect|prepare|resolve --app-dir <app-folder> [--env <url>] '
  + '[--unit <unitId>] [--resolution accept-current|defer|cancel-unsent|quarantine-unreadable] [--approval-token <token>] '
  + '[--accept-current-private-state] [--acknowledge-unknown-dispatch] [--quarantine-id <id>] [--deployment-settings <file>] '
  + '[--spec @<app-folder>/app-spec.json] [--workspace <dir>] [--language-code <lcid>]';
const COMMANDS = ['inspect', 'prepare', 'resolve'];
const UNIT_RESOLUTIONS = ['accept-current', 'defer', 'cancel-unsent'];
const KT = P.CONFIGURATION_CREATE_KIND_TABLE;
const RECEIPT_KT = P.CONFIGURATION_CREATE_RECEIPT_KIND_TABLE;
// The SDK's Dataverse API root (see lib/app-component-scope.js: the SDK's client posts under /api/data/v9.0).
const API_ROOT = '/api/data/v9.0';

const lower = (s) => String(s).toLowerCase();
const halt = S.configurationCreateHalt;

class UsageError extends Error {}

// ── The read ports ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The four reads lib/configuration-create-recovery.js accepts (createReadOnlyRecoveryContext refuses anything more), over a GET-only
// Dataverse reader: `get(path)` below the API root and `getAbsolute(url)` for a continuation, each answering { status, body }.
// The rows are read with the same readers and columns the build's own verification reads use (configuration-create-bindings.js
// readDefaultConfigurationRow / readAllPages, configuration-create-plan.js captureConfigurationBaseline), so recovery and the build
// judge one row the same way. A value row's or a connection reference's private column is read by the exact-id read as the build's
// verification reads it, kept in memory only and dropped by the public projection; the child list leaves it out of the query.
function readPortsOver(dataverse, { solutionUniqueName }) {
  let componentTypes = null;
  const typesOnce = async () => {
    if (!componentTypes || !componentTypes.complete) componentTypes = await B.readComponentTypes(dataverse);
    return componentTypes;
  };
  return {
    async readRow(kind, id) {
      const got = await B.readDefaultConfigurationRow(dataverse, KT[kind].bindingKind, id);
      if (got && got.state === 'present') return { ok: true, row: got };
      if (got && got.state === 'absent') return { ok: false, missing: true };
      return { ok: false };
    },
    async readChildren(rootKind, rootId) {
      const children = [];
      for (const childTag of KT[rootKind].childKinds) {
        const bindingKind = KT[childTag].bindingKind;
        const k = B.KINDS[bindingKind];
        const columns = B.DEFAULT_READ_COLUMNS[bindingKind].filter((col) => col !== k.privateColumn);
        // GET /customapirequestparameters?$select=customapirequestparameterid,uniquename,...&$filter=_customapiid_value eq <api id>
        const page = await B.readAllPages(dataverse, `/${k.set}?$select=${[k.pk, ...columns].join(',')}&$filter=${k.parentColumn} eq ${rootId}`);
        if (!page || page.complete !== true || !Array.isArray(page.rows)) return { ok: false };
        for (const row of page.rows) children.push({ kind: childTag, row });
      }
      return { ok: true, children };
    },
    // Solution membership of one recorded row. A value row is never a solution member (it is per-environment data), and a restricted
    // solution (Default, Active) plans no membership, so neither is required. Anything that cannot be read is unreadable, never absent.
    async readMembership(kind, id) {
      const bindingKind = KT[kind].bindingKind;
      const table = Object.prototype.hasOwnProperty.call(A.MEMBERSHIP_TABLES, bindingKind) ? A.MEMBERSHIP_TABLES[bindingKind] : A.CHILD_MEMBERSHIP_TABLES[bindingKind];
      if (table === undefined || isRestrictedSolution(solutionUniqueName)) return { ok: true, required: false };
      let componentType = table;
      if (typeof table !== 'number') {
        const types = await typesOnce();
        if (!types.complete || !Number.isInteger(types.types[table])) return { ok: false };
        componentType = types.types[table];
      }
      const [member] = await B.readMembers(dataverse, { solution: solutionUniqueName, plan: { members: [{ kind: bindingKind, id, componentType }] } });
      if (!member || member.state === 'unknown') return { ok: false };
      return { ok: true, member: member.state === 'present' };
    },
    projectObserved(kind, row) {
      const k = KT[kind];
      const p = P.publicProjectionFromObserved(kind, row);
      if (!p.ok) return null;
      const rowId = row && row.state === 'present' ? row.id : row && row[B.KINDS[k.bindingKind].pk];
      const out = { id: S.isCanonicalGuid(lower(rowId || '')) ? lower(rowId) : null, parentId: k.root ? null : p.public.parentId, public: p.public };
      // ruleStateOf answers 'unpublished' | 'published', or null while the service is still publishing it.
      if (kind === 'duplicate-rule') out.lifecycle = p.ruleState || 'publishing';
      return out;
    },
  };
}

// A GET-only Dataverse reader over the plugin's az-token client. The client is made on the first read, so a resolution that reads
// nothing (defer, cancel-unsent, quarantine) never asks for a token. Every write method is refused by readOnlyHttpClient before it is
// sent, and a continuation link must stay under the same API root.
function dataverseReaderFor(origin, makeClient) {
  const root = `${origin}${API_ROOT}`;
  let wrapped = null;
  const client = () => {
    if (!wrapped) wrapped = readOnlyHttpClient(makeClient(origin));
    return wrapped.client;
  };
  return {
    get: (p) => client().get(`${root}${p}`),
    getAbsolute: (url) => {
      if (typeof url !== 'string' || !url.startsWith(`${root}/`)) return Promise.reject(new Error('a continuation outside the API root was refused'));
      return client().get(url);
    },
    stats: () => (wrapped ? { gets: wrapped.stats.gets, refusedWrites: wrapped.stats.refusedWrites } : { gets: 0, refusedWrites: 0 }),
  };
}

// ── The current intent ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
// What the App Spec asks of a recorded unit's root today, as the hash accept-current compares with the recorded one
// (configuration-create-plan.js publicIntentSha256: the root's kind and key, each new row's kind, key and public fields, whether a
// new rule must be published; no ids). It is compiled the way the build compiled the unit: a unit that preserved an existing root
// is compiled over that root (its recorded projection standing for the baseline) with the slots it created. A data-source variable's
// parent definition id is the one recorded, so the intent compares the declaration, not where its parent lives. Answers null when
// the declaration is gone or no longer compiles: recovery then refuses `configuration-create-intent-changed`.
function currentIntentOf(spec, unit, { bindings, solution }) {
  try {
    const rootRow = unit.rows.find((r) => r.id === unit.root.id);
    const bindingKind = KT[unit.root.kind].bindingKind;
    const recordedParent = unit.root.kind === 'env-definition' && rootRow.public.parentDefinitionId ? rootRow.public.parentDefinitionId : null;
    let parentKey = null;
    if (recordedParent) {
      const entry = A.configurationIntentOf(spec, bindingKind, unit.root.key);
      if (typeof entry.parentSchemaName === 'string' && entry.parentSchemaName) parentKey = A.portKeyOf('environmentVariable', entry.parentSchemaName);
    }
    const boundIdOf = (k, key) => (parentKey && k === 'environmentVariable' && key === parentKey ? recordedParent : undefined);
    const options = { kind: unit.root.kind, key: unit.root.key, bindings, solution, boundIdOf };
    if (rootRow.role === 'preserved') {
      options.baseline = {
        ok: true,
        root: { kind: unit.root.kind, id: unit.root.id, public: rootRow.public, ...(unit.root.kind === 'duplicate-rule' ? { ruleState: 'unpublished' } : {}) },
        children: unit.rows.filter((r) => r.role === 'preserved' && r.id !== unit.root.id).map((r) => ({ kind: r.kind, id: r.id, parentId: r.parentId, public: r.public })),
      };
      options.additions = unit.rows.filter((r) => r.role === 'create').map((r) => r.key);
    }
    const compiled = P.compileConfigurationCreateUnit(spec, options);
    return compiled.ok ? compiled.unit.publicIntentSha256 : null;
  } catch {
    return null;
  }
}

// ── Arguments ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function readArguments(argv) {
  const flagError = validateFlags(argv, {
    known: ['app-dir', 'spec', 'workspace', 'env', 'unit', 'resolution', 'approval-token', 'accept-current-private-state',
      'acknowledge-unknown-dispatch', 'quarantine-id', 'deployment-settings', 'language-code'],
    needValue: ['app-dir', 'spec', 'workspace', 'env', 'unit', 'resolution', 'approval-token', 'quarantine-id', 'deployment-settings', 'language-code'],
  });
  if (flagError) throw new UsageError(flagError);
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];
  if (!COMMANDS.includes(command) || positional.length !== 1) throw new UsageError('name one command: inspect, prepare or resolve');
  if (flags['app-dir'] && flags.spec) throw new UsageError('pass --app-dir or --spec, not both');
  if (!flags['app-dir'] && !flags.spec) throw new UsageError('--app-dir is required');
  const specPath = flags.spec
    ? path.resolve(flags.spec.startsWith('@') ? flags.spec.slice(1) : flags.spec)
    : path.join(path.resolve(flags['app-dir']), 'app-spec.json');
  const workspaceDir = path.resolve(flags.workspace || path.join(path.dirname(specPath), '.maker-workspace'));
  let origin = null;
  if (flags.env !== undefined) {
    origin = dataverseOrigin(flags.env);
    if (!origin) throw new UsageError(`--env is not a Dataverse environment URL; pass its https origin only, for example https://contoso.crm.dynamics.com`);
  }
  let languageCode;
  if (flags['language-code'] !== undefined) {
    languageCode = Number(flags['language-code']);
    if (!Number.isSafeInteger(languageCode) || languageCode <= 0) throw new UsageError('--language-code is not a language code (an integer such as 1033)');
  }
  const resolution = flags.resolution;
  const quarantine = resolution === 'quarantine-unreadable';
  const unitFlags = ['unit', 'approval-token', 'accept-current-private-state', 'deployment-settings'];
  if (command === 'inspect') {
    for (const f of ['unit', 'resolution', 'approval-token', 'accept-current-private-state', 'acknowledge-unknown-dispatch', 'quarantine-id', 'deployment-settings']) {
      if (flags[f] !== undefined) throw new UsageError(`--${f} is not an inspect option`);
    }
  } else if (quarantine) {
    if (command !== 'resolve') throw new UsageError('quarantine-unreadable is a resolve, with no prepare step');
    for (const f of unitFlags) if (flags[f] !== undefined) throw new UsageError(`--${f} does not apply to quarantine-unreadable`);
    if (flags['acknowledge-unknown-dispatch'] !== true) {
      throw new UsageError('quarantine-unreadable needs --acknowledge-unknown-dispatch: the receipt cannot say what was sent, and a later configuration build may send those rows again at the same ids');
    }
  } else {
    if (!UNIT_RESOLUTIONS.includes(resolution)) throw new UsageError('--resolution must be accept-current, defer, cancel-unsent or quarantine-unreadable');
    if (!flags.unit) throw new UsageError('--unit <unitId> is required (inspect lists the unit ids)');
    if (!origin) throw new UsageError('--env is required: a resolution is checked against the environment it is meant for before anything is read or changed');
    for (const f of ['acknowledge-unknown-dispatch', 'quarantine-id']) if (flags[f] !== undefined) throw new UsageError(`--${f} applies only to quarantine-unreadable`);
    if (command === 'prepare' && (flags['approval-token'] !== undefined || flags['accept-current-private-state'] !== undefined)) {
      throw new UsageError('--approval-token and --accept-current-private-state belong to resolve');
    }
    if (command === 'resolve' && !flags['approval-token']) throw new UsageError('--approval-token is required (prepare prints it)');
    if (flags['accept-current-private-state'] !== undefined && resolution !== 'accept-current') {
      throw new UsageError('--accept-current-private-state applies only to accept-current');
    }
  }
  return { command, flags, specPath, workspaceDir, origin, languageCode, resolution, quarantine };
}

function readSpec(specPath) {
  let raw;
  try {
    raw = readJsonArg('@' + specPath);
  } catch (err) {
    throw new UsageError(`cannot read the App Spec ${specPath} (${err && err.code ? err.code : 'not valid JSON'})`);
  }
  return migrateAppSpec(raw);
}

// --deployment-settings: the same file and reader the build uses (build-model-app.js). It can hold secrets, so no message quotes it:
// a JSON error names the file only and readDeploymentBindings' errors name entries, never values. A UTF-8 BOM is dropped first.
function readBindings(file, spec) {
  if (typeof file !== 'string') return { environmentVariables: new Map(), connectionReferences: new Map() };
  const at = path.resolve(file);
  let text;
  try {
    text = fs.readFileSync(at, 'utf8');
  } catch (err) {
    throw new UsageError(`--deployment-settings: cannot read ${at} (${(err && err.code) || 'error'})`);
  }
  let settings;
  try {
    settings = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new UsageError(`--deployment-settings: ${at} is not valid JSON`);
  }
  const bindings = A.readDeploymentBindings(settings, spec);
  if (bindings.errors.length) throw new UsageError(`--deployment-settings: ${bindings.errors.join('; ')}`);
  return bindings;
}

// The context a resolution is checked against: this environment, the App Spec's solution and app, and the language named now or,
// when none is, the receipt's own (the build resolves the same language from the environment).
function contextOf({ origin, spec, languageCode, saved }) {
  const language = languageCode !== undefined ? languageCode : saved ? saved.authoringLanguageCode : null;
  return S.createStateContext({
    environmentUrl: origin,
    solutionUniqueName: spec && spec.solution && spec.solution.uniqueName,
    appUniqueName: appUniqueName(spec),
    authoringLanguageCode: language === undefined ? null : language,
  });
}

// Before a receipt changes, every environment-variable or connection-reference copy an earlier plugin version left in the workspace must
// be proved clean (workspace-configuration-memory.js): a copy that may hold an unsent edit is a local draft the operator must see first.
function localDraftCheck(workspaceDir) {
  return async () => {
    const { createNodeWorkspaceStorage } = require('./lib/maker-sdk.js');
    const storage = createNodeWorkspaceStorage(workspaceDir);
    for (const { folder, id } of legacyConfigurationArtifacts(storage)) await checkLegacyConfigurationPair(storage, folder, id);
  };
}

// ── Results ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function refusal(command, error) {
  const out = { ok: false, command, code: error.code, retry: 'never', error: error.message };
  for (const field of ['unitId', 'rootId', 'rootKind', 'reason', 'nextStep', 'transition']) {
    if (error[field] !== undefined && error[field] !== null) out[field] = error[field];
  }
  return out;
}

const halted = (e) => !!e && (e.name === 'ConfigurationCreateHalt' || (typeof e.code === 'string' && e.code.length > 0));

function haltSummary(e) {
  if (!e) return null;
  const out = { code: e.code, message: e.message };
  if (e.reason) out.reason = e.reason;
  return out;
}

const MANUAL_COMPLETION_NOTE = 'Not executed. To complete a missing row by hand, send one POST to its entity set with its recorded id in the '
  + 'id column, its recorded parent and these public fields, plus the private inputs named in privateFields supplied out of band. Never '
  + 'PATCH, upsert, use a new id, or delete and recreate. The earlier request may still run, and a duplicate-id refusal does not prove '
  + 'its side effects ran exactly once. Then run inspect again.';

function localUnitOf(unit) {
  return {
    unitId: unit.unitId,
    state: unit.state,
    root: { ...unit.root },
    rows: unit.rows.map((r) => ({ kind: r.kind, key: r.key, id: r.id, parentId: r.parentId, role: r.role, dispatch: r.dispatch })),
    publication: unit.publication ? unit.publication.dispatch : null,
  };
}

function inspectedUnitOf(inspection) {
  return {
    unitId: inspection.unitId,
    state: inspection.state,
    root: { ...inspection.root },
    dispatch: inspection.dispatch,
    publication: inspection.publication,
    outcome: inspection.observation.outcome,
    observation: inspection.observation,
    halt: haltSummary(inspection.halt),
    nextStep: inspection.nextStep,
    manualCompletion: inspection.manualCompletion.map((m) => ({
      method: 'POST', entitySet: KT[m.kind].entitySet, idColumn: KT[m.kind].idColumn, ...m,
    })),
  };
}

async function inspect(args, spec, deps) {
  const discovery = S.discoverConfigurationCreateState(args.workspaceDir, { kindTable: RECEIPT_KT });
  const saved = discovery.sidecar.status === 'valid' ? discovery.sidecar.state : null;
  const units = saved ? saved.units : [];
  const payload = {
    ok: true,
    command: 'inspect',
    workspaceDir: args.workspaceDir,
    receipt: discovery.sidecar.status,
    ...(discovery.sidecar.status === 'invalid' ? { receiptReason: discovery.sidecar.reason } : {}),
    ...(saved ? { revision: saved.revision } : {}),
    quarantines: discovery.quarantines.map((q) => ({ ...q })),
    orphanArchives: discovery.orphanArchives.slice(),
    unknownEntries: discovery.unknownEntries,
    units: [],
    serviceReads: 0,
  };
  if (saved && args.origin && units.length) {
    // The context is compared BEFORE any read: a receipt of another environment must never send reads to the one named now.
    const context = contextOf({ origin: args.origin, spec, languageCode: args.languageCode, saved });
    if (!S.sameCreateStateContext(saved, context)) throw halt('configuration-create-context-mismatch', { reason: 'the receipt was saved for another environment, solution, app or language' });
    const reader = dataverseReaderFor(args.origin, deps.httpClient);
    const ctx = R.createReadOnlyRecoveryContext(readPortsOver(reader, { solutionUniqueName: saved.solutionUniqueName }));
    for (const unit of units) payload.units.push(inspectedUnitOf(await R.inspectCreateUnit(ctx, unit, { kindTable: RECEIPT_KT })));
    payload.serviceReads = reader.stats().gets;
    payload.manualCompletionNote = MANUAL_COMPLETION_NOTE;
  } else {
    payload.units = units.map(localUnitOf);
  }
  const open = units.filter((u) => u.state === 'open').length;
  payload.clear = !discovery.blocking && open === 0 && discovery.quarantines.length === 0 && units.length === 0;
  payload.nextSteps = nextStepsOf(payload, { open, deferred: units.length - open, local: !(saved && args.origin && units.length) });
  return payload;
}

function nextStepsOf(payload, { open, deferred, local }) {
  const steps = [];
  if (payload.receipt === 'invalid') {
    steps.push('The receipt cannot be read or verified. Keep the file. Restore a trustworthy copy if you have one; otherwise run resolve --resolution quarantine-unreadable --acknowledge-unknown-dispatch to move its bytes aside under a tombstone.');
  }
  if (payload.unknownEntries > 0 || payload.orphanArchives.length > 0 || payload.quarantines.some((q) => q.status === 'invalid' || q.state === 'archiving' || !q.archive)) {
    steps.push('The workspace holds unfinished or unrecognised recovery files. If a quarantine is still archiving, run resolve --resolution quarantine-unreadable --acknowledge-unknown-dispatch --quarantine-id <id> to finish it; keep every file.');
  }
  if (open > 0 && local) steps.push('Run inspect again with --env <envUrl> to read the recorded rows from the environment.');
  if (open > 0 && !local) steps.push('For each open unit: when its outcome is match, run prepare --resolution accept-current; otherwise complete or preserve the rows as its nextStep says, or prepare --resolution defer after removing its root from the App Spec.');
  if (deferred > 0) steps.push('Deferred units stay recorded: a build stops if the App Spec brings their root back.');
  const quarantineIds = payload.quarantines.filter((q) => q.status === 'valid' && q.state === 'deferred').map((q) => q.quarantineId);
  if (quarantineIds.length) {
    steps.push(`A configuration build stops while quarantines exist. To continue, pass --acknowledge-quarantined-configuration ${quarantineIds.join(',')} to that one build, accepting it may send rows again at the ids an earlier build may already have used.`);
  }
  if (!steps.length) steps.push('Nothing to recover: no configuration create is recorded in this workspace.');
  return steps;
}

async function resolveUnit(args, spec, deps) {
  if (!fs.existsSync(args.workspaceDir)) throw halt('configuration-create-approval-stale', { reason: 'the workspace holds no saved unit' });
  return withLease(args, spec, deps, async () => {
    const saved = S.readConfigurationCreateState(args.workspaceDir, { kindTable: RECEIPT_KT });
    const context = contextOf({ origin: args.origin, spec, languageCode: args.languageCode, saved });
    const unit = saved && saved.units.find((u) => u.unitId === lower(args.flags.unit));
    const bindings = args.resolution === 'accept-current' ? readBindings(args.flags['deployment-settings'], spec) : undefined;
    const reader = dataverseReaderFor(args.origin, deps.httpClient);
    const ctx = R.createReadOnlyRecoveryContext(readPortsOver(reader, { solutionUniqueName: saved ? saved.solutionUniqueName : '' }));
    const options = {
      workspaceDir: args.workspaceDir,
      kindTable: RECEIPT_KT,
      context,
      unitId: lower(args.flags.unit),
      mode: args.resolution,
      // Computed only when a unit is there to compare it with; an unknown unit is refused by the recovery module (approval-stale).
      currentPublicIntentSha256: args.resolution === 'accept-current' && unit ? currentIntentOf(spec, unit, { bindings, solution: saved.solutionUniqueName }) : undefined,
      declarations: createDeclarationsOf(spec),
      checkLocalDrafts: localDraftCheck(args.workspaceDir),
      ...(deps.invalidate ? { invalidate: deps.invalidate } : {}),
      ...(deps.leaseDeps ? { leaseDeps: deps.leaseDeps } : {}),
    };
    if (args.command === 'prepare') {
      const prepared = await R.prepareConfigurationResolution(ctx, options);
      const resolve = `resolve --resolution ${args.resolution} --unit ${options.unitId} --approval-token ${prepared.token}${prepared.privateAcknowledgmentRequired ? ' --accept-current-private-state' : ''}`;
      return {
        ok: true,
        payload: {
          ok: true,
          command: 'prepare',
          unitId: options.unitId,
          resolution: args.resolution,
          approvalToken: prepared.token,
          revision: prepared.revision,
          privateAcknowledgmentRequired: prepared.privateAcknowledgmentRequired,
          observation: prepared.observation,
          serviceReads: reader.stats().gets,
          nextStep: prepared.privateAcknowledgmentRequired
            ? `Review the current private values of this unit (they were not compared and are not shown), then run ${resolve}. The token works once.`
            : `Run ${resolve}. The token works once, and only while nothing in the workspace or the environment has changed.`,
        },
      };
    }
    const done = await R.resolveConfigurationResolution(ctx, {
      ...options,
      token: args.flags['approval-token'],
      acceptCurrentPrivateState: args.flags['accept-current-private-state'] === true,
    });
    return {
      ok: false,
      payload: { ...refusal('resolve', done.halt), resolution: args.resolution, removed: done.removed, deferred: done.deferred, serviceReads: reader.stats().gets },
    };
  });
}

async function quarantine(args, spec, deps) {
  return withLease(args, spec, deps, async () => {
    const done = S.quarantineUnreadableReceipt(args.workspaceDir, {
      kindTable: RECEIPT_KT,
      acknowledgeUnknownDispatch: true,
      ...(args.flags['quarantine-id'] ? { quarantineId: args.flags['quarantine-id'] } : {}),
      ...(deps.invalidate ? { invalidate: deps.invalidate } : {}),
      ...(deps.leaseDeps ? { leaseDeps: deps.leaseDeps } : {}),
    });
    return {
      ok: false,
      payload: {
        ...refusal('resolve', done.halt),
        resolution: 'quarantine-unreadable',
        quarantineId: done.quarantineId,
        nextStep: `The receipt was moved aside under quarantine ${done.quarantineId}; keep both files. A build without configuration can run now. `
          + `A configuration build stops until you pass --acknowledge-quarantined-configuration ${done.quarantineId} to it, which accepts that it may send rows again at ids an earlier build may already have used.`,
        serviceReads: 0,
      },
    };
  });
}

// prepare and resolve hold the app's build lease, as a build and a teardown do, so no build can run while the receipt changes. A held
// lease is the receipt's state-busy stop.
async function withLease(args, spec, deps, fn) {
  try {
    return await withAppBuildLease({ workspaceDir: args.workspaceDir, appUniqueName: appUniqueName(spec), warn: deps.warn, ...(deps.owner ? { owner: deps.owner } : {}) }, fn);
  } catch (error) {
    if (error && error.code === 'build-locked') {
      throw halt('configuration-create-state-busy', { reason: 'another build, teardown or recovery holds the build lock of this app in this workspace' });
    }
    throw error;
  }
}

/**
 * Runs one recovery command and answers { ok, payload } without exiting (main prints it with emitResult).
 *   deps.httpClient(origin) -> { get(url) }   the raw client (default: the az-token client); wrapped read-only before any use
 *   deps.warn(text), deps.invalidate(dir), deps.leaseDeps, deps.owner   seams for tests
 */
async function runRecoveryCommand(argv, deps = {}) {
  const d = {
    httpClient: deps.httpClient || ((origin) => require('./lib/sdk-http-client.js').createAzHttpClient(origin)),
    warn: deps.warn || ((text) => process.stderr.write(`⚠ ${text}\n`)),
    invalidate: deps.invalidate,
    leaseDeps: deps.leaseDeps,
    owner: deps.owner,
  };
  let args;
  try {
    args = readArguments(argv);
    const spec = readSpec(args.specPath);
    if (args.command === 'inspect') return { ok: true, payload: await inspect(args, spec, d) };
    if (args.quarantine) return await quarantine(args, spec, d);
    return await resolveUnit(args, spec, d);
  } catch (error) {
    if (error instanceof UsageError) return { ok: false, payload: { ok: false, error: `${error.message}\n${USAGE}` } };
    if (halted(error)) return { ok: false, payload: refusal(args ? args.command : null, error) };
    throw error;
  }
}

async function main() {
  let result;
  try {
    result = await runRecoveryCommand(process.argv.slice(2));
  } catch (error) {
    emitResult(false, { ok: false, error: `configuration recovery stopped: ${error && error.message ? error.message : String(error)}` });
    return;
  }
  emitResult(result.ok, result.payload);
}

if (require.main === module) main();

module.exports = { runRecoveryCommand, readPortsOver, currentIntentOf };
