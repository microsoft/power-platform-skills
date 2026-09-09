'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { readDocumentTree } = require('./helpers/workflow-documents');

const pluginRoot = path.resolve(__dirname, '../..');
const budgets = [
  ['skills/create-mobile-app/SKILL.md', 180, 12000],
  ['skills/design-system/SKILL.md', 160, 10000],
  ['agents/screen-planner.md', 180, 12000],
  ['agents/screen-builder.md', 180, 12000],
];

test('frequently loaded entry points stay bounded instead of embedding every workflow', () => {
  for (const [relativePath, maxLines, maxBytes] of budgets) {
    const content = fs.readFileSync(path.join(pluginRoot, relativePath), 'utf8');
    const lines = content.trimEnd().split(/\r?\n/).length;
    assert.ok(lines <= maxLines, `${relativePath}: ${lines} lines exceeds ${maxLines}`);
    assert.ok(Buffer.byteLength(content) <= maxBytes, `${relativePath} exceeds ${maxBytes} bytes`);
  }
});

test('registered child agents do not require user-interaction or nested-dispatch tools', () => {
  const agentsRoot = path.join(pluginRoot, 'agents');
  for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const content = fs.readFileSync(path.join(agentsRoot, entry.name), 'utf8');
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(frontmatter, `${entry.name} must retain agent metadata`);
    assert.doesNotMatch(
      frontmatter[1],
      /^\s*-\s*(?:AskUserQuestion|EnterPlanMode|ExitPlanMode|Task)\s*$/m,
      `${entry.name}: the foreground owns questions, approvals, and dispatch`,
    );
  }
});

test('bounded entry points retain reachable local references', () => {
  for (const [relativePath] of budgets) {
    const entryPath = path.join(pluginRoot, relativePath);
    const documents = readDocumentTree(entryPath, pluginRoot);
    assert.ok(documents.length > 1, `${relativePath} should route to on-demand references`);
  }
});
