'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { pluginTestFiles, sdkTestSpec, summarize, runPluginSuite, reportStrayFolders, withTempDir } = require('../run-tests.js');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { PREVIOUS_RELEASE, BUNDLE_PATH } = require('./helpers/previous-bundle.js');

test('pluginTestFiles discovers every *.test.js as a scripts/tests path, sorted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtests-'));
  fs.writeFileSync(path.join(dir, 'b.test.js'), '');
  fs.writeFileSync(path.join(dir, 'a.test.js'), '');
  fs.writeFileSync(path.join(dir, 'notatest.js'), '');
  const files = pluginTestFiles(dir);
  assert.deepStrictEqual(files, [path.join('scripts', 'tests', 'a.test.js'), path.join('scripts', 'tests', 'b.test.js')]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pluginTestFiles covers the real tests directory (all 18+ suites)', () => {
  const files = pluginTestFiles(path.join(__dirname));
  assert.ok(files.length >= 18, `expected the full suite, got ${files.length}`);
  assert.ok(files.every((f) => f.endsWith('.test.js')));
});

// Discovery used to be a FLAT readdir, so a test file in `scripts/tests/<subdir>/` was committed,
// reviewed, reported green — and never executed. Nothing downstream notices, because the runner
// reports success over the files it did find. Every suite happens to be top-level today, which is
// exactly why this needs a test rather than an observation.
test('pluginTestFiles descends into subdirectories (a nested suite must not be silently skipped)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtests-nested-'));
  fs.mkdirSync(path.join(dir, 'sub', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'top.test.js'), '');
  fs.writeFileSync(path.join(dir, 'sub', 'mid.test.js'), '');
  fs.writeFileSync(path.join(dir, 'sub', 'deeper', 'low.test.js'), '');
  fs.writeFileSync(path.join(dir, 'sub', 'fixture.js'), '');       // not a test
  fs.mkdirSync(path.join(dir, 'helpers'));
  fs.writeFileSync(path.join(dir, 'helpers', 'mock.js'), '');      // helpers hold fixtures, not tests
  const files = pluginTestFiles(dir);
  assert.deepStrictEqual(files, [
    path.join('scripts', 'tests', 'sub', 'deeper', 'low.test.js'),
    path.join('scripts', 'tests', 'sub', 'mid.test.js'),
    path.join('scripts', 'tests', 'top.test.js'),
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sdkTestSpec resolves the package dir and reports presence', () => {
  const spec = sdkTestSpec('D:/nope', 'D:/also-nope');
  assert.ok(spec.pkgDir.endsWith(path.join('packages', 'cds-maker-sdk')));
  assert.strictEqual(spec.pkgExists, false);
  assert.strictEqual(spec.node20Exists, false);
});

test('summarize reports a skipped suite as SKIP and keeps the run green', () => {
  const { lines, exitCode } = summarize([
    { name: 'plugin node:test', ok: true },
    { name: 'cds-maker-sdk Jest', ok: true, skipped: 'no Node 20 (set NODE20_BIN)' },
  ]);
  assert.strictEqual(exitCode, 0, 'a missing SDK prerequisite must not fail the run');
  assert.ok(lines.some((l) => /SKIP\s+cds-maker-sdk Jest \(no Node 20 \(set NODE20_BIN\)\)/.test(l)));
  assert.ok(lines.some((l) => /PASS\s+plugin node:test/.test(l)));
});

test('summarize fails the run when any non-skipped suite failed', () => {
  const { lines, exitCode } = summarize([
    { name: 'plugin node:test', ok: false },
    { name: 'cds-maker-sdk Jest', ok: true },
  ]);
  assert.strictEqual(exitCode, 1);
  assert.ok(lines.some((l) => /FAIL\s+plugin node:test/.test(l)));
});

// --- Nothing left behind ----------------------------------------------------------------------
// The suite runs in a temporary folder of its own, and the run fails when a test leaves anything in it. A full run
// used to leave about 260 folders in the developer's temp folder; these tests hold the check to catching a leak, to
// passing a clean run, and to never leaving its own folder behind.
test('runPluginSuite runs the suite in a temporary folder of its own, names what a test left there, and removes it', () => {
  const root = makeTempDir('runtests-guard-');
  const work = path.join(root, 'work');
  const parent = path.join(root, 'temp');
  fs.mkdirSync(work);
  fs.mkdirSync(parent);
  fs.writeFileSync(path.join(work, 'clean.test.js'), "const test = require('node:test');\ntest('makes nothing', () => {});\n");
  fs.writeFileSync(path.join(work, 'leaky.test.js'), [
    "const test = require('node:test');",
    "const fs = require('node:fs');",
    "const os = require('node:os');",
    "const path = require('node:path');",
    "test('leaves a folder behind', () => { fs.mkdtempSync(path.join(os.tmpdir(), 'leaked-')); });",
    '',
  ].join('\n'));

  assert.deepStrictEqual(runPluginSuite(['clean.test.js'], { cwd: work, stdio: 'pipe', tempParent: parent }), { status: 0, left: [], made: [], kept: [] });
  const leaky = runPluginSuite(['leaky.test.js'], { cwd: work, stdio: 'pipe', tempParent: parent });
  assert.strictEqual(leaky.status, 0, 'the leaking test itself passes: only the check catches it');
  assert.strictEqual(leaky.left.length, 1, leaky.left.join(', '));
  assert.match(leaky.left[0], /^leaked-/);
  assert.deepStrictEqual(fs.readdirSync(parent), [], "the suite's temporary folder is removed either way");
});

// A build's workspace is `<app folder>/.maker-workspace` unless it is given another, so a test that handed a build `process.cwd()` as its app folder — the suite runs in the plugin's own folder — made
// `plugins/model-apps/.maker-workspace` and left it behind, empty. The run names such a folder and fails, and it removes the folder when it is empty: a leftover is not a leak the next run can see, since it
// would find the folder already there and take it for one that was always there.
test('runPluginSuite names a .maker-workspace the suite made in its working folder and removes it when it is empty — and leaves alone one that was there before the run', () => {
  const root = makeTempDir('runtests-cwd-');
  const work = path.join(root, 'work');
  const parent = path.join(root, 'temp');
  fs.mkdirSync(work);
  fs.mkdirSync(parent);
  fs.writeFileSync(path.join(work, 'clean.test.js'), "const test = require('node:test');\ntest('makes nothing', () => {});\n");
  fs.writeFileSync(path.join(work, 'stray.test.js'), [
    "const test = require('node:test');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "test('makes the workspace a build opens when it is given no other', () => { fs.mkdirSync(path.join(process.cwd(), '.maker-workspace')); });",
    '',
  ].join('\n'));
  const run = (file) => runPluginSuite([file], { cwd: work, stdio: 'pipe', tempParent: parent });

  const stray = run('stray.test.js');
  assert.strictEqual(stray.status, 0, 'the test itself passes: only the check catches it');
  assert.deepStrictEqual(stray.made, [path.join(work, '.maker-workspace')], 'the folder is named, by its path');
  assert.deepStrictEqual(stray.left, [], 'it is not in the temporary folder');
  assert.deepStrictEqual(stray.kept, [], 'nothing is left in place: it held nothing');
  assert.ok(!fs.existsSync(path.join(work, '.maker-workspace')), 'and it is removed, being empty, so that the next run is not blind to the leak');

  // One that was there before the run is nobody's to answer for, and stays as it is, with what is in it.
  fs.mkdirSync(path.join(work, '.maker-workspace'));
  fs.writeFileSync(path.join(work, '.maker-workspace', 'last-applied.json'), '{}');
  assert.deepStrictEqual(run('clean.test.js'), { status: 0, left: [], made: [], kept: [] });
  assert.deepStrictEqual(fs.readdirSync(path.join(work, '.maker-workspace')), ['last-applied.json']);
});

// The folder the suite runs in is shared: a build started by hand beside the suite opens its own `.maker-workspace` there, and the run cannot tell that folder from one a test made — all it knows is that the
// folder was not there before the run. So it never takes what it cannot show to be its own: a folder with anything in it is named, and left where it is with everything in it, whoever made it. (It used to remove
// such a folder with all that was in it, which took the baseline and the lock of a build that was still running.)
test('runPluginSuite names a .maker-workspace that holds something and leaves it where it is, with everything in it — a build running beside the suite keeps its workspace', async () => {
  const root = makeTempDir('runtests-beside-');
  const work = path.join(root, 'work');
  const parent = path.join(root, 'temp');
  fs.mkdirSync(work);
  fs.mkdirSync(parent);
  const waiting = [
    "const fs = require('node:fs');",
    "const waitFor = (file) => { const until = Date.now() + 60000; while (!fs.existsSync(file)) { if (Date.now() > until) process.exit(2); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } };",
  ];
  // The suite's one test makes no workspace: it only waits until the build beside it has made its own, so that the folder appears while the suite runs.
  fs.writeFileSync(path.join(work, 'beside.test.js'), [
    "const test = require('node:test');",
    ...waiting,
    "test('makes no workspace, and lets the build beside it make its own', () => { fs.writeFileSync('suite-started', ''); waitFor('build-wrote'); });",
    '',
  ].join('\n'));
  const build = spawn(process.execPath, ['-e', [
    ...waiting,
    "waitFor('suite-started');",
    "fs.mkdirSync('.maker-workspace/apps', { recursive: true });",
    "fs.writeFileSync('.maker-workspace/last-applied.json', '{\"generation\":123}');",
    "fs.writeFileSync('.maker-workspace/apps/app.json', '{}');",
    "fs.writeFileSync('build-wrote', '');",
    "waitFor('suite-ended');",
  ].join('\n')], { cwd: work, stdio: 'ignore', windowsHide: true });
  const ended = new Promise((resolve) => build.once('exit', resolve));
  try {
    const run = runPluginSuite(['beside.test.js'], { cwd: work, stdio: 'pipe', tempParent: parent });
    const workspace = path.join(work, '.maker-workspace');
    assert.strictEqual(run.status, 0, 'the test itself passes: only the check catches it');
    assert.deepStrictEqual(run.made, [workspace], 'the folder was not there before the run, so it is named, and the run fails on it');
    assert.strictEqual(build.exitCode, null, 'the build beside the suite is still running');
    assert.strictEqual(fs.readFileSync(path.join(workspace, 'last-applied.json'), 'utf8'), '{"generation":123}', 'its baseline is as it wrote it');
    assert.ok(fs.existsSync(path.join(workspace, 'apps', 'app.json')), 'and what is nested in its folder is there');
    assert.deepStrictEqual(run.kept, [workspace], "the run says it left the folder in place: it is not the run's to remove");
  } finally {
    fs.writeFileSync(path.join(work, 'suite-ended'), '');
    await ended;
  }
});

// A removal that follows a link reaches what the link points at, and a link is no folder that a run could have found empty, so a `.maker-workspace` that is a link — or anything else that is not a plain folder — is
// named, and neither followed nor removed. (A junction on Windows, which needs no privilege to make; a symbolic link elsewhere.)
test('runPluginSuite names a .maker-workspace that is a link or a file and removes neither — what a link points at is never reached', () => {
  const root = makeTempDir('runtests-link-');
  const parent = path.join(root, 'temp');
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(parent);
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, 'last-applied.json'), '{}');
  const kinds = {
    link: `fs.symlinkSync(${JSON.stringify(elsewhere)}, path.join(process.cwd(), '.maker-workspace'), 'junction');`,
    file: "fs.writeFileSync(path.join(process.cwd(), '.maker-workspace'), 'not a folder');",
  };
  for (const [kind, make] of Object.entries(kinds)) {
    const work = path.join(root, `work-${kind}`);
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, `${kind}.test.js`), [
      "const test = require('node:test');",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      `test('makes a ${kind} where the workspace would be', () => { ${make} });`,
      '',
    ].join('\n'));
    const run = runPluginSuite([`${kind}.test.js`], { cwd: work, stdio: 'pipe', tempParent: parent });
    const workspace = path.join(work, '.maker-workspace');
    assert.strictEqual(run.status, 0, `${kind}: the test itself passes`);
    assert.deepStrictEqual(run.made, [workspace], `${kind}: it is named`);
    assert.deepStrictEqual(run.kept, [workspace], `${kind}: and left in place`);
  }
  assert.ok(fs.lstatSync(path.join(root, 'work-link', '.maker-workspace')).isSymbolicLink(), 'the link is still a link');
  assert.strictEqual(fs.readFileSync(path.join(elsewhere, 'last-applied.json'), 'utf8'), '{}', 'and what it points at was not reached');
  assert.strictEqual(fs.readFileSync(path.join(root, 'work-file', '.maker-workspace'), 'utf8'), 'not a folder', 'the file is as it was');
});

test('the report of what the run made in the plugin folder says which folder it removed and which it left in place, and what to do about the latter', () => {
  assert.strictEqual(reportStrayFolders({ made: [], kept: [] }), '', 'nothing made, nothing said');
  const removed = reportStrayFolders({ made: ['/p/.maker-workspace'], kept: [] });
  assert.match(removed, /^\n1 folder\(s\) made in the plugin's own folder while the suite ran:\n {2}\/p\/\.maker-workspace {2}\(empty: removed again\)\n/);
  assert.doesNotMatch(removed, /by hand/, 'there is nothing to delete when the run took the folder away');
  assert.match(removed, /never process\.cwd\(\)/, 'and the way to avoid it is said either way');
  const left = reportStrayFolders({ made: ['/a/.maker-workspace', '/b/.maker-workspace'], kept: ['/b/.maker-workspace'] });
  assert.match(left, /\n {2}\/a\/\.maker-workspace {2}\(empty: removed again\)\n/);
  assert.match(left, /\n {2}\/b\/\.maker-workspace {2}\(left in place\)\n/);
  assert.match(left, /another process may have made it/);
  assert.match(left, /Delete it by hand/);
  assert.match(left, /never process\.cwd\(\)/);
});

test('withTempDir points TEMP, TMP and TMPDIR at the folder whatever their spelling, and keeps the rest', () => {
  const env = withTempDir({ Temp: 'C:\\old', tmp: 'C:\\old', TMPDIR: '/old', PATH: 'p', Other: 'x' }, 'D:\\suite');
  assert.deepStrictEqual(env, { PATH: 'p', Other: 'x', TEMP: 'D:\\suite', TMP: 'D:\\suite', TMPDIR: 'D:\\suite' });
});

test('summarize fails the run when the suite left something in its temporary folder', () => {
  const { lines, exitCode } = summarize([
    { name: 'plugin node:test', ok: true },
    { name: 'nothing left in the temporary folder', ok: false },
  ]);
  assert.strictEqual(exitCode, 1);
  assert.ok(lines.some((l) => /FAIL\s+nothing left in the temporary folder/.test(l)));
});

// main() is the gate CI runs, and it is not run here (it runs this whole suite), so its wiring is read from the source:
// the suite goes through runPluginSuite and what it left decides a result of its own.
test('the regression gate runs the plugin suite through runPluginSuite and fails on what it left behind, in its temporary folder and in the plugin\'s own', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'run-tests.js'), 'utf8');
  assert.match(source, /const plugin = runPluginSuite\(files, \{ cwd: pluginRoot \}\);/);
  assert.match(source, /results\.push\(\{ name: 'nothing left in the temporary folder', ok: plugin\.left\.length === 0 \}\);/);
  assert.match(source, /results\.push\(\{ name: 'nothing made in the plugin folder', ok: plugin\.made\.length === 0 \}\);/);
});

// --- CI workflow scoping ---------------------------------------------------------------------
// The plugin's workflow must stay scoped to THIS plugin. A widened path filter would spend CI on
// every unrelated PR, and (worse) make an unrelated plugin's red build look like a model-apps
// failure. This is a text assertion rather than a YAML parse because the repo ships no YAML
// dependency and the properties that matter are all line-level.
const WORKFLOW = path.resolve(__dirname, '..', '..', '..', '..', '.github', 'workflows', 'model-apps-script-tests.yml');
// The one exception: the sources this plugin ships physical copies of. A change to one is NOT
// unrelated — telemetry-lib-copy.test.js fails when a copy drifts from its source, and it should
// fail in the PR that edited the source, not in the next model-apps PR, whose author did not cause it.
const BUNDLED_SHARED_SOURCES = new Set([
  'shared/telemetry/**',
  'shared/skills/**',
  'plugins/power-pages/scripts/lib/telemetry/region/**',
]);
// pcf ships copies of these model-apps files (scripts/validate-plugin-copies.js is the source of
// truth). A PR that edits only pcf's copy must still run this plugin's copy-sync test.
const PCF_COPY_SYNC_PATHS = new Set([
  'scripts/validate-plugin-copies.js',
  'plugins/pcf/scripts/lib/process-runner.js',
  'plugins/pcf/scripts/lib/sdk-http-client.js',
  'plugins/pcf/scripts/lib/output-redaction.js',
  'plugins/pcf/scripts/lib/odata.js',
  'plugins/pcf/scripts/lib/source-literals.js',
  'plugins/pcf/scripts/lib/interaction-mode.js',
  'plugins/pcf/scripts/lib/nearest-name.js',
  'plugins/pcf/scripts/lib/utf8-stream.js',
  'plugins/pcf/scripts/lib/cli-failure.js',
  'plugins/pcf/scripts/lib/telemetry/ikey.json',
  'plugins/pcf/scripts/lib/dataverse-auth.js',
  'plugins/pcf/scripts/check-auth.js',
  'plugins/pcf/scripts/resolve-interaction-mode.js',
  'plugins/pcf/scripts/vendor/cds-maker-sdk.cjs',
  'plugins/pcf/scripts/vendor/PROVENANCE.json',
  'plugins/pcf/scripts/vendor/.gitattributes',
  'plugins/pcf/skills/report-issue/report-issue-workflow.md',
  'plugins/pcf/skills/report-issue/SKILL.md',
]);

test('the model-apps CI workflow triggers ONLY on model-apps paths and the shared sources it bundles', () => {
  const wf = fs.readFileSync(WORKFLOW, 'utf8');
  // The `paths:` block ends at the first non-list line (the blank line before `jobs:`).
  //   paths:
  //       - "plugins/model-apps/**"
  //       # a comment is allowed between entries
  //       - "evals/model-apps/**"
  const block = wf.slice(wf.indexOf('paths:'));
  const globs = [];
  for (const line of block.split('\n').slice(1)) {
    const m = /^\s+-\s+"?([^"\s]+)"?\s*$/.exec(line);
    if (m) { globs.push(m[1]); continue; }
    if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;
    break; // reached `jobs:` or another key
  }
  assert.ok(globs.length > 0, 'the workflow must declare a paths filter, not run on every PR');
  for (const g of globs) {
    assert.ok(
      g.startsWith('plugins/model-apps/') || g.startsWith('evals/model-apps/') || g.endsWith('model-apps-script-tests.yml')
        || BUNDLED_SHARED_SOURCES.has(g)
        || PCF_COPY_SYNC_PATHS.has(g),
      `path filter "${g}" is not scoped to model-apps — this workflow must not run for other plugins`
    );
  }
  // And it must not be scoped so tightly that the plugin's own code stops triggering it.
  assert.ok(globs.some((g) => g.startsWith('plugins/model-apps/')), 'the plugin source must trigger the workflow');
  // Every shared source the plugin copies from must trigger it, and each one must exist: a renamed
  // or removed source would otherwise leave an allowed glob that matches nothing.
  for (const source of BUNDLED_SHARED_SOURCES) {
    assert.ok(globs.includes(source), `a change to ${source} must run the drift test`);
    assert.ok(fs.existsSync(path.resolve(__dirname, '..', '..', '..', '..', source.replace(/\/\*\*$/, ''))), `${source} names no directory`);
  }
  for (const copyPath of PCF_COPY_SYNC_PATHS) {
    assert.ok(globs.includes(copyPath), `a change to ${copyPath} must run the pcf copy sync test`);
    assert.ok(fs.existsSync(path.resolve(__dirname, '..', '..', '..', '..', copyPath)), `${copyPath} names no file`);
  }
});

test('the model-apps CI workflow opts out of telemetry transmission on every job', () => {
  // Repo convention: any job that could execute a telemetry-emitting hook or script must set the
  // plugin's opt-out var, so a test that forgets to isolate emission cannot reach a real collector.
  const wf = fs.readFileSync(WORKFLOW, 'utf8');
  const jobCount = (wf.match(/^ {4}[a-z0-9-]+:\s*$/gim) || []).length;
  const optOuts = (wf.match(/POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT/g) || []).length;
  assert.ok(jobCount >= 2, `expected at least 2 jobs, found ${jobCount}`);
  assert.strictEqual(optOuts, jobCount, `every job must set the opt-out (${optOuts} set / ${jobCount} jobs)`);
});

test('the model-apps CI workflow has a read-only token, cancels superseded runs, and bounds every job', () => {
  const wf = fs.readFileSync(WORKFLOW, 'utf8');
  // Declared at the top level so no job inherits whatever the repository default grants, and no
  // job widens it again with a write scope of its own.
  assert.match(wf, /^permissions:[ \t]*\r?\n[ \t]+contents:[ \t]*read[ \t]*\r?$/m, 'the token must be read-only');
  assert.doesNotMatch(wf, /^\s+[a-z-]+:[ \t]*write[ \t]*\r?$/m, 'no scope may be write');
  assert.match(wf, /^concurrency:[ \t]*\r?\n(?:[ \t]+.*\r?\n)*?[ \t]+cancel-in-progress:[ \t]*true\b/m,
    'a new push must cancel the run it supersedes');
  // Without a limit a hung test holds its runner for GitHub's six-hour default.
  const jobCount = (wf.match(/^ {4}[a-z0-9-]+:\s*$/gim) || []).length;
  const timeouts = (wf.match(/^ {8}timeout-minutes:[ \t]*\d+[ \t]*\r?$/gm) || []).length;
  assert.strictEqual(timeouts, jobCount, `every job must set timeout-minutes (${timeouts} set / ${jobCount} jobs)`);
});

// The lexer's oracle tests (every sweep that asks TypeScript or Babel which tokens are data, and the differential
// against the released lexer) skip themselves where the parsers are not installed, so the suite alone proves
// nothing about them: one job must install the parsers and run the same suite with them. A text assertion again,
// for the same reason: what matters is that the versions are exact, that nothing is installed into the plugin,
// and that the three paths the tests read are set.
test('the model-apps CI workflow runs the suite once with pinned TypeScript and Babel parsers and the released lexer', () => {
  const wf = fs.readFileSync(WORKFLOW, 'utf8');
  const start = wf.search(/^ {4}test-model-apps-lexer-oracles:\s*$/m);
  assert.ok(start >= 0, 'a job must run the suite with the parsers');
  const rest = wf.slice(start).split(/\r?\n/).slice(1);
  const end = rest.findIndex((line) => /^ {4}[a-z0-9-]+:\s*$/i.test(line));
  const job = (end === -1 ? rest : rest.slice(0, end)).join('\n');
  // Exact versions: a range would let a new release change what the sweeps judge without a commit.
  assert.match(job, /typescript@\d+\.\d+\.\d+(?![\w.-])/, 'TypeScript must be pinned to one version');
  assert.match(job, /@babel\/parser@\d+\.\d+\.\d+(?![\w.-])/, 'Babel must be pinned to one version');
  assert.doesNotMatch(job, /(?:typescript|@babel\/parser)@(?:latest|next|[\^~<>*])/, 'no range, no tag');
  // Installed outside the plugin, without install scripts: the plugin ships no dependencies.
  assert.match(job, /npm install --prefix "\$RUNNER_TEMP\/[^"]+"[^\n]*--ignore-scripts/, 'the parsers are installed under RUNNER_TEMP with --ignore-scripts');
  assert.doesNotMatch(job, /npm (?:install|ci)(?![^\n]*--prefix)/, 'no install may run in the plugin or the repository');
  // The three paths the tests read.
  for (const name of ['TYPESCRIPT_ORACLE_PATH', 'BABEL_ORACLE_PATH', 'BASE_LIB_PATH']) {
    assert.match(job, new RegExp(`echo "${name}=[^"]+" >> "\\$GITHUB_ENV"`), `${name} must be exported to the later steps`);
  }
  // The released lexer comes from the commit that released it, by its hash (a branch or a tag moves), and the suite
  // is the plugin's own command.
  const commit = /git fetch --no-tags --depth=1 origin ([0-9a-f]{40})\b/.exec(job);
  assert.ok(commit, 'the released lexer is fetched by a full commit hash');
  assert.match(job, /^ {14}run: node scripts\/run-tests\.js[ \t]*$/m, 'the plugin\'s own test command runs');
  assert.match(job, /^ {14}working-directory: plugins\/model-apps[ \t]*$/m, 'from the plugin\'s directory');
  // Where the history has that commit, it must be the release: a hash that names another commit would compare
  // the lexer with the wrong one. (A shallow clone, which is what CI has, does not have it; the job fetches it.)
  let release = null;
  try {
    release = execFileSync('git', ['show', `${commit[1]}:plugins/model-apps/.plugin/plugin.json`], { cwd: path.dirname(WORKFLOW), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    release = null;
  }
  if (release !== null) assert.strictEqual(JSON.parse(release).version, '2.13.0', 'the fetched commit is the 2.13.0 release');
});

// The upgrade tests (workspace-upgrade-*-real-bundle.test.js) need the previous release's SDK bundle, which a shallow checkout does not
// have, and FAIL in CI without it: each job that runs the suite fetches that release by its hash and names the bundle — the same commit
// helpers/previous-bundle.js checks the bundle's SHA-256 against, so the two cannot drift apart on a re-vendor.
test('the model-apps CI workflow gives every suite run the previous release\'s SDK bundle the upgrade tests read', () => {
  const { PREVIOUS_RELEASE, BUNDLE_PATH } = require('./helpers/previous-bundle.js');
  const wf = fs.readFileSync(WORKFLOW, 'utf8');
  for (const id of ['test-model-apps-scripts', 'test-model-apps-lexer-oracles']) {
    const job = workflowJob(wf, id);
    const fetchAt = job.indexOf(`git fetch --no-tags --depth=1 origin ${PREVIOUS_RELEASE}`);
    assert.ok(fetchAt >= 0, `${id} fetches the previous release (${PREVIOUS_RELEASE}) by its hash`);
    assert.ok(job.includes(`git cat-file blob FETCH_HEAD:${BUNDLE_PATH} > "$RUNNER_TEMP/previous-cds-maker-sdk.cjs"`), `${id} extracts its bundle under RUNNER_TEMP`);
    assert.match(job, /echo "MODEL_APPS_PREVIOUS_BUNDLE=\$RUNNER_TEMP\/previous-cds-maker-sdk\.cjs" >> "\$GITHUB_ENV"/, `${id} names it to the later steps`);
    assert.ok(fetchAt < job.search(/^ {14}run: node scripts\/run-tests\.js[ \t]*$/m), `${id} fetches it before the suite runs`);
  }
});

// The eval tests and runners read committed fixtures, which a Windows checkout gives CRLF line ends, and the routing runner starts agent CLIs as
// child processes (.cmd shims on Windows), so the eval job runs on every system and Node version the suite job runs on; the lexer's oracle
// sweeps compare it with parsers whose identifier tables are not those of the Node version's engine, so they run on both Node versions. Text
// assertions again: a list is read from the job's own `matrix:` block, in either form YAML writes it.
//   matrix:
//       os:
//           - ubuntu-latest
//       node: [20, 22]
function workflowJob(wf, id) {
  const start = wf.search(new RegExp(`^ {4}${id}:\\s*$`, 'm'));
  assert.ok(start >= 0, `the workflow has a job ${id}`);
  const rest = wf.slice(start).split(/\r?\n/).slice(1);
  const end = rest.findIndex((line) => /^ {4}[a-z0-9-]+:\s*$/i.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}
function matrixList(job, key) {
  const lines = job.split('\n');
  const at = lines.findIndex((line) => line.startsWith(`                ${key}:`));
  if (at === -1) return null;
  const inline = /\[([^\]]*)\]\s*$/.exec(lines[at]);
  if (inline) return inline[1].split(',').map((item) => item.trim()).filter(Boolean);
  const items = [];
  for (const line of lines.slice(at + 1)) {
    const item = /^ {20}- (\S+)\s*$/.exec(line);
    if (!item) break;
    items.push(item[1]);
  }
  return items;
}
test('the model-apps CI workflow runs the eval job on every system and Node version the suite job runs on, and the lexer oracles on both Node versions', () => {
  const wf = fs.readFileSync(WORKFLOW, 'utf8');
  const suite = workflowJob(wf, 'test-model-apps-scripts');
  const evals = workflowJob(wf, 'test-model-apps-evals');
  const oracles = workflowJob(wf, 'test-model-apps-lexer-oracles');
  assert.deepStrictEqual(matrixList(suite, 'os'), ['ubuntu-latest', 'windows-latest', 'macos-latest']);
  assert.deepStrictEqual(matrixList(suite, 'node'), ['20', '22']);
  assert.deepStrictEqual(matrixList(evals, 'os'), matrixList(suite, 'os'), 'the eval job runs on every system the suite runs on');
  assert.deepStrictEqual(matrixList(evals, 'node'), matrixList(suite, 'node'), 'and on every Node version');
  assert.match(evals, /^ {8}runs-on: \$\{\{ matrix\.os \}\}[ \t]*$/m, 'on the system of its matrix entry');
  assert.match(evals, /^ {18}node-version: \$\{\{ matrix\.node \}\}[ \t]*$/m, 'with the Node version of its matrix entry');
  assert.match(evals, /^ {12}fail-fast: false[ \t]*$/m, 'and one entry that fails does not cancel the others');
  assert.deepStrictEqual(matrixList(oracles, 'node'), matrixList(suite, 'node'), 'the lexer oracles run on every Node version');
  assert.match(oracles, /^ {18}node-version: \$\{\{ matrix\.node \}\}[ \t]*$/m);
});

// --- committed lock files must not carry a registry URL ---------------------------------------
// `resolved` records the exact feed a package came from. Public npm is blocked on some Microsoft
// networks, so a contributor installing through an internal Azure Artifacts feed would rewrite
// every `resolved` to that internal URL and leak it into this OSS repo on the next commit. The
// `.npmrc` (`omit-lockfile-registry-resolved=true`) stops npm writing the field; this test is the
// backstop that catches a lock regenerated without it, or committed from another machine.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const VENDOR_BUILD = path.join(REPO_ROOT, 'plugins', 'model-apps', 'scripts', '_vendor-build');

test('the vendor-build lock file carries no registry URL of any kind', () => {
  const lockPath = path.join(VENDOR_BUILD, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const offenders = [];
  for (const [name, entry] of Object.entries(lock.packages || {})) {
    if (entry && entry.resolved !== undefined) offenders.push(`packages['${name}'] -> ${entry.resolved}`);
  }
  for (const [name, entry] of Object.entries(lock.dependencies || {})) {
    if (entry && entry.resolved !== undefined) offenders.push(`dependencies['${name}'] -> ${entry.resolved}`);
  }
  assert.deepStrictEqual(
    offenders,
    [],
    `package-lock.json must not record a feed URL (an internal Azure Artifacts URL would leak into this OSS repo).\n` +
      `Re-run \`npm install\` in ${VENDOR_BUILD} with its .npmrc present, or delete the "resolved" keys.\nFound:\n  ${offenders.join('\n  ')}`
  );
});

test('the vendor-build lock still pins every platform binary WITH an integrity hash', () => {
  // Stripping `resolved` must not cost supply-chain protection, and regenerating the lock on one
  // OS can silently collapse the tree: a `npm install --package-lock-only` that reuses a Windows
  // node_modules dropped 28 packages to 3, losing every non-Windows esbuild binary that CI needs.
  const lock = JSON.parse(fs.readFileSync(path.join(VENDOR_BUILD, 'package-lock.json'), 'utf8'));
  const pkgs = Object.entries(lock.packages || {}).filter(([name]) => name !== '');
  const missingIntegrity = pkgs.filter(([, e]) => !e.link && e.integrity === undefined).map(([n]) => n);
  assert.deepStrictEqual(missingIntegrity, [], 'every locked package keeps its integrity hash');
  // esbuild ships one optional package per platform; a single-platform lock means the tree was
  // regenerated on one OS and the others were lost.
  const platforms = pkgs.filter(([name]) => name.startsWith('node_modules/@esbuild/'));
  assert.ok(platforms.length >= 10, `expected the full cross-platform esbuild set, found ${platforms.length}: ${platforms.map(([n]) => n).join(', ')}`);
});

test('the .npmrc that prevents the leak sits next to the package.json it governs', () => {
  // npm reads the per-project .npmrc from the directory that OWNS package.json and does NOT walk
  // up, so a repo-root .npmrc alone would NOT cover this lock file — verified with `npm config
  // get` from inside the directory. Deleting this file silently re-enables the leak.
  const npmrc = path.join(VENDOR_BUILD, '.npmrc');
  assert.ok(fs.existsSync(npmrc), `${npmrc} is required: without it npm rewrites "resolved" with the contributor's feed URL`);
  assert.match(fs.readFileSync(npmrc, 'utf8'), /^\s*omit-lockfile-registry-resolved\s*=\s*true\s*$/m);
});

// The `.npmrc` that strips `resolved` only governs the directory that OWNS package.json -- npm does
// NOT walk up -- so it protects _vendor-build and nothing else. Verified: `npm config get` reads
// false from plugins/mobile-apps/template and from the power-pages create-site asset packages,
// each of which has its own package.json. That is the DESIRED scope (those are templates scaffolded
// into user projects; forcing our lockfile policy on a user's project would be wrong), but it means
// a lock file added to any other plugin tomorrow would be unprotected. This sweep is the backstop
// for that: it does not demand the strip everywhere, only that no committed lock leaks a NON-PUBLIC
// feed URL, which is the actual security property.
function findLockFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findLockFiles(full, out);
    else if (entry.name === 'package-lock.json') out.push(full);
  }
  return out;
}

test('NO committed lock file anywhere in the repo records a non-public registry URL', () => {
  const locks = findLockFiles(REPO_ROOT);
  assert.ok(locks.length > 0, 'the sweep must actually find the lock file(s) it is guarding');
  const offenders = [];
  for (const lockPath of locks) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    for (const section of ['packages', 'dependencies']) {
      for (const [name, entry] of Object.entries(lock[section] || {})) {
        const url = entry && entry.resolved;
        if (typeof url !== 'string' || !/^https?:/i.test(url)) continue;
        // Public npm (and its official mirror) are fine in an OSS repo; an internal Azure Artifacts
        // or on-prem feed URL is the leak this guards against.
        const host = new URL(url).host.toLowerCase();
        if (host === 'registry.npmjs.org' || host === 'registry.yarnpkg.com') continue;
        offenders.push(`${path.relative(REPO_ROOT, lockPath)} :: ${section}['${name}'] -> ${url}`);
      }
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    `a committed package-lock.json records a non-public feed URL, which would leak an internal registry into this OSS repo:\n  ${offenders.join('\n  ')}`
  );
});
