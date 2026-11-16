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
  // About five minutes on the build plan and a minute on the edit plan; only the status line uses it.
  var LONG_IDLE_CHECKS = 30;

  // Version mode. A file:// page cannot fetch, so it cannot ask whether its own file changed, but
  // it can load a classic script. Each render writes options.versionFile beside the page:
  //   window.__planVersion && window.__planVersion("<16 hex>");
  // and the page loads it on every tick, reloading only when the version differs. A check changes
  // nothing on screen, so it runs for as long as the page is open: through input gates, where the
  // page must show the next step once the user answers in the terminal, and through long steps.
  // Stopping after a run of unchanged checks left the page stale for good once a step took longer
  // than that, so the long-idle count only changes the status line.
  // If the file cannot load (a browser that blocks file scripts), the page falls back to the timed
  // refresh below, which does reload on every tick and so keeps its pause at input gates and its
  // unchanged-reload budget.
  var versioned = Boolean(options.versionFile);
  var stale = !versioned;
  var stopped = false;
  var unchangedChecks = 0;
  // Set once the reader is seen outside this window: another app (the terminal), another tab, or a
  // hidden page. A reload cannot interrupt a reader who was elsewhere, so the quiet window and the
  // page's busy signal do not hold it back; the next interaction with the page clears it.
  var away = false;
  // Captured now: currentScript is only set while this script first runs, not in later callbacks.
  var nonce = (document.currentScript && document.currentScript.nonce) || '';

  function stop(text) {
    stopped = true;
    message.textContent = text;
  }

  function readerElsewhere() {
    return document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus());
  }

  function touch() {
    lastInteraction = Date.now();
    away = false;
  }
  // The page reports interactions these listeners cannot see, such as the reader leaving the live
  // preview frame, whose own events go to that cross-origin frame's document.
  window.planRefreshTouch = touch;

  function readerBusy() {
    if (Date.now() - lastInteraction < QUIET_MS) return true;
    // A page can report that the reader is busy in a way these listeners cannot see. The build
    // plan does so while the pointer is over the live preview.
    return typeof window.planRefreshBusy === 'function' && Boolean(window.planRefreshBusy());
  }

  function tryReload() {
    if (stopped || !stale || document.hidden) return;
    if (readerElsewhere()) away = true;
    if (!away && readerBusy()) return;
    refresh();
  }

  function fallBack() {
    versioned = false;
    stale = true;
    if (options.waiting) stop(PAUSED_WAITING);
    else if (count >= MAX_UNCHANGED_RELOADS) stop(PAUSED_UNCHANGED);
    else message.textContent = 'Auto-refresh on while progress changes.';
  }

  function checkVersion() {
    var probe = document.createElement('script');
    // The nonce lets the probe past this page's CSP, which admits only nonced scripts.
    if (nonce) probe.setAttribute('nonce', nonce);
    probe.addEventListener('load', function () { probe.remove(); });
    probe.addEventListener('error', function () {
      probe.remove();
      if (versioned) fallBack();
    });
    // A fresh URL each time, so a cached copy of the version is never read.
    probe.src = options.versionFile + '?t=' + Date.now();
    (document.head || document.body).appendChild(probe);
  }

  if (versioned) {
    window.__planVersion = function (version) {
      if (!versioned || stale) return;
      if (version !== options.version) {
        stale = true;
        // Reload now rather than on the next tick: the change is already on disk.
        tryReload();
        return;
      }
      unchangedChecks += 1;
      if (unchangedChecks === LONG_IDLE_CHECKS && !options.waiting) {
        message.textContent = 'No new progress for a while. Still checking: this page updates when the run continues.';
      }
    };
    message.textContent = options.waiting
      ? 'Waiting for your input. This page updates when the run continues.'
      : 'Auto-refresh on: this page updates when the plan changes.';
    // Ask at once: the plan may have moved on between this render and this page loading.
    checkVersion();
  } else {
    fallBack();
  }
  if (stopped) return;

  // `wheel` and `touchmove`, not `scroll`: the page restores the reader's scroll position after
  // every reload, and that programmatic scroll would count as reading and hold off the next update.
  ['wheel', 'touchmove', 'keydown', 'pointerdown'].forEach(function (event) {
    window.addEventListener(event, touch, { passive: true });
  });
  // Coming back to the page is when the reader wants it current: check at once instead of on the
  // next tick, and reload straight away if the plan moved on while they were elsewhere.
  function returned() {
    if (document.hidden) return;
    if (stale) tryReload();
    else if (versioned) checkVersion();
  }
  document.addEventListener('visibilitychange', returned);
  window.addEventListener('focus', returned);

  setInterval(function () {
    if (stopped) return;
    if (readerElsewhere()) away = true;
    if (versioned && !stale) {
      checkVersion();
      return;
    }
    tryReload();
  }, RELOAD_MS);
}

/**
 * The script the page loads to learn the newest version, e.g.
 *   window.__planVersion && window.__planVersion("9f2c41d07ab35e60");
 * Written after the page itself, so a reader that sees the new version reloads into the new page.
 * A file:// page may load a classic script but not fetch, which is why this is JavaScript.
 */
function versionScript(version, pageName) {
  return `// Written on every render. ${pageName} loads it to see if it is stale.\n`
    + `window.__planVersion && window.__planVersion(${JSON.stringify(version)});\n`;
}

/** A short stable fingerprint of what a page shows, for the version file. */
function progressVersion(progress) {
  return crypto.createHash('sha256').update(JSON.stringify(progress)).digest('hex').slice(0, 16);
}

function planRefreshScript(progress, options) {
  // Hash actual progress, never render time or the random CSP nonce. Rewriting an
  // unchanged plan must not renew its polling budget or conceal an interrupted run.
  const marker = crypto.createHash('sha256').update(JSON.stringify(progress)).digest('hex');
  return `(${watchPlan.toString()})(${JSON.stringify({ ...options, progress: marker })});`;
}

module.exports = { planRefreshScript, progressVersion, versionScript };
