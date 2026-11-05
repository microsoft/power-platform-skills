'use strict';
// helpers/own-temp-folder.js: a test file that requires it works in a temp folder of its own inside the temp folder it was given, so the
// folder lib/temp-workspace.js keeps the plugin's workspaces in is that file's alone — and the folder is gone when the file ends, unless a
// test left something in it, which the suite's runner must still see. Its name is short whatever the file is called, so a workspace two levels
// below it still fits in Windows' path limit under a long temp folder. Each case runs a small test file in a process of its own, as
// `node --test` does, with a temp folder this test made.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { withTempDir } = require('../run-tests.js');
const { workspaceParent } = require('../lib/temp-workspace.js');

const HELPER = path.join(__dirname, 'helpers', 'own-temp-folder.js');
const TEMP_WORKSPACE = path.join(__dirname, '..', 'lib', 'temp-workspace.js');
// What the folder of a test file called `name` starts with: `own-`, the first letter of each word of the name before `.test.js` (at most six), four
// hex digits of a hash of the whole name — `solution-settings-real-bundle.test.js` is `own-ssrb-<4 hex>-` — and mkdtemp adds six characters.
function ownTempStart(name) {
  const letters = name.replace(/\.test\.js$/, '').split(/[^A-Za-z0-9]+/).filter(Boolean).map((word) => word[0].toLowerCase()).join('').slice(0, 6);
  return `own-${letters}-${crypto.createHash('sha256').update(name).digest('hex').slice(0, 4)}-`;
}
const OWN_TEMP_NAME = /^own-[a-z0-9]{1,6}-[0-9a-f]{4}-[A-Za-z0-9]{6}$/;

// A test file that requires the helper first (unless `helper` is false: the plain layout, as before the helper), makes a workspace with the real
// maker and leaves it to the end of the process, which removes it (lib/temp-workspace.js, THE END OF A RUN) — and, when `OWN_TEMP_LEAVE` is set,
// leaves a file of its own in the temp folder. What it saw is written to `OWN_TEMP_REPORT`, outside the temp folder.
function probeSource({ helper, prefix }) {
  return [
    "'use strict';",
    helper ? `const { ownTemp } = require(${JSON.stringify(HELPER)});` : 'const ownTemp = null;',
    "const test = require('node:test');",
    "const fs = require('node:fs');",
    "const os = require('node:os');",
    "const path = require('node:path');",
    `const { makeTempWorkspace, workspaceParent } = require(${JSON.stringify(TEMP_WORKSPACE)});`,
    "test('a workspace in the plugin folder of the temp folder', () => {",
    `  const workspace = makeTempWorkspace(${JSON.stringify(prefix)});`,
    "  const env = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };",
    "  fs.writeFileSync(process.env.OWN_TEMP_REPORT, JSON.stringify({ ownTemp, tmpdir: os.tmpdir(), env, parent: workspaceParent(), workspace }));",
    "  if (process.env.OWN_TEMP_LEAVE) fs.writeFileSync(path.join(os.tmpdir(), 'left-behind.txt'), 'a test that forgot to clean up');",
    "});",
    '',
  ].join('\n');
}

// Runs the probe, as a test file called `name`, with `temp` as its temp folder; answers its exit status and what it reported.
function runProbe(temp, { leave = false, name = 'probe.test.js', helper = true, prefix = 'probe-' } = {}) {
  const dir = makeTempDir('otf-probe-');
  const file = path.join(dir, name);
  const report = path.join(dir, 'report.json');
  fs.writeFileSync(file, probeSource({ helper, prefix }));
  const env = withTempDir(process.env, temp);
  for (const key of Object.keys(env)) if (/^NODE_TEST_CONTEXT$/i.test(key)) delete env[key];
  Object.assign(env, { OWN_TEMP_REPORT: report, POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1' }, leave ? { OWN_TEMP_LEAVE: '1' } : {});
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, output, seen: fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null }));
  });
}

test('a test file that requires it works in a folder of its own inside the temp folder it was given, and the folder is gone when the file ends', async () => {
  const temp = makeTempDir('otf-given-');
  const { status, output, seen } = await runProbe(temp);
  assert.strictEqual(status, 0, output);
  assert.ok(seen, output);
  assert.strictEqual(path.dirname(seen.ownTemp), temp, 'inside the temp folder the process was given');
  assert.match(path.basename(seen.ownTemp), OWN_TEMP_NAME);
  assert.ok(path.basename(seen.ownTemp).startsWith(ownTempStart('probe.test.js')), `named for the test file: ${path.basename(seen.ownTemp)}`);
  assert.deepStrictEqual([seen.tmpdir, seen.env.TEMP, seen.env.TMP, seen.env.TMPDIR], [seen.ownTemp, seen.ownTemp, seen.ownTemp, seen.ownTemp], 'os.tmpdir() and the three variables name it');
  assert.strictEqual(seen.parent, workspaceParent({ os: { tmpdir: () => seen.ownTemp } }), 'the plugin\'s workspace folder is the one in it');
  assert.strictEqual(path.dirname(seen.workspace), seen.parent, 'and the workspace was made there');
  // The end of the process removed the workspace and the plugin's folder (lib/temp-workspace.js), and then this folder: nothing is left.
  assert.deepStrictEqual(fs.readdirSync(temp), []);
});

test('what a test leaves behind keeps the folder, with what was left in it, in the temp folder the runner checks', async () => {
  const temp = makeTempDir('otf-given-');
  const { status, output, seen } = await runProbe(temp, { leave: true });
  assert.strictEqual(status, 0, output);
  assert.deepStrictEqual(fs.readdirSync(temp), [path.basename(seen.ownTemp)], 'the folder stays, so the runner names it');
  assert.deepStrictEqual(fs.readdirSync(seen.ownTemp), ['left-behind.txt'], 'with what was left — the workspace and the plugin\'s folder are gone');
});

test('two test files that run at once, given one temp folder, work in two folders of their own', async () => {
  const temp = makeTempDir('otf-given-');
  const runs = await Promise.all([runProbe(temp), runProbe(temp)]);
  for (const { status, output } of runs) assert.strictEqual(status, 0, output);
  const [one, two] = runs.map(({ seen }) => seen);
  assert.notStrictEqual(one.ownTemp, two.ownTemp);
  assert.notStrictEqual(one.parent, two.parent, 'so neither can remove the plugin folder the other is making a workspace in');
  assert.deepStrictEqual(fs.readdirSync(temp), []);
});

// Every workspace is two levels below the file's own temp folder, and Windows refuses fs.mkdtempSync a folder whose path is 248 characters or more.
// A temp folder of LONG_ROOT characters is long, but one the plain layout fits in: there the longest-named file that requires the helper, making a
// workspace named like the longest a script makes, must still get it in its own plugin folder. A folder named with the whole file name did not
// (measured: the workspace went to the plain temp folder), and on every system its name broke the bound below.
const LONG_ROOT = 144;
// The longest prefix a script gives lib/temp-workspace.js: download-model-app.js's (provision-solution.js's is as long).
const LONGEST_PREFIX = 'model-app-download-';
const LONGEST_FILE = fs.readdirSync(__dirname)
  .filter((name) => name.endsWith('.test.js'))
  .sort((a, b) => b.length - a.length || a.localeCompare(b))
  .find((name) => fs.readFileSync(path.join(__dirname, name), 'utf8').includes("require('./helpers/own-temp-folder.js')"));

test('its name is short whatever the test file is called: under a long temp folder the plain layout fits in, the longest-named file still gets its workspace in its own plugin folder', async (t) => {
  assert.ok(LONGEST_FILE, 'some test file requires the helper');
  const base = makeTempDir('otf-long-');
  const padding = LONG_ROOT - base.length - 1;
  if (padding < 1) {
    t.skip(`the temp folder is ${base.length} characters long already, past the ${LONG_ROOT} this test builds`);
    return;
  }
  const root = path.join(base, 'p'.repeat(padding));
  fs.mkdirSync(root);
  assert.strictEqual(root.length, LONG_ROOT);
  // The root is usable: with no folder of the file's own, the workspace is made in the plugin folder of the root itself.
  const plain = await runProbe(root, { name: LONGEST_FILE, helper: false, prefix: LONGEST_PREFIX });
  assert.strictEqual(plain.status, 0, plain.output);
  assert.strictEqual(path.dirname(plain.seen.workspace), workspaceParent({ os: { tmpdir: () => root } }), `the plain layout fits: ${plain.seen.workspace}`);
  const own = await runProbe(root, { name: LONGEST_FILE, prefix: LONGEST_PREFIX });
  assert.strictEqual(own.status, 0, own.output);
  assert.strictEqual(path.dirname(own.seen.ownTemp), root);
  assert.strictEqual(path.dirname(own.seen.workspace), workspaceParent({ os: { tmpdir: () => own.seen.ownTemp } }),
    `${LONGEST_FILE}'s workspace is in the plugin folder of its own temp folder, not the plain temp folder: ${own.seen.workspace} (${own.seen.workspace.length} characters)`);
  const name = path.basename(own.seen.ownTemp);
  assert.match(name, OWN_TEMP_NAME, `a short name, at most 22 characters: ${name}`);
  assert.ok(name.startsWith(ownTempStart(LONGEST_FILE)), `named for ${LONGEST_FILE}: ${name}`);
  assert.deepStrictEqual(fs.readdirSync(root), [], 'and neither run left anything');
});