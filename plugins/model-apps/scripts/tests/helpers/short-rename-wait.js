'use strict';
// A rename refused with EPERM, EACCES or EBUSY is waited out on Windows for about a minute (lib/rename-retry.js). A test that keeps a
// rename failing for good, to see what the caller does with a lock that stays, uses this to wait a moment instead; the wait is
// restored when the test ends. Elsewhere there is no wait, so it changes nothing.
const { setDefaultBudgetMs } = require('../../lib/rename-retry.js');

function shortRenameWait(t, ms = 40) {
  const previous = setDefaultBudgetMs(ms);
  t.after(() => setDefaultBudgetMs(previous));
}

module.exports = { shortRenameWait };
