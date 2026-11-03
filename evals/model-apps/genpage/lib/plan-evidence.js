'use strict';
// The plan-section primitives (planSection, findMarkdownTable, parseMarkdownRows) moved into the plugin unchanged —
// plugins/model-apps/scripts/lib/plan-sections.js documents the shapes they read — because the plugin's own plan readers use
// them and shipped code must not import an eval module. Re-exported here, the very same functions, so every evaluator keeps
// its import path.
const { planSection, findMarkdownTable, parseMarkdownRows } = require('../../../../plugins/model-apps/scripts/lib/plan-sections.js');

module.exports = { planSection, findMarkdownTable, parseMarkdownRows };
