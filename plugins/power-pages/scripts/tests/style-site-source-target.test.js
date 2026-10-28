'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sourceContext } = require('../lib/style-site-source-target');
const { addClass, applyMarkup } = require('../lib/style-site-plan');

const match = '<div class="col-md-4">';
const window = (label) => `${match}\r\n<h3>${label}</h3></div>`;
const edit = { path: 'page.webpage.copy.html', match, className: 'pp-feature' };

test('context targets one repeated wrapper and remains idempotent despite other original tags', () => {
  const before = `<section id="features">${window('First')}${window('Second')}</section>${window('Elsewhere')}`;
  const scoped = { ...edit, context: { after: '\r\n<h3>Second</h3>' } };
  const after = addClass(before, scoped);
  assert.equal(after, before.replace(window('Second'), window('Second').replace(match, '<div class="col-md-4 pp-feature">')));
  assert.equal(addClass(after, scoped), after);
  assert.throws(() => addClass(before, edit), /exactly one opening tag/);
  assert.throws(() => addClass(before, { ...scoped, context: { after: '\r\n<h3>' } }), /ambiguous/);
  assert.throws(() => addClass(before, { ...scoped, context: { after: '\n<h3>Second</h3>' } }), /no longer matches/);
});

test('unique ancestor context can distinguish identical siblings without an ordinal or global selector', () => {
  const sibling = window('Identical');
  const before = `${sibling}<section id="features">${sibling}${sibling}${sibling}</section>`;
  const prefix = `<section id="features">${sibling}`;
  const scoped = { ...edit, context: { before: prefix, after: '\r\n<h3>Identical</h3>' } };
  const after = addClass(before, scoped);
  assert.equal(after, `${sibling}${prefix}${sibling.replace(match, '<div class="col-md-4 pp-feature">')}${sibling}</section>`);
  assert.equal(addClass(after, scoped), after);
});

test('exact windows must target parsed HTML, not attributes, comments, raw-text content or Liquid code', () => {
  for (const [before, after] of [
    ['<!-- ', ' -->'], ['<script>const example = \'', '\';</script>'],
    ['<style>/* ', ' */</style>'], ['<textarea>', '</textarea>'], ['<title>', '</title>'],
    ["<span title='", "'></span>"],
    ['{% comment %}', '{% endcomment %}'], ['{%- comment -%}', '{%- endcomment -%}'],
    ["{% assign example = '", "' %}"], ["{{ '", "' }}"],
    ["{% assign example = '%}", "' %}"],
  ]) {
    const source = `${before}${match}${after}${window('Real')}`;
    assert.throws(() => addClass(source, { ...edit, context: { before, after } }), /real opening tag/, source);
    const result = addClass(source, { ...edit, context: { after: '\r\n<h3>Real</h3>' } });
    assert.ok(result.startsWith(before + match + after), 'Do not touch the non-DOM lookalike.');
  }
  const conditional = `{% if user %}${window('Real')}{% endif %}`;
  assert.ok(addClass(conditional, { ...edit, context: { after: '\r\n<h3>Real</h3>' } }).includes('pp-feature'));
  assert.throws(() => addClass('<div class="{{ mode }}">', { ...edit, match: '<div class="{{ mode }}">', context: { before: 'x' } }), /static opening tag/);
});

test('context validation bounds original source evidence and rejects unrecognized targeting fields', () => {
  assert.equal(sourceContext(undefined, match), null);
  assert.deepEqual(sourceContext({ after: 'x' }, match), { before: '', after: 'x' });
  for (const context of [null, [], '', {}, { before: '', after: '' }, { before: null },
    { after: 1 }, { before: 'x', index: 2 }, { selector: '#features' },
    { before: 'x'.repeat(16001 - match.length) }]) {
    assert.throws(() => sourceContext(context, match), /Source context/);
  }
  assert.doesNotThrow(() => sourceContext({ before: 'x'.repeat(16000 - match.length) }, match));
});

test('class and inline groups compose only with the same original tag and normalized context', () => {
  const before = window('First') + window('Second');
  const context = { after: '\r\n<h3>Second</h3>' };
  const request = {
    components: [{ id: 'feature', className: edit.className, sourcePath: edit.path }],
    classEdits: [{ ...edit, context }],
    styles: [{ id: 'fill', owner: 'custom', location: 'inline', componentId: 'feature',
      inlineTarget: match, inlineContext: { before: '', ...context }, declarations: { 'background-image': 'linear-gradient(#fff, #000)' } }],
  };
  const after = applyMarkup(before, request, edit.path);
  assert.equal(after, window('First') + window('Second').replace(match,
    '<div class="col-md-4 pp-feature" style="background-image: linear-gradient(#fff, #000);">'));
  assert.equal(applyMarkup(after, request, edit.path), after);
  request.styles.push({ ...request.styles[0], id: 'duplicate' });
  assert.throws(() => applyMarkup(before, request, edit.path), /must not overlap properties/);
  request.styles.pop();
  request.styles = [];
  request.classEdits.push({ ...edit, context: { before: window('First') } });
  assert.throws(() => applyMarkup(before, request, edit.path), /Overlapping markup targets/);
});
