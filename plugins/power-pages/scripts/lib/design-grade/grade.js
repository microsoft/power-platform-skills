'use strict';

// Builds grade.json from evidence.json (+ judgments.json). Pure apart from file I/O in the CLI wrapper.

const { loadCatalog, judgmentIds, measuredAllowed, profileOf, maxSeverity } = require('./catalog');
const { runChecks } = require('./checks');
const { scoreAll, rankIssues } = require('./scoring');

const RESULTS = new Set(['pass', 'fail', 'n/a']);
const DECISIONS = new Set(['confirm', 'dismiss']);
const MIN_DISMISS_REASON = 20;

// Measured issues, merged across pages: the candidates the judge must confirm or dismiss.
function profilePages(evidence, profile) {
  // The first-impression profile looks only at the start page (the first captured route).
  return profile === 'first-impression' ? { ...evidence, pages: evidence.pages.slice(0, 1) } : evidence;
}

function autoIssues(evidence, profile = 'full') {
  const allowed = measuredAllowed(profile);
  return runChecks(profilePages(evidence, profile)).issues.filter((i) => allowed(i.id));
}

function candidateIssues(evidence, profile = 'full') {
  return mergeAcrossPages(autoIssues(evidence, profile)).sort((a, b) => a.key.localeCompare(b.key));
}

function validateJudgments(evidence, judgments, profile = 'full') {
  const errors = [];
  profileOf(profile);
  const ids = judgmentIds(profile);
  const cat = loadCatalog();
  const routes = profilePages(evidence, profile).pages.filter((p) => p.viewports.desktop && !p.viewports.desktop.error).map((p) => p.route);
  if (!judgments || typeof judgments !== 'object' || !judgments.pages) {
    return ['judgments.json must have a "pages" object keyed by route.'];
  }
  for (const route of routes) {
    const pj = judgments.pages[route];
    if (!pj) { errors.push(`Missing judgments for page ${route}.`); continue; }
    for (const id of ids) {
      const j = pj[id];
      if (!j) { errors.push(`${route}: missing result for ${id} (${cat.byId.get(id).title}).`); continue; }
      if (!RESULTS.has(j.result)) errors.push(`${route}: ${id} result must be pass, fail, or n/a (got "${j.result}").`);
      if ((j.result === 'fail' || j.result === 'n/a') && !(j.evidence || '').trim()) errors.push(`${route}: ${id} is "${j.result}" but has no evidence text.`);
      if (j.severity && j.severity !== cat.byId.get(id).severity) errors.push(`${route}: ${id} severity is fixed at "${cat.byId.get(id).severity}"; remove the severity override.`);
    }
    for (const key of Object.keys(pj)) if (!ids.includes(key)) errors.push(`${route}: ${key} is not a judgment item of the "${profile}" review.`);
  }
  const decisions = judgments.candidates || {};
  const keys = candidateIssues(evidence, profile).map((c) => c.key);
  for (const key of keys) {
    const d = decisions[key];
    if (!d) { errors.push(`candidates: missing decision for measured issue ${key}.`); continue; }
    if (!DECISIONS.has(d.decision)) errors.push(`candidates: ${key} decision must be confirm or dismiss (got "${d.decision}").`);
    if (d.decision === 'dismiss' && (d.reason || '').trim().length < MIN_DISMISS_REASON) errors.push(`candidates: dismissing ${key} needs a reason of at least ${MIN_DISMISS_REASON} characters that cites what the screenshots or source show.`);
  }
  for (const key of Object.keys(decisions)) if (!keys.includes(key)) errors.push(`candidates: ${key} is not a measured issue in this evidence.`);
  for (const [i, x] of (judgments.extra || []).entries()) {
    if (!cat.dimensions[x.dimension]) errors.push(`extra[${i}]: unknown dimension "${x.dimension}".`);
    if (!['major', 'minor'].includes(x.severity)) errors.push(`extra[${i}]: uncatalogued issues may only be major or minor.`);
    if (!(x.title || '').trim() || !(x.evidence || '').trim()) errors.push(`extra[${i}]: title and evidence are required.`);
    if (!routes.includes(x.route)) errors.push(`extra[${i}]: route "${x.route}" was not graded.`);
  }
  return errors;
}

function judgmentIssues(judgments, profile = 'full') {
  const cat = loadCatalog();
  const out = [];
  for (const [route, pj] of Object.entries(judgments.pages || {}).sort(([a], [b]) => a.localeCompare(b))) {
    for (const id of judgmentIds(profile)) {
      const j = pj[id];
      if (!j || j.result !== 'fail') continue;
      const c = cat.byId.get(id);
      out.push({
        id, variant: null, dimension: c.dimension, detection: 'judgment', gate: c.gate || null, severity: c.severity, title: c.title, route,
        viewports: j.viewports || [], aboveFold: j.aboveFold !== false, summary: j.evidence,
        instances: (j.instances || []).slice(0, 10), instanceCount: (j.instances || []).length, metrics: {}, screenshot: j.screenshot || null,
      });
    }
  }
  (judgments.extra || []).forEach((x, i) => {
    out.push({
      id: `X-${String(i + 1).padStart(2, '0')}`, variant: null, dimension: x.dimension, detection: 'judgment', uncatalogued: true,
      severity: x.severity, title: x.title, route: x.route, viewports: x.viewports || [], aboveFold: !!x.aboveFold, summary: x.evidence,
      instances: (x.instances || []).slice(0, 10), instanceCount: (x.instances || []).length, metrics: {}, screenshot: x.screenshot || null, extraFix: x.fix || [],
    });
  });
  return out;
}

// Same catalog id (+variant) on several pages is one root cause, so it is reported and scored once.
function mergeAcrossPages(issues) {
  const cat = loadCatalog();
  const map = new Map();
  for (const i of issues) {
    const key = i.variant ? `${i.id}:${i.variant}` : i.id;
    const keyed = i.uncatalogued ? `${key}` : key;
    let m = map.get(keyed);
    if (!m) {
      const c = cat.byId.get(i.id);
      m = {
        key: keyed, id: i.id, variant: i.variant, dimension: i.dimension, category: cat.dimToCategory[i.dimension], detection: i.detection,
        uncatalogued: !!i.uncatalogued, gate: null, severity: i.severity, title: i.title, effort: c ? c.effort : 'M',
        routes: [], viewports: [], aboveFold: false, summaries: [], instances: [], instanceCount: 0, metrics: {}, screenshots: [],
        refs: c ? c.refs || [] : [],
        fix: c ? c.fix : i.extraFix,
        trigger: c ? c.trigger : null,
      };
      map.set(keyed, m);
    }
    m.severity = maxSeverity(m.severity, i.severity);
    if (i.gate) m.gate = i.gate;
    if (!m.routes.includes(i.route)) m.routes.push(i.route);
    m.viewports = [...new Set(m.viewports.concat(i.viewports))];
    m.aboveFold = m.aboveFold || i.aboveFold;
    m.summaries.push({ route: i.route, text: i.summary });
    m.instances.push(...i.instances.map((x) => ({ route: i.route, ...x })));
    m.instanceCount += i.instanceCount;
    if (Object.keys(i.metrics || {}).length) m.metrics[i.route] = i.metrics;
    if (i.screenshot) m.screenshots.push({ route: i.route, path: i.screenshot });
  }
  for (const m of map.values()) {
    m.instances = m.instances.slice(0, 15);
    m.routes.sort();
    const vpOrder = ['mobile', 'tablet', 'desktop'];
    m.viewports.sort((a, b) => vpOrder.indexOf(a) - vpOrder.indexOf(b));
  }
  return [...map.values()];
}

function buildGrade(evidence, judgments, opts = {}) {
  const cat = loadCatalog();
  const profile = opts.profile || 'full';
  profileOf(profile);
  const scoped = profilePages(evidence, profile);
  const { profiles } = runChecks(scoped);
  const judgmentMode = opts.autoOnly ? 'auto-only' : 'full';
  const full = judgments && !opts.autoOnly;
  const decisions = (full && judgments.candidates) || {};
  const measured = autoIssues(evidence, profile);
  const keyOf = (i) => (i.variant ? `${i.id}:${i.variant}` : i.id);
  const confirmed = measured.filter((a) => !(decisions[keyOf(a)] && decisions[keyOf(a)].decision === 'dismiss'));
  // A judgment item whose catalog `coveredBy` lists a measured item is the same root cause when that
  // measured item is confirmed on the same page; it is recorded as merged instead of counted twice.
  const merged = [];
  const judged = (full ? judgmentIssues(judgments, profile) : []).filter((j) => {
    const covering = ((cat.byId.get(j.id) || {}).coveredBy || []);
    const hit = confirmed.find((a) => covering.includes(a.id) && a.route === j.route);
    if (hit) merged.push({ key: j.id, route: j.route, coveredBy: keyOf(hit), evidence: j.summary });
    return !hit;
  });
  const all = measured.concat(judged);
  const mergedAll = mergeAcrossPages(all);
  const isDismissed = (i) => i.detection === 'auto' && decisions[i.key] && decisions[i.key].decision === 'dismiss';
  const dismissed = mergedAll.filter(isDismissed).sort((a, b) => a.key.localeCompare(b.key))
    .map((i) => ({ key: i.key, title: i.title, severity: i.severity, gate: i.gate, routes: i.routes, reason: decisions[i.key].reason }));
  const ranked = rankIssues(mergedAll.filter((i) => !isDismissed(i)));
  const graded = scoped.pages.filter((p) => p.viewports.desktop && !p.viewports.desktop.error);
  const failedPages = scoped.pages.filter((p) => !graded.includes(p)).map((p) => ({ route: p.route, error: (p.viewports.desktop || {}).error || 'not collected' }));
  const gaps = [];
  for (const p of scoped.pages) {
    for (const vp of Object.keys(evidence.viewports || {})) if (!p.viewports[vp]) gaps.push({ route: p.route, viewport: vp, step: 'measure', error: 'not collected' });
    for (const e of p.collectionErrors || []) if (e.step !== 'screenshot') gaps.push({ route: p.route, ...e });
  }
  const score = scoreAll(ranked, { incomplete: gaps.length > 0, nothingGraded: graded.length === 0, profile });
  return {
    tool: 'design-grade',
    profile,
    catalogVersion: cat.version,
    baseUrl: evidence.baseUrl,
    collectedAt: evidence.collectedAt,
    projectRoot: evidence.projectRoot || null,
    judgmentMode,
    pages: scoped.pages.map((p) => ({ route: p.route, url: p.url, status: p.status, screenshots: p.screenshots })),
    coverage: {
      pagesGraded: graded.map((p) => p.route),
      pagesFailed: failedPages,
      gaps,
      complete: gaps.length === 0 && graded.length > 0,
      notes: scoped.pages.flatMap((p) => {
        const c = (p.viewports.desktop && p.viewports.desktop.coverage) || {};
        return c.iframes ? [{ route: p.route, note: `${c.iframes} iframe(s) not measured; review them in the screenshots` }] : [];
      }),
      autoChecks: cat.issues.filter((i) => i.detection === 'auto' && measuredAllowed(profile)(i.id)).length,
      judgmentChecks: judgmentMode === 'full' ? judgmentIds(profile).length : 0,
    },
    verdict: score.verdict,
    counts: score.counts,
    failingGates: score.failingGates,
    categories: score.categories,
    profiles,
    issues: ranked,
    dismissed,
    merged,
  };
}

module.exports = { buildGrade, validateJudgments, mergeAcrossPages, judgmentIssues, candidateIssues };
