'use strict';
// The early workspace guard of the default configuration create path (#807), run by every entry that can change an
// environment for an app: the build command (build-model-app.js runBuildCommand), the build engine's own entry
// (sdk-build.js runSdkBuild), the changed-only flow (changed-only-flow.js) and teardown (teardown-model-app.js).
//
// WHY at every entry, and before anything else. A build that was interrupted while it created configuration rows leaves a
// receipt in the app's workspace (lib/configuration-create-state.js) saying which rows it meant to create at which ids and how
// far each got. Nothing may send a row of such a unit again on its own (a lost answer does not say whether the service
// committed it), and nothing may take a shortcut past it either: a changed-only no-op, a phase-only apply, a protected-path
// switch or a teardown would otherwise report success, certify a baseline or delete tables while the receipt still says the
// environment holds rows nobody has accounted for. So each entry calls this guard before its own shortcuts, under the app's
// build lease, and stops with a structured halt (retry never) that names the recovery command.
//
// The guard is LOCAL ONLY: it reads the workspace's receipt, quarantine markers and archives, and sends nothing. A workspace
// with no receipt (or an empty, valid one) passes with no service request added. The checks themselves are
// lib/configuration-create-recovery.js preflightConfigurationCreates; this module only builds what it needs from an App Spec
// and an entry's options, and turns its halt into the BuildHalt every entry already reports.

const fs = require('node:fs');
const path = require('node:path');
const { BuildHalt } = require('./entity-provision.js');
const { RETRY } = require('./retry-policy.js');
const { appUniqueName } = require('./app-unique-name.js');

const lower = (s) => String(s).toLowerCase();

// The configuration modules load lazily: sdk-build.js requires this module while it is still loading, and the plan module and
// configuration-artifacts.js sit on that same require graph, so a top-level require here could see a half-made module.
const recovery = () => require('./configuration-create-recovery.js');
const createState = () => require('./configuration-create-state.js');
const kindTable = () => require('./configuration-create-plan.js').CONFIGURATION_CREATE_RECEIPT_KIND_TABLE;

// Every name configuration-create-state.js reads as evidence starts with this (its FILE_PREFIX: the receipt, quarantine markers,
// archives, its lease and temp files; listEvidence filters on it).
const EVIDENCE_PREFIX = 'configuration-create-state.';
const CLEAR = Object.freeze({ quarantineIds: Object.freeze([]), acknowledged: false, deferredUnits: 0 });

// True only when the workspace provably holds no receipt evidence: it does not exist, or it is a plain folder whose listing has no
// evidence name. Then the guards answer clear without loading the receipt modules, which pull in the stable-id create modules a build
// without configuration receipts must not load. Anything else (a link or junction, a file, a folder that cannot be listed) takes the
// full path, which refuses what it cannot read rather than treat it as absent.
function holdsNoEvidence(dir) {
  let st;
  try { st = fs.lstatSync(dir); } catch (e) { return !!e && e.code === 'ENOENT'; }
  if (!st.isDirectory() || st.isSymbolicLink()) return false;
  try { return !fs.readdirSync(dir).some((n) => n.startsWith(EVIDENCE_PREFIX)); } catch { return false; }
}

/**
 * The App Spec's configuration roots as the receipt guard matches them (configuration-create-recovery.js
 * assertDeferredUnitsExcluded): kind tag, port key, every name the root answers to, and the root a declaration depends on (a
 * data-source variable's parent definition). The same list configuration-build.js hands the guard inside the build.
 */
function createDeclarationsOf(spec) {
  const out = [];
  if (!spec || typeof spec !== 'object') return out;
  const each = (list, fn) => { for (const e of Array.isArray(list) ? list : []) if (e && typeof e === 'object') fn(e); };
  each(spec.environmentVariables, (e) => {
    if (typeof e.schemaName !== 'string') return;
    const parent = typeof e.parentSchemaName === 'string' && e.parentSchemaName ? [{ kind: 'env-definition', key: lower(e.parentSchemaName), name: e.parentSchemaName }] : [];
    out.push({ kind: 'env-definition', key: lower(e.schemaName), names: [e.schemaName], ...(parent.length ? { dependsOn: parent } : {}) });
  });
  each(spec.connectionReferences, (e) => { if (typeof e.logicalName === 'string') out.push({ kind: 'connection-reference', key: lower(e.logicalName), names: [e.logicalName] }); });
  each(spec.customApis, (e) => { if (typeof e.uniqueName === 'string') out.push({ kind: 'custom-api', key: lower(e.uniqueName), names: [e.uniqueName] }); });
  each(spec.duplicateDetectionRules, (e) => {
    if (typeof e.key !== 'string') return;
    out.push({ kind: 'duplicate-rule', key: e.key, names: [e.key, ...(typeof e.name === 'string' && e.name ? [e.name] : [])] });
  });
  out.push(...pageBindingDeclarationsOf(spec));
  return out;
}

// A page the build writes depends on what its bindings name: an `actionBindings` entry on the Custom API of that unique name, a
// `connectorBindings` entry on the connection reference of that logical name (lib/page-binding-targets.js, which reads the same two
// tables before a rebuild writes them). A deferred root a page still calls is not out of the build, so each such page is a
// declaration of its own kind ('page', which matches no receipt root) that depends on those roots. Only pages the build would write
// count (pagesStatingBindings of a full build: a TSX source, a stated binding), and an action binding named EXACTLY as a reviewed
// built-in Dataverse operation (WhoAmI, RetrieveVersion) names no Custom API, so it depends on nothing.
//   { name: 'contoso_Calc', isFunction: true }                         -> { kind: 'custom-api', key: 'contoso_calc', name: 'contoso_Calc' }
//   { logicalName: 'contoso_c1', connectorId: '/providers/.../shared_x' } -> { kind: 'connection-reference', key: 'contoso_c1', name: 'contoso_c1' }
function pageBindingDeclarationsOf(spec) {
  if (!Array.isArray(spec.pages) || !spec.pages.length) return [];
  const { pagesStatingBindings, isBuiltInOperation } = require('./page-binding-targets.js');
  const { PAGE_BINDINGS } = require('./page-bindings.js');
  const refsOf = (page, list, kind) => (Array.isArray(page[list]) ? page[list] : [])
    .filter((entry) => !(list === 'actionBindings' && isBuiltInOperation(entry)))
    .map((entry) => (entry && typeof entry[PAGE_BINDINGS[list]] === 'string' ? entry[PAGE_BINDINGS[list]].trim() : ''))
    .filter(Boolean)
    .map((name) => ({ kind, key: lower(name), name }));
  const out = [];
  for (const page of pagesStatingBindings(spec)) {
    const dependsOn = [...refsOf(page, 'actionBindings', 'custom-api'), ...refsOf(page, 'connectorBindings', 'connection-reference')];
    if (dependsOn.length) out.push({ kind: 'page', key: String(page.key), names: [], dependsOn });
  }
  return out;
}

// Whether this run would interpret or write configuration: the App Spec declares a configuration kind and the run includes the
// data-model phase (no phase list is every phase, as the engine reads `opts.phases || PHASES`). Only such a run needs a
// quarantine acknowledged.
function configurationWorkOf(spec, phases) {
  if (!require('./configuration-artifacts.js').hasConfigurationDefinitions(spec)) return false;
  return !Array.isArray(phases) || phases.includes('data-model');
}

// A ConfigurationCreateHalt as the BuildHalt the entries report: the same code, never retried, its safe identifiers and next
// step carried along. The message is the halt's own (codes, unit and root ids, the next step; never a value).
function toBuildHalt(error) {
  const out = new BuildHalt(error.message, { phase: 'preflight', code: error.code, recoverable: false, retry: RETRY.NEVER });
  for (const field of ['unitId', 'rootId', 'rootKind', 'nextStep', 'reason']) {
    if (error[field] !== undefined && error[field] !== null) out[field] = error[field];
  }
  return out;
}

const isCreateHalt = (error) => !!error && error.name === 'ConfigurationCreateHalt';

/**
 * The receipt context of this run: the environment's origin, the App Spec's solution, the app's unique name and the authoring
 * language. When the language is not known yet (a direct engine call that resolves it later, or a dry run that reads none),
 * the saved receipt's own language is used, so the environment, the solution and the app are still compared. Answers null
 * when the context cannot be made at all (no environment): the guard then still refuses any blocking or open evidence.
 */
function contextOf(workspaceDir, { spec, env, languageCode }) {
  const S = createState();
  let language = Number.isSafeInteger(languageCode) ? languageCode : undefined;
  if (language === undefined) {
    // An unreadable receipt is the preflight's to refuse (state-invalid); here it only means no language to borrow.
    try {
      const found = S.discoverConfigurationCreateState(workspaceDir, { kindTable: kindTable() });
      language = found.sidecar.status === 'valid' ? found.sidecar.state.authoringLanguageCode : null;
    } catch {
      language = null;
    }
  }
  try {
    return S.createStateContext({
      environmentUrl: new URL(String(env)).origin,
      solutionUniqueName: spec && spec.solution && spec.solution.uniqueName,
      appUniqueName: appUniqueName(spec),
      authoringLanguageCode: language === undefined ? null : language,
    });
  } catch {
    return null;
  }
}

/**
 * Throws the BuildHalt of the first thing in the app workspace that stops this run (preflightConfigurationCreates): an invalid
 * or incomplete receipt, quarantine or archive; a receipt of another environment, solution, app or language; an open unit; a
 * declaration that brings back a deferred unit's root; or configuration work while a quarantine is not acknowledged.
 *   assertConfigurationCreatesClear(workspaceDir, { spec, env, languageCode?, phases?, quarantineAcknowledgment?, configurationWork? })
 * `quarantineAcknowledgment` is only ever the in-process capability validateQuarantineAcknowledgment made (see acknowledge).
 * Answers what the preflight answered: { quarantineIds, acknowledged, deferredUnits }.
 */
function assertConfigurationCreatesClear(workspaceDir, { spec, env, languageCode, phases, quarantineAcknowledgment, configurationWork } = {}) {
  const ws = path.resolve(workspaceDir);
  if (holdsNoEvidence(ws)) return CLEAR;
  try {
    return recovery().preflightConfigurationCreates({
      workspaceDir: ws,
      context: contextOf(ws, { spec, env, languageCode }),
      kindTable: kindTable(),
      declarations: createDeclarationsOf(spec),
      configurationWork: configurationWork === undefined ? configurationWorkOf(spec, phases) : configurationWork === true,
      quarantineAcknowledgment,
    });
  } catch (error) {
    if (isCreateHalt(error)) throw toBuildHalt(error);
    throw error;
  }
}

/**
 * The build's explicit `--acknowledge-quarantined-configuration <id>[,<id>...]`: validated against the workspace's quarantines
 * (every deferred one named, none unknown, none incomplete) and answered as the in-process capability the guards accept. Never
 * saved anywhere: it is good for this invocation only, and teardown accepts none.
 */
function acknowledgeQuarantines(workspaceDir, raw) {
  const ids = String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  try {
    return recovery().validateQuarantineAcknowledgment(path.resolve(workspaceDir), ids);
  } catch (error) {
    if (isCreateHalt(error)) throw toBuildHalt(error);
    throw error;
  }
}

/**
 * Teardown's guard: refuses any receipt evidence at all except an empty valid receipt — an open or deferred unit, an invalid,
 * unreadable or unknown file, an incomplete or complete quarantine and its archive (configuration-create-state.js
 * assertConfigurationCreateWorkspaceClearable). A build's quarantine acknowledgment is not accepted here. Throws the
 * BuildHalt; `dir` may be the isolated folder a workspace clear is about to remove.
 */
function assertTeardownClear(dir) {
  if (holdsNoEvidence(path.resolve(dir))) return;
  try {
    createState().assertConfigurationCreateWorkspaceClearable(path.resolve(dir), { kindTable: kindTable() });
  } catch (error) {
    if (isCreateHalt(error)) throw toBuildHalt(error);
    throw error;
  }
}

module.exports = {
  createDeclarationsOf,
  configurationWorkOf,
  assertConfigurationCreatesClear,
  acknowledgeQuarantines,
  assertTeardownClear,
  toBuildHalt,
};
