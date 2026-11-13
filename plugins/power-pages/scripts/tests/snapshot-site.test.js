const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { safeReaddir } = require('../../skills/migrate-datamodel/scripts/snapshot-site');
const { diffCategory } = require('../../skills/migrate-datamodel/scripts/diff-snapshots');
const script = path.join(__dirname, '../../skills/migrate-datamodel/scripts/snapshot-site.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const site = path.join(root, 'site');
  const output = path.join(root, 'reports');
  fs.mkdirSync(site);
  function write(relative, text) {
    const file = path.join(site, ...relative.split(/[\\/]/));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  function run() {
    const result = spawnSync(process.execPath, [script, '--site-root', site,
      '--output-dir', output, '--label', 'sdm', '--with-content-hash'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(fs.readFileSync(path.join(output, 'sdm-snapshot.json'), 'utf8'));
  }
  return { write, run };
}

test('missing optional snapshot directories remain empty', (t) => {
  t.mock.method(fs, 'readdirSync', () => {
    throw Object.assign(new Error('missing directory'), { code: 'ENOENT' });
  });
  assert.deepEqual(safeReaddir('missing'), []);
});

test('unreadable snapshot directories report errors rather than empty inventories', (t) => {
  t.mock.method(fs, 'readdirSync', () => {
    throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
  });
  assert.throws(() => safeReaddir('restricted'), /Could not read snapshot directory restricted: permission denied/);
});

test('nested configuration and both setting layouts are captured with content hashes', (t) => {
    const { write, run } = fixture(t);
    write('.powerpages-site\\website.yml', 'adx_name: Contoso');
    write('.powerpages-site\\sitesetting.yml', '- adx_name: Aggregate\n  adx_value: "true"');
    write('.powerpages-site\\site-settings\\Individual.sitesetting.yml', 'adx_name: Individual\nadx_value: "false"');
    write('.powerpages-site\\web-templates\\header\\Header.webtemplate.yml', 'adx_name: Header');
    write('.powerpages-site\\web-templates\\header\\Header.webtemplate.source.html', '<header>Before</header>');
    const before = run();
    assert.equal(before.counts.siteSettings, 2);
    assert.deepEqual(before.inventory.siteSettings.map((record) => record.value), ['true', 'false']);
    assert.equal(before.counts.webTemplates, 1);
    assert.match(before.inventory.webTemplates[0].contentHash, /^[a-f0-9]{16}$/);
    write('.powerpages-site\\web-templates\\header\\Header.webtemplate.source.html', '<header>After</header>');
    assert.notEqual(run().inventory.webTemplates[0].contentHash, before.inventory.webTemplates[0].contentHash);
  });

test('malformed aggregate fields are reported instead of silently dropped', (t) => {
    const { write, run } = fixture(t);
    write('sitesetting.yml', '- adx_name: Example\n  malformed field without a colon');
    const snapshot = run();
    assert.equal(snapshot.counts.siteSettings, 0);
    assert.match(snapshot.parseErrors.siteSettings[0].message, /Invalid YAML line/);
  });

test('navigation retains inactive links, target, order and state while counting active links', (t) => {
    const { write, run } = fixture(t);
    write('web-link-sets\\main\\Main.en-US.weblinkset.yml', 'adx_name: Main\nadx_statecode: 0');
    write('web-link-sets\\main\\Main.en-US.weblinkset.weblink.yml',
      '- adx_name: Home\n  adx_displayorder: 2\n  adx_pageid: page-id\n  adx_statecode: 0\n' +
      '- adx_name: Hidden\n  adx_displayorder: 1\n  adx_externalurl: https://contoso.com\n  adx_statecode: 1');
    const snapshot = run();
    assert.equal(snapshot.counts.webLinks, 2);
    assert.equal(snapshot.inventory.webLinkSets[0].linkCount, 1);
    assert.deepEqual(snapshot.inventory.webLinkSets[0].linkNames, ['Home']);
    const hidden = snapshot.inventory.webLinks.find((link) => link.name === 'Hidden');
    assert.equal(hidden.stateCode, 1);
    assert.equal(hidden.displayOrder, 1);
    assert.equal(hidden.externalUrl, 'https://contoso.com');
    assert.equal(snapshot.inventory.webLinks.find((link) => link.name === 'Home').pageId, 'page-id');
  });

test('legacy navigation layouts remain supported alongside canonical menus', (t) => {
  const { write, run } = fixture(t);
  for (const [folder, name] of [['web-link-sets', 'Main'], ['weblink-sets', 'Footer']]) {
    write(`${folder}\\menu\\${name}.en-US.weblinkset.yml`, `adx_name: ${name}`);
    write(`${folder}\\menu\\${name}.en-US.weblinkset.weblink.yml`, '- adx_name: Home\n  statecode: 0');
  }
  const snapshot = run();
  assert.equal(snapshot.counts.webLinkSets, 2);
  assert.equal(snapshot.counts.webLinks, 2);
  assert.deepEqual(snapshot.inventory.webLinks.map((link) => link.parentSet).sort(), ['Footer', 'Main']);
});

test('prefixed inactive states survive every scanner shape and produce diff warnings', (t) => {
  const { write, run } = fixture(t);
  const records = [
    ['webrole.yml', '- adx_name: Role\n  adx_statecode: 1', 'webRoles'],
    ['web-pages\\home\\Home.webpage.yml', 'adx_name: Home\nadx_statecode: 1', 'webPages'],
    ['content-snippets\\title\\Title.en-US.contentsnippet.yml', 'adx_name: Title\nadx_statecode: 1', 'contentSnippets'],
    ['web-templates\\main\\Main.webtemplate.yml', 'adx_name: Main\nadx_statecode: 1', 'webTemplates'],
    ['page-templates\\Main.pagetemplate.yml', 'adx_name: Main\nadx_statecode: 1', 'pageTemplates'],
    ['basic-forms\\main\\Main.basicform.yml', 'adx_name: Main\nadx_statecode: 1', 'basicForms'],
  ];
  for (const [file, text] of records) write(file, text);
  const before = run();
  for (const [file, text, category] of records) {
    assert.equal(before.inventory[category][0].stateCode, 1, category);
    write(file, text.replace('adx_statecode: 1', 'statecode: 0'));
  }
  const after = run();
  for (const [, , category] of records) {
    const diff = diffCategory(category, before.inventory[category], after.inventory[category]);
    assert.equal(diff.status, 'warn', category);
    assert.equal(diff.stateChanged.length, 1, category);
  }
});

test('nested form steps retain parent identities, state and routing and cannot silently disappear', (t) => {
  const { write, run } = fixture(t);
  for (const form of ['Order', 'Contact']) {
    write(`advanced-forms\\${form}\\${form}.advancedform.yml`, `adx_name: ${form}`);
    write(`advanced-forms\\${form}\\advanced-form-steps\\nested\\details\\Details.advancedformstep.yml`,
      `adx_name: Details\nadx_webform: ${form}-id\nadx_targetentitylogicalname: account\nadx_type: 0\nadx_statecode: 1\nadx_nextstep: next-id`);
  }
  const before = run();
  const steps = before.inventory.advancedFormSteps;
  assert.equal(before.counts.advancedFormSteps, 2);
  assert.equal(steps[0].stateCode, 1);
  assert.equal(steps[0].type, 0);
  assert.equal(steps[0].nextStepId, 'next-id');
  assert.equal(diffCategory('advancedFormSteps', steps, steps).status, 'pass');
  assert.equal(diffCategory('advancedFormSteps', steps, steps.slice(1)).status, 'fail');
  write('advanced-forms\\Order\\advanced-form-steps\\nested\\details\\Details.advancedformstep.yml',
    'name: Details\nwebform: Order-id\ntargetentitylogicalname: contact\ntype: 0\nstatecode: 1\nnextstep: different-id');
  const diff = diffCategory('advancedFormSteps', steps, run().inventory.advancedFormSteps);
  assert.equal(diff.status, 'warn');
  assert.deepEqual(diff.valueChanged.map((change) => change.field).sort(), ['nextStepId', 'targetEntity']);
});

test('aggregate and per-record access rules retain policy values and normalize role order', (t) => {
  const { write, run } = fixture(t);
  write('webpagerule.yml',
    '- adx_name: Aggregate\n  adx_right: 2\n  adx_webpageid: home-id\n  adx_statecode: 1');
  write('webpage-rules\\Orders.webpagerule.yml',
    'name: Orders\nright: 0\nwebpageid: orders-id\nscope: 1\nstatecode: 0\n' +
    'adx_webpageaccesscontrolrule_webrole:\n- role-b\n- role-a');
  const before = run();
  const rules = before.inventory.webpageRules;
  assert.equal(before.counts.webpageRules, 2);
  assert.equal(rules[0].stateCode, 1);
  assert.equal(rules[1].right, 0);
  assert.equal(rules[1].pageId, 'orders-id');
  assert.deepEqual(rules[1].webRoleIds, ['role-a', 'role-b']);
  assert.equal(diffCategory('webpageRules', rules, rules.slice(1)).status, 'fail');
  write('webpage-rules\\Orders.webpagerule.yml',
    'name: Orders\nright: 2\nwebpageid: orders-id\nscope: 1\nstatecode: 0\n' +
    'adx_webpageaccesscontrolrule_webrole:\n- role-a\n- role-b');
  const diff = diffCategory('webpageRules', rules, run().inventory.webpageRules);
  assert.equal(diff.status, 'warn');
  assert.deepEqual(diff.valueChanged.map((change) => change.field), ['right']);
});

test('malformed nested steps and per-record access rules surface category parse errors', (t) => {
  const { write, run } = fixture(t);
  write('advanced-forms\\order\\Order.advancedform.yml', 'adx_name: Order');
  write('advanced-forms\\order\\advanced-form-steps\\details\\Details.advancedformstep.yml', 'not valid YAML');
  write('webpage-rules\\Broken.webpagerule.yml', 'not valid YAML');
  const snapshot = run();
  assert.equal(snapshot.parseErrors.advancedFormSteps.length, 1);
  assert.equal(snapshot.parseErrors.webpageRules.length, 1);
});
