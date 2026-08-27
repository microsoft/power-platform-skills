/* Dev-only bundler: @maker-studio/cds-maker-sdk -> self-contained CJS the plugin vendors.
 * Run: node plugins/model-apps/scripts/_vendor-build/build.js --sdk <path-to-ppux>
 *      or set POWER_PLATFORM_UX_SDK_ROOT=<path-to-ppux>
 * Not shipped. Re-run only when the SDK source changes.
 *
 * After rebuilding, run the vendored-SDK contract tests against the new bundle:
 *   scripts/tests/{sdk-surface-contract,sdk-async-surface,hardening2-real-bundle,vendor-sdk-smoke}.test.js
 * sdk-async-surface is the one to read first: it pins which SDK methods are asynchronous, and an
 * upstream change to that set is both silent and corrupting (see that file's header).
 *
 * esbuild is pinned to an EXACT version in package.json (no `^`) on purpose. The stub plugin below
 * depends on esbuild's *internal* import-interop codegen (`__toESM` / `__copyProps`) — an
 * implementation detail with no compatibility guarantee, not a public API. That codegen does change
 * across releases: 0.24.2 -> 0.28.1 rewrote the CJS module wrapper to re-throw init errors on every
 * require. Because this build's output is a COMMITTED artifact (../vendor/cds-maker-sdk.cjs), a
 * caret range would let the same SDK source produce a different bundle on someone else's machine —
 * and caret drift is not hypothetical here: the previous `^0.24.0` was already resolving to 0.24.2.
 * Bump deliberately, then re-run the vendored-SDK contract tests (scripts/tests/
 * {sdk-surface-contract,hardening2-real-bundle,vendor-sdk-smoke}.test.js) against the new bundle. */
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
const PROVENANCE = path.resolve(__dirname, '../vendor/PROVENANCE.json');
const esbuild = require('esbuild');

if (!fs.existsSync(SDK_ENTRY)) {
  console.error('SDK entry not found:', SDK_ENTRY);
  process.exit(2);
}

/* Record WHICH upstream source produced the committed bundle.
 *
 * Without this the artifact is unreproducible in practice, and that is not hypothetical: the bundle
 * committed before this was built from a stale, gitignored `lib/` several commits behind its
 * nominal source, and nothing in the repo could reveal that. "Built from master" is not provenance —
 * master moves, and `lib/` is a build output that can be arbitrarily old relative to `src/`.
 *
 * So capture the resolved SHA, and flag a dirty or stale checkout rather than silently baking it in.
 * The `git` calls here are best-effort and record null on failure; the CALLER below decides what
 * that means, and it REFUSES unless --allow-unreproducible is passed, because a source that cannot
 * be identified cannot be audited.
 */
function sdkProvenance(root) {
  const git = (args) => {
    try {
      return require('node:child_process')
        .execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .trim();
    } catch {
      return null;
    }
  };
  const commit = git(['rev-parse', 'HEAD']);
  // `--porcelain` limited to the SDK package: unrelated dirt elsewhere in a large monorepo must not
  // be reported as "this bundle came from modified SDK sources".
  //
  // `null` means the git call FAILED (not a checkout, git missing, permissions) and is kept
  // distinct from `0`. Conflating "unknown" with "clean" is what makes a provenance record lie, so
  // the two are recorded differently and treated differently below.
  const dirtyRaw = git(['status', '--porcelain', '--', 'packages/cds-maker-sdk']);
  const entryMtime = fs.statSync(SDK_ENTRY).mtime.toISOString();
  // A `lib/` older than the newest `src/` file means tsc was not re-run — the exact stale-build trap.
  //
  // LIMIT, stated because it is not obvious: mtime is a heuristic, not proof. A fresh clone or a
  // `git checkout` rewrites source mtimes to NOW, so an already-correct `lib/` will look stale and
  // the build will refuse until the SDK is rebuilt. That is the SAFE direction — it costs one
  // rebuild and never ships an unverified artifact — but it does mean the check is conservative
  // rather than exact. It also cannot see a `lib/` that was copied in with a fresh mtime, so it
  // catches the accident (forgot to rebuild), not a determined mistake.
  let newestSrc = null;
  const srcDir = path.join(root, 'packages/cds-maker-sdk/src');
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.ts')) {
        const m = fs.statSync(f).mtime;
        if (!newestSrc || m > newestSrc) newestSrc = m;
      }
    }
  };
  try { walk(srcDir); } catch { /* no src tree: an export-based build, nothing to compare */ }
  return {
    commit,
    subject: git(['log', '-1', '--format=%s']),
    // null = could not determine (see above); a number = that many modified paths.
    dirtySdkPackage: dirtyRaw === null ? null : dirtyRaw.split('\n').filter(Boolean).length,
    libBuiltAt: entryMtime,
    newestSrcAt: newestSrc ? newestSrc.toISOString() : null,
    libIsStale: !!(newestSrc && newestSrc > fs.statSync(SDK_ENTRY).mtime),
    // NOSTUB materially changes the OUTPUT (it disables the stub plugin, pulling the real shell/UI
    // packages into the bundle), so a record that omitted it could not explain a hash difference.
    nostub: !!process.env.NOSTUB,
    esbuildVersion: require('esbuild/package.json').version,
    nodeVersion: process.version,
    builtAt: new Date().toISOString(),
  };
}

const prov = sdkProvenance(argSdk);
if (prov.libIsStale) {
  console.error(`REFUSING: ${SDK_ENTRY} is OLDER than the newest .ts under packages/cds-maker-sdk/src`);
  console.error(`  lib built  : ${prov.libBuiltAt}`);
  console.error(`  newest src : ${prov.newestSrcAt}`);
  console.error('  Rebuild the SDK (its own `build` script) before vendoring, or the bundle will not');
  console.error('  match the source it claims to come from. This exact trap shipped once already.');
  process.exit(3);
}
// A bundle whose inputs cannot be identified is not reproducible, and a reviewer has no way to tell
// that from one that is. So these FAIL rather than warn — `--allow-unreproducible` exists for the
// legitimate "I am iterating locally" case and records the fact in the provenance file.
const ALLOW_UNREPRODUCIBLE = process.argv.includes('--allow-unreproducible');
if (prov.commit === null && !ALLOW_UNREPRODUCIBLE) {
  console.error('REFUSING: could not read a commit from the SDK source tree.');
  console.error('  Without a commit the bundle cannot be reproduced or audited.');
  console.error('  Vendor from a git checkout, or pass --allow-unreproducible for a local experiment.');
  process.exit(4);
}
if (prov.dirtySdkPackage !== 0 && !ALLOW_UNREPRODUCIBLE) {
  const what = prov.dirtySdkPackage === null
    ? 'could not determine whether packages/cds-maker-sdk is clean'
    : `packages/cds-maker-sdk has ${prov.dirtySdkPackage} uncommitted change(s)`;
  console.error(`REFUSING: ${what}.`);
  console.error(`  The bundle would NOT be reproducible from commit ${prov.commit || '(unknown)'}.`);
  console.error('  Commit the SDK changes first, or pass --allow-unreproducible for a local experiment.');
  process.exit(5);
}
if (ALLOW_UNREPRODUCIBLE) {
  console.warn('WARNING: --allow-unreproducible — this bundle must NOT be committed.');
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
    // Hash the artifact so a reviewer can tell two bundles apart without diffing 600KB of minified
    // output, and so a rebuild from the same inputs is checkable rather than assumed.
    // Hash the LF-NORMALISED content so the recorded value is platform-independent: git's
    // end-of-line normalisation would otherwise make the same commit hash differently on a Windows
    // checkout than on Linux. (vendor/.gitattributes also marks the bundle `-text`; this is the
    // belt to that braces.)
    const raw = fs.readFileSync(OUTFILE);
    const normalised = Buffer.from(raw.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
    const sha256 = require('node:crypto').createHash('sha256').update(normalised).digest('hex');
    fs.writeFileSync(PROVENANCE, `${JSON.stringify({ ...prov, allowUnreproducible: ALLOW_UNREPRODUCIBLE || undefined, bundleSha256: sha256, bundleBytes: normalised.length }, null, 2)}\n`);
    console.log(`BUNDLE OK -> ${OUTFILE} (${kb} KB)`);
    console.log(`  sdk commit : ${prov.commit || '(not a git checkout)'}`);
    console.log(`  sha256     : ${sha256}`);
    console.log(`  provenance -> ${PROVENANCE}`);
  })
  .catch(() => {
    console.error('BUNDLE FAILED');
    process.exit(1);
  });
