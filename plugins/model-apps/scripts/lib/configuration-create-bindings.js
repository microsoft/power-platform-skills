'use strict';

// The protected create driver of the four configuration families — environment variables, connection references,
// Custom APIs and duplicate detection rules — over the managed create lifecycle (managed-create-context.js) and its
// send-once gate (managed-create-transport.js). The build uses it under the `configurationIdentity` opt-in, through the
// protected port (configuration-protected.js); this module answers the questions a protected create must ask, and
// nothing here sends a write.
//   planOf(spec, opts)                   the row plan of one artifact (buildRowPlan input) at its derived ids
//   createClassifier(entries)            the gate's classifier: which planned row (or completion effect) a request is
//   classifyConstituent(entries, req)    the same, for one constituent of a $batch change set (a bound Custom API's edit)
//   readConfigurationRow(dv, kind, id)   one exact-id read: present (with its row version), absent (only a 404 0x80040217) or unknown
//   readConfigurationConflicts(dv, p)    the fully paged namesake queries a create must run first
//   observe(dv, planned)                 the fresh read a recovery or a settle judges, the root's complete child graph included
//   readComponentTypes(dv)               the ObjectTypeCode of each member table
//   acceptResultFor(planned)             the run's check of what the SDK's pushArtifact answered
//
// Why the comparisons are closed tables rather than "compare what came back":
// - A row at the derived id is ours only when it holds exactly what the plan prepared. Every column a read selects
//   decodes through a fixed table; a value the table does not know (a new option code, a type change) is UNKNOWN,
//   never "close enough", and a column this build never writes must be empty or the row is not the one it prepared.
// - The projection a row is judged by hashes semantic fields (names exact, table and column names lower case), so the
//   same row read through another API version or spelling compares the same. A Custom API's labels the App Spec leaves
//   out are pinned in the plan to what the SDK fills them with (pinApiLabels), so any other label is a difference.
// - A private input — an environment variable's value, a connection reference's connection id — is never part of a
//   plan, a projection, a sealed send or a hash: it is held in memory against the planned object only (PRIVATE), and
//   compared there. Even its digest would be a dictionary-attackable copy of a short secret, so none is kept.

const crypto = require('crypto');
const { canonicalJson, normalizeGuid } = require('./reconcile-common.js');
const { odataLit } = require('./odata.js');
const { isRestrictedSolution } = require('./system-solutions.js');
const { apiPath, headerValue } = require('./workflow-effect-context.js');
const { sentProjection } = require('./managed-create-transport.js');
const { CODES, acceptSaved } = require('./managed-create-context.js');
const { intentFor: defaultIntentFor } = require('./creates-capabilities.js');
const { createIntentCatalog } = require('./creates-port.js');
const A = require('./configuration-artifacts.js');

// The binding store's not-found code for a bound row that is gone, and the delete refusal of this driver's scope.
const NOT_FOUND_CODE = 'configuration-row-not-found';
const DELETE_CODE = 'configuration-protected-removal-unsupported';
const PRIVATE_MISMATCH = 'configuration-private-input-mismatch';

const sha = (value) => crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
const lower = (v) => String(v).toLowerCase();
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const rowKey = (kind, key) => `${kind}\u0000${key}`;

// ---------------------------------------------------------------------------------------------
// Closed option tables. A code outside a table decodes to BAD: the row is unreadable, never matched.

// environmentvariabledefinition.type
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/environmentvariabledefinition#BKMK_Type
const EV_TYPES = Object.freeze({ string: 100000000, number: 100000001, boolean: 100000002, json: 100000003, dataSource: 100000004, secret: 100000005 });
// environmentvariabledefinition.secretstore: where a Secret's value is kept. The SDK manages a Secret only as an Azure
// Key Vault reference and refuses to fetch one whose secretstore is set to anything but 0
// (ENVIRONMENT_VARIABLE_SECRET_UNRECOGNIZED). No create this build plans sends the column, whatever the type, so a row it
// made reads back empty or 0 (the column's default); 1 (kept by Dataverse) is a definition someone else made or changed,
// and a code outside the table is unreadable.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/environmentvariabledefinition#BKMK_SecretStore
const SECRET_STORES = Object.freeze({ keyVault: 0, dataverse: 1 });
// customapi.bindingtype and customapi.allowedcustomprocessingsteptype
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/customapi#BKMK_BindingType
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/customapi#BKMK_AllowedCustomProcessingStepType
const API_BINDINGS = Object.freeze({ global: 0, entity: 1, entityCollection: 2 });
const API_STEPS = Object.freeze({ none: 0, asyncOnly: 1, syncAndAsync: 2 });
// customapirequestparameter.type and customapiresponseproperty.type (one option set)
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/customapirequestparameter#BKMK_Type
const PARAM_TYPES = Object.freeze({
  boolean: 0, dateTime: 1, decimal: 2, entity: 3, entityCollection: 4, entityReference: 5, float: 6, integer: 7,
  money: 8, picklist: 9, string: 10, stringArray: 11, guid: 12,
});
// duplicaterulecondition.operatorcode; operatorparam carries the character count of first/lastCharacters.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/duplicaterulecondition#BKMK_OperatorCode
const MATCH_CODES = Object.freeze({ exact: 0, firstCharacters: 1, lastCharacters: 2, sameDate: 3, sameDateAndTime: 4, exactChoiceLabel: 5, exactChoiceValue: 6 });
// duplicaterule statecode/statuscode: 0/0 Unpublished, 0/1 Publishing (a job in flight: neither state), 1/2 Published.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/duplicaterule#BKMK_StatusCode
function ruleStateOf(statecode, statuscode) {
  if (statecode === 0 && statuscode === 0) return 'unpublished';
  if (statecode === 1 && statuscode === 2) return 'published';
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Decoders: wire value -> semantic value, or BAD.

const BAD = Symbol('bad');
const text = (v) => (v === null || typeof v === 'string' ? v : BAD);
const lowerText = (v) => (v === null ? null : typeof v === 'string' ? v.toLowerCase() : BAD);
const bool = (v) => (typeof v === 'boolean' ? v : BAD);
const guid = (v) => (v === null ? null : typeof v === 'string' && normalizeGuid(v) ? normalizeGuid(v) : BAD);
const count = (v) => (v === null || (Number.isInteger(v) && v >= 0) ? v : BAD);
function code(table) {
  const byCode = new Map(Object.entries(table).map(([name, n]) => [n, name]));
  return (v) => (byCode.has(v) ? byCode.get(v) : BAD);
}
// An optional choice column: empty, or a code of its table.
function optionalCode(table) {
  const decodeCode = code(table);
  return (v) => (v === null ? null : decodeCode(v));
}
// A column this build never writes. It may only be empty: a value there was put by someone else.
const UNMODELLED = 'unmodelled';
// A column this build never writes that the platform fills on create with a known default, and that may be changed
// outside the plugin once the row exists. Dataverse stores 0 in a connection reference's `promptingbehavior` when the
// create omits it (a live read shows `"promptingbehavior": 0` on every reference the build made), so a closed map that
// expected it empty never proved one; a maker can later set it in the portal.
//   - A body that carries the column at all, an explicit null included, is unmodelled: no request this build planned
//     writes it, and a null would clear what the platform or a maker put there.
//   - A read that finds it empty or holding exactly the default reports nothing: the two are the same platform state.
//   - A read that finds any other value keeps it as preserved bound-row state (decoded.preserved), as PRESERVED below: a
//     create expects none, so a fresh row holding it is still a conflict; an update expects exactly what its fresh base
//     read held (planOf), so an edit of a row changed outside the plugin is planned over that value, never writes it,
//     and is proved only while the row still holds it.
const defaulted = (value) => Object.freeze({ defaulted: value });
const isDefaulted = (spec) => isPlain(spec) && has(spec, 'defaulted');
// A column this build never writes but a BOUND row may hold, set outside the plugin: a Custom API's implementation (its
// plug-in type), which an App Spec cannot declare (configuration-artifacts.js refuses `pluginTypeId`) and which is
// registered after the API exists. A read keeps its exact value (decoded.preserved); a body that carries the column at all
// is not a write this build planned. A create expects it empty, as an unmodelled column; an update expects exactly the
// value its fresh base read held (planOf), so an edit is proved only while the row still holds that same implementation.
const PRESERVED = 'preserved';
// The private input's column: compared in memory (privateStateOf), never projected.
const PRIVATE = 'private';
// The lookup to the row's parent: the managed row protocol's parentId (managed-create-context.js), not a field.
const PARENT = 'parent';
// The rule's state columns: read as ruleState (observe), not a field.
const STATE = 'state';

// Each kind: its entity set, primary key, the table its component type is read from, the namesake column (roots), the
// parent's set and lookup (children), and the closed map of every column a read selects and a create may send:
//   column -> [semantic field, decoder, create default when the body omits it]   or one of the markers above.
// A create default is what the platform stores for an omitted column (null text, false flags, the first option); a
// required column has none, so a body without it is not the planned create.
// Column names: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/about-entity-reference
const KINDS = Object.freeze({
  environmentVariable: {
    set: 'environmentvariabledefinitions', pk: 'environmentvariabledefinitionid', name: 'schemaname', nameField: 'schemaName',
    columns: {
      schemaname: ['schemaName', text], displayname: ['name', text, null], description: ['description', text, null],
      type: ['type', code(EV_TYPES)], defaultvalue: ['defaultValue', text, null], isrequired: ['isRequired', bool, false],
      valueschema: ['valueSchema', text, null], apiid: ['connectorId', text, null], parameterkey: ['parameterKey', text, null],
      _parentdefinitionid_value: ['parentDefinitionId', guid, null], secretstore: ['secretStore', optionalCode(SECRET_STORES), null],
      hint: UNMODELLED, learnmoreurl: UNMODELLED, inputcontrolconfig: UNMODELLED,
    },
    binds: { ParentDefinitionId: ['_parentdefinitionid_value', 'environmentvariabledefinitions'] },
  },
  // A value row is never a solution member (it would export this environment's value), and it carries nothing but
  // the private value and its definition.
  environmentVariableValue: {
    set: 'environmentvariablevalues', pk: 'environmentvariablevalueid', parentSet: 'environmentvariabledefinitions',
    parentBind: 'EnvironmentVariableDefinitionId', parentColumn: '_environmentvariabledefinitionid_value', nav: null,
    columns: { value: PRIVATE, _environmentvariabledefinitionid_value: PARENT },
    privateColumn: 'value',
  },
  connectionReference: {
    set: 'connectionreferences', pk: 'connectionreferenceid', name: 'connectionreferencelogicalname', nameField: 'logicalName',
    columns: {
      connectionreferencelogicalname: ['logicalName', text], connectionreferencedisplayname: ['name', text, null],
      description: ['description', text, null], connectorid: ['connectorId', text], _customconnectorid_value: ['customConnectorId', guid, null],
      connectionid: PRIVATE,
      connectionparametersconfig: UNMODELLED, connectionparametersetconfig: UNMODELLED, promptingbehavior: defaulted(0),
    },
    binds: { CustomConnectorId: ['_customconnectorid_value', 'connectors'] },
    privateColumn: 'connectionid',
  },
  customApi: {
    set: 'customapis', pk: 'customapiid', name: 'uniquename', nameField: 'uniqueName',
    columns: {
      uniquename: ['uniqueName', text], name: ['name', text, null], displayname: ['displayName', text, null], description: ['description', text, null],
      bindingtype: ['binding', code(API_BINDINGS), 'global'], boundentitylogicalname: ['boundEntityLogicalName', lowerText, null],
      isfunction: ['isFunction', bool, false], isprivate: ['isPrivate', bool, false],
      allowedcustomprocessingsteptype: ['allowedProcessingSteps', code(API_STEPS), 'none'], workflowsdkstepenabled: ['enabledForWorkflow', bool, false],
      executeprivilegename: ['executePrivilegeName', text, null],
      _plugintypeid_value: PRESERVED,
    },
    binds: {},
  },
  customApiRequestParameter: {
    set: 'customapirequestparameters', pk: 'customapirequestparameterid', parentSet: 'customapis',
    parentBind: 'CustomAPIId', parentColumn: '_customapiid_value', nav: 'CustomAPIRequestParameters',
    columns: {
      uniquename: ['uniqueName', text], name: ['name', text, null], displayname: ['displayName', text, null], description: ['description', text, null],
      type: ['type', code(PARAM_TYPES)], logicalentityname: ['entityLogicalName', lowerText, null], isoptional: ['isOptional', bool, false],
      _customapiid_value: PARENT,
    },
  },
  customApiResponseProperty: {
    set: 'customapiresponseproperties', pk: 'customapiresponsepropertyid', parentSet: 'customapis',
    parentBind: 'CustomAPIId', parentColumn: '_customapiid_value', nav: 'CustomAPIResponseProperties',
    columns: {
      uniquename: ['uniqueName', text], name: ['name', text, null], displayname: ['displayName', text, null], description: ['description', text, null],
      type: ['type', code(PARAM_TYPES)], logicalentityname: ['entityLogicalName', lowerText, null],
      _customapiid_value: PARENT,
    },
  },
  duplicateRule: {
    set: 'duplicaterules', pk: 'duplicateruleid', name: 'name', nameField: 'name',
    columns: {
      name: ['name', text], description: ['description', text, null], baseentityname: ['entityLogicalName', lowerText],
      matchingentityname: ['matchingEntityLogicalName', lowerText], iscasesensitive: ['caseSensitive', bool, false],
      excludeinactiverecords: ['excludeInactiveRecords', bool, false], statecode: STATE, statuscode: STATE,
    },
    binds: {},
  },
  // A condition is only ever created inside its rule's deep insert: a condition sent on its own (a direct POST or the
  // platform's CompoundUpdateDuplicateDetectionRule $batch) is refused, so its parent is never bound by a body.
  duplicateRuleCondition: {
    set: 'duplicateruleconditions', pk: 'duplicateruleconditionid', parentSet: 'duplicaterules',
    parentBind: null, parentColumn: '_regardingobjectid_value', nav: 'DuplicateRule_DuplicateRuleConditions',
    columns: {
      baseattributename: ['column', lowerText], matchingattributename: ['matchingColumn', lowerText, null],
      operatorcode: ['match', code(MATCH_CODES)], operatorparam: ['characters', count, null], ignoreblankvalues: ['ignoreBlankValues', bool, false],
      _regardingobjectid_value: PARENT,
    },
  },
});
const ROOT_KINDS = new Set(['environmentVariable', 'connectionReference', 'customApi', 'duplicateRule']);
// The slot of a child under its root, as the create port names it (configurationCreateIntents).
function childKindOf(rootKind, slot) {
  if (rootKind === 'environmentVariable') return 'environmentVariableValue';
  if (rootKind === 'customApi') return slot.startsWith('request:') ? 'customApiRequestParameter' : 'customApiResponseProperty';
  return 'duplicateRuleCondition';
}
// The membership component type of each kind: a table's ObjectTypeCode, read at plan time (readComponentTypes); an
// environment variable definition's is the fixed 380.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/solutioncomponent#BKMK_ComponentType
const MEMBER_TABLES = Object.freeze({ ...A.MEMBERSHIP_TABLES, ...A.CHILD_MEMBERSHIP_TABLES });

// ---------------------------------------------------------------------------------------------
// Decoding and projection

// A lookup in a body: "EnvironmentVariableDefinitionId@odata.bind": "/environmentvariabledefinitions(<guid>)". Only the
// set the kind binds to, by GUID; an alternate key or another set names no row this plan prepared.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/associate-disassociate-entities-using-web-api#associate-entity-records-on-create
function boundGuid(value, set) {
  const m = /^\/?([A-Za-z_][A-Za-z0-9_]*)\(([^()]*)\)$/.exec(typeof value === 'string' ? value : '');
  if (!m || m[1].toLowerCase() !== set) return BAD;
  return normalizeGuid(m[2]) || BAD;
}

/**
 * Decode one wire object of `kind` through its closed map. `mode`:
 *   'read'    a row a read selected every mapped column of: a missing column is unreadable;
 *   'create'  a create body: an omitted column takes its create default, an omitted required column is not the plan;
 *   'patch'   a PATCH body: only what it carries.
 * Answers { fields, unmodelled, preserved, parentId, private: { present, value }, state } or null (unreadable / not this
 * kind's); `preserved` maps each filled PRESERVED column to its GUID and each defaulted column holding another value than
 * its default to that value, and only a read has any.
 * A body's keys outside the map (other than the primary key, an allowed bind and the navigations the caller takes
 * out) make it null: a column this build does not model is not part of any create it planned.
 */
function decode(kind, raw, mode) {
  if (!isPlain(raw)) return null;
  const k = KINDS[kind];
  const wire = {};
  let parentId;
  for (const [key, value] of Object.entries(raw)) {
    if (key === k.pk) continue;
    if (mode === 'read' && key.startsWith('@odata.')) continue;
    const bind = /^(.+)@odata\.bind$/.exec(key);
    if (bind && mode !== 'read') {
      if (k.parentBind && bind[1] === k.parentBind) {
        const g = boundGuid(value, k.parentSet);
        if (g === BAD) return null;
        parentId = g;
        continue;
      }
      const target = k.binds && k.binds[bind[1]];
      if (!target) return null;
      const g = value === null ? null : boundGuid(value, target[1]);
      if (g === BAD) return null;
      wire[target[0]] = g;
      continue;
    }
    if (!has(k.columns, key)) {
      if (mode === 'read') continue;
      return null;
    }
    wire[key] = value;
  }
  const fields = {};
  const unmodelled = [];
  const preserved = {};
  const state = {};
  let secret = { present: false, value: undefined };
  for (const [col, spec] of Object.entries(k.columns)) {
    const present = has(wire, col);
    const v = wire[col];
    if (spec === UNMODELLED) { if (present && v !== null) unmodelled.push(col); continue; }
    if (isDefaulted(spec)) {
      if (!present) continue;
      if (mode !== 'read') { unmodelled.push(col); continue; }
      if (v === null || v === spec.defaulted) continue;
      // The only values a preserved column holds are JSON scalars a projection can hash; anything else is unreadable.
      if (typeof v !== 'number' && typeof v !== 'string' && typeof v !== 'boolean') return null;
      preserved[col] = v;
      continue;
    }
    if (spec === PRESERVED) {
      if (!present) continue;
      // Never written: even an explicit null would clear the implementation someone else registered.
      if (mode !== 'read') return null;
      if (v === null) continue;
      const g = guid(v);
      if (g === BAD) return null;
      preserved[col] = g;
      continue;
    }
    if (spec === PRIVATE) { if (present) secret = { present: true, value: v }; continue; }
    if (spec === STATE) { if (present) state[col] = v; else if (mode === 'read') return null; continue; }
    if (spec === PARENT) {
      if (!present) { if (mode === 'read') return null; continue; }
      const g = guid(v);
      if (g === BAD || (parentId !== undefined && parentId !== g)) return null;
      parentId = g;
      continue;
    }
    const [field, decoder, fallback] = spec;
    if (!present) {
      if (mode === 'patch') continue;
      if (mode === 'create' && spec.length === 3) { fields[field] = fallback; continue; }
      return null;
    }
    const d = decoder(v);
    if (d === BAD) return null;
    fields[field] = d;
  }
  return { fields, unmodelled: unmodelled.sort(), preserved, parentId: parentId === undefined ? undefined : parentId, private: secret, state };
}

// The semantic fields a decoded row compares by. A condition takes the comparable shape the planner uses
// (normalCondition: its matching column defaults to its own column, a character count only where it counts); a
// connection reference says only WHETHER it is connected — which connection is private.
function semanticOf(kind, decoded, mode = 'read') {
  if (kind === 'duplicateRuleCondition') {
    if (mode === 'patch') return decoded.fields;
    return A.normalCondition(decoded.fields);
  }
  if (kind === 'connectionReference' && (mode !== 'patch' || decoded.private.present)) {
    const v = decoded.private.value;
    return { ...decoded.fields, connected: decoded.private.present && v !== null && v !== undefined && v !== '' };
  }
  // Empty and 0 (Key Vault, the default) are the one store a definition this build made can read back with (SECRET_STORES).
  if (kind === 'environmentVariable' && has(decoded.fields, 'secretStore')) {
    return { ...decoded.fields, secretStore: decoded.fields.secretStore === 'keyVault' ? null : decoded.fields.secretStore };
  }
  return decoded.fields;
}

const LABELS = ['name', 'displayName', 'description'];
const labelsOf = (from) => Object.fromEntries(LABELS.map((f) => [f, has(from, f) && from[f] !== undefined ? from[f] : null]));
const guidOrText = (v) => (v == null ? null : normalizeGuid(v) || String(v));

// What a row the plan prepares must read back as, from the artifact the SDK is handed (configuration-artifacts.js
// buildArtifact) — one definition for both, so the plan and the push cannot drift apart. A Custom API's labels are
// all in it: planOf pins the ones the App Spec leaves out (pinApiLabels) before this reads them.
function expectedOf(kind, artifact, child) {
  switch (kind) {
    case 'environmentVariable':
      return {
        schemaName: artifact.schemaName, name: artifact.name, description: artifact.description, type: artifact.type,
        defaultValue: artifact.defaultValue, isRequired: artifact.isRequired, valueSchema: artifact.valueSchema,
        connectorId: artifact.connectorId, parameterKey: artifact.parameterKey, parentDefinitionId: artifact.parentId ? normalizeGuid(artifact.parentId) : null,
        secretStore: null,
      };
    case 'environmentVariableValue':
      return {};
    case 'connectionReference':
      return {
        logicalName: artifact.logicalName, name: artifact.name, description: artifact.description, connectorId: artifact.connectorId,
        customConnectorId: guidOrText(artifact.customConnectorId), connected: artifact.connectionId != null && artifact.connectionId !== '',
      };
    case 'customApi':
      return {
        uniqueName: artifact.uniqueName, binding: artifact.binding, boundEntityLogicalName: artifact.boundEntityLogicalName,
        isFunction: artifact.isFunction, allowedProcessingSteps: artifact.allowedProcessingSteps, enabledForWorkflow: artifact.enabledForWorkflow,
        isPrivate: artifact.isPrivate, executePrivilegeName: artifact.executePrivilegeName, ...labelsOf(artifact),
      };
    case 'customApiRequestParameter':
    case 'customApiResponseProperty':
      return {
        uniqueName: child.uniqueName, type: child.type, entityLogicalName: child.entityLogicalName == null ? null : lower(child.entityLogicalName),
        ...(kind === 'customApiRequestParameter' ? { isOptional: child.isOptional === true } : {}), ...labelsOf(child),
      };
    case 'duplicateRule':
      return {
        name: artifact.name, description: artifact.description, entityLogicalName: artifact.entityLogicalName,
        matchingEntityLogicalName: artifact.matchingEntityLogicalName, caseSensitive: artifact.caseSensitive, excludeInactiveRecords: artifact.excludeInactiveRecords,
      };
    case 'duplicateRuleCondition':
      return A.normalCondition(child);
    default:
      throw new TypeError(`unsupported configuration kind ${kind}`);
  }
}

// Whether the App Spec authors `field` on `from`: present and not undefined. An explicit null or false is authored (it
// clears or turns off); only an omitted field is left to the row.
const authored = (from, field) => isPlain(from) && has(from, field) && from[field] !== undefined;

/**
 * What a row the plan UPDATES must read back as: the row's own fields from its fresh exact read (`base`), with only what
 * the App Spec authors laid over them — the same overlay the existing typed planner compares by
 * (configuration-artifacts.js variablePlan, referencePlan, customApiPlan / compareChildren, duplicateRulePlan /
 * overlayCondition). `created` is what a CREATE of the same declaration reads back as (expectedOf): an authored field
 * takes its value from there, so a create and an update of one declaration say the same thing about it. An omitted
 * field never takes a create default: the update does not send it, and the row keeps what it has.
 * Kept from `created` in every case: the identity fields, the immutable ones the App Spec must state (a definition's
 * type, a reference's connector, a rule's table, a child's type), a definition's secret store (only the store a create
 * makes is supported, so another one read back is a difference, never an expectation) and a Custom API root's labels
 * (pinApiLabels has already laid them over the base).
 */
function boundExpectation(kind, created, base, declared, binds) {
  const row = semanticOf(kind, base.decoded);
  const out = { ...created };
  const keep = (field) => { out[field] = has(row, field) ? row[field] : null; };
  const unless = (isAuthored, fields) => { if (!isAuthored) for (const f of fields) keep(f); };
  switch (kind) {
    case 'environmentVariable':
      unless(declared.name != null, ['name']);
      for (const f of ['description', 'defaultValue', 'valueSchema', 'connectorId', 'parameterKey']) unless(authored(declared, f), [f]);
      unless(has(declared, 'isRequired'), ['isRequired']);
      unless(has(declared, 'parentSchemaName'), ['parentDefinitionId']);
      return out;
    case 'connectionReference':
      unless(declared.name != null, ['name']);
      unless(authored(declared, 'description'), ['description']);
      unless(authored(declared, 'customConnectorId'), ['customConnectorId']);
      // Connected is what the deployment settings ask for when they name the reference, else the row's own.
      unless(!!binds.connectionReferences.get(lower(declared.logicalName)), ['connected']);
      return out;
    case 'customApi':
      for (const f of ['binding', 'boundEntityLogicalName', 'isFunction', 'allowedProcessingSteps', 'enabledForWorkflow', 'isPrivate', 'executePrivilegeName']) unless(authored(declared, f), [f]);
      return out;
    case 'customApiRequestParameter':
    case 'customApiResponseProperty':
      if (kind === 'customApiRequestParameter') unless(has(declared, 'isOptional'), ['isOptional']);
      unless(authored(declared, 'entityLogicalName'), ['entityLogicalName']);
      // A child's label: authored (an explicit null clears it) or the row's own.
      for (const f of LABELS) out[f] = authored(declared, f) ? declared[f] : has(row, f) ? row[f] : null;
      return out;
    case 'duplicateRule':
      unless(nonEmpty(declared.name), ['name']);
      for (const f of ['description', 'matchingEntity', 'caseSensitive', 'excludeInactiveRecords']) unless(authored(declared, f), [f === 'matchingEntity' ? 'matchingEntityLogicalName' : f]);
      return out;
    case 'duplicateRuleCondition': {
      // configuration-artifacts.js overlayCondition: the column and match are the declaration's; the matching column,
      // character count and blank handling it omits stay as the row has them.
      const fields = base.decoded.fields;
      const pick = (f) => (authored(declared, f) ? declared[f] : fields[f]);
      return A.normalCondition({ column: declared.column, matchingColumn: pick('matchingColumn'), match: declared.match, characters: pick('characters'), ignoreBlankValues: pick('ignoreBlankValues') === true });
    }
    default:
      return out;
  }
}

// The declaration of the child in `slot` of a root entry: a Custom API child by its unique name in its direction, a
// condition by its key; a value has none (an empty object).
function declaredChild(entry, slot) {
  if (slot.startsWith('request:') || slot.startsWith('response:')) {
    const list = slot.startsWith('request:') ? entry.requestParameters : entry.responseProperties;
    return (list || []).find((c) => lower(c.uniqueName) === slot.slice(slot.indexOf(':') + 1)) || {};
  }
  return (entry.conditions || []).find((c) => c.key === slot) || {};
}

// The state a bound rule keeps when its App Spec omits `status`: the row's own, published while a publish is in flight.
function boundRuleState(base) {
  return ruleStateOf(base.decoded.state.statecode, base.decoded.state.statuscode) || 'published';
}

// The projection a row is judged by: the expected fields only, plus every unmodelled column a read found filled, every
// preserved column's exact value and, for a root, every child row its complete graph holds that the plan does not (observe):
//   sha256(canonicalJson({ kind, fields: { <expected field>: <value>, ... }, unmodelled?: [<column>, ...],
//                          preserved?: { <column>: <guid> }, unexpectedChildren?: ['<kind>:<id>', ...] }))
// Each list or map is left out when empty, so a row with none hashes exactly as its expectation does. An expectation
// carries `preserved` only for an update whose base read held one (planOf): a created row expects none.
function projectionOf(kind, expected, semantic, unmodelled = [], unexpectedChildren = [], preserved = {}) {
  const fields = Object.fromEntries(Object.keys(expected).map((f) => [f, has(semantic, f) ? semantic[f] : null]));
  return sha({ kind, fields, ...(unmodelled.length ? { unmodelled } : {}), ...(Object.keys(preserved).length ? { preserved } : {}), ...(unexpectedChildren.length ? { unexpectedChildren } : {}) });
}
const sameValue = (a, b) => canonicalJson(a === undefined ? null : a) === canonicalJson(b === undefined ? null : b);

// ---------------------------------------------------------------------------------------------
// The plan

// planned object -> { artifact, secrets: Map(rowKey -> private input) }. Module-private and keyed by the frozen planned
// object, so a private input reaches no plan, no JSON of a planned object, no store record and no log: only the SDK
// artifact (artifactFor) and the in-memory comparisons below see it.
const PRIVATE_INPUTS = new WeakMap();
const PLAN_KEY_FIELD = Object.freeze({ environmentVariable: 'schemaName', connectionReference: 'logicalName', customApi: 'uniqueName', duplicateRule: 'key' });

// A Dataverse row version as a read answers it in `@odata.etag` and a conditional PATCH sends it in If-Match: W/"<n>".
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/perform-conditional-operations-using-web-api
const ROW_VERSION = /^W\/"\d+"$/;

// The fresh base read of one row a plan UPDATES: a readConfigurationRow answer, present, of that kind at that id, under
// the planned parent and, for a kind a plan can PATCH, with a row version. Anything else throws: an update prepared from
// no read, a stale read of another row or a PATCH-able read without a version would let a PATCH through with no
// condition the plan holds. A duplicate rule and its conditions are never PATCHed under the opt-in (a changed rule stops
// with configuration-edit-unsupported), so a bound rule is planned and verified by its exact id and content projection
// alone — and Dataverse answers `duplicaterules` rows without `@odata.etag`, so requiring one there left a bound rule
// that could never be rebuilt or verified.
function baseOf(bases, kind, id, parentId) {
  const b = bases instanceof Map ? bases.get(id) : isPlain(bases) && has(bases, id) ? bases[id] : undefined;
  const versioned = !PATCHABLE.has(kind) || (isPlain(b) && typeof b.rowVersion === 'string' && ROW_VERSION.test(b.rowVersion));
  if (!isPlain(b) || b.state !== 'present' || b.kind !== kind || b.id !== id || !versioned
    || (parentId !== null && b.parentId !== parentId) || !isPlain(b.decoded) || !isPlain(b.decoded.fields)) {
    throw new TypeError(`planOf: the ${kind} ${id} is planned as an update but has no fresh base read${PATCHABLE.has(kind) ? ' with a row version' : ''} (readConfigurationRow)`);
  }
  return b;
}

// Pin every Custom API label in the artifact before anything is planned from it, so the plan, the push and the read-back
// all compare one value and no label is left for something else to fill:
//   a label the App Spec authors                 that label;
//   an update row's label it does not author     the row's own label, from its fresh base read (an update keeps it);
//   a created row's label it does not author     what the SDK fills it with at push — the same defaults, in the same order:
//     root (CustomApiAdapter.createDefault, `??`)        name = uniqueName, displayName = uniqueName, description = displayName
//     child (CustomApiAdapter.normalize, `=== undefined`) name = '<api uniqueName>.<child uniqueName>', displayName = uniqueName,
//                                                         description = displayName
// The SDK leaves a label that is already set untouched, so pinning changes nothing it sends; the parity test in
// tests/configuration-create-bindings.test.js holds this to the bundled SDK's own push of an unpinned artifact.
function pinApiLabels(artifact, rootMode, slotModes, bases) {
  const pin = (own, fallback, isSet) => {
    const out = {};
    for (const f of LABELS) out[f] = isSet(own[f]) ? own[f] : fallback(f, out);
    Object.assign(own, out);
  };
  const rootId = normalizeGuid(artifact.id);
  if (rootMode === 'update') {
    const base = baseOf(bases, 'customApi', rootId, null);
    pin(artifact, (f) => base.decoded.fields[f], (v) => v != null);
  } else {
    pin(artifact, (f, out) => (f === 'description' ? out.displayName : artifact.uniqueName), (v) => v != null);
  }
  for (const [list, prefix, childKind] of [[artifact.requestParameters, 'request:', 'customApiRequestParameter'], [artifact.responseProperties, 'response:', 'customApiResponseProperty']]) {
    for (const child of list) {
      if (slotModes.get(`${prefix}${lower(child.uniqueName)}`) === 'update') {
        const base = baseOf(bases, childKind, normalizeGuid(child.id), rootId);
        pin(child, (f) => base.decoded.fields[f], (v) => v !== undefined);
      } else {
        pin(child, (f, out) => (f === 'name' ? `${artifact.uniqueName}.${child.uniqueName}` : f === 'displayName' ? child.uniqueName : out.displayName), (v) => v !== undefined);
      }
    }
  }
}

/**
 * The protected create plan of ONE declared configuration artifact, at the ids the create port derives for it:
 *   planOf(spec, { kind, key, bindings?, solution?, intentFor?, boundIdOf?, componentTypes?, boundSlots?, keptChildren?, bases?, baseGeneration? })
 * `kind` is a root kind and `key` its declared key (schema name, logical name, unique name, rule key). `bindings` are
 * the deployment bindings (readDeploymentBindings): a bound value adds the value row, a bound connection makes the
 * reference's connection a private input. `solution` is the run's solution (else the spec's, else Default); in a
 * restricted solution (Default, Active) no membership is planned. `componentTypes` is readComponentTypes' `types`,
 * needed whenever membership is. `boundIdOf(kind, portKey)` is a recorded binding's id (the root is then an update);
 * `boundSlots` names children that already exist under it (updates, not creates). `keptChildren` ({ value: <id> }, a
 * bound variable only) is a bound value the deployment settings do not name this run: held at its id, never sent. `bases` (a Map or an object, by row
 * id) holds the fresh readConfigurationRow answer of every row the plan updates with a PATCH: its row version is the only
 * If-Match the classifier admits for that row, and a Custom API row's labels the App Spec leaves out are kept from it.
 * `baseGeneration` is the committed group's generation (the binding store's readGroup) an update is planned from: the
 * store prepares the attempt only while the group is still at it. `childIdOf` ({ <slot>: <id> }, a bound root only) places
 * an existing child at an id the plugin did not derive (one adopted under its `@<id>` approval). `asIs: true` plans the
 * same existing rows read-only: no create row, and each row expected exactly as its base read holds it.
 * Answers a frozen planned object { kind, key, solution, plan, rows } — `plan` is buildRowPlan's input (with the root's
 * `baseObservation` when it is an update read fresh); `rows` are its rows with what each must read back as
 * (`expected`), for a child its slot, and for a PATCHed row its held row version (`ifMatch`). No private input is in
 * either.
 */
function planOf(spec, { kind, key, bindings, solution, intentFor = defaultIntentFor, boundIdOf, componentTypes, boundSlots = [], keptChildren, bases, baseGeneration, childIdOf, asIs = false } = {}) {
  if (!ROOT_KINDS.has(kind)) throw new TypeError(`planOf: ${kind} is not a configuration root kind`);
  if (asIs && typeof boundIdOf !== 'function') throw new TypeError('planOf: an as-is plan is a plan of a bound row');
  if (asIs && kind === 'duplicateRule') throw new TypeError('planOf: a duplicate rule is never adopted, so never planned as-is');
  const entry = A.configurationIntentOf(spec, kind, key);
  const sol = nonEmpty(solution) ? solution : spec && isPlain(spec.solution) && nonEmpty(spec.solution.uniqueName) ? spec.solution.uniqueName : 'Default';
  const binds = bindings || { environmentVariables: new Map(), connectionReferences: new Map() };
  const catalog = createIntentCatalog(A.configurationCreateIntents(spec, { intentFor, bindings: binds, boundIdOf, solution: sol }));
  const portKey = A.portKeyOf(kind, entry[PLAN_KEY_FIELD[kind]]);
  const got = catalog.get(kind, portKey);
  if (!got) throw new TypeError(`planOf: no create identity for ${kind} "${portKey}"`);
  let parentDefinitionId = null;
  if (kind === 'environmentVariable' && entry.type === 'dataSource' && nonEmpty(entry.parentSchemaName)) {
    const parent = catalog.get('environmentVariable', lower(entry.parentSchemaName));
    if (!parent) throw new TypeError(`planOf: the parent definition "${entry.parentSchemaName}" of "${portKey}" is not declared`);
    parentDefinitionId = parent.id;
  }
  // A child the root already has at an id this plugin did not derive (a row a maker made before the opt-in, adopted under
  // its own `@<id>` approval: configuration-protected.js adoptionOf) keeps that id; every other child takes its derived one.
  const childIds = { ...got.childIds };
  for (const [slot, rawId] of Object.entries(childIdOf || {})) {
    const id = normalizeGuid(rawId);
    if (!has(got.childIds, slot) || !id || got.intent.boundId === undefined) throw new TypeError(`planOf: ${kind} "${portKey}" has no bound ${slot} child to place at ${rawId}`);
    childIds[slot] = id;
  }
  const artifact = A.buildArtifact({ kind, key: portKey, detail: { entry } }, got.id, childIds, { bindings: binds }, parentDefinitionId);
  const secrets = new Map();
  const rootId = normalizeGuid(got.id);
  const rootMode = got.intent.boundId !== undefined ? 'update' : 'create';
  const bound = new Set(boundSlots);
  if (kind === 'customApi') pinApiLabels(artifact, rootMode, new Map(Object.keys(childIds).map((s) => [s, bound.has(s) ? 'update' : 'create'])), bases);
  const rootExpected = expectedOf(kind, artifact);
  const root = {
    kind, key: portKey, id: rootId, parentId: null, slot: null, mode: rootMode, sensitiveInput: false,
    expected: rootMode === 'update' ? boundExpectation(kind, rootExpected, baseOf(bases, kind, rootId, null), entry, binds) : rootExpected,
  };
  if (kind === 'connectionReference' && artifact.connectionId != null && artifact.connectionId !== '') {
    root.sensitiveInput = true;
    secrets.set(rowKey(kind, portKey), artifact.connectionId);
  }
  const rows = [root];
  for (const [slot, rawId] of Object.entries(childIds)) {
    const childKind = childKindOf(kind, slot);
    const id = normalizeGuid(rawId);
    const children = kind === 'customApi' ? [...artifact.requestParameters, ...artifact.responseProperties] : kind === 'duplicateRule' ? artifact.conditions : [];
    const child = children.find((c) => normalizeGuid(c.id) === id) || null;
    if (childKind !== 'environmentVariableValue' && !child) throw new TypeError(`planOf: the ${slot} child of ${kind} "${portKey}" is not in its artifact`);
    const mode = bound.has(slot) ? 'update' : 'create';
    const created = expectedOf(childKind, artifact, child);
    const row = {
      kind: childKind, key: JSON.stringify([portKey, slot]), id, parentId: rootId, slot, mode,
      expected: mode === 'update' ? boundExpectation(childKind, created, baseOf(bases, childKind, id, rootId), declaredChild(entry, slot), binds) : created,
      sensitiveInput: childKind === 'environmentVariableValue',
    };
    // A condition's namesake is any condition of the rule its declaration describes (configuration-artifacts.js describes).
    if (childKind === 'duplicateRuleCondition') row.declared = structuredClone((entry.conditions || []).find((c) => c.key === slot));
    if (childKind === 'environmentVariableValue') secrets.set(rowKey(childKind, row.key), artifact.currentValue.value);
    rows.push(row);
  }
  // A bound variable's value the declaration leaves alone this run (its deployment settings name no value): the bound
  // row is still the variable's own child, so the plan holds it — present, under its definition, at its bound id — and
  // an edit of the definition is not judged a conflict over it. Nothing can be sent for it: it holds no row version (a
  // PATCH needs one: classifyPatch) and no private input (a value carried for it is refused: sendRow).
  for (const [slot, rawId] of Object.entries(keptChildren || {})) {
    if (kind !== 'environmentVariable' || slot !== 'value' || has(got.childIds, slot) || rootMode !== 'update') throw new TypeError(`planOf: ${kind} "${portKey}" cannot keep a bound ${slot} child`);
    const id = normalizeGuid(rawId);
    if (!id) throw new TypeError(`planOf: the kept ${slot} child of ${kind} "${portKey}" has no id`);
    rows.push({ kind: 'environmentVariableValue', key: JSON.stringify([portKey, slot]), id, parentId: rootId, slot, mode: 'update', kept: true, expected: {}, sensitiveInput: false });
  }
  // An as-is plan (`asIs`): the rows of the same plan that already exist, each expected to read back exactly as its own base
  // read holds it, over the same field set — no create row and nothing to send. It is what a read-only acceptance of rows
  // made before the opt-in proves (configuration-protected.js adoptionOf): the build then plans the item as bound and
  // sends only the edit it printed, through its ordinary protected path.
  if (asIs) {
    if (rootMode !== 'update') throw new TypeError(`planOf: ${kind} "${portKey}" is not bound; an as-is plan has nothing to keep`);
    for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i].mode !== 'update') rows.splice(i, 1);
    for (const r of rows) {
      if (r.kept) continue;
      const own = semanticOf(r.kind, baseOf(bases, r.kind, r.id, r.parentId).decoded);
      r.expected = Object.fromEntries(Object.keys(r.expected).map((f) => [f, has(own, f) ? own[f] : null]));
    }
  }
  for (const r of rows) {
    // An updated row keeps what its base read held in the columns this build never writes (PRESERVED): the exact value, so
    // a row whose implementation was replaced or removed meanwhile is not the row this edit planned.
    r.preserved = r.mode === 'update' && !r.kept ? { ...baseOf(bases, r.kind, r.id, r.parentId).decoded.preserved } : {};
    r.expectedSha256 = projectionOf(r.kind, r.expected, r.expected, [], [], r.preserved);
    if (r.mode === 'update' && !r.kept && PATCHABLE.has(r.kind)) r.ifMatch = baseOf(bases, r.kind, r.id, r.parentId).rowVersion;
  }
  // An update of a bound root records the versions it was prepared from (the binding store's baseObservation); they stay
  // out of the declaration, which a later fresh read must not change.
  const versions = rows.filter((r) => r.ifMatch !== undefined).map((r) => ({ kind: r.kind, id: r.id, rowVersion: r.ifMatch }));
  // A root read without a row version records a null one in its as-is plan: its base is then proved by the content
  // projection alone (baseOf).
  const baseObservation = root.ifMatch !== undefined ? { rowVersion: root.ifMatch, savedSha256: sha({ rows: versions }) }
    : asIs ? { rowVersion: null, savedSha256: sha({ rows: versions }) } : null;
  const members = [];
  if (!isRestrictedSolution(sol)) {
    for (const r of rows) {
      if (r.kind === 'environmentVariableValue') continue;
      const table = MEMBER_TABLES[r.kind];
      const componentType = typeof table === 'number' ? table : componentTypes && componentTypes[table];
      if (!Number.isInteger(componentType)) throw new TypeError(`planOf: the component type of ${table} is not known; read it first (readComponentTypes)`);
      members.push({ kind: r.kind, id: r.id, componentType });
    }
  }
  const ruleState = kind !== 'duplicateRule' ? null
    // A bound rule whose App Spec omits `status` keeps the state the row shows (as the existing planner does: a build
    // never republishes a rule somebody unpublished); a create, or an authored status, is the declared state.
    : rootMode === 'update' && entry.status === undefined ? boundRuleState(baseOf(bases, kind, rootId, null)) : artifact.status;
  if (ruleState !== null && ruleState !== 'published' && ruleState !== 'unpublished') throw new TypeError(`planOf: rule status ${ruleState} is not one this driver plans`);
  // A protected rule is published once, by the create set that makes it: only a plan whose rule row is a create holds the
  // publish effect. A bound rule's plan keeps its state as a completion check (verified, never published again), so a
  // rule found unpublished there is held, not republished.
  const publishes = ruleState === 'published' && root.mode === 'create';
  const planRows = rows.map(({ kind: k, key: rk, id, parentId, mode, expectedSha256, sensitiveInput }) => ({ kind: k, key: rk, id, parentId, mode, expectedSha256, sensitiveInput }));
  const plan = {
    family: kind, key: portKey,
    declarationSha256: declarationSha256Of(spec, { kind, key, solution: sol, rows: planRows, ruleState }),
    rows: planRows, members, ruleState,
    effects: [...members.map((m) => ({ kind: 'membership', id: m.id })), ...(publishes ? [{ kind: 'rule-state', id: rootId }] : [])],
    ...(baseObservation ? { baseObservation } : {}),
    ...(rootMode === 'update' && baseGeneration !== undefined && baseGeneration !== null ? { baseGeneration } : {}),
  };
  const planned = deepFreeze({ kind, key: portKey, solution: sol, plan, rows });
  PRIVATE_INPUTS.set(planned, { artifact, secrets });
  return planned;
}

/**
 * The declaration digest of a plan of `kind` `key` (planOf's plan.declarationSha256): today's declaration of the item,
 * the solution, the plan rows ({ kind, key, id, parentId, mode, expectedSha256, sensitiveInput }; any other field is
 * ignored) and the rule state. Given a pending attempt's OWN persisted rows and rule state, it is the digest that attempt
 * was prepared with exactly when today's declaration is the one it was prepared for — so recovery judges the attempt by
 * its original expectation, never by rows re-derived from today's reads.
 */
function declarationSha256Of(spec, { kind, key, solution, rows, ruleState = null }) {
  const entry = A.configurationIntentOf(spec, kind, key);
  const portKey = A.portKeyOf(kind, entry[PLAN_KEY_FIELD[kind]]);
  const planRows = rows.map(({ kind: k, key: rk, id, parentId, mode, expectedSha256, sensitiveInput }) => ({ kind: k, key: rk, id, parentId, mode, expectedSha256, sensitiveInput: sensitiveInput === true }));
  return sha({ kind, key: portKey, declaration: A.portableIntent(kind, entry), solution, rows: planRows, ruleState: ruleState === undefined ? null : ruleState });
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

function privateOf(planned) {
  const p = PRIVATE_INPUTS.get(planned);
  if (!p) throw new TypeError('the planned object was not made by planOf');
  return p;
}

/** The SDK artifact of a planned object (sdk.createArtifact input): a fresh copy, private inputs included. */
function artifactFor(planned) {
  return structuredClone(privateOf(planned).artifact);
}

/** The run's `acceptResult` for the SDK's pushArtifact of `planned` (managed-create-context.js acceptSaved). */
function acceptResultFor(planned) {
  return acceptSaved({ type: planned.kind, id: planned.plan.rows[0].id });
}

// ---------------------------------------------------------------------------------------------
// Reads. None throws: a failed, refused or malformed read is `unknown`, never absence and never a difference.

function errorCode(body) {
  let b = body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { return null; } }
  const e = isPlain(b) ? b.error || b.Error : null;
  return isPlain(e) && typeof e.code === 'string' ? e.code.toLowerCase() : null;
}

// One read through the SDK's Dataverse reader: `get(path)` answers { status, body } (a 404 included) and may throw.
async function answer(run) {
  try {
    const res = await run();
    const status = res && Number.isInteger(res.status) ? res.status : null;
    if (status !== null && status >= 200 && status < 300 && isPlain(res.body)) return { ok: true, status, body: res.body };
    return { ok: false, status, code: errorCode(res && res.body) };
  } catch (e) {
    const status = e && Number.isInteger(e.statusCode) ? e.statusCode : e && Number.isInteger(e.status) ? e.status : null;
    return { ok: false, status, code: errorCode(e && e.body) };
  }
}
const canRead = (dv) => !!dv && typeof dv.get === 'function';

// Dataverse's "does not exist" for a read by id: HTTP 404 with { "error": { "code": "0x80040217", ... } }. A 404
// without it (a missing set, a proxy's page) proves nothing about the row.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/web-service-error-codes
const NOT_FOUND = '0x80040217';

/**
 * One exact-id read of `kind` at `id`, every mapped column selected:
 *   GET /customapis(<id>)?$select=customapiid,uniquename,name,displayname,...,_plugintypeid_value
 *   { "@odata.etag": "W/\"1\"", "customapiid": "<id>", "uniquename": "contoso_Calc", ..., "_plugintypeid_value": null }
 * Answers { state: 'present', kind, id, parentId, rowVersion, decoded } | { state: 'absent' } | { state: 'unknown', reason }.
 * Present only when the answer names this id and carries every selected column (Dataverse answers `null` for an empty
 * one) but the private one, whose absence is a masked value, not an unreadable row. `rowVersion` is the answer's
 * `@odata.etag` when it is a row version (W/"<n>"), else null — a plan cannot update the row from such a read (planOf).
 */
async function readConfigurationRow(dataverse, kind, id) {
  const k = KINDS[kind];
  const want = normalizeGuid(id);
  if (!k || !want) throw new TypeError(`readConfigurationRow: ${kind} ${id} is not a configuration row`);
  if (!canRead(dataverse)) return { state: 'unknown', reason: 'no reader is available' };
  const res = await answer(() => dataverse.get(`/${k.set}(${want})?$select=${[k.pk, ...Object.keys(k.columns)].join(',')}`));
  if (!res.ok) {
    if (res.status === 404 && res.code === NOT_FOUND) return { state: 'absent' };
    return { state: 'unknown', reason: `the read failed (HTTP ${res.status})` };
  }
  if (normalizeGuid(res.body[k.pk]) !== want) return { state: 'unknown', reason: 'the read answered another row' };
  if (Object.entries(k.columns).some(([col, spec]) => spec !== PRIVATE && !has(res.body, col))) return { state: 'unknown', reason: 'the read left out a selected column' };
  const decoded = decode(kind, res.body, 'read');
  if (!decoded) return { state: 'unknown', reason: 'a column holds a value this build cannot read' };
  const etag = res.body['@odata.etag'];
  const rowVersion = typeof etag === 'string' && ROW_VERSION.test(etag) ? etag : null;
  return { state: 'present', kind, id: want, parentId: decoded.parentId === undefined ? null : decoded.parentId, rowVersion, decoded };
}

/**
 * Every page of one collection read. Dataverse pages with an absolute `@odata.nextLink`:
 *   { "value": [ ... ], "@odata.nextLink": "https://contoso.crm.dynamics.com/api/data/v9.2/customapis?$select=...&$skiptoken=..." }
 * and may flag `"@Microsoft.Dynamics.CRM.morerecords": true`. A later page is read through the SDK's same-origin
 * absolute reader (getAbsolute); a failed page, a page without a `value` list, a link that is not an absolute URL or
 * repeats one already followed, and a "more records" flag without a link leave the read INCOMPLETE — and an
 * incomplete namesake query proves no absence, even when every page it did read was empty.
 * See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query/page-results
 */
async function readAllPages(dataverse, path) {
  if (!canRead(dataverse)) return { complete: false, reason: 'no reader is available' };
  const rows = [];
  const links = new Set();
  let page = await answer(() => dataverse.get(path));
  for (;;) {
    if (!page.ok) return { complete: false, reason: `a page could not be read (HTTP ${page.status})` };
    if (!Array.isArray(page.body.value)) return { complete: false, reason: 'a page is not a list' };
    rows.push(...page.body.value);
    const next = page.body['@odata.nextLink'];
    if (next === undefined || next === null) {
      if (page.body['@Microsoft.Dynamics.CRM.morerecords'] === true) return { complete: false, reason: 'more records were flagged without a link to them' };
      return { complete: true, rows };
    }
    let absolute = false;
    try { absolute = typeof next === 'string' && /^https:$/i.test(new URL(next).protocol); } catch { absolute = false; }
    if (!absolute || links.has(next) || typeof dataverse.getAbsolute !== 'function') return { complete: false, reason: 'the read continues on a page this build cannot follow' };
    links.add(next);
    page = await answer(() => dataverse.getAbsolute(next));
  }
}

/** The ObjectTypeCode of each member table: { complete: true, types: { customapi: 10133, ... } } or { complete: false, reason }. */
async function readComponentTypes(dataverse) {
  const types = {};
  for (const table of new Set(Object.values(MEMBER_TABLES).filter((t) => typeof t === 'string'))) {
    // GET /EntityDefinitions(LogicalName='customapi')?$select=ObjectTypeCode  ->  { "ObjectTypeCode": 10133, "MetadataId": "..." }
    const res = canRead(dataverse) ? await answer(() => dataverse.get(`/EntityDefinitions(LogicalName='${table}')?$select=ObjectTypeCode`)) : { ok: false };
    if (!res.ok || !Number.isInteger(res.body.ObjectTypeCode)) return { complete: false, reason: `the component type of ${table} could not be read` };
    types[table] = res.body.ObjectTypeCode;
  }
  return { complete: true, types };
}

const lit = (v) => `'${encodeURIComponent(odataLit(v))}'`;

// The namesake query of one planned create row, and how a returned row is judged: 'hit' (a namesake), 'other' (a row
// the query may return that is no namesake: another parameter of the same API, another condition of the same rule)
// or BAD (a row the predicate does not hold for: the answer is not the query's, so nothing it says is trusted).
//   environment variable    schemaname eq '<schema name>'                      (any definition, any solution)
//   connection reference    connectionreferencelogicalname eq '<logical name>'
//   Custom API              uniquename eq '<unique name>'
//   duplicate rule          name eq '<name>'                                   (ANY table: a rule's name is the maker's handle)
//   value                   _environmentvariabledefinitionid_value eq <definition id>   (one value per definition)
//   request parameter /
//   response property       _customapiid_value eq <api id>, then the unique name, case-insensitive, in that direction only
//   condition               _regardingobjectid_value eq <rule id>, then every condition the declaration describes
// String equality in a Dataverse $filter is case-insensitive, so a returned namesake is compared the same way.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query/filter-rows
function conflictQueryOf(row) {
  const k = KINDS[row.kind];
  if (ROOT_KINDS.has(row.kind)) {
    const name = row.expected[k.nameField];
    return {
      path: `/${k.set}?$select=${k.pk},${k.name}&$filter=${k.name} eq ${lit(name)}`,
      judge: (r) => (typeof r[k.name] === 'string' && lower(r[k.name]) === lower(name) ? 'hit' : BAD),
    };
  }
  const parentOk = (r) => normalizeGuid(r[k.parentColumn]) === row.parentId;
  const base = `/${k.set}?$filter=${k.parentColumn} eq ${row.parentId}&$select=`;
  if (row.kind === 'environmentVariableValue') {
    return { path: `${base}${k.pk},${k.parentColumn}`, judge: (r) => (parentOk(r) ? 'hit' : BAD) };
  }
  if (row.kind === 'duplicateRuleCondition') {
    return {
      path: `${base}${[k.pk, ...Object.keys(k.columns)].join(',')}`,
      judge: (r) => {
        const d = decode(row.kind, r, 'read');
        if (!d || !parentOk(r)) return BAD;
        return A.describes(row.declared, d.fields) ? 'hit' : 'other';
      },
    };
  }
  return {
    path: `${base}${k.pk},uniquename,${k.parentColumn}`,
    judge: (r) => {
      if (!parentOk(r) || typeof r.uniquename !== 'string') return BAD;
      return lower(r.uniquename) === lower(row.expected.uniqueName) ? 'hit' : 'other';
    },
  };
}

async function readRowConflicts(dataverse, row) {
  const k = KINDS[row.kind];
  const q = conflictQueryOf(row);
  const read = await readAllPages(dataverse, q.path);
  if (!read.complete) return { state: 'unknown', reason: read.reason };
  const ids = [];
  for (const r of read.rows) {
    const id = isPlain(r) && typeof r[k.pk] === 'string' ? normalizeGuid(r[k.pk]) : '';
    if (!id) return { state: 'unknown', reason: 'the namesake query answered a row without an id' };
    const verdict = q.judge(r);
    if (verdict === BAD) return { state: 'unknown', reason: 'the namesake query answered a row its filter does not hold for' };
    if (verdict !== 'hit') continue;
    // The derived id itself answering the namesake query right after its exact read found nothing: the two reads
    // disagree, and neither is taken.
    if (id === row.id) return { state: 'unknown', reason: 'the namesake query answered the planned id itself' };
    if (!ids.includes(id)) ids.push(id);
  }
  return ids.length ? { state: 'conflict', ids } : { state: 'clear' };
}

/**
 * The namesake queries a protected create must run, complete, before it sends anything — one per planned CREATE row,
 * every page followed (readAllPages). Run after the exact reads found those rows absent. Answers
 *   { state: 'clear' | 'conflict' | 'unknown', code: null | create-identity-conflict | create-identity-unverified, rows }
 * with `rows` [{ kind, key, state, ids?, reason? }]. Any unknown query answers unknown (nothing is created on a read
 * that may have missed a namesake), before any conflict; a namesake at another id is a conflict, whatever approval the
 * maker holds: an approval adopts the row AT the derived id, never a row elsewhere.
 */
async function readConfigurationConflicts(dataverse, planned) {
  privateOf(planned);
  const rows = [];
  for (const row of planned.rows) {
    if (row.mode !== 'create') continue;
    rows.push({ kind: row.kind, key: row.key, ...(await readRowConflicts(dataverse, row)) });
  }
  if (rows.some((r) => r.state === 'unknown')) return { state: 'unknown', code: CODES.unverified, rows };
  if (rows.some((r) => r.state === 'conflict')) return { state: 'conflict', code: CODES.conflict, rows };
  return { state: 'clear', code: null, rows };
}

/**
 * The membership of every planned member in the plan's solution, from a complete read of the solution's components of
 * the planned types (and the classic duplicate-rule types 44 and 45, which the platform may still list a rule or a
 * condition under):
 *   GET /solutions?$select=solutionid,uniquename&$filter=uniquename eq 'ContosoSol'
 *   GET /solutioncomponents?$select=objectid,componenttype,_solutionid_value&$filter=_solutionid_value eq <id> and (componenttype eq 380 or ...)
 *   { "value": [ { "objectid": "<guid>", "componenttype": 10133, "_solutionid_value": "<id>" } ], "@odata.nextLink": ... }
 * Ids are matched here, not in the filter, so one read serves every member. Any incomplete or malformed answer makes
 * EVERY member unknown: a missing page could hold any of them.
 * See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/solutioncomponent
 */
async function readMembers(dataverse, planned) {
  const want = planned.plan.members;
  if (!want.length) return [];
  const unknown = () => want.map((m) => ({ id: m.id, state: 'unknown' }));
  const sol = await readAllPages(dataverse, `/solutions?$select=solutionid,uniquename&$filter=uniquename eq ${lit(planned.solution)}`);
  if (!sol.complete || sol.rows.length !== 1) return unknown();
  const s = sol.rows[0];
  const sid = isPlain(s) && typeof s.solutionid === 'string' ? normalizeGuid(s.solutionid) : '';
  if (!sid || typeof s.uniquename !== 'string' || lower(s.uniquename) !== lower(planned.solution)) return unknown();
  const classic = (m) => A.CLASSIC_MEMBERSHIP_TYPES[m.kind];
  const types = [...new Set(want.flatMap((m) => [m.componentType, ...(classic(m) ? [classic(m)] : [])]))].sort((a, b) => a - b);
  const filter = `_solutionid_value eq ${sid} and (${types.map((t) => `componenttype eq ${t}`).join(' or ')})`;
  const comps = await readAllPages(dataverse, `/solutioncomponents?$select=objectid,componenttype,_solutionid_value&$filter=${filter}`);
  if (!comps.complete) return unknown();
  const present = new Set();
  for (const c of comps.rows) {
    const id = isPlain(c) && typeof c.objectid === 'string' ? normalizeGuid(c.objectid) : '';
    if (!id || !types.includes(c.componenttype) || normalizeGuid(c._solutionid_value) !== sid) return unknown();
    present.add(`${id}|${c.componenttype}`);
  }
  return want.map((m) => ({
    id: m.id,
    state: present.has(`${m.id}|${m.componentType}`) || (classic(m) && present.has(`${m.id}|${classic(m)}`)) ? 'present' : 'absent',
  }));
}

// A private input read back, compared in memory with the planned one:
//   match     the row holds exactly the planned input;
//   masked    the column was not returned, or came back as a run of asterisks (a secret the platform will not show);
//   mismatch  the row holds another input;
//   unknown   there is no planned input to compare with.
function privateStateOf(read, want) {
  if (want === undefined) return 'unknown';
  if (!read.present) return 'masked';
  if (read.value === want) return 'match';
  if (typeof read.value === 'string' && /^\*+$/.test(read.value)) return 'masked';
  return 'mismatch';
}

/**
 * The complete child graph under a present root, against the plan: every child collection of the root's kind, filtered by
 * the parent lookup and read to its last page (readAllPages):
 *   GET /customapirequestparameters?$select=customapirequestparameterid,_customapiid_value&$filter=_customapiid_value eq <root id>
 *   { "value": [ { "customapirequestparameterid": "<guid>", "_customapiid_value": "<root id>" } ], "@odata.nextLink": ... }
 * (the same for response properties, a rule's conditions by _regardingobjectid_value and a definition's values by
 * _environmentvariabledefinitionid_value). Answers { state: 'complete', unexpected: ['<kind>:<id>', ...] } or
 * { state: 'unknown' } when a collection is not read completely, answers a row without an id or under another parent,
 * names a row twice, or disagrees with the exact reads about a planned child (listed but read absent, or the reverse).
 * The exact reads alone prove only the planned children: a row someone else added under the root would never be asked
 * about, and the rule, API or definition it changes would still be judged the one the plan made.
 */
async function readChildGraph(dataverse, planned, exact) {
  const rootId = planned.plan.rows[0].id;
  const unexpected = [];
  for (const [childKind, k] of Object.entries(KINDS)) {
    if (!k.parentSet || k.parentSet !== KINDS[planned.kind].set) continue;
    const read = await readAllPages(dataverse, `/${k.set}?$select=${k.pk},${k.parentColumn}&$filter=${k.parentColumn} eq ${rootId}`);
    if (!read.complete) return { state: 'unknown' };
    const listed = new Set();
    for (const r of read.rows) {
      const id = isPlain(r) && typeof r[k.pk] === 'string' ? normalizeGuid(r[k.pk]) : '';
      if (!id || listed.has(id) || normalizeGuid(r[k.parentColumn]) !== rootId) return { state: 'unknown' };
      listed.add(id);
    }
    const plannedIds = new Set();
    for (const row of planned.rows) {
      if (row.kind !== childKind) continue;
      plannedIds.add(row.id);
      const seen = exact.get(row.id);
      if (seen === 'unknown') continue;
      if ((seen === 'present') !== listed.has(row.id)) return { state: 'unknown' };
    }
    for (const id of listed) if (!plannedIds.has(id)) unexpected.push(`${childKind}:${id}`);
  }
  return { state: 'complete', unexpected: unexpected.sort() };
}

/**
 * The fresh observation the lifecycle judges (managed-create-context.js classifyRecovery / settle):
 *   { rows: [{ kind, key, id, state, parentId?, projectionSha256?, privateState? }], members: [{ id, state }], ruleState }
 * One exact-id read per planned row (readConfigurationRow), the root's complete child graph (readChildGraph), the
 * solution's members (readMembers) and the rule's state from its own read. The graph is judged on the root row, the one
 * row the lifecycle compares for the whole artifact: a child the plan does not hold makes the root's projection differ
 * (a conflict: it is neither deleted nor adopted), and a graph that cannot be read completely makes the root unknown —
 * so no completion is proven from a partial graph. An absent rule is reported unpublished — there is no rule to be
 * published — so its absence is judged as the missing row it is; an unreadable or publishing rule leaves the state unknown.
 */
async function observe(dataverse, planned) {
  const { secrets } = privateOf(planned);
  const rows = [];
  const exact = new Map();
  let rootRead = null;
  let ruleState = null;
  for (const r of planned.rows) {
    const read = await readConfigurationRow(dataverse, r.kind, r.id);
    exact.set(r.id, read.state);
    if (r.parentId === null) rootRead = read;
    if (r.kind === 'duplicateRule') ruleState = read.state === 'absent' ? 'unpublished' : read.state === 'present' ? ruleStateOf(read.decoded.state.statecode, read.decoded.state.statuscode) : undefined;
    if (read.state !== 'present') {
      rows.push({ kind: r.kind, key: r.key, id: r.id, state: read.state });
      continue;
    }
    const out = {
      kind: r.kind, key: r.key, id: read.id, state: 'present', parentId: read.parentId,
      projectionSha256: projectionOf(r.kind, r.expected, semanticOf(r.kind, read.decoded), read.decoded.unmodelled, [], read.decoded.preserved),
    };
    if (r.sensitiveInput) out.privateState = privateStateOf(read.decoded.private, secrets.get(rowKey(r.kind, r.key)));
    rows.push(out);
  }
  if (rootRead && rootRead.state === 'present') {
    const root = planned.rows[0];
    const graph = await readChildGraph(dataverse, planned, exact);
    if (graph.state !== 'complete') rows[0] = { kind: root.kind, key: root.key, id: root.id, state: 'unknown' };
    else if (graph.unexpected.length) {
      rows[0].projectionSha256 = projectionOf(root.kind, root.expected, semanticOf(root.kind, rootRead.decoded), rootRead.decoded.unmodelled, graph.unexpected, rootRead.decoded.preserved);
    }
  }
  return { rows, members: await readMembers(dataverse, planned), ruleState };
}

/**
 * What a bound plan would change, read fresh and sent nowhere — the build's read-only preflight decides from it whether
 * the change is one the protected path can make:
 *   { state: 'complete', rootChanged, creates: [kind], labelEdits: [kind], fixedEdits: [kind], removals: ['<kind>:<id>'],
 *     missing: [{ kind, key, id }], ruleStateChanged }   or   { state: 'unknown' }
 * One exact-id read per planned row and the root's complete child graph (readChildGraph), as observe reads them. A bound
 * row that differs from its expectation is an edit: of the root, of a child's labels only (`labelEdits`: name, display
 * name, description — what the SDK PATCHes in place), or of anything else (`fixedEdits`). A planned create the read finds
 * present, an unreadable row or a graph that cannot be read completely is unknown: nothing is judged from a partial read.
 * A child under the root the plan does not hold is a removal (`removals`); a bound row read absent is `missing`.
 */
async function editShapeOf(dataverse, planned) {
  const out = { state: 'complete', rootChanged: false, creates: [], labelEdits: [], fixedEdits: [], removals: [], missing: [], ruleStateChanged: false };
  const exact = new Map();
  let rootPresent = false;
  for (const r of planned.rows) {
    const read = await readConfigurationRow(dataverse, r.kind, r.id);
    exact.set(r.id, read.state);
    if (read.state === 'unknown') return { state: 'unknown' };
    if (r.mode === 'create') {
      if (read.state !== 'absent') return { state: 'unknown' };
      out.creates.push(r.kind);
      continue;
    }
    if (read.state === 'absent') {
      out.missing.push({ kind: r.kind, key: r.key, id: r.id });
      continue;
    }
    if (r.parentId === null) rootPresent = true;
    if (r.kind === 'duplicateRule') {
      const now = ruleStateOf(read.decoded.state.statecode, read.decoded.state.statuscode);
      if (now !== planned.plan.ruleState) out.ruleStateChanged = true;
    }
    const semantic = semanticOf(r.kind, read.decoded);
    if (projectionOf(r.kind, r.expected, semantic, read.decoded.unmodelled, [], read.decoded.preserved) === r.expectedSha256) continue;
    if (r.parentId === null) {
      out.rootChanged = true;
      continue;
    }
    // Which fields differ, compared as the plan holds them; a difference the field comparison cannot place (a column the
    // projection normalizes, an unmodelled one) is not provably a label edit, so it is a fixed edit.
    const differing = Object.keys(r.expected).filter((f) => canonicalJson(r.expected[f] === undefined ? null : r.expected[f]) !== canonicalJson(semantic[f] === undefined ? null : semantic[f]));
    if (differing.length && differing.every((f) => LABELS.includes(f)) && API_KINDS.has(r.kind)) out.labelEdits.push(r.kind);
    else out.fixedEdits.push(r.kind);
  }
  if (rootPresent) {
    const graph = await readChildGraph(dataverse, planned, exact);
    if (graph.state !== 'complete') return { state: 'unknown' };
    out.removals = graph.unexpected;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The classifier: which planned row, or which completion effect, one mutation is. Anything else answers null (the
// gate refuses it unsent). Every check is against the plan, never against what the request says about itself.

const KIND_OF_SET = Object.freeze(Object.fromEntries(Object.entries(KINDS).map(([kind, k]) => [k.set, kind])));
const API_KINDS = new Set(['customApi', 'customApiRequestParameter', 'customApiResponseProperty']);
const PATCHABLE = new Set(['environmentVariable', 'environmentVariableValue', 'connectionReference', 'customApi', 'customApiRequestParameter', 'customApiResponseProperty']);
// What the SDK's Custom API adapter PATCHes in place: a root's editable fields, and a child's labels only — a child's
// type, optionality and table are fixed once created (configuration-artifacts.js refuses a change to them).
const API_ROOT_EDITABLE = new Set(['name', 'displayname', 'description', 'isprivate', 'executeprivilegename']);
const API_CHILD_EDITABLE = new Set(['name', 'displayname', 'description']);
const API_CHILD_KINDS = new Set(['customApiRequestParameter', 'customApiResponseProperty']);
// The deep-insert navigations of a root: the child kinds created inside its POST.
const navsOf = (kind) => Object.entries(KINDS).filter(([, k]) => k.nav && k.parentSet === KINDS[kind].set).map(([childKind, k]) => [k.nav, childKind]);

// A request body as the HTTP client hands it to the gate: the JSON text it sends (a string or a Buffer), or an object.
function parseBody(body) {
  if (body === undefined || body === null) return { empty: true };
  if (isPlain(body)) return { empty: false, json: body };
  const textOf = Buffer.isBuffer(body) ? body.toString('utf8') : typeof body === 'string' ? body : null;
  if (textOf === null) return { empty: false, json: null };
  if (!textOf.trim()) return { empty: true };
  try {
    const json = JSON.parse(textOf);
    return { empty: false, json: isPlain(json) ? json : null };
  } catch {
    return { empty: false, json: null };
  }
}

// The query options of a request, decoded. The SDK percent-encodes an $expand's inner options:
//   customapis?$select=customapiid&$expand=CustomAPIRequestParameters(%24select%3Dcustomapirequestparameterid)%2C...
// A repeated option is two answers to one question: null.
function queryOf(url) {
  let params;
  try { params = new URL(String(url), 'https://contoso.crm.dynamics.com').searchParams; } catch { return null; }
  const out = {};
  for (const [key, value] of params) {
    if (has(out, key)) return null;
    out[key] = value;
  }
  return out;
}

// The query a create of `kind` may carry: none, `$select=<its primary key>` (return=representation's id), and for a
// Custom API root an $expand of exactly its child collections, each selecting only its own primary key — so the answer
// names the ids the platform saved and nothing else.
function createQueryOk(kind, query) {
  const k = KINDS[kind];
  for (const [key, value] of Object.entries(query)) {
    if (key === '$select') { if (value !== k.pk) return false; continue; }
    if (key === '$expand' && kind === 'customApi') {
      const navs = new Map(navsOf(kind).map(([nav, childKind]) => [nav, KINDS[childKind].pk]));
      const seen = new Set();
      for (const item of value.split(',')) {
        const m = /^([A-Za-z_]+)\(\$select=([a-z_]+)\)$/.exec(item);
        if (!m || !navs.has(m[1]) || navs.get(m[1]) !== m[2] || seen.has(m[1])) return false;
        seen.add(m[1]);
      }
      continue;
    }
    return false;
  }
  return true;
}

// A solution header may only name the plan's solution; a value row must carry none (it is never a member).
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/compose-http-requests-handle-errors#other-headers
function solutionHeaderOk(planned, kind, headers) {
  const named = headerValue(headers, 'mscrm.solutionuniquename');
  if (named === null) return true;
  return kind !== 'environmentVariableValue' && lower(named) === lower(planned.solution);
}

function privateMismatch(row) {
  // The message names the row only: the input it was compared with is private, and so is what was about to be sent.
  return Object.assign(new Error(`the ${row.kind} "${row.key}" was about to be sent with another private input than the one planned; it was not sent`), { code: PRIVATE_MISMATCH });
}

/**
 * One planned row as a request carries it, or null. `raw` is the row's own object (a deep-insert child's array item);
 * `how` is 'create' (a POST, nested or not) or 'patch'. The body must decode through the kind's closed map with no
 * unmodelled column and none it preserves, sit under the planned parent (a nested child binds none — its parent is the root it is inside;
 * any other child binds exactly its planned parent; a root binds none), and say exactly what the plan expects: every
 * semantic field equal and nothing more (a Custom API's labels included: the plan pins them). A private input other than the planned one
 * throws (PRIVATE_MISMATCH) rather than answer null, so the run reports it as the local failure it is. The sealed
 * projection covers the semantic fields only: never a private input.
 */
function sendRow(planned, row, raw, how, nested) {
  const d = decode(row.kind, raw, how);
  if (!d || d.unmodelled.length) return null;
  // Where the body puts the row: a nested child and a root bind no parent; a child created on its own binds exactly its
  // planned parent; a PATCH may leave the parent unsaid, never name another one.
  const parentOk = nested || row.parentId === null ? d.parentId === undefined
    : how === 'create' ? d.parentId === row.parentId
      : d.parentId === undefined || d.parentId === row.parentId;
  if (!parentOk) return null;
  const sem = semanticOf(row.kind, d, how);
  for (const [f, v] of Object.entries(sem)) {
    if (!has(row.expected, f) || !sameValue(v, row.expected[f])) return null;
  }
  if (how === 'create' && Object.keys(row.expected).some((f) => !has(sem, f))) return null;
  if (d.private.present) {
    const want = privateOf(planned).secrets.get(rowKey(row.kind, row.key));
    if (!row.sensitiveInput) { if (d.private.value !== null && d.private.value !== '') return null; }
    else if (d.private.value !== want) throw privateMismatch(row);
  } else if (row.sensitiveInput && how === 'create') {
    throw privateMismatch(row);
  }
  const projected = { ...sem, ...(row.parentId ? { parentId: row.parentId } : {}) };
  return { kind: row.kind, key: row.key, id: row.id, parentId: row.parentId, ...sentProjection(projected) };
}

function indexOf(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new TypeError('createClassifier needs at least one { token, planned } entry');
  const byId = new Map();
  for (const { token, planned } of entries) {
    privateOf(planned);
    if (!nonEmpty(token)) throw new TypeError('createClassifier: an entry has no attempt token');
    for (const row of planned.rows) {
      // Two artifacts planning one id would make every request about it ambiguous.
      if (byId.has(row.id)) throw new TypeError(`createClassifier: the id ${row.id} is planned twice`);
      byId.set(row.id, { token, planned, row });
    }
  }
  return byId;
}

function classifyCreate(byId, req, kind, body, constituent) {
  const k = KINDS[kind];
  const hit = typeof body[k.pk] === 'string' ? byId.get(normalizeGuid(body[k.pk]) || '') : undefined;
  if (!hit || hit.row.kind !== kind || hit.row.mode !== 'create') return null;
  const { token, planned, row } = hit;
  // A condition exists only inside its rule's deep insert; a root is created only by its own POST, never in a $batch.
  if (kind === 'duplicateRuleCondition' || (constituent && row.parentId === null)) return null;
  const query = queryOf(req.url);
  if (!query || !createQueryOk(kind, query) || !solutionHeaderOk(planned, kind, req.headers)) return null;
  // A change-set child is the SDK's later child of a BOUND Custom API, in exactly its shape:
  //   POST /customapirequestparameters?$select=customapirequestparameterid  { ..., "CustomAPIId@odata.bind": "/customapis(<bound id>)" }
  if (constituent) {
    const parent = planned.rows.find((r) => r.id === row.parentId);
    if (!parent || parent.mode !== 'update' || Object.keys(query).length !== 1 || query.$select !== k.pk) return null;
  }
  const own = { ...body };
  const nested = [];
  for (const [nav, childKind] of row.parentId === null ? navsOf(kind) : []) {
    if (!has(own, nav)) continue;
    const list = own[nav];
    delete own[nav];
    if (!Array.isArray(list)) return null;
    for (const item of list) {
      const ck = KINDS[childKind];
      const c = isPlain(item) && typeof item[ck.pk] === 'string' ? byId.get(normalizeGuid(item[ck.pk]) || '') : undefined;
      if (!c || c.planned !== planned || c.row.kind !== childKind || c.row.mode !== 'create' || c.row.parentId !== row.id) return null;
      if (nested.some((n) => n.row === c.row)) return null;
      nested.push({ row: c.row, raw: item, nav });
    }
  }
  // A root's deep insert carries every child the plan creates under it, and nothing else: a child left out would be
  // sent later under a parent the answer has not proven, and a rule's condition cannot be sent any other way.
  if (row.parentId === null) {
    const want = planned.rows.filter((r) => r.parentId === row.id && r.mode === 'create' && navsOf(kind).some(([, ck]) => ck === r.kind));
    if (want.length !== nested.length) return null;
  }
  const rows = [sendRow(planned, row, own, 'create', false)];
  for (const n of nested) {
    const sent = sendRow(planned, n.row, n.raw, 'create', true);
    if (sent) sent.answer = { at: n.nav, key: KINDS[n.row.kind].pk, match: { [KINDS[n.row.kind].pk]: n.row.id } };
    rows.push(sent);
  }
  if (rows.some((r) => !r)) return null;
  return { type: 'rows', token, rows, expectTable: k.set, expectKey: k.pk };
}

// The If-Match of a PATCH, which must be exactly the row version the plan holds for the row (planOf `bases`):
//   If-Match: W/"3"
// A missing header, the wildcard `*`, another or older version, a list of versions, or two spellings of the header
// (If-Match and if-match, which could each be read as THE condition) is no condition the plan holds.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/perform-conditional-operations-using-web-api#apply-optimistic-concurrency
function ifMatchOk(headers, held) {
  const values = Object.entries(isPlain(headers) ? headers : {}).filter(([name]) => name.toLowerCase() === 'if-match').map(([, v]) => v);
  return typeof held === 'string' && ROW_VERSION.test(held) && values.length === 1 && values[0] === held;
}

// The PATCH of one planned update row, as the SDK sends it:
//   PATCH /customapis(<id>)?$select=customapiid   If-Match: W/"3"   MSCRM.SolutionUniqueName: ContosoSol   { "isprivate": true }
//   PATCH /customapirequestparameters(<id>)?$select=customapirequestparameterid   If-Match: W/"9"   { "description": "Arg" }
// The query is exactly the selected primary key (return=representation's id). A Custom API child is PATCHed only for its
// labels, and only on its own: in a change set (`constituent`) only the bound root's PATCH of its editable fields is a
// shape a reviewed change-set parser may admit.
function classifyPatch(byId, req, kind, rawId, body, constituent) {
  const id = normalizeGuid(rawId);
  const hit = id ? byId.get(id) : undefined;
  if (!hit || hit.row.kind !== kind || hit.row.mode !== 'update' || !PATCHABLE.has(kind)) return null;
  const keys = Object.keys(body);
  if (constituent && (kind !== 'customApi' || !keys.length || !keys.every((c) => API_ROOT_EDITABLE.has(c)))) return null;
  if (API_CHILD_KINDS.has(kind) && (!keys.length || !keys.every((c) => API_CHILD_EDITABLE.has(c)))) return null;
  const k = KINDS[kind];
  const query = queryOf(req.url);
  if (!query || Object.keys(query).length !== 1 || query.$select !== k.pk) return null;
  if (!ifMatchOk(req.headers, hit.row.ifMatch) || !solutionHeaderOk(hit.planned, kind, req.headers)) return null;
  const sent = sendRow(hit.planned, hit.row, body, 'patch', false);
  if (!sent) return null;
  return { type: 'rows', token: hit.token, rows: [sent], expectTable: k.set, expectKey: k.pk };
}

// AddSolutionComponent of one planned member, in exactly the shape the SDK sends:
//   POST /AddSolutionComponent  { "ComponentId": "<guid>", "ComponentType": 10133, "SolutionUniqueName": "ContosoSol", "AddRequiredComponents": false }
// AddRequiredComponents must be false: true would pull every dependency into the solution, rows this plan never made.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/addsolutioncomponent
function classifyMembership(byId, req, body) {
  const keys = Object.keys(body).sort().join(',');
  if (keys !== 'AddRequiredComponents,ComponentId,ComponentType,SolutionUniqueName' || body.AddRequiredComponents !== false) return null;
  const id = typeof body.ComponentId === 'string' ? normalizeGuid(body.ComponentId) : '';
  const hit = id ? byId.get(id) : undefined;
  if (!hit || typeof body.SolutionUniqueName !== 'string' || lower(body.SolutionUniqueName) !== lower(hit.planned.solution)) return null;
  if (!hit.planned.plan.members.some((m) => m.id === id && m.componentType === body.ComponentType)) return null;
  const query = queryOf(req.url);
  if (!query || Object.keys(query).length) return null;
  return { type: 'effect', token: hit.token, kind: 'membership', id };
}

// The publish of a rule its own create set made, whose declared state is published (the plan's rule-state effect):
//   POST /duplicaterules(<guid>)/Microsoft.Dynamics.CRM.PublishDuplicateRule  {}
// A bound rule's plan holds no such effect (planOf): a rule is published once, when it is created, and only verified after.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/publishduplicaterule
function classifyPublish(byId, req, rawId, parsed) {
  const id = normalizeGuid(rawId);
  const hit = id ? byId.get(id) : undefined;
  if (!hit || hit.row.kind !== 'duplicateRule' || hit.row.mode !== 'create') return null;
  if (!hit.planned.plan.effects.some((e) => e.kind === 'rule-state' && e.id === id)) return null;
  if (!parsed.empty && !(isPlain(parsed.json) && Object.keys(parsed.json).length === 0)) return null;
  const query = queryOf(req.url);
  if (!query || Object.keys(query).length) return null;
  return { type: 'effect', token: hit.token, kind: 'rule-state', id };
}

const ENTITY_BY_ID = /^([a-z]+)\(([^()]+)\)$/;
const PUBLISH = /^duplicaterules\(([^()]+)\)\/Microsoft\.Dynamics\.CRM\.PublishDuplicateRule$/;

function classifyWith(byId, req, constituent) {
  const method = String((req && req.method) || '').toUpperCase();
  let path;
  try { path = apiPath(req && req.url); } catch { return null; }
  if (!path) return null;
  const parsed = parseBody(req.body);
  if (method === 'POST') {
    const publish = PUBLISH.exec(path);
    if (publish) return constituent ? null : classifyPublish(byId, req, publish[1], parsed);
    if (parsed.empty || !parsed.json) return null;
    if (path === 'AddSolutionComponent') return constituent ? null : classifyMembership(byId, req, parsed.json);
    const kind = has(KIND_OF_SET, path) ? KIND_OF_SET[path] : null;
    return kind ? classifyCreate(byId, req, kind, parsed.json, constituent) : null;
  }
  if (method === 'PATCH') {
    const m = ENTITY_BY_ID.exec(path);
    const kind = m && has(KIND_OF_SET, m[1]) ? KIND_OF_SET[m[1]] : null;
    if (!kind || parsed.empty || !parsed.json) return null;
    return classifyPatch(byId, req, kind, m[2], parsed.json, constituent);
  }
  return null;
}

/**
 * The gate's classifier (runWithManagedCreateSet `classify`) for the planned objects of one create set:
 *   createClassifier([{ token, planned }, ...]) -> ({ method, url, body, headers }) -> descriptor | null
 * A descriptor names the attempt (`token`) and the planned rows a request carries, with their sealed non-private
 * projection — or the membership / rule-state effect it is. Null for everything else: a row not planned, planned as
 * an update but POSTed (or the reverse), a column outside the closed maps, a value other than the planned one, a
 * namesake id, a second solution, a query beyond the id, a PATCH without exactly the row version the plan holds
 * (If-Match), a Custom API child PATCH of more than its labels, a publish of a rule the set did not create, a direct
 * condition, a removal.
 */
function createClassifier(entries) {
  const byId = indexOf(entries);
  return (req) => classifyWith(byId, req, false);
}

/**
 * The same classification for ONE constituent of a $batch change set, for the checked change-set parser
 * (managed-create-batch.js, a run's `batch` option), exactly as the SDK sends a bound Custom API's edit:
 *   PATCH .../customapis(<bound id>)?$select=customapiid             If-Match: <held version>  { <editable root fields> }
 *   POST  .../customapiresponseproperties?$select=customapiresponsepropertyid  { ..., "CustomAPIId@odata.bind": "/customapis(<bound id>)" }
 * A root create, a child's label PATCH (admitted only on its own), a membership and a publish are never a constituent.
 * The descriptor adds what the parser checks a constituent against: `prepared` (the wire body encoded from the plan,
 * preparedWire), the root's held `ifMatch`, and a seal of the constituent's own wire fields.
 */
function classifyConstituent(entries, req) {
  return constituentOf(indexOf(entries), req);
}

function constituentOf(byId, req) {
  const out = classifyWith(byId, req, true);
  if (!out || out.rows.length !== 1 || !API_KINDS.has(out.rows[0].kind)) return null;
  const { row } = byId.get(out.rows[0].id);
  const json = parseBody(req.body).json;
  const prepared = preparedWire(row, json);
  if (!prepared || canonicalJson(prepared) !== canonicalJson(json)) return null;
  // The change-set parser (managed-create-batch.js) compares `prepared` with the constituent key for key, holds the root
  // PATCH to `ifMatch`, and checks the sealed projection against the constituent's own wire fields — so here the seal is
  // of every wire key the constituent carries (no private input exists on these kinds), not the semantic projection a
  // direct request is sealed by.
  const sealed = { ...out.rows[0], ...sentProjection(json) };
  return {
    ...out,
    rows: [sealed],
    prepared,
    ...(row.parentId === null ? { ifMatch: row.ifMatch } : {}),
  };
}

// The wire body the plan prepared for one Custom API constituent, key for key over what the constituent carries, each value
// encoded from the plan's expectation (never copied from the request): the primary key is the planned id, the parent bind
// names the planned parent, a text or flag is the expected value and an option is its code. A case-insensitive name
// (a table's logical name) keeps the request's spelling only when it IS the expected name, ignoring case. A key the plan
// cannot encode makes the whole constituent unprepared (null).
function preparedWire(row, json) {
  const k = KINDS[row.kind];
  const out = {};
  for (const [key, raw] of Object.entries(json)) {
    if (key === k.pk) { if (normalizeGuid(raw) !== row.id) return null; out[key] = raw; continue; }
    const bind = /^(.+)@odata\.bind$/.exec(key);
    if (bind) {
      if (!k.parentBind || bind[1] !== k.parentBind || row.parentId === null || boundGuid(raw, k.parentSet) !== row.parentId) return null;
      out[key] = raw;
      continue;
    }
    const spec = has(k.columns, key) ? k.columns[key] : null;
    if (!Array.isArray(spec) || !has(row.expected, spec[0])) return null;
    const want = row.expected[spec[0]];
    if (spec[1] === lowerText) out[key] = typeof raw === 'string' && typeof want === 'string' && raw.toLowerCase() === want ? raw : want;
    else if (key === 'type') out[key] = has(PARAM_TYPES, want) ? PARAM_TYPES[want] : null;
    else if (key === 'bindingtype') out[key] = has(API_BINDINGS, want) ? API_BINDINGS[want] : null;
    else if (key === 'allowedcustomprocessingsteptype') out[key] = has(API_STEPS, want) ? API_STEPS[want] : null;
    else out[key] = want;
  }
  return out;
}

/**
 * The one classifier a run hands the gate (createManagedCreateContext run `classify`) when its set may send the checked
 * change set: a constituent of a `$batch` (the parser passes its `contentId`) is classified as one (classifyConstituent),
 * any other request as a direct one (createClassifier).
 */
function createSetClassifier(entries) {
  const byId = indexOf(entries);
  return (req) => (req && req.contentId !== undefined ? constituentOf(byId, req) : classifyWith(byId, req, false));
}

module.exports = {
  NOT_FOUND_CODE,
  DELETE_CODE,
  PRIVATE_MISMATCH,
  KINDS,
  planOf,
  declarationSha256Of,
  artifactFor,
  acceptResultFor,
  createClassifier,
  classifyConstituent,
  createSetClassifier,
  readConfigurationRow,
  readConfigurationConflicts,
  readAllPages,
  readComponentTypes,
  observe,
  editShapeOf,
  projectionOf,
  semanticOf,
  readMembers,
  ruleStateOf,
};
