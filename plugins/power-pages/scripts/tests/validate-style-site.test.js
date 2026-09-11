const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fixture } = require('./style-site-fixtures');
const { preparePlan } = require('../lib/style-site-plan');
const { main, verify } = require('../../skills/style-site/scripts/validate-style-site');
const validator = path.resolve(__dirname, '../../skills/style-site/scripts/validate-style-site.js');

test('validates proposal then rejects changes without a matching completed receipt', (t) => {
  const f = fixture(t);
  const plan = preparePlan(f.root, f.request);
  assert.equal(verify(plan).status, 'verified-proposal');
  assert.throws(() => verify(plan, { planHash: plan.planHash, siteRoot: plan.siteRoot, status: 'failed' }), /Receipt/);
  f.put(f.cssPath, '/* modified */');
  assert.throws(() => verify(plan), /snapshot/);
});

test('explicit validation works for arbitrary external work directories', (t) => {
  const f = fixture(t);
  const file = path.join(f.work, 'draft.json');
  fs.writeFileSync(file, JSON.stringify(preparePlan(f.root, f.request)));
  assert.equal(main(['--plan', file]).status, 'verified-proposal');
});

test('hook is quiet before artifacts exist, but blocks malformed existing artifacts', (t) => {
  const f = fixture(t);
  const run = () => spawnSync(process.execPath, [validator], { input: JSON.stringify({ cwd: f.work }), encoding: 'utf8', env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: '1' } });
  assert.equal(run().status, 0);
  const folder = path.join(f.work, '.powerpages-style');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'style-site.plan.json'), '{invalid');
  const result = run();
  assert.equal(result.status, 2);
  assert.match(result.stderr, /style-site:/);
});

for (const applied of [false, true]) {
  test(`verification rejects newly added styling inputs (applied: ${applied})`, (t) => {
    const f = fixture(t);
    const plan = preparePlan(f.root, f.request);
    let receipt;
    if (applied) {
      const receiptPath = path.join(f.work, 'receipt.json');
      require('../../skills/style-site/scripts/apply-style-plan').applyPlan(plan, {
        apply: true, approvedHash: plan.planHash, receipt: receiptPath,
      });
      receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    }
    f.put('web-files/additional.css', '.pp-card { color: #123456; }');
    assert.throws(() => verify(plan, receipt), /inventory changed/);
  });
}
