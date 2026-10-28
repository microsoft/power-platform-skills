'use strict';
// The RuntimeTypes text the bundled SDK generates for a page, as `genpage.js types` writes it, made offline: the SDK reads each table's metadata through
// its own `fetchEntityMetadata`, which is replaced here by the answer it would build for a table with an id and a name column, so the generator itself
// runs and nothing is sent. What the types say of a page — its `PageInput`, its `UxAgentDataApi` — is then the SDK's own, not a copy of it.
const { makeTempDir } = require('./temp-dirs.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../../lib/maker-sdk.js');

async function generatedRuntimeTypes(tables = ['contoso_item'], { prefix = 'runtime-types-' } = {}) {
  const sdk = createMakerSdk({
    workspaceStorage: createNodeWorkspaceStorage(makeTempDir(prefix)),
    instanceUrl: 'https://contoso.crm.dynamics.com',
    httpClient: { get: async () => ({ status: 404, headers: {}, body: null }), post: async () => ({ status: 404, headers: {}, body: null }) },
  });
  sdk.fetchEntityMetadata = async (logical) => ({
    logicalName: logical, entitySetName: `${logical}s`, primaryIdAttribute: `${logical}id`, primaryNameAttribute: 'contoso_name', displayName: 'Item',
    attributes: [{ logicalName: `${logical}id`, attributeType: 'Uniqueidentifier', isPrimaryId: true }, { logicalName: 'contoso_name', attributeType: 'String', isPrimaryName: true, maxLength: 100 }],
    relationships: [], columnDetailComplete: true,
  });
  return sdk.generateGenPageRuntimeTypes(tables);
}

module.exports = { generatedRuntimeTypes };
