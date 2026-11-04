'use strict';
// Shared fixtures for the configuration row families of the managed binding store (lib/managed-bindings.js
// `rowProtocol`), its request boundary (lib/managed-create-transport.js) and its lifecycle (lib/managed-create-context.js):
// one Custom API with one request parameter, every id a fixed GUID, every hash a fixed digit run.
const { openManagedBindings } = require('../../lib/managed-bindings.js');
const { environmentFingerprint } = require('../../lib/page-ownership-records.js');
const { apiPath } = require('../../lib/workflow-effect-context.js');

const ENV = 'https://contoso.crm.dynamics.com';
const APP = 'contoso_app';
const SOL = 'contoso_solution';
const FP = environmentFingerprint(ENV);
const H = (c) => c.repeat(64);
const API = '11111111-1111-4111-8111-111111111111';
const REQ = '22222222-2222-4222-8222-222222222222';
const FORM = '33333333-3333-4333-8333-333333333333';
const API_KEY = 'contoso_api';
const REQ_KEY = JSON.stringify([API_KEY, 'request:p']);

const open = (dir) => openManagedBindings({ workspaceDir: dir, environment: ENV, appUniqueName: APP, solutionUniqueName: SOL });
const rec = (kind, key, id, over = {}) => ({ formatVersion: 1, appUniqueName: APP, environmentFingerprint: FP, kind, key, id, intentSha256: H('a'), origin: 'created', ...over });
const PROOF = { savedSha256: H('1'), semanticSha256: H('2'), preservationSha256: H('3'), expectedChildrenSha256: H('4') };
const codeOf = (fn) => { try { fn(); } catch (e) { return e.code || e.name; } return null; };

const protocolRow = (kind, key, id, parentId) => ({ kind, key, id, parentId, mode: 'create', expectedSha256: H('9'), sensitiveInput: false, sentFields: null, sentSha256: null, dispatched: false });

/** A store prepare plan (prepareAttemptSet) for one Custom API and its request parameter. */
function apiPlan({ key = API_KEY, api = API, req = REQ, reqKey = JSON.stringify([key, 'request:p']) } = {}) {
  return {
    family: 'customApi', key, baseGeneration: null, root: { kind: 'customApi', key, id: api }, declarationSha256: H('e'),
    rowProtocol: {
      version: 1, rows: [protocolRow('customApi', key, api, null), protocolRow('customApiRequestParameter', reqKey, req, api)], preserved: [],
      completion: { ruleState: null, members: [{ kind: 'customApi', id: api, componentType: 10134 }, { kind: 'customApiRequestParameter', id: req, componentType: 10135 }] },
      effects: [{ kind: 'membership', id: api, dispatched: false }, { kind: 'membership', id: req, dispatched: false }], cohort: null,
    },
  };
}

/** The expected proof (markAttemptSetSending) of apiPlan. */
function apiExpected({ key = API_KEY, api = API, req = REQ, reqKey = JSON.stringify([key, 'request:p']) } = {}) {
  return {
    proofVersion: 1, proofSchema: 'configuration-rows-v1', rootId: api, baseProofSha256: null, sentProjectionSha256: H('b'), preservationSha256: H('c'), baseObservation: null,
    children: [{ kind: 'customApiRequestParameter', key: reqKey, namespaceParentId: api, id: req, associationSha256: H('d') }],
  };
}

/** The consumer state (commitGroupSet) of apiPlan. */
function apiConsumer({ key = API_KEY, api = API, req = REQ, reqKey = JSON.stringify([key, 'request:p']) } = {}) {
  return {
    version: 1, rows: [
      { kind: 'customApi', key, id: api, parentId: null, projectionSha256: H('5'), sensitiveInput: false },
      { kind: 'customApiRequestParameter', key: reqKey, id: req, parentId: api, projectionSha256: H('6'), sensitiveInput: false }],
  };
}

/** Commit one form group through the version-1 path, so a store holds an old family's group. */
function settleForm(store) {
  const scope = { type: 'table', table: 'account' };
  const token = store.prepareAttempt({ family: 'form', key: 'account/main', baseGeneration: null, root: { kind: 'form', key: 'account/main', id: FORM }, knownScopes: [scope], declarationSha256: H('e'), publication: { scope, state: 'owed' } });
  store.markSending(token, { proofVersion: 1, proofSchema: 'form-v1', rootId: FORM, baseProofSha256: null, sentProjectionSha256: H('b'), preservationSha256: H('c'), baseObservation: null, children: [] });
  store.noteSaved(token, { proof: { savedSha256: H('1') }, acknowledgedRoot: true });
  return store.commitGroup({ token, baseGeneration: null, records: [rec('form', 'account/main', FORM)], proof: PROOF, consumerState: { declaration: { name: 'Main' }, children: {}, proofSchema: 'form-v1' }, publication: { scope, state: 'owed', desiredSha256: H('5'), dispatchToken: null } });
}

const URL_API = `${ENV}/api/data/v9.2/customapis`;
const URL_MEMBER = `${ENV}/api/data/v9.2/AddSolutionComponent`;

/** The deep insert of one Custom API and its one request parameter (the parameter names its parent as `parent`). */
const apiBody = (api = API, req = REQ, parent = api) => ({ uniquename: API_KEY, customapiid: api, CustomAPIRequestParameters: [{ uniquename: 'p', customapirequestparameterid: req, parent }] });

/**
 * A test driver's classifier for `token`: the Custom API deep insert is the root and its one parameter, an
 * AddSolutionComponent is a membership effect, and anything else is not the set's (null).
 */
function apiClassifier(token) {
  // Loaded here, not at the top: the store's own tests use these fixtures without the request boundary.
  const { sentProjection } = require('../../lib/managed-create-transport.js');
  return ({ method, url, body }) => {
    const p = apiPath(url);
    if (method === 'POST' && p === 'customapis') {
      const b = JSON.parse(body);
      const c = b.CustomAPIRequestParameters[0];
      return {
        type: 'rows', token, rows: [
          { kind: 'customApi', key: b.uniquename, id: b.customapiid, parentId: null, ...sentProjection({ uniquename: b.uniquename, customapiid: b.customapiid }) },
          { kind: 'customApiRequestParameter', key: JSON.stringify([b.uniquename, `request:${c.uniquename}`]), id: c.customapirequestparameterid, parentId: c.parent, ...sentProjection({ uniquename: c.uniquename }) },
        ],
      };
    }
    if (method === 'POST' && p === 'AddSolutionComponent') return { type: 'effect', token, kind: 'membership', id: JSON.parse(body).ComponentId };
    return null;
  };
}

module.exports = { ENV, APP, SOL, FP, H, API, REQ, FORM, API_KEY, REQ_KEY, PROOF, URL_API, URL_MEMBER, open, rec, codeOf, apiPlan, apiExpected, apiConsumer, settleForm, apiBody, apiClassifier };
