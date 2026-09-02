'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LIVE_TOKEN = '__BUILD_PLAN_LIVE__';
const clientTemplate = fs.readFileSync(
  path.join(__dirname, 'mobile-build-plan-client.js.template'),
  'utf8',
).trimEnd();

if (clientTemplate.split(LIVE_TOKEN).length !== 2) {
  throw new Error('Build Plan client template must contain exactly one live-mode token');
}

function renderClientBehavior(live) {
  // Only a serialized boolean is substituted; the resulting file stays standalone and deterministic.
  const source = clientTemplate.replace(LIVE_TOKEN, JSON.stringify(live === true));
  return `<script>\n${source}\n</script>`;
}

module.exports = {
  renderClientBehavior,
};