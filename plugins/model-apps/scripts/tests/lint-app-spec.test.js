// #560: lint-app-spec.js is the CLI surface for the two gates that previously had none.
// The contract that matters is that it runs the SAME three steps a deploying CLI runs on load
// (migrate -> validate -> lint) — linting the file as written instead of the migrated shape is
// exactly the mistake the `node -e` workaround invited.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');

const { lintSpec } = require('../lint-app-spec.js');

const CLI = path.join(__dirname, '..', 'lint-app-spec.js');

const good = () => ({
  solution: { uniqueName: 'c', publisherPrefix: 'c' },
  app: { name: 'C' },
  entities: [{ schemaName: 'c_order', displayName: 'Order', pluralName: 'Orders', primaryAttribute: { schemaName: 'c_name', displayName: 'Name' }, columns: [] }],
  forms: [], views: [], charts: [],
});

test('a clean spec reports ok with no errors', () => {
  const r = lintSpec(good());
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.profile, 'plan', 'the default profile is plan, not deploy');
});

// Regression contract. validateAppSpec defaults to the DEPLOY profile, which requires every generative
// page to be implemented and every persona job to carry privileges. Both are deliberately absent
// while a spec is being authored — which is exactly when the documented gates run this CLI — so a
// deploy default rejected normal work-in-progress specs and would have broken the authoring flow.
test('the default profile accepts a work-in-progress spec that the deploy profile rejects', () => {
  const s = good();
  s.pages = [{ key: 'ov', name: 'Overview', purpose: 'overview', source: { kind: 'intent' } }];
  s.appShell = { areas: [{ label: 'M', groups: [{ label: 'M', subAreas: [{ title: 'Overview', page: 'ov' }] }] }] };

  const dflt = lintSpec(s);
  assert.strictEqual(dflt.ok, true, `an intent page must pass the default gate: ${JSON.stringify(dflt.errors)}`);

  const deploy = lintSpec(s, { profile: 'deploy' });
  assert.strictEqual(deploy.ok, false, 'deploy still requires the page to be implemented');
  assert.ok(deploy.errors.some((e) => /must be implemented/.test(e)), JSON.stringify(deploy.errors));
});

test('an unknown profile is rejected by name rather than silently falling back', () => {
  const r = lintSpec(good(), { profile: 'nope' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /unknown profile 'nope'/.test(e)), JSON.stringify(r.errors));
});

// Regression contract. `|| 'plan'` treated the EMPTY STRING as "not supplied". A supplied-but-empty
// profile is a caller who asked for a profile and gave none — most plausibly a CI wrapper whose
// `--profile=$PROFILE` expanded empty — and folding it into the default silently ran the weaker plan
// gate while the job believed it had requested `deploy`. Only `undefined` may take the default.
test('an EMPTY profile is rejected rather than silently defaulting to plan', () => {
  for (const profile of ['', '   ']) {
    const r = lintSpec(good(), { profile });
    assert.strictEqual(r.ok, false, `profile ${JSON.stringify(profile)} must not be accepted`);
    assert.ok(r.errors.some((e) => /empty profile value|unknown profile/.test(e)), JSON.stringify(r.errors));
    assert.notStrictEqual(r.profile, 'plan', 'must not report the default it did not run');
  }
  assert.strictEqual(lintSpec(good(), { profile: undefined }).profile, 'plan', 'omitted still takes the default');
  assert.strictEqual(lintSpec(good(), {}).profile, 'plan');
});

// Regression contract. validateAppSpec emits non-blocking advisories of its own, which the build narrates.
// Reporting only lint warnings made this CLI quieter than the build it stands in for.
test('warnings from BOTH gates are reported, each tagged with its source', () => {
  const s = good();
  // Two pre-existing (pageId-bearing) pages sharing a name is a validateAppSpec WARNING.
  s.pages = [
    { key: 'a', name: 'Overview', pageId: 'p1', source: { kind: 'tsx', codeFile: 'a.tsx' } },
    { key: 'b', name: 'overview', pageId: 'p2', source: { kind: 'tsx', codeFile: 'b.tsx' } },
  ];
  s.appShell = { areas: [{ label: 'M', groups: [{ label: 'M', subAreas: [{ title: 'A', page: 'a' }, { title: 'B', page: 'b' }] }] }] };
  const r = lintSpec(s);
  assert.ok(r.warnings.some((w) => w.startsWith('schema: ')), `expected a schema-tagged warning: ${JSON.stringify(r.warnings)}`);
});

test('schema (validateAppSpec) findings are reported and tagged "schema:"', () => {
  const s = good();
  delete s.solution;
  const r = lintSpec(s);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('schema: ')), JSON.stringify(r.errors));
});

test('lint (lintAppSpec) findings are reported and tagged "lint:"', () => {
  const s = good();
  // A view filter with a value-taking operator and no value is a lint error, not a schema error.
  s.views = [{ entity: 'c_order', name: 'Mine', columns: ['c_name'], filters: [{ attr: 'c_name', op: 'eq' }] }];
  const r = lintSpec(s);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('lint: ')), JSON.stringify(r.errors));
});

// The load-bearing behaviour: the spec is MIGRATED before either gate sees it. A legacy spec with
// name-based refs is valid only after migration, so linting the raw file would report false errors.
test('the spec is migrated before validation (a legacy spec is not reported as broken)', () => {
  const legacy = {
    ...good(),
    pages: [{ name: 'Sales Overview', codeFile: 'sales.tsx' }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Main', subAreas: [{ title: 'Sales Overview', page: 'Sales Overview' }] }] }] },
  };
  const r = lintSpec(legacy);
  assert.strictEqual(r.schemaVersion, 2, 'migration ran');
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('warnings alone do not fail (so CI can gate on correctness, not advice)', () => {
  const s = good();
  // "Active <Plural>" collides with the stock default view — a documented WARNING.
  s.views = [{ entity: 'c_order', name: 'Active Orders', columns: ['c_name'], activeOnly: true }];
  const r = lintSpec(s);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.length > 0, 'expected the stock-default-view warning');
  assert.ok(r.warnings.every((w) => /^(schema|lint): /.test(w)), `every warning is source-tagged: ${JSON.stringify(r.warnings)}`);
});

function runCli(spec, extraArgs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-app-spec-'));
  const file = path.join(dir, 'app-spec.json');
  fs.writeFileSync(file, JSON.stringify(spec));
  try {
    const stdout = execFileSync(process.execPath, [CLI, '--spec', '@' + file, ...(extraArgs || [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI exits 0 on a clean spec and 1 when a gate fails', () => {
  const ok = runCli(good());
  assert.strictEqual(ok.code, 0, ok.stdout + (ok.stderr || ''));
  assert.match(ok.stdout, /^OK \[profile: plan\] — 0 error\(s\)/m);

  const bad = good();
  delete bad.solution;
  const fail = runCli(bad);
  assert.strictEqual(fail.code, 1);
  assert.match(fail.stderr, /ERROR {2}schema: /);
});

test('CLI --profile deploy is available for gating a final, deployable spec', () => {
  const s = good();
  s.pages = [{ key: 'ov', name: 'Overview', purpose: 'overview', source: { kind: 'intent' } }];
  s.appShell = { areas: [{ label: 'M', groups: [{ label: 'M', subAreas: [{ title: 'Overview', page: 'ov' }] }] }] };
  assert.strictEqual(runCli(s).code, 0, 'passes the default plan gate');
  const deploy = runCli(s, ['--profile', 'deploy']);
  assert.strictEqual(deploy.code, 1);
  assert.match(deploy.stdout, /FAIL \[profile: deploy\]/);
});

// Regression contract. The JSON payload's `ok` must describe the COMMAND's outcome. A warnings-only
// --strict run exits 1, so emitting ok:true there would let a machine consumer read a failure as
// a success.
test('CLI --strict --json reports ok:false and exits 1 on warnings alone', () => {
  const s = good();
  s.views = [{ entity: 'c_order', name: 'Active Orders', columns: ['c_name'], activeOnly: true }];
  const out = runCli(s, ['--strict', '--json']);
  assert.strictEqual(out.code, 1);
  const payload = JSON.parse(out.stdout);
  assert.strictEqual(payload.ok, false, 'JSON status must match the exit code');
  assert.deepStrictEqual(payload.errors, []);
  assert.ok(payload.warnings.length > 0);
  assert.match(out.stderr, /--strict was set/);
  // The misleading "completed with 0 error(s)" summary must not appear for a warnings-only failure.
  assert.doesNotMatch(out.stderr, /completed with 0 error\(s\)/);
});

test('CLI --json on a clean spec reports ok:true and exits 0', () => {
  const out = runCli(good(), ['--json']);
  assert.strictEqual(out.code, 0);
  const payload = JSON.parse(out.stdout);
  assert.strictEqual(payload.ok, true);
  assert.strictEqual(payload.profile, 'plan');
});

test('CLI --strict turns warnings into a failure', () => {
  const s = good();
  s.views = [{ entity: 'c_order', name: 'Active Orders', columns: ['c_name'], activeOnly: true }];
  assert.strictEqual(runCli(s).code, 0, 'warnings alone pass without --strict');
  const strict = runCli(s, ['--strict']);
  assert.strictEqual(strict.code, 1);
  assert.match(strict.stdout, /failed by --strict/);
});

test('CLI reports an unreadable spec by name rather than a generic gate error', () => {
  let out;
  try {
    execFileSync(process.execPath, [CLI, '--spec', '@does-not-exist.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    out = { code: 0 };
  } catch (err) {
    out = { code: err.status, stderr: String(err.stderr || '') };
  }
  assert.strictEqual(out.code, 1);
  assert.match(out.stderr, /could not read spec @does-not-exist\.json/);
});

test('CLI with no --spec prints usage', () => {
  let out;
  try {
    execFileSync(process.execPath, [CLI], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    out = { code: 0 };
  } catch (err) {
    out = { code: err.status, stderr: String(err.stderr || '') };
  }
  assert.strictEqual(out.code, 1);
  assert.match(out.stderr, /Usage: node lint-app-spec\.js/);
});

// Regression contract. parseArgs turns a bare `--flag` into `true`. For a VALUE-taking flag that is a
// usage error, not a default: a bare `--profile` silently falling back to `plan` would skip a
// `deploy` gate a CI job believed it had requested, and a bare `--spec` would reach readJsonArg and
// report "spec is not an object" — a gate verdict about a file the caller never named.
test('CLI rejects a value-taking flag given with no value', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-app-spec-'));
  const file = path.join(dir, 'app-spec.json');
  fs.writeFileSync(file, JSON.stringify(good()));
  try {
    for (const [args, expected] of [
      [[CLI, '--spec'], /--spec needs a path/],
      [[CLI, '--spec', '@' + file, '--profile'], /--profile needs one of: design, plan, deploy, structural/],
    ]) {
      let out;
      try {
        execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        out = { code: 0, stderr: '' };
      } catch (err) {
        out = { code: err.status, stderr: String(err.stderr || '') };
      }
      assert.strictEqual(out.code, 1, `expected a usage failure for ${args.slice(1).join(' ')}`);
      assert.match(out.stderr, expected);
      assert.doesNotMatch(out.stderr, /spec is not an object/, 'a usage error must not surface as a gate verdict');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Regression contract. parseArgs preserves `--profile=` as the EMPTY STRING, which passed the
// bare-flag guard (it is a string) and was then folded into the default by `|| 'plan'`. A CI wrapper
// whose `--profile=$PROFILE` expanded empty therefore ran the weaker plan gate and exited 0 while
// believing it had requested `deploy`.
test('CLI rejects an EMPTY value-taking flag instead of silently taking the default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-app-spec-'));
  const file = path.join(dir, 'app-spec.json');
  fs.writeFileSync(file, JSON.stringify(good()));
  try {
    for (const [args, expected] of [
      [[CLI, '--spec', '@' + file, '--profile='], /--profile needs one of: design, plan, deploy, structural/],
      [[CLI, '--spec', '@' + file, '--profile', ''], /--profile needs one of: design, plan, deploy, structural/],
      [[CLI, '--spec='], /--spec needs a path/],
    ]) {
      let out;
      try {
        execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        out = { code: 0, stdout: '', stderr: '' };
      } catch (err) {
        out = { code: err.status, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') };
      }
      assert.strictEqual(out.code, 1, `expected a usage failure for ${args.slice(1).join(' ')}`);
      assert.match(out.stderr, expected);
      assert.doesNotMatch(out.stdout, /OK \[profile: plan\]/, 'must not run the default gate it was not asked for');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Regression contract. parseArgs accepts any `--name`, so a typo was silently dropped and the
// command ran the DEFAULT plan profile — a CI job reporting success for a gate it never applied.
test('CLI rejects an unknown flag rather than silently running the default gate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-app-spec-'));
  const file = path.join(dir, 'app-spec.json');
  fs.writeFileSync(file, JSON.stringify(good()));
  try {
    for (const [args, expected] of [
      [[CLI, '--spec', '@' + file, '--profle', 'deploy'], /unknown flag\(s\): --profle/],
      [[CLI, '--spec', '@' + file, '--strictt'], /unknown flag\(s\): --strictt/],
      [[CLI, '@' + file], /unexpected argument\(s\)/],
    ]) {
      let out;
      try {
        execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        out = { code: 0, stdout: '', stderr: '' };
      } catch (err) {
        out = { code: err.status, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') };
      }
      assert.strictEqual(out.code, 1, `expected a usage failure for ${args.slice(1).join(' ')}`);
      assert.match(out.stderr, expected);
      assert.doesNotMatch(out.stdout, /OK \[profile: plan\]/, 'a typo must not report a passing gate');
    }
    // The complement: every KNOWN flag combination still runs. (No --strict here: the fixture emits
    // warnings, which --strict correctly turns into a non-zero exit — that is tested separately.)
    const ok = execFileSync(process.execPath, [CLI, '--spec', '@' + file, '--profile', 'plan', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.strictEqual(JSON.parse(ok).ok, true, ok);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Regression contract. The positional guard fired BEFORE --spec was inspected, so the most common
// Windows failure — an unquoted absolute path containing spaces, which the documented flow invites —
// lost its diagnostic. The old message named the truncated file; the new one must too, or it points
// the reader away from the cause by asserting they should have used --spec, which they did.
test('CLI names the truncated --spec value when an unquoted path with spaces splits', () => {
  let out;
  try {
    execFileSync(process.execPath, [CLI, '--spec', '@C:\\Users\\x\\OneDrive', '-', 'Contoso\\app-spec.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    out = { code: 0, stderr: '' };
  } catch (err) {
    out = { code: err.status, stderr: String(err.stderr || '') };
  }
  assert.strictEqual(out.code, 1);
  assert.match(out.stderr, /--spec was parsed as '@C:\\Users\\x\\OneDrive'/);
  assert.match(out.stderr, /quote it/);
});

// Regression contract. The documented invocation is `--spec @<path> --json` and the caller parses
// stdout. A usage error that writes only to stderr leaves stdout empty, and JSON.parse('') throws —
// so an agent following the documented flow crashes instead of reporting the usage message.
test('CLI --json emits a parseable payload for usage errors too, never empty stdout', () => {
  for (const args of [
    [CLI, '--json', '--profle', 'deploy', '--spec', '@x.json'],
    [CLI, '--json', '--spec', '@does-not-exist.json'],
    [CLI, '--json'],
  ]) {
    let out;
    try {
      execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      out = { code: 0, stdout: '', stderr: '' };
    } catch (err) {
      out = { code: err.status, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') };
    }
    assert.strictEqual(out.code, 1, args.join(' '));
    const payload = JSON.parse(out.stdout);
    assert.strictEqual(payload.ok, false);
    assert.ok(Array.isArray(payload.errors) && payload.errors.length > 0, out.stdout);
    assert.ok(payload.errors.every((e) => e.startsWith('usage: ')), `usage errors are tagged so an agent can bucket them: ${out.stdout}`);
  }
});

// Regression contract. --help is a request this tool can answer, not an unknown flag. The sibling
// CLIs in this directory honour it, and rejecting it reads as though the tool is broken.
test('CLI --help prints usage and exits 0', () => {
  const out = execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(out, /Usage: node lint-app-spec\.js/);
});

// Regression contract. authoring-flow.md tells the agent to triage on the schema:/lint: prefix,
// so an untagged error has no bucket. Nothing pinned the invariant on the errors side.
test('EVERY error is source-tagged, including a rejected profile', () => {
  const bad = lintSpec(good(), { profile: 'DEPLOY' });
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.errors.every((e) => /^(schema|lint): /.test(e)), JSON.stringify(bad.errors));

  const s = good();
  delete s.solution;
  s.views = [{ entity: 'c_order', name: 'Mine', columns: ['c_name'], filters: [{ attr: 'c_name', op: 'eq' }] }];
  const r = lintSpec(s);
  assert.ok(r.errors.length > 1);
  assert.ok(r.errors.every((e) => /^(schema|lint): /.test(e)), JSON.stringify(r.errors));
});

// Regression contract. parseArgs accumulates into a plain `{}`, so assigning `flags['__proto__']`
// goes through the inherited setter and never becomes an own property: an allow-list built on
// Object.keys(flags) would miss `--__proto__` entirely AND silently swallow the token after it.
// The allow-list therefore reads the flag NAMES from argv, which cannot be fooled this way.
test('CLI rejects prototype-named flags that never become own properties', () => {
  for (const args of [
    [CLI, '--__proto__', 'deploy', '--spec', '@x.json'],
    [CLI, '--__proto__=deploy', '--spec', '@x.json'],
    [CLI, '--constructor', '--spec', '@x.json'],
  ]) {
    let out;
    try {
      execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      out = { code: 0, stderr: '' };
    } catch (err) {
      out = { code: err.status, stderr: String(err.stderr || '') };
    }
    assert.strictEqual(out.code, 1, `expected a usage failure for ${args.slice(1).join(' ')}`);
    assert.match(out.stderr, /unknown flag\(s\): --(__proto__|constructor)/);
  }
});
