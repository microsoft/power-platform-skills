'use strict';

const fs = require('node:fs');

const { createAzHttpClient } = require('./sdk-http-client.js');
const { odataLit } = require('./odata.js');

const CUSTOM_CONTROL_SELECT = ['customcontrolid', 'name', 'version', 'componentstate', 'ismanaged'];
const FORM_SELECT = ['formid', 'name', 'type'];
const SOLUTION_SELECT = ['solutionid', '_publisherid_value', 'ismanaged'];
const PUBLISHER_SELECT = ['publisherid', 'customizationprefix'];
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Where-used is the registered solution dependency graph only. It is not proof of Liquid or text
// references, so an empty result is never a "safe to delete" verdict for a PCF control.
const WHERE_USED_CAVEAT = "registered solution dependencies only — not proof of Liquid or text references; an empty result is not 'safe to delete'";

async function makePcfSdk(env, workspaceDir, httpClient = createAzHttpClient(env)) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(workspaceDir), instanceUrl: env, httpClient });
  await sdk.initWorkspace();
  return sdk;
}

async function findCustomControl(sdk, name) {
  const rows = await sdk.queryRecords('customcontrol', {
    select: CUSTOM_CONTROL_SELECT,
    filter: `name eq '${odataLit(name)}'`,
    top: 2,
  });
  if (!rows || rows.length === 0) return null;
  if (rows.length > 1) throw new Error(`More than one custom control named '${name}' was found`);
  return customControlRow(rows[0]);
}

async function listCustomControls(sdk, opts = {}) {
  const options = {
    select: CUSTOM_CONTROL_SELECT,
    paginate: true,
  };
  if (!opts.includeManaged) options.filter = 'ismanaged eq false';
  const rows = await sdk.queryRecords('customcontrol', options);
  return (rows || []).map(customControlRow);
}

function customControlRow(row) {
  // SDK queryRecords('customcontrol') returns projected Dataverse rows shaped like:
  // { customcontrolid, name, version, componentstate, ismanaged }.
  return {
    id: row && row.customcontrolid,
    name: row && row.name,
    version: row && row.version,
    componentState: row && row.componentstate,
    isManaged: row && row.ismanaged,
  };
}

async function findForm(sdk, { table, form, types = [2, 7] }) {
  const typeList = (types || []).map((t) => Number(t)).filter((t) => Number.isFinite(t));
  const clauses = [
    `objecttypecode eq '${odataLit(table)}'`,
    typeList.length ? `type in (${typeList.join(',')})` : null,
    isGuid(form) ? `formid eq ${form}` : `name eq '${odataLit(form)}'`,
  ].filter(Boolean);
  const rows = await sdk.queryRecords('systemform', {
    select: FORM_SELECT,
    filter: clauses.join(' and '),
    paginate: true,
  });
  if (!rows || rows.length === 0) throw new Error(`No form matched '${form}' on table '${table}'`);
  if (rows.length > 1) {
    const candidates = rows.map((r) => `${r.name || '(unnamed)'} (${r.formid || 'no id'}, type ${r.type == null ? 'unknown' : r.type})`).join('; ');
    throw new Error(`Several forms matched '${form}' on table '${table}': ${candidates}`);
  }
  // SDK queryRecords('systemform') returns projected Dataverse rows shaped like:
  // { formid, name, type }.
  const row = rows[0];
  return { formid: row.formid, name: row.name, type: row.type };
}

async function readFormXml(sdk, formId, opts = {}) {
  const layer = opts.layer || 'published';
  if (layer !== 'draft' && layer !== 'published') throw new Error(`Unsupported FormXML layer '${layer}'`);
  // The SDK has no layer-selecting RetrieveUnpublished form read: a plain systemform GET returns
  // the published layer, while draft reads need the RetrieveUnpublished bound function. Retire this
  // raw read when the SDK adds a form-layer reader that models both draft and published FormXML.
  const path = layer === 'draft'
    ? `/systemforms(${formId})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=formxml`
    : `/systemforms(${formId})?$select=formxml`;
  const res = await sdk.dataverse.get(path);
  if (!isSuccess(res)) throw new Error(`FormXML for ${formId} (${layer}) could not be read (HTTP ${res && res.status})`);
  // sdk.dataverse.get for both form reads returns:
  // { status: 200, body: { formxml: '<form>...</form>', '@odata.etag'?: 'W/"..."' } }.
  const xml = res && res.body && res.body.formxml;
  if (typeof xml !== 'string') throw new Error(`FormXML for ${formId} (${layer}) was missing from the response`);
  return xml;
}

async function dependentsOf(sdk, customControlId) {
  const path = `/RetrieveDependentComponents(ObjectId=@o,ComponentType=@t)?@o=${customControlId}&@t=66`;
  try {
    // The SDK has no RetrieveDependentComponents method for solution dependency reads. Retire this
    // raw read when the SDK adds one so PCF where-used can use the modeled surface.
    const res = await sdk.dataverse.get(path);
    if (!isSuccess(res)) return { ok: false, reason: responseReason(res) };
    // RetrieveDependentComponents returns `dependency` entities, for example:
    // { value: [{ dependentcomponenttype: 60, dependentcomponentobjectid: '<systemformid>',
    //             requiredcomponenttype: 66, requiredcomponentobjectid: '<customcontrolid>' }] }.
    // See: https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/dependency
    // Older tests used ComponentType/ObjectId, so those aliases remain as a compatibility fallback
    // for any SDK/proxy that projects the response with legacy casing.
    return {
      ok: true,
      rows: (((res && res.body && res.body.value) || []).map((r) => ({
        type: firstDefined(r.dependentcomponenttype, r.ComponentType, r.componentType),
        objectId: firstDefined(r.dependentcomponentobjectid, r.ObjectId, r.objectId),
      }))).filter((r) => r.type != null || r.objectId),
    };
  } catch (err) {
    return { ok: false, reason: errorReason(err) };
  }

  function firstDefined(...values) {
    return values.find((value) => value !== undefined && value !== null);
  }
}

async function formsContainingControl(sdk, name) {
  try {
    const rows = await sdk.queryRecords('systemform', {
      select: ['formid', 'name'],
      filter: `contains(formxml,'${odataLit(name)}')`,
      paginate: true,
    });
    // The fallback query returns projected rows shaped like:
    // { formid: '<guid>', name: 'Main form name' }.
    return {
      ok: true,
      rows: (rows || []).map((r) => ({ formid: r.formid, name: r.name })),
    };
  } catch (err) {
    return { ok: false, reason: errorReason(err) };
  }
}

async function solutionPrefix(sdk, uniqueName) {
  const solutions = await sdk.queryRecords('solution', {
    select: SOLUTION_SELECT,
    filter: `uniquename eq '${odataLit(uniqueName)}'`,
    top: 2,
  });
  if (!solutions || solutions.length === 0) throw new Error(`Solution '${uniqueName}' was not found`);
  if (solutions.length > 1) throw new Error(`More than one solution matched '${uniqueName}'`);
  const solution = solutions[0];
  // SDK queryRecords('solution') returns projected rows shaped like:
  // { solutionid, _publisherid_value, ismanaged }.
  if (solution.ismanaged) throw new Error(`Solution '${uniqueName}' is a managed solution; choose an unmanaged solution`);
  const publisherId = solution._publisherid_value;
  if (!publisherId) throw new Error(`Solution '${uniqueName}' does not include a publisher lookup`);

  const publishers = await sdk.queryRecords('publisher', {
    select: PUBLISHER_SELECT,
    filter: `publisherid eq ${publisherId}`,
    top: 1,
  });
  const publisher = publishers && publishers[0];
  // SDK queryRecords('publisher') returns projected rows shaped like:
  // { publisherid, customizationprefix }.
  if (!publisher || !publisher.customizationprefix) throw new Error(`The publisher for solution '${uniqueName}' could not be resolved`);
  return publisher.customizationprefix;
}

function isGuid(value) {
  return GUID_RE.test(String(value || ''));
}

function isSuccess(res) {
  return !!res && res.status >= 200 && res.status < 300;
}

function responseReason(res) {
  const status = res && res.status;
  const body = res && res.body;
  // Dataverse errors usually arrive as { error: { message } }; some surfaces preserve the
  // capitalized envelope { Error: { message } }, and local fakes may return { message } directly.
  const message = body && (body.error && body.error.message || body.Error && body.Error.message || body.message);
  return message ? `HTTP ${status}: ${String(message).slice(0, 200)}` : `HTTP ${status}`;
}

function errorReason(err) {
  return (err && err.message) ? String(err.message).slice(0, 200) : 'read failed';
}

module.exports = {
  WHERE_USED_CAVEAT,
  makePcfSdk,
  findCustomControl,
  listCustomControls,
  findForm,
  readFormXml,
  dependentsOf,
  formsContainingControl,
  solutionPrefix,
};
