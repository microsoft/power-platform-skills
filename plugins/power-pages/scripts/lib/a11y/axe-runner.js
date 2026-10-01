'use strict';

// Runs axe-core inside an already-loaded page and normalizes its output into the
// audit's common finding shape (see report.js).
//
// Injection uses addScriptTag({ content }) with the source read from the pinned local
// package. The browser context is created with bypassCSP: true, so a strict
// Content-Security-Policy on a deployed site cannot block the inline script; the
// legacy create-site axe-audit.js loads from a CDN and fails silently in that case.

const { redact, redactHtml } = require('./page-helpers');

const WCAG_TAGS = Object.freeze(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);

function axeTags({ bestPractice = true } = {}) {
  return bestPractice ? [...WCAG_TAGS, 'best-practice'] : [...WCAG_TAGS];
}

// axe encodes success criteria as tags without dots, e.g.:
//   'wcag143'  -> 1.4.3   (Contrast minimum)
//   'wcag1410' -> 1.4.10  (Reflow)
//   'wcag2411' -> 2.4.11  (Focus not obscured, WCAG 2.2)
// Level tags ('wcag2a', 'wcag21aa', 'wcag22aa') and 'wcag2a-obsolete' are not
// criteria and return null. The principle and guideline are always a single digit,
// so the remainder is the criterion number.
function tagToCriterion(tag) {
  if (/^wcag2\d?a{1,3}$/.test(tag)) return null;
  const m = /^wcag(\d)(\d)(\d+)$/.exec(tag);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

function criteriaFromTags(tags = []) {
  return [...new Set(tags.map(tagToCriterion).filter(Boolean))];
}

function normalizeAxeResult(result, kind) {
  const wcag = criteriaFromTags(result.tags);
  return {
    id: result.id,
    source: 'axe',
    kind,
    impact: result.impact || (kind === 'needsReview' ? 'moderate' : 'minor'),
    wcag,
    bestPractice: wcag.length === 0,
    heuristic: false,
    description: result.help || result.description || result.id,
    helpUrl: result.helpUrl || null,
    nodes: (result.nodes || []).map((n) => ({
      target: Array.isArray(n.target) ? n.target.map(String).join(' ') : String(n.target || ''),
      // axe's node html is the element's outerHTML, so it needs the same scrubbing
      // as the extended checks' snippets (tokens, input values, signed URLs).
      html: redactHtml(n.html, 300),
      summary: redact(n.failureSummary, 500),
    })),
  };
}

// `incomplete` means axe could not decide (for example contrast over a background
// image). It is reported as needsReview, never as a violation, so it does not affect
// the exit code — the agent or a human decides.
function normalizeAxeResults(raw) {
  return {
    findings: [
      ...(raw.violations || []).map((r) => normalizeAxeResult(r, 'violation')),
      ...(raw.incomplete || []).map((r) => normalizeAxeResult(r, 'needsReview')),
    ],
    axeVersion: raw.testEngine && raw.testEngine.version,
  };
}

async function runAxe(page, axeSource, { bestPractice = true } = {}) {
  const loaded = await page.evaluate(() => typeof window.axe !== 'undefined');
  if (!loaded) {
    await page.addScriptTag({ content: axeSource });
  }
  // axe registers through AMD `define` when the page has an AMD loader (RequireJS,
  // still present on some older portal templates) and never sets window.axe.
  const ok = await page.evaluate(() => typeof window.axe !== 'undefined');
  if (!ok) throw new Error('axe-core did not initialize on this page (AMD loader or script injection blocked)');

  const raw = await page.evaluate(async (tags) => window.axe.run(document, {
    runOnly: { type: 'tag', values: tags },
    resultTypes: ['violations', 'incomplete'],
  }), axeTags({ bestPractice }));
  return normalizeAxeResults(raw);
}

module.exports = {
  WCAG_TAGS,
  axeTags,
  criteriaFromTags,
  normalizeAxeResult,
  normalizeAxeResults,
  runAxe,
  tagToCriterion,
};
