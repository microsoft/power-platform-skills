'use strict';
// A clock for lib/process-runner.js `spawnResultTree` (its `deps.clock`) whose timers start counting only once `file` exists — the file the program under test writes when it
// runs. A machine that is slow to start that program (cmd.exe, then node, on a loaded runner) cannot have the call ended before there is a program to end, so what a test measures
// is the ending of the call, not the speed of the start.
const fs = require('node:fs');

/** @param {string} file - a path the program writes as soon as it runs */
function clockStartedWith(file) {
  return {
    setTimeout: (fn, ms) => {
      const handle = { cancelled: false, timer: null, unref() {} };
      const arm = () => {
        if (handle.cancelled) return;
        handle.timer = fs.existsSync(file) ? setTimeout(fn, ms) : setTimeout(arm, 20);
      };
      arm();
      return handle;
    },
    clearTimeout: (handle) => {
      handle.cancelled = true;
      clearTimeout(handle.timer);
    },
  };
}

module.exports = { clockStartedWith };
