'use strict';
// A small, strict, stateful Dataverse for the configuration artifacts the plugin writes through the bundled SDK: environment
// variable definitions and values, connection references, Custom API definitions (with their request parameters and response
// properties), duplicate-detection rules (with their conditions), the solution row (its version) and a table's
// duplicate-detection flag. The real SDK bundle talks to it through `request`, the transport `lib/sdk-http-client.js` takes,
// so a test proves the wire the bundle actually sends — not a mock of the SDK.
//
// Strict on purpose: a path, a column, a navigation or an action this fake does not model answers 501 and is recorded in
// `unexpected`, so a new request shape fails the test that first sends it instead of being answered by a guess.
//
// Rows are stored by entity set; every write bumps the row's `versionnumber`, which is also its ETag (`W/"<n>"`), and a
// PATCH or DELETE with a stale If-Match answers 412 as Dataverse does.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/perform-conditional-operations-using-web-api
const { randomUUID } = require('node:crypto');
const { compileFilter, describeFilter, evaluateFilter } = require('./odata-filter.js');

const API_ROOT = /^\/api\/data\/v9\.\d/;
const lc = (s) => String(s).toLowerCase();
const normGuid = (s) => lc(String(s || '').replace(/[{}]/g, ''));

// Each modelled entity set: its primary key, the columns a row may hold, and its collection-valued navigations (child set +
// the lookup column on the child that points back). A deep insert under a navigation creates the child rows in the same request.
const SETS = {
  environmentvariabledefinitions: {
    pk: 'environmentvariabledefinitionid',
    columns: ['schemaname', 'displayname', 'description', 'type', 'defaultvalue', 'isrequired', 'valueschema', 'connectorid',
      'parameterkey', '_parentdefinitionid_value', 'secretstore', 'ismanaged', 'solutionid', 'statecode', 'statuscode', 'introducedversion',
      'iscustomizable', 'hint', 'apiid', 'learnmoreurl', 'inputcontrolconfig'],
    lookups: { parentdefinitionid: 'environmentvariabledefinitions', ParentDefinitionId: 'environmentvariabledefinitions' },
    navs: { environmentvariabledefinition_environmentvariablevalue: { set: 'environmentvariablevalues', fk: '_environmentvariabledefinitionid_value' } },
  },
  environmentvariablevalues: {
    pk: 'environmentvariablevalueid',
    columns: ['value', 'schemaname', '_environmentvariabledefinitionid_value', 'ismanaged', 'statecode', 'statuscode'],
    lookups: { EnvironmentVariableDefinitionId: 'environmentvariabledefinitions', environmentvariabledefinitionid: 'environmentvariabledefinitions' },
    navs: {},
  },
  connectionreferences: {
    pk: 'connectionreferenceid',
    columns: ['connectionreferencelogicalname', 'connectionreferencedisplayname', 'description', 'connectorid', 'connectionid',
      '_customconnectorid_value', 'connectionparametersconfig', 'connectionparametersetconfig', 'ismanaged', 'statecode', 'statuscode',
      'iscustomizable', 'promptingbehavior'],
    lookups: { CustomConnectorId: 'connectors' },
    navs: {},
  },
  customapis: {
    pk: 'customapiid',
    columns: ['uniquename', 'name', 'displayname', 'description', 'bindingtype', 'boundentitylogicalname', 'isfunction', 'isprivate',
      'allowedcustomprocessingsteptype', 'workflowsdkstepenabled', 'executeprivilegename', '_plugintypeid_value', 'ismanaged',
      'iscustomizable', '_sdkmessageid_value', 'statecode', 'statuscode', 'customizationlevel'],
    lookups: { PluginTypeId: 'plugintypes' },
    navs: {
      CustomAPIRequestParameters: { set: 'customapirequestparameters', fk: '_customapiid_value' },
      CustomAPIResponseProperties: { set: 'customapiresponseproperties', fk: '_customapiid_value' },
    },
  },
  customapirequestparameters: {
    pk: 'customapirequestparameterid',
    columns: ['uniquename', 'name', 'displayname', 'description', 'type', 'logicalentityname', 'isoptional', '_customapiid_value',
      'ismanaged', 'iscustomizable', 'statecode', 'statuscode'],
    lookups: { CustomAPIId: 'customapis' },
    navs: {},
  },
  customapiresponseproperties: {
    pk: 'customapiresponsepropertyid',
    columns: ['uniquename', 'name', 'displayname', 'description', 'type', 'logicalentityname', '_customapiid_value', 'ismanaged',
      'iscustomizable', 'statecode', 'statuscode'],
    lookups: { CustomAPIId: 'customapis' },
    navs: {},
  },
  duplicaterules: {
    pk: 'duplicateruleid',
    columns: ['name', 'description', 'baseentityname', 'matchingentityname', 'iscasesensitive', 'excludeinactiverecords',
      'statecode', 'statuscode', 'ismanaged', 'iscustomizable', 'baseentitytypecode', 'matchingentitytypecode', 'uniquename'],
    lookups: {},
    navs: { DuplicateRule_DuplicateRuleConditions: { set: 'duplicateruleconditions', fk: '_regardingobjectid_value' } },
  },
  duplicateruleconditions: {
    pk: 'duplicateruleconditionid',
    columns: ['baseattributename', 'matchingattributename', 'operatorcode', 'operatorparam', 'ignoreblankvalues', '_regardingobjectid_value',
      'uniquerulename'],
    lookups: { regardingobjectid: 'duplicaterules', RegardingObjectId: 'duplicaterules', regardingobjectid_duplicaterule: 'duplicaterules' },
    navs: {},
  },
  solutions: {
    pk: 'solutionid',
    columns: ['uniquename', 'friendlyname', 'version', 'ismanaged', '_publisherid_value', 'isvisible'],
    lookups: {},
    navs: {},
    single: { publisherid: { set: 'publishers', fk: '_publisherid_value' } },
  },
  publishers: {
    pk: 'publisherid',
    columns: ['uniquename', 'friendlyname', 'customizationprefix', 'customizationoptionvalueprefix'],
    lookups: {},
    navs: {},
  },
  // A solution's members. `objectid` is the component's own id; `componenttype` is the platform's type code (380 for an environment
  // variable definition) or, for a kind stored as a table row (a connection reference, a Custom API), that table's ObjectTypeCode.
  // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/solutioncomponent
  solutioncomponents: {
    pk: 'solutioncomponentid',
    columns: ['objectid', 'componenttype', 'rootcomponentbehavior', '_solutionid_value'],
    lookups: {},
    navs: {},
  },
  asyncoperations: {
    pk: 'asyncoperationid',
    columns: ['statecode', 'statuscode', 'message', 'friendlymessage', 'name', 'operationtype'],
    lookups: {},
    navs: {},
  },
};

class Unmodelled extends Error {}

/**
 * @param {object} [options]
 * @param {string} [options.origin]
 * @param {Array<{logicalName:string, duplicateDetectionEnabled?:boolean, attributes?:string[]}>} [options.tables]
 * @param {{uniqueName:string, version?:string, prefix?:string, managed?:boolean}} [options.solution]
 * @param {(req:{method:string,path:string,body:any}) => ({statusCode:number, body?:any}|undefined|Promise<...>)} [options.intercept]
 *   answers a request before the store does (used to provoke a refusal or a lost answer); it may be async, so it can
 *   let the store apply the request first and then lose the answer
 * @param {boolean} [options.childrenJoin] a create sent with a solution header puts the children it carries (or a child
 *   created on its own) into that solution too. Off by default: a compound create's children are then left out, the
 *   behaviour the platform's own duplicate-rule code works around, so a caller must prove (and add) each child itself.
 * @param {number} [options.pageSize] server-driven paging: a collection read without `$top` answers at most this many rows
 *   and, when more remain, an absolute `@odata.nextLink` carrying `$skiptoken=<offset>`. Off by default (one page).
 * @param {boolean} [options.liveRowShape] answer two rows as a live environment does: a connection reference created without
 *   `promptingbehavior` stores the platform's create default 0 (a live read shows `"promptingbehavior": 0` on every
 *   reference the plugin made), and a `duplicaterules` row is answered WITHOUT `@odata.etag` (a live read of a rule carries
 *   none, while every other configuration row does). Off by default, so the tests written before keep their answers.
 */
function createConfigOrg(options = {}) {
  const origin = options.origin || 'https://contoso.crm.dynamics.com';
  const sets = new Map(Object.keys(SETS).map((name) => [name, new Map()]));
  const requests = [];
  const unexpected = [];
  const tables = new Map((options.tables || []).map((t) => [lc(t.logicalName), {
    logicalName: lc(t.logicalName),
    duplicateDetectionEnabled: t.duplicateDetectionEnabled !== false,
    attributes: (t.attributes || []).map(lc),
    objectTypeCode: t.objectTypeCode || 10000 + sets.size,
  }]));
  // The system tables whose rows are solution components identified by the table's ObjectTypeCode (which differs per org, so a
  // caller reads it from metadata rather than hard-coding it).
  // `solution` and `solutioncomponent` are here for their EntitySetName, which the SDK's queryRecords reads first.
  for (const [logicalName, objectTypeCode, entitySetName] of [['connectionreference', 10132, 'connectionreferences'], ['customapi', 10133, 'customapis'],
    ['customapirequestparameter', 10134, 'customapirequestparameters'], ['customapiresponseproperty', 10135, 'customapiresponseproperties'],
    ['duplicaterule', 4414, 'duplicaterules'], ['duplicaterulecondition', 4416, 'duplicateruleconditions'],
    ['solution', 7100, 'solutions'], ['solutioncomponent', 7103, 'solutioncomponents']]) {
    if (!tables.has(logicalName)) tables.set(logicalName, { logicalName, duplicateDetectionEnabled: false, attributes: [], objectTypeCode, entitySetName });
  }
  let version = 1;

  const publisherId = randomUUID();
  sets.get('publishers').set(publisherId, {
    publisherid: publisherId, uniquename: 'contoso', friendlyname: 'Contoso', customizationprefix: (options.solution && options.solution.prefix) || 'contoso',
    customizationoptionvalueprefix: 10000, versionnumber: version++,
  });
  const solution = options.solution || { uniqueName: 'ContosoSol', version: '1.0.0.0' };
  const solutionId = solution.id || randomUUID();
  sets.get('solutions').set(solutionId, {
    solutionid: solutionId, uniquename: solution.uniqueName, friendlyname: solution.uniqueName, version: solution.version || '1.0.0.0',
    ismanaged: solution.managed === true, _publisherid_value: publisherId, isvisible: true, versionnumber: version++,
  });

  const json = (statusCode, body, headers = {}) => ({
    statusCode,
    headers: { 'content-type': 'application/json; odata.metadata=minimal', 'odata-version': '4.0', ...headers },
    body: body === undefined ? '' : JSON.stringify(body),
  });
  const failure = (statusCode, code, message) => json(statusCode, { error: { code, message } });
  const etagOf = (row) => `W/"${row.versionnumber}"`;
  const headerOf = (headers, name) => (Object.entries(headers || {}).find(([k]) => lc(k) === lc(name)) || [])[1];

  function parseQuery(search) {
    const out = {};
    for (const part of search.replace(/^\?/, '').split(/&(?=\$|@)/)) {
      if (!part) continue;
      const eq = part.indexOf('=');
      out[part.slice(0, eq)] = part.slice(eq + 1);
    }
    return out;
  }
  // `$expand=CustomAPIRequestParameters($select=a,b),CustomAPIResponseProperties($select=c)` -> [{ nav, select }]
  function parseExpand(text) {
    const out = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i <= text.length; i += 1) {
      const ch = text[i];
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if ((ch === ',' && depth === 0) || i === text.length) {
        const item = text.slice(start, i);
        start = i + 1;
        const m = /^([A-Za-z_]+)(?:\((.*)\))?$/.exec(item);
        if (!m) throw new Unmodelled(`$expand item ${item}`);
        const inner = m[2] ? Object.fromEntries(m[2].split(';').map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)])) : {};
        out.push({ nav: m[1], select: inner.$select, filter: inner.$filter });
      }
    }
    return out;
  }

  function checkColumns(set, names, where) {
    const schema = SETS[set];
    for (const name of names) {
      if (name === schema.pk || name === 'versionnumber' || name === 'createdon' || name === 'modifiedon' || name === 'solutionid') continue;
      if (!schema.columns.includes(name)) {
        throw Object.assign(new Error(`Could not find a property named '${name}' on type 'Microsoft.Dynamics.CRM.${set.replace(/s$/, '')}' (${where})`), { status: 400 });
      }
    }
  }

  function shape(set, row, query) {
    const schema = SETS[set];
    const select = query.$select ? query.$select.split(',') : null;
    if (select) checkColumns(set, select, `${set} $select`);
    const out = options.liveRowShape && set === 'duplicaterules' ? {} : { '@odata.etag': etagOf(row) };
    for (const [k, v] of Object.entries(row)) {
      if (k === 'versionnumber') continue;
      if (!select || select.includes(k) || k === schema.pk) out[k] = v;
    }
    // Dataverse answers every selected column, `null` when the row holds no value.
    for (const col of select || []) if (!(col in out) && col !== 'versionnumber') out[col] = row[col] === undefined ? null : row[col];
    if (select && select.includes('versionnumber')) out.versionnumber = row.versionnumber;
    if (query.$expand) {
      for (const ex of parseExpand(query.$expand)) {
        if (schema.navs[ex.nav]) {
          const nav = schema.navs[ex.nav];
          const children = [...sets.get(nav.set).values()].filter((c) => normGuid(c[nav.fk]) === normGuid(row[schema.pk]))
            .filter((c) => !ex.filter || evaluateFilter(compileFilter(ex.filter), c));
          out[ex.nav] = children.map((c) => shape(nav.set, c, { $select: ex.select }));
        } else if (schema.single && schema.single[ex.nav]) {
          const one = schema.single[ex.nav];
          const target = sets.get(one.set).get(normGuid(row[one.fk]));
          out[ex.nav] = target ? shape(one.set, target, { $select: ex.select }) : null;
        } else {
          throw new Unmodelled(`$expand ${ex.nav} on ${set}`);
        }
      }
    }
    return out;
  }

  // A body's `Lookup@odata.bind: "/set(id)"` becomes the `_lookup_value` column; a nested array under a navigation becomes child rows.
  function insert(set, body, parentLink) {
    const schema = SETS[set];
    const id = normGuid(body[schema.pk] || randomUUID());
    if (sets.get(set).has(id)) throw Object.assign(new Error(`A record with matching key values already exists (${set} ${id})`), { status: 412, code: '0x80040237' });
    const row = { [schema.pk]: id };
    const children = [];
    for (const [key, value] of Object.entries(body)) {
      if (key === schema.pk || key.startsWith('@odata')) continue;
      const bind = /^(.+)@odata\.bind$/.exec(key);
      if (bind) {
        if (!schema.lookups[bind[1]]) throw new Unmodelled(`${set} binds ${bind[1]}`);
        const target = /\(([^)]+)\)/.exec(String(value));
        const col = `_${lc(bind[1]).replace(/_duplicaterule$/, '')}_value`;
        row[col] = target ? normGuid(target[1]) : null;
        continue;
      }
      if (schema.navs[key]) {
        children.push([schema.navs[key], value]);
        continue;
      }
      checkColumns(set, [key], `${set} body`);
      row[key] = value;
    }
    if (parentLink) row[parentLink.fk] = parentLink.id;
    if (set === 'duplicaterules' && row.statecode === undefined) { row.statecode = 0; row.statuscode = 0; }
    if (options.liveRowShape && set === 'connectionreferences' && row.promptingbehavior === undefined) row.promptingbehavior = 0;
    row.versionnumber = version++;
    row.ismanaged = row.ismanaged || false;
    sets.get(set).set(id, row);
    for (const [nav, items] of children) for (const item of items || []) insert(nav.set, item, { fk: nav.fk, id });
    return row;
  }

  function update(set, id, body, headers) {
    const row = sets.get(set).get(normGuid(id));
    if (!row) return failure(404, '0x80040217', `${set} With Id = ${id} Does Not Exist`);
    const ifMatch = headerOf(headers, 'If-Match');
    if (ifMatch && ifMatch !== '*' && ifMatch !== etagOf(row)) return failure(412, '0x80060882', 'The version of the existing record doesn\'t match the RowVersion property provided.');
    const schema = SETS[set];
    for (const [key, value] of Object.entries(body || {})) {
      const bind = /^(.+)@odata\.bind$/.exec(key);
      if (bind) {
        if (!schema.lookups[bind[1]]) throw new Unmodelled(`${set} binds ${bind[1]}`);
        const target = /\(([^)]+)\)/.exec(String(value));
        row[`_${lc(bind[1])}_value`] = target ? normGuid(target[1]) : null;
        continue;
      }
      if (key.startsWith('@odata')) continue;
      if (schema.navs[key]) throw new Unmodelled(`${set} PATCH with a nested ${key}`);
      checkColumns(set, [key], `${set} PATCH body`);
      row[key] = value;
    }
    // Editing a published duplicate-detection rule unpublishes it; it must be published again to take effect.
    if (set === 'duplicaterules' && row.statecode === 1) { row.statecode = 0; row.statuscode = 0; }
    row.versionnumber = version++;
    return null;
  }

  function remove(set, id, headers) {
    const row = sets.get(set).get(normGuid(id));
    if (!row) return failure(404, '0x80040217', `${set} With Id = ${id} Does Not Exist`);
    const ifMatch = headerOf(headers, 'If-Match');
    if (ifMatch && ifMatch !== '*' && ifMatch !== etagOf(row)) return failure(412, '0x80060882', 'The version of the existing record doesn\'t match.');
    sets.get(set).delete(normGuid(id));
    for (const nav of Object.values(SETS[set].navs)) {
      for (const [cid, child] of sets.get(nav.set)) if (normGuid(child[nav.fk]) === normGuid(id)) sets.get(nav.set).delete(cid);
    }
    return null;
  }

  function list(set, query) {
    let rows = [...sets.get(set).values()];
    if (query.$filter) {
      const ast = compileFilter(query.$filter);
      const described = describeFilter(ast);
      if (described.paths.length || described.lambdas.length) throw new Unmodelled(`a navigation in the $filter of ${set}`);
      checkColumns(set, described.fields, `${set} $filter`);
      rows = rows.filter((row) => evaluateFilter(ast, row));
    }
    if (query.$top) rows = rows.slice(0, Number(query.$top));
    return rows;
  }

  // One page of a collection read (options.pageSize). The continuation is the same query plus `$skiptoken=<offset>`, as
  // an absolute URL — the shape Dataverse answers:
  //   { "value": [ ... ], "@odata.nextLink": "https://contoso.crm.dynamics.com/api/data/v9.2/customapis?$select=...&$skiptoken=..." }
  // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query/page-results
  function page(set, query) {
    const { $skiptoken: token, ...rest } = query;
    const offset = token === undefined ? 0 : Number(token);
    if (!Number.isInteger(offset) || offset < 0) throw Object.assign(new Error(`a malformed $skiptoken ${token}`), { status: 400 });
    const rows = list(set, rest);
    const out = { value: rows.slice(offset, offset + options.pageSize).map((row) => shape(set, row, rest)) };
    if (offset + options.pageSize < rows.length) {
      const search = Object.entries({ ...rest, $skiptoken: String(offset + options.pageSize) }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
      out['@odata.nextLink'] = `${origin}/api/data/v9.2/${set}?${search}`;
    }
    return out;
  }

  // The duplicate-detection publish job: `PublishDuplicateRule` queues an asyncoperation that, once read, has completed and set the
  // rule to Published (statecode 1, statuscode 2). Learn: duplicaterule StatusCode — 0/0 Unpublished, 0/1 Publishing, 1/2 Published.
  function publishRule(id) {
    const row = sets.get('duplicaterules').get(normGuid(id));
    if (!row) return failure(404, '0x80040217', `duplicaterule With Id = ${id} Does Not Exist`);
    const table = tables.get(lc(row.baseentityname));
    if (table && !table.duplicateDetectionEnabled) {
      return failure(400, '0x80048416', 'Duplicate detection is not enabled for this entity.');
    }
    const jobId = randomUUID();
    sets.get('asyncoperations').set(jobId, { asyncoperationid: jobId, statecode: 3, statuscode: 30, name: 'Publish duplicate rule', versionnumber: version++ });
    row.statecode = 1;
    row.statuscode = 2;
    row.versionnumber = version++;
    return json(200, { asyncoperationid: jobId });
  }

  // `CompoundUpdateDuplicateDetectionRule` writes the rule's columns and REPLACES its condition set with `ChildEntities`: a listed
  // condition is updated (inserted when unknown), every condition it does not list is deleted. Like any edit it unpublishes the rule.
  //   { "Entity": { "@odata.type": "...duplicaterule", "duplicateruleid": "<id>", "description": "x" },
  //     "ChildEntities": [ { "@odata.type": "...duplicaterulecondition", "duplicateruleconditionid": "<id>", "baseattributename": ... } ] }
  function compoundUpdateRule(body) {
    const entity = { ...(body && body.Entity) };
    const id = entity.duplicateruleid;
    if (!id) throw new Unmodelled('a compound update without a rule id');
    delete entity['@odata.type'];
    delete entity.duplicateruleid;
    const refused = update('duplicaterules', id, entity, {});
    if (refused) return refused;
    const conditions = sets.get('duplicateruleconditions');
    const listed = new Set();
    for (const child of (body.ChildEntities || [])) {
      const columns = { ...child };
      delete columns['@odata.type'];
      const cid = normGuid(columns.duplicateruleconditionid || randomUUID());
      delete columns.duplicateruleconditionid;
      listed.add(cid);
      if (conditions.has(cid)) {
        checkColumns('duplicateruleconditions', Object.keys(columns), 'compound child');
        Object.assign(conditions.get(cid), columns, { versionnumber: version++ });
      } else {
        insert('duplicateruleconditions', { duplicateruleconditionid: cid, ...columns }, { fk: '_regardingobjectid_value', id: normGuid(id) });
      }
    }
    for (const [cid, row] of [...conditions]) {
      if (normGuid(row._regardingobjectid_value) === normGuid(id) && !listed.has(cid)) conditions.delete(cid);
    }
    return { statusCode: 204, headers: { 'odata-version': '4.0' }, body: '' };
  }

  // The component type a created row of `set` is held under in a solution, or null for a set this fake does not track membership of.
  const ROOT_COMPONENT_TYPES = {
    environmentvariabledefinitions: () => 380,
    connectionreferences: () => tables.get('connectionreference').objectTypeCode,
    customapis: () => tables.get('customapi').objectTypeCode,
    // A duplicate rule is a table row too: a current environment lists it under the duplicaterule table's ObjectTypeCode, not the
    // documented 44.
    duplicaterules: () => tables.get('duplicaterule').objectTypeCode,
  };
  // A child row's type: a Custom API parameter or property, or a rule condition, is a table row (its table's ObjectTypeCode; for a
  // condition not the documented 45). An environment variable VALUE is deliberately absent: it is never a member.
  const CHILD_COMPONENT_TYPES = {
    customapirequestparameters: () => tables.get('customapirequestparameter').objectTypeCode,
    customapiresponseproperties: () => tables.get('customapiresponseproperty').objectTypeCode,
    duplicateruleconditions: () => tables.get('duplicaterulecondition').objectTypeCode,
  };
  const solutionByName = (name) => [...sets.get('solutions').values()].find((s) => lc(s.uniquename) === lc(name));
  function addMember(solution, objectId, componentType) {
    const members = sets.get('solutioncomponents');
    const existing = [...members.values()].find((m) => m._solutionid_value === solution.solutionid && m.objectid === normGuid(objectId) && m.componenttype === componentType);
    if (existing) return existing;
    const row = { solutioncomponentid: randomUUID(), objectid: normGuid(objectId), componenttype: componentType, rootcomponentbehavior: null, _solutionid_value: solution.solutionid, versionnumber: version++ };
    members.set(row.solutioncomponentid, row);
    return row;
  }
  // A create sent with MSCRM.SolutionUniqueName lands in that solution as well.
  // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-entity-web-api#create-a-record-in-a-solution
  function joinSolution(set, row, solutionName) {
    const typeOf = ROOT_COMPONENT_TYPES[set] || (options.childrenJoin ? CHILD_COMPONENT_TYPES[set] : null);
    const solution = solutionName && typeOf ? solutionByName(solutionName) : null;
    if (!solution) return;
    const id = row[SETS[set].pk];
    addMember(solution, id, typeOf());
    if (!options.childrenJoin) return;
    for (const nav of Object.values(SETS[set].navs)) {
      const childType = CHILD_COMPONENT_TYPES[nav.set];
      if (!childType) continue;
      for (const child of sets.get(nav.set).values()) if (child[nav.fk] === id) addMember(solution, child[SETS[nav.set].pk], childType());
    }
  }
  // `AddSolutionComponent`: { ComponentId, ComponentType, SolutionUniqueName, AddRequiredComponents } -> { id }. A component already in
  // the solution is answered as success, as the platform does. The classic duplicate-rule condition type is refused as a current
  // environment refuses it (nothing is added):
  //   400 {"error":{"code":"0x80040216","message":"Invalid component type provided 45"}}
  // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/addsolutioncomponent
  function addSolutionComponent(body) {
    const solution = solutionByName(body && body.SolutionUniqueName);
    if (!solution) return failure(404, '0x8004f01d', 'The solution does not exist');
    if (!body.ComponentId || !Number.isInteger(body.ComponentType)) throw new Unmodelled('an AddSolutionComponent without a component');
    if (body.ComponentType === 45) return failure(400, '0x80040216', `Invalid component type provided ${body.ComponentType}`);
    const row = addMember(solution, body.ComponentId, body.ComponentType);
    return json(200, { id: row.solutioncomponentid });
  }

  function entityDefinition(logical, query) {
    const table = tables.get(lc(logical));
    if (!table) return failure(404, '0x80060888', `Could not find an entity with name ${logical}`);
    const select = (query.$select || '').split(',').filter(Boolean);
    const out = { MetadataId: randomUUID(), LogicalName: table.logicalName };
    for (const col of select) {
      if (col === 'IsDuplicateDetectionEnabled') out.IsDuplicateDetectionEnabled = { Value: table.duplicateDetectionEnabled, CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyduplicatedetectionsettings' };
      else if (col === 'LogicalName' || col === 'MetadataId') continue;
      else if (col === 'ObjectTypeCode') out.ObjectTypeCode = table.objectTypeCode;
      else if (col === 'EntitySetName') out.EntitySetName = table.entitySetName || `${table.logicalName}s`;
      else throw new Unmodelled(`EntityDefinitions $select ${col}`);
    }
    return json(200, out);
  }

  // The representation a write answers under `Prefer: return=representation`, as Dataverse renders it: its context names
  // the set and the selected columns, and a created row echoes the lookups its body bound (the service answers the
  // `_<lookup>_value` of an `@odata.bind` even when only the primary key is selected), e.g.
  //   {"@odata.context":"<api base>/$metadata#customapirequestparameters(customapirequestparameterid)/$entity",
  //    "@odata.etag":"W/\"7\"","customapirequestparameterid":"<id>","_customapiid_value":"<api id>"}
  function representation(set, row, query, apiBase, created) {
    const out = { '@odata.context': `${apiBase}/$metadata#${set}${query.$select ? `(${query.$select})` : ''}/$entity`, ...shape(set, row, query) };
    if (created) for (const [k, v] of Object.entries(row)) if (/^_.+_value$/.test(k) && v !== null && v !== undefined && !(k in out)) out[k] = v;
    return out;
  }
  // The API base a request named: `https://<host>/api/data/v9.x`.
  const apiBaseOf = (parsed) => `${parsed.origin}${(/^\/api\/data\/v9\.\d/.exec(parsed.pathname) || ['/api/data/v9.0'])[0]}`;

  async function dispatch(method, where, body, headers, apiBase = `${origin}/api/data/v9.0`) {
    const qIndex = where.indexOf('?');
    const pathPart = qIndex === -1 ? where : where.slice(0, qIndex);
    const query = qIndex === -1 ? {} : parseQuery(where.slice(qIndex));
    if (options.intercept) {
      const answer = await options.intercept({ method, path: where, body, headers });
      if (answer) return answer.raw ? answer.raw : json(answer.statusCode, answer.body);
    }
    if (method === 'POST' && pathPart === '/$batch') return batch(body, apiBase);
    let m = /^\/EntityDefinitions\(LogicalName='([^']+)'\)$/.exec(pathPart);
    if (m && method === 'GET') return entityDefinition(m[1], query);
    m = /^\/duplicaterules\(([^)]+)\)\/Microsoft\.Dynamics\.CRM\.PublishDuplicateRule$/.exec(pathPart);
    if (m && method === 'POST') return publishRule(m[1]);
    if (pathPart === '/CompoundUpdateDuplicateDetectionRule' && method === 'POST') return compoundUpdateRule(body);
    if (pathPart === '/AddSolutionComponent' && method === 'POST') return addSolutionComponent(body);
    // The languages provisioned in the org; a Custom API label edit is written only when exactly one is (else it is refused).
    if (pathPart === '/RetrieveProvisionedLanguages()' && method === 'GET') return json(200, { RetrieveProvisionedLanguages: options.languages || [1033] });
    if (pathPart === '/WhoAmI()' && method === 'GET') return json(200, { UserId: '00000000-0000-0000-0000-0000000000aa', BusinessUnitId: randomUUID(), OrganizationId: randomUUID() });
    m = /^\/([a-z]+)(?:\(([^)]+)\))?$/.exec(pathPart);
    if (!m || !SETS[m[1]]) throw new Unmodelled('the path');
    const [, set, key] = m;
    // A key may be an alternate key (`/solutions(uniquename='x')`); only the primary key is modelled.
    if (key && !/^\{?[0-9a-f-]{36}\}?$/i.test(key)) throw new Unmodelled(`an alternate key ${key}`);
    if (method === 'GET' && key) {
      const row = sets.get(set).get(normGuid(key));
      if (!row) return failure(404, '0x80040217', `${set} With Id = ${key} Does Not Exist`);
      return json(200, shape(set, row, query));
    }
    if (method === 'GET' && options.pageSize && !query.$top) return json(200, page(set, query));
    if (method === 'GET') return json(200, { value: list(set, query).map((row) => shape(set, row, query)) });
    if (method === 'POST' && !key) {
      const row = insert(set, body || {});
      joinSolution(set, row, headerOf(headers, 'MSCRM.SolutionUniqueName'));
      const prefer = headerOf(headers, 'Prefer') || '';
      const entityId = `${origin}/api/data/v9.2/${set}(${row[SETS[set].pk]})`;
      if (/return=representation/.test(prefer)) return json(201, representation(set, row, query, apiBase, true), { 'odata-entityid': entityId, etag: etagOf(row) });
      return { statusCode: 204, headers: { 'odata-entityid': entityId, 'odata-version': '4.0' }, body: '' };
    }
    if (method === 'PATCH' && key) {
      const refused = update(set, key, body, headers);
      if (refused) return refused;
      const row = sets.get(set).get(normGuid(key));
      const prefer = headerOf(headers, 'Prefer') || '';
      if (/return=representation/.test(prefer)) return json(200, representation(set, row, query, apiBase, false), { etag: etagOf(row) });
      return { statusCode: 204, headers: { 'odata-version': '4.0', etag: etagOf(row) }, body: '' };
    }
    if (method === 'DELETE' && key) {
      const refused = remove(set, key, headers);
      return refused || { statusCode: 204, headers: { 'odata-version': '4.0' }, body: '' };
    }
    throw new Unmodelled('the method');
  }

  async function guarded(method, where, body, headers, apiBase) {
    try {
      return await dispatch(method, where, body, headers, apiBase);
    } catch (error) {
      if (error instanceof Unmodelled) throw error;
      if (error && error.status) return failure(error.status, error.code || '0x80040203', error.message);
      throw error;
    }
  }

  // `$batch`: one change set, applied atomically — on the first failing operation every change of the set is rolled back and only
  // that operation's status is answered.
  // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/execute-batch-operations-using-web-api#change-sets
  async function batch(text, apiBase) {
    const operations = parseBatch(String(text));
    const saved = new Map([...sets].map(([k, v]) => [k, structuredClone(v)]));
    const statuses = [];
    for (const op of operations) {
      // eslint-disable-next-line no-await-in-loop
      const res = await guarded(op.method, op.path, op.body, op.headers, op.apiBase || apiBase);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        for (const [k, v] of saved) sets.set(k, v);
        return batchAnswer([{ contentId: op.contentId, status: res.statusCode, body: res.body }]);
      }
      statuses.push({ contentId: op.contentId, status: res.statusCode, headers: res.headers, body: res.body });
    }
    return batchAnswer(statuses);
  }

  // The parts of a `$batch` body as the SDK renders it (CRLF between lines; the boundary differs per request):
  //   --batch_<id>
  //   Content-Type: multipart/mixed;boundary=changeset_<id>
  //
  //   --changeset_<id>
  //   Content-Type: application/http
  //   Content-Transfer-Encoding: binary
  //   Content-ID: 1
  //
  //   PATCH https://contoso.crm.dynamics.com/api/data/v9.0/customapis(<id>) HTTP/1.1
  //   Content-Type: application/json;type=entry
  //   If-Match: W/"7"
  //
  //   {"displayname":"Calculate"}
  //   --changeset_<id>--
  //   --batch_<id>--
  // RFC 2046: the CRLF before a delimiter belongs to the delimiter, not to the body.
  function parseBatch(text) {
    const outer = (/^--(\S+)/.exec(text) || [])[1];
    const inner = (/Content-Type:\s*multipart\/mixed;\s*boundary=(\S+)/i.exec(text) || [])[1];
    const boundary = inner || outer;
    if (!boundary) throw new Unmodelled('a $batch body without a boundary');
    return text.split(`--${boundary}`).slice(1).filter((segment) => !segment.startsWith('--')).map((segment) => {
      const mimeEnd = segment.search(/\r?\n\r?\n/);
      const mime = segment.slice(0, mimeEnd);
      const http = segment.slice(mimeEnd).replace(/^\r?\n\r?\n/, '');
      const headEnd = http.search(/\r?\n\r?\n/);
      const head = (headEnd === -1 ? http : http.slice(0, headEnd)).split(/\r?\n/);
      const [, method, url] = /^(\w+) (\S+) HTTP\/1\.1$/.exec(head[0]) || [];
      if (!method) throw new Unmodelled(`a $batch part without a request line: ${JSON.stringify(head[0])}`);
      const headers = {};
      for (const line of head.slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0) headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
      }
      const payload = headEnd === -1 ? '' : http.slice(headEnd).replace(/^\r?\n\r?\n/, '').replace(/\r?\n$/, '');
      const parsed = new URL(url, origin);
      const where = decodeURIComponent(parsed.pathname + parsed.search).replace(API_ROOT, '');
      return { contentId: (/^Content-ID:\s*(\S+)/im.exec(mime) || [])[1], method, path: where, headers, body: payload ? JSON.parse(payload) : undefined, apiBase: apiBaseOf(parsed) };
    });
  }
  function batchAnswer(parts) {
    const outer = `batchresponse_${randomUUID()}`;
    const inner = `changesetresponse_${randomUUID()}`;
    const text = [
      `--${outer}`,
      `Content-Type: multipart/mixed; boundary=${inner}`,
      '',
      ...parts.map((part) => [
        `--${inner}`,
        'Content-Type: application/http',
        'Content-Transfer-Encoding: binary',
        `Content-ID: ${part.contentId}`,
        '',
        `HTTP/1.1 ${part.status} ${part.status < 300 ? (part.status === 204 ? 'No Content' : 'OK') : 'Bad Request'}`,
        ...Object.entries(part.headers || {}).filter(([k]) => /^(odata-entityid|location|etag)$/i.test(k)).map(([k, v]) => `${k === 'odata-entityid' ? 'OData-EntityId' : k}: ${v}`),
        'OData-Version: 4.0',
        // The CRLF before the next delimiter belongs to the delimiter (RFC 2046), so a body is one line and no blank
        // line follows it, as the service answers.
        ...(part.body ? ['Content-Type: application/json; odata.metadata=minimal', '', String(part.body)] : ['']),
      ].join('\r\n')),
      `--${inner}--`,
      `--${outer}--`,
      '',
    ].join('\r\n');
    return { statusCode: 200, headers: { 'content-type': `multipart/mixed; boundary=${outer}`, 'odata-version': '4.0' }, body: text };
  }

  // The transport: `request({ url, method, headers, body })` -> `{ statusCode, headers, body }`.
  async function request({ url, method, headers, body }) {
    const parsed = new URL(url);
    if (parsed.origin !== origin) throw new Error(`fake-config-org: a request to another origin: ${url}`);
    const where = decodeURIComponent(parsed.pathname + parsed.search).replace(API_ROOT, '');
    const type = headerOf(headers, 'content-type') || '';
    let parsedBody;
    if (body !== undefined && body !== null && body !== '') parsedBody = /json/i.test(type) || !type ? JSON.parse(String(body)) : String(body);
    const recorded = { method, path: where, body: parsedBody, headers };
    if (method === 'POST' && where === '/$batch') {
      try { recorded.operations = parseBatch(String(body)); } catch { /* the dispatch below names the failure */ }
    }
    requests.push(recorded);
    try {
      const answer = await guarded(method, where, parsedBody, headers, apiBaseOf(parsed));
      recorded.status = answer.statusCode;
      return answer;
    } catch (error) {
      unexpected.push(`${method} ${where}: ${error && error.message}`);
      recorded.status = 501;
      return failure(501, '0x80040265', `fake-config-org does not model ${method} ${where}: ${error && error.message}`);
    }
  }

  // Every request that changed something since `mark` (a `$batch` as its operations), as `METHOD /path`.
  function writes(since = 0) {
    return requests.slice(since).flatMap((r) => (r.operations ? r.operations : [r]))
      .filter((r) => r.method !== 'GET' && r.path !== '/$batch')
      .map((r) => `${r.method} ${r.path.replace(/\?.*$/, '')}`);
  }
  const rows = (set) => [...sets.get(set).values()];
  const table = (logical) => tables.get(lc(logical));

  return { origin, request, requests, unexpected, writes, rows, table, sets, solutionId, publisherId };
}

module.exports = { createConfigOrg, CONFIG_SETS: SETS };
