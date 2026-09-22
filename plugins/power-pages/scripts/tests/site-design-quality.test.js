'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { checkColorPair } = require('../lib/style-site-contrast');

const pluginRoot = path.resolve(__dirname, '..', '..');
const sharedPath = path.join(pluginRoot, 'references', 'site-design-quality.md');
const codePath = path.join(pluginRoot, 'skills', 'create-site', 'references', 'design-aesthetics.md');
const classicPath = path.join(pluginRoot, 'skills', 'style-site', 'references', 'design-quality.md');
const documents = new Map([sharedPath, codePath, classicPath]
  .map((file) => [file, fs.readFileSync(file, 'utf8')]));
const shared = documents.get(sharedPath);

function localLinks(file, content) {
  return [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter((href) => !/^https?:|^#/i.test(href))
    .map((href) => path.resolve(path.dirname(file), href.split('#')[0]));
}

test('both platform adapters load the same bundled design source before execution guidance', () => {
  for (const file of [codePath, classicPath]) {
    const introduction = documents.get(file).split(/^## /m)[0];
    assert.ok(localLinks(file, introduction).includes(sharedPath), file);
    assert.match(introduction, /\bread\b/i);
    assert.match(introduction, /\bapply\b/i);
  }
});

test('design references and script links stay inside the installable plugin and resolve', () => {
  for (const [file, content] of documents) {
    const scripts = [...content.matchAll(/\$\{PLUGIN_ROOT\}\/([^"`\s]+\.js)/g)]
      .map((match) => path.join(pluginRoot, ...match[1].split('/')));
    for (const target of [...localLinks(file, content), ...scripts]) {
      const relative = path.relative(pluginRoot, target);
      assert.ok(!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`),
        `${file}: reference escapes the installed plugin: ${target}`);
      assert.ok(fs.statSync(target).isFile(), `${file}: ${target}`);
    }
  }
});

test('shared text-contrast guidance agrees with the exact calculator thresholds', () => {
  // Read only the numeric contract from the Markdown table; wording and layout
  // elsewhere can evolve without tests pinning complete instructional sentences.
  const rows = shared.split(/\r?\n/)
    .filter((line) => line.startsWith('|'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => /^\d+(?:\.\d+)?:1$/.test(cells.at(-1)));
  assert.equal(rows.length, 3);
  const normal = rows.find(([category]) => /\bnormal\b/i.test(category));
  const regular = rows.find(([category]) => /\blarge regular\b/i.test(category));
  const bold = rows.find(([category]) => /\blarge bold\b/i.test(category));
  assert.ok(normal && regular && bold);
  assert.match(normal[0], /18px bold/);
  assert.match(regular[1], /24 CSS px/);
  assert.match(bold[0], /700\+/);
  assert.match(bold[1], /14pt/);
  assert.match(bold[1], /approximately 18\.667 CSS px/);
  assert.match(shared, /`14 \* 96 \/ 72`/);
  assert.match(shared, /without rounding/);

  const ratio = (row) => Number(row[2].split(':')[0]);
  assert.deepEqual([ratio(normal), ratio(regular), ratio(bold)], [4.5, 3, 3]);
  for (const [fontSize, fontWeight, row] of [
    [18, 700, normal],
    [18.666, 700, normal],
    [14 * 96 / 72, 699, normal],
    [14 * 96 / 72, 700, bold],
    [23.999, 400, normal],
    [24, 400, regular],
  ]) {
    const result = checkColorPair({ foreground: '#000', background: '#fff', fontSize, fontWeight });
    assert.equal(result.minimum, ratio(row), `${fontSize}px / weight ${fontWeight}`);
  }
  assert.doesNotMatch(documents.get(codePath), /18px\+\s*bold/);
});

test('near-threshold examples never turn rounded ratios into passes', () => {
  for (const [foreground, fontSize, minimum] of [['#777', 18, 4.5], ['#959595', 24, 3]]) {
    const result = checkColorPair({ foreground, background: '#fff', fontSize, fontWeight: 700 });
    assert.equal(Number(result.ratio.toFixed(1)), minimum);
    assert.ok(result.ratio < minimum);
    assert.equal(result.status, 'fail');
    assert.equal(result.evidence, 'supplied-color-pair-only');
  }
});

test('classic imagery reuses its asset workflow and SPA execution remains in the code adapter', () => {
  const classic = documents.get(classicPath);
  const links = localLinks(classicPath, classic);
  for (const target of [
    ['skills', 'customize-declarative-site', 'references', 'visual-asset-planning.md'],
    ['skills', 'classic-site-skills', 'author-web-file', 'SKILL.md'],
  ]) {
    assert.ok(links.includes(path.join(pluginRoot, ...target)), target.join('/'));
  }
  assert.match(classic, /\$\{PLUGIN_ROOT\}\/scripts\/prepare-declarative-asset\.js/);
  assert.match(documents.get(codePath), /index\.html/);
  assert.match(documents.get(codePath), /browser_snapshot/);
  for (const content of [shared, classic]) {
    assert.doesNotMatch(content, /browser_snapshot|npm run dev|python -m http\.server/);
    assert.doesNotMatch(content, /<link\b[^>]*fonts\.googleapis/);
  }
});
