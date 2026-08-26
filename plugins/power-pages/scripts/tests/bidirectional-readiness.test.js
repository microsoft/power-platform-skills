'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { auditBidirectionalReadiness } = require('../lib/bidirectional-readiness');
const { createTempProject, writeProjectFile } = require('./test-utils');

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
