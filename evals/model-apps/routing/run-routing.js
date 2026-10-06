#!/usr/bin/env node
'use strict';

// Routing (skill-trigger) eval runner for the model-apps plugin.
//
// The offline harnesses next door (genpage/, app-builder/) grade ARTIFACTS a run produced. This
// one grades the decision that happens before any of that: given a user prompt and the plugin's
// skill descriptions, does the agent pick the right skill — `/genpage` for a page in an app that
// already exists, `/app-builder` for a whole app, and NEITHER for Power Pages, canvas, Power
// Automate or a generic web app? The two descriptions explicitly point at each other, so a
// wording change to one can silently start stealing the other's prompts; nothing else catches it.
//
// Each trial launches a real agent CLI headlessly (Claude Code or GitHub Copilot CLI) in an
// isolated empty workspace with ONLY this plugin loaded, streams its JSONL transcript, and kills
// it the moment a plugin skill is invoked (see lib/agents.js for the isolation flags and
// lib/transcript.js for the event shapes). Cost is therefore ~one model turn per trial.
//
// NOT part of the per-PR gate: it needs model credentials, is non-deterministic, and costs money.
// See EVAL_GUIDE.md → "Cadence" and .github/workflows/model-apps-agent-evals.yml.
//
// Usage: node run-routing.js [--agent claude|copilot] [--model <m>] [--runs <n>]
//          [--threshold <0..1|a/b>] [--tier smoke|full|stress] [--eval <id>] [--concurrency <n>]
//          [--timeout <sec>] [--out <results.json>] [--transcripts <dir>] [--compare <prev.json>]
//          [--agent-bin <path>] [--dry-run]
// Exit:  0 every case met the threshold · 1 a case failed · 2 harness error (bad args, agent
//        missing / not signed in, plugin not loaded, or every trial of a case errored)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const { TIERS } = require('../lib/eval-args.js');
const { TranscriptParser, AGENTS } = require('./lib/transcript.js');
const { buildInvocation, quoteForCmd } = require('./lib/agents.js');
const { summarizeCase, validateEvals } = require('./lib/grade.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PLUGIN_DIR = path.join(REPO_ROOT, 'plugins', 'model-apps');
const PLUGIN_NAME = 'model-apps';

const DEFAULTS = { agent: 'claude', model: null, runs: 3, threshold: 2 / 3, thresholdLabel: '2/3', tier: null, eval: null, concurrency: 4, timeout: 180, out: null, transcripts: null, compare: null, agentBin: null, dryRun: false };

const USAGE = `Usage: run-routing.js [options]

  --agent <claude|copilot>  Agent CLI to drive (default: claude)
  --model <name>            Model passed to the agent CLI (default: the CLI's own default)
  --runs <n>                Trials per case (default: 3)
  --threshold <0..1|a/b>    Minimum pass rate per case, compared strictly (default: 2/3)
  --tier <tier>             Only cases of this tier (${TIERS.join(' | ')})
  --eval <id>               Only this case id
  --concurrency <n>         Parallel trials (default: 4)
  --timeout <sec>           Per-trial timeout (default: 180)
  --out <file>              Write machine-readable results JSON
  --transcripts <dir>       Save each trial's raw JSONL transcript (local debugging; may contain local paths)
  --compare <file>          Print per-case pass-rate deltas against an earlier --out file
  --agent-bin <path>        Override the agent executable
  --dry-run                 Print the invocation and selected cases; launch nothing
`;

function parseArgs(argv, { fail = (m) => { console.error(`error: ${m}`); process.exit(2); } } = {}) {
  const a = { ...DEFAULTS };
  const value = (flag, i) => {
    const v = argv[i];
    if (v === undefined || /^--/.test(v)) fail(`${flag} requires a value`);
    return v;
  };
  const int = (flag, raw, min) => {
    if (!/^\d+$/.test(raw) || Number(raw) < min) fail(`${flag} requires an integer >= ${min} (got ${JSON.stringify(raw)})`);
    return Number(raw);
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    switch (f) {
      case '--agent': a.agent = value(f, ++i); if (!AGENTS.includes(a.agent)) fail(`--agent must be one of ${AGENTS.join('|')}`); break;
      case '--model':
        a.model = value(f, ++i);
        // On Windows the agent CLI is a .cmd shim launched through cmd.exe, where `%VAR%` and
        // `!` expand even inside double quotes. Model ids never need those characters, so
        // reject anything outside a plain id charset instead of trusting quoting.
        if (!/^[A-Za-z0-9._:/-]+$/.test(a.model)) fail(`--model must be a plain model id (letters, digits, . _ : / -), got ${JSON.stringify(a.model)}`);
        break;
      case '--runs': a.runs = int(f, value(f, ++i), 1); break;
      case '--threshold': {
        // A decimal in (0, 1] or an exact fraction such as 2/3 — the default — so "2 of 3" never
        // has to be rounded to 0.67 (which 2/3 = 0.666… would then fail under strict comparison).
        const raw = value(f, ++i);
        const frac = /^(\d+)\/(\d+)$/.exec(raw);
        const n = frac ? Number(frac[1]) / Number(frac[2]) : Number(raw);
        const shapeOk = frac ? Number(frac[2]) > 0 : /^(0(\.\d+)?|1(\.0+)?)$/.test(raw);
        if (!shapeOk || !(n > 0 && n <= 1)) fail(`--threshold must be a number in (0, 1] or a fraction such as 2/3 (got ${JSON.stringify(raw)})`);
        a.threshold = n;
        a.thresholdLabel = raw;
        break;
      }
      case '--tier': a.tier = value(f, ++i); if (!TIERS.includes(a.tier)) fail(`--tier must be one of ${TIERS.join('|')}`); break;
      case '--eval': a.eval = int(f, value(f, ++i), 0); break;
      case '--concurrency': a.concurrency = int(f, value(f, ++i), 1); break;
      case '--timeout': a.timeout = int(f, value(f, ++i), 1); break;
      case '--out': a.out = value(f, ++i); break;
      case '--transcripts': a.transcripts = value(f, ++i); break;
      case '--compare': a.compare = value(f, ++i); break;
      case '--agent-bin': a.agentBin = value(f, ++i); break;
      case '--dry-run': a.dryRun = true; break;
      case '--help': case '-h': process.stdout.write(USAGE); process.exit(0); break;
      default: fail(`unknown argument ${JSON.stringify(f)}\n${USAGE}`);
    }
  }
  return a;
}

function pluginSkills(pluginDir = PLUGIN_DIR) {
  return fs.readdirSync(path.join(pluginDir, 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(pluginDir, 'skills', e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
}

/**
 * A SKILL.md frontmatter `description`, inline or as a YAML block scalar:
 *   description: Creates, updates … pages.            ← inline (genpage, app-builder)
 *   description: >                                     ← folded (report-issue, telemetry)
 *     Use this skill when the user wants to …
 * For a block scalar, the value is every following line indented deeper than the key, joined.
 * Reading only the key's own line hashed the literal ">" for folded descriptions, so edits to
 * them never moved the fingerprint.
 */
function frontmatterDescription(md) {
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const lines = (fm ? fm[1] : '').split(/\r?\n/);
  const i = lines.findIndex((l) => /^description:/.test(l));
  if (i < 0) return '';
  const inline = lines[i].replace(/^description:\s*/, '').trim();
  if (!/^[>|][+-]?$/.test(inline)) return inline;
  const body = [];
  for (const l of lines.slice(i + 1)) {
    if (l.trim() && !/^\s/.test(l)) break;
    body.push(l.trim());
  }
  return body.join(' ').trim();
}

/**
 * Fingerprint of what the model routes on — each skill's frontmatter `description:`. Recorded in
 * the results so a --compare between two runs can tell "the descriptions changed" from noise.
 */
function descriptionFingerprint(pluginDir = PLUGIN_DIR) {
  const out = {};
  for (const s of pluginSkills(pluginDir)) {
    const md = fs.readFileSync(path.join(pluginDir, 'skills', s, 'SKILL.md'), 'utf8');
    out[s] = crypto.createHash('sha256').update(frontmatterDescription(md)).digest('hex').slice(0, 12);
  }
  return out;
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (process.platform === 'win32') {
      // child.kill() would end only cmd.exe and orphan the agent beneath it.
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL'); // detached → its own process group
    }
  } catch { /* already gone */ }
}

/**
 * How to launch `bin` with `argv`. Windows: a bare name (PATH lookup) or a .cmd/.bat shim must go
 * through cmd.exe — Node refuses to spawn a batch file without a shell (EINVAL) — so the command
 * itself is quoted too. Shared by the trial and the Copilot skill preflight so both resolve the
 * same executable the same way.
 */
function commandFor(bin, argv) {
  const useShell = process.platform === 'win32' && (!path.isAbsolute(bin) || /\.(cmd|bat)$/i.test(bin));
  return { cmd: useShell ? quoteForCmd(bin) : bin, args: useShell ? argv.map(quoteForCmd) : argv, shell: useShell };
}

/**
 * Copilot CLI does not report its loaded skills in the JSONL stream (Claude's init event does), so
 * ask the CLI itself, with the trial's plugin dir and isolated COPILOT_HOME — the same inputs the
 * session resolves skills from:
 *   copilot --plugin-dir <dir> --no-auto-update skill list --json
 *   → [{ "name": "genpage", "source": "plugin", "path": "<dir>\\skills\\genpage", "enabled": true },
 *      { "name": "customize-cloud-agent", "source": "builtin", "path": "...", "enabled": true }, …]
 * `names` are the enabled skills that come from the plugin under test; `leaks` are enabled skills
 * from anywhere else except the CLI's own builtins (a personal, project or other plugin's skill
 * reaching the trial means the isolation failed and routing could be steered by it).
 * @returns {{names?: string[], leaks?: string[], error?: string}}
 */
function copilotSkillInventory({ bin, binArgs = [], pluginDir, env, cwd }) {
  const { cmd, args, shell } = commandFor(bin, [...binArgs, '--plugin-dir', pluginDir, '--no-auto-update', 'skill', 'list', '--json']);
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, shell, encoding: 'utf8', timeout: 60000, windowsHide: true });
  if (r.error || r.status !== 0) {
    const tail = String(r.stderr || (r.error && r.error.message) || '').trim().split(/\r?\n/).slice(-2).join(' | ');
    return { error: `could not verify Copilot skill loading (\`skill list\` exit ${r.status})${tail ? `: ${tail}` : ''}` };
  }
  let list;
  try { list = JSON.parse(r.stdout); } catch { return { error: 'could not verify Copilot skill loading: `skill list --json` returned unparseable output' }; }
  if (!Array.isArray(list)) return { error: 'could not verify Copilot skill loading: `skill list --json` did not return an array' };
  const norm = (p) => { const s = path.resolve(String(p || '')); return process.platform === 'win32' ? s.toLowerCase() : s; };
  const root = norm(pluginDir) + path.sep;
  const fromPlugin = (s) => s.source === 'plugin' && norm(s.path).startsWith(root);
  const enabled = list.filter((s) => s && s.enabled !== false);
  return {
    names: enabled.filter(fromPlugin).map((s) => s.name),
    leaks: enabled.filter((s) => s.source !== 'builtin' && !fromPlugin(s)).map((s) => `${s.name} (${s.source})`),
  };
}

/**
 * Launch one agent run and resolve when it ROUTED, finished, timed out, or failed to start.
 * Never rejects: every failure becomes `trial.error`, which grading excludes from the pass rate.
 * `loadedSkills` / `loadError` carry a preflight's skill inventory for agents whose transcript does
 * not report it (Copilot); a `loadError` fails the trial before any model call is made.
 */
function spawnTrial({ bin, binArgs = [], args, env, prompt, cwd, timeoutMs, plugin, agent, loadedSkills = null, loadError = null }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const parser = new TranscriptParser(agent, plugin);
    if (loadError) {
      resolve({ error: loadError, routedTo: null, skillCalls: [], loadedSkills, durationMs: 0, stdout: '' });
      return;
    }
    const { cmd, args: argv, shell: useShell } = commandFor(bin, [...binArgs, ...args]);
    let child;
    try {
      child = spawn(cmd, argv, {
        cwd,
        env: { ...process.env, ...env },
        shell: useShell,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ error: `could not start ${bin}: ${err.message}`, routedTo: null, skillCalls: [], durationMs: 0, stdout: '' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let buf = '';
    let timedOut = false;
    let settled = false;
    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(child);
      let error = extra.error || null;
      // "none" is a DECISION only when the run ended on its own without choosing a plugin skill.
      // A run cut off by the timeout has not decided anything — even if it streamed events (an
      // init line, message deltas) first — and graded as `none` it would pass every negative
      // case. So a timeout without a route is always an error, excluded from the pass rate; so is
      // a run that produced no transcript at all (network/auth stall, a CLI that ignored stdin).
      if (!error && parser.routedTo === null) {
        if (timedOut) {
          error = parser.eventCount === 0
            ? 'timed out with no transcript output'
            : `timed out before routing (${parser.eventCount} transcript events, no decision)`;
        } else if (parser.eventCount === 0) {
          error = `${bin} produced no transcript output`;
        } else if (parser.resultError) {
          error = `${parser.resultError} before any routing decision`;
        }
      }
      // Isolation guard: if the plugin's skills are not all loaded, every negative case would
      // "pass" for the wrong reason and positives would look like routing failures — so fail
      // loudly instead. Claude reports its skills in the init event (namespaced
      // `model-apps:genpage`); Copilot's come from the skill-list preflight (bare `genpage`).
      const loaded = parser.loadedSkills || loadedSkills;
      if (!error && loaded) {
        const missing = plugin.pluginSkills.filter((s) => !loaded.includes(`${plugin.pluginName}:${s}`) && !loaded.includes(s));
        if (missing.length) error = `plugin skills not loaded: ${missing.join(', ')} (check --plugin-dir)`;
      }
      resolve({
        routedTo: parser.routedTo,
        skillCalls: parser.skillCalls,
        loadedSkills: loaded,
        result: parser.result,
        timedOut,
        error,
        durationMs: Date.now() - started,
        stdout,
      });
    };
    const timer = setTimeout(() => { timedOut = true; finish(); }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      stdout += s;
      buf += s;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        parser.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (parser.routedTo !== null) { finish(); return; }
      }
    });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('error', (err) => finish({ error: `could not start ${bin}: ${err.message}` }));
    child.on('close', (code) => {
      if (buf) parser.push(buf);
      const tail = stderr.trim().split(/\r?\n/).slice(-3).join(' | ');
      // A run that ends without routing is a valid "none" outcome only if it ended SUCCESSFULLY.
      // Exiting non-zero is an auth/install/runtime failure, not a decision — even when a terminal
      // `result` event was printed first (a failed result is also caught via parser.resultError).
      if (parser.routedTo === null && code !== 0 && !timedOut) {
        finish({ error: `${bin} exited ${code} before any routing decision${tail ? `: ${tail}` : ''}` });
      } else {
        finish();
      }
    });
    child.stdin.on('error', () => { /* agent exited before reading the prompt; 'close' reports it */ });
    child.stdin.end(prompt);
  });
}

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmQuiet(dir) {
  // Windows can hold a handle briefly after taskkill; retry rather than fail the run over cleanup.
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best effort */ }
}

/** Default trial runner: real agent CLI, isolated temp workspace (+ COPILOT_HOME). */
async function runTrialWithAgent(opts, evalCase, plugin) {
  const cwd = mkTemp('mapps-routing-ws-');
  const copilotHome = opts.agent === 'copilot' ? mkTemp('mapps-routing-home-') : undefined;
  try {
    const inv = buildInvocation(opts.agent, { pluginDir: PLUGIN_DIR, model: opts.model, copilotHome });
    const bin = opts.agentBin || inv.bin;
    // Copilot's transcript never lists loaded skills, so verify them up front with the same
    // isolated home and plugin dir; a missing skill or a leaked one is a trial error, not a grade.
    let preflight = {};
    if (opts.agent === 'copilot') {
      const inventory = copilotSkillInventory({ bin, pluginDir: PLUGIN_DIR, env: inv.env, cwd });
      preflight = inventory.error
        ? { loadError: inventory.error }
        : inventory.leaks.length
          ? { loadError: `isolation leak: skills from outside the plugin are loaded: ${inventory.leaks.join(', ')}` }
          : { loadedSkills: inventory.names };
    }
    return await spawnTrial({
      agent: opts.agent,
      bin,
      args: inv.args,
      env: inv.env,
      prompt: evalCase.prompt,
      cwd,
      timeoutMs: opts.timeout * 1000,
      plugin,
      ...preflight,
    });
  } finally {
    rmQuiet(cwd);
    if (copilotHome) rmQuiet(copilotHome);
  }
}

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function yamlStr(s) { return JSON.stringify(String(s)); }

/**
 * Run the selected cases and print TAP. `deps.runTrial` is the seam tests use to grade canned
 * trials without launching an agent.
 * @returns {Promise<{exitCode: number, results: object}>}
 */
async function runRouting(opts, { runTrial = runTrialWithAgent, evalsData, write = (l) => process.stdout.write(`${l}\n`), plugin } = {}) {
  plugin = plugin || { pluginName: PLUGIN_NAME, pluginSkills: pluginSkills() };
  const data = evalsData || JSON.parse(fs.readFileSync(path.join(__dirname, 'evals.json'), 'utf8'));
  const errs = validateEvals(data, plugin.pluginSkills);
  if (errs.length) {
    for (const e of errs) console.error(`error: evals.json: ${e}`);
    return { exitCode: 2, results: null };
  }
  let cases = data.evals;
  if (opts.tier) cases = cases.filter((c) => c.tier === opts.tier);
  if (opts.eval !== null) cases = cases.filter((c) => c.id === opts.eval);
  if (!cases.length) {
    console.error('error: no cases matched the filter');
    return { exitCode: 2, results: null };
  }

  if (opts.dryRun) {
    const inv = buildInvocation(opts.agent, { pluginDir: PLUGIN_DIR, model: opts.model, copilotHome: '<temp COPILOT_HOME>' });
    write(`# dry run — would launch ${cases.length} case(s) × ${opts.runs} trial(s):`);
    write(`#   ${opts.agentBin || inv.bin} ${inv.args.join(' ')}   (prompt on stdin, cwd = empty temp dir)`);
    for (const c of cases) write(`#   #${c.id} [${c.tier}] expect ${c.expect === null ? 'none' : c.expect}: ${c.prompt}`);
    return { exitCode: 0, results: null };
  }

  const jobs = cases.flatMap((c) => Array.from({ length: opts.runs }, (_, t) => ({ c, t })));
  const trials = await pool(jobs, opts.concurrency, async ({ c, t }) => {
    const trial = await runTrial(opts, c, plugin);
    if (opts.transcripts && trial.stdout) {
      fs.mkdirSync(opts.transcripts, { recursive: true });
      fs.writeFileSync(path.join(opts.transcripts, `${c.id}-${t + 1}.${opts.agent}.jsonl`), trial.stdout);
    }
    return { id: c.id, trial };
  });

  const byCase = new Map(cases.map((c) => [c.id, []]));
  for (const { id, trial } of trials) byCase.get(id).push(trial);

  const prev = opts.compare ? JSON.parse(fs.readFileSync(opts.compare, 'utf8')) : null;
  const prevRate = new Map(prev ? prev.cases.map((c) => [c.id, c.rate]) : []);

  write('TAP version 13');
  write(`# agent ${opts.agent} · model ${opts.model || '(cli default)'} · runs ${opts.runs} · threshold ${opts.thresholdLabel || opts.threshold}`);
  write(`1..${cases.length}`);
  const summary = { pass: 0, fail: 0, error: 0, trials: 0, trialErrors: 0, costUsd: 0 };
  const caseResults = [];
  cases.forEach((c, i) => {
    const ts = byCase.get(c.id);
    const s = summarizeCase(c, ts, opts.threshold);
    summary[s.status] += 1;
    summary.trials += ts.length;
    summary.trialErrors += s.errors.length;
    for (const t of ts) if (t.result && typeof t.result.costUsd === 'number') summary.costUsd += t.result.costUsd;
    const dist = Object.entries(s.outcomes).map(([k, v]) => `${k}×${v}`).join(', ') || 'no valid trials';
    const head = `#${c.id} [${c.tier}] expect ${c.expect === null ? 'none' : c.expect} — ${s.passes}/${s.valid} (${dist})`;
    write(`${s.status === 'pass' ? 'ok' : 'not ok'} ${i + 1} - ${head}`);
    if (s.status !== 'pass' || s.errors.length) {
      write('  ---');
      write(`  prompt: ${yamlStr(c.prompt)}`);
      if (c.trap) write(`  trap: ${yamlStr(c.trap)}`);
      for (const e of [...new Set(s.errors)]) write(`  error: ${yamlStr(e)}`);
      write('  ...');
    }
    if (prevRate.has(c.id) && s.rate !== null && prevRate.get(c.id) !== s.rate) {
      write(`# delta #${c.id}: ${prevRate.get(c.id) === null ? 'n/a' : prevRate.get(c.id).toFixed(2)} → ${s.rate.toFixed(2)}`);
    }
    caseResults.push({
      id: c.id, tier: c.tier, prompt: c.prompt, expect: c.expect, accept: c.accept || [],
      status: s.status, rate: s.rate, passes: s.passes, valid: s.valid, outcomes: s.outcomes, errors: s.errors,
      trials: ts.map((t) => ({ routedTo: t.routedTo, skills: (t.skillCalls || []).map((k) => k.raw), timedOut: !!t.timedOut, error: t.error || null, durationMs: t.durationMs })),
    });
  });
  write(`# cases ${cases.length} (pass ${summary.pass}, fail ${summary.fail}, error ${summary.error})`);
  write(`# trials ${summary.trials} (errors ${summary.trialErrors})`);
  // Only runs that reach their `result` event report cost; trials killed at the routing decision
  // never do, so this is a lower bound and is labelled as one.
  if (summary.costUsd) write(`# cost >= $${summary.costUsd.toFixed(2)} (killed trials do not report cost)`);

  const results = {
    schema: 1,
    agent: opts.agent,
    model: opts.model,
    runs: opts.runs,
    threshold: opts.threshold,
    finishedAt: new Date().toISOString(),
    descriptions: descriptionFingerprint(),
    summary,
    cases: caseResults,
  };
  if (opts.out) fs.writeFileSync(opts.out, `${JSON.stringify(results, null, 2)}\n`);
  const exitCode = summary.error ? 2 : summary.fail ? 1 : 0;
  return { exitCode, results };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { exitCode } = await runRouting(opts);
  process.exitCode = exitCode;
}

if (require.main === module) {
  main().catch((err) => { console.error(`error: ${err.stack || err.message}`); process.exit(2); });
}

module.exports = { parseArgs, runRouting, spawnTrial, copilotSkillInventory, pluginSkills, descriptionFingerprint, frontmatterDescription, DEFAULTS };
