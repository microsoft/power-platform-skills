'use strict';

// Helpers for tests that watch HOW a reader is used — which reads were made, how many were in flight at once,
// and in what order — rather than only what it answered.

// One turn of the event loop. A timer's resolution is far coarser (about 15 ms on Windows), and the runs these
// tests make involve hundreds of reads.
const turn = () => new Promise((resolve) => setImmediate(resolve));

// A small stable hash, so a read's latency depends on WHAT it reads and on the run's seed — never on when it
// started — and the same seed delays the same reads however many are allowed at once.
function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

// Wraps every method of `read` (an object of async functions): records the call, counts how many are in flight,
// and delays the answer by `latency(call)` turns of the event loop. `stats.calls` is in the order the reads
// STARTED; `stats.maxInFlight` is the most that were under way together.
function instrument(read, { latency = () => 1 } = {}) {
  const stats = { calls: [], inFlight: 0, maxInFlight: 0 };
  const wrapped = {};
  for (const [name, fn] of Object.entries(read)) {
    wrapped[name] = async (...args) => {
      const call = { name, args };
      stats.calls.push(call);
      stats.inFlight += 1;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      try {
        for (let turns = latency(call); turns > 0; turns--) await turn();
        return await fn(...args);
      } finally {
        stats.inFlight -= 1;
      }
    };
  }
  return { read: wrapped, stats };
}

// The reads of a run as a sorted list: two runs made the same reads exactly when these are equal.
const callKeys = (stats) => stats.calls.map((c) => JSON.stringify([c.name, c.args])).sort();

module.exports = { turn, hash, instrument, callKeys };
