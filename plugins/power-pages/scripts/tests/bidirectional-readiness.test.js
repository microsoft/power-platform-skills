'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const { auditBidirectionalReadiness } = require('../lib/bidirectional-readiness');
const {
  parseArgs,
} = require('../audit-bidirectional-readiness');
const { createTempProject, writeProjectFile } = require('./test-utils');

const AUDIT_PATH = path.join(__dirname, '..', 'audit-bidirectional-readiness.js');

test('parses an optional project root without consuming other options', () => {
  assert.deepEqual(parseArgs([]), {});
  assert.equal(parseArgs(['--projectRoot', '.']).projectRoot, path.resolve('.'));
  assert.throws(
    () => parseArgs(['--projectRoot']),
    /"--projectRoot" requires a value/
  );
  assert.throws(
    () => parseArgs(['--projectRoot', '--unexpected']),
    /"--projectRoot" requires a value/
  );
  assert.throws(
    () => parseArgs(['--projectRoot', '']),
    /"--projectRoot" requires a value/
  );
  assert.throws(
    () => parseArgs(['--projectRoot', '.', '--projectRoot', '..']),
    /"--projectRoot" may be specified only once/
  );
  assert.throws(
    () => parseArgs(['--unexpected']),
    /Unknown or misplaced argument "--unexpected"/
  );
});

test('CLI reports malformed project-root usage without auditing another path', () => {
  const result = spawnSync(
    process.execPath,
    [AUDIT_PATH, '--projectRoot', '--unexpected'],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /"--projectRoot" requires a value/);
  assert.match(result.stderr, /Usage: audit-bidirectional-readiness/);
});

test('accepts logical directional CSS', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'src/theme.css', `
    .callout {
      margin-inline-start: 1rem;
      padding-inline-end: 2rem;
      border-inline-start: 0.25rem solid;
      text-align: start;
    }
  `);

  const result = auditBidirectionalReadiness(projectRoot);
  assert.equal(result.summary.error, 0, JSON.stringify(result.findings));
});

test('blocks unexplained direction-sensitive physical CSS', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'src/theme.css', `
    .callout {
      margin-left: 1rem;
      border-right: 0.25rem solid;
      text-align: left;
    }
  `);

  const result = auditBidirectionalReadiness(projectRoot);
  assert.equal(result.summary.error, 3);
  assert.ok(result.findings.every((item) => item.rule === 'directional-physical-css'));
});

test('blocks physical framework style-object properties', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(
    projectRoot,
    'src/Card.tsx',
    `const padding = { "paddingLeft": '1rem' };
     const alignment = { textAlign: 'left' };
     const quoted = { 'margin-right': '1rem' };
     const template = '<div style="padding-left: 1rem"></div>';`
  );

  const result = auditBidirectionalReadiness(projectRoot);
  assert.equal(result.summary.error, 4);
  assert.ok(result.findings.every((item) => item.rule === 'directional-physical-css'));
});

test('accepts an adjacent validated physical exception', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'src/map.css', `
    .map-controls {
      /* bidi-physical: Map controls follow provider placement; verify=ltr,rtl */
      right: 1rem;
    }
  `);

  const result = auditBidirectionalReadiness(projectRoot);
  assert.equal(result.summary.error, 0, JSON.stringify(result.findings));
  assert.equal(result.findings.length, 0);
});

test('allows one declaration per physical exception', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'src/map.css', `
    /* bidi-physical: Map controls follow provider placement; verify=ltr,rtl */
    .map-controls { margin-left: 1rem; padding-right: 1rem; }
  `);

  const result = auditBidirectionalReadiness(projectRoot);
  assert.equal(result.summary.error, 1);
  assert.equal(result.findings[0].rule, 'directional-physical-css');
});

test('applies a physical exception to the first declaration in source order', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'src/map.css', `
    /* bidi-physical: Pin remains on the provider-defined physical edge; verify=ltr,rtl */
    .map-controls { left: 0; margin-left: 1rem; }
  `);

  const result = auditBidirectionalReadiness(projectRoot);
  assert.equal(result.summary.error, 1);
  assert.equal(result.summary.review, 0);
  assert.equal(result.findings[0].rule, 'directional-physical-css');
});

test('rejects unused or non-adjacent physical exceptions', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'src/map.css', `
    /* bidi-physical: Map controls follow provider placement; verify=ltr,rtl */

    .map-controls {
      right: 1rem;
    }
  `);

  const result = auditBidirectionalReadiness(projectRoot);
  assert.equal(result.summary.error, 1);
  assert.equal(result.findings[0].rule, 'unused-physical-exception');
});

test('reports physical geometry and visual reordering for review', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'src/carousel.css', `
    .track {
      flex-direction: row-reverse;
      transform: translateX(-100%);
    }
  `);

  const result = auditBidirectionalReadiness(projectRoot);
  assert.equal(result.summary.error, 0);
  assert.deepEqual(
    new Set(result.findings.map((item) => item.rule)),
    new Set(['visual-order-review', 'directional-geometry-review'])
  );
});

test('blocks invisible bidi controls in source', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'src/example.ts', "const route = '/safe\u202Egnp';\n");

  const result = auditBidirectionalReadiness(projectRoot);
  assert.equal(result.summary.error, 1);
  assert.equal(result.findings[0].rule, 'unexpected-bidi-control');
});

test('ignores physical-property examples inside multiline comments', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'src/theme.css', `
    /*
     * Avoid physical properties such as:
     * margin-left: 1rem;
     * text-align: right;
     */
    .card {
      margin-inline-start: 1rem;
    }
  `);

  const result = auditBidirectionalReadiness(projectRoot);
  assert.equal(result.summary.error, 0, JSON.stringify(result.findings));
});

test('ignores line-comment findings without requiring whitespace before the comment', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'src/example.ts', `
    const count = 1// margin-left: 1rem;
    const ready = true// direction: 'ltr';
    const step = 2// track.scrollLeft += 100;
    retry: // padding-right: 1rem;
  `);

  const result = auditBidirectionalReadiness(projectRoot);
  assert.equal(result.summary.error, 0, JSON.stringify(result.findings));
  assert.equal(result.summary.review, 0, JSON.stringify(result.findings));
});

test('preserves URL double slashes without hiding later findings', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'src/theme.css', `
    .cdn { background: url(//cdn.example.com/a//b/image.png); margin-left: 1rem; }
    .remote { background: url(https://example.com/a//b/*/image.png); padding-right: 1rem; }
  `);
  writeProjectFile(
    projectRoot,
    'index.html',
    '<p>https://example.com/a//b</p><img src=//cdn.example.com/image.png><div style="margin-left: 1rem"></div>'
  );

  const result = auditBidirectionalReadiness(projectRoot);
  assert.equal(result.summary.error, 3, JSON.stringify(result.findings));
});

test('carries quote state across lines so literal comment markers cannot hide code', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'src/example.ts', `
    const marker = \`
      /*
    \`;
    const styles = { marginLeft: '1rem' };
  `);

  const result = auditBidirectionalReadiness(projectRoot);
  assert.equal(result.summary.error, 1, JSON.stringify(result.findings));
  assert.equal(result.findings[0].rule, 'directional-physical-css');
});

test('audit CLI exits nonzero when blocking findings exist', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'src/theme.css', '.card { margin-left: 1rem; }');

  const result = spawnSync(
    process.execPath,
    [AUDIT_PATH, '--projectRoot', projectRoot],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).summary.error, 1);
});
