#!/usr/bin/env node

/**
 * scripts/check-routes.js — Route param contract doctor.
 *
 * Catches the "screen A sends, screen B ignores" bug class: when multiple
 * screens push to a shared destination with different param sets, the
 * destination's `useLocalSearchParams<{...}>()` may declare only one sender's
 * params, and the other senders' params are silently dropped at runtime.
 *
 * The analysis itself lives in `scripts/lib/ast/routes.js` and is shared with the
 * semantic validation infrastructure, so route derivation and param diffing
 * cannot drift between the two. It resolves symbols through the app's TypeScript program, which means
 * aliased `useLocalSearchParams` imports, params built from constants, and
 * navigation performed by an app-local helper are all understood. When the app
 * has no TypeScript installed, semantic analysis is reported as non-blocking
 * `unknown`; regex never decides behavioral correctness.
 *
 * Usage:
 *   node scripts/check-routes.js                # exit 1 if any drift
 *   node scripts/check-routes.js --json         # machine-readable output
 *   node scripts/check-routes.js --quiet        # only print failures
 *   node scripts/check-routes.js --fix-suggest  # print the exact useLocalSearchParams type to use
 *
 * Wire as `npm run check-routes` (see package.json `scripts`).
 *
 * Exit codes:
 *   0 = all destinations declare every sender-passed param
 *   1 = drift detected (one or more destinations missing params)
 *   2 = app/ directory missing (cannot analyze)
 */

const fs = require('fs');
const path = require('path');

const { analyzeRoutes } = require('./lib/ast/routes');

const args = process.argv.slice(2);
const FLAG_JSON = args.includes('--json');
const FLAG_QUIET = args.includes('--quiet');
const FLAG_FIX_SUGGEST = args.includes('--fix-suggest');

function main() {
  const cwd = process.cwd();
  const appRoot = path.join(cwd, 'app');
  if (!fs.existsSync(appRoot)) {
    console.error(`Error: ${appRoot} does not exist. Run from a project root with an app/ directory.`);
    process.exit(2);
  }

  const { findings, unknowns, stats, backend } = analyzeRoutes({ projectRoot: cwd, cwd });

  if (FLAG_JSON) {
    console.log(JSON.stringify({ findings, unknowns, stats, backend }, null, 2));
    process.exit(findings.length > 0 ? 1 : 0);
  }

  for (const unknown of unknowns) {
    console.warn(`? check-routes: unknown — ${unknown.message}`);
  }

  if (findings.length === 0) {
    if (!FLAG_QUIET) {
      console.log(
        unknowns.length > 0
          ? `✓ check-routes: no proven route contract failures; ${unknowns.length} item(s) remain unknown.`
          : '✓ check-routes: all destinations declare every sender-passed param.',
      );
      console.log(`  Scanned ${stats.files} TSX file(s) in ${path.relative(cwd, appRoot)}/ (${backend} analysis).`);
      console.log(`  ${stats.routes} routes, ${stats.senders} push/replace/Link expressions.`);
    }
    process.exit(0);
  }

  console.error(`✗ check-routes: ${findings.length} route contract issue(s).\n`);
  for (const finding of findings) {
    console.error(`  Route:  ${finding.route}`);
    console.error(`  File:   ${path.relative(cwd, finding.file)}`);
    if (finding.kind === 'file-folder-route-collision') {
      console.error('  Issue:  Route file conflicts with a same-name child folder.');
      console.error(`  Child:  ${finding.childFiles.map((child) => path.relative(cwd, child)).join(', ')}`);
      console.error(`  Fix:    Move ${path.basename(finding.file)} to ${path.basename(finding.file, '.tsx')}/index.tsx.`);
      console.error('');
      continue;
    }
    if (finding.kind === 'duplicate-route') {
      console.error('  Issue:  Duplicate Expo route.');
      console.error(`  Other:  ${path.relative(cwd, finding.otherFile)}`);
      console.error('  Fix:    If the route owns child screens, use <route>/index.tsx and remove the sibling <route>.tsx file.');
      console.error('');
      continue;
    }
    if (finding.kind === 'no-declaration') {
      console.error(`  Issue:  No useLocalSearchParams<>() call, but ${Object.keys(finding.receivedParams).length} param(s) are sent here.`);
    } else {
      console.error('  Issue:  Missing from useLocalSearchParams<>() type.');
      console.error(`  Declared: { ${finding.declaredRaw ? finding.declaredRaw.replace(/\s+/g, ' ').trim() : '∅'} }`);
    }
    console.error(`  Sources: ${finding.sources.join(', ')}`);
    console.error(`  Missing: ${Object.entries(finding.missingParams || finding.receivedParams).map(([key, value]) => `${key} (${value})`).join(', ')}`);
    if (FLAG_FIX_SUGGEST || !FLAG_QUIET) {
      console.error(`  Fix:    useLocalSearchParams<{ ${finding.suggestion} }>();`);
    }
    console.error('');
  }
  process.exit(1);
}

main();
