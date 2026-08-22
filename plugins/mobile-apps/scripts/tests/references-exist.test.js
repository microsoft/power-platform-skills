'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');

function walk(directory, include) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(entryPath, include));
    else if (entry.isFile() && include(entryPath)) files.push(entryPath);
  }
  return files;
}

function sourceFiles() {
  return [
    ...walk(path.join(pluginRoot, 'skills'), (filePath) => path.basename(filePath) === 'SKILL.md'),
    ...walk(path.join(pluginRoot, 'agents'), () => true),
    ...walk(path.join(pluginRoot, 'hooks'), () => true),
  ].sort();
}

function scriptReferences(contents) {
  const pattern = /\$\{(?:PLUGIN_ROOT|CLAUDE_SKILL_DIR)\}\/(?:\.\.\/|\.\/|[A-Za-z0-9_.-]+\/)*scripts\/[A-Za-z0-9_./-]+\.js|(?:\.\.\/)+(?:[A-Za-z0-9_.-]+\/)*scripts\/[A-Za-z0-9_./-]+\.js|(?:skills\/[A-Za-z0-9_./-]+\/)?scripts\/[A-Za-z0-9_./-]+\.js/g;
  return [...new Set(contents.match(pattern) || [])];
}

function resolveReference(sourceFile, reference) {
  if (reference.startsWith('${PLUGIN_ROOT}/')) {
    return path.resolve(pluginRoot, reference.slice('${PLUGIN_ROOT}/'.length));
  }
  if (reference.startsWith('${CLAUDE_SKILL_DIR}/')) {
    return path.resolve(path.dirname(sourceFile), reference.slice('${CLAUDE_SKILL_DIR}/'.length));
  }
  if (reference.startsWith('../') || reference.startsWith('./')) {
    return path.resolve(path.dirname(sourceFile), reference);
  }
  return path.resolve(pluginRoot, reference);
}

test('all JavaScript scripts referenced by mobile skills, agents, and hooks exist and parse', () => {
  const missing = [];
  const referencesByTarget = new Map();

  for (const sourceFile of sourceFiles()) {
    const contents = fs.readFileSync(sourceFile, 'utf8');
    for (const reference of scriptReferences(contents)) {
      const target = resolveReference(sourceFile, reference);
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        missing.push(`${path.relative(pluginRoot, sourceFile)} -> ${reference} -> ${path.relative(pluginRoot, target)}`);
        continue;
      }
      const sources = referencesByTarget.get(target) || [];
      sources.push(`${path.relative(pluginRoot, sourceFile)} -> ${reference}`);
      referencesByTarget.set(target, sources);
    }
  }

  assert.deepEqual(missing, [], `Missing referenced scripts:\n${missing.join('\n')}`);
  assert.ok(referencesByTarget.size > 0, 'Expected at least one referenced script');

  const syntaxErrors = [];
  for (const [target, sources] of referencesByTarget) {
    const result = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
    if (result.status !== 0) {
      syntaxErrors.push(
        `${path.relative(pluginRoot, target)}\nReferenced by:\n  ${sources.join('\n  ')}\n${result.stderr || result.stdout}`,
      );
    }
  }
  assert.deepEqual(syntaxErrors, [], `Referenced scripts with syntax errors:\n${syntaxErrors.join('\n')}`);
});

module.exports = {
  resolveReference,
  scriptReferences,
  sourceFiles,
};