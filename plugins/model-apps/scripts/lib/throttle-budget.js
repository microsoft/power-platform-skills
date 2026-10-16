'use strict';
// The one budget a run spends on waiting out a throttled service.
//
// A throttle is waited out in two places. The page backend (lib/genpage-sdk.js) sends a throttled page write again after each answer, waiting what the service asked (`Retry-After`) or its own schedule; and when its
// sends are not enough, the build (build-model-app.js) runs the pages phase again after a wait of its own. With an account in each layer, a service that kept asking for a minute would cost one page 24 sends and
// about twenty minutes of waiting in which nothing was said, and the wait the service asked for would be lost where the one layer hands over to the other.
//
// So the waiting of one run is ONE budget — five minutes — shared by both layers: each asks `fits(ms)` before a wait, `spend`s it
// when it takes it, and stops, saying what the service asked, when it does not fit (`waitDoesNotFit`). The layers wait with seams of their own (the backend's `deps.sleep`, the build's `deps.sleep`), so this only COUNTS;
// a wait is counted whole when it is scheduled, however it ends. What a wait of more than a few seconds says is a line on the `warn` seam the caller gives, which the build wires to stderr: stdout carries the JSON result.
// The build makes the budget and hands it to every page write; a page write that is given none (the upload script's) makes one of its own for that write.
// See https://learn.microsoft.com/power-apps/developer/data-platform/api-limits#retry-operations for what the service asks.
const THROTTLE_BUDGET_MS = 5 * 60 * 1000;
// A wait this short is not worth a line: the first waits of the schedule (1 s, 2 s, 4 s) and a short `Retry-After` pass in silence.
const QUIET_WAIT_MS = 5000;

const seconds = (ms) => `${Math.ceil(ms / 1000)} s`;
// `300000` is "5 minutes", `60000` "1 minute", and a budget that is not whole minutes is said in seconds.
const sizeOf = (ms) => (ms % 60000 === 0 ? `${ms / 60000} minute${ms === 60000 ? '' : 's'}` : `${Math.ceil(ms / 1000)} seconds`);

// `warn(message)` is the caller's line seam (optional); `totalMs` is for a caller that wants another size.
function makeThrottleBudget({ totalMs = THROTTLE_BUDGET_MS, warn } = {}) {
  let spent = 0;
  return {
    totalMs,
    spentMs: () => spent,
    remainingMs: () => Math.max(0, totalMs - spent),
    // Whether a wait of `ms` is within what is left — to the millisecond, so a wait that takes the last of the budget fits.
    fits: (ms) => ms <= totalMs - spent,
    // A value that is no wait (not a number, not positive) is none.
    spend(ms) { if (Number.isFinite(ms) && ms > 0) spent += ms; },
    // Says `message` when the wait of `ms` is longer than a few seconds, and only then.
    announce(message, ms) { if (ms > QUIET_WAIT_MS && typeof warn === 'function') warn(message); },
  };
}

// What a run says about how much of the budget is gone, for the line that announces a wait: "47 s of the 5 minutes a run spends in all on waiting out a throttled service are spent". It is a "run" because the budget is
// the build's and the upload's alike (an upload that is given none makes one of its own for its write).
function spentNote(budget) {
  return `${seconds(budget.spentMs())} of the ${sizeOf(budget.totalMs)} a run spends in all on waiting out a throttled service are spent`;
}

// What a run says when the next wait does not fit: what the service asked (when it asked), how much of the budget is gone, and that a later run of the same command goes on from here — the build is idempotent, so it reuses
// everything already built, and a write that was refused wrote nothing. `askedMs` is the service's request, `waitMs` the wait the layer would have taken (the longer of the request and its own schedule).
function waitDoesNotFit(budget, { askedMs = 0, waitMs }) {
  const lead = askedMs > 0 ? `the service asked to wait ${seconds(askedMs)} before the next send, which does not fit` : `the next wait, ${seconds(waitMs)}, does not fit`;
  return `${lead} in what is left of the ${sizeOf(budget.totalMs)} a run spends in all on waiting out a throttled service (${seconds(budget.spentMs())} are spent). Nothing more is sent now: run the same command again later, and it continues from here.`;
}

module.exports = { THROTTLE_BUDGET_MS, QUIET_WAIT_MS, makeThrottleBudget, waitDoesNotFit, spentNote };
