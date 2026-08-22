'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');
const deleted = [
  ['mcp-design-', 'queries.md'], ['design-spec-', 'extraction.md'], ['code-app-', 'extraction.md'],
  ['figma-', 'extraction.md'], ['power-pages-', 'extraction.md'], ['canvas-app-', 'extraction.md'],
  ['linear-', 'design.md'], ['intercom-', 'design.md'], ['uber-', 'design.md'], ['sentry-', 'design.md'],
  ['brand-', 'examples.md'], ['universal-', 'patterns.md'], ['tamagui-component-', 'recipes.md'],
].map((parts) => parts.join(''));

function walk(directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target, output);
    else if (entry.isFile()) output.push(target);
  }
  return output;
}

test('derivation contract is concise and injected before styling references', () => {
  const contract = fs.readFileSync(path.join(pluginRoot, 'shared', 'references', 'derivation-contract.md'), 'utf8');
  assert.ok(contract.split('\n').length <= 45);
  for (const phrase of ['Every screen states a fact', 'One screen, one story', 'Reinforce, do not repeat', 'Every count answers', 'Imagery is chosen by data', 'Static words never occupy derived slots', 'largest text is the subject']) {
    assert.match(contract, new RegExp(phrase, 'i'));
  }
  const skill = fs.readFileSync(path.join(pluginRoot, 'skills', 'create-mobile-prototype', 'SKILL.md'), 'utf8');
  assert.ok(skill.indexOf('derivation-contract.md') < skill.indexOf('styling reference'));
});

test('deleted prose catalogues have zero inbound references and stay deleted', () => {
  const files = walk(pluginRoot);
  const contents = files.filter((file) => /\.(?:md|js|ts|tsx|json|yml|yaml)$/.test(file)).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  for (const name of deleted) {
    assert.equal(files.some((file) => path.basename(file) === name), false, `${name} still exists`);
    assert.equal(contents.includes(name), false, `${name} still referenced`);
  }
});

test('shared component APIs live in code and context inventory instead of recipes', () => {
  const components = fs.readFileSync(path.join(pluginRoot, 'shared', 'samples', 'src', 'components', 'index.tsx'), 'utf8');
  const context = fs.readFileSync(path.join(pluginRoot, 'shared', 'context-pack.md'), 'utf8');
  const exports = [...components.matchAll(/^export function ([A-Za-z][A-Za-z0-9]*)/gm)].map((match) => match[1]);
  assert.equal(exports.length, 24);
  for (const component of exports) assert.match(context, new RegExp('^- `' + component + '`$', 'm'));
});