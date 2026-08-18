'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pluginTestFiles, sdkTestSpec, summarize } = require('../run-tests.js');

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

// --- CI workflow scoping ---------------------------------------------------------------------
// The plugin's workflow must stay scoped to THIS plugin. A widened path filter would spend CI on
// every unrelated PR, and (worse) make an unrelated plugin's red build look like a model-apps
// failure. This is a text assertion rather than a YAML parse because the repo ships no YAML
// dependency and the properties that matter are all line-level.
const WORKFLOW = path.resolve(__dirname, '..', '..', '..', '..', '.github', 'workflows', 'model-apps-script-tests.yml');

test('the model-apps CI workflow triggers ONLY on model-apps paths', () => {
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
      g.startsWith('plugins/model-apps/') || g.startsWith('evals/model-apps/') || g.endsWith('model-apps-script-tests.yml'),
      `path filter "${g}" is not scoped to model-apps — this workflow must not run for other plugins`
    );
  }
  // And it must not be scoped so tightly that the plugin's own code stops triggering it.
  assert.ok(globs.some((g) => g.startsWith('plugins/model-apps/')), 'the plugin source must trigger the workflow');
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
