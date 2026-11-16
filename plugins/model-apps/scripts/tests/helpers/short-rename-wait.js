'use strict';
// A rename refused with EPERM, EACCES or EBUSY is waited out on Windows (lib/rename-retry.js: 5 s a rename, 30 s in all for the
// process). A test that keeps a rename failing for good, to see what the caller does with a lock that stays, uses this to wait a
// moment instead. It starts the test from a fresh process total and puts both the budget and the total back when the test ends, so
// no test leaves a spent or shortened budget to the next. Elsewhere there is no wait, so it changes nothing.
const { setDefaultBudgetMs, setProcessWaitedMs } = require('../../lib/rename-retry.js');

function shortRenameWait(t, ms = 40) {
  const previousBudget = setDefaultBudgetMs(ms);
  const previousWaited = setProcessWaitedMs(0);
  t.after(() => {
    setDefaultBudgetMs(previousBudget);
    setProcessWaitedMs(previousWaited);
  });
}

// A test that exercises the default budgets starts from a fresh process total, and puts the old one back.
function freshRenameWaitTotal(t) {
  const previousWaited = setProcessWaitedMs(0);
  t.after(() => setProcessWaitedMs(previousWaited));
}

module.exports = { shortRenameWait, freshRenameWaitTotal };
