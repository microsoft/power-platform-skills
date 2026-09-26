'use strict';
// The two gates that accept a generated page must refuse exactly the same pages with exactly the same
// words: they were two copies once, and a check added to one had to be found missing from the other.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pageStructureProblems } = require('../lib/page-structure.js');
const workerGate = require('../genpage-worker-output.js').structuralProblems;
const promotionGate = require('../promote-intent-pages.js').structuralProblems;

const CASES = [
  ['complete page', 'export default function P() {\n  return <div>ok</div>;\n}\n'],
  ['empty file', '   \n'],
  ['no default export', 'export function P() { return null; }\n'],
  ['cut inside the export', 'import * as React from "react";\nexport default function P(props: Props)'],
  ['unbalanced brackets', 'export default function P() {\n  return <div>\n'],
  ['stops mid-statement', 'const P = () => <div/>;\nexport default P;\nconst total = count *'],
  ['fenced prose', '\u0060\u0060\u0060tsx\nexport default function P() { return null; }\n\u0060\u0060\u0060\n'],
  // A tilde fence needs no escaping inside a template literal, which is how a page embeds markdown help.
  ['fence inside a template literal is data', 'const help = \u0060\n~~~md\nx\n~~~\n\u0060;\nexport default function P() { return <div>{help}</div>; }\n'],
  ['elided body', 'export default function P() {\n  // ... rest of the component\n  return null;\n}\n'],
];

for (const [name, code] of CASES) {
  test(`both page gates give the same verdict: ${name}`, () => {
    const expected = pageStructureProblems(code);
    assert.deepEqual(workerGate(code), expected);
    assert.deepEqual(promotionGate(code), expected);
  });
}

test('a complete page passes and each failure is named', () => {
  assert.deepEqual(pageStructureProblems(CASES[0][1]), []);
  assert.deepEqual(pageStructureProblems('   \n'), ['file is empty']);
  assert.match(pageStructureProblems(CASES[2][1]).join('\n'), /no complete default export — no real `export default`/);
  assert.match(pageStructureProblems(CASES[6][1]).join('\n'), /markdown code fence/);
  assert.deepEqual(pageStructureProblems(CASES[7][1]), []);
  assert.match(pageStructureProblems(CASES[8][1]).join('\n'), /the page is incomplete/);
});
