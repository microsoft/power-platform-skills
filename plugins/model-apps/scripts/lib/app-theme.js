'use strict';

// app.theme (Preview): the app's modern theme and header logo, through the SDK's setAppTheme/getAppTheme.
//
//   undefined  nothing is read or written (an existing spec costs no request)
//   null       remove the app's own theme, so the app follows the environment's again
//   { ... }    set the app's theme to exactly these fields (AppTheme in the SDK; see THEME_FIELDS below)
//
// The SDK stores the theme as a content-named web resource version plus the app's theme setting row (appsetting), and
// can publish the app itself. The build never lets it publish the APP: setAppTheme is always called with publish:false,
// and the app's publication is queued on the build's publication port (lib/app-publication-policy.js), which publishes
// through the same SDK writer as every other app publish — so an exact Main-form obligation of the app can withhold it,
// and nothing here can go around that. publish:false does not stop the SDK publishing the new VERSION web resource
// itself: a version is immutable and must be readable before any app names it, so a first set sends, in order,
//   POST /webresourceset                      the version, named `<prefix>_/apptheme/<16 hex>.xml` from its content
//   POST /PublishXml  <webresources>…</webresources>   that one resource, never an app
//   POST /appsettings | PATCH /appsettings(<id>) (If-Match) | DELETE /appsettings(<id>)   the app's row, as a draft
// An equal theme sends nothing; a removal sends only the row's DELETE.
//
// What `app.theme` manages is a PROPERTY of the app — "the app's CustomThemeDefinition setting holds this theme" —
// never a record it owns. Dataverse keeps one theme row per app (the setting row's key, checked before any write by
// lib/app-theme-reads.js assertThemeIdentityConstraint), so the app and the setting definition name the property; the
// row's id is only where it is stored at this moment, read when a membership needs it and never kept. Nothing here
// claims to have created a row or a version, and nothing here deletes one:
//   - another writer can replace the row between the set and a later read; a row of the same value then still holds the
//     declared theme (the property is met), but it is not this build's, so it is never named as created or deleted;
//   - a version is shared by every app whose theme has the same bytes (its name is derived from them), so it is never
//     deleted, even when the SDK reports it created; a superseded version is reported by the SDK and left in place;
//   - the header logo is only REFERENCED: creating or deleting that image is `webResources[]`'s business.
// So `managedBindings` is always empty.
//
// Every read of the theme runs under the strict read policy of lib/app-theme-reads.js (the SDK must have been made with
// `themeReads`): every row an answer returns is placed against what the read asked for, or the operation is unknown.
// The policy also counts the writes each operation sends, which is the only evidence used to say a failure wrote nothing.

const { THEME_PALETTE_SLOTS } = require('./maker-sdk.js');
const {
  isThemeReadGuarded, withThemeReadScope, isReadIncomplete, assertThemeIdentityConstraint, readThemeSettingIdentity,
  READ_INCOMPLETE, IDENTITY_UNPROVEN, THEME_SETTING,
} = require('./app-theme-reads.js');
const { RETRY } = require('./retry-policy.js');

const COLOR = /^#[0-9A-Fa-f]{6}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEADER_FIELDS = ['background', 'foreground', 'backgroundHover', 'foregroundHover', 'backgroundPressed', 'foregroundPressed', 'backgroundSelected', 'foregroundSelected'];
const THEME_FIELDS = ['basePaletteColor', 'lockPrimary', 'vibrancy', 'hueTorsion', 'font', 'palette', 'appHeader', 'logo'];
const LOGO_FIELDS = ['webResourceName', 'tooltip'];
const KEY = 'app.theme';
// Web resource types a header logo can be: PNG 5, JPG 6, GIF 7, ICO 10, SVG 11.
// https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/webresource#webresourcetype-choicesoptions
const IMAGE_TYPES = new Set([5, 6, 7, 10, 11]);
const XML_WEB_RESOURCE = 4;
const WEB_RESOURCE_COMPONENT = 61;
const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPlain = (value) => isObject(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const isGuid = (value) => typeof value === 'string' && GUID.test(value);
const lower = (value) => String(value).toLowerCase();

// Anything that is not closed JSON (an array, a class instance, a function, a non-finite number) anywhere in the theme.
// The theme has no list field, so an array is never one; this catches an object put where a value belongs and back.
function notJson(value, at, errors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) errors.push(`${at} must be a finite number`); return; }
  if (Array.isArray(value)) { errors.push(`${at} must not be a list`); return; }
  if (!isPlain(value)) { errors.push(`${at} must be plain JSON`); return; }
  for (const [key, child] of Object.entries(value)) notJson(child, `${at}.${key}`, errors);
}

// Refusals before any request. The SDK validates as well (ValidationError 'appTheme'); checking here first lets the spec
// lint name the field, and refuses `additionalAttributes`, which the SDK would pass through to the stored theme.
function validateAppTheme(theme, { path = KEY } = {}) {
  const errors = [];
  if (theme === undefined || theme === null) return { errors, warnings: [] };
  if (!isPlain(theme)) return { errors: [`${path} must be an object, or null to remove the app's theme`], warnings: [] };
  notJson(theme, path, errors);
  if (errors.length) return { errors, warnings: [] };
  const color = (value, at) => { if (typeof value !== 'string' || !COLOR.test(value)) errors.push(`${at} must be a colour like "#0F6CBD"`); };
  const only = (value, allowed, at) => Object.keys(value).filter((key) => !allowed.includes(key))
    .forEach((key) => errors.push(`${at}.${key} is not a theme field${key === 'additionalAttributes' ? ' (raw theme attributes are not supported)' : ''}`));
  only(theme, THEME_FIELDS, path);
  if (!Object.keys(theme).some((key) => THEME_FIELDS.includes(key))) errors.push(`${path} names no theme field; use null to remove the app's theme`);
  if (theme.basePaletteColor !== undefined) color(theme.basePaletteColor, `${path}.basePaletteColor`);
  if (theme.lockPrimary !== undefined && typeof theme.lockPrimary !== 'boolean') errors.push(`${path}.lockPrimary must be true or false`);
  for (const key of ['vibrancy', 'hueTorsion']) {
    if (theme[key] !== undefined && !(Number.isInteger(theme[key]) && theme[key] >= -100 && theme[key] <= 100)) errors.push(`${path}.${key} must be a whole number from -100 to 100`);
  }
  if (theme.font !== undefined && (typeof theme.font !== 'string' || !theme.font.trim())) errors.push(`${path}.font must be a font name`);
  if (theme.palette !== undefined) {
    if (!isObject(theme.palette)) errors.push(`${path}.palette must be an object of palette slots`);
    else {
      only(theme.palette, THEME_PALETTE_SLOTS, `${path}.palette`);
      for (const [slot, value] of Object.entries(theme.palette)) if (THEME_PALETTE_SLOTS.includes(slot)) color(value, `${path}.palette.${slot}`);
    }
  }
  if (theme.appHeader !== undefined) {
    if (!isObject(theme.appHeader)) errors.push(`${path}.appHeader must be an object`);
    else {
      only(theme.appHeader, HEADER_FIELDS, `${path}.appHeader`);
      if (theme.appHeader.background === undefined) errors.push(`${path}.appHeader.background is required`);
      for (const key of HEADER_FIELDS) if (theme.appHeader[key] !== undefined) color(theme.appHeader[key], `${path}.appHeader.${key}`);
    }
  }
  if (theme.logo !== undefined) {
    if (!isObject(theme.logo)) errors.push(`${path}.logo must be an object`);
    else {
      only(theme.logo, LOGO_FIELDS, `${path}.logo`);
      if (theme.logo.webResourceName === undefined && theme.logo.tooltip === undefined) errors.push(`${path}.logo needs webResourceName or tooltip`);
      const name = theme.logo.webResourceName;
      // The header logo is an image web resource of the environment, e.g. "contoso_/images/logo.svg" — never a URL:
      // the app would load it from another origin, which the SDK's logo check refuses anyway (APP_THEME_LOGO_INVALID).
      if (name !== undefined && (typeof name !== 'string' || !name.trim() || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(name))) {
        errors.push(`${path}.logo.webResourceName must name an image web resource (e.g. "contoso_/images/logo.svg"), not a URL`);
      }
      if (theme.logo.tooltip !== undefined && typeof theme.logo.tooltip !== 'string') errors.push(`${path}.logo.tooltip must be text`);
    }
  }
  return { errors, warnings: [] };
}

// One canonical form for comparing a declared theme with the one the SDK reads back: sorted keys, upper-case colours,
// undefined fields left out. Two themes that differ only there store the same web resource content.
function canonicalTheme(theme) {
  if (!isObject(theme)) return theme;
  const out = {};
  for (const key of Object.keys(theme).sort()) {
    const value = theme[key];
    if (value === undefined) continue;
    out[key] = isObject(value) ? canonicalTheme(value) : typeof value === 'string' && COLOR.test(value) ? value.toUpperCase() : value;
  }
  return out;
}

const sameTheme = (a, b) => JSON.stringify(canonicalTheme(a)) === JSON.stringify(canonicalTheme(b));

// What the app WILL show once published (`afterPublish`), as the SDK resolves it:
//   { source: 'app'|'environment'|'none'|'unknown', webResourceName?, theme?, exact?, diagnostics? }
// Only a binding whose document was read back field for field (`exact: true`) of the app's own row is "equal": a
// document the SDK could not read (it reports that as a warning and leaves `exact` out) proves nothing.
function matchesDeclared(binding, declared) {
  return Boolean(binding) && binding.source === 'app' && binding.exact === true && sameTheme(binding.theme, declared);
}

// null means "the app has no theme row of its own", so it is decided from the ROW (AppThemeInfo.row.state:
// 'absent'|'draft'|'published'|'publishedWithDraft'|'removalPending'), never from what the app resolves: a row holding
// the "no theme" sentinel `""` resolves to source 'none', yet it is still the app's own override and keeps the
// environment's theme from applying. Only an absent row, or one whose removal is pending its app publish, is removed.
const rowRemoved = (info) => Boolean(info && info.row && (info.row.state === 'absent' || info.row.state === 'removalPending'));
// The SDK's "no value" (settingValueIsNone): nothing, '' or the quoted empty string '""'.
const isNoneValue = (value) => value === undefined || value === null || value === '' || value === '""';

const themeOf = (spec) => (spec && isObject(spec.app) ? spec.app.theme : undefined);
const emptyResult = () => ({ saved: [], unchanged: [], pendingPublish: [], refused: [], unknown: [], managedBindings: [] });

// A failure's code for a result: the error's own when it is a plain code, never its words (they can quote a URL, a
// value or an answer). An SDK ValidationError has no code of its own.
function codeOf(error) {
  if (isReadIncomplete(error)) return READ_INCOMPLETE;
  const code = error && (error.code || (error.name === 'ValidationError' ? 'VALIDATION_ERROR' : undefined));
  return typeof code === 'string' && SAFE_CODE.test(code) ? code : 'APP_THEME_FAILED';
}
// A stop the create port raised (`create-outcome-unknown`, `create-completion-required`, …): the build's own catch
// reports it, so it is passed on as it is, carrying what this operation had already done.
const isCreateStop = (error) => Boolean(error) && typeof error.code === 'string' && error.code.startsWith('create-');

function completionRequired(missing) {
  return Object.assign(new Error(`app.theme: the theme was written, but its ${missing === 'webResource' ? 'version web resource' : 'setting row'} could not be found afterwards; nothing more was done, and nothing was created again. Re-run to read the app's theme back.`), {
    code: 'create-completion-required', transient: false, outcome: 'stopped',
    create: { kind: 'appTheme', key: KEY, id: null }, detail: { missing },
  });
}
const themeError = (code, message) => Object.assign(new Error(message), { code });

// An app whose theme set ended unknown in this build: nothing more is done to its theme by this SDK (not even a null
// removal), because what the app's row holds is not known. A later run reads it back before it does anything.
const unknownSets = new WeakMap();
const markUnknown = (sdk, appId) => { if (sdk) { if (!unknownSets.has(sdk)) unknownSets.set(sdk, new Set()); unknownSets.get(sdk).add(lower(appId)); } };
const isUnknown = (sdk, appId) => Boolean(sdk && unknownSets.has(sdk) && unknownSets.get(sdk).has(lower(appId)));

const query = (params) => `?${params.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&')}`;
const literal = (text) => String(text).replace(/'/g, "''");
const succeeded = (response) => response && response.status >= 200 && response.status < 300;
async function rowsOf(client, path, what) {
  const response = await client.get(path);
  if (!succeeded(response) || !isObject(response.body) || !Array.isArray(response.body.value)) throw themeError(READ_INCOMPLETE, `app.theme: the ${what} read could not be read; nothing is concluded from it.`);
  return response.body.value;
}

// A web resource by name, read strictly (the read policy judges it: one row at most, of exactly that name).
//   GET /webresourceset?$select=webresourceid,name,webresourcetype&$filter=name eq 'contoso_/images/logo.svg'
//   { "value": [ { "webresourceid": "<id>", "name": "contoso_/images/logo.svg", "webresourcetype": 11 } ] }
async function webResourceByName(client, name) {
  const rows = await rowsOf(client, `/webresourceset${query([['$select', 'webresourceid,name,webresourcetype'], ['$filter', `name eq '${literal(name)}'`]])}`, 'web resource lookup');
  if (rows.length > 1) throw themeError(READ_INCOMPLETE, 'app.theme: a web resource lookup answered more than one resource; nothing is concluded from it.');
  return rows.length ? { id: lower(rows[0].webresourceid), name: rows[0].name, type: rows[0].webresourcetype } : null;
}

// The declared logo must be an image web resource that exists now: the SDK's own check reports a missing one only as a
// warning, and a warning is never read as proof. Returns null when it is, else the refusal code.
async function logoProblem(client, declared) {
  const name = declared && declared.logo && declared.logo.webResourceName;
  if (name === undefined) return null;
  const found = await webResourceByName(client, name);
  if (!found) return 'APP_THEME_PREREQUISITE_UNRESOLVED';
  return IMAGE_TYPES.has(found.type) ? null : 'APP_THEME_LOGO_INVALID';
}

const solutionNameOf = (solution) => (typeof solution === 'string' ? solution : isObject(solution) && typeof solution.uniqueName === 'string' ? solution.uniqueName : '').trim();

// The appsetting solution component type differs per environment, so it is read (once per SDK):
//   GET /solutioncomponentdefinitions?$select=solutioncomponenttype,primaryentityname&$filter=primaryentityname eq 'appsetting'
//   { "value": [ { "solutioncomponenttype": 10051, "primaryentityname": "appsetting" } ] }
const settingTypes = new WeakMap();
async function appSettingType(sdk) {
  if (settingTypes.has(sdk)) return settingTypes.get(sdk);
  const rows = await rowsOf(sdk.dataverse, `/solutioncomponentdefinitions${query([['$select', 'solutioncomponenttype,primaryentityname'], ['$filter', "primaryentityname eq 'appsetting'"]])}`, 'setting component type');
  if (rows.length !== 1) throw themeError(READ_INCOMPLETE, 'app.theme: the setting component type did not read back as one type; nothing is concluded.');
  settingTypes.set(sdk, rows[0].solutioncomponenttype);
  return rows[0].solutioncomponenttype;
}

//   GET /solutioncomponents?$select=objectid,componenttype&$filter=_solutionid_value eq <solution> and (objectid eq <a> or objectid eq <b>)
async function membersOf(client, solutionId, wanted) {
  const rows = await rowsOf(client, `/solutioncomponents${query([['$select', 'objectid,componenttype'], ['$filter', `_solutionid_value eq ${lower(solutionId)} and (${wanted.map((member) => `objectid eq ${member.id}`).join(' or ')})`]])}`, 'solution membership');
  const present = new Set(rows.map((row) => `${row.componenttype}:${lower(row.objectid)}`));
  return wanted.filter((member) => !present.has(`${member.type}:${member.id}`));
}

/**
 * The stored theme is complete: the version web resource the app's row names exists now as a theme version (type 4),
 * and the app's CustomThemeDefinition row exists and names it. Both are read where they are NOW (an observation, never
 * a record of creation): the version by its name, strictly; the row by app + CustomThemeDefinition
 * (readThemeSettingIdentity). This is the theme's completion, so it is proven after every set, with or without a
 * solution; only the solution's member reads and adds depend on one (ensureAppThemeMembership).
 * A version or row that is gone after a set is `create-completion-required`; a row that holds another value is unknown.
 */
async function proveStoredTheme(client, appId, versionName) {
  const version = await webResourceByName(client, versionName);
  if (!version) throw completionRequired('webResource');
  if (version.type !== XML_WEB_RESOURCE) throw themeError('APP_THEME_NOT_SAVED', 'app.theme: the app\'s theme names a web resource that is not a theme version.');
  const identity = await readThemeSettingIdentity(client, appId, versionName, themeError);
  if (!identity.settingId) throw completionRequired('appSetting');
  if (!identity.matches) throw themeError('APP_THEME_NOT_SAVED', 'app.theme: the app\'s theme setting holds another theme than the one just written.');
  return { version, settingId: identity.settingId };
}

const provenMembers = new WeakMap();
/**
 * The theme's two records in the build's solution: the version web resource the app's row names (type 61) and the row
 * itself (the environment's appsetting type). The SDK made header-less adds neither, so after a changed set they are
 * added here (`add: true`), and then proven present by a fresh read. Without `add` it is a read-only proof, answering
 * the members that are missing. The ids come from the stored proof (proveStoredTheme): `stored` when the caller has
 * just made it, else it is made here.
 */
async function ensureAppThemeMembership(ctx, appId, versionName, { add = false, stored } = {}) {
  const sdk = ctx.sdk;
  const client = sdk.dataverse;
  const solution = solutionNameOf(ctx.solution);
  if (!solution) throw themeError('APP_THEME_PREREQUISITE_UNRESOLVED', 'app.theme: no solution to prove the theme\'s membership in.');
  const { version, settingId } = stored || await proveStoredTheme(client, appId, versionName);
  const cacheKey = `${lower(solution)}|${version.id}|${settingId}`;
  if (!provenMembers.has(sdk)) provenMembers.set(sdk, new Set());
  if (provenMembers.get(sdk).has(cacheKey)) return { proven: true, missing: [], added: 0 };
  const solutionInfo = await sdk.getSolution(solution);
  const solutionId = solutionInfo && solutionInfo.solutionId;
  if (!isGuid(solutionId)) throw themeError(READ_INCOMPLETE, 'app.theme: the solution did not read back with an id; nothing is concluded.');
  const wanted = [{ id: version.id, type: WEB_RESOURCE_COMPONENT, part: 'webResource' }, { id: settingId, type: await appSettingType(sdk), part: 'appSetting' }];
  const missing = await membersOf(client, solutionId, wanted);
  if (missing.length && !add) return { proven: false, missing: missing.map((member) => member.part), added: 0 };
  for (const member of missing) {
    await sdk.addSolutionComponent({ componentId: member.id, componentType: member.type, solutionUniqueName: solution, addRequiredComponents: false });
  }
  if (missing.length && (await membersOf(client, solutionId, wanted)).length) {
    throw themeError('APP_THEME_MEMBERSHIP_MISSING', 'app.theme: the theme\'s records were added to the solution, but did not read back as members.');
  }
  provenMembers.get(sdk).add(cacheKey);
  return { proven: true, missing: [], added: missing.length };
}

const refusedPlan = (code, extra = {}) => ({ operations: [], unknown: [], refused: [{ key: KEY, code, ...extra }] });
const unknownPlan = (code) => ({ operations: [], unknown: [{ key: KEY, code }] });

// Plan: undefined -> no operation and no request. Otherwise the key check (first time per client), one strict
// getAppTheme and, for a declared logo, one strict lookup decide set/remove/noChange; an equal theme in a solution also
// proves its membership, read-only. A read that cannot be placed leaves the operation `unknown`, never a guessed write.
async function planAppTheme(spec, ctx = {}) {
  const declared = themeOf(spec);
  if (declared === undefined) return { operations: [], unknown: [] };
  // A theme the lint would refuse is refused here too, before the read: a caller that skipped the lint still writes nothing.
  const { errors } = validateAppTheme(declared);
  if (errors.length) return { operations: [], unknown: [], refused: [{ key: KEY, code: 'APP_THEME_INVALID', errors }] };
  if (!isGuid(ctx.appId)) return refusedPlan('APP_THEME_PREREQUISITE_UNRESOLVED');
  const appId = lower(ctx.appId);
  const sdk = ctx.sdk;
  if (!isThemeReadGuarded(sdk)) return unknownPlan(READ_INCOMPLETE);
  if (isUnknown(sdk, appId)) return unknownPlan('create-outcome-unknown');
  return withThemeReadScope(sdk, { appId }, async (scope) => {
    let current;
    let definitionId;
    try {
      await assertThemeIdentityConstraint(sdk.dataverse, themeError);
      current = await sdk.getAppTheme(appId);
      definitionId = scope.definitions.get(THEME_SETTING);
      if (scope.incomplete || !isGuid(definitionId) || !current || !current.row) return unknownPlan(READ_INCOMPLETE);
      if (declared !== null) {
        const logo = await logoProblem(sdk.dataverse, declared);
        if (logo) return refusedPlan(logo);
      }
    } catch (error) {
      return unknownPlan(scope.incomplete ? READ_INCOMPLETE : codeOf(error));
    }
    let action;
    if (declared === null) action = rowRemoved(current) ? 'noChange' : 'remove';
    else if (!matchesDeclared(current.afterPublish, declared)) action = 'set';
    else {
      action = 'noChange';
      // Content equal is not complete while the theme's records are missing from the build's solution: nothing is
      // repaired silently (a no-op must not write), so the plan refuses and names the explicit repair.
      if (solutionNameOf(ctx.solution)) {
        let proof;
        try {
          proof = await ensureAppThemeMembership(ctx, appId, current.row.latestValue, { add: false });
        } catch (error) {
          return unknownPlan(scope.incomplete ? READ_INCOMPLETE : codeOf(error));
        }
        if (!proof.proven) {
          return refusedPlan('APP_THEME_MEMBERSHIP_MISSING', {
            missing: proof.missing,
            repair: 'Add the theme version web resource (component type 61) and the app\'s CustomThemeDefinition setting row to the solution with addSolutionComponent, then run again.',
          });
        }
      }
    }
    return {
      operations: [{ key: KEY, kind: 'appTheme', target: appId, action, destructive: action === 'remove', publicationScopes: ['app'], preconditions: [] }],
      unknown: [],
      theme: declared,
      settingDefinitionId: definitionId,
      pendingPublish: Boolean(current.pendingPublish),
    };
  });
}

// What a create port's answer must be for the set to count: a known success outcome and the setter's own answer.
//   passthrough  { outcome: 'created', id, childIds, ids, result }
//   fence        { outcome: 'applied', id: null, childIds: {}, result, evidence: 'sdk-acknowledged' }
// `result` is SetAppThemeResult: { appId, outcome: 'created'|'updated'|'unchanged'|'removed', webResource?, published,
// resolved, rowState, pendingPublish, pendingReasons, superseded, solutionComponentsAdded, warnings }.
const SET_OUTCOMES = new Set(['created', 'updated', 'unchanged']);
const usableSet = (written) => isObject(written) && SET_OUTCOMES.has(written.outcome);
// After a proven set, the membership failures that still leave what is stored unknown (see applyAppTheme); every failure of
// the set's own proof is unknown whatever its code.
const POST_SET_UNCERTAIN = new Set([READ_INCOMPLETE, IDENTITY_UNPROVEN, 'APP_THEME_NOT_SAVED']);
const usableRemove = (written) => isObject(written) && (written.outcome === 'removed' || written.outcome === 'unchanged');

async function applyAppTheme(plan, ctx = {}) {
  const result = emptyResult();
  if (plan && Array.isArray(plan.refused)) result.refused.push(...plan.refused.map(({ key, code }) => ({ key, code })));
  if (plan && Array.isArray(plan.unknown)) result.unknown.push(...plan.unknown.map(({ key, code }) => ({ key, code })));
  const op = plan && plan.operations && plan.operations[0];
  if (!op) return result;
  const sdk = ctx.sdk;
  const appId = lower(op.target);
  if (isUnknown(sdk, appId)) { result.unknown.push({ key: KEY, code: 'create-outcome-unknown' }); return result; }
  const queue = ctx.publication && typeof ctx.publication.queue === 'function' ? ctx.publication : null;
  const owe = () => {
    result.pendingPublish.push(KEY);
    try {
      queue.queue({ kind: 'app', id: appId, reason: KEY });
    } catch (error) {
      result.unknown.push({ key: KEY, code: codeOf(error) });
    }
  };
  // The app's publication belongs to the build's publication port (see the file header): without it nothing that
  // would owe one is done.
  if (!queue && (op.action !== 'noChange' || plan.pendingPublish)) { result.refused.push({ key: KEY, code: 'APP_THEME_PUBLISH_BLOCKED' }); return result; }
  if (op.action === 'noChange') {
    result.unchanged.push(KEY);
    // A theme already saved but not yet published is still owed to the app's publication.
    if (plan.pendingPublish) owe();
    return result;
  }
  if (!isThemeReadGuarded(sdk)) { result.unknown.push({ key: KEY, code: READ_INCOMPLETE }); return result; }
  const set = op.action === 'set';
  const port = ctx.creates && typeof ctx.creates.run === 'function' ? ctx.creates : null;
  // A removal creates nothing (it deletes the row, or leaves it removal-pending until the app publish), so only a set
  // needs the create port; a set without it is refused before any write.
  if (set && !port) { result.refused.push({ key: KEY, code: 'APP_THEME_CREATE_PORT_UNAVAILABLE' }); return result; }
  const publisherPrefix = typeof ctx.publisherPrefix === 'string' ? ctx.publisherPrefix.trim() : '';
  if (set && (!publisherPrefix || !isGuid(plan.settingDefinitionId))) { result.refused.push({ key: KEY, code: 'APP_THEME_PREREQUISITE_UNRESOLVED' }); return result; }
  return withThemeReadScope(sdk, { appId }, async (scope) => {
    const before = scope.writes;
    const unknownAfter = (code) => {
      const wrote = scope.writes > before;
      result.unknown.push(wrote ? { key: KEY, code, afterWrite: true } : { key: KEY, code });
      if (wrote) markUnknown(sdk, appId);
    };
    let written;
    try {
      if (set) {
        // The fence's key for this operation is the PROPERTY (app + setting definition), never a row or a version id,
        // and the theme and prefix are the setter's arguments: a changed theme or prefix is the same pair.
        const answer = await port.run({
          kind: 'appTheme', key: KEY, identity: { appId, settingDefinitionId: lower(plan.settingDefinitionId) }, childKeys: [],
        }, () => sdk.setAppTheme(appId, plan.theme, { publish: false, publisherPrefix }));
        written = answer && (answer.outcome === 'created' || answer.outcome === 'applied') ? answer.result : undefined;
        if (!usableSet(written)) { unknownAfter('APP_THEME_NOT_SAVED'); markUnknown(sdk, appId); return result; }
      } else {
        written = await sdk.setAppTheme(appId, null, { publish: false });
        if (!usableRemove(written)) { unknownAfter('APP_THEME_NOT_SAVED'); markUnknown(sdk, appId); return result; }
      }
    } catch (error) {
      if (isCreateStop(error)) {
        result.unknown.push({ key: KEY, code: error.code });
        markUnknown(sdk, appId);
        error.appTheme = result;
        throw error;
      }
      const code = scope.incomplete ? READ_INCOMPLETE : codeOf(error);
      // Only the write count is evidence that nothing was saved: an SDK code alone is not (a version POST can precede a
      // later conflict). A read that could not be placed, or an unproven key, is unknown even with no write.
      if (scope.writes === before && code !== READ_INCOMPLETE && code !== IDENTITY_UNPROVEN) result.refused.push({ key: KEY, code });
      else unknownAfter(code);
      return result;
    }
    (written.outcome === 'unchanged' ? result.unchanged : result.saved).push(KEY);
    if (set && !(isObject(written.webResource) && typeof written.webResource.name === 'string' && written.webResource.name)) {
      const stop = completionRequired('webResource');
      result.unknown.push({ key: KEY, code: stop.code });
      stop.appTheme = result;
      throw stop;
    }
    if (written.pendingPublish) owe();
    // A read the setter made that could not be placed leaves what the row holds unknown: nothing more is done to this
    // app's theme by this SDK (unknownAfter marks it), not even its membership.
    if (scope.incomplete) { unknownAfter(READ_INCOMPLETE); return result; }
    if (set) {
      const stopped = (error) => { markUnknown(sdk, appId); error.appTheme = result; result.unknown.push({ key: KEY, code: error.code }); return error; };
      // The set's own completion: the version it names and the app's row, read back. Until that proof is made, what the
      // row holds NOW is unknown, whatever stopped it (a read left incomplete, an unproven key, a row that holds another
      // theme, or a transport failure with no answer at all), so every failure here is sticky like an unknown set: a later
      // null or changed theme on this SDK must not remove or replace a row nobody can name.
      let stored;
      try {
        stored = await proveStoredTheme(sdk.dataverse, appId, written.webResource.name);
      } catch (error) {
        if (isCreateStop(error)) throw stopped(error);
        result.unknown.push({ key: KEY, code: scope.incomplete ? READ_INCOMPLETE : codeOf(error), afterWrite: true });
        markUnknown(sdk, appId);
        return result;
      }
      if (solutionNameOf(ctx.solution)) {
        try {
          await ensureAppThemeMembership(ctx, appId, written.webResource.name, { add: true, stored });
        } catch (error) {
          if (isCreateStop(error)) throw stopped(error);
          // The theme stays saved and its content is proven. A failed add of that known content (the member add or its
          // read-back) is not sticky: its explicit repair path (an equal theme refuses APP_THEME_MEMBERSHIP_MISSING) stays
          // open. A membership read that could not be placed still is.
          const code = scope.incomplete ? READ_INCOMPLETE : codeOf(error);
          result.unknown.push({ key: KEY, code, afterWrite: true });
          if (scope.incomplete || POST_SET_UNCERTAIN.has(code)) markUnknown(sdk, appId);
        }
      }
    }
    return result;
  });
}

// Verify: the stored and resolved state after publication. `live` only when the app resolves the declared theme, its
// saved row holds it too, and nothing about it is pending publication. This is not proof of what a browser paints.
//   [{ key, ok, state: 'live'|'pendingPublish'|'mismatch'|'unknown', code?, reasons? }]
async function verifyAppTheme(spec, ctx = {}) {
  const declared = themeOf(spec);
  if (declared === undefined) return [];
  const unknown = (code) => [{ key: KEY, ok: false, state: 'unknown', code }];
  if (!isGuid(ctx.appId)) return unknown('APP_THEME_PREREQUISITE_UNRESOLVED');
  const appId = lower(ctx.appId);
  if (!isThemeReadGuarded(ctx.sdk)) return unknown(READ_INCOMPLETE);
  // A set whose outcome is unknown is not settled by a read that happens to match.
  if (isUnknown(ctx.sdk, appId)) return unknown('create-outcome-unknown');
  return withThemeReadScope(ctx.sdk, { appId }, async (scope) => {
    let info;
    let logo = null;
    try {
      info = await ctx.sdk.getAppTheme(appId);
      if (declared !== null) logo = await logoProblem(ctx.sdk.dataverse, declared);
    } catch (error) {
      return unknown(scope.incomplete ? READ_INCOMPLETE : codeOf(error));
    }
    if (scope.incomplete || !info || !info.row) return unknown(READ_INCOMPLETE);
    const pending = () => [{ key: KEY, ok: false, state: 'pendingPublish', reasons: info.pendingReasons || [] }];
    if (declared === null) {
      // Removed only once no row of the app's own is left (see rowRemoved) AND nothing is pending its app publish.
      if (info.row.state === 'removalPending') return pending();
      if (info.row.state !== 'absent') return [{ key: KEY, ok: false, state: 'mismatch' }];
      if (info.pendingPublish) return pending();
      const live = Boolean(info.resolved) && info.resolved.source !== 'app' && info.resolved.source !== 'unknown';
      return [live ? { key: KEY, ok: true, state: 'live' } : { key: KEY, ok: false, state: 'mismatch' }];
    }
    if (logo) return [{ key: KEY, ok: false, state: 'mismatch', code: logo }];
    if (!matchesDeclared(info.afterPublish, declared)) return [{ key: KEY, ok: false, state: 'mismatch' }];
    if (info.pendingPublish) return pending();
    if (!matchesDeclared(info.resolved, declared)) return [{ key: KEY, ok: false, state: 'mismatch' }];
    if (solutionNameOf(ctx.solution)) {
      try {
        const proof = await ensureAppThemeMembership(ctx, appId, info.row.latestValue, { add: false });
        if (!proof.proven) return [{ key: KEY, ok: false, state: 'mismatch', code: 'APP_THEME_MEMBERSHIP_MISSING' }];
      } catch (error) {
        return unknown(scope.incomplete ? READ_INCOMPLETE : codeOf(error));
      }
    }
    return [{ key: KEY, ok: true, state: 'live' }];
  });
}

/**
 * Download: what the app's own theme row holds, as a spec's `app.theme`, from one getAppTheme answer (pure).
 *   { status: 'omitted' }                                     no row of the app's own: absence is not an authored intent,
 *                                                             and the environment's theme is never copied into the app
 *   { status: 'captured', theme: null, pendingPublish: true } the row's removal is saved and pending its app publish
 *   { status: 'captured', theme, pendingPublish }             the row's theme, read back exactly
 *   { status: 'refused', code }                               APP_THEME_UNREPRESENTABLE — the row holds the "no theme"
 *                                                             sentinel (it keeps the environment's theme out; null would
 *                                                             remove the row instead) or a theme the spec cannot state;
 *                                                             APP_THEME_READ_INCOMPLETE — it could not be read exactly
 */
function captureAppTheme(info) {
  if (!isObject(info) || !isObject(info.row)) return { status: 'refused', code: READ_INCOMPLETE };
  if (info.row.state === 'absent') return { status: 'omitted' };
  if (info.row.state === 'removalPending') return { status: 'captured', theme: null, pendingPublish: true };
  if (isNoneValue(info.row.latestValue)) return { status: 'refused', code: 'APP_THEME_UNREPRESENTABLE' };
  const binding = info.afterPublish;
  if (!isObject(binding) || binding.source !== 'app' || !isObject(binding.theme)) return { status: 'refused', code: READ_INCOMPLETE };
  const theme = canonicalTheme(binding.theme);
  if (binding.exact !== true || validateAppTheme(theme).errors.length) return { status: 'refused', code: 'APP_THEME_UNREPRESENTABLE' };
  return { status: 'captured', theme, pendingPublish: Boolean(info.pendingPublish) };
}

// The download's read: one strict getAppTheme, then captureAppTheme. Only run when capabilities were asked for.
async function downloadAppTheme(ctx = {}) {
  if (!isGuid(ctx.appId)) return { status: 'refused', code: 'APP_THEME_PREREQUISITE_UNRESOLVED' };
  if (!isThemeReadGuarded(ctx.sdk)) return { status: 'refused', code: READ_INCOMPLETE };
  return withThemeReadScope(ctx.sdk, { appId: ctx.appId }, async (scope) => {
    let info;
    try {
      info = await ctx.sdk.getAppTheme(lower(ctx.appId));
    } catch (error) {
      return { status: 'refused', code: scope.incomplete ? READ_INCOMPLETE : codeOf(error) };
    }
    if (scope.incomplete) return { status: 'refused', code: READ_INCOMPLETE };
    const captured = captureAppTheme(info);
    const name = captured.status === 'captured' && captured.theme && captured.theme.logo && captured.theme.logo.webResourceName;
    if (!name) return captured;
    // The header logo is part of what the theme shows: a theme captured without its image is not portable (a build from
    // it would refuse the missing logo, or show another image of that name). The SDK reports a missing logo only as a
    // warning, so it is looked up here, strictly, and named for the download to export as an external binary.
    let found;
    try {
      found = await webResourceByName(ctx.sdk.dataverse, name);
    } catch (error) {
      return { status: 'refused', code: scope.incomplete ? READ_INCOMPLETE : codeOf(error) };
    }
    if (scope.incomplete) return { status: 'refused', code: READ_INCOMPLETE };
    if (!found) return { status: 'refused', code: 'APP_THEME_LOGO_UNAVAILABLE' };
    if (!IMAGE_TYPES.has(found.type)) return { status: 'refused', code: 'APP_THEME_LOGO_INVALID' };
    return { ...captured, logo: { webResourceName: found.name, webResourceType: found.type } };
  });
}

/**
 * What a download does with downloadAppTheme's answer. Decided BEFORE anything is written, so a strict download that
 * cannot capture the theme exactly writes nothing (the same contract as the download's other lossy gates):
 *   captured           { write: true, theme, pendingPublish, logo? }  logo: the image to export as an EXTERNAL binary
 *                                                                     (named, never owned: a build does not delete it)
 *   omitted            { write: false }                               no theme of the app's own; nothing to say
 *   refused, strict    { write: false, error }                        the caller stops before output (exit 1)
 *   refused, lossy     { write: false, warning }                      --allow-lossy-download: the field is left out,
 *                                                                     and the loss is named
 * A spec without `app.theme` leaves the app's theme as it is when built, so an omission never removes a theme.
 */
const DOWNLOAD_REASONS = {
  APP_THEME_UNREPRESENTABLE: 'the app\'s theme row holds a value app.theme cannot state (the "no theme" sentinel, or attributes outside the schema)',
  APP_THEME_LOGO_UNAVAILABLE: 'the theme\'s header logo web resource no longer exists',
  APP_THEME_LOGO_INVALID: 'the theme\'s header logo is not an image web resource',
  [READ_INCOMPLETE]: 'the app\'s theme could not be read exactly',
};
function appThemeDownloadOutcome(result, { allowLossy = false } = {}) {
  if (isObject(result) && result.status === 'omitted') return { write: false };
  if (isObject(result) && result.status === 'captured' && result.theme !== undefined) {
    const outcome = { write: true, theme: result.theme, pendingPublish: Boolean(result.pendingPublish) };
    if (isObject(result.logo)) outcome.logo = { webResourceName: result.logo.webResourceName, webResourceType: result.logo.webResourceType, external: true };
    return outcome;
  }
  const code = isObject(result) && typeof result.code === 'string' && SAFE_CODE.test(result.code) ? result.code : 'APP_THEME_FAILED';
  const why = DOWNLOAD_REASONS[code] || 'the app\'s theme could not be read';
  if (!allowLossy) return { write: false, code, error: `app.theme: ${why} (${code}) — refusing to write a spec that would silently drop it. Pass --allow-lossy-download to write the spec without app.theme.` };
  return { write: false, code, warning: `app.theme was LEFT OUT (${code}): ${why}. A build from this spec leaves the app's theme as it is.` };
}

/**
 * The whole operation for a spec: null when `app.theme` is omitted (nothing read, nothing written), else plan + apply's
 * FeatureResult. `ctx`: { sdk (made with themeReads), appId, publication (the build's port), creates (the create port),
 * publisherPrefix, solution? (unique name, when the build's records belong to a solution) }.
 */
async function applyDeclaredAppTheme(spec, ctx = {}) {
  if (themeOf(spec) === undefined) return null;
  return applyAppTheme(await planAppTheme(spec, ctx), ctx);
}

const isComplete = (result) => !result || (result.refused.length === 0 && result.unknown.length === 0);

// The build-level failure for a requested theme that was refused or ended unknown. It carries the FeatureResult (what
// was saved is kept and reported), and is never run again automatically: a refusal will be refused again, and an
// unknown set must be read back by an explicit run, not sent again.
function appThemeIncomplete(result) {
  const codes = [...(result ? result.refused : []), ...(result ? result.unknown : [])].map((entry) => entry.code);
  return Object.assign(new Error(`app.theme: the app theme was not completed (${codes.join(', ') || 'no result'}).${result && result.saved.length ? ' What was saved is kept.' : ''}`), {
    code: 'APP_THEME_INCOMPLETE', recoverable: false, retry: RETRY.NEVER, transient: false, appTheme: result,
  });
}

module.exports = {
  validateAppTheme,
  planAppTheme,
  applyAppTheme,
  verifyAppTheme,
  applyDeclaredAppTheme,
  captureAppTheme,
  downloadAppTheme,
  appThemeDownloadOutcome,
  ensureAppThemeMembership,
  proveStoredTheme,
  appThemeIncomplete,
  isComplete,
  canonicalTheme,
  THEME_FIELDS,
  HEADER_FIELDS,
  KEY,
};
