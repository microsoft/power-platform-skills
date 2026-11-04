'use strict';

// The protected create driver of the four configuration families — environment variables, connection references,
// Custom APIs and duplicate detection rules — over the managed create lifecycle (managed-create-context.js) and its
// send-once gate (managed-create-transport.js). Not wired into the build yet: this module answers the questions a
// protected create must ask, and nothing here sends a write.
//   planOf(spec, opts)                   the row plan of one artifact (buildRowPlan input) at its derived ids
//   createClassifier(entries)            the gate's classifier: which planned row (or completion effect) a request is
//   classifyConstituent(entries, req)    the same, for one constituent of a $batch change set (a later child only)
//   readConfigurationRow(dv, kind, id)   one exact-id read: present, absent (only a 404 0x80040217) or unknown
//   readConfigurationConflicts(dv, p)    the fully paged namesake queries a create must run first
//   observe(dv, planned)                 the fresh read a recovery or a settle judges (the lifecycle's observation)
//   readComponentTypes(dv)               the ObjectTypeCode of each member table
//   acceptResultFor(planned)             the run's check of what the SDK's pushArtifact answered
//
// Why the comparisons are closed tables rather than "compare what came back":
// - A row at the derived id is ours only when it holds exactly what the plan prepared. Every column a read selects
//   decodes through a fixed table; a value the table does not know (a new option code, a type change) is UNKNOWN,
//   never "close enough", and a column this build never writes must be empty or the row is not the one it prepared.
// - The projection a row is judged by hashes semantic fields (names exact, table and column names lower case), so the
//   same row read through another API version or spelling compares the same, and the SDK's own label defaults (it
//   fills a Custom API's unauthored labels) are not mistaken for a difference.
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
// A column this build never writes. It may only be empty: a value there was put by someone else.
const UNMODELLED = 'unmodelled';
// The private input's column: compared in memory (privateStateOf), never projected.
const PRIVATE = 'private';
// The lookup to the row's parent: the K1a row's parentId, not a field.
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
      _parentdefinitionid_value: ['parentDefinitionId', guid, null],
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
      connectionparametersconfig: UNMODELLED, connectionparametersetconfig: UNMODELLED, promptingbehavior: UNMODELLED,
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
      _plugintypeid_value: UNMODELLED,
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
 * Answers { fields, unmodelled, parentId, private: { present, value }, state } or null (unreadable / not this kind's).
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
  const state = {};
  let secret = { present: false, value: undefined };
  for (const [col, spec] of Object.entries(k.columns)) {
    const present = has(wire, col);
    const v = wire[col];
    if (spec === UNMODELLED) { if (present && v !== null) unmodelled.push(col); continue; }
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
  return { fields, unmodelled: unmodelled.sort(), parentId: parentId === undefined ? undefined : parentId, private: secret, state };
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
  return decoded.fields;
}

const LABELS = ['name', 'displayName', 'description'];
const pickLabels = (from) => Object.fromEntries(LABELS.filter((f) => has(from, f) && from[f] != null).map((f) => [f, from[f]]));
const guidOrText = (v) => (v == null ? null : normalizeGuid(v) || String(v));

// What a row the plan prepares must read back as, from the artifact the SDK is handed (configuration-artifacts.js
// buildArtifact) — one definition for both, so the plan and the push cannot drift apart. The Custom API labels the
// App Spec does not author are left out: the SDK fills them itself (`<api>.<param>`, the unique name), and they are not
// what the maker declared.
function expectedOf(kind, artifact, child) {
  switch (kind) {
    case 'environmentVariable':
      return {
        schemaName: artifact.schemaName, name: artifact.name, description: artifact.description, type: artifact.type,
        defaultValue: artifact.defaultValue, isRequired: artifact.isRequired, valueSchema: artifact.valueSchema,
        connectorId: artifact.connectorId, parameterKey: artifact.parameterKey, parentDefinitionId: artifact.parentId ? normalizeGuid(artifact.parentId) : null,
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
        isPrivate: artifact.isPrivate, executePrivilegeName: artifact.executePrivilegeName, ...pickLabels(artifact),
      };
    case 'customApiRequestParameter':
    case 'customApiResponseProperty':
      return {
        uniqueName: child.uniqueName, type: child.type, entityLogicalName: child.entityLogicalName == null ? null : lower(child.entityLogicalName),
        ...(kind === 'customApiRequestParameter' ? { isOptional: child.isOptional === true } : {}), ...pickLabels(child),
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

// The projection a row is judged by: the expected fields only, plus every unmodelled column a read found filled.
//   sha256(canonicalJson({ kind, fields: { <expected field>: <value>, ... }, unmodelled?: [<column>, ...] }))
function projectionOf(kind, expected, semantic, unmodelled = []) {
  const fields = Object.fromEntries(Object.keys(expected).map((f) => [f, has(semantic, f) ? semantic[f] : null]));
  return sha({ kind, fields, ...(unmodelled.length ? { unmodelled } : {}) });
}
const sameValue = (a, b) => canonicalJson(a === undefined ? null : a) === canonicalJson(b === undefined ? null : b);

// ---------------------------------------------------------------------------------------------
// The plan

// planned object -> { artifact, secrets: Map(rowKey -> private input) }. Module-private and keyed by the frozen planned
// object, so a private input reaches no plan, no JSON of a planned object, no store record and no log: only the SDK
// artifact (artifactFor) and the in-memory comparisons below see it.
const PRIVATE_INPUTS = new WeakMap();
const PLAN_KEY_FIELD = Object.freeze({ environmentVariable: 'schemaName', connectionReference: 'logicalName', customApi: 'uniqueName', duplicateRule: 'key' });

/**
 * The protected create plan of ONE declared configuration artifact, at the ids the create port derives for it:
 *   planOf(spec, { kind, key, bindings?, solution?, intentFor?, boundIdOf?, componentTypes?, boundSlots? })
 * `kind` is a root kind and `key` its declared key (schema name, logical name, unique name, rule key). `bindings` are
 * the deployment bindings (readDeploymentBindings): a bound value adds the value row, a bound connection makes the
 * reference's connection a private input. `solution` is the run's solution (else the spec's, else Default); in a
 * restricted solution (Default, Active) no membership is planned. `componentTypes` is readComponentTypes' `types`,
 * needed whenever membership is. `boundIdOf(kind, portKey)` is a recorded binding's id (the root is then an update);
 * `boundSlots` names children that already exist under it (updates, not creates).
 * Answers a frozen planned object { kind, key, solution, plan, rows } — `plan` is buildRowPlan's input; `rows` are its
 * rows with what each must read back as (`expected`) and, for a child, its slot. No private input is in either.
 */
function planOf(spec, { kind, key, bindings, solution, intentFor = defaultIntentFor, boundIdOf, componentTypes, boundSlots = [] } = {}) {
  if (!ROOT_KINDS.has(kind)) throw new TypeError(`planOf: ${kind} is not a configuration root kind`);
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
  const artifact = A.buildArtifact({ kind, key: portKey, detail: { entry } }, got.id, got.childIds, { bindings: binds }, parentDefinitionId);
  const secrets = new Map();
  const rootId = normalizeGuid(got.id);
  const root = { kind, key: portKey, id: rootId, parentId: null, slot: null, mode: got.intent.boundId !== undefined ? 'update' : 'create', expected: expectedOf(kind, artifact), sensitiveInput: false };
  if (kind === 'connectionReference' && artifact.connectionId != null && artifact.connectionId !== '') {
    root.sensitiveInput = true;
    secrets.set(rowKey(kind, portKey), artifact.connectionId);
  }
  const rows = [root];
  const bound = new Set(boundSlots);
  for (const [slot, rawId] of Object.entries(got.childIds)) {
    const childKind = childKindOf(kind, slot);
    const id = normalizeGuid(rawId);
    const children = kind === 'customApi' ? [...artifact.requestParameters, ...artifact.responseProperties] : kind === 'duplicateRule' ? artifact.conditions : [];
    const child = children.find((c) => normalizeGuid(c.id) === id) || null;
    if (childKind !== 'environmentVariableValue' && !child) throw new TypeError(`planOf: the ${slot} child of ${kind} "${portKey}" is not in its artifact`);
    const row = {
      kind: childKind, key: JSON.stringify([portKey, slot]), id, parentId: rootId, slot, mode: bound.has(slot) ? 'update' : 'create',
      expected: expectedOf(childKind, artifact, child), sensitiveInput: childKind === 'environmentVariableValue',
    };
    // A condition's namesake is any condition of the rule its declaration describes (configuration-artifacts.js describes).
    if (childKind === 'duplicateRuleCondition') row.declared = structuredClone((entry.conditions || []).find((c) => c.key === slot));
    if (childKind === 'environmentVariableValue') secrets.set(rowKey(childKind, row.key), artifact.currentValue.value);
    rows.push(row);
  }
  for (const r of rows) r.expectedSha256 = projectionOf(r.kind, r.expected, r.expected);
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
  const ruleState = kind === 'duplicateRule' ? artifact.status : null;
  if (ruleState !== null && ruleState !== 'published' && ruleState !== 'unpublished') throw new TypeError(`planOf: rule status ${ruleState} is not one this driver plans`);
  const planRows = rows.map(({ kind: k, key: rk, id, parentId, mode, expectedSha256, sensitiveInput }) => ({ kind: k, key: rk, id, parentId, mode, expectedSha256, sensitiveInput }));
  const plan = {
    family: kind, key: portKey,
    declarationSha256: sha({ kind, key: portKey, declaration: A.portableIntent(kind, entry), solution: sol, rows: planRows, ruleState }),
    rows: planRows, members, ruleState,
    effects: [...members.map((m) => ({ kind: 'membership', id: m.id })), ...(ruleState === 'published' ? [{ kind: 'rule-state', id: rootId }] : [])],
  };
  const planned = deepFreeze({ kind, key: portKey, solution: sol, plan, rows });
  PRIVATE_INPUTS.set(planned, { artifact, secrets });
  return planned;
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
 * Answers { state: 'present', id, parentId, decoded } | { state: 'absent' } | { state: 'unknown', reason }. Present
 * only when the answer names this id and carries every selected column (Dataverse answers `null` for an empty one) but
 * the private one, whose absence is a masked value, not an unreadable row.
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
  return { state: 'present', id: want, parentId: decoded.parentId === undefined ? null : decoded.parentId, decoded };
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
 * The fresh observation the lifecycle judges (managed-create-context.js classifyRecovery / settle):
 *   { rows: [{ kind, key, id, state, parentId?, projectionSha256?, privateState? }], members: [{ id, state }], ruleState }
 * One exact-id read per planned row (readConfigurationRow), the solution's members (readMembers) and the rule's state
 * from its own read. An absent rule is reported unpublished — there is no rule to be published — so its absence is
 * judged as the missing row it is; an unreadable or publishing rule leaves the state unknown.
 */
async function observe(dataverse, planned) {
  const { secrets } = privateOf(planned);
  const rows = [];
  let ruleState = null;
  for (const r of planned.rows) {
    const read = await readConfigurationRow(dataverse, r.kind, r.id);
    if (r.kind === 'duplicateRule') ruleState = read.state === 'absent' ? 'unpublished' : read.state === 'present' ? ruleStateOf(read.decoded.state.statecode, read.decoded.state.statuscode) : undefined;
    if (read.state !== 'present') {
      rows.push({ kind: r.kind, key: r.key, id: r.id, state: read.state });
      continue;
    }
    const out = {
      kind: r.kind, key: r.key, id: read.id, state: 'present', parentId: read.parentId,
      projectionSha256: projectionOf(r.kind, r.expected, semanticOf(r.kind, read.decoded), read.decoded.unmodelled),
    };
    if (r.sensitiveInput) out.privateState = privateStateOf(read.decoded.private, secrets.get(rowKey(r.kind, r.key)));
    rows.push(out);
  }
  return { rows, members: await readMembers(dataverse, planned), ruleState };
}

// ---------------------------------------------------------------------------------------------
// The classifier: which planned row, or which completion effect, one mutation is. Anything else answers null (the
// gate refuses it unsent). Every check is against the plan, never against what the request says about itself.

const KIND_OF_SET = Object.freeze(Object.fromEntries(Object.entries(KINDS).map(([kind, k]) => [k.set, kind])));
const API_KINDS = new Set(['customApi', 'customApiRequestParameter', 'customApiResponseProperty']);
const PATCHABLE = new Set(['environmentVariable', 'environmentVariableValue', 'connectionReference', 'customApi']);
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
 * unmodelled column, sit under the planned parent (a nested child binds none — its parent is the root it is inside;
 * any other child binds exactly its planned parent; a root binds none), and say exactly what the plan expects: every
 * semantic field equal, nothing more but the Custom API labels the SDK fills. A private input other than the planned one
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
    if (has(row.expected, f)) { if (!sameValue(v, row.expected[f])) return null; continue; }
    if (!(API_KINDS.has(row.kind) && LABELS.includes(f) && typeof v === 'string')) return null;
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

function classifyPatch(byId, req, kind, rawId, body, constituent) {
  const id = normalizeGuid(rawId);
  const hit = id ? byId.get(id) : undefined;
  if (!hit || hit.row.kind !== kind || hit.row.mode !== 'update' || !PATCHABLE.has(kind)) return null;
  if (constituent && kind !== 'customApi') return null;
  const query = queryOf(req.url);
  if (!query || Object.keys(query).length || !solutionHeaderOk(hit.planned, kind, req.headers)) return null;
  const sent = sendRow(hit.planned, hit.row, body, 'patch', false);
  if (!sent) return null;
  const k = KINDS[kind];
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

// The publish of a planned rule whose declared state is published:
//   POST /duplicaterules(<guid>)/Microsoft.Dynamics.CRM.PublishDuplicateRule  {}
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/publishduplicaterule
function classifyPublish(byId, req, rawId, parsed) {
  const id = normalizeGuid(rawId);
  const hit = id ? byId.get(id) : undefined;
  if (!hit || hit.row.kind !== 'duplicateRule' || hit.planned.plan.ruleState !== 'published') return null;
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
 * namesake id, a second solution, a query beyond the id, a direct condition, a removal.
 */
function createClassifier(entries) {
  const byId = indexOf(entries);
  return (req) => classifyWith(byId, req, false);
}

/**
 * The same classification for ONE constituent of a $batch change set. The gate refuses a $batch outright today; this is
 * the narrow shape a reviewed change-set parser may admit later: a bound Custom API root's PATCH and the POST of a
 * later child under its planned parent. A root create, a membership and a publish are never a constituent.
 */
function classifyConstituent(entries, req) {
  const out = classifyWith(indexOf(entries), req, true);
  if (!out) return null;
  return out.rows.every((r) => API_KINDS.has(r.kind)) ? out : null;
}

module.exports = {
  NOT_FOUND_CODE,
  DELETE_CODE,
  PRIVATE_MISMATCH,
  KINDS,
  planOf,
  artifactFor,
  acceptResultFor,
  createClassifier,
  classifyConstituent,
  readConfigurationRow,
  readConfigurationConflicts,
  readComponentTypes,
  observe,
  projectionOf,
};
