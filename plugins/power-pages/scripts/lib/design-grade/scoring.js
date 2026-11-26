'use strict';

const { loadCatalog, severityRank, EFFORT_ORDER } = require('./catalog');

const round2 = (n) => Math.round(n * 100) / 100;

// load = majors + 0.25 * minors; score = 5 - 4 * tanh(0.2 * load)
function scoreFromIssues(issues) {
  const cat = loadCatalog();
  const load = issues.reduce((a, i) => a + cat.severities[i.severity].load, 0);
  return round2(5 - 4 * Math.tanh(cat.scoring.penaltySteepness * load));
}

function counts(issues) {
  const c = { major: 0, minor: 0, gates: 0 };
  for (const i of issues) {
    c[i.severity]++;
    if (i.gate) c.gates++;
  }
  return c;
}

function verdictFor(c, incomplete = false, profile = 'full') {
  const p = loadCatalog().profiles[profile];
  const v = Object.fromEntries(((p && p.verdicts) || loadCatalog().scoring.verdicts).map((x) => [x.when, x]));
  if (c.gates > 0) return v.gate;
  if (incomplete) return v.incomplete;
  if (c.major > 0) return v.major;
  return v.otherwise;
}

// Deterministic priority: gate → severity → breadth (pages) → above the fold → effort (quick wins first) → dimension order → key.
function rankIssues(issues) {
  const cat = loadCatalog();
  const sorted = [...issues].sort((a, b) =>
    Number(!!b.gate) - Number(!!a.gate) ||
    severityRank(a.severity) - severityRank(b.severity) ||
    b.routes.length - a.routes.length ||
    Number(b.aboveFold) - Number(a.aboveFold) ||
    EFFORT_ORDER.indexOf(a.effort) - EFFORT_ORDER.indexOf(b.effort) ||
    cat.dimOrder.indexOf(a.dimension) - cat.dimOrder.indexOf(b.dimension) ||
    a.key.localeCompare(b.key));
  return sorted.map((i, idx) => ({ ...i, rank: idx + 1, quickWin: i.effort === 'S' && i.severity === 'major' }));
}

function scoreAll(issues, { incomplete = false, nothingGraded = false, profile = 'full' } = {}) {
  const cat = loadCatalog();
  const noScores = nothingGraded || !cat.profiles[profile].scores;
  const categories = cat.categories.map((c) => {
    const inCat = issues.filter((i) => c.dimensions.includes(i.dimension));
    return {
      id: c.id,
      name: c.name,
      question: c.question,
      score: noScores ? null : scoreFromIssues(inCat),
      counts: counts(inCat),
      dimensions: c.dimensions.map((d) => ({ id: d, name: cat.dimensions[d].name, counts: counts(inCat.filter((i) => i.dimension === d)) })),
    };
  });
  const total = counts(issues);
  const failingGates = [...new Set(issues.filter((i) => i.gate).map((i) => i.gate))].sort()
    .map((g) => ({ id: g, title: cat.gates[g].title, issues: issues.filter((i) => i.gate === g).map((i) => i.key) }));
  return { categories, counts: total, failingGates, verdict: verdictFor(total, incomplete || nothingGraded, profile) };
}

module.exports = { scoreFromIssues, scoreAll, rankIssues, counts, verdictFor };
