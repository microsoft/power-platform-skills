const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./style-site-fixtures');
const { preparePlan, planHash } = require('../lib/style-site-plan');
const { applyPlan, main } = require('../../skills/style-site/scripts/apply-style-plan');
const { verify } = require('../../skills/style-site/scripts/validate-style-site');

test('dry-run never writes and apply requires exact approval plus receipt', (t) => {
  const f = fixture(t);
  const plan = preparePlan(f.root, f.request);
  assert.equal(applyPlan(plan).status, 'dry-run');
  assert.throws(() => applyPlan(plan, { apply: true }), /approval/);
  assert.throws(() => applyPlan(plan, { apply: true, approvedHash: plan.planHash }), /receipt/);
  assert.equal(fs.readFileSync(path.join(f.root, f.cssPath), 'utf8'), plan.writes[0].before);
});

for (const newFile of [false, true]) {
  test(`applies and independently verifies idempotently (new file: ${newFile})`, (t) => {
    const f = fixture(t, { major: 5, prefix: '', nested: true });
    if (newFile) Object.assign(f.request.styles[0], { scope: 'site', fileName: 'cards.css' });
    const plan = preparePlan(f.root, f.request);
    const receipt = path.join(f.work, 'receipt.json');
    const result = applyPlan(plan, { apply: true, approvedHash: plan.planHash, receipt });
    assert.equal(result.status, 'applied');
    const data = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    assert.equal(verify(plan, data).status, 'verified-local-files');
    assert.equal(applyPlan(plan).status, 'already-applied');
    assert.equal(applyPlan(plan, { apply: true, approvedHash: plan.planHash, receipt: path.join(f.work, 'second.json') }).status, 'already-applied');
    for (const write of plan.writes) assert.equal(fs.readFileSync(path.join(f.root, write.path), 'utf8'), write.after);
  });
}

test('stale CSS/defaults and new inventory require regeneration', (t) => {
  const f = fixture(t);
  const plan = preparePlan(f.root, f.request);
  f.put(f.assets['theme.css'].path, '/* changed in Studio */');
  assert.throws(() => applyPlan(plan), /Source changed/);
  f.put(f.assets['theme.css'].path, '/* theme.css */\n');
  f.put('web-files/unregistered.css', '/* new */');
  assert.throws(() => applyPlan(plan), /does not match/);
});

test('modified metadata cannot pass request reconstruction with a recomputed hash', (t) => {
  const f = fixture(t);
  Object.assign(f.request.styles[0], { scope: 'site', fileName: 'cards.css' });
  const plan = preparePlan(f.root, f.request);
  const write = plan.writes.find((entry) => entry.kind === 'webfile');
  write.after += 'adx_hiddenfromsitemap: false\n';
  write.afterHash = require('../lib/classic-site-style-context').hash(write.after);
  plan.planHash = planHash(plan);
  assert.throws(() => applyPlan(plan), /does not match/);
});

test('receipt collisions and in-site receipts leave files unchanged', (t) => {
  const f = fixture(t);
  const plan = preparePlan(f.root, f.request);
  const receipt = path.join(f.work, 'receipt.json');
  fs.writeFileSync(receipt, 'user-owned');
  assert.throws(() => applyPlan(plan, { apply: true, approvedHash: plan.planHash, receipt }), /already exists/);
  assert.throws(() => applyPlan(plan, { apply: true, approvedHash: plan.planHash, receipt: path.join(f.root, 'receipt.json') }), /outside/);
  assert.equal(fs.readFileSync(path.join(f.root, f.cssPath), 'utf8'), plan.writes[0].before);
});

test('CLI never accepts an upload action', (t) => {
  const f = fixture(t);
  const planFile = path.join(f.work, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify(preparePlan(f.root, f.request)));
  assert.equal(main(['--plan', planFile]).status, 'dry-run');
  assert.throws(() => main(['--plan', planFile, '--upload']), /Unknown/);
});

test('new inventory invalidates an already-applied proposal', (t) => {
  const f = fixture(t);
  const plan = preparePlan(f.root, f.request);
  applyPlan(plan, { apply: true, approvedHash: plan.planHash, receipt: path.join(f.work, 'receipt.json') });
  f.put('web-files/new.css', '/* concurrent addition */');
  assert.throws(() => applyPlan(plan), /inventory changed/);
});

test('a write failure records partial local state and removes only its staged files', (t) => {
  const f = fixture(t);
  Object.assign(f.request.styles[0], { scope: 'site', fileName: 'cards.css' });
  const plan = preparePlan(f.root, f.request);
  const receipt = path.join(f.work, 'failed-receipt.json');
  const rename = fs.renameSync;
  let calls = 0;
  fs.renameSync = (...args) => {
    if (++calls === 2) throw new Error('Simulated filesystem failure');
    return rename(...args);
  };
  try {
    assert.throws(() => applyPlan(plan, { apply: true, approvedHash: plan.planHash, receipt }), /No automatic rollback/);
  } finally {
    fs.renameSync = rename;
  }
  const data = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  assert.equal(data.status, 'failed');
  assert.equal(data.completed.length, 1);
  assert.equal(data.changes.length, 2);
  assert.throws(() => verify(plan, data), /Receipt/);
  assert.ok(!fs.readdirSync(path.join(f.root, 'web-files')).some((file) => file.endsWith('.tmp')));
});

test('normal final skill usage tracking does not invalidate the styling receipt', (t) => {
  const f = fixture(t);
  const plan = preparePlan(f.root, f.request);
  applyPlan(plan, { apply: true, approvedHash: plan.planHash, receipt: path.join(f.work, 'receipt.json') });
  f.put('site-settings/Site-AI-Skills-StyleSite.sitesetting.yml', 'name: Site/AI/Skills/StyleSite\nvalue: 1\n');
  assert.equal(applyPlan(plan).status, 'already-applied');
});
