'use strict';

function htmlCompanionsEnabled(value = process.env.MOBILE_APP_HTML_COMPANIONS) {
  if (value === undefined || value === '1') return true;
  if (value === '0') return false;
  throw new Error('MOBILE_APP_HTML_COMPANIONS must be 0 or 1');
}

module.exports = { htmlCompanionsEnabled };
