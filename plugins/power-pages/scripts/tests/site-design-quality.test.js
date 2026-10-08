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
const currentCodePath = path.join(pluginRoot, 'references', 'design-aesthetics.md');
const blueprintsPath = path.join(pluginRoot, 'references', 'page-blueprints.md');
const critiquePath = path.join(pluginRoot, 'references', 'design-critique.md');
const classicCritiquePath = path.join(pluginRoot, 'skills', 'style-site', 'references', 'design-critique.md');
const compositionPath = path.join(pluginRoot, 'skills', 'customize-declarative-site', 'references', 'content-and-page-compositions.md');
const documents = new Map([sharedPath, codePath, classicPath, currentCodePath, blueprintsPath, critiquePath, classicCritiquePath, compositionPath]
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

test('classic and code design share experience and narrative principles without a second brief', () => {
  for (const field of ['Audience and job', 'Primary and secondary action', 'Principal doubt',
    'Proof strategy', 'Design thesis', 'First-screen concept', 'Signature moment']) {
    assert.ok(shared.includes(field), field);
  }
  assert.ok(localLinks(sharedPath, shared).includes(blueprintsPath));
  assert.ok(localLinks(sharedPath, shared).includes(classicCritiquePath));
  assert.match(shared, /narrow existing-site edits/);
  assert.match(shared, /does not authorize new functionality, fabricated data/);
  assert.match(documents.get(compositionPath), /not required component types or serialized layouts/);
  assert.match(documents.get(compositionPath), /Do not invent testimonials, service levels, metrics/);
  assert.match(documents.get(compositionPath), /label it visibly as sample content/);
  assert.match(documents.get(currentCodePath), /design system for Power Pages code sites/);
  assert.match(documents.get(classicCritiquePath), /Preserve approved brand\/system\/self-hosted fonts/);
});

test('classic final design review preserves local approval, evidence, and native-source contracts', () => {
  const classic = documents.get(classicPath);
  const critique = documents.get(classicCritiquePath);
  const customization = fs.readFileSync(path.join(pluginRoot, 'skills', 'customize-declarative-site', 'SKILL.md'), 'utf8');
  const style = fs.readFileSync(path.join(pluginRoot, 'skills', 'style-site', 'SKILL.md'), 'utf8');
  const create = fs.readFileSync(path.join(pluginRoot, 'skills', 'create-site', 'SKILL.md'), 'utf8');
  const declarative = fs.readFileSync(path.join(pluginRoot, 'skills', 'create-site', 'workflows', 'declarative-site.md'), 'utf8');
  const common = create.split('## Code-Site Workflow')[0].replace(/^---\r?\n[\s\S]*?\r?\n---/, '');

  assert.match(common, /Classic sites need no dev server or live preview/);
  assert.doesNotMatch(common, /capture-design-review\.js|browser_snapshot|dev server MUST/);
  assert.doesNotMatch(declarative, /capture-design-review\.js|axe-audit\.js|npm run dev/);
  assert.match(customization, /newSiteDesign\.composition/);
  assert.match(customization, /Do not add mandatory schema fields/);
  assert.match(customization, /approved image-check receipt/);
  assert.match(customization, /do not repeat unchanged network\s+probes/);
  assert.match(customization, /--imageChecks "<APPROVED_REVIEW_DIR>\/plan.html.image-checks.json"/);
  assert.match(classic, /not a second score-to-pass gate/);
  assert.match(classic, /exact-diff\/hash approval for every revision/);
  assert.match(classic, /protected defaults/);
  assert.match(classic, /externalResources/);
  assert.match(classic, /style-site:2.runtime/);
  assert.doesNotMatch(style, /capture-design-review\.js|axe-audit\.js|TaskCreate|critique-blocked/);
  assert.deepEqual([...style.matchAll(/<!-- gate: ([^ |]+)/g)].map((match) => match[1]),
    ['style-site:2.runtime', 'style-site:3.scope', 'style-site:5.approve', 'style-site:6.reapprove']);
  assert.match(critique, /downloaded `FontFace` families.*not an inventory of system fonts/);
  assert.match(critique, /approved inline declarations, existing tokens and scoped custom styles are valid/);
  assert.match(critique, /not a verified total out of 40 or a rescaled rating/);
  assert.match(critique, /SPA automatic capture\/fix\/commit loop does not apply/);
  assert.ok(localLinks(classicCritiquePath, critique).includes(critiquePath));
  assert.match(critique, /Use only the two tables/);
  assert.doesNotMatch(critique, /^\| \d+ \|/m, 'the shared rubric is referenced, not copied');
});

test('read-only critique routes classic metadata without executing project code or assuming pixels', () => {
  const entry = fs.readFileSync(path.join(pluginRoot, 'skills', 'exceptional-web-design', 'SKILL.md'), 'utf8');
  const review = fs.readFileSync(path.join(pluginRoot, 'skills', 'exceptional-web-design', 'workflows', 'classic-site.md'), 'utf8');
  const tools = entry.match(/^allowed-tools: (.+)$/m)[1].split(',').map((tool) => tool.trim());
  assert.match(entry, /do not continue into the workflow below/);
  assert.match(entry, /Without positive classic evidence, retain the existing workflow below unchanged/);
  for (const tool of ['Write', 'Edit', 'Skill', 'Task']) assert.ok(!tools.includes(tool), tool);
  for (const reference of ['design-studio-site-discovery.md', 'design-studio-webpage-authoring.md',
    'site-design-quality.md', 'design-critique.md', 'page-blueprints.md']) {
    assert.ok(review.includes(reference), reference);
  }
  assert.match(review, /`\.portalconfig` plus `website\.yml`/);
  assert.match(review, /`website\.yml` alone is not a classic marker/);
  assert.match(review, /existing root\/localized page identities, parents, partial URLs, and language records/);
  assert.match(review, /Do not authenticate, submit forms, change records, deploy/);
  assert.match(review, /Source only means no screenshots/);
  assert.match(review, /unpublished local changes from the deployed version/);
  assert.match(review, /not observed or genuinely not applicable/);
  assert.match(review, /Provisional\/partial review/);
  assert.match(review, /query-string or fragment state/);
  assert.match(review, /origin \(scheme, host, and port\)/);
  assert.match(review, /complete locale\/hierarchy in each route/);
  assert.match(review, /user already requested source-only review/);
  assert.match(review, /no automatic fix loop or deployment follows/);
  assert.match(review, /No evidenced failures/);
  assert.match(review, /Review eight pages at most/);
  assert.match(review, /summary\.accessibility\.unaudited/);
  assert.match(review, /summary\.redirects/);
  assert.match(review, /summary\.omittedRoutes/);
  assert.doesNotMatch(review, /npm run dev|under `<PROJECT_ROOT>\/src`/);
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
