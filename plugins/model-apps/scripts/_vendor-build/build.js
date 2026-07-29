/* Dev-only bundler: @maker-studio/cds-maker-sdk -> self-contained CJS the plugin vendors.
 * Run: node plugins/model-apps/scripts/_vendor-build/build.js --sdk <path-to-ppux>
 *      or set POWER_PLATFORM_UX_SDK_ROOT=<path-to-ppux>
 * Not shipped. Re-run only when the SDK source changes. */
const path = require('node:path');
const fs = require('node:fs');

const argSdk = (() => {
  const i = process.argv.indexOf('--sdk');
  if (i > -1) return process.argv[i + 1];
  return process.env.POWER_PLATFORM_UX_SDK_ROOT;
})();
if (!argSdk) {
  console.error('Usage: node plugins/model-apps/scripts/_vendor-build/build.js --sdk <path-to-ppux>');
  console.error('   or: set POWER_PLATFORM_UX_SDK_ROOT=<path-to-ppux>');
  process.exit(2);
}
const SDK_ENTRY = path.join(argSdk, 'packages/cds-maker-sdk/lib/index.js');
const OUTFILE = path.resolve(__dirname, '../vendor/cds-maker-sdk.cjs');
const esbuild = require('esbuild');

if (!fs.existsSync(SDK_ENTRY)) {
  console.error('SDK entry not found:', SDK_ENTRY);
  process.exit(2);
}

// Transitive deps that are pulled in by the cds-* designer packages (which the headless SDK DOES
// use for form/app/command serialization) but that are themselves pure UI / routing / telemetry /
// localization infra never executed on our headless serialize/push path. They read browser globals
// at import, bloat the bundle by ~10x, and (via shell-icm-info / shell-telemetry) embed an internal
// team→owner-email + VSTS-work-item ownership table that must not ship in a public repo. Stub them
// to chainable no-ops (same mechanism the shell-auth stub always used). The cds-* designer packages,
// powerapps-apis, power-platform-environment, graphql, lodash, axios, uuid, crypto-js and xmldom are
// deliberately NOT stubbed — the headless path genuinely uses them.
const STUB_PACKAGES = [
  '@maker-studio/shell-authentication', '@maker-studio/authentication',
  '@maker-studio/powerapps-ui-common', '@maker-studio/shell-telemetry',
  '@maker-studio/shell-icm-info', '@maker-studio/shell-localization',
  '@maker-studio/shell-embedding', '@maker-studio/shell-persistent-storage',
  '@maker-studio/shell-storage', '@maker-studio/ppux-telemetry-api',
  '@tanstack/react-query', '@tanstack/query-core', '@skype/ecsclient',
  'react', 'react-dom', 'react-is', 'react-fast-compare', 'react-helmet',
  'react-router', 'react-router-dom', 'react-side-effect', 'prop-types',
  'i18next', 'react-i18next',
];
const STUB_RE = new RegExp(
  '^(' + STUB_PACKAGES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(/|$)'
);
const stubPlugin = {
  name: 'stub-shell-auth',
  setup(build) {
    build.onResolve({ filter: STUB_RE }, (a) => ({ path: a.path, namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      // A chainable no-op that satisfies EVERY import interop esbuild emits for a stubbed module:
      //   const x = require('pkg'); x.foo; x(); new x();            (CJS require + property access)
      //   import x from 'pkg'; new x.default();                     (esbuild __toESM default interop)
      //   import { named } from 'pkg';                              (esbuild __copyProps named interop)
      // `chain` is a callable+constructable Proxy that returns itself for any property. The module's
      // export is a *function* whose [[Prototype]] is `chain`, so (a) it is itself callable/
      // constructable and (b) any property access — including on __toESM's prototype-inheriting
      // target — resolves through `chain`. `.default` (= the module export) stays constructable, so
      // `new x.default()` no longer throws "not a constructor".
      contents: `
        var chain = new Proxy(function () { return chain; }, {
          get: function (_t, k) { if (k === '__esModule') return false; if (k === Symbol.toPrimitive) return function () { return ''; }; return chain; },
          apply: function () { return chain; },
          construct: function () { return {}; }
        });
        var mod = function () { return chain; };
        Object.setPrototypeOf(mod, chain);
        module.exports = mod;
      `,
      loader: 'js',
    }));
  },
};

esbuild
  .build({
    entryPoints: [SDK_ENTRY],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    outfile: OUTFILE,
    logLevel: 'info',
    minify: true,
    // The bundle is entirely Microsoft's cds-maker-sdk + its designer packages; esbuild's extracted
    // legal comments were 100% redundant Microsoft copyright headers (no third-party notices — the
    // bundled OSS deps ship pre-stripped), so we drop the sidecar and carry a single copyright banner
    // (below) instead. NOTE: bundled third-party OSS (lodash/axios/uuid/crypto-js/graphql/xmldom) still
    // warrants a THIRD-PARTY-NOTICES file for a public release — an OSS-review follow-up, not captured here.
    legalComments: 'none',
    plugins: process.env.NOSTUB ? [] : [stubPlugin],
    banner: {
      // Copyright banner (kept verbatim through minify) + a headless browser-global shim for the
      // transitive shell-* deps that touch `window` at import (e.g. shell-telemetry's ErrorHandler).
      // The SDK's own xmldom DOM shim (installDomShim) handles DOMParser/XMLSerializer separately.
      js: `/*!
 * Copyright (C) Microsoft Corporation. All rights reserved.
 * Vendored, headless build of @maker-studio/cds-maker-sdk. Generated — do not edit by hand;
 * rebuild via scripts/_vendor-build/build.js.
 */
(function(){
        var noop=function(){};
        if(typeof globalThis.window==="undefined"){
          globalThis.window={
            addEventListener:noop,removeEventListener:noop,dispatchEvent:noop,
            location:{href:"https://localhost/",origin:"https://localhost",protocol:"https:",host:"localhost",hostname:"localhost",pathname:"/",search:"",hash:""},
            navigator:{userAgent:"node",language:"en-US",languages:["en-US"]},
            localStorage:{getItem:function(){return null;},setItem:noop,removeItem:noop,clear:noop,key:function(){return null;},length:0},
            sessionStorage:{getItem:function(){return null;},setItem:noop,removeItem:noop,clear:noop,key:function(){return null;},length:0},
            matchMedia:function(){return {matches:false,addEventListener:noop,removeEventListener:noop,addListener:noop,removeListener:noop};},
            requestAnimationFrame:function(cb){return setTimeout(cb,0);},cancelAnimationFrame:function(id){clearTimeout(id);},
            setTimeout:setTimeout,clearTimeout:clearTimeout,setInterval:setInterval,clearInterval:clearInterval,console:console
          };
        }
        globalThis.self=globalThis.self||globalThis.window;
        globalThis.navigator=globalThis.navigator||globalThis.window.navigator;
        var elStub={style:{},setAttribute:noop,getAttribute:function(){return null;},removeAttribute:noop,appendChild:noop,removeChild:noop,addEventListener:noop,removeEventListener:noop,classList:{add:noop,remove:noop,toggle:noop,contains:function(){return false;}}};
        if(typeof globalThis.window.document==="undefined"){
          globalThis.window.document={addEventListener:noop,removeEventListener:noop,createElement:function(){return Object.assign({},elStub);},documentElement:elStub,head:elStub,body:elStub,getElementsByTagName:function(){return [];},getElementById:function(){return null;},querySelector:function(){return null;},querySelectorAll:function(){return [];},cookie:""};
        }
        globalThis.document=globalThis.document||globalThis.window.document;
      })();`,
    },
  })
  .then(() => {
    const kb = (fs.statSync(OUTFILE).size / 1024).toFixed(0);
    console.log(`BUNDLE OK -> ${OUTFILE} (${kb} KB)`);
  })
  .catch(() => {
    console.error('BUNDLE FAILED');
    process.exit(1);
  });
