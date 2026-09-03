'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { auditBidirectionalReadiness } = require('../lib/bidirectional-readiness');
const { createTempProject, writeProjectFile } = require('./test-utils');

const cliPath = path.join(__dirname, '..', 'audit-bidirectional-readiness.js');

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

test('blocks fixed CSS and element direction but allows the root document direction', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'index.html', '<html lang="he-IL" dir="rtl"><body></body></html>');
  writeProjectFile(projectRoot, 'src/Form.tsx', `
    const styles = { direction: 'ltr' };
    const multilineStyles = {
      direction: 'rtl',
    };
    export const Form = () => <input dir="ltr" style={styles} />;
  `);
  writeProjectFile(projectRoot, 'src/Menu.vue', `<Menu :dir="'ltr'" />`);
  writeProjectFile(projectRoot, 'src/dialog.component.html', `<dialog [attr.dir]="'ltr'"></dialog>`);
  writeProjectFile(projectRoot, 'src/Multiline.tsx', `
    export const Input = () => <input
      onChange={() =>
        update()
      }
      dir="ltr"
    />;
  `);
  writeProjectFile(projectRoot, 'src/locale.ts', `
    export const localeMetadata = { direction: 'ltr' };
    export const multilineLocaleMetadata = {
      direction: 'rtl',
    };
  `);
  writeProjectFile(projectRoot, 'src/data.html', `<div data-dir="ltr"></div>`);

  const result = auditBidirectionalReadiness(projectRoot);
  assert.equal(result.summary.error, 6, JSON.stringify(result.findings));
  assert.ok(result.findings.every((item) => item.rule === 'fixed-direction'));
  assert.ok(result.findings.every((item) => /^[a-f0-9]{64}$/.test(item.fingerprint)));
});

test('ignores examples in comments and comment braces do not leak style context', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'src/Example.astro', `
    <!-- Example only:
      <code dir="ltr">npm run build</code>
    -->
  `);
  writeProjectFile(projectRoot, 'src/styles.ts', `
    const styles = {
      color: 'red', // {
    };
    // track.scrollTo({ left: 100 });
    const localeMetadata = {
      direction: 'ltr',
    };
  `);

  const result = auditBidirectionalReadiness(projectRoot);
  assert.equal(result.summary.error, 0, JSON.stringify(result.findings));
  assert.equal(result.summary.review, 0, JSON.stringify(result.findings));
});

test('accepts one adjacent documented fixed-direction exception', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'src/machine-values.css', `
    .email-value {
      /* bidi-fixed: Email addresses preserve LTR character order; verify=ltr,rtl */
      direction: ltr;
    }
  `);
  writeProjectFile(projectRoot, 'src/Code.astro', `
    <!-- bidi-fixed: Source-code text preserves authored character order; verify=ltr,rtl -->
    <code dir="ltr">npm run build</code>
  `);

  const result = auditBidirectionalReadiness(projectRoot);
  assert.equal(result.summary.error, 0, JSON.stringify(result.findings));
});

test('rejects vague, non-adjacent, and mismatched fixed-direction exceptions', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'src/invalid.css', `
    /* bidi-fixed: needed; verify=ltr,rtl */
    direction: ltr;

    /* bidi-fixed: Email addresses preserve LTR character order; verify=ltr,rtl */

    direction: ltr;

    /* bidi-fixed: Email addresses preserve LTR character order; verify=ltr,rtl */
    margin-left: 1rem;

    /* bidi-fixed: Email addresses preserve LTR character order; verify=ltr,rtl */
    /* unrelated comment */
    direction: ltr;

    /* bidi-fixed: First stale reason must not disappear; verify=ltr,rtl */
    /* bidi-fixed: Email addresses preserve LTR character order; verify=ltr,rtl */
    direction: ltr;
  `);

  const result = auditBidirectionalReadiness(projectRoot);
  assert.ok(result.findings.some((item) => item.rule === 'invalid-fixed-exception'));
  assert.ok(result.findings.some((item) => item.rule === 'unused-fixed-exception'));
  assert.ok(result.findings.some((item) => item.rule === 'fixed-direction'));
  assert.ok(result.findings.some((item) => item.rule === 'directional-physical-css'));
});

test('blocks physical utility classes including responsive variants', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'src/Card.tsx', `
    export const Card = () =>
      <div className="ml-4 text-left md:right-0 rtl:-mr-2">Card</div>;
    export const ReactBound = () => <div className={"pl-2"} />;
  `);
  writeProjectFile(projectRoot, 'src/Card.vue', `<div :class="'mr-4'"></div>`);
  writeProjectFile(projectRoot, 'src/card.component.html', `<div [class]="'left-0'"></div>`);

  const result = auditBidirectionalReadiness(projectRoot);
  const utilityFindings = result.findings.filter(
    (item) => item.rule === 'directional-physical-utility'
  );
  assert.equal(utilityFindings.length, 7, JSON.stringify(result.findings));
});

test('allows logical utility classes', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'src/Card.tsx', `
    export const Card = () =>
      <div className="ms-4 text-start md:end-0 ps-2">Card</div>;
  `);

  const result = auditBidirectionalReadiness(projectRoot);
  assert.equal(result.summary.error, 0, JSON.stringify(result.findings));
});

test('blocks asymmetric physical spacing and corner-radius shorthands', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'src/theme.css', `
    .field { padding: 0 1rem 0 2rem; }
    .card { border-radius: 1rem 0.5rem 0.25rem 0; }
    .safe { margin: 0 1rem; padding: 0 2rem 0 2rem; border-radius: 1rem; }
    .safe-ellipse { border-radius: 50% / 25%; }
    .unsafe-calculated { border-radius: calc(10px / 2) calc(20px / 2); }
  `);
  writeProjectFile(projectRoot, 'src/styles.ts', `
    const unsafe = { padding: '0 1rem 0 2rem', color: 'red' };
    const safe = { margin: '0 1rem 0 1rem' };
  `);

  const result = auditBidirectionalReadiness(projectRoot);
  const shorthandFindings = result.findings.filter(
    (item) => item.rule === 'directional-physical-shorthand'
  );
  assert.equal(shorthandFindings.length, 4, JSON.stringify(result.findings));
});

test('blocks unicode bidi overrides', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'src/theme.css', `
    .unsafe { unicode-bidi: bidi-override; }
    .safe { unicode-bidi: isolate; }
  `);

  const result = auditBidirectionalReadiness(projectRoot);
  assert.equal(result.summary.error, 1, JSON.stringify(result.findings));
  assert.equal(result.findings[0].rule, 'unicode-bidi-override');
});

test('reports raw horizontal scrolling and additional physical geometry for review', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'src/Carousel.ts', `
    track.scrollLeft += 100;
    track.scrollTo({ left: 0, behavior: 'smooth' });
    track.scrollTo(100, 0);
    track.scrollBy(100, 0);
    track.scroll({ left: 100 });
    track.scrollTo({
      left: offset,
      behavior: 'smooth',
    });
    track.scrollBy(
      offset,
      0
    );
  `);
  writeProjectFile(projectRoot, 'src/icons.css', `
    .next { transform: scaleX(-1); }
    .hero { background-position: left center; }
    .move { transform: translate(20px, 0); }
    .individual { translate: 20px 0; }
    .vertical { transform: translate3d(0, 20px, 0); }
  `);

  const result = auditBidirectionalReadiness(projectRoot);
  assert.equal(
    result.findings.filter((item) => item.rule === 'directional-scroll-review').length,
    7
  );
  assert.equal(
    result.findings.filter((item) => item.rule === 'directional-geometry-review').length,
    4
  );
});

test('allows a fixed-direction annotation on a multiline element', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'src/Code.tsx', `
    /* bidi-fixed: Source-code text preserves authored character order; verify=ltr,rtl */
    export const Code = () => <code
      dir="ltr"
    >npm run build</code>;
  `);

  const result = auditBidirectionalReadiness(projectRoot);
  assert.equal(result.summary.error, 0, JSON.stringify(result.findings));
});

test('CLI prints findings and exits nonzero only for deterministic errors', (t) => {
  const failingRoot = createTempProject(t);
  writeProjectFile(failingRoot, 'src/theme.css', '.field { text-align: left; }');
  const failing = spawnSync(
    process.execPath,
    [cliPath, '--projectRoot', failingRoot],
    { encoding: 'utf8' }
  );
  assert.equal(failing.status, 1);
  assert.equal(JSON.parse(failing.stdout).summary.error, 1);

  const reviewRoot = createTempProject(t);
  writeProjectFile(reviewRoot, 'src/Carousel.ts', 'track.scrollLeft += 100;');
  const review = spawnSync(
    process.execPath,
    [cliPath, '--projectRoot', reviewRoot],
    { encoding: 'utf8' }
  );
  assert.equal(review.status, 0);
  assert.equal(JSON.parse(review.stdout).summary.review, 1);
});
