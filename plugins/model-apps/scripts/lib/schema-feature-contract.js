'use strict';
// Shared schema-feature contract: the App Spec fields 2.21.0 adds to the data model, and the small, dependency-free helpers every
// consumer of those fields shares.
//
//   entities[].columns[].options[] / globalChoices[].options[]   a string, a localized label map, or `{ value, label }`
//   entities[].columns[].dateTimeBehavior                       'UserLocal' | 'DateOnly' | 'TimeZoneIndependent' (DateTime only)
//   entities[].columns[].isSecured                              boolean
//   entities[].searchEnabled / changeTrackingEnabled / duplicateDetectionEnabled   table flags
//   fieldSecurityProfiles[]                                     see lib/field-security.js
//
// This module deliberately requires nothing from lib/app-spec.js: app-spec.js is the validator that will call into it, so a require
// in the other direction would be a cycle. The two small helpers it needs from there (a version compare, the label alias rule) are
// restated below with the same behaviour and a pointer to the original.
//
// Every helper here follows the shared feature-helper roles: validate -> { errors, warnings }, plan -> { operations, unknown },
// apply -> FeatureResult, verify -> Check[]. Results name operations, tables and columns, never values, tokens or raw errors.

const { odataLit } = require('./odata.js');

const SCHEMA_FEATURES_MIN_VERSION = '2.21.0';

// The keys this contract adds, grouped by where they live, so the App Spec's closed-key lists can be extended from one place.
const COLUMN_FEATURE_KEYS = Object.freeze(['isSecured', 'dateTimeBehavior']);
const ENTITY_FEATURE_KEYS = Object.freeze(['searchEnabled', 'changeTrackingEnabled', 'duplicateDetectionEnabled']);
const SPEC_FEATURE_KEYS = Object.freeze(['fieldSecurityProfiles']);
const CHOICE_OPTION_KEYS = Object.freeze(['value', 'label']);
const FIELD_SECURITY_PROFILE_KEYS = Object.freeze(['key', 'name', 'description', 'permissions', 'assignTo']);
const FIELD_PERMISSION_KEYS = Object.freeze(['table', 'column', 'read', 'create', 'update']);
const ASSIGN_TO_KEYS = Object.freeze(['users', 'teams']);

// Dataverse `DateTimeBehavior` values. See:
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/behavior-format-date-time-attribute
const DATE_TIME_BEHAVIORS = Object.freeze(['UserLocal', 'DateOnly', 'TimeZoneIndependent']);

// The value the build has always given the option at position `i` when the spec does not state one. Kept as it is: every option
// set this plugin has ever created is numbered this way, so changing it would renumber deployed choices on the next rebuild.
const CHOICE_VALUE_BASE = 100000000;
// An option value is an Int32 on the wire (OptionMetadata.Value). Negative values are legal on the platform but no option this
// plugin authors needs one, and refusing them keeps a typo (`-1` for "none") from becoming a real option.
const CHOICE_VALUE_MAX = 2147483647;

// The id Dataverse gives the built-in "System Administrator" field-security profile in every organization. That profile is
// platform-managed: a spec must never create a same-named profile or try to modify it.
// See: https://learn.microsoft.com/en-us/power-platform/admin/field-level-security
const SYSTEM_ADMIN_PROFILE_ID = '572329c1-a042-4e22-be47-367c6374ea45';
const SYSTEM_ADMIN_PROFILE_NAME = 'System Administrator';
const PROFILE_NAME_MAX = 100;

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const lower = (v) => String(v == null ? '' : v).toLowerCase();

// Same rule as compareVersions in lib/app-spec.js: compare the release core only, so a pre-release requirement is met by its release.
function compareVersions(a, b) {
  const core = (v) => String(v || '').split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
  const [pa, pb] = [core(a), core(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------- choice options

// Is this option entry the explicit `{ value, label }` form, as opposed to a plain label or a localized label MAP?
//
// A localized label map is ALSO a plain object — `{ "1033": "Open", "3082": "Abierto" }` — so "is it an object" cannot tell them
// apart (lib/app-spec.js isLocalizedLabelMap answers true for both). The discriminator is the own keys: a map's keys are LCIDs, and
// no LCID is spelled `value` or `label`. An object that carries either name is therefore meant as the explicit form, and is held to
// it exactly: `{ label: "Open" }` alone, or `{ value: 1, label: "Open", color: "red" }`, is an error, never a map with odd keys.
function isChoiceOptionObject(entry) {
  return isPlainObject(entry) && (has(entry, 'value') || has(entry, 'label'));
}

// Every option entry as `{ value, label, explicit }`, in the author's order. `label` is what the author wrote (a string or a map);
// `value` is the explicit value, or the build's positional default. Malformed entries are passed through as best it can — the
// validator below is what rejects them, so a consumer that runs after validation never sees one.
//
// A list that is not an array at all throws the TypeError of `.map` on it, exactly as the build's own option mapping always did:
// the build relies on that to fail the one column in its own step (and to abandon a change set holding it) rather than create a
// choice column with no options. Missing (`undefined`/`null`) is an empty list.
function normalizeChoiceOptions(options) {
  return (options || []).map((entry, i) => {
    if (isChoiceOptionObject(entry)) return { value: entry.value, label: entry.label, explicit: true };
    return { value: CHOICE_VALUE_BASE + i, label: entry, explicit: false };
  });
}

function choiceOptionLabels(options) {
  return Array.isArray(options) ? normalizeChoiceOptions(options).map((o) => o.label) : [];
}

// The options as the SDK takes them (`{ value, label }`). For a spec that uses only strings and maps this is exactly what the
// build sent before the explicit form existed.
function choiceOptionsForSdk(options) {
  return normalizeChoiceOptions(options).map(({ value, label }) => ({ value, label }));
}

function hasExplicitChoiceValues(options) {
  return (Array.isArray(options) ? options : []).some(isChoiceOptionObject);
}

// Same rule as labelAliases in lib/app-spec.js: a plain label is itself; a localized label is each of its non-blank strings.
function labelAliasesOf(label) {
  if (typeof label === 'string') return label.trim() ? [label] : [];
  if (!isPlainObject(label)) return [];
  return Object.values(label).filter((v) => typeof v === 'string' && v.trim());
}

// alias (lower-cased, trimmed) -> the distinct values it names. An alias that names more than one value is ambiguous: a sample
// record or view filter that uses it must use the number instead, never the first match.
function choiceLabelIndex(options) {
  const index = new Map();
  if (!Array.isArray(options)) return index;
  for (const o of normalizeChoiceOptions(options)) {
    for (const alias of labelAliasesOf(o.label)) {
      const key = alias.trim().toLowerCase();
      if (!index.has(key)) index.set(key, []);
      const values = index.get(key);
      if (!values.includes(o.value)) values.push(o.value);
    }
  }
  return index;
}

// Structural errors in one option list: entry shapes, the explicit form's keys, its value range, and value uniqueness across the
// list once the positional defaults are filled in (so `[{ value: 100000001, label: 'A' }, 'B']` collides: 'B' is 100000001 too).
// Label CONTENT (blank, localized-map rules) is the existing label validator's job; this returns only what it alone can see.
function choiceOptionErrors(options, where) {
  const errors = [];
  if (options === undefined) return errors;
  if (!Array.isArray(options)) return [`${where} must be an array`];
  const seen = new Map();
  options.forEach((entry, i) => {
    const at = `${where}[${i}]`;
    if (isChoiceOptionObject(entry)) {
      const extra = Object.keys(entry).filter((k) => !CHOICE_OPTION_KEYS.includes(k));
      const missing = CHOICE_OPTION_KEYS.filter((k) => !has(entry, k));
      if (extra.length || missing.length) {
        errors.push(`${at} must have exactly 'value' and 'label'${missing.length ? ` (missing ${missing.join(', ')})` : ''}${extra.length ? ` (unknown ${extra.join(', ')})` : ''} — or be a plain label`);
        return;
      }
      if (!Number.isInteger(entry.value) || entry.value < 0 || entry.value > CHOICE_VALUE_MAX) {
        errors.push(`${at}.value must be a whole number from 0 to ${CHOICE_VALUE_MAX}, got ${JSON.stringify(entry.value)}`);
        return;
      }
      if (typeof entry.label !== 'string' && !(isPlainObject(entry.label) && !isChoiceOptionObject(entry.label))) {
        errors.push(`${at}.label must be a label (a string or a localized label map)`);
        return;
      }
    } else if (typeof entry !== 'string' && !isPlainObject(entry)) {
      errors.push(`${at} must be a label or { value, label }`);
      return;
    }
    const value = isChoiceOptionObject(entry) ? entry.value : CHOICE_VALUE_BASE + i;
    if (seen.has(value)) errors.push(`${at} has value ${value}, which option ${seen.get(value)} already uses — option values must be unique`);
    else seen.set(value, i);
  });
  return errors;
}

// ---------------------------------------------------------------------------------------------------------------- validation

function usesSchemaFeatures(spec) {
  if (!isPlainObject(spec)) return false;
  if (spec.fieldSecurityProfiles !== undefined) return true;
  const optionLists = [];
  for (const e of Array.isArray(spec.entities) ? spec.entities : []) {
    if (!isPlainObject(e)) continue;
    if (ENTITY_FEATURE_KEYS.some((k) => e[k] !== undefined)) return true;
    for (const c of Array.isArray(e.columns) ? e.columns : []) {
      if (!isPlainObject(c)) continue;
      if (COLUMN_FEATURE_KEYS.some((k) => c[k] !== undefined)) return true;
      optionLists.push(c.options);
    }
  }
  for (const g of Array.isArray(spec.globalChoices) ? spec.globalChoices : []) if (isPlainObject(g)) optionLists.push(g.options);
  return optionLists.some(hasExplicitChoiceValues);
}

function closedKeyErrors(obj, allowed, where) {
  return Object.keys(obj).filter((k) => !allowed.includes(k)).map((k) => `${where}: unknown property '${k}' (allowed: ${allowed.join(', ')})`);
}

function validateColumnFeatures(e, c, where, errors) {
  if (c.isSecured !== undefined) {
    if (typeof c.isSecured !== 'boolean') errors.push(`${where}.isSecured must be a boolean, got ${JSON.stringify(c.isSecured)}`);
    // createCustomerColumn takes no security option and updateColumn refuses a Customer column, so the build has no way to make
    // one secured. Refuse it here rather than build an unsecured column the spec says is secured.
    else if (c.type === 'Customer') errors.push(`${where}.isSecured is not supported on a Customer column — the build cannot secure one; secure it in the maker portal`);
  }
  if (c.dateTimeBehavior !== undefined) {
    if (!DATE_TIME_BEHAVIORS.includes(c.dateTimeBehavior)) {
      errors.push(`${where}.dateTimeBehavior must be one of ${DATE_TIME_BEHAVIORS.join('|')}, got ${JSON.stringify(c.dateTimeBehavior)}`);
    } else if (c.type !== 'DateTime') {
      errors.push(`${where}.dateTimeBehavior applies only to a DateTime column, not '${c.type || 'Text'}'`);
    } else if (c.dateTimeBehavior === 'DateOnly' && c.dateFormat === 'DateAndTime') {
      // The platform refuses DateOnly behaviour with a DateAndTime format (HTTP 400), and the SDK refuses it before sending.
      errors.push(`${where}: dateTimeBehavior 'DateOnly' cannot have dateFormat 'DateAndTime' — use dateFormat 'DateOnly' or omit it`);
    }
  }
  if (c.type === 'Choice' || c.type === 'MultiChoice') errors.push(...choiceOptionErrors(c.options, `${where}.options`));
}

function validateEntityFlags(e, where, errors) {
  for (const k of ['searchEnabled', 'duplicateDetectionEnabled']) {
    if (e[k] !== undefined && typeof e[k] !== 'boolean') errors.push(`${where}.${k} must be a boolean, got ${JSON.stringify(e[k])}`);
  }
  if (e.changeTrackingEnabled !== undefined && e.changeTrackingEnabled !== true) {
    // Change tracking is one-way on the platform: once on it stays on (a `false` write is answered 204 and changes nothing).
    // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/use-change-tracking-synchronize-data-external-systems
    errors.push(`${where}.changeTrackingEnabled can only be true — change tracking cannot be turned off once on; omit it to leave the table as it is`);
  }
  if (e.searchEnabled === true && e.changeTrackingEnabled !== true) {
    errors.push(`${where}: searchEnabled true also turns on change tracking, which can never be turned off — set changeTrackingEnabled: true to confirm`);
  }
}

function validateFieldSecurityProfiles(spec, errors, warnings) {
  const profiles = spec.fieldSecurityProfiles;
  if (profiles === undefined) return;
  if (!Array.isArray(profiles)) { errors.push('fieldSecurityProfiles must be an array'); return; }
  const declaredColumns = new Map(); // "table.column" -> column
  for (const e of Array.isArray(spec.entities) ? spec.entities : []) {
    if (!isPlainObject(e)) continue;
    for (const c of Array.isArray(e.columns) ? e.columns : []) {
      if (isPlainObject(c) && c.schemaName) declaredColumns.set(`${lower(e.schemaName)}.${lower(c.schemaName)}`, c);
    }
  }
  const keys = new Set();
  const names = new Set();
  profiles.forEach((p, i) => {
    const at = `fieldSecurityProfiles[${i}]`;
    if (!isPlainObject(p)) { errors.push(`${at} must be an object`); return; }
    errors.push(...closedKeyErrors(p, FIELD_SECURITY_PROFILE_KEYS, at));
    if (typeof p.key !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(p.key)) {
      errors.push(`${at}.key must be a stable identifier (a letter, then letters, digits, '_' or '-', at most 64), got ${JSON.stringify(p.key)}`);
    } else if (keys.has(p.key)) errors.push(`${at}.key '${p.key}' is used by another profile`);
    else keys.add(p.key);
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > PROFILE_NAME_MAX) {
      errors.push(`${at}.name must be a non-empty string of at most ${PROFILE_NAME_MAX} characters`);
    } else if (p.name.trim().toLowerCase() === SYSTEM_ADMIN_PROFILE_NAME.toLowerCase()) {
      errors.push(`${at}.name '${p.name}' is the platform's own profile — the build never creates or changes it`);
    } else if (names.has(p.name.trim().toLowerCase())) {
      // The platform does not keep profile names unique, but the build finds an existing profile by name, so two in one spec
      // would make the second find the first.
      errors.push(`${at}.name '${p.name}' is used by another profile`);
    } else names.add(p.name.trim().toLowerCase());
    if (p.description !== undefined && typeof p.description !== 'string') errors.push(`${at}.description must be a string`);
    if (!Array.isArray(p.permissions)) errors.push(`${at}.permissions must be an array`);
    const perms = new Set();
    (Array.isArray(p.permissions) ? p.permissions : []).forEach((perm, j) => {
      const pat = `${at}.permissions[${j}]`;
      if (!isPlainObject(perm)) { errors.push(`${pat} must be an object`); return; }
      if (has(perm, 'readUnmasked')) {
        errors.push(`${pat}.readUnmasked is not supported — unmasked read is an administrator decision; set it in the maker portal`);
      }
      errors.push(...closedKeyErrors(perm, FIELD_PERMISSION_KEYS, pat).filter((m) => !/'readUnmasked'/.test(m)));
      for (const k of ['read', 'create', 'update']) {
        if (perm[k] !== undefined && typeof perm[k] !== 'boolean') errors.push(`${pat}.${k} must be a boolean`);
      }
      if (typeof perm.table !== 'string' || !perm.table.trim() || typeof perm.column !== 'string' || !perm.column.trim()) {
        errors.push(`${pat} needs a table and a column (logical names)`);
        return;
      }
      const id = `${lower(perm.table)}.${lower(perm.column)}`;
      if (perms.has(id)) { errors.push(`${pat}: ${id} has another permission in this profile`); return; }
      perms.add(id);
      const col = declaredColumns.get(id);
      if (col && col.isSecured !== true) {
        errors.push(`${pat}: ${id} is not secured — set isSecured: true on the column (a permission on an unsecured column is refused)`);
      } else if (!col) {
        warnings.push(`${pat}: ${id} is not declared in this spec; it must already be a secured column in the environment`);
      }
    });
    if (p.assignTo !== undefined) {
      if (!isPlainObject(p.assignTo)) { errors.push(`${at}.assignTo must be an object`); return; }
      errors.push(...closedKeyErrors(p.assignTo, ASSIGN_TO_KEYS, `${at}.assignTo`));
      for (const k of ASSIGN_TO_KEYS) {
        const list = p.assignTo[k];
        if (list === undefined) continue;
        if (!Array.isArray(list)) { errors.push(`${at}.assignTo.${k} must be an array of ids`); continue; }
        const ids = new Set();
        list.forEach((g, n) => {
          if (typeof g !== 'string' || !GUID_RE.test(g)) errors.push(`${at}.assignTo.${k}[${n}] must be a GUID`);
          else if (ids.has(g.toLowerCase())) errors.push(`${at}.assignTo.${k}[${n}] repeats an id`);
          else ids.add(g.toLowerCase());
        });
      }
    }
  });
}

// The second argument (`{ profile }`) is the shared helper signature; this contract applies the same rules to every spec profile.
function validateSchemaFeatures(spec) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(spec)) return { errors, warnings };
  (Array.isArray(spec.entities) ? spec.entities : []).forEach((e, i) => {
    if (!isPlainObject(e)) return;
    const at = `entities[${i}] (${e.schemaName})`;
    validateEntityFlags(e, at, errors);
    (Array.isArray(e.columns) ? e.columns : []).forEach((c, j) => {
      if (isPlainObject(c)) validateColumnFeatures(e, c, `${at}.columns[${j}] (${c.schemaName})`, errors);
    });
  });
  (Array.isArray(spec.globalChoices) ? spec.globalChoices : []).forEach((g, i) => {
    if (isPlainObject(g)) errors.push(...choiceOptionErrors(g.options, `globalChoices[${i}] (${g.name}).options`));
  });
  validateFieldSecurityProfiles(spec, errors, warnings);
  if (usesSchemaFeatures(spec) && compareVersions(spec.minimumPluginVersion, SCHEMA_FEATURES_MIN_VERSION) < 0) {
    warnings.push(`set minimumPluginVersion to '${SCHEMA_FEATURES_MIN_VERSION}' or newer when using explicit option values, dateTimeBehavior, isSecured, table search/tracking/duplicate-detection flags or fieldSecurityProfiles — older plugins ignore or reject these fields`);
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------------------------------------------------------- column types (L25)

// The spec type -> the deployed `AttributeTypeName.Value` it creates. `AttributeType` alone cannot tell File, Image and
// MultiChoice apart (all three are 'Virtual'), so the type NAME is compared when the read carries it.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/attributetypedisplayname
const DEPLOYED_TYPE_NAME = Object.freeze({
  Text: 'StringType', AutoNumber: 'StringType', Memo: 'MemoType', Integer: 'IntegerType', BigInt: 'BigIntType',
  Decimal: 'DecimalType', Double: 'DoubleType', Money: 'MoneyType', DateTime: 'DateTimeType', Boolean: 'BooleanType',
  Choice: 'PicklistType', MultiChoice: 'MultiSelectPicklistType', File: 'FileType', Image: 'ImageType',
  Customer: 'CustomerType', Lookup: 'LookupType',
});
const DEPLOYED_TYPE = Object.freeze({
  StringType: 'String', MemoType: 'Memo', IntegerType: 'Integer', BigIntType: 'BigInt', DecimalType: 'Decimal', DoubleType: 'Double',
  MoneyType: 'Money', DateTimeType: 'DateTime', BooleanType: 'Boolean', PicklistType: 'Picklist', CustomerType: 'Customer', LookupType: 'Lookup',
});

// A declared column whose deployed type differs from the spec's. Column types are immutable on the platform (changing one means
// a new column and a data migration), so a rebuild never "reapplies" a type: this only lets verification SAY the spec and the
// environment disagree, instead of passing because a column of that name exists.
//
// `deployed` rows are attribute metadata, e.g.
//   { "LogicalName": "new_amount", "AttributeType": "Decimal", "AttributeTypeName": { "Value": "DecimalType" } }
//   { "LogicalName": "new_photo",  "AttributeType": "Virtual", "AttributeTypeName": { "Value": "ImageType" } }
// A row without a readable type is `unknown`, never a match: 'Virtual' with no type name could be any of three types.
function columnTypeMismatches(entity, deployed) {
  const byName = new Map((Array.isArray(deployed) ? deployed : []).map((r) => [lower(r && (r.LogicalName || r.logicalName)), r]));
  const mismatches = [];
  const unknown = [];
  for (const c of (entity && entity.columns) || []) {
    if (!c || !c.schemaName) continue;
    const row = byName.get(lower(c.schemaName));
    if (!row) continue; // absent is the existence check's finding, not a type mismatch
    const want = DEPLOYED_TYPE_NAME[c.type || 'Text'];
    if (!want) continue;
    const typeName = row.AttributeTypeName && typeof row.AttributeTypeName.Value === 'string' ? row.AttributeTypeName.Value : undefined;
    const type = typeof row.AttributeType === 'string' ? row.AttributeType : undefined;
    const target = { table: lower(entity.schemaName), column: lower(c.schemaName), declared: c.type || 'Text' };
    if (typeName) {
      if (typeName !== want) mismatches.push(Object.assign(target, { deployed: typeName }));
    } else if (type && type !== 'Virtual' && DEPLOYED_TYPE[want]) {
      if (type !== DEPLOYED_TYPE[want]) mismatches.push(Object.assign(target, { deployed: type }));
    } else {
      unknown.push(target);
    }
  }
  return { mismatches, unknown };
}

// ---------------------------------------------------------------------------------------------------------------- table flags

const TABLE_FLAGS_SELECT = 'IsDuplicateDetectionEnabled,ChangeTrackingEnabled,SyncToExternalSearchIndex,CanEnableSyncToExternalSearchIndex';

function declaredTableFlags(entity) {
  const out = {};
  for (const k of ENTITY_FEATURE_KEYS) if (entity && entity[k] !== undefined) out[k] = entity[k];
  return out;
}

// One scalar read of a table's three flags and the managed property that gates search, e.g.
//   { "IsDuplicateDetectionEnabled": { "Value": true, "CanBeChanged": true }, "ChangeTrackingEnabled": false,
//     "SyncToExternalSearchIndex": false, "CanEnableSyncToExternalSearchIndex": { "Value": true } }
// Scalars only — no labels — so it cannot strip a localized label from a create that follows it. Any property the answer does
// not state as a boolean is `undefined` (unknown), never false: a plan must not treat "could not read" as "off".
async function readTableFlags(provision, logical) {
  const raw = provision && provision.dataverse;
  if (!raw || typeof raw.get !== 'function') return null;
  let res;
  try {
    res = await raw.get(`/EntityDefinitions(LogicalName='${odataLit(logical)}')?$select=${TABLE_FLAGS_SELECT}`);
  } catch (_) { return null; }
  if (!res || res.status < 200 || res.status >= 300 || !isPlainObject(res.body)) return null;
  const b = res.body;
  const bool = (v) => (typeof v === 'boolean' ? v : undefined);
  const managed = (v) => (isPlainObject(v) ? bool(v.Value) : undefined);
  return {
    duplicateDetectionEnabled: managed(b.IsDuplicateDetectionEnabled),
    changeTrackingEnabled: bool(b.ChangeTrackingEnabled),
    searchEnabled: bool(b.SyncToExternalSearchIndex),
    canEnableSearch: managed(b.CanEnableSyncToExternalSearchIndex),
  };
}

function isAuthorized(authorizedDestructive, key) {
  if (authorizedDestructive === true) return true;
  if (authorizedDestructive instanceof Set) return authorizedDestructive.has(key);
  if (Array.isArray(authorizedDestructive)) return authorizedDestructive.includes(key);
  return false;
}

// What one table's declared flags need, against what `current` (readTableFlags, or null when it could not be read) says.
// At most one operation per table — the SDK writes all three in one PUT. A flag already at its declared value is not written.
//
//   duplicateDetectionEnabled false on a table that has it on (or might)   destructive: it unpublishes every published duplicate
//                                                                         rule of the table, and turning it on again does not
//                                                                         republish them. Refused unless authorized.
//   searchEnabled true where CanEnableSyncToExternalSearchIndex is false  refused: the managed property forbids it.
//   searchEnabled true on an untracked table                              the write carries changeTrackingEnabled: true, the
//                                                                         explicit consent the SDK needs (validation already
//                                                                         required it in the spec).
function planTableFlags(entity, current, { authorizedDestructive } = {}) {
  const operations = [];
  const unknown = [];
  const refused = [];
  const declared = declaredTableFlags(entity);
  if (!Object.keys(declared).length) return { operations, unknown, refused };
  const logical = lower(entity.schemaName);
  const key = `tableFlags:${logical}`;
  const cur = current || {};
  const changes = {};
  let destructive = false;
  if (declared.duplicateDetectionEnabled !== undefined && cur.duplicateDetectionEnabled !== declared.duplicateDetectionEnabled) {
    if (declared.duplicateDetectionEnabled === false) {
      if (!isAuthorized(authorizedDestructive, key)) {
        refused.push({ key, kind: 'tableFlags', target: logical, code: 'DESTRUCTIVE_NOT_AUTHORIZED', reason: 'turning duplicate detection off unpublishes every duplicate rule of the table' });
      } else { changes.duplicateDetectionEnabled = false; destructive = true; }
    } else changes.duplicateDetectionEnabled = true;
  }
  if (declared.searchEnabled !== undefined && cur.searchEnabled !== declared.searchEnabled) {
    if (declared.searchEnabled === true && cur.canEnableSearch === false) {
      refused.push({ key, kind: 'tableFlags', target: logical, code: 'TABLE_SEARCH_NOT_ALLOWED', reason: 'the table does not allow Dataverse search (CanEnableSyncToExternalSearchIndex is false)' });
    } else {
      changes.searchEnabled = declared.searchEnabled;
      if (declared.searchEnabled === true && cur.changeTrackingEnabled !== true) changes.changeTrackingEnabled = true;
    }
  }
  if (declared.changeTrackingEnabled === true && cur.changeTrackingEnabled !== true) changes.changeTrackingEnabled = true;
  if (current === null || current === undefined) {
    unknown.push({ key, kind: 'tableFlags', target: logical, code: 'TABLE_FLAGS_UNREAD', reason: 'the current flags could not be read; every declared flag is written and the SDK re-checks its own rules' });
  }
  if (Object.keys(changes).length) {
    // Duplicate detection is entity metadata the platform applies on publish of the table; search and change tracking are
    // metadata-only (the SDK documents no publish for search).
    const publicationScopes = changes.duplicateDetectionEnabled !== undefined ? [`table:${logical}`] : [];
    operations.push({ key, kind: 'tableFlags', target: logical, action: 'update', destructive, publicationScopes, preconditions: [], changes });
  }
  return { operations, unknown, refused };
}

function emptyFeatureResult() {
  return { saved: [], unchanged: [], pendingPublish: [], refused: [], unknown: [], managedBindings: [] };
}

// Write each planned table-flag operation through the SDK's updateTable (which re-reads the table and enforces its own one-way
// rules before its PUT). A TableSearchNotAllowedError — the managed property changed between the plan's read and the write — is
// a refusal, not a crash; any other error propagates so the runner turns it into the build's own halt.
async function applyTableFlags(plan, ctx) {
  const result = emptyFeatureResult();
  for (const r of plan.refused || []) result.refused.push(r);
  for (const op of plan.operations || []) {
    try {
      await ctx.sdk.updateTable(op.target, Object.assign({}, op.changes));
    } catch (e) {
      if (e && (e.name === 'TableSearchNotAllowedError' || e.code === 'TABLE_SEARCH_NOT_ALLOWED')) {
        result.refused.push({ key: op.key, kind: op.kind, target: op.target, code: 'TABLE_SEARCH_NOT_ALLOWED', reason: 'the table does not allow Dataverse search' });
        continue;
      }
      throw e;
    }
    result.saved.push(op.key);
    for (const scope of op.publicationScopes || []) {
      if (ctx.publication && typeof ctx.publication.queue === 'function') ctx.publication.queue(scope);
      if (!result.pendingPublish.includes(op.key)) result.pendingPublish.push(op.key);
    }
  }
  return result;
}

// One check per declared flag against a fresh read. `undefined` in the read is `unknown`, never a pass.
function verifyTableFlags(entity, current) {
  const logical = lower(entity && entity.schemaName);
  return Object.entries(declaredTableFlags(entity)).map(([flag, want]) => {
    const got = current ? current[flag] : undefined;
    const status = got === undefined ? 'unknown' : (got === want ? 'pass' : 'fail');
    return { key: `tableFlags:${logical}.${flag}`, kind: 'tableFlag', target: logical, status, detail: `${flag} declared ${want}, deployed ${got === undefined ? 'unreadable' : got}` };
  });
}

module.exports = {
  SCHEMA_FEATURES_MIN_VERSION,
  COLUMN_FEATURE_KEYS,
  ENTITY_FEATURE_KEYS,
  SPEC_FEATURE_KEYS,
  CHOICE_OPTION_KEYS,
  FIELD_SECURITY_PROFILE_KEYS,
  FIELD_PERMISSION_KEYS,
  ASSIGN_TO_KEYS,
  DATE_TIME_BEHAVIORS,
  CHOICE_VALUE_BASE,
  CHOICE_VALUE_MAX,
  SYSTEM_ADMIN_PROFILE_ID,
  SYSTEM_ADMIN_PROFILE_NAME,
  GUID_RE,
  isChoiceOptionObject,
  normalizeChoiceOptions,
  choiceOptionLabels,
  choiceOptionsForSdk,
  hasExplicitChoiceValues,
  choiceLabelIndex,
  choiceOptionErrors,
  usesSchemaFeatures,
  validateSchemaFeatures,
  columnTypeMismatches,
  declaredTableFlags,
  readTableFlags,
  planTableFlags,
  applyTableFlags,
  verifyTableFlags,
  isAuthorized,
  emptyFeatureResult,
};
