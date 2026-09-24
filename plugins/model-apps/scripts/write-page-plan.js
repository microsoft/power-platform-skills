#!/usr/bin/env node
'use strict';
// write-page-plan: project an App Spec into the `genpage-plan.md` the page-builder worker reads.
//
// /app-builder Phase 1.5 dispatches the SAME worker /genpage uses, and that worker's input contract
// is a plan document — not an App Spec. This CLI is the adapter seam: it writes a schema-faithful
// plan into the working directory so the worker's documented contract is satisfied unchanged.
//
// Usage:
//   node write-page-plan.js --spec @<working-dir>/app-spec.json --working-dir <dir>
//     [--env <orgUrl>] [--app <label>] [--languages "English (1033) only"] [--out <path>]
//
// The default output is `app-builder-page-plan.md`, NOT `genpage-plan.md`. Both skills derive their
// working directory from a slug off the user's request, so the two can land on the same folder — and
// `genpage-plan.md` is the filename standalone `/genpage` treats as its authoritative state. Writing
// there would let a later `/genpage` run silently consume an app-builder plan, whose dialect differs
// (`Mode: app-builder` + stable keys vs. no Mode + filename stems), producing wrong PAGEREF tokens.
// The worker is handed the plan PATH explicitly in its dispatch, so the name is free to differ.
//
// Output: { "ok": true, "planPath": "...", "pages": [{ "key", "file", "dataMode" }, ...] }
// The `pages[]` echo is what Phase 1.5 iterates to dispatch one worker per page, so the CLI is the
// single source of truth for BOTH the plan content and the per-page dispatch parameters.

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, validateFlags, readJsonArg, emitResult } = require('./lib/dataverse-auth.js');
const { migrateAppSpec } = require('./lib/app-spec.js');
const { buildPagePlan, pageKey, pageFile, planFile, pageDataMode, mdText } = require('./lib/page-plan.js');
const { pageFileProblems } = require('./lib/page-file-targets.js');

function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const USAGE =
    'Usage: node scripts/write-page-plan.js --spec @<app-folder>/app-spec.json --working-dir <dir> '
    + '[--env <orgUrl>] [--app <label>] [--languages <text>] [--out <path>]';
  // Every flag here carries a value, so all of them go in needValue; a bare one would otherwise
  // reach path.resolve/readFile as a boolean.
  const flagError = validateFlags(argv, {
    known: ['spec', 'working-dir', 'env', 'app', 'languages', 'out'],
    needValue: ['spec', 'working-dir', 'env', 'app', 'languages', 'out'],
  });
  if (flagError) {
    process.stderr.write(`✗ ${flagError}\n${USAGE}\n`);
    process.exit(1);
  }
  const specArg = flags.spec || positional[0];
  const workingDir = flags['working-dir'];
  if (!specArg || !workingDir) {
    process.stderr.write(USAGE + '\n');
    process.exit(1);
  }

  const specPath = path.resolve(specArg.startsWith('@') ? specArg.slice(1) : specArg);
  const spec = migrateAppSpec(readJsonArg('@' + specPath));
  const absWorkingDir = path.resolve(workingDir);

  const markdown = buildPagePlan(spec, {
    envUrl: flags.env,
    appLabel: flags.app,
    languages: flags.languages,
    // Forward slashes: the plan schema requires them on Windows because downstream agents embed the
    // path in shell commands where a backslash is an escape character.
    workingDir: absWorkingDir.replace(/\\/g, '/'),
    // __dirname is `<plugin>/scripts`, so the plugin root is one level UP. The worker resolves
    // `${PLUGIN_ROOT}/references/...` and `${PLUGIN_ROOT}/samples/...` from this value, so pointing
    // it at scripts/ would make every reference/sample read miss.
    pluginRoot: path.resolve(__dirname, '..').replace(/\\/g, '/'),
  });

  const planPath = flags.out ? path.resolve(flags.out) : path.join(absWorkingDir, 'app-builder-page-plan.md');

  // Fail BEFORE writing if the plan names a sample that does not exist — the worker's Step 3 reads
  // `${PLUGIN_ROOT}/samples/<name>` and a missing file derails generation with a confusing error.
  const samplesDir = path.resolve(__dirname, '..', 'samples');
  const named = [...new Set([...markdown.matchAll(/\|\s*(\d+-[a-z0-9-]+\.tsx)\s*\|/gi)].map((m) => m[1]))];
  const missing = named.filter((n) => !fs.existsSync(path.join(samplesDir, n)));
  if (missing.length) {
    emitResult(false, new Error(`page plan references sample(s) that do not exist in samples/: ${missing.join(', ')}`));
    return;
  }

  // The checks that need the disk — a link at a page path, a folder that links outside the working
  // directory, a page already there under another spelling — run HERE, where the working directory is
  // known: buildPagePlan is pure, so it applies only the lexical rules and collisions. /genpage runs the
  // same checks through check-page-files.js before its workers; this is /app-builder's, before Phase 1.5
  // dispatches any. Only the pages a worker will write are held to the whole rule — a built page is
  // written by nobody — but the built pages go along as `built`, in the plan's own spelling: a new page
  // must not reach one through a link or junction (`loop/home.tsx`, with `loop` pointing back here, IS
  // `home.tsx`), and only here is the working directory known to resolve that.
  const intentFiles = (spec.pages || []).filter((p) => p && (!p.source || p.source.kind === 'intent')).map(pageFile);
  const builtFiles = (spec.pages || []).filter((p) => p && p.source && p.source.kind === 'tsx' && p.source.codeFile).map(planFile);
  const problems = pageFileProblems(intentFiles, { workingDir: absWorkingDir, built: builtFiles });
  if (problems.length) {
    emitResult(false, new Error(`page file(s) are not safe to write in ${absWorkingDir}: ${problems.map((p) => p.message).join('; ')}`));
    return;
  }

  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, markdown, 'utf8');

  const pages = (spec.pages || []).filter(Boolean).map((p) => ({
    // `name` is required by the worker's dispatch prompt ("Generate the **[Page Name]** page"), and
    // the caller interpolates it straight into that prompt — so it must be sanitised HERE, not just
    // where it lands in the plan body. An unsanitised multi-line name would let author- or
    // download-supplied text inject lines into the instructions given to a file-writing agent.
    name: mdText(p.name, pageKey(p)),
    key: pageKey(p),
    file: pageFile(p),
    dataMode: pageDataMode(p),
    intent: !p.source || p.source.kind === 'intent',
  }));
  emitResult(true, { ok: true, planPath, pages });
}

if (require.main === module) main();

module.exports = { main };
