'use strict';

// Single-in-flight async queue with a per-op timeout.
//
// The form designer is shared mutable state (one DOM, one FormDesignerService),
// so relay operations MUST run one at a time. The id-correlation a socket relay
// would need is unnecessary here because we drive the page synchronously via
// page.evaluate — but we still serialize so two tool calls can't race the
// designer, and we time-box each op so a wedged designer can't hang the MCP call.

class Serializer {
  constructor() {
    this._tail = Promise.resolve();
  }

  // Queue fn to run after all previously-queued ops settle. Returns fn's result
  // (or rejects with its error / a timeout). The internal chain never breaks on
  // error, so one failed op doesn't wedge the queue.
  run(fn, timeoutMs = 15000) {
    const next = this._tail.then(() => {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('op timeout after ' + timeoutMs + 'ms')), timeoutMs);
      });
      return Promise.race([Promise.resolve().then(fn), timeout]).finally(() => clearTimeout(timer));
    });
    this._tail = next.then(() => {}, () => {});
    return next;
  }
}

module.exports = { Serializer };
