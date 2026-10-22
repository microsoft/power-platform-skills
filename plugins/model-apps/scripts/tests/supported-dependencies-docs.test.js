'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  RUNTIME_DEPENDENCIES,
  DEV_DEPENDENCIES,
  FEATURE_RUNTIME_KEYS,
  FEATURE_DEV_KEYS,
  buildDependencyMap,
  buildDevDependencyMap,
} = require('../lib/supported-dependencies.js');

const ROOT = path.join(__dirname, '..', '..');

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function extractJsonObjectAfter(content, marker) {
  const start = content.indexOf(marker);
  assert.notEqual(start, -1, `missing marker ${marker}`);
  const open = content.indexOf('{', start);
  assert.notEqual(open, -1, `missing JSON object after ${marker}`);
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = open; i < content.length; i += 1) {
    const ch = content[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(content.slice(open, i + 1));
    }
  }
  throw new Error(`unterminated JSON object after ${marker}`);
}

function extractPackageRows(content, heading) {
  const headingIndex = content.indexOf(`## ${heading}`);
  assert.notEqual(headingIndex, -1, `missing heading ${heading}`);
  const nextHeading = content.indexOf('\n## ', headingIndex + 1);
  const section = content.slice(headingIndex, nextHeading === -1 ? content.length : nextHeading);
  const rows = new Map();
  for (const line of section.split(/\r?\n/)) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*([^|]+)\|/);
    if (!m) continue;
    rows.set(m[1], { version: m[2], confidence: m[3].trim() });
  }
  return rows;
}

function assertRowsMatchMap(rows, dependencyMap) {
  assert.deepEqual([...rows.keys()].sort(), Object.keys(dependencyMap).sort());
  for (const [name, meta] of Object.entries(dependencyMap)) {
    assert.equal(rows.get(name).version, meta.version, `${name} version`);
    assert.equal(rows.get(name).confidence, meta.confidence, `${name} confidence`);
  }
}

test('supported-dependencies.md exactly matches the dependency source of truth', () => {
  const doc = read('references/supported-dependencies.md');

  assertRowsMatchMap(extractPackageRows(doc, 'Runtime dependencies'), RUNTIME_DEPENDENCIES);
  assertRowsMatchMap(extractPackageRows(doc, 'Dev dependencies'), DEV_DEPENDENCIES);

  for (const [feature, runtimeKeys] of Object.entries(FEATURE_RUNTIME_KEYS)) {
    for (const dep of runtimeKeys) {
      assert.match(doc, new RegExp(String.raw`\|\s*\`${feature}\`\s*\|\s*\`${dep}\``), `${feature} runtime dependency`);
    }
  }
  for (const [feature, devKeys] of Object.entries(FEATURE_DEV_KEYS)) {
    for (const dep of devKeys) {
      assert.match(doc, new RegExp(String.raw`\|\s*\`${feature}\`[^\n]*\`${dep}\``), `${feature} dev dependency`);
    }
  }
});

test('rules.md generated package example matches the dependency source of truth', () => {
  const rules = read('references/rules.md');
  const dependencies = extractJsonObjectAfter(rules, '"dependencies"');
  const devDependencies = extractJsonObjectAfter(rules, '"devDependencies"');

  assert.deepEqual(dependencies, buildDependencyMap(['charts', 'datepicker', 'timepicker']));
  assert.deepEqual(devDependencies, buildDevDependencyMap(['charts', 'datepicker', 'timepicker']));
});

test('agent-facing dependency guidance points to the source of truth instead of listing versions', () => {
  const agent = read('agents/genpage-page-builder.md');
  assert.match(agent, /supported-dependencies\.md/);
  assert.doesNotMatch(agent, /"@fluentui\/react-icons"\s*:/);
  assert.doesNotMatch(agent, /"d3"\s*:/);
});
