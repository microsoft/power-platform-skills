'use strict';

/**
 * Locates the TypeScript compiler used by the semantic (AST) mobile validators.
 *
 * Resolution order matters:
 *   1. The validated app's own `node_modules/typescript`. Generated mobile
 *      templates pin TypeScript 5.9.3, so analysing an app with the exact
 *      compiler that app type-checks with keeps module resolution, JSX
 *      handling, and syntax support identical to `npx tsc --noEmit`.
 *   2. This plugin's development/CI devDependency (`plugins/mobile-apps/node_modules`).
 *      Present when the plugin's own test suite runs; absent in a marketplace
 *      install, which is why it is a fallback and never the preferred copy.
 *   3. A plain `require('typescript')` from this file's resolution paths, which
 *      also covers a hoisted monorepo install.
 *
 * When no compiler is found the caller must degrade to a non-blocking
 * `unknown` finding: a missing dev dependency is not evidence that app code is
 * wrong, so it must never fail a build.
 */

const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');

function tryLoadFrom(baseDir) {
  if (!baseDir) return null;
  const entry = path.join(baseDir, 'node_modules', 'typescript', 'package.json');
  if (!fs.existsSync(entry)) return null;
  try {
    // Resolve through the package entry point rather than assuming
    // `lib/typescript.js`; the published layout has changed between majors.
    const modulePath = require.resolve(path.join(baseDir, 'node_modules', 'typescript'));
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const ts = require(modulePath);
    return ts && typeof ts.createProgram === 'function' ? { ts, modulePath } : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} projectRoot Absolute path to the validated app root.
 * @returns {{ ts: object, source: 'app'|'plugin'|'ambient', modulePath: string, version: string }|null}
 */
function loadTypeScript(projectRoot) {
  if (process.env.MOBILE_AST_DISABLE_TYPESCRIPT === '1') return null;

  const fromApp = projectRoot ? tryLoadFrom(path.resolve(projectRoot)) : null;
  if (fromApp) {
    return { ...fromApp, source: 'app', version: fromApp.ts.version };
  }

  const fromPlugin = tryLoadFrom(PLUGIN_ROOT);
  if (fromPlugin) {
    return { ...fromPlugin, source: 'plugin', version: fromPlugin.ts.version };
  }

  try {
    // eslint-disable-next-line global-require
    const ts = require('typescript');
    if (ts && typeof ts.createProgram === 'function') {
      return { ts, source: 'ambient', modulePath: require.resolve('typescript'), version: ts.version };
    }
  } catch {
    // Fall through to the null result below — callers report `unknown`.
  }

  return null;
}

module.exports = { loadTypeScript, PLUGIN_ROOT };
