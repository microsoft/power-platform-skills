/* Dev-only bundler: @maker-studio/cds-maker-sdk -> self-contained CJS the plugin vendors.
 * Run: node plugins/model-apps/scripts/_vendor-build/build.js [--sdk <path-to-ppux>]
 * Not shipped. Re-run only when the SDK source changes. */
const esbuild = require('esbuild');
const path = require('node:path');
const fs = require('node:fs');

const argSdk = (() => {
  const i = process.argv.indexOf('--sdk');
  return i > -1 ? process.argv[i + 1] : 'D:/Projects/power-platform-ux';
})();
const SDK_ENTRY = path.join(argSdk, 'packages/cds-maker-sdk/lib/index.js');
const OUTFILE = path.resolve(__dirname, '../vendor/cds-maker-sdk.cjs');

if (!fs.existsSync(SDK_ENTRY)) {
  console.error('SDK entry not found:', SDK_ENTRY);
  process.exit(2);
}

// Transitive shell deps that read browser globals at import / break esbuild named-export
// resolution. The SDK itself injects auth via HttpClient and uses an xmldom DOM shim, so these
// are dead weight for our headless serialize/push path — stub them to chainable no-ops.
const STUB_RE = /^@maker-studio\/(shell-authentication|authentication)(\/|$)/;
const stubPlugin = {
  name: 'stub-shell-auth',
  setup(build) {
    build.onResolve({ filter: STUB_RE }, (a) => ({ path: a.path, namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      // A chainable no-op that is callable (identity HOC), constructable, and returns
      // itself for any property. Exposed via a *prototype* Proxy so esbuild's __toESM /
      // __copyProps resolves ANY named import (withUserInfo, withHttpClient, …) — a bare
      // Proxy on module.exports has no own keys and yields `undefined` for named imports.
      contents: `
        var chain = new Proxy(function () { return chain; }, {
          get: function (_t, k) { if (k === '__esModule') return false; if (k === Symbol.toPrimitive) return function () { return ''; }; return chain; },
          apply: function () { return chain; },
          construct: function () { return {}; }
        });
        var catchAll = new Proxy({}, { get: function (_t, k) { if (k === '__esModule') return false; return chain; } });
        module.exports = Object.create(catchAll);
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
    legalComments: 'none',
    plugins: process.env.NOSTUB ? [] : [stubPlugin],
    banner: {
      // Headless browser-global shim for transitive shell-* deps that touch `window`
      // at import (e.g. shell-telemetry's ErrorHandler). The SDK's own xmldom DOM shim
      // (installDomShim) handles DOMParser/XMLSerializer separately.
      js: `(function(){
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
