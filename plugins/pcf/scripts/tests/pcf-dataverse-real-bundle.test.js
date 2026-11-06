'use strict';
// REAL BUNDLE: PCF Dataverse reads must traverse the shipped maker SDK, not only a hand-written
// mock. The SDK resolves logical names to entity-set names through metadata before queryRecords
// hits the wire, and `dataverse.get(relativePath)` is the supported escape hatch for bound
// functions the SDK has not modeled.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { findCustomControl, readFormXml, dependentsOf } = require('../lib/pcf-dataverse.js');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const dirs = [];

async function sdkWithCapture() {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-dv-'));
  dirs.push(dir);
  const reads = [];
  const httpClient = {
    get: async (url) => {
      reads.push(String(url));
      const text = String(url);
      if (/EntityDefinitions\(LogicalName='customcontrol'\)/i.test(text)) {
        return { status: 200, headers: {}, body: { EntitySetName: 'customcontrols', LogicalName: 'customcontrol' } };
      }
      if (/\/customcontrols\?/i.test(text)) {
        return {
          status: 200,
          headers: {},
          body: {
            value: [{
              customcontrolid: '11111111-1111-1111-1111-111111111111',
              name: "Contoso's Star",
              version: '1.0.0',
              componentstate: 0,
              ismanaged: false,
            }],
          },
        };
      }
      if (/RetrieveUnpublished/i.test(text)) {
        return { status: 200, headers: {}, body: { formxml: '<draft />' } };
      }
      if (/RetrieveDependentComponents/i.test(text)) {
        return { status: 200, headers: {}, body: { value: [{ dependentcomponenttype: 60, dependentcomponentobjectid: '22222222-2222-2222-2222-222222222222', dependencytype: 2 }] } };
      }
      return { status: 200, headers: {}, body: {} };
    },
    post: async () => ({ status: 204, headers: {}, body: {} }),
    patch: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: 'https://contoso.crm.dynamics.com', httpClient });
  await sdk.initWorkspace();
  return { sdk, reads };
}

test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test('REAL BUNDLE: PCF reads record customcontrol query and raw bound-function URLs', async () => {
  const { sdk, reads } = await sdkWithCapture();

  assert.equal((await findCustomControl(sdk, "Contoso's Star")).id, '11111111-1111-1111-1111-111111111111');
  assert.equal(await readFormXml(sdk, '22222222-2222-2222-2222-222222222222', { layer: 'draft' }), '<draft />');
  assert.deepEqual(await dependentsOf(sdk, '11111111-1111-1111-1111-111111111111'), {
    ok: true,
    rows: [{ type: 60, objectId: '22222222-2222-2222-2222-222222222222' }],
  });

  assert.ok(reads.includes("https://contoso.crm.dynamics.com/api/data/v9.0/EntityDefinitions(LogicalName='customcontrol')?$select=EntitySetName"));
  assert.ok(reads.includes("https://contoso.crm.dynamics.com/api/data/v9.0/customcontrols?$select=customcontrolid%2Cname%2Cversion%2Ccomponentstate%2Cismanaged&$filter=name%20eq%20'Contoso''s%20Star'&$top=2"));
  assert.ok(reads.includes('https://contoso.crm.dynamics.com/api/data/v9.0/systemforms(22222222-2222-2222-2222-222222222222)/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=formxml'));
  assert.ok(reads.includes('https://contoso.crm.dynamics.com/api/data/v9.0/RetrieveDependentComponents(ObjectId=@o,ComponentType=@t)?@o=11111111-1111-1111-1111-111111111111&@t=66'));
});
