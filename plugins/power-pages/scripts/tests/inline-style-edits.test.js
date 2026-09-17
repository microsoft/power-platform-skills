'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { editInlineDeclarations, inlineOverrides } = require('../lib/inline-style-edits');

test('inline updates preserve unrelated values and become stable after one edit', () => {
  const before = 'width: 100%; background-image: url("a;b.png"); font-family: "Segoe UI"; border-radius: 8px; height: auto;  ';
  const requested = { 'border-radius': '50%', 'box-shadow': '0 12px 32px #00000033' };
  const after = editInlineDeclarations(before, requested);
  assert.ok(after.startsWith('width: 100%; background-image: url("a;b.png"); font-family: "Segoe UI"; height: auto;  '));
  assert.ok(after.includes('border-radius: 50%;'));
  assert.equal((after.match(/border-radius:/g) || []).length, 1);
  assert.equal(editInlineDeclarations(after, requested), after);
  assert.equal(editInlineDeclarations('border-radius: 50%;  ', { 'border-radius': '50%' }), 'border-radius: 50%;  ');
});

test('requested declarations follow ordinary overrides and keep only existing exact-property priority', () => {
  const requested = { 'border-radius': '50%', 'border-color': '#ffffff' };
  const after = editInlineDeclarations('border-radius: 1px !important; border-radius: 2px; border: 1px solid #000000; border-top-left-radius: 3px;', requested);
  assert.ok(after.endsWith('border-radius: 50% !important; border-color: #ffffff;'));
  assert.equal((after.match(/!important/g) || []).length, 1);
  assert.equal(editInlineDeclarations(after, requested), after);
  assert.throws(() => editInlineDeclarations('border: 1px solid #000 !important;', { 'border-color': '#ffffff' }), /Existing !important border/);
  assert.throws(() => editInlineDeclarations('all: initial !important;', { color: '#ffffff' }), /Existing !important all/);
  assert.throws(() => editInlineDeclarations('font: 16px serif !important;', { 'font-size': '20px' }), /Existing !important font/);
  assert.throws(() => editInlineDeclarations('border-inline-width: 2px !important;', { 'border-width': '1px' }), /Existing !important border-inline-width/);
  assert.throws(() => editInlineDeclarations('border-start-start-radius: 8px !important;', { 'border-radius': '50%' }), /Existing !important border-start-start-radius/);
  assert.doesNotThrow(() => editInlineDeclarations('border: 1px solid #000 !important;', { 'border-radius': '50%' }));
  assert.doesNotThrow(() => editInlineDeclarations('border-width: 2px !important;', { 'border-color': '#ffffff' }));
});

test('inline override checks distinguish shorthand effects and already matching exact values', () => {
  assert.deepEqual(inlineOverrides('border-radius: 8px; width: 100%;', { 'border-radius': '50%' }), ['border-radius']);
  assert.deepEqual(inlineOverrides('border: 1px solid #000;', { 'border-color': '#fff' }), ['border']);
  assert.deepEqual(inlineOverrides('border-width: 2px;', { 'border-color': '#fff' }), []);
  assert.deepEqual(inlineOverrides('border: 1px solid #000;', { 'border-radius': '50%' }), []);
  assert.deepEqual(inlineOverrides('border-color: #fff; border-width: 1px;', { 'border-color': '#fff', 'border-width': '1px' }), []);
  assert.deepEqual(inlineOverrides('padding-inline-start: 1px;', { padding: '8px' }), ['padding-inline-start']);
  assert.deepEqual(inlineOverrides('place-items: center;', { 'align-items': 'start' }), ['place-items']);
  assert.deepEqual(inlineOverrides('border-block-color: #000;', { 'border-color': '#fff' }), ['border-block-color']);
  assert.deepEqual(inlineOverrides('constructor: ignored;', { color: '#fff' }), []);
});

test('ambiguous inline serialization fails closed instead of silently recovering syntax', () => {
  for (const text of ['color', 'color:;', 'color: red; broken', 'color: &quot;red&quot;;',
    'color: red; /* unfinished', '/*/', 'font-family: Contoso\\', 'background: url(a.png', 'width: calc(100% - 1px;', 'color: "red;', 'width: 10px);', 'color: red!important!important;']) {
    assert.throws(() => editInlineDeclarations(text, { color: '#fff' }), /Inline CSS|inline CSS|inline source|Malformed|Ambiguous|Unbalanced/, text);
  }
});

test('general inline syntax preserves comments, escaped names, tokens, quoting and declaration order', () => {
  const before = '/* keep */ b\\6frder: 1px solid red; --Brand: #abc; --brand: #def; --block: { color:red }; font-family: "A & B", sans-serif;';
  const after = editInlineDeclarations(before, { '--Brand': '#123', margin: '1rem', 'margin-inline-start': 'calc(-1 * 2vw)' });
  assert.ok(after.startsWith('/* keep */ b\\6frder: 1px solid red; --brand: #def; --block: { color:red }; font-family: "A & B", sans-serif;'));
  assert.ok(after.endsWith('--Brand: #123; margin: 1rem; margin-inline-start: calc(-1 * 2vw);'));
  assert.equal(editInlineDeclarations(after, { '--Brand': '#123', margin: '1rem', 'margin-inline-start': 'calc(-1 * 2vw)' }), after);
  assert.equal(editInlineDeclarations('c\\6flor:red;', { color: 'blue' }), 'color: blue;');
  assert.throws(() => editInlineDeclarations('', { color: 'red; width: 10px' }), /Malformed/);
  assert.throws(() => editInlineDeclarations('', { color: 'red', COLOR: 'blue' }), /duplicate/);
});

test('general shorthand and explicit priority checks retain the local cascade', () => {
  for (const [baseline, declarations] of [
    ['animation: pp-fade 1s !important;', { 'animation-duration': '2s' }],
    ['grid: none !important;', { 'grid-template-columns': '1fr 2fr' }],
    ['inset: 0 !important;', { top: '1rem' }],
    ['mask: none !important;', { 'mask-size': 'cover' }],
    ['text-decoration: underline !important;', { 'text-decoration-color': 'red' }],
    ['border: 0 !important;', { 'border-image-source': 'url(/frame.svg)' }],
  ]) {
    assert.throws(() => editInlineDeclarations(baseline, declarations), /Existing !important/);
    assert.ok(inlineOverrides(baseline, declarations).length);
  }
  assert.doesNotThrow(() => editInlineDeclarations('all: initial !important;', { '--Brand': 'red', direction: 'rtl' }));
  assert.deepEqual(inlineOverrides('color: red;', { color: 'blue !important' }), []);
  assert.deepEqual(inlineOverrides('color: red !important;', { color: 'blue !important' }), ['color']);
  assert.equal(editInlineDeclarations('', { color: 'red !important' }), 'color: red !important;');
});

test('explicit property removal releases inline ownership without escalating stylesheet priority', () => {
  const before = 'color: red !important; padding: 1rem; /*keep*/ color: blue; --Brand: pink; --brand: cyan;';
  const requested = { color: null, '--Brand': null };
  const after = editInlineDeclarations(before, requested);
  assert.equal(after, ' padding: 1rem; /*keep*/  --brand: cyan;');
  assert.equal(editInlineDeclarations(after, requested), after);
  assert.equal(editInlineDeclarations('color:red;', { color: null }), '');
  assert.equal(editInlineDeclarations('border: 0 !important; padding: 1rem;', { border: null, 'border-color': 'red' }),
    ' padding: 1rem; border-color: red;');
});

test('escaped identifiers and trailing escaped whitespace retain their CSS meaning', () => {
  const requested = { '--token\\ name': 'value\\ ', 'font-family': 'Contoso\\ ' };
  const after = editInlineDeclarations('', requested);
  assert.equal(after, '--token\\ name: value\\ ; font-family: Contoso\\ ;');
  assert.equal(editInlineDeclarations(after, requested), after);
});

test('inline editing does not confuse newer value grammar with broken declaration boundaries', () => {
  const value = 'if(style(--scheme: dark): white; else: black)';
  const after = editInlineDeclarations('padding: 1rem; color:red;', { color: value });
  assert.equal(after, `padding: 1rem; color: ${value};`);
  assert.equal(editInlineDeclarations(after, { color: value }), after);
  assert.deepEqual(inlineOverrides(after, { color: value }), []);
});
