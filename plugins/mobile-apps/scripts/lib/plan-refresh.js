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

  var PAUSED_WAITING = 'Auto-refresh paused while waiting for input. Reload the browser after answering.';
  var PAUSED_UNCHANGED = 'Auto-refresh paused: no new progress. Reload the browser to check or resume.';
  // Version mode, used by the create plan. Every reload restarts the live app in the plan's phone
  // on its first screen with its sample data reset, so that page reloads only when the plan
  // changed. A file:// page cannot fetch, so it cannot ask whether its own file changed, but it
  // can load a classic script: app-docs.js rewrites options.versionFile beside the page on every
  // render as
  //   window.__planVersion && window.__planVersion("<16 hex>");
  // and each tick loads it again. A check reloads nothing, so it continues at input gates, where
  // the page must show the next step once the user answers in the terminal. Unchanged checks
  // count against the same budget as unchanged reloads, so an interrupted run still stops.
  // If the file cannot load (a browser that blocks file scripts), `versioned` turns false and the
  // page falls back to the timed refresh above, waiting pause included.
  var versioned = Boolean(options.versionFile);
  var planChanged = false;
  var unchangedChecks = 0;
  var stopped = false;
  // Captured now: currentScript is only set while this script first runs, not in later callbacks.
  var nonce = (document.currentScript && document.currentScript.nonce) || '';

  function stop(text) {
    stopped = true;
    message.textContent = text;
  }

  function checkVersion() {
    var probe = document.createElement('script');
    // The nonce lets the probe past this page's CSP, which admits only nonced scripts.
    if (nonce) probe.setAttribute('nonce', nonce);
    probe.addEventListener('load', function () { probe.remove(); });
    probe.addEventListener('error', function () {
      versioned = false;
      probe.remove();
      if (options.waiting) stop(PAUSED_WAITING);
    });
    // A fresh URL each time, so a cached copy of the version is never read.
    probe.src = options.versionFile + '?t=' + Date.now();
    (document.head || document.body).appendChild(probe);
  }

  if (versioned) {
    window.__planVersion = function (version) {
      if (version !== options.version) planChanged = true;
      else unchangedChecks += 1;
    };
    message.textContent = options.waiting
      ? 'Waiting for your input. This page updates when the run continues.'
      : 'Auto-refresh on while progress changes.';
    // Ask at once: the plan may have moved on between this render and this page loading.
    checkVersion();
  }
  if (stopped) return;
  if (!versioned && options.waiting) {
    message.textContent = PAUSED_WAITING;
    return;
  }
  if (count >= MAX_UNCHANGED_RELOADS) {
    message.textContent = PAUSED_UNCHANGED;
    return;
  }
  if (!versioned) message.textContent = 'Auto-refresh on while progress changes.';
  ['scroll', 'keydown', 'pointerdown'].forEach(function (event) {
    window.addEventListener(event, function () { lastInteraction = Date.now(); }, { passive: true });
  });
  setInterval(function () {
    if (stopped) return;
    if (versioned && !planChanged) {
      if (unchangedChecks >= MAX_UNCHANGED_RELOADS) {
        stop(PAUSED_UNCHANGED);
        return;
      }
      checkVersion();
      return;
    }
    if (Date.now() - lastInteraction < QUIET_MS) return;
    // A page can report that the reader is busy in a way these listeners cannot see. The create
    // plan does so while the reader uses the live preview: that cross-origin frame's clicks and
    // keys never reach this window. Busy restarts the quiet window, as an interaction does.
    if (typeof window.planRefreshBusy === 'function' && window.planRefreshBusy()) {
      lastInteraction = Date.now();
      return;
    }
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
