#!/usr/bin/env node

// Grades a /design-eval run: lists the measured candidates for the judge, then turns the judge's answers
// into per-category scores, critical gates, a verdict, ranked issues with fix steps and source hints,
// and an HTML report that it opens in the default browser.
//
// Usage (JSON on stdin, inside a quoted heredoc):
//   {"action": "candidates", "dir": "<runDir>"}
//   {"action": "grade", "dir": "<runDir>"}            reads <runDir>/judgments.json written by the judge
//   {"action": "grade", "dir": "<runDir>", "open": false}
//
// `dir` must be a run folder created by collect.js (<project>/docs/design-eval/<run>). The project is read
// for file:line hints, never run. Output: JSON on stdout. Exit 0 on success; 1 on usage errors or when the
// judgments are incomplete (the error lists exactly what is missing).

const fs = require('node:fs');
const path = require('node:path');
const { isBoolean, isString, parseRequest } = require('../../../scripts/lib/review-navigation');
const { openInDefaultBrowser } = require('../../../scripts/lib/default-browser');
const { buildGrade, validateJudgments, candidateIssues } = require('../../../scripts/lib/design-grade/grade');
const { loadCatalog } = require('../../../scripts/lib/design-grade/catalog');
const { locate } = require('../../../scripts/lib/design-grade/locate-source');
const { render } = require('../../../scripts/lib/design-grade/render-report');

const REQUEST_FIELDS = { action: isString, dir: isString, open: isBoolean };
const USAGE = 'Usage: node grade.js --input -   (JSON request on stdin: action "candidates" | "grade", dir, open)';
const TOP_ISSUES = 4;

// A run folder is <project>/docs/design-eval/<run> with evidence.json, inside a Power Pages code site.
function resolveRun(dir) {
  const runDir = path.resolve(dir);
  const project = path.resolve(runDir, '..', '..', '..');
  if (path.basename(path.dirname(runDir)) !== 'design-eval' || path.basename(path.dirname(path.dirname(runDir))) !== 'docs' ||
      !fs.existsSync(path.join(project, 'powerpages.config.json'))) {
    return { error: 'dir must be a run folder created by collect.js (<project>/docs/design-eval/<run>).' };
  }
  if (!fs.existsSync(path.join(runDir, 'evidence.json'))) return { error: 'No evidence.json in dir. Run collect.js first.' };
  return { runDir, project };
}

function parseArgs(argv, { readStdin = () => fs.readFileSync(0, 'utf8') } = {}) {
  if (!(argv[0] === '--input' && argv[1] === '-')) return { error: USAGE };
  const { request, error } = parseRequest(readStdin(), REQUEST_FIELDS);
  if (error) return { error };
  if (!['candidates', 'grade'].includes(request.action) || !request.dir) return { error: USAGE };
  const run = resolveRun(request.dir);
  if (run.error) return run;
  return { action: request.action, open: request.open !== false, ...run };
}

// The issues shown in chat: gates first, then other major issues, in the grade's rank order.
function topIssues(grade, max = TOP_ISSUES) {
  return grade.issues.filter((i) => i.severity === 'major').slice(0, max);
}

function previousRunDir(runDir) {
  const root = path.dirname(runDir);
  const runs = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name < path.basename(runDir) && fs.existsSync(path.join(root, e.name, 'grade.json')))
    .map((e) => e.name).sort();
  return runs.length ? path.join(root, runs[runs.length - 1]) : null;
}

// Judgment fails from the previous run, per route, that the judge must re-check on this run.
function previousFails(runDir, routes) {
  const prevDir = previousRunDir(runDir);
  if (!prevDir) return [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(prevDir, 'judgments.json'), 'utf8'));
    return Object.entries(j.pages || {}).filter(([route]) => routes.includes(route)).flatMap(([route, items]) =>
      Object.entries(items).filter(([, a]) => a && a.result === 'fail').map(([id, a]) => ({ route, id, evidence: a.evidence })));
  } catch {
    return [];
  }
}

// A previous fail may only turn into a pass with evidence of what visibly changed.
function recheckErrors(fails, judgments) {
  return fails.filter((f) => {
    const a = ((judgments.pages || {})[f.route] || {})[f.id];
    return a && a.result === 'pass' && !String(a.evidence || '').trim();
  }).map((f) => `pages["${f.route}"]["${f.id}"] failed in the previous run; a pass needs evidence describing what visibly changed (or answer fail again).`);
}

function previousRun(runDir) {
  const prevDir = previousRunDir(runDir);
  if (!prevDir) return null;
  try {
    const prev = JSON.parse(fs.readFileSync(path.join(prevDir, 'grade.json'), 'utf8'));
    return { run: path.basename(prevDir), verdict: prev.verdict.verdict, categories: prev.categories.map((c) => ({ name: c.name, score: c.score })), counts: prev.counts, keys: [...new Set(prev.issues.map((i) => i.key).concat((prev.merged || []).map((m) => m.key)))] };
  } catch {
    return null;
  }
}

function brief(i, cat) {
  return {
    rank: i.rank, key: i.key, title: i.title, gate: i.gate ? `${i.gate} ${cat.gates[i.gate].title}` : null,
    subDimension: cat.dimensions[i.dimension].name, effort: i.effort, pages: i.routes, viewports: i.viewports,
    evidence: i.summaries.map((s) => `${s.route}: ${s.text}`),
    where: i.instances.slice(0, 3).map((x) => `${x.route} ${x.selector} - ${x.detail}`),
    fix: i.fix, source: (i.sourceHints || []).slice(0, 3).map((h) => `${h.file}:${h.line} ${h.match}`),
  };
}

function run(args, { open = openInDefaultBrowser } = {}) {
  const evidence = JSON.parse(fs.readFileSync(path.join(args.runDir, 'evidence.json'), 'utf8'));
  if (args.action === 'candidates') {
    const list = candidateIssues(evidence).map((i) => ({
      key: i.key, title: i.title, severity: i.severity, gate: i.gate, trigger: i.trigger, routes: i.routes, viewports: i.viewports,
      evidence: i.summaries.map((s) => `${s.route}: ${s.text}`), where: i.instances.slice(0, 6).map((x) => `${x.route} ${x.selector} - ${x.detail}`),
    }));
    fs.writeFileSync(path.join(args.runDir, 'candidates.json'), JSON.stringify(list, null, 2));
    const recheck = previousFails(args.runDir, evidence.pages.map((p) => p.route));
    if (recheck.length) fs.writeFileSync(path.join(args.runDir, 'recheck.json'), JSON.stringify(recheck, null, 2));
    return { code: 0, out: { candidatesFile: path.join(args.runDir, 'candidates.json'), count: list.length, keys: list.map((c) => c.key), recheck: recheck.map((f) => `${f.route} ${f.id}`) } };
  }
  const judgmentsFile = path.join(args.runDir, 'judgments.json');
  if (!fs.existsSync(judgmentsFile)) return { code: 1, err: `No judgments.json in ${args.runDir}. Run the design-judge agent first.\n` };
  let judgments;
  try { judgments = JSON.parse(fs.readFileSync(judgmentsFile, 'utf8')); } catch (error) { return { code: 1, err: `judgments.json is not valid JSON: ${error.message}\n` }; }
  const errors = validateJudgments(evidence, judgments).concat(recheckErrors(previousFails(args.runDir, evidence.pages.map((p) => p.route)), judgments));
  if (errors.length) return { code: 1, err: `Judgments are incomplete or invalid:\n- ${errors.join('\n- ')}\n` };
  const grade = buildGrade(evidence, judgments, {});
  locate(grade, args.project);
  fs.writeFileSync(path.join(args.runDir, 'grade.json'), JSON.stringify(grade, null, 2));
  const report = path.join(args.runDir, 'report.html');
  fs.writeFileSync(report, render(grade));
  let opened = false;
  if (args.open) {
    try { open(report); opened = true; } catch { /* the path is printed for the user to open */ }
  }
  const cat = loadCatalog();
  const top = topIssues(grade);
  return {
    code: 0,
    out: {
      verdict: grade.verdict.verdict, meaning: grade.verdict.meaning,
      failingGates: grade.failingGates.map((g) => `${g.id} ${g.title}`),
      categories: grade.categories.map((c) => ({ name: c.name, score: c.score, major: c.counts.major, minor: c.counts.minor })),
      counts: grade.counts,
      topIssues: top.map((i) => brief(i, cat)),
      moreMajor: grade.issues.filter((i) => i.severity === 'major').length - top.length,
      dismissed: grade.dismissed.map((d) => `${d.key}: ${d.reason}`),
      countedOnce: (grade.merged || []).map((m) => `${m.key} on ${m.route} is the same problem as ${m.coveredBy}`),
      coverageGaps: grade.coverage.gaps.map((g) => `${g.route} ${g.viewport} ${g.step}: ${g.error}`),
      previous: previousRun(args.runDir),
      ...(() => {
        const prev = previousRun(args.runDir);
        if (!prev) return {};
        // Merged findings still exist (they were counted under a measured issue), so they are neither resolved nor new.
        const now = [...new Set(grade.issues.map((i) => i.key).concat((grade.merged || []).map((m) => m.key)))];
        return { resolvedSinceLast: prev.keys.filter((k) => !now.includes(k)), newSinceLast: now.filter((k) => !prev.keys.includes(k)) };
      })(),
      report, opened,
    },
  };
}

function main(argv = process.argv.slice(2), {
  write = (s) => process.stdout.write(s),
  writeError = (s) => process.stderr.write(s),
  readStdin,
  open,
} = {}) {
  const args = parseArgs(argv, { readStdin });
  if (args.error) {
    writeError(`${args.error}\n`);
    return 1;
  }
  try {
    const result = run(args, { open });
    if (result.err) writeError(result.err);
    if (result.out) write(`${JSON.stringify(result.out, null, 1)}\n`);
    return result.code;
  } catch (error) {
    writeError(`Design evaluation grading failed: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { main, parseArgs, run, topIssues, previousRun, previousFails, recheckErrors, resolveRun, TOP_ISSUES };
