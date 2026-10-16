'use strict';
// The bundled SDK as every script makes it: the vendored bundle (vendor/cds-maker-sdk.cjs) with the vendored TypeScript compiler
// (lib/typescript-compiler.js) as its generative-page compiler.
//
// The SDK compiles a page's source itself whenever a push changes it, and without a compiler it refuses that push before
// writing anything (GENPAGE_COMPILER_UNAVAILABLE). Its bundle holds no TypeScript (the host passes one in through
// `MakerSdkOptions.typescript`), so every instance a script makes is given the vendored one here — lazily: it is unpacked and
// evaluated only when a page is compiled, so an instance that never compiles one pays nothing. Scripts require this module, never
// the bundle itself, so no instance can be made without it (tests/maker-sdk.test.js scans for a direct require). A caller can
// still pass its own `typescript` (a test's fake): an explicit option wins.
//
// `connectivity: true` is the one option this factory adds. The SDK's connection and connector reads (`listConnections`,
// `listConnectorOperations`, `getConnectorOperationSchema`) need an HttpClient that signs in to the Power Apps service
// (`powerAppsServiceClient`); a caller that asks for connectivity is given this plugin's (lib/power-apps-service-client.js), built
// here so that no script wires a credential-carrying client by hand. It is opt-in because the client's token comes from an extra Azure
// CLI call and only those reads use it: an instance made without it is exactly what it was, and the SDK then refuses those three
// reads before any request (`CONNECTIVITY_NOT_CONFIGURED`). A `powerAppsServiceClient` the caller names wins, as `typescript` does. This is the only
// client the factory gives: the SDK's reads through the Power Platform API (a Test org's, and a connector's tables) need a `powerPlatformApiClient`, and the
// tables a `connectorRuntimeClient` too, which an Azure CLI token cannot back (lib/sdk-first.js, "No Power Platform API client").
//
// The `httpClient` the caller names is handed to the SDK with one addition (lib/app-header-text.js): a PATCH of an app module row whose name or description is not a string — through `patch`, through
// `patchRaw`, or in a change set a caller sends raw (`dataverse.postBatch`) — is refused before it is sent. The SDK's push of an app writes the header from the workspace copy whenever its own comparison
// read of the header cannot be made, and the build never edits a header text that is not plain, so the request itself is the last place to stop one. Guarded here, once, so no script that makes an SDK
// can leave an app push unguarded (tests/maker-sdk.test.js pins that no script makes one another way); the refusal is an SdkError (APP_HEADER_NOT_PLAIN_TEXT), which the bundle rethrows as it is. No request
// is added or changed: only writes of that row are looked at, and every other member of the client runs on the client itself, so a client whose methods keep private state still works.
const bundle = require('../vendor/cds-maker-sdk.cjs');
const { loadVendoredTypeScript } = require('./typescript-compiler.js');
const { guardAppHeaderWrites } = require('./app-header-text.js');

// `create` given the vendored compiler unless the options name one, and — only for a caller that asked — the Power Apps service client
// (a seam for the test: the bundle's own exports are read-only). The `connectivity` request itself is the factory's, never the SDK's.
function withVendoredCompiler(create) {
  return (options) => {
    const { connectivity, ...forSdk } = options || {};
    const made = { typescript: () => loadVendoredTypeScript(), ...forSdk };
    if (made.httpClient) made.httpClient = guardAppHeaderWrites(made.httpClient, (code, message) => new bundle.SdkError(code, message));
    if (connectivity && made.powerAppsServiceClient === undefined) {
      // Required here, not at the top: the client pulls in the Azure CLI token code, which an instance that never reads connections does not need.
      const { createPowerAppsServiceClient } = require('./power-apps-service-client.js');
      made.powerAppsServiceClient = createPowerAppsServiceClient();
    }
    return create(made);
  };
}

module.exports = { ...bundle, createMakerSdk: withVendoredCompiler(bundle.createMakerSdk), withVendoredCompiler };
