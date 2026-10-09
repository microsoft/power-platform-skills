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
  assert.equal(DEFAULTS.threshold, 2 / 3, 'the default is the exact fraction, not a rounded 0.67');
  const frac = parse(['--threshold', '3/4']).args;
  assert.equal(frac.threshold, 0.75);
  assert.equal(frac.thresholdLabel, '3/4');
  assert.equal(parse(['--threshold', '1']).args.threshold, 1);
});

test('parseArgs: rejects typos and value-less or out-of-range values instead of defaulting', () => {
  for (const argv of [['--agent', 'gemini'], ['--runs', '0'], ['--runs'], ['--threshold', '1.5'], ['--threshold', '0'],
    ['--threshold', 'abc'], ['--threshold', '4/3'], ['--threshold', '0/3'], ['--threshold', '2/0'],
    ['--tier', 'smoek'], ['--eval', '1.5'], ['--timeout', '--runs'], ['--runz', '3'],
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

const { setTimeout: sleep } = require('node:timers/promises');

// How long a test waits for something that WILL happen: the fake agent to start, a killed process
// to let go of its directory. The wait ends the moment the thing happens, so the bound adds no time
// to a passing run — it turns a real hang into a failure that names what never happened.
const WAIT_LIMIT_MS = 60000;

async function until(condition, what) {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`${what} did not happen within ${WAIT_LIMIT_MS}ms`);
    await sleep(10);
  }
}

const hasExited = (child) => child.exitCode !== null || child.signalCode !== null;

// A killed agent is torn down by the OS a moment AFTER the trial resolves, and until then it still holds
// its working directory: removing it straight away failed with `EBUSY: resource busy or locked, rmdir
// …routing-fake-…` on a loaded Windows machine (Node 22, one run in twenty). So a directory is removed
// by retrying while it is reported in use, up to a bound — never by hoping a kill has finished.
async function removeWhenFree(dir) {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(e.code) || Date.now() > deadline) throw e;
      await sleep(50);
    }
  }
}

// The deadline of a trial, in the test's hands: spawnTrial arms it with the configured `timeoutMs`, and
// `fire()` is the moment that time would have passed. A real timer raced the agent's start-up — a timeout
// "after output" needs the output first, and Node can take longer than any fixed timeout to print it.
function manualClock() {
  const clock = {
    callback: null,
    armedFor: null,
    setTimeout(callback, ms) { clock.callback = callback; clock.armedFor = ms; return clock; },
    clearTimeout() { clock.callback = null; },
    get armed() { return clock.callback !== null; },
    fire() {
      const callback = clock.callback;
      assert.ok(callback, 'the deadline is armed');
      clock.callback = null;
      callback();
    },
  };
  return clock;
}

function fakeTrial(mode, { prompt = 'build me a page', timeoutMs = 20000, agent = 'claude', env = {}, loadedSkills, loadError, clock, onStart } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-fake-'));
  return spawnTrial({
    agent, bin: process.execPath, binArgs: [FAKE], args: [], env: { FAKE_AGENT_MODE: mode, ...env },
    prompt, cwd, timeoutMs, plugin: PLUGIN, loadedSkills, loadError, clock, onStart,
  }).finally(() => removeWhenFree(cwd));
}

test('spawnTrial: a FAILED terminal result is an error, never a "none" decision (both CLIs, any exit code)', async () => {
  // Graded as "none", a run that crashed after printing its result would pass every negative
  // case. Exit 1 is caught by the exit-code check; exit 0 proves the failed RESULT is caught alone.
  for (const exit of ['1', '0']) {
    const claude = await fakeTrial('claude-failed', { agent: 'claude', env: { FAKE_AGENT_EXIT: exit } });
    assert.equal(claude.routedTo, null);
    assert.match(claude.error || '', exit === '1' ? /exited 1 before any routing decision/ : /claude result error_during_execution \(is_error\) before any routing decision/, `claude exit ${exit}`);
    const copilot = await fakeTrial('copilot-failed', { agent: 'copilot', env: { FAKE_AGENT_EXIT: exit } });
    assert.equal(copilot.routedTo, null);
    assert.match(copilot.error || '', exit === '1' ? /exited 1 before any routing decision/ : /copilot result exitCode 1 before any routing decision/, `copilot exit ${exit}`);
  }
  // A successful run that answers in text is still the legitimate "none".
  const ok = await fakeTrial('answer');
  assert.equal(ok.error, null);
});

test('spawnTrial: prompt reaches the agent on stdin; a routed agent is killed at the decision', async () => {
  // The deadline is never fired here, so only the decision can end the run — however long this machine
  // takes to start the agent. (A wall-clock bound on `durationMs` failed a slow run for being slow.)
  const clock = manualClock();
  let child;
  const t = await fakeTrial('route-then-hang', { prompt: 'make me an app', clock, onStart: (s) => { child = s.child; } });
  assert.equal(t.routedTo, 'app-builder', 'the fake routes on the prompt text, proving stdin delivery');
  assert.equal(t.error, null);
  assert.equal(t.timedOut, false);
  assert.equal(clock.armed, false, 'the decision disarmed the deadline instead of leaving it running');
  // `route-then-hang` never exits on its own, so it has gone only because the harness killed it.
  await until(() => hasExited(child), 'the routed agent being killed');
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
  // as a harness failure. The deadline is fired by the test once the agent is really running and silent
  // (it wrote its ready file), so nothing here depends on how long this machine takes to start Node.
  const clock = manualClock();
  const ready = path.join(os.tmpdir(), `routing-ready-${process.pid}-${Date.now()}`);
  let child;
  const trial = fakeTrial('hang', { timeoutMs: 1500, clock, env: { FAKE_AGENT_READY_FILE: ready }, onStart: (s) => { child = s.child; } });
  try {
    await until(() => fs.existsSync(ready), 'the silent agent starting');
    assert.equal(clock.armedFor, 1500, 'the deadline is armed with the configured timeout');
    clock.fire();
    const t = await trial;
    assert.equal(t.timedOut, true);
    assert.equal(t.routedTo, null);
    assert.match(t.error, /timed out with no transcript output/);
    // `hang` never exits on its own, so it has gone only because the harness killed it at the deadline.
    await until(() => hasExited(child), 'the silent agent being killed');
  } finally {
    // An assertion above must not leave a running agent holding the test process open.
    if (clock.armed) clock.fire();
    await trial.catch(() => {});
    fs.rmSync(ready, { force: true });
  }
});

test('spawnTrial: a timeout AFTER transcript output is still an error, never a "none" decision', async () => {
  // The gap a silent-agent test alone misses: Claude always streams an init event (and Copilot
  // message deltas) before deciding, so "any output" must not turn a cut-off run into "none".
  // The deadline is fired only after the parser has read the init event, so the event always comes
  // BEFORE the timeout: a fixed 1.5 s timeout raced the agent's start-up and read "no transcript output"
  // whenever Node took longer than that to print its first line.
  const clock = manualClock();
  let parser;
  let child;
  const trial = fakeTrial('init-then-hang', { timeoutMs: 1500, clock, onStart: (s) => { parser = s.parser; child = s.child; } });
  try {
    await until(() => parser.eventCount >= 1, 'the parser reading the init event');
    clock.fire();
    const t = await trial;
    assert.equal(t.timedOut, true);
    assert.equal(t.routedTo, null);
    assert.match(t.error, /timed out before routing \(1 transcript events, no decision\)/);
    await until(() => hasExited(child), 'the cut-off agent being killed');
  } finally {
    if (clock.armed) clock.fire();
    await trial.catch(() => {});
  }
});

test('spawnTrial: an agent that starts slower than the configured timeout still gets its output before the deadline', async () => {
  // The race itself, made to happen on purpose: the agent needs 1.7 s to get going and the configured
  // timeout is 1.5 s. On a real timer the deadline would pass first and the trial would report "no
  // transcript output"; on the test's clock it fires only after the init event was read.
  const clock = manualClock();
  let parser;
  const trial = fakeTrial('init-then-hang', { timeoutMs: 1500, clock, env: { FAKE_AGENT_START_DELAY_MS: '1700' }, onStart: (s) => { parser = s.parser; } });
  try {
    await until(() => parser.eventCount >= 1, 'the slow agent printing its init event');
    clock.fire();
    const t = await trial;
    assert.match(t.error, /timed out before routing \(1 transcript events, no decision\)/);
  } finally {
    if (clock.armed) clock.fire();
    await trial.catch(() => {});
  }
});

test('spawnTrial: with no injected clock the deadline is a real timer, and it ends a silent agent', async () => {
  // This one runs on the real clock, and still cannot race: a silent agent prints nothing, so whether it
  // had finished starting when the timer went off changes nothing about what the trial reports.
  const t = await fakeTrial('hang', { timeoutMs: 300 });
  assert.equal(t.timedOut, true);
  assert.equal(t.routedTo, null);
  assert.match(t.error, /timed out with no transcript output/);
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
    await removeWhenFree(dir);
    await removeWhenFree(cwd);
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

// ---------- Copilot skill-load preflight ----------

const { copilotSkillInventory } = require('../run-routing.js');

function inventory(shape) {
  const pluginDir = path.join(os.tmpdir(), 'fake plugin dir', 'model-apps');
  return copilotSkillInventory({ bin: process.execPath, binArgs: [FAKE], pluginDir, env: { FAKE_SKILL_LIST: shape }, cwd: os.tmpdir() });
}

test('copilotSkillInventory: plugin skills come from the plugin dir; builtins are neither loaded-plugin nor leaks', () => {
  const inv = inventory('ok');
  assert.deepEqual(inv.names, ['app-builder', 'genpage', 'report-issue', 'telemetry']);
  assert.deepEqual(inv.leaks, []);
  assert.equal(inv.error, undefined);
});

test('copilotSkillInventory: missing plugin skills, a leaked personal skill, and a failed or garbled listing', () => {
  assert.deepEqual(inventory('missing').names, []);
  assert.deepEqual(inventory('leak').leaks, ['brainstorming (personal)']);
  assert.match(inventory('broken').error, /could not verify Copilot skill loading \(`skill list` exit 2\): Error: not signed in/);
  assert.match(inventory('garbage').error, /unparseable output/);
});

test('spawnTrial(copilot): a successful text answer with the plugin skills NOT loaded is an error, not a "none"', async () => {
  // The case Copilot's transcript cannot reveal: without the preflight inventory this run would
  // grade as a clean "none" and pass every negative case.
  const t = await fakeTrial('copilot-answer', { agent: 'copilot', loadedSkills: ['customize-cloud-agent'] });
  assert.match(t.error || '', /plugin skills not loaded: app-builder, genpage, report-issue, telemetry/);
  const ok = await fakeTrial('copilot-answer', { agent: 'copilot', loadedSkills: ['app-builder', 'genpage', 'report-issue', 'telemetry'] });
  assert.equal(ok.error, null);
  assert.equal(ok.routedTo, null);
});

test('spawnTrial: a preflight loadError fails the trial without launching the agent', async () => {
  const t = await fakeTrial('route-then-hang', { agent: 'copilot', loadError: 'isolation leak: skills from outside the plugin are loaded: brainstorming (personal)' });
  assert.match(t.error, /isolation leak/);
  assert.equal(t.stdout, '', 'nothing was spawned');
  assert.equal(t.routedTo, null);
});