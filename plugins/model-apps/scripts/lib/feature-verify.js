'use strict';
// Component-level verification of the controls a build manages on a table's command bar, and a creation witness for
// the dashboards it declares — the verification side of DESIGN C07. Both answers come from the bundled SDK's
// `inspectArtifact` (GETs only, no workspace needed); this module turns them into verify checks.
//
// Why a separate check and not the existing one. verify-model-app.js's `commandBar(entity)` asks only whether the
// table has ANY command bar, so a build that lost a button, put it on the wrong surface or bound it to another app still
// passed. The inspection classifies every `appaction` row of the table and answers per declared control:
//   present | missing | ambiguous | misplaced | indeterminate
// and only `present` passes. The five stay distinct here because each means something different to the maker:
// `missing` is not permission to create, `misplaced` is not permission to rewrite, `ambiguous` and `indeterminate`
// are "cannot tell" — none of them is a pass, and none of them is turned into another.
//
// Identity. A control the build recorded (its row id, the SDK-minted control id) is VERIFIED by that id. A control
// looked up by caption alone is DISCOVERY: the SDK answers `identity: 'caption'`, and a caption-mode `present` proves
// only that some served row has that caption — perhaps another solution's. Such a check is reported `unverified`
// (CAPTION_ONLY), never `pass`.
//
// Hidden and disabled. A disabled row — or a row under a disabled or unhosted ancestor — is served on no surface, so
// the SDK answers `misplaced` (its candidate is proved elsewhere) and that fails here. A row that is served but
// `hidden`, or under a hidden menu, is present in the served data and invisible to the user: it fails too (HIDDEN /
// ANCESTOR_HIDDEN). What the SDK computes is a PREDICTION from the saved rows, not a read of the runtime or of what a
// browser renders; the check says so in its `basis`.
//
// Dashboards. The witness compares the SAVED row with the artifact the build pushed (`expected`): `matching` passes;
// `present` (no expected given) is existence only and is not content equality, so it is `unverified`;
// `conflicting` and `missing` fail; `unreadable` — including COMPARISON_NOT_ESTABLISHED — is `unverified`. It
// complements, and does not replace, verify-spec.js's published-layer tile check: a dashboard can match in the saved
// layer and still be unpublished.
//
// Every `unverified` check FAILS the requested verification. An incomplete read is never a success
// (DESIGN C05: incomplete reads and ambiguous identities remain unverified).
//
// Foreign controls (rows the build did not declare) are tolerated: only declared controls are asked about.

const { GUID_RE, findingOf, checkClosedObject, isNonEmptyString } = require('./readonly-operations.js');

const COMMAND_SURFACES = Object.freeze(['form', 'homeGrid', 'subGrid', 'associatedGrid']);
const CONTROL_KINDS = Object.freeze(['button', 'flyout', 'split']);
const TARGET_KEYS = ['entity', 'appModuleId', 'controls'];
const CONTROL_KEYS = ['key', 'rowId', 'surface', 'label', 'menuPath', 'kind'];
const DASHBOARD_KEYS = ['key', 'id', 'expected'];

const COMMAND_BASIS = 'stored appaction rows, classified by the SDK; a prediction of the served bar, not a read of the runtime or the rendered page';
const DASHBOARD_BASIS = 'the saved (unpublished) dashboard row compared with the pushed artifact; publication is checked separately';

/**
 * Validates the declared command expectations (closed keys, canonical GUIDs, known surfaces) before any read.
 * @param {unknown} targets - [{ entity, appModuleId?, controls: [{ key, rowId?, surface, label?, menuPath?, kind? }] }]
 * @returns {string[]} errors
 */
function validateCommandTargets(targets) {
  const errors = [];
  if (!Array.isArray(targets)) return ['command targets must be an array'];
  const keys = new Set();
  targets.forEach((t, i) => {
    const where = `commands[${i}]`;
    if (!checkClosedObject(t, TARGET_KEYS, where, errors)) return;
    if (!isNonEmptyString(t.entity)) errors.push(`${where}.entity must be a table logical name`);
    if (t.appModuleId !== undefined && !(typeof t.appModuleId === 'string' && GUID_RE.test(t.appModuleId))) errors.push(`${where}.appModuleId must be a canonical GUID`);
    if (!Array.isArray(t.controls) || t.controls.length === 0) {
      errors.push(`${where}.controls must be a non-empty array`);
      return;
    }
    t.controls.forEach((c, j) => {
      const cw = `${where}.controls[${j}]`;
      if (!checkClosedObject(c, CONTROL_KEYS, cw, errors)) return;
      if (!isNonEmptyString(c.key)) errors.push(`${cw}.key must be a non-empty string`);
      else if (keys.has(c.key)) errors.push(`${cw}.key "${c.key}" is used twice`);
      else keys.add(c.key);
      if (!COMMAND_SURFACES.includes(c.surface)) errors.push(`${cw}.surface must be one of: ${COMMAND_SURFACES.join(', ')}`);
      if (c.rowId !== undefined && !(typeof c.rowId === 'string' && GUID_RE.test(c.rowId))) errors.push(`${cw}.rowId must be a canonical GUID`);
      if (c.rowId === undefined && !isNonEmptyString(c.label)) errors.push(`${cw} needs a rowId (verification) or a label (discovery)`);
      if (c.label !== undefined && typeof c.label !== 'string') errors.push(`${cw}.label must be a string`);
      if (c.menuPath !== undefined && !(Array.isArray(c.menuPath) && c.menuPath.every((m) => typeof m === 'string'))) errors.push(`${cw}.menuPath must be an array of captions`);
      if (c.kind !== undefined && !CONTROL_KINDS.includes(c.kind)) errors.push(`${cw}.kind must be one of: ${CONTROL_KINDS.join(', ')}`);
    });
  });
  return errors;
}

/** @returns {string[]} errors */
function validateDashboardTargets(targets) {
  const errors = [];
  if (!Array.isArray(targets)) return ['dashboard targets must be an array'];
  const keys = new Set();
  targets.forEach((d, i) => {
    const where = `dashboards[${i}]`;
    if (!checkClosedObject(d, DASHBOARD_KEYS, where, errors)) return;
    if (!isNonEmptyString(d.key)) errors.push(`${where}.key must be a non-empty string`);
    else if (keys.has(d.key)) errors.push(`${where}.key "${d.key}" is used twice`);
    else keys.add(d.key);
    if (!(typeof d.id === 'string' && GUID_RE.test(d.id))) errors.push(`${where}.id must be a canonical GUID`);
    if (d.expected !== undefined && (!d.expected || typeof d.expected !== 'object' || Array.isArray(d.expected))) errors.push(`${where}.expected must be the pushed dashboard artifact`);
  });
  return errors;
}

// The SDK's query, from a declared control: only the fields it reads (an absent menuPath is a top-level control).
function queryOf(control) {
  return {
    surface: control.surface,
    ...(control.rowId ? { rowId: control.rowId.toLowerCase() } : {}),
    ...(control.label !== undefined ? { label: control.label } : {}),
    ...(control.menuPath ? { menuPath: control.menuPath } : {}),
    ...(control.kind ? { kind: control.kind } : {}),
  };
}

// What the inspection observed about a row — the stored facts a live proof records (row id, Location, isdisabled),
// never its caption or script.
function rowFacts(row) {
  return {
    rowId: row.rowId,
    location: row.location,
    surface: row.surface,
    placement: row.placement,
    disabled: row.disabled,
    hidden: row.hidden,
    ancestorHidden: row.ancestorHidden,
    scope: row.scope,
    audienceAppId: row.audienceAppId,
    managed: row.managed,
    diagnostics: [...row.diagnostics],
  };
}

/**
 * One command check, from the SDK's match.
 * @returns {{ key, status: 'pass'|'fail'|'unverified', reason, verdict, identity, rows, elsewhere, uncertain }}
 */
function commandCheck(control, match, rowsById) {
  const facts = (ids) => ids.map((id) => rowsById.get(id)).filter(Boolean).map(rowFacts);
  const base = {
    key: control.key,
    kind: 'command',
    verdict: match.verdict,
    identity: match.identity,
    rows: facts(match.rowIds),
    elsewhere: facts(match.elsewhere),
    uncertain: facts(match.uncertain),
  };
  switch (match.verdict) {
    case 'present':
      if (match.identity !== 'row') return { ...base, status: 'unverified', reason: 'CAPTION_ONLY' };
      if (match.hidden) return { ...base, status: 'fail', reason: 'HIDDEN' };
      if (match.ancestorHidden) return { ...base, status: 'fail', reason: 'ANCESTOR_HIDDEN' };
      return { ...base, status: 'pass', reason: 'PRESENT' };
    case 'missing': return { ...base, status: 'fail', reason: 'MISSING' };
    case 'ambiguous': return { ...base, status: 'fail', reason: 'AMBIGUOUS' };
    case 'misplaced': return { ...base, status: 'fail', reason: misplacedReason(base.elsewhere) };
    case 'indeterminate': return { ...base, status: 'unverified', reason: 'INDETERMINATE' };
    default: return { ...base, status: 'unverified', reason: 'UNKNOWN_VERDICT' };
  }
}

// The most specific reason a candidate is not served where it was declared: disabled itself, under a disabled or
// unhosted menu, or on another surface/app. Several candidates: the first in the SDK's order decides the reason; all
// of them are listed in `elsewhere`.
function misplacedReason(elsewhere) {
  const first = elsewhere[0];
  if (!first) return 'MISPLACED';
  if (first.disabled) return 'DISABLED';
  if (first.diagnostics.includes('ANCESTOR_NOT_SERVED')) return 'ANCESTOR_NOT_SERVED';
  if (first.placement === 'unhosted') return 'UNHOSTED';
  return 'MISPLACED';
}

/**
 * Inspects one table's command bar for the declared controls. Never throws for a read: an unreadable bar makes every
 * control of the table `unverified` (INSPECTION_UNREADABLE), which fails the requested check.
 * @param {object} sdk - a MakerSdk (only inspectArtifact is used)
 * @param {{ entity: string, appModuleId?: string, controls: object[] }} target
 */
async function inspectCommandControls(sdk, target) {
  const controls = target.controls;
  let inspection;
  try {
    inspection = await sdk.inspectArtifact('command', String(target.entity).toLowerCase(), {
      find: controls.map(queryOf),
      ...(target.appModuleId ? { appModuleId: target.appModuleId.toLowerCase() } : {}),
    });
  } catch (err) {
    const finding = findingOf(err, 'INSPECTION_UNREADABLE');
    return {
      entity: target.entity,
      read: 'unreadable',
      checks: controls.map((c) => ({ key: c.key, kind: 'command', status: 'unverified', reason: finding.code, detail: finding.message })),
    };
  }
  const rowsById = new Map((inspection.rows || []).map((r) => [r.rowId, r]));
  const found = Array.isArray(inspection.found) ? inspection.found : [];
  return {
    entity: target.entity,
    read: 'complete',
    observedAt: inspection.observedAt,
    rowCount: rowsById.size,
    checks: controls.map((c, i) => (found[i] ? commandCheck(c, found[i], rowsById) : { key: c.key, kind: 'command', status: 'unverified', reason: 'NO_ANSWER' })),
  };
}

/**
 * The creation witness of one declared dashboard.
 * @param {object} sdk
 * @param {{ key: string, id: string, expected?: object }} target
 */
async function witnessDashboard(sdk, target) {
  const base = { key: target.key, kind: 'dashboard', id: target.id, basis: DASHBOARD_BASIS };
  let w;
  try {
    w = await sdk.inspectArtifact('dashboard', target.id, target.expected ? { expected: target.expected } : undefined);
  } catch (err) {
    // INVALID_ARGUMENT (a malformed expected artifact, refused before any request) or a transport failure the SDK did
    // not answer in-band: either way nothing was established.
    const f = findingOf(err, 'INSPECTION_FAILED');
    return { ...base, status: 'unverified', reason: f.code, detail: f.message };
  }
  const out = { ...base, observation: w.observation, ...(w.reasonCode ? { reasonCode: w.reasonCode } : {}), observedAt: w.observedAt };
  switch (w.observation) {
    case 'matching': return { ...out, status: 'pass', reason: 'MATCHING' };
    case 'present': return { ...out, status: 'unverified', reason: 'EXISTENCE_ONLY' };
    case 'conflicting': return { ...out, status: 'fail', reason: w.reasonCode === 'KIND' ? 'NOT_A_DASHBOARD' : 'CONTENT_DIFFERS', ...(Array.isArray(w.differences) ? { differences: w.differences.slice(0, 20) } : {}) };
    case 'missing': return { ...out, status: 'fail', reason: 'MISSING' };
    default: return { ...out, status: 'unverified', reason: w.reasonCode || 'UNREADABLE' };
  }
}

/**
 * Runs every requested inspection and folds them into one answer. `ok` is true only when every check passed;
 * `unverified` counts against it like `fail` does.
 * @param {object} sdk
 * @param {{ commands?: object[], dashboards?: object[] }} request
 */
async function verifyFeatures(sdk, { commands = [], dashboards = [] } = {}) {
  const errors = [...validateCommandTargets(commands), ...validateDashboardTargets(dashboards)];
  if (errors.length) {
    const err = new Error(`feature verify: ${errors.join('; ')}`);
    err.code = 'FEATURE_VERIFY_INVALID';
    err.errors = errors;
    throw err;
  }
  const checks = [];
  const tables = [];
  for (const target of commands) {
    const r = await inspectCommandControls(sdk, target);
    tables.push({ entity: r.entity, read: r.read, ...(r.rowCount !== undefined ? { rowCount: r.rowCount } : {}) });
    checks.push(...r.checks.map((c) => ({ ...c, entity: r.entity })));
  }
  for (const d of dashboards) checks.push(await witnessDashboard(sdk, d));
  const summary = { pass: 0, fail: 0, unverified: 0 };
  for (const c of checks) summary[c.status] += 1;
  return {
    ok: summary.fail === 0 && summary.unverified === 0,
    summary,
    tables,
    checks,
    basis: { command: COMMAND_BASIS, dashboard: DASHBOARD_BASIS },
  };
}

/** One line per check that did not pass — what verify prints. */
function describeFeatureCheck(check) {
  const where = check.kind === 'command' ? `command '${check.key}' on ${check.entity}` : `dashboard '${check.key}'`;
  const text = {
    PRESENT: 'present',
    MATCHING: 'the saved dashboard matches what the build pushed',
    CAPTION_ONLY: 'a served control has this caption, but it was found by caption only: the build recorded no row id to verify it by',
    HIDDEN: 'present, but hidden',
    ANCESTOR_HIDDEN: 'present, but the menu it sits under is hidden',
    MISSING: 'not found',
    AMBIGUOUS: 'several served controls match it',
    DISABLED: 'stored disabled, so it is served nowhere',
    ANCESTOR_NOT_SERVED: 'the menu it sits under is disabled or not served',
    UNHOSTED: 'stored, but served on no surface',
    MISPLACED: 'it exists, but on another surface, menu or app',
    INDETERMINATE: 'whether it is served there cannot be settled',
    EXISTENCE_ONLY: 'the dashboard exists; its content was not compared',
    CONTENT_DIFFERS: `the saved dashboard differs from what the build pushed${check.differences ? ` (${check.differences.join(', ')})` : ''}`,
    NOT_A_DASHBOARD: 'the row is not a dashboard',
  }[check.reason];
  return `${check.status.toUpperCase()} ${where}: ${text || `cannot be verified (${check.reason}${check.detail ? `: ${check.detail}` : ''})`}`;
}

module.exports = {
  COMMAND_SURFACES,
  validateCommandTargets,
  validateDashboardTargets,
  inspectCommandControls,
  witnessDashboard,
  verifyFeatures,
  describeFeatureCheck,
};
