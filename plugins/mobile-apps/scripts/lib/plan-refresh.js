'use strict';

const crypto = require('node:crypto');

// Embedded in both standalone pages. Keep this function self-contained: file:// pages
// cannot fetch a helper or progress endpoint, and installed plugins have no repo-root assets.
function watchPlan(options) {
  var MAX_UNCHANGED_RELOADS = 30;
  var RELOAD_MS = options.reloadMs;
  var QUIET_MS = options.quietMs;
  var lastInteraction = 0;
  var message = document.getElementById('refreshStatus');
  var url = new URL(location.href);
  // Only our cache-busting navigations carry these fields, e.g.
  // ?planProgress=<sha256>&planReloads=3&t=<milliseconds>. Unlike sessionStorage,
  // the URL survives file:// reloads even when browser storage is unavailable.
  var previous = url.searchParams.get('planProgress');
  var rawCount = url.searchParams.get('planReloads') || '';
  var count = previous === options.progress && /^\d+$/.test(rawCount)
    ? Number(rawCount) : 0;
  if (!Number.isSafeInteger(count)) count = MAX_UNCHANGED_RELOADS;
  // Browser reload retains the polling query string, but must renew the budget.
  // location.replace() is a "navigate" entry, so automatic polls cannot reset it.
  // https://www.w3.org/TR/navigation-timing-2/#dom-performancenavigationtiming-type
  var navigation = performance.getEntriesByType('navigation')[0];
  if (navigation && navigation.type === 'reload') count = 0;

  function refresh() {
    var fresh = new URL(location.href);
    fresh.searchParams.set('planProgress', options.progress);
    fresh.searchParams.set('planReloads', String(count + 1));
    // Atomic rewrites have no file:// cache headers. A distinct URL picks up the
    // new file; replace avoids adding every poll to the reader's back history.
    fresh.searchParams.set('t', String(Date.now()));
    location.replace(fresh.href);
  }

  if (options.settled) {
    message.textContent = 'Auto-refresh off: run finished or stopped.';
    return;
  }
  if (options.waiting) {
    message.textContent = 'Auto-refresh paused while waiting for input. Reload the browser after answering.';
    return;
  }
  if (count >= MAX_UNCHANGED_RELOADS) {
    message.textContent = 'Auto-refresh paused: no new progress. Reload the browser to check or resume.';
    return;
  }
  message.textContent = 'Auto-refresh on while progress changes.';
  ['scroll', 'keydown', 'pointerdown'].forEach(function (event) {
    window.addEventListener(event, function () { lastInteraction = Date.now(); }, { passive: true });
  });
  setInterval(function () {
    if (Date.now() - lastInteraction < QUIET_MS) return;
    if (document.hidden) return;
    refresh();
  }, RELOAD_MS);
}

function planRefreshScript(progress, options) {
  // Hash actual progress, never render time or the random CSP nonce. Rewriting an
  // unchanged plan must not renew its polling budget or conceal an interrupted run.
  const marker = crypto.createHash('sha256').update(JSON.stringify(progress)).digest('hex');
  return `(${watchPlan.toString()})(${JSON.stringify({ ...options, progress: marker })});`;
}

module.exports = { planRefreshScript };
