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
// An equal theme sends nothing; a removal sends only the row's DELETE. A superseded theme version is never deleted
// here: the SDK reports it (`superseded`) and leaves it.
//
// Every set goes through the build's create port (`ctx.creates.run`): it may create two records whose ids the server
// assigns (the version web resource and the setting row). Without the port nothing is written.

const { THEME_PALETTE_SLOTS } = require('./maker-sdk.js');
const { sha256 } = require('./hash.js');

const COLOR = /^#[0-9A-Fa-f]{6}$/;
const HEADER_FIELDS = ['background', 'foreground', 'backgroundHover', 'foregroundHover', 'backgroundPressed', 'foregroundPressed', 'backgroundSelected', 'foregroundSelected'];
const THEME_FIELDS = ['basePaletteColor', 'lockPrimary', 'vibrancy', 'hueTorsion', 'font', 'palette', 'appHeader', 'logo'];
const LOGO_FIELDS = ['webResourceName', 'tooltip'];
const KEY = 'app.theme';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Refusals before any request. The SDK validates as well (ValidationError 'appTheme'); checking here first lets the spec
// lint name the field, and refuses `additionalAttributes`, which the SDK would pass through to the stored theme.
function validateAppTheme(theme, { path = KEY } = {}) {
  const errors = [];
  if (theme === undefined || theme === null) return { errors, warnings: [] };
  if (!isObject(theme)) return { errors: [`${path} must be an object, or null to remove the app's theme`], warnings: [] };
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
//   { source: 'app'|'environment'|'none'|'unknown', webResourceName?, theme?, exact? }
// `exact: false` means the stored version could not be read back field for field, so it is never "equal".
function matchesDeclared(binding, declared) {
  if (!binding || binding.source === 'unknown') return false;
  return binding.source === 'app' && binding.exact !== false && sameTheme(binding.theme, declared);
}

// null means "the app has no theme row of its own", so it is decided from the ROW (AppThemeInfo.row.state:
// 'absent'|'draft'|'published'|'publishedWithDraft'|'removalPending'), never from what the app resolves: a row holding
// the "no theme" sentinel `""` resolves to source 'none', yet it is still the app's own override and keeps the
// environment's theme from applying. Only an absent row, or one whose removal is pending its app publish, is removed.
const rowRemoved = (info) => Boolean(info && info.row && (info.row.state === 'absent' || info.row.state === 'removalPending'));

const themeOf = (spec) => (spec && spec.app ? spec.app.theme : undefined);

// Plan: undefined -> no operation and no request. Otherwise ONE read (getAppTheme) decides set/remove/noChange; a read
// that fails leaves the operation `unknown`, never a guessed write.
async function planAppTheme(spec, ctx) {
  const declared = themeOf(spec);
  if (declared === undefined) return { operations: [], unknown: [] };
  // A theme the lint would refuse is refused here too, before the read: a caller that skipped the lint still writes nothing.
  const { errors } = validateAppTheme(declared);
  if (errors.length) return { operations: [], unknown: [], refused: [{ key: KEY, code: 'APP_THEME_INVALID', errors }] };
  let current;
  try {
    current = await ctx.sdk.getAppTheme(ctx.appId);
  } catch (error) {
    return { operations: [], unknown: [{ key: KEY, code: (error && error.code) || 'APP_THEME_UNREADABLE' }] };
  }
  const action = declared === null
    ? (rowRemoved(current) ? 'noChange' : 'remove')
    : (matchesDeclared(current && current.afterPublish, declared) ? 'noChange' : 'set');
  return {
    operations: [{ key: KEY, kind: 'appTheme', target: ctx.appId, action, destructive: action === 'remove', publicationScopes: ['app'], preconditions: [] }],
    unknown: [],
    theme: declared,
    pendingPublish: Boolean(current && current.pendingPublish),
  };
}

// Codes that the SDK raises BEFORE it writes anything: the theme was refused. Any other failure may have saved part of
// it (a version web resource, the setting row), so it is `unknown` and the build re-reads rather than claims either.
const PREWRITE = new Set(['APP_THEME_LOGO_INVALID', 'APP_THEME_UNAVAILABLE', 'APP_THEME_PUBLISH_BLOCKED', 'APP_THEME_NAME_TAKEN', 'VALIDATION_ERROR']);
const codeOf = (error) => (error && (error.code || (error.name === 'ValidationError' ? 'VALIDATION_ERROR' : undefined))) || 'APP_THEME_FAILED';

async function applyAppTheme(plan, ctx) {
  const result = { saved: [], unchanged: [], pendingPublish: [], refused: [], unknown: [], managedBindings: [] };
  if (plan && Array.isArray(plan.refused)) result.refused.push(...plan.refused.map(({ key, code }) => ({ key, code })));
  if (plan && Array.isArray(plan.unknown)) result.unknown.push(...plan.unknown);
  const op = plan && plan.operations && plan.operations[0];
  if (!op) return result;
  if (op.action === 'noChange') {
    result.unchanged.push(KEY);
    // A theme already saved but not yet published is still owed to the app's publication.
    if (plan.pendingPublish) { result.pendingPublish.push(KEY); ctx.publication.queue({ kind: 'app', id: op.target, reason: KEY }); }
    return result;
  }
  const theme = op.action === 'remove' ? null : plan.theme;
  // publish:false always: the app's publication belongs to the build's publication port (see the file header).
  const execute = () => ctx.sdk.setAppTheme(op.target, theme, { publish: false });
  const port = ctx.creates && typeof ctx.creates.run === 'function' ? ctx.creates : null;
  // A removal creates nothing (it deletes the row, or leaves it removal-pending until the app publish), so only a set
  // needs the create port; a set without it is refused before any write.
  if (theme !== null && !port) {
    result.refused.push({ key: KEY, code: 'APP_THEME_CREATE_PORT_UNAVAILABLE' });
    return result;
  }
  let written;
  try {
    if (theme === null) {
      written = await execute();
    } else {
      const answer = await port.run(themeCreate(op.target, theme), execute);
      // The port answers { outcome: 'created'|'adopted'|'refused'|'unknown', result, code? }, `result` being the
      // setter's own answer; a port that hands the setter's answer back as it came is read as 'created'. The setter's
      // answer has an `outcome` too ('created'|'updated'|'unchanged'|'removed') but never a `result`.
      const fromPort = answer && typeof answer === 'object' && Object.prototype.hasOwnProperty.call(answer, 'result');
      const outcome = fromPort ? answer.outcome : 'created';
      if (outcome === 'unknown' || outcome === 'refused') {
        (outcome === 'unknown' ? result.unknown : result.refused).push({ key: KEY, code: answer.code || (outcome === 'unknown' ? 'APP_THEME_CREATE_UNKNOWN' : 'APP_THEME_CREATE_REFUSED') });
        return result;
      }
      written = fromPort ? answer.result : answer;
      // An earlier run's create the port resolved as made ('adopted') carries no setter answer: what it left is read
      // back, and counts only when the app will show exactly the declared theme.
      if (!written) {
        const info = await ctx.sdk.getAppTheme(op.target);
        if (!matchesDeclared(info && info.afterPublish, theme)) {
          result.unknown.push({ key: KEY, code: 'APP_THEME_NOT_SAVED' });
          return result;
        }
        written = { outcome: 'unchanged', pendingPublish: Boolean(info.pendingPublish) };
      }
    }
  } catch (error) {
    const code = codeOf(error);
    (PREWRITE.has(code) ? result.refused : result.unknown).push({ key: KEY, code });
    return result;
  }
  if (!written || written.outcome === 'unchanged') result.unchanged.push(KEY);
  else result.saved.push(KEY);
  if (written && written.webResource && written.webResource.created) {
    result.managedBindings.push({ kind: 'webResource', key: KEY, id: written.webResource.id, origin: 'created' });
  }
  if (written && written.pendingPublish) {
    result.pendingPublish.push(KEY);
    ctx.publication.queue({ kind: 'app', id: op.target, reason: KEY });
  }
  return result;
}

// The create port's description of one theme set. setAppTheme may create two records, and the SERVER assigns both ids:
//   webResource  the version, `<prefix>_/apptheme/<16 hex>.xml`, named by the SDK from the theme's serialized bytes
//   appSetting   the app's one CustomThemeDefinition row (Dataverse allows one row per app and setting definition)
// so the port reserves no id. It records the create under `identity` — the app, the setting, and a hash of the declared
// theme — and reads the ids the setter reports back through `receipt`. Running the setter again is safe: an existing
// version of equal bytes is reused (a different one under that name is refused), and the row is written only when the
// setter's own pre-write read still sees the snapshot it started from.
function themeCreate(appId, theme) {
  return {
    kind: 'appTheme',
    key: KEY,
    identity: { appId, setting: 'CustomThemeDefinition', sha256: sha256(JSON.stringify(canonicalTheme(theme))) },
    childKeys: ['webResource', 'appSetting'],
    serverAssigned: true,
    receipt: (written) => ({
      id: written && written.webResource ? written.webResource.id : null,
      childIds: { webResource: written && written.webResource ? written.webResource.id : null },
      versionName: written && written.webResource ? written.webResource.name : null,
    }),
  };
}
// Verify: the stored and resolved state after publication. `ok` only when the app will show the declared theme AND
// nothing about it is pending publication. This is not proof of what a browser paints.
async function verifyAppTheme(spec, ctx) {
  const declared = themeOf(spec);
  if (declared === undefined) return [];
  let info;
  try {
    info = await ctx.sdk.getAppTheme(ctx.appId);
  } catch (error) {
    return [{ key: KEY, ok: false, state: 'unknown', code: (error && error.code) || 'APP_THEME_UNREADABLE' }];
  }
  if (declared === null) {
    // Removed only once no row of the app's own is left (see rowRemoved) AND nothing is pending its app publish; the
    // app then resolves the environment's theme, or none.
    if (!(info && info.row && info.row.state === 'absent')) {
      return [info && info.row && info.row.state === 'removalPending'
        ? { key: KEY, ok: false, state: 'pendingPublish', reasons: info.pendingReasons || [] }
        : { key: KEY, ok: false, state: 'differs' }];
    }
    if (info.pendingPublish) return [{ key: KEY, ok: false, state: 'pendingPublish', reasons: info.pendingReasons || [] }];
    const live = Boolean(info.resolved) && info.resolved.source !== 'app' && info.resolved.source !== 'unknown';
    return [{ key: KEY, ok: live, state: live ? 'live' : 'differs' }];
  }
  if (!matchesDeclared(info.afterPublish, declared)) return [{ key: KEY, ok: false, state: 'differs' }];
  if (info.pendingPublish) return [{ key: KEY, ok: false, state: 'pendingPublish', reasons: info.pendingReasons || [] }];
  return [{ key: KEY, ok: matchesDeclared(info.resolved, declared), state: matchesDeclared(info.resolved, declared) ? 'live' : 'differs' }];
}

module.exports = { validateAppTheme, planAppTheme, applyAppTheme, verifyAppTheme, canonicalTheme, THEME_FIELDS, HEADER_FIELDS };
