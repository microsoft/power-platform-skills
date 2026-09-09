'use strict';

const fs = require('node:fs');
const path = require('node:path');

const pluginRoot = path.resolve(__dirname, '../../..');

// Tests inspect reachable documents together; agents still load only their active phase.
function readDocumentTree(entryPath, allowedRoot = path.dirname(entryPath)) {
  const documents = [];
  const seen = new Set();
  const entryParts = path.relative(pluginRoot, entryPath).split(path.sep);
  const skillDirectory = entryParts[0] === 'skills' && entryParts.length > 2
    ? path.join(pluginRoot, 'skills', entryParts[1])
    : allowedRoot;

  function visit(filePath) {
    if (seen.has(filePath)) return;
    seen.add(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    documents.push({ path: filePath, content });
    const prose = content.replace(/^```[^\n]*\r?\n[\s\S]*?^```[^\n]*(?:\r?\n|$)/gm, '');
    for (const match of prose.matchAll(/\[[^\]\n]+\]\(([^)\n]+\.md(?:#[^)\n]*)?)\)/g)) {
      let target = match[1].split('#')[0];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      target = target.replace('${PLUGIN_ROOT}', pluginRoot)
        .replace('${CLAUDE_SKILL_DIR}', skillDirectory);
      if (target.includes('${')) continue;
      const absolute = path.resolve(path.dirname(filePath), target);
      const relative = path.relative(allowedRoot, absolute);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
      visit(absolute);
    }
  }

  visit(path.resolve(entryPath));
  return documents;
}

function readSkillDocuments(skillName) {
  const skillRoot = path.join(pluginRoot, 'skills', skillName);
  return readDocumentTree(path.join(skillRoot, 'SKILL.md'), skillRoot);
}

function readSkillWorkflow(skillName) {
  return readSkillDocuments(skillName).map(document => document.content).join('\n');
}

module.exports = { readDocumentTree, readSkillDocuments, readSkillWorkflow };
