'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const path = require('path');
const { auditBidirectionalReadiness } = require('../lib/bidirectional-readiness');
const {
  parseArgs,
} = require('../audit-bidirectional-readiness');
const { createTempProject, writeProjectFile } = require('./test-utils');

const AUDIT_PATH = path.join(__dirname, '..', 'audit-bidirectional-readiness.js');

function createSymlinkOrSkip(t, target, linkPath, type) {
  try {
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch (error) {
    if (['EACCES', 'EPERM', 'ENOTSUP'].includes(error.code)) {
      t.skip(`Symlink creation is unavailable: ${error.code}`);
      return false;
    }
    throw error;
  }
}

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

test('rejects an unwrapped physical exception without exempting the declaration', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'src/map.css', `
    bidi-physical: Map controls follow provider placement; verify=ltr,rtl
    .map-controls { margin-left: 1rem; }
  `);

  const result = auditBidirectionalReadiness(projectRoot);
  assert.deepEqual(
    result.findings.map((item) => item.rule),
    ['invalid-physical-exception', 'directional-physical-css']
  );
});

test('rejects half-wrapped physical exceptions without exempting the declaration', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'src/map.css', `
    /* bidi-physical: Opening wrapper only is not a valid directive; verify=ltr,rtl
    .opening-only { margin-left: 1rem; }
    bidi-physical: Closing wrapper only is not a valid directive; verify=ltr,rtl */
    .closing-only { padding-right: 1rem; }
  `);

  const result = auditBidirectionalReadiness(projectRoot);
  assert.deepEqual(
    result.findings.map((item) => item.rule),
    [
      'invalid-physical-exception',
      'directional-physical-css',
      'invalid-physical-exception',
      'directional-physical-css',
    ]
  );
});

test('does not treat directive-like string content as an exception', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'src/map.ts', `
    const guidance = "bidi-physical: Example text only; verify=ltr,rtl";
    const style = { marginLeft: '1rem' };
  `);

  const result = auditBidirectionalReadiness(projectRoot);
  assert.equal(result.summary.error, 1, JSON.stringify(result.findings));
  assert.equal(result.findings[0].rule, 'directional-physical-css');
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

test('reports fixed text dimensions in expanded and compact CSS', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'src/cards.css', `
    .expanded {
      width: 8rem;
    }
    .compact { inline-size: 12px; }
    .multiple { color: red; block-size: 2.5em; padding: 1rem; }
    .no-semicolon { height: 40px }
  `);

  const result = auditBidirectionalReadiness(projectRoot);
  assert.equal(result.summary.error, 0);
  assert.equal(
    result.findings.filter((item) => item.rule === 'fixed-content-size-review').length,
    4
  );
});

test('ignores flexible dimensions and fixed-size text outside declarations', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'src/cards.css', `
    .bounded { max-width: 8rem; }
    .fluid { width: 100%; height: auto; }
    /* .example { width: 8rem; } */
  `);
  writeProjectFile(
    projectRoot,
    'src/guidance.ts',
    'const guidance = "width: 8rem;";\n'
  );

  const result = auditBidirectionalReadiness(projectRoot);
  assert.equal(
    result.findings.filter((item) => item.rule === 'fixed-content-size-review').length,
    0,
    JSON.stringify(result.findings)
  );
});

test('does not traverse symlinked directories or directory cycles', (t) => {
  const projectRoot = createTempProject(t);
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpages-external-'));
  t.after(() => fs.rmSync(externalRoot, { recursive: true, force: true }));
  writeProjectFile(externalRoot, 'outside.css', '.outside { margin-left: 1rem; }');
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });

  const directoryType = process.platform === 'win32' ? 'junction' : 'dir';
  if (!createSymlinkOrSkip(
    t,
    externalRoot,
    path.join(projectRoot, 'src', 'external'),
    directoryType
  )) return;
  if (!createSymlinkOrSkip(
    t,
    path.join(projectRoot, 'src'),
    path.join(projectRoot, 'src', 'loop'),
    directoryType
  )) return;

  const result = auditBidirectionalReadiness(projectRoot);
  assert.deepEqual(result.findings, []);
});

test('does not audit symlinked source files', (t) => {
  const projectRoot = createTempProject(t);
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpages-external-'));
  t.after(() => fs.rmSync(externalRoot, { recursive: true, force: true }));
  const externalFile = writeProjectFile(
    externalRoot,
    'outside.css',
    '.outside { padding-right: 1rem; }'
  );
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });

  if (!createSymlinkOrSkip(
    t,
    externalFile,
    path.join(projectRoot, 'src', 'linked.css'),
    'file'
  )) return;

  const result = auditBidirectionalReadiness(projectRoot);
  assert.deepEqual(result.findings, []);
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
