'use strict';
// The bridge between the build command and the default build's configuration create writer (#807,
// lib/configuration-create-writer.js): the build's raw authenticated HttpClient and what the writer needs beside it, held for
// one SDK object.
//
// It is its own module, with no requires, because build-model-app.js makeSdk attaches it to EVERY build's SDK, while the
// writer and the stable-identity modules it rests on (configuration-create-plan/-state/-bindings, creates-port, creates-identity)
// must load only for an App Spec that declares configuration (lib/configuration-build.js createUnitsFor requires them lazily).
// tests/creates-port.test.js walks the default build's require graph and pins that.
//
// A WeakMap, so the bridge is reachable only through this module and never appears on the SDK object.

const BRIDGES = new WeakMap();
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Holds the build's authenticated HttpClient and API URL factory for `sdk` (the build's solution SDK).
 *   attachConfigurationCreateBridge(sdk, { httpClient, apiUrl, workspaceDir?, reader?, environmentUrl?, authoringLanguageCode?, sleep? })
 * `httpClient` is a createAzHttpClient client (post/get answer { status, headers, body } and throw on a transport failure);
 * `apiUrl(path)` answers the absolute Web API URL of a path such as '/customapis'. The rest is what the build's own runtime
 * needs beside them, handed over separately from the temporary solution SDK: `workspaceDir` the durable app workspace the
 * receipt lives in, `reader` the header-less provision SDK the proof reads go through, `environmentUrl` and
 * `authoringLanguageCode` the receipt's context (lib/configuration-create-state.js createStateContext). `sleep(ms)` replaces the
 * wait between the reads that prove a new rule published (a test's clock; a build passes none and waits for real).
 */
function attachConfigurationCreateBridge(sdk, { httpClient, apiUrl, workspaceDir, reader, environmentUrl, authoringLanguageCode, sleep } = {}) {
  if (!sdk || typeof sdk !== 'object') throw new TypeError('attachConfigurationCreateBridge: sdk must be an object');
  if (!httpClient || typeof httpClient.post !== 'function') throw new TypeError('attachConfigurationCreateBridge: httpClient.post is required');
  if (typeof apiUrl !== 'function') throw new TypeError('attachConfigurationCreateBridge: apiUrl is required');
  BRIDGES.set(sdk, Object.freeze({
    httpClient,
    apiUrl,
    workspaceDir: nonEmpty(workspaceDir) ? workspaceDir : null,
    reader: reader || null,
    environmentUrl: nonEmpty(environmentUrl) ? environmentUrl : null,
    authoringLanguageCode: Number.isSafeInteger(authoringLanguageCode) ? authoringLanguageCode : null,
    sleep: typeof sleep === 'function' ? sleep : null,
  }));
}

/** The bridge attached to `sdk`, or null. */
function configurationCreateBridgeOf(sdk) {
  return sdk && typeof sdk === 'object' ? BRIDGES.get(sdk) || null : null;
}

module.exports = { attachConfigurationCreateBridge, configurationCreateBridgeOf };
