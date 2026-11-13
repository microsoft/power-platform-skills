'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { hashFile, hashTree } = require('../../scripts/lib/eval-evidence.js');

const HASH = /^[a-f0-9]{64}$/;
const NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const CODE = /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/;
const DAY = 86400000;
const MAX_AGE_DAYS = 30;

function requireValue(condition, message) {
  if (!condition) throw new Error(`Invalid evaluation summary: ${message}`);
}

function fields(value, keys) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'expected object');
  requireValue(Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)), `expected only ${keys.join(', ')}`);
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value);
}

function runUrl(value) {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    // Only canonical Actions run pages are public provenance links. Userinfo,
    // fragments, query strings and lookalike github.com hosts are rejected.
    return url.origin === 'https://github.com' && !url.username && !url.password &&
      !url.search && !url.hash && /^\/[\w.-]+\/[\w.-]+\/actions\/runs\/[1-9]\d*$/.test(url.pathname) && url.href === value;
  } catch { return false; }
}

function validateSummary(summary) {
  const summaryFields = ['schemaVersion', 'plugin', 'commit', 'generatedAt', 'model', 'judgeModel', 'runUrl', 'pluginHash', 'runtimeHash', 'suites'];
  if (summary?.schemaVersion === 3) summaryFields.push('reasoningEffort', 'judgeReasoningEffort');
  fields(summary, summaryFields);
  requireValue([1, 2, 3].includes(summary.schemaVersion) && typeof summary.plugin === 'string' && NAME.test(summary.plugin), 'schemaVersion or plugin');
  requireValue(typeof summary.commit === 'string' && /^[a-f0-9]{40,64}$/.test(summary.commit), 'commit');
  requireValue(typeof summary.generatedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(summary.generatedAt) && Number.isFinite(Date.parse(summary.generatedAt)), 'generatedAt');
  // Date.parse normalizes impossible dates such as "2026-02-30T12:00:00Z".
  // Compare calendar/time components after parsing; optional fractional seconds
  // (".1Z", ".10Z", ".100Z") all identify the same permitted instant.
  requireValue(new Date(summary.generatedAt).toISOString().slice(0, 19) === summary.generatedAt.slice(0, 19), 'calendar date');
  requireValue(text(summary.model) && text(summary.judgeModel), 'model identity');
  if (summary.schemaVersion === 3) {
    const efforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
    requireValue(efforts.includes(summary.reasoningEffort) && efforts.includes(summary.judgeReasoningEffort), 'reasoning effort');
    requireValue(summary.model !== summary.judgeModel, 'judge must differ from agent');
  }
  requireValue(runUrl(summary.runUrl) && HASH.test(summary.pluginHash), 'runUrl or pluginHash');
  requireValue(HASH.test(summary.runtimeHash), 'runtimeHash');
  requireValue(Array.isArray(summary.suites) && summary.suites.length > 0, 'suites');
  const skills = new Set();
  for (const suite of summary.suites) {
    fields(suite, ['skill', 'skillHash', 'suiteHash', 'runs', 'expectedCases', 'results']);
    requireValue(typeof suite.skill === 'string' && NAME.test(suite.skill) && !skills.has(suite.skill), 'duplicate or invalid skill');
    skills.add(suite.skill);
    requireValue(HASH.test(suite.skillHash) && HASH.test(suite.suiteHash), 'suite hashes');
    requireValue(Number.isSafeInteger(suite.runs) && suite.runs > 0 && suite.runs <= 1000, 'runs');
    requireValue(Array.isArray(suite.expectedCases) && suite.expectedCases.length > 0 && Array.isArray(suite.results), 'cases or results');
    const cases = new Set();
    for (const item of suite.expectedCases) {
      fields(item, ['name', 'kind']);
      requireValue(text(item.name) && ['capability', 'dormancy'].includes(item.kind), 'case name or kind');
      const key = JSON.stringify([item.name, item.kind]);
      requireValue(!cases.has(key), 'duplicate expected case');
      cases.add(key);
    }
    const records = new Set();
    for (const result of suite.results) {
      const resultFields = ['name', 'kind', 'variant', 'trial', 'status', 'score', 'checks', 'tokens', 'durationMs', 'error'];
      if (summary.schemaVersion >= 2) resultFields.push('agentUsage', 'judgeUsage');
      fields(result, resultFields);
      requireValue(cases.has(JSON.stringify([result.name, result.kind])), 'unexpected case');
      requireValue(['baseline', 'skilled'].includes(result.variant) && Number.isSafeInteger(result.trial) && result.trial >= 0 && result.trial < suite.runs, 'role or trial');
      const key = JSON.stringify([result.name, result.kind, result.variant, result.trial]);
      requireValue(!records.has(key), 'duplicate role/trial record');
      records.add(key);
      requireValue(['passed', 'failed', 'error'].includes(result.status), 'status');
      requireValue(result.score === null || (typeof result.score === 'number' && Number.isFinite(result.score) && result.score >= 0 && result.score <= 1), 'score');
      requireValue(Array.isArray(result.checks), 'checks');
      const checks = new Set();
      for (const check of result.checks) {
        fields(check, ['name', 'passed']);
        requireValue(typeof check.name === 'string' && CODE.test(check.name) && typeof check.passed === 'boolean' && !checks.has(check.name), 'grader check');
        checks.add(check.name);
      }
      requireValue(result.status !== 'passed' || (result.checks.length > 0 && result.checks.every((check) => check.passed)), 'passed result needs passing checks');
      for (const key of ['tokens', 'durationMs']) requireValue(result[key] === null || (Number.isSafeInteger(result[key]) && result[key] >= 0), key);
      if (summary.schemaVersion >= 2) {
        if (result.agentUsage !== null) {
          fields(result.agentUsage, ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']);
          for (const value of Object.values(result.agentUsage)) {
            requireValue(value === null || (Number.isSafeInteger(value) && value >= 0), 'agent token count');
          }
        }
        const input = result.agentUsage?.inputTokens;
        const output = result.agentUsage?.outputTokens;
        const total = Number.isSafeInteger(input) && Number.isSafeInteger(output) && Number.isSafeInteger(input + output)
          ? input + output : null;
        requireValue(result.tokens === total, 'agent token total');
        fields(result.judgeUsage, ['calls', 'reportedCalls', 'inputTokens', 'outputTokens']);
        for (const value of Object.values(result.judgeUsage)) {
          requireValue(Number.isSafeInteger(value) && value >= 0, 'judge token count');
        }
        requireValue(result.judgeUsage.reportedCalls <= result.judgeUsage.calls &&
          Number.isSafeInteger(result.judgeUsage.inputTokens + result.judgeUsage.outputTokens) &&
          (result.judgeUsage.reportedCalls > 0 || (result.judgeUsage.inputTokens === 0 && result.judgeUsage.outputTokens === 0)),
        'judge usage coverage');
      }
      requireValue(result.status === 'error' ? typeof result.error === 'string' && CODE.test(result.error) : result.error === null, 'fixed error code');
    }
  }
  return summary;
}

function readSummaries(input, { allowEmpty = false } = {}) {
  if (!input) return [];
  const inputs = Array.isArray(input) ? input : [input];
  const files = [];
  function collect(file, explicit = false) {
    const stat = fs.lstatSync(file);
    requireValue(!stat.isSymbolicLink(), 'summary symlink');
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(file).sort()) collect(path.join(file, child));
    // Runner output folders can also hold private JSON artifacts. Discover only
    // deliberately named summaries; explicit file inputs may use any JSON name.
    } else if (stat.isFile() && file.endsWith('.json') &&
      (explicit || path.basename(file) === 'summary.json' || file.endsWith('.summary.json'))) files.push(file);
  }
  for (const file of inputs) collect(file, true);
  if (!files.length) {
    // The publication workflow starts with a genuinely empty artifact directory
    // before the first run or after expiry. Do not ignore unexpected files.
    const emptyDirectories = inputs.every((file) => fs.lstatSync(file).isDirectory() && fs.readdirSync(file).length === 0);
    requireValue(allowEmpty && emptyDirectories, 'no JSON summaries found');
  }
  return files.map((file) => validateSummary(JSON.parse(fs.readFileSync(file, 'utf8'))));
}

function discoverInventory(repoRoot, catalog) {
  const marketplace = JSON.parse(fs.readFileSync(path.join(repoRoot, 'marketplace.json'), 'utf8'));
  return marketplace.plugins.map((entry) => {
    const plugin = catalog.plugins.find((item) => item.name === entry.name);
    if (typeof entry.source !== 'string') return { name: entry.name, title: plugin.title, external: true, skills: [], docsUrl: plugin.docsUrl };
    const dir = path.resolve(repoRoot, entry.source);
    requireValue(dir.startsWith(`${path.resolve(repoRoot)}${path.sep}`), 'plugin source outside repository');
    const skillsDir = path.join(dir, 'skills');
    const skills = fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((item) => item.isDirectory() && fs.existsSync(path.join(skillsDir, item.name, 'SKILL.md')))
      .map((item) => ({ name: item.name, hash: hashFile(path.join(skillsDir, item.name, 'SKILL.md')) }))
      .sort((a, b) => a.name.localeCompare(b.name)) : [];
    return { name: entry.name, title: plugin.title, external: false, skills, dir, hash: hashTree(dir), docsUrl: plugin.docsUrl };
  });
}

function statistics(suite, kind, variant) {
  const tasks = suite.expectedCases.filter((item) => item.kind === kind);
  const results = suite.results.filter((item) => item.kind === kind && item.variant === variant);
  const expected = tasks.length * suite.runs;
  const passed = results.filter((item) => item.status === 'passed').length;
  return {
    tasks: tasks.length, expected, recorded: results.length, passed,
    errors: results.filter((item) => item.status === 'error').length,
    missing: expected - results.length,
    // Repeats describe stability on one task, not additional independent tasks.
    allRunsPassed: tasks.filter((task) => results.filter((item) => item.name === task.name && item.status === 'passed').length === suite.runs).length,
  };
}

function usageGroup() {
  const metric = () => ({ total: 0, reported: 0, expected: 0, minimum: false });
  return {
    summaries: 0, runs: new Set(), expectedTrials: 0, recordedTrials: 0,
    agent: { total: metric(), input: metric(), output: metric(), cacheRead: metric(), cacheWrite: metric() },
    judge: { calls: 0, reportedCalls: 0, input: 0, output: 0, trackedTrials: 0, legacyTrials: 0 },
  };
}

function addCount(target, key, value) {
  const total = target[key] + value;
  requireValue(Number.isSafeInteger(total), 'token usage total exceeds safe integer range');
  target[key] = total;
}

function addUsage(group, summary) {
  group.summaries++;
  if (summary.runUrl) group.runs.add(summary.runUrl);
  for (const suite of summary.suites) {
    addCount(group, 'expectedTrials', suite.expectedCases.length * suite.runs * 2);
    addCount(group, 'recordedTrials', suite.results.length);
    for (const result of suite.results) {
      // Older summaries conflated absent usage events with zero. Positive
      // totals are usable, but a legacy zero cannot prove that usage was zero.
      const agent = result.agentUsage ?? {};
      const values = {
        total: summary.schemaVersion === 1 && result.tokens === 0 ? null : result.tokens,
        input: agent.inputTokens, output: agent.outputTokens,
        cacheRead: agent.cacheReadTokens, cacheWrite: agent.cacheWriteTokens,
      };
      for (const [key, value] of Object.entries(values)) {
        const metric = group.agent[key];
        metric.expected++;
        if (value !== null && value !== undefined) {
          addCount(metric, 'total', value);
          metric.reported++;
          if (summary.schemaVersion === 1 && key === 'total') metric.minimum = true;
        }
      }
      if (summary.schemaVersion === 1) {
        group.judge.legacyTrials++;
      } else {
        group.judge.trackedTrials++;
        addCount(group.judge, 'calls', result.judgeUsage.calls);
        addCount(group.judge, 'reportedCalls', result.judgeUsage.reportedCalls);
        addCount(group.judge, 'input', result.judgeUsage.inputTokens);
        addCount(group.judge, 'output', result.judgeUsage.outputTokens);
      }
    }
  }
  if (group.recordedTrials < group.expectedTrials) {
    for (const metric of Object.values(group.agent)) metric.minimum = true;
  }
  requireValue(Number.isSafeInteger(group.agent.total.total + group.judge.input + group.judge.output), 'combined usage total exceeds safe integer range');
}

function summarizeUsage(summaries, inventory) {
  const total = usageGroup();
  const days = new Map();
  const plugins = new Map();
  for (const summary of summaries) {
    const date = summary.generatedAt.slice(0, 10);
    if (!days.has(date)) days.set(date, usageGroup());
    if (!plugins.has(summary.plugin)) plugins.set(summary.plugin, usageGroup());
    for (const group of [total, days.get(date), plugins.get(summary.plugin)]) addUsage(group, summary);
  }
  return {
    total,
    days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, usage]) => ({ date, usage })),
    plugins: [...plugins].map(([name, usage]) => ({
      name, title: inventory.find((plugin) => plugin.name === name).title, usage,
    })).sort((a, b) => a.title.localeCompare(b.title)),
  };
}

function loadEvaluations({ repoRoot, catalog, evalResults = null, allowEmptyEvalResults = false, now = new Date() }) {
  const inventory = discoverInventory(repoRoot, catalog);
  const summaries = readSummaries(evalResults, { allowEmpty: allowEmptyEvalResults });
  const runtimeDir = path.join(repoRoot, 'evals', 'runtime');
  const runtimeHash = summaries.length && fs.existsSync(runtimeDir) ? hashTree(runtimeDir) : null;
  const latest = new Map();
  const seen = new Set();
  for (const summary of summaries) {
    const plugin = inventory.find((item) => item.name === summary.plugin);
    requireValue(plugin && !plugin.external, 'unknown or external plugin evidence');
    requireValue(summary.suites.every((suite) => plugin.skills.some((skill) => skill.name === suite.skill)), 'unknown skill');
    requireValue(Date.parse(summary.generatedAt) <= Number(now) + 5 * 60000, 'future date');
    for (const suite of summary.suites) {
      const key = JSON.stringify([summary.plugin, suite.skill, summary.model, summary.judgeModel,
        summary.reasoningEffort ?? null, summary.judgeReasoningEffort ?? null]);
      const timestamp = Date.parse(summary.generatedAt);
      const identity = JSON.stringify([key, timestamp]);
      requireValue(!seen.has(identity), 'ambiguous same-date skill/model summaries');
      seen.add(identity);
      const previous = latest.get(key);
      // Actions can upload one summary per skill. Select a whole suite with its
      // own provenance; filling missing trials from another run could turn an
      // incomplete run into an apparent pass or mix source versions.
      if (!previous || timestamp > Date.parse(previous.summary.generatedAt)) latest.set(key, { summary, suite });
    }
  }
  for (const plugin of inventory) {
    for (const skill of plugin.skills) {
      skill.evidence = [];
      for (const { summary, suite } of latest.values()) {
        if (summary.plugin !== plugin.name || suite.skill !== skill.name) continue;
        const suiteDir = path.join(repoRoot, 'evals', plugin.name, skill.name);
        const suiteCurrent = fs.existsSync(path.join(suiteDir, 'eval.yaml')) && hashTree(suiteDir) === suite.suiteHash;
        const runtimeChanged = runtimeHash !== summary.runtimeHash;
        const changed = plugin.hash !== summary.pluginHash || skill.hash !== suite.skillHash || !suiteCurrent || runtimeChanged;
        const ageMs = Number(now) - Date.parse(summary.generatedAt);
        const ageDays = Math.floor(ageMs / DAY);
        const capability = statistics(suite, 'capability', 'skilled');
        const baseline = statistics(suite, 'capability', 'baseline');
        const dormancy = statistics(suite, 'dormancy', 'skilled');
        const routingBaseline = statistics(suite, 'dormancy', 'baseline');
        const complete = [capability, baseline, dormancy, routingBaseline].every((item) => item.missing === 0);
        const fresh = ageMs <= MAX_AGE_DAYS * DAY && !changed;
        const mixed = suite.results.some((item) => item.variant === 'skilled' && item.status !== 'passed');
        const breadth = capability.tasks >= 2 && dormancy.tasks >= 1 && suite.runs >= 2;
        let category = 'Limited evidence';
        if (mixed) category = 'Mixed results';
        if (complete && fresh && breadth && !mixed) category = 'Consistent offline evidence';
        skill.evidence.push({
          model: summary.model, judgeModel: summary.judgeModel, commit: summary.commit,
          reasoningEffort: summary.reasoningEffort ?? null, judgeReasoningEffort: summary.judgeReasoningEffort ?? null,
          generatedAt: summary.generatedAt, runUrl: summary.runUrl, ageDays, changed, runtimeChanged, complete, fresh,
          category, runs: suite.runs, capability, baseline, dormancy, routingBaseline,
          delta: complete && capability.expected > 0 ? (capability.passed - baseline.passed) / capability.expected : null,
          cases: suite.expectedCases.map((item) => ({
            ...item,
            results: suite.results.filter((result) => result.name === item.name && result.kind === item.kind)
              .map((result) => summary.schemaVersion === 1 && result.tokens === 0 ? { ...result, tokens: null } : result),
          })),
        });
      }
      skill.evidence.sort((a, b) => a.model.localeCompare(b.model) || a.judgeModel.localeCompare(b.judgeModel));
    }
    delete plugin.dir;
    delete plugin.hash;
    for (const skill of plugin.skills) delete skill.hash;
  }
  return { plugins: inventory, maxAgeDays: MAX_AGE_DAYS, usage: summarizeUsage(summaries, inventory) };
}

module.exports = { validateSummary, readSummaries, discoverInventory, statistics, loadEvaluations, MAX_AGE_DAYS };
