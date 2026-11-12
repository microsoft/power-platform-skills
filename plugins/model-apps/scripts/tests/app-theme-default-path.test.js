'use strict';
// The default engine never reaches the app theme code: loading the build, verify, download and teardown entry points
// loads neither theme module, and a build of a spec with no `app.theme` (fresh create and existing app) calls no theme
// method on the SDK and sends no theme request. Its own file, so require.cache holds only what these entry points load.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib');
const themeModules = () => Object.keys(require.cache).filter((file) => /[\\/]lib[\\/]app-theme(-reads)?\.js$/.test(file));

const { inOwnFolder } = require('./helpers/own-app-folder.js');
const { runSdkBuild: runSdkBuildInPlace } = require(path.join(LIB, 'sdk-build.js'));
const runSdkBuild = inOwnFolder(runSdkBuildInPlace);
const { membershipSpec, membershipSdk } = require('./helpers/app-membership-sdk.js');

test('loading the default build, verify, download and teardown entry points loads no theme module', () => {
  require(path.join(LIB, 'maker-sdk.js'));
  require(path.join(LIB, 'sdk-teardown.js'));
  require(path.join(__dirname, '..', 'verify-model-app.js'));
  require(path.join(__dirname, '..', 'download-model-app.js'));
  assert.deepEqual(themeModules(), []);
});

// Every theme method the SDK has; a call to any of them from a build of a spec without `app.theme` is a leak.
const THEME_METHODS = new Set(['getAppTheme', 'setAppTheme', 'getEnvironmentTheme', 'setEnvironmentTheme']);
function watched(sdk) {
  const calls = [];
  const proxy = new Proxy(sdk, {
    get(target, name, receiver) {
      if (THEME_METHODS.has(name)) calls.push(name);
      return Reflect.get(target, name, receiver);
    },
  });
  return { proxy, calls };
}

for (const existing of [false, true]) {
  test(`a build of a spec with no app.theme makes no theme call and no theme request (existing=${existing})`, async () => {
    const fake = membershipSdk({ existing });
    const { proxy, calls } = watched(fake.sdk);
    const spec = membershipSpec();
    assert.equal(spec.app.theme, undefined);
    await runSdkBuild(spec, { sdk: proxy, apply: true, phases: ['app-shell', 'publish'], publish: true });
    assert.deepEqual(calls, []);
    const themeRequests = fake.events.filter(([, url]) => typeof url === 'string' && /RetrieveSetting|appsettings|settingdefinitions|apptheme/i.test(url));
    assert.deepEqual(themeRequests, []);
    assert.deepEqual(themeModules(), []);
  });
}
