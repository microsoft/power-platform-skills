'use strict';

// Runs axe-core inside an already-loaded page and normalizes its output into the
// audit's common finding shape (see report.js).
//
// Injection uses addScriptTag({ content }) with the source read from the pinned local
// package. The browser context is created with bypassCSP: true, so a strict
// Content-Security-Policy on a deployed site cannot block the inline script; the
// legacy create-site axe-audit.js loads from a CDN and fails silently in that case.

const crypto = require('node:crypto');

const { redact, redactHtml } = require('./page-helpers');

// The pinned axe instance lives under a per-process random property name instead of
// window.axe. A page that ships its own (possibly older or patched) axe, or any script
// that defines window.axe, can't make the audit reuse that object, and can't predefine
// this name because it can't guess it.
const AXE_KEY = `__ppA11yAxe_${crypto.randomBytes(8).toString('hex')}`;

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

// Wraps the pinned axe source so it always initializes a fresh instance and leaves the
// page as it found it. The published axe.js is a UMD bundle shaped like:
//   (function axeFunction(window) {
//     var axe = axe || {};                       // function-local, so always fresh
//     if (typeof define === 'function' && define.amd) define('axe-core', [], ...);
//     ...
//     if (typeof window.getComputedStyle === 'function') window.axe = axe;
//     ...  // bundled helpers: `typeof define === 'function' && define.amd ? define(factory)`
//   })(typeof window === 'object' ? window : this);
// - `define`, `module`, `exports`, and `require` are shadowed with undefined locals, so
//   a page AMD loader (RequireJS on older portal templates) never sees axe's anonymous
//   define() calls, which RequireJS rejects as "Mismatched anonymous define()".
// - window.axe is the only global axe writes. It's cleared before the source runs, the
//   new instance is captured under AXE_KEY, and the page's own window.axe is restored.
// - A page that locks window.axe (non-writable and non-configurable) makes the capture
//   impossible; that throws in the page, AXE_KEY stays unset, and runAxe fails loudly
//   instead of running the page's object.
function wrapAxeSource(source, key) {
  const k = JSON.stringify(key);
  return `(function () {
  var define, module, exports, require;
  var previous = Object.getOwnPropertyDescriptor(window, 'axe');
  if (previous && !previous.configurable) {
    if (!('value' in previous) || !previous.writable) throw new Error('window.axe is locked by the page');
    window.axe = undefined;
  } else {
    Object.defineProperty(window, 'axe', { value: undefined, writable: true, configurable: true, enumerable: true });
  }
  try {
${source}
;
    var pinned = window.axe;
    if (pinned && typeof pinned.run === 'function') {
      Object.defineProperty(window, ${k}, { value: pinned, writable: false, configurable: false, enumerable: false });
    }
  } finally {
    if (!previous) delete window.axe;
    else if (previous.configurable) Object.defineProperty(window, 'axe', previous);
    else window.axe = previous.value;
  }
})();`;
}

async function runAxe(page, axeSource, { bestPractice = true } = {}) {
  const isReady = (key) => !!window[key] && typeof window[key].run === 'function';
  if (!(await page.evaluate(isReady, AXE_KEY))) {
    await page.addScriptTag({ content: wrapAxeSource(axeSource, AXE_KEY) });
  }
  if (!(await page.evaluate(isReady, AXE_KEY))) {
    throw new Error('axe-core did not initialize on this page (script injection was blocked or the page locks window.axe)');
  }

  const raw = await page.evaluate(async ({ key, tags }) => window[key].run(document, {
    runOnly: { type: 'tag', values: tags },
    resultTypes: ['violations', 'incomplete'],
  }), { key: AXE_KEY, tags: axeTags({ bestPractice }) });
  return normalizeAxeResults(raw);
}

module.exports = {
  AXE_KEY,
  WCAG_TAGS,
  axeTags,
  criteriaFromTags,
  normalizeAxeResult,
  normalizeAxeResults,
  runAxe,
  tagToCriterion,
  wrapAxeSource,
};
