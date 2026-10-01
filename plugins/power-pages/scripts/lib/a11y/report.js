'use strict';

// Common finding shape, aggregation, and exit-code policy for the accessibility audit.
//
// Every source (axe or an extended check) produces findings shaped like:
//   { id, source: 'axe'|'extended', kind: 'violation'|'needsReview', impact,
//     wcag: ['1.4.3'], bestPractice, heuristic, description, helpUrl,
//     nodes: [{ target, html, summary }] }
// The report groups by rule id and then by node target so a header defect repeated
// on 25 pages appears once with 25 occurrences instead of 25 separate findings.

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
    this.states = [];
    this.rules = new Map();
  }

  addPage({ route, viewport, state = null, url, title = null, status = null, error = null, checkErrors = [] }) {
    this.pages.push({ route, viewport, state, url, title, status, error, checkErrors });
  }

  addState({ label, route, viewport, error = null }) {
    this.states.push({ label, route, viewport, error });
  }

  addFindings(findings, { route, viewport, state = null }) {
    for (const f of findings) {
      const key = `${f.kind}:${f.id}`;
      let rule = this.rules.get(key);
      if (!rule) {
        rule = {
          id: f.id, source: f.source, kind: f.kind, impact: f.impact, wcag: f.wcag,
          bestPractice: f.bestPractice, heuristic: f.heuristic, description: f.description,
          helpUrl: f.helpUrl, nodes: new Map(),
        };
        this.rules.set(key, rule);
      }
      // A rule's impact can differ per node in axe; keep the most severe one seen.
      if (IMPACT_ORDER.indexOf(f.impact) < IMPACT_ORDER.indexOf(rule.impact)) rule.impact = f.impact;
      const nodes = f.nodes.length ? f.nodes : [{ target: '(page)', html: '', summary: '' }];
      for (const n of nodes) {
        let node = rule.nodes.get(n.target);
        if (!node) {
          node = { target: n.target, html: n.html, summary: n.summary, occurrences: [] };
          rule.nodes.set(n.target, node);
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
    const pageErrors = this.pages.filter((p) => p.error).length;
    const states = this.states;
    const stateErrors = states.filter((s) => s.error).length;
    const checkErrors = this.pages.reduce((n, p) => n + p.checkErrors.length, 0);

    return {
      ...this.meta,
      ...extra,
      finishedAt: new Date().toISOString(),
      summary: {
        pagesAudited: this.pages.filter((p) => !p.error).length,
        pageErrors,
        statesAudited: states.length - stateErrors,
        stateErrors,
        checkErrors,
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

// A load failure takes priority over violations: a page or state that never rendered
// was not audited, so a "pass" or a violation count would both misrepresent coverage.
// Errors in individual extended checks (checkErrors) are reported but do not change
// the exit code; axe itself failing on a page is recorded as a page error.
function exitCodeFor(report) {
  if (report.summary.pageErrors > 0 || report.summary.stateErrors > 0) return EXIT.LOAD_FAILURE;
  if (report.summary.blocking > 0) return EXIT.VIOLATIONS;
  return EXIT.PASS;
}

module.exports = {
  IMPACT_ORDER,
  ReportBuilder,
  exitCodeFor,
  isBlocking,
  makeFinding,
};
