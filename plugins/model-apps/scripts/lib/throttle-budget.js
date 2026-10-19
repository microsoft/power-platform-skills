'use strict';
// The budget a run allows itself for the waiting it does when the service throttles.
//
// Three layers of a run wait out a throttle. The HTTP client (lib/sdk-http-client.js) sends a throttled read, publish, delete or column create again — at most five re-sends, after the schedule's wait (1, 2, 4, 8 and 8 s) or after what the
// answer's `Retry-After` asks. The page backend (lib/genpage-sdk.js) sends a throttled page write again after each answer — a page's change set is a `$batch` the client never re-sends — waiting what the service asked or its own schedule.
// And when those sends are not enough, the build (build-model-app.js) runs the phase again after a wait of its own. With an account in each layer, a service that kept asking for a minute would cost one page 24 sends and about twenty minutes
// of waiting in which nothing was said, and the wait the service asked for would be lost where the one layer hands over to the other.
//
// So the waiting those layers do for a throttle is ONE budget — five minutes — shared by all of them: each asks `fits(ms)` before a wait, `spend`s it when it takes it, and stops, saying what the service asked, when it does not fit
// (`waitDoesNotFit`). The layers wait with seams of their own (the client's and the backend's `deps.sleep`, the build's `deps.sleep`), so this only COUNTS; a wait is counted whole when it is scheduled, however it ends. What a wait of more than a few
// seconds says is a line on the `warn` seam the caller gives, which the build wires to stderr: stdout carries the JSON result. The build makes the budget and hands it to the HTTP client of its SDK, to the page backend (which gives it to the client it
// makes) and to every page write; the upload script makes one for its run and hands it to its backend. A page write that is given none, by a backend that was handed none, makes one of its own for that write.
//
// The client's waits can overlap: it sends several requests at once, and a service that throttles them answers them alike, so they wake together. What a run waited is the time it spent waiting, not the sum of its requests' waits, so a wait that
// is PLACED on the clock (`spend(ms, at)`, `at` the moment it starts) adds only what runs past the end of the waits placed before it. The backend and the build wait one at a time, place nothing, and add whole.
//
// A throttled request that the client will not wait for, because the wait does not fit, is handed back as it came: the SDK reports it as the 429 it is, which says nothing of what the service asked or of why nothing more was sent. So the client
// says so here (`decline`), and the build, which owns the halt, reads it (`declined`).
//
// What is NOT drawn from it is a wait that is not for a throttle: the client keeps its own schedule for a 5xx (a customization lock, a SQL deadlock victim, a gateway), a reset connection and the re-send of a deadlock victim. And a script that
// gives its client no budget — every script but the build and the page upload — waits as it always did.
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
  // The end, on the clock of the callers that place their waits, of the latest wait placed so far.
  let placedUntil = 0;
  // The waits that did not fit, as the HTTP client met them: how many, the longest the service asked for and the longest wait, and the longest wait already said.
  let declines = 0;
  let declinedAskMs = 0;
  let declinedWaitMs = 0;
  let saidWaitMs = 0;
  // What a wait of `ms` adds to what the run has waited. A wait that is placed (`at` is a moment) adds only what runs past the end of the waits placed before it — it may overlap them, and what is waited together is waited once; one that is not
  // placed is added whole.
  const addedBy = (ms, at) => (Number.isFinite(at) ? Math.max(0, at + ms - Math.max(placedUntil, at)) : ms);
  const budget = {
    totalMs,
    spentMs: () => spent,
    remainingMs: () => Math.max(0, totalMs - spent),
    // Whether a wait of `ms` is within what is left — to the millisecond, so a wait that takes the last of the budget fits. `at` places it (see addedBy): it fits when what it would add does.
    fits: (ms, at) => addedBy(ms, at) <= totalMs - spent,
    // Takes a wait of `ms` out of the budget, and answers what it added. A value that is no wait (not a number, not positive) is none. `at`, the moment the wait starts, places it: it adds only what runs past the waits placed before it.
    spend(ms, at) {
      if (!(Number.isFinite(ms) && ms > 0)) return 0;
      const added = addedBy(ms, at);
      spent += added;
      if (Number.isFinite(at)) placedUntil = Math.max(placedUntil, at + ms);
      return added;
    },
    // Says `message` when the wait of `ms` is longer than a few seconds, and only then.
    announce(message, ms) { if (ms > QUIET_WAIT_MS && typeof warn === 'function') warn(message); },
    // A wait of `waitMs` that the HTTP client did not take, because it did not fit; `askedMs` is what the service asked, when it asked. It is said once for each wait longer than any said before: four requests that are refused together are one line.
    decline({ askedMs = 0, waitMs } = {}) {
      const finite = (ms) => (Number.isFinite(ms) && ms > 0 ? ms : 0);
      declines += 1;
      declinedAskMs = Math.max(declinedAskMs, finite(askedMs));
      declinedWaitMs = Math.max(declinedWaitMs, finite(waitMs));
      if (finite(waitMs) > saidWaitMs) {
        saidWaitMs = finite(waitMs);
        if (typeof warn === 'function') warn(waitDoesNotFit(budget, { askedMs: finite(askedMs), waitMs: finite(waitMs) }));
      }
    },
    // How many waits did not fit, and the longest the service asked and the longest wait among them: what the build reads to say that the budget stopped a request.
    declined: () => ({ count: declines, askedMs: declinedAskMs, waitMs: declinedWaitMs }),
    // How much of the budget is gone, in the words of the line that announces a wait.
    note: () => spentNote(budget),
  };
  return budget;
}

// What a run says about how much of the budget is gone, for the line that announces a wait: "47 s of the 5 minutes a run allows itself for waiting out a throttled service are spent". It is a "run" because the budget is
// the build's and the upload's alike (the upload script makes one for its run; a page write that is given none, by a backend that was handed none, makes one of its own for that write). It says what the run ALLOWS ITSELF for a throttle's waits: the waits that are not for a throttle are not drawn from it.
function spentNote(budget) {
  return `${seconds(budget.spentMs())} of the ${sizeOf(budget.totalMs)} a run allows itself for waiting out a throttled service are spent`;
}

// What a run says when the next wait does not fit: what the service asked (when it asked), how much of the budget is gone, and that a later run of the same command goes on from here — the build is idempotent, so it reuses
// everything already built, and a write that was refused wrote nothing. `askedMs` is the service's request, `waitMs` the wait the layer would have taken (the longer of the request and its own schedule).
function waitDoesNotFit(budget, { askedMs = 0, waitMs }) {
  const lead = askedMs > 0 ? `the service asked to wait ${seconds(askedMs)} before the next send, which does not fit` : `the next wait, ${seconds(waitMs)}, does not fit`;
  return `${lead} in what is left of the ${sizeOf(budget.totalMs)} a run allows itself for waiting out a throttled service (${seconds(budget.spentMs())} are spent). Nothing more is sent now: run the same command again later, and it continues from here.`;
}

module.exports = { THROTTLE_BUDGET_MS, QUIET_WAIT_MS, makeThrottleBudget, waitDoesNotFit, spentNote };
