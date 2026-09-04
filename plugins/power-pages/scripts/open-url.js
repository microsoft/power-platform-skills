#!/usr/bin/env node
'use strict';

const { openInDefaultBrowser } = require('./lib/default-browser');

// Accepted argv shape:
//   --url https://contoso.powerappsportals.com
// Missing or malformed URLs are reported as JSON so the skill can still show
// the URL to the user even if default-browser opening fails.
function parseArgs(argv) {
  const args = {};
  const idx = argv.indexOf('--url');
  if (idx !== -1) args.url = argv[idx + 1];
  return args;
}

function openUrl({ url }, deps = {}) {
  if (!url || !/^https?:\/\//i.test(url)) return { ok: false, error: 'Usage: open-url.js --url <http(s)-url>' };
  try {
    openInDefaultBrowser(url, deps);
    return { ok: true, url };
  } catch (err) {
    return { ok: false, url, error: err.message };
  }
}

if (require.main === module) {
  process.stdout.write(`${JSON.stringify(openUrl(parseArgs(process.argv.slice(2))), null, 2)}\n`);
}

module.exports = { parseArgs, openUrl };
