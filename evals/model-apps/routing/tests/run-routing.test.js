'use strict';
// Runner tests for run-routing.js. Two seams:
//   * runRouting(opts, { runTrial }) with canned trials — TAP shape, thresholds, exit codes,
//     --compare deltas, --out JSON — without launching anything;
//   * spawnTrial() against tests/fake-agent.js — the real process plumbing: prompt on stdin,
//     streaming parse, kill-on-decision, crash/timeout/isolation errors.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseArgs, runRouting, spawnTrial, DEFAULTS } = require('../run-routing.js');

const RUNNER = path.join(__dirname, '..', 'run-routing.js');
const FAKE = path.join(__dirname, 'fake-agent.js');
const PLUGIN = { pluginName: 'model-apps', pluginSkills: ['app-builder', 'genpage', 'report-issue', 'telemetry'] };
const EVALS = { evals: [
  { id: 1, tier: 'smoke', prompt: 'page please', expect: 'genpage' },
  { id: 2, tier: 'smoke', prompt: 'power pages site', expect: null, trap: 'bleed' },
  { id: 3, tier: 'full', prompt: 'whole app', expect: 'app-builder' },
] };

function parse(argv) {
  const errors = [];
  try {
    return { args: parseArgs(argv, { fail: (m) => { errors.push(m); throw new Error('__fail__'); } }), errors };
  } catch (e) {
    if (e.message !== '__fail__') throw e;
    return { args: null, errors };
  }
}

// ---------- argument parsing ----------

test('parseArgs: defaults and valid flags', () => {
  assert.deepEqual(parse([]).args, DEFAULTS);
  const { args } = parse(['--agent', 'copilot', '--runs', '5', '--threshold', '0.8', '--tier', 'stress', '--eval', '0', '--dry-run']);
  assert.equal(args.agent, 'copilot');
  assert.equal(args.runs, 5);
  assert.equal(args.threshold, 0.8);
  assert.equal(args.tier, 'stress');
  assert.equal(args.eval, 0);
  assert.equal(args.dryRun, true);
});

test('parseArgs: rejects typos and value-less or out-of-range values instead of defaulting', () => {
  for (const argv of [['--agent', 'gemini'], ['--runs', '0'], ['--runs'], ['--threshold', '1.5'], ['--threshold', '0'],
    ['--threshold', 'abc'], ['--tier', 'smoek'], ['--eval', '1.5'], ['--timeout', '--runs'], ['--runz', '3'],
    ['--model', 'gpt%PATH%'], ['--model', 'a b'], ['--model', 'x&calc']]) {
    const { args, errors } = parse(argv);
    assert.equal(args, null, `${argv.join(' ')} must be rejected`);
    assert.ok(errors.length, argv.join(' '));
  }
});

// ---------- runRouting with canned trials ----------

function collect() {
  const lines = [];
  return { write: (l) => lines.push(l), text: () => lines.join('\n') };
}

const canned = (byId) => async (_opts, c) => byId[c.id].shift();

test('runRouting: all cases at threshold → exit 0, TAP per case, results JSON written', async () => {
  const out = collect();
  const file = path.join(os.tmpdir(), `routing-results-${process.pid}.json`);
  try {
    const { exitCode, results } = await runRouting({ ...DEFAULTS, runs: 3, out: file }, {
      evalsData: EVALS, plugin: PLUGIN, write: out.write,
      runTrial: canned({
        1: [{ routedTo: 'genpage' }, { routedTo: 'genpage' }, { routedTo: null }],
        2: [{ routedTo: null, result: { costUsd: 0.01 } }, { routedTo: null }, { routedTo: null }],
        3: [{ routedTo: 'app-builder' }, { routedTo: 'app-builder' }, { routedTo: 'app-builder' }],
      }),
    });
    assert.equal(exitCode, 0, out.text());
    assert.match(out.text(), /^ok 1 - #1 \[smoke\] expect genpage — 2\/3 \(genpage×2, none×1\)$/m);
    assert.match(out.text(), /^ok 2 - #2 \[smoke\] expect none — 3\/3/m);
    assert.match(out.text(), /^# cases 3 \(pass 3, fail 0, error 0\)$/m);
    assert.match(out.text(), /^# cost >= \$0\.01 /m);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.cases.length, 3);
    assert.equal(saved.cases[0].rate, 2 / 3);
    assert.ok(saved.descriptions.genpage && saved.descriptions['app-builder'], 'records a description fingerprint per skill');
    assert.deepEqual(results.summary.pass, 3);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('runRouting: a case under threshold → exit 1 with prompt + trap in the YAML block', async () => {
  const out = collect();
  const { exitCode } = await runRouting({ ...DEFAULTS, runs: 2, tier: 'smoke' }, {
    evalsData: EVALS, plugin: PLUGIN, write: out.write,
    runTrial: canned({ 1: [{ routedTo: 'genpage' }, { routedTo: 'genpage' }], 2: [{ routedTo: 'genpage' }, { routedTo: null }] }),
  });
  assert.equal(exitCode, 1);
  assert.match(out.text(), /^not ok 2 - #2 \[smoke\] expect none — 1\/2/m);
  assert.match(out.text(), /prompt: "power pages site"/);
  assert.match(out.text(), /trap: "bleed"/);
  assert.doesNotMatch(out.text(), /#3/, '--tier filters cases');
});

test('runRouting: every trial of a case errored → exit 2 (harness error, not a routing verdict)', async () => {
  const out = collect();
  const { exitCode } = await runRouting({ ...DEFAULTS, runs: 1, eval: 1 }, {
    evalsData: EVALS, plugin: PLUGIN, write: out.write,
    runTrial: async () => ({ routedTo: null, error: 'claude exited 1 before any routing decision' }),
  });
  assert.equal(exitCode, 2);
  assert.match(out.text(), /error: "claude exited 1/);
});

test('runRouting: --compare prints a delta only for cases whose pass rate moved', async () => {
  const prev = path.join(os.tmpdir(), `routing-prev-${process.pid}.json`);
  fs.writeFileSync(prev, JSON.stringify({ cases: [{ id: 1, rate: 1 }, { id: 2, rate: 1 }] }));
  try {
    const out = collect();
    await runRouting({ ...DEFAULTS, runs: 1, tier: 'smoke', compare: prev }, {
      evalsData: EVALS, plugin: PLUGIN, write: out.write,
      runTrial: canned({ 1: [{ routedTo: null }], 2: [{ routedTo: null }] }),
    });
    assert.match(out.text(), /^# delta #1: 1\.00 → 0\.00$/m);
    assert.doesNotMatch(out.text(), /# delta #2/);
  } finally {
    fs.rmSync(prev, { force: true });
  }
});

test('runRouting: invalid evals.json or an empty filter → exit 2 before any trial', async () => {
  let launched = 0;
  const runTrial = async () => { launched += 1; return { routedTo: null }; };
  const bad = await runRouting({ ...DEFAULTS }, { evalsData: { evals: [{ id: 1, prompt: 'x', expect: 'nope' }] }, plugin: PLUGIN, write: () => {}, runTrial });
  assert.equal(bad.exitCode, 2);
  const none = await runRouting({ ...DEFAULTS, eval: 99 }, { evalsData: EVALS, plugin: PLUGIN, write: () => {}, runTrial });
  assert.equal(none.exitCode, 2);
  assert.equal(launched, 0);
});

test('CLI --dry-run prints the isolated invocation and launches nothing', () => {
  const r = spawnSync(process.execPath, [RUNNER, '--dry-run', '--tier', 'smoke', '--agent', 'copilot'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /# dry run — would launch \d+ case\(s\) × 3 trial\(s\)/);
  assert.match(r.stdout, /copilot .*--plugin-dir .*--available-tools skill view glob grep/);
});

// ---------- spawnTrial against a fake agent (real process plumbing) ----------

function fakeTrial(mode, { prompt = 'build me a page', timeoutMs = 20000 } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-fake-'));
  return spawnTrial({
    agent: 'claude', bin: process.execPath, binArgs: [FAKE], args: [], env: { FAKE_AGENT_MODE: mode },
    prompt, cwd, timeoutMs, plugin: PLUGIN,
  }).finally(() => fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
}

test('spawnTrial: prompt reaches the agent on stdin; a routed agent is killed at the decision', async () => {
  const t = await fakeTrial('route-then-hang', { prompt: 'make me an app' });
  assert.equal(t.routedTo, 'app-builder', 'the fake routes on the prompt text, proving stdin delivery');
  assert.equal(t.error, null);
  assert.equal(t.timedOut, false);
  assert.ok(t.durationMs < 15000, `should stop at the decision, took ${t.durationMs}ms`);
});

test('spawnTrial: a text answer ends the run as a "none" decision', async () => {
  const t = await fakeTrial('answer');
  assert.equal(t.routedTo, null);
  assert.equal(t.error, null);
  assert.equal(t.result.costUsd, 0.001);
});

test('spawnTrial: exiting non-zero before any decision is an error carrying the stderr tail', async () => {
  const t = await fakeTrial('crash');
  assert.match(t.error, /exited 3 before any routing decision: Error: not signed in/);
});

test('spawnTrial: the plugin missing from the init skill list is an error, not a passing "none"', async () => {
  const t = await fakeTrial('no-plugin');
  assert.match(t.error, /plugin skills not loaded: app-builder, genpage/);
});

test('spawnTrial: a silent agent is killed at the timeout and reported as an error, not a "none"', async () => {
  // Graded as `none`, a hung CLI would pass every negative case — a harness failure must read
  // as a harness failure.
  const t = await fakeTrial('hang', { timeoutMs: 1500 });
  assert.equal(t.timedOut, true);
  assert.equal(t.routedTo, null);
  assert.match(t.error, /timed out with no transcript output/);
});

test('spawnTrial: a timeout AFTER transcript output is still an error, never a "none" decision', async () => {
  // The gap a silent-agent test alone misses: Claude always streams an init event (and Copilot
  // message deltas) before deciding, so "any output" must not turn a cut-off run into "none".
  const t = await fakeTrial('init-then-hang', { timeoutMs: 1500 });
  assert.equal(t.timedOut, true);
  assert.equal(t.routedTo, null);
  assert.match(t.error, /timed out before routing \(1 transcript events, no decision\)/);
});

test('spawnTrial: an absolute .cmd shim is launched through the shell (Windows)', { skip: process.platform !== 'win32' }, async () => {
  // npm installs agent CLIs as .cmd shims on Windows, and Node refuses to spawn a batch file
  // without a shell (EINVAL). The directory has a space in it to exercise command quoting.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing shim '));
  const shim = path.join(dir, 'agent.cmd');
  fs.writeFileSync(shim, `@"${process.execPath}" "${FAKE}" %*\r\n`);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-fake-'));
  try {
    const t = await spawnTrial({
      agent: 'claude', bin: shim, args: [], env: { FAKE_AGENT_MODE: 'route-then-hang' },
      prompt: 'build me a page', cwd, timeoutMs: 20000, plugin: PLUGIN,
    });
    assert.equal(t.error, null);
    assert.equal(t.routedTo, 'genpage');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('frontmatterDescription: inline and folded block descriptions both hash their real text', () => {
  const { frontmatterDescription, descriptionFingerprint } = require('../run-routing.js');
  assert.equal(frontmatterDescription('---\nname: a\ndescription: Builds pages.\nuser-invocable: true\n---\nbody'), 'Builds pages.');
  assert.equal(
    frontmatterDescription('---\nname: t\ndescription: >\n  Use this skill when\n  telemetry is mentioned.\nuser-invocable: true\n---\n'),
    'Use this skill when telemetry is mentioned.',
  );
  assert.equal(frontmatterDescription('no frontmatter'), '');
  const fp = descriptionFingerprint();
  // The folded descriptions (report-issue, telemetry) used to hash the literal ">", so two
  // different skills shared one fingerprint. Every skill's fingerprint must now be distinct.
  assert.equal(new Set(Object.values(fp)).size, Object.keys(fp).length, JSON.stringify(fp));
});

test('spawnTrial: a missing executable resolves with an error instead of throwing', async () => {
  const t = await spawnTrial({
    agent: 'claude', bin: path.join(os.tmpdir(), 'definitely-not-an-agent.exe'), args: [], env: {},
    prompt: 'x', cwd: os.tmpdir(), timeoutMs: 5000, plugin: PLUGIN,
  });
  assert.match(t.error, /could not start|exited/);
});
