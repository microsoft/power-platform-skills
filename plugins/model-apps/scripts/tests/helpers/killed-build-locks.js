'use strict';
// What a killed build leaves of its locks, for a test that "kills" a build by leaving it unsettled in the test's own process.
//
// A test of what a killed build leaves behind (SIGKILL, "End task", an agent's timeout) can run the build in its own process and leave it unsettled
// — a request that never answers, and nothing of the run happens after that moment — and then run the next build there, as a new process would.
// A real kill also ENDS the process: the locks the build held (lib/app-operation-lease.js — the build lock, and in the pages phase the two pages
// locks) stay in the workspace under its pid, and a later build takes them over once that pid is gone (lib/process-owner.js). In one process the pid
// is this one, which runs, so the next build would be refused as a second concurrent build — rightly, for a build that is still running. This makes
// the locks say what a real kill leaves: each lock this process holds in the workspace is handed to a process that has ended. Nothing else changes.
const fs = require('node:fs');
const path = require('node:path');
const { ownerStamp } = require('../../lib/process-owner.js');
const { deadPid } = require('./kill-target-client.js');

const LOCK = /^(?:app-build\.[0-9a-f]{64}|app-pages\.[0-9a-f]{64}|pages-.+)\.lock$/;

// Answers { pid, locks }: the pid the locks now name, and the names of the locks handed to it.
function leaveLocksOfKilledBuild(workspaceDir) {
  const gone = deadPid();
  const locks = [];
  for (const name of fs.readdirSync(workspaceDir).sort()) {
    if (!LOCK.test(name)) continue;
    const file = path.join(workspaceDir, name);
    let held;
    try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!held || held.pid !== process.pid) continue;
    fs.writeFileSync(file, JSON.stringify({ ...ownerStamp({ pid: gone }), rnd: held.rnd }));
    locks.push(name);
  }
  return { pid: gone, locks };
}

module.exports = { leaveLocksOfKilledBuild };
