'use strict';

// Helpers that run INSIDE the audited page.
//
// Playwright serializes functions passed to page.evaluate(), so they cannot close
// over Node-side helpers. Rather than copy cssPath/accessibleName into every check,
// installHelpers() defines them once per document on window.__ppA11y and each
// in-page check reads them from there. Navigation discards window, so callers must
// re-install after every goto (ensureHelpers does this idempotently).

// Strips data that must never reach the JSON report or chat from an HTML snippet.
// Reports quote element markup as evidence, and on a signed-in Power Pages page that
// markup can carry live secrets, e.g.:
//   <input type="hidden" name="__RequestVerificationToken" value="CfDJ8...">   (anti-forgery token)
//   <input id="emailaddress1" value="jane@contoso.com">                         (prefilled profile data)
//   <img src="/File/download.aspx?Entity=...&sig=...">                          (signed file URL)
//   <script nonce="r4nd0m">                                                      (CSP nonce)
// So: every `value` attribute and any attribute whose NAME looks like a credential
// is blanked, and query strings are dropped from URL attributes (the path is kept,
// because it is useful evidence). Matches both quote styles and a value cut off by
// truncation ("...` with no closing quote at end of input).
//
// Must stay self-contained (no closures, no requires): ensureHelpers() ships its
// source text into the page so in-page snippets use the exact same rules as Node.
function sanitizeHtml(html) {
  const SENSITIVE_NAME = /^(value|nonce)$|token|secret|passw|csrf|xsrf|session|signature|credential|api-?key/i;
  const URL_ATTR = /^(href|src|srcset|action|formaction|poster|data|cite|background|xlink:href)$/i;
  return String(html || '').replace(/(\s)([^\s"'<>/=]+)(\s*=\s*)("[^"]*"?|'[^']*'?)/g, (match, space, name, eq, quoted) => {
    const q = quoted[0];
    if (SENSITIVE_NAME.test(name)) return `${space}${name}${eq}${q}[redacted]${q}`;
    if (URL_ATTR.test(name)) {
      const closed = quoted.length > 1 && quoted.endsWith(q);
      const inner = quoted.slice(1, closed ? -1 : undefined);
      // srcset is a comma-separated list ("a.png?x=1 1x, b.png?x=2 2x"), so stop at
      // whitespace and commas rather than only at the closing quote.
      const cleaned = inner.replace(/\?[^\s,#]*/g, '?[redacted]');
      return `${space}${name}${eq}${q}${cleaned}${q}`;
    }
    return match;
  });
}

function installHelpersInPage(sanitize) {
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

  // outerHTML of a container can be the whole page; cap it before sanitizing so the
  // regex pass stays cheap. Sanitize before clean() truncates to 300 so a cut can
  // never land in the middle of an unredacted attribute value.
  function snippet(el) {
    return clean(sanitize(el.outerHTML.slice(0, 4000)), 300);
  }

  function isRendered(el) {
    if (!el.getClientRects().length) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  }

  window.__ppA11y = { cssPath, accessibleName, snippet, clean, isRendered };
}

// page.evaluate(fn, arg) can only pass serializable arguments, not a function, so the
// sanitizer travels as source text inside one expression. Both functions are
// module-level constants, never user input.
async function ensureHelpers(page) {
  await page.evaluate(`(${installHelpersInPage})(${sanitizeHtml})`);
}

// Email redaction for Node-side strings (axe node HTML, failure summaries). Pages
// viewed while signed in routinely render the user's own address in the header.
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function redact(text, max = 300) {
  return String(text || '').replace(EMAIL_PATTERN, '[redacted-email]').slice(0, max);
}

// Node-side equivalent of the in-page snippet(): sanitize first, then truncate.
function redactHtml(html, max = 300) {
  return redact(sanitizeHtml(html), max);
}

module.exports = {
  ensureHelpers,
  installHelpersInPage,
  redact,
  redactHtml,
  sanitizeHtml,
};
