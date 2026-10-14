'use strict';
// Shared REAL-BUNDLE harness for the form-layout tests that need the SDK's own serializer and fetch:
// the vendored SDK against a stub HTTP client that stores ONE systemform row. A form "exists" once it has
// formxml (the fixture's, or one the engine created), so the same harness serves a create and a rebuild.
//
// The stub answers only what a `forms`-phase build and `--verify` read; anything else fails the test, so a
// new request a change introduces shows up here instead of being silently absorbed.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../../vendor/cds-maker-sdk.cjs');
const { verifySpec } = require('../../lib/verify-spec.js');
const { readerFor } = require('../../verify-model-app.js');

const guid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const clone = (v) => JSON.parse(JSON.stringify(v));
const NOTES_CLASS_ID = '06375649-C143-495E-A496-C962E5B4488E';
const SUBGRID_CLASS_ID = 'E7A81278-8635-4D9E-8D4D-59480B391C5B';
const VIEW_ID = guid(7777);
const DEFAULT_ATTRIBUTES = { new_name: 'String', new_code: 'String', new_notes: 'Memo', new_area: 'String', new_extra: 'String' };

function createHarness({ formId = guid(1), entity = 'new_ticket', formName = 'Main', attributes = DEFAULT_ATTRIBUTES } = {}) {
  const dirs = [];
  const store = { row: { formid: formId, name: formName, objecttypecode: entity, type: 2, isdefault: true } };
  const writes = [];
  const reads = [];
  let revision = 1;
  const response = (body, status = 200) => ({ status, headers: { etag: `W/"${revision}"` }, body });
  const httpClient = {
    get: async (url) => {
      reads.push(url);
      const decoded = decodeURIComponent(url);
      if (decoded.includes(`EntityDefinitions(LogicalName='${entity}')`)) {
        return response({ LogicalName: entity, EntitySetName: `${entity}s`,
          Attributes: Object.entries(attributes).map(([LogicalName, AttributeType]) => ({ LogicalName, AttributeType })) });
      }
      if (/EntityDefinitions\(LogicalName='systemform'\)/.test(decoded)) return response({ EntitySetName: 'systemforms' });
      if (/systemforms\(/i.test(url)) {
        assert.ok(store.row.formxml, 'a fetch reads a form that has been serialized');
        return response(clone(store.row));
      }
      if (/\/systemforms(?:\?|$)/i.test(url)) return response({ value: store.row.formxml ? [clone(store.row)] : [] });
      assert.fail(`unexpected GET: ${url}`);
    },
    post: async (url, body) => {
      writes.push({ method: 'post', url, body: clone(body) });
      if (/\/systemforms(?:\?|$)/i.test(url)) {
        store.row = { ...store.row, ...body, formid: formId };
        return { ...response({}, 204), headers: { 'odata-entityid': `https://contoso.crm.dynamics.com/api/data/v9.2/systemforms(${formId})` } };
      }
      if (/\/(?:PublishXml|AddSolutionComponent)(?:\?|$)/.test(url)) return response({}, 204);
      assert.fail(`unexpected POST: ${url}`);
    },
    patch: async (url, body) => {
      assert.match(url, /\/systemforms\(/i);
      writes.push({ method: 'patch', url, body: clone(body) });
      store.row = { ...store.row, ...body };
      revision += 1;
      return response({}, 204);
    },
    put: async (url) => assert.fail(`unexpected PUT: ${url}`),
    delete: async (url) => assert.fail(`unexpected DELETE: ${url}`),
  };
  // A new SDK over a new workspace: a second apply must not lean on the first one's local copy.
  const freshSdk = async (workspaceDir) => {
    const dir = workspaceDir || fs.mkdtempSync(path.join(os.tmpdir(), 'form-layout-rt-'));
    if (!workspaceDir) dirs.push(dir);
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir),
      instanceUrl: 'https://contoso.crm.dynamics.com', httpClient });
    await sdk.initWorkspace();
    const mutations = [];
    // These wrappers record calls and delegate every one to the real bundle.
    for (const method of ['createArtifact', 'addElement', 'updateElement', 'moveElement', 'removeElement', 'updateRecord', 'setFormSecurityRoles']) {
      const original = sdk[method].bind(sdk);
      sdk[method] = async (...args) => {
        mutations.push({ method, args: clone(args) });
        return original(...args);
      };
    }
    // A sub-grid embeds the id of its child table's view, which the build looks up with a query of its own (the
    // table's default public view); the stub answers it with one view and delegates every other query.
    const queryRecords = sdk.queryRecords.bind(sdk);
    sdk.queryRecords = async (set, options) => (set === 'savedquery' ? [{ savedqueryid: VIEW_ID, isdefault: true }] : queryRecords(set, options));
    return { sdk, mutations, dir };
  };
  const cleanup = () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
  return { store, writes, reads, freshSdk, cleanup, formId, entity, attributes };
}

// Put a form on the server the way the engine's create does — a minimal artifact, each compiled tab added
// whole, the seed tab dropped, one push — from the given tabs. Returns the server's form id.
async function seedForm(h, tabs, { name = 'Main', entity = h.entity } = {}) {
  const seed = await h.freshSdk();
  const art = await seed.sdk.createArtifact('form', { name, entityLogicalName: entity, formType: 'Main' });
  for (const tab of tabs) await seed.sdk.addElement('form', art.id, '/tabs', tab);
  await seed.sdk.removeElement('form', art.id, '/tabs/0');
  const pushed = await seed.sdk.pushArtifact('form', art.id);
  assert.ok(pushed && pushed.saved !== false, `the fixture form is pushed: ${JSON.stringify(pushed && pushed.error)}`);
  return h.formId;
}

// `--verify` over what the server holds, through the plugin's own reader (the published formxml query).
async function verifyForms(h, spec) {
  const fetched = await h.freshSdk();
  const live = readerFor(fetched.sdk, spec.app.uniqueName);
  const read = {
    findTable: async () => ({ logicalName: h.entity }),
    findColumns: async () => Object.keys(h.attributes).map((logicalName) => ({ logicalName })),
    sitemapXml: async () => '',
    queryRecords: live.queryRecords,
    formTopology: live.formTopology,
  };
  return verifySpec(spec, read);
}

// The FormXML of the section `name`.
function sectionXml(formxml, name) {
  const at = formxml.indexOf(`name="${name}"`);
  assert.ok(at > 0, `section ${name} is in the formxml`);
  const start = formxml.lastIndexOf('<section', at);
  const end = formxml.indexOf('</section>', at) + '</section>'.length;
  return formxml.slice(start, end);
}

// A run of empty rows written as a count — `<row />×22` — so a test can state the exact shape of a
// timeline host without a 22-row literal.
const collapseEmptyRows = (xml) => String(xml).replace(/(?:<row \/>)+/g, (run) => `<row />×${run.length / '<row />'.length}`);

module.exports = { guid, clone, createHarness, seedForm, verifyForms, sectionXml, collapseEmptyRows, NOTES_CLASS_ID, SUBGRID_CLASS_ID, VIEW_ID, DEFAULT_ATTRIBUTES };
