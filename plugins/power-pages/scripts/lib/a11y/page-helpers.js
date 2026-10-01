'use strict';

// Helpers that run INSIDE the audited page.
//
// Playwright serializes functions passed to page.evaluate(), so they cannot close
// over Node-side helpers. Rather than copy cssPath/accessibleName into every check,
// installHelpers() defines them once per document on window.__ppA11y and each
// in-page check reads them from there. Navigation discards window, so callers must
// re-install after every goto (ensureHelpers does this idempotently).

function installHelpersInPage() {
  if (window.__ppA11y) return;

  const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

  // Short, stable-enough selector for humans to locate the element in source. Stops
  // at the first id so selectors stay readable on deep SPA trees.
  function cssPath(node) {
    const parts = [];
    let n = node;
    while (n && n.nodeType === 1 && parts.length < 6) {
      let part = n.tagName.toLowerCase();
      if (n.id) {
        parts.unshift(`${part}#${CSS.escape(n.id)}`);
        break;
      }
      const parent = n.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === n.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(n) + 1})`;
      }
      parts.unshift(part);
      n = parent;
    }
    return parts.join(' > ');
  }

  function clean(text, max) {
    return String(text || '').replace(/\s+/g, ' ').trim().replace(EMAIL, '[redacted-email]').slice(0, max);
  }

  // Approximation of the accessible-name algorithm, good enough to give the agent
  // a role+name pair that Playwright's getByRole can find again.
  function accessibleName(el) {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => {
        const ref = document.getElementById(id);
        return ref ? ref.textContent : '';
      }).join(' ');
      if (text.trim()) return clean(text, 80);
    }
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return clean(aria, 80);
    if (el.labels && el.labels.length) return clean(el.labels[0].textContent, 80);
    const alt = el.getAttribute('alt');
    if (alt) return clean(alt, 80);
    const text = el.innerText || el.textContent;
    if (text && text.trim()) return clean(text, 80);
    return clean(el.getAttribute('title') || el.getAttribute('placeholder') || el.value || '', 80);
  }

  function snippet(el) {
    return clean(el.outerHTML, 300);
  }

  function isRendered(el) {
    if (!el.getClientRects().length) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  }

  window.__ppA11y = { cssPath, accessibleName, snippet, clean, isRendered };
}

async function ensureHelpers(page) {
  await page.evaluate(installHelpersInPage);
}

// Email redaction for Node-side strings (axe node HTML, failure summaries). Pages
// viewed while signed in routinely render the user's own address in the header.
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function redact(text, max = 300) {
  return String(text || '').replace(EMAIL_PATTERN, '[redacted-email]').slice(0, max);
}

module.exports = {
  ensureHelpers,
  installHelpersInPage,
  redact,
};
