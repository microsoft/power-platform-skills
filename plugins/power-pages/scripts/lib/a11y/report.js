'use strict';

// Common finding shape, aggregation, and exit-code policy for the accessibility audit.
//
// Every source (axe or an extended check) produces findings shaped like:
//   { id, source: 'axe'|'extended', kind: 'violation'|'needsReview', impact,
//     wcag: ['1.4.3'], bestPractice, heuristic, description, helpUrl,
//     nodes: [{ target, html, summary }] }
// The report groups by rule id and then by node (selector + markup + summary) so a
// header defect repeated on 25 pages appears once with 25 occurrences instead of 25
// separate findings.

const { EXIT } = require('./args');

const IMPACT_ORDER = Object.freeze(['critical', 'serious', 'moderate', 'minor']);

function makeFinding({ id, impact, wcag = [], heuristic = false, bestPractice, description, helpUrl = null, nodes = [], kind = 'violation' }) {
  return {
    id,
    source: 'extended',
    kind,
    impact,
    wcag,
    bestPractice: bestPractice === undefined ? wcag.length === 0 : bestPractice,
    heuristic,
    description,
    helpUrl,
    nodes,
  };
}

// Blocking = the kind of issue the skill should insist on fixing. Best-practice and
// heuristic findings are still reported, but heuristics can false-positive (focus
// styling, clipped text) and best-practice rules are not WCAG conformance failures,
// so neither fails the run on its own.
function isBlocking(finding) {
  return finding.kind === 'violation'
    && (finding.impact === 'critical' || finding.impact === 'serious')
    && !finding.bestPractice
    && !finding.heuristic;
}

class ReportBuilder {
  constructor({ baseUrl, viewports, checks, bestPractice, tool }) {
    this.meta = { baseUrl, viewports, checks, bestPractice, tool, startedAt: new Date().toISOString() };
    this.pages = [];
    // Page identities for counting, kept out of the output: `route` is query-redacted,
    // so /case?id=1 and /case?id=2 share one route but are two audited pages. The key
    // is the full URL, which must never be written to the report.
    this.pageKeys = [];
    this.states = [];
    this.rules = new Map();
  }

  addPage({ route, viewport, state = null, url, title = null, status = null, error = null, checkErrors = [], blockedRequests = null, key = null }) {
    this.pages.push({ route, viewport, state, url, title, status, error, checkErrors, blockedRequests });
    this.pageKeys.push(key || route);
  }

  addState({ label, route, viewport, error = null, checkErrors = [], blockedRequests = null, formSubmitAllowed = false }) {
    this.states.push({ label, route, viewport, formSubmitAllowed, error, checkErrors, blockedRequests });
  }

  addFindings(findings, { route, viewport, state = null }) {
    for (const f of findings) {
      const key = `${f.kind}:${f.id}`;
      let rule = this.rules.get(key);
      if (!rule) {
        rule = {
          id: f.id, source: f.source, kind: f.kind, impact: f.impact, wcag: [...f.wcag],
          bestPractice: f.bestPractice, heuristic: f.heuristic, description: f.description,
          helpUrl: f.helpUrl, nodes: new Map(),
        };
        this.rules.set(key, rule);
      }
      // A rule's impact can differ per node in axe; keep the most severe one seen.
      if (IMPACT_ORDER.indexOf(f.impact) < IMPACT_ORDER.indexOf(rule.impact)) rule.impact = f.impact;
      // Some extended rules derive their criteria per element (motion: an unmuted
      // video maps to 1.4.2, a long one to 2.2.2), so the first occurrence does not
      // speak for the whole rule. Union them so no criterion is dropped.
      for (const c of f.wcag) if (!rule.wcag.includes(c)) rule.wcag.push(c);
      // A rule is best practice only if every occurrence is; one WCAG-mapped
      // occurrence makes it a conformance issue.
      if (!f.bestPractice) rule.bestPractice = false;
      const nodes = f.nodes.length ? f.nodes : [{ target: '(page)', html: '', summary: '' }];
      for (const n of nodes) {
        // Keyed on the markup and summary as well as the selector: a positional
        // selector such as "main > p:nth-of-type(2)" names different elements on
        // different routes, and merging them would hide all but the first one's
        // evidence. A shared header/footer element has identical markup on every
        // page, so it still collapses into one node with many occurrences.
        const nodeKey = JSON.stringify([n.target, n.html || '', n.summary || '']);
        let node = rule.nodes.get(nodeKey);
        if (!node) {
          node = { target: n.target, html: n.html, summary: n.summary, occurrences: [] };
          rule.nodes.set(nodeKey, node);
        }
        node.occurrences.push({ route, viewport, state });
      }
    }
  }

  build({ crawl = null, extra = {} } = {}) {
    const findings = [...this.rules.values()]
      .map((r) => ({ ...r, nodes: [...r.nodes.values()] }))
      .sort((a, b) => (IMPACT_ORDER.indexOf(a.impact) - IMPACT_ORDER.indexOf(b.impact)) || a.id.localeCompare(b.id));

    const violations = findings.filter((f) => f.kind === 'violation');
    const needsReview = findings.filter((f) => f.kind === 'needsReview');
    const byImpact = Object.fromEntries(IMPACT_ORDER.map((i) => [i, violations.filter((f) => f.impact === i).length]));
    const blocking = violations.filter(isBlocking).length;
    // `pages` has one entry per route and layout, so 12 routes on desktop + mobile is
    // 24 entries. pagesAudited counts routes that loaded on at least one layout, which
    // is what "N pages" means to a reader; pageLayoutsAudited keeps the per-layout
    // count, and pageErrors counts failed loads (one per route and layout).
    const okPages = this.pages.filter((p) => !p.error);
    const okPageKeys = this.pageKeys.filter((k, i) => !this.pages[i].error);
    const pageErrors = this.pages.length - okPages.length;
    const states = this.states;
    const stateErrors = states.filter((s) => s.error).length;
    const checkErrors = [...this.pages, ...states].reduce((n, p) => n + (p.checkErrors || []).length, 0);
    const blockedRequests = [...this.pages, ...states].reduce((n, s) => n + (s.blockedRequests ? s.blockedRequests.count : 0), 0);

    return {
      ...this.meta,
      ...extra,
      finishedAt: new Date().toISOString(),
      summary: {
        pagesAudited: new Set(okPageKeys).size,
        pageLayoutsAudited: okPages.length,
        pageErrors,
        statesAudited: states.length - stateErrors,
        stateErrors,
        checkErrors,
        blockedRequests,
        violations: violations.length,
        blocking,
        needsReview: needsReview.length,
        byImpact,
      },
      pages: this.pages,
      states,
      crawl,
      violations,
      needsReview,
    };
  }
}

// An incomplete audit takes priority over violations: a page or state that never
// rendered, or a check that errored, was not audited, so a "pass" or a violation
// count would both misrepresent coverage. The skill still reads summary.blocking
// from the report, so violations found on the pages that did run are not lost.
// Blocked requests (summary.blockedRequests) are the safety guard working as
// designed, not a failure, so they do not change the exit code.
function exitCodeFor(report) {
  const s = report.summary;
  if (s.pageErrors > 0 || s.stateErrors > 0 || s.checkErrors > 0) return EXIT.LOAD_FAILURE;
  if (s.blocking > 0) return EXIT.VIOLATIONS;
  return EXIT.PASS;
}

module.exports = {
  IMPACT_ORDER,
  ReportBuilder,
  exitCodeFor,
  isBlocking,
  makeFinding,
};
