#!/usr/bin/env node
'use strict';

// Backward-compatible alias only. The canonical implementation and CLI are in
// extract-msapp-brief.v2.cjs; keep all extraction logic and tests there.
const extractor = require('./extract-msapp-brief.v2.cjs');

if (require.main === module) {
  console.warn('[brief] DEPRECATED: use scripts/extract-msapp-brief.v2.cjs; forwarding to v2.');
  try {
    extractor.main();
  } catch (err) {
    console.error('[brief] FAILED:', err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

module.exports = extractor;
