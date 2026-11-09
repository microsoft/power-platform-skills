const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '../../skills/migrate-datamodel/scripts/diff-snapshots.js');

function compare(t, sdmInventory, edmInventory, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-diff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [label, inventory] of [['sdm', sdmInventory], ['edm', edmInventory]]) {
    const snapshot = Object.hasOwn(options, `${label}Snapshot`) ? options[`${label}Snapshot`] : {
      label, inventory, parseErrors: options[label] || {},
    };
    fs.writeFileSync(path.join(root, `${label}.json`), JSON.stringify(snapshot));
  }
  const result = spawnSync(process.execPath, [
    script, '--sdm', path.join(root, 'sdm.json'), '--edm', path.join(root, 'edm.json'),
    '--output-dir', root,
  ], { encoding: 'utf8' });
  const output = path.join(root, 'migration-data-diff.json');
  return { ...result, diff: fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : null };
}

test('equivalent identities and active state normalization still pass', (t) => {
  const result = compare(t, { webTemplates: [{ name: 'Home', stateCode: null }] },
    { webTemplates: [{ name: 'Home', stateCode: 0 }] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.diff.overallStatus, 'pass');
});

test('state, setting value and content changes remain reviewable warnings', (t) => {
  const result = compare(t, {
    webTemplates: [{ name: 'Home', stateCode: 0, contentHash: 'before' }],
    siteSettings: [{ name: 'Search/Enabled', value: 'true' }],
  }, {
    webTemplates: [{ name: 'Home', stateCode: 1, contentHash: 'after' }],
    siteSettings: [{ name: 'Search/Enabled', value: 'false' }],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.diff.overallStatus, 'warn');
  assert.equal(result.diff.categories.webTemplates.stateChanged.length, 1);
  assert.equal(result.diff.categories.webTemplates.contentChanged.length, 1);
  assert.equal(result.diff.categories.siteSettings.valueChanged.length, 1);
});

test('missing metadata still fails while SDM-only download categories warn', (t) => {
  const result = compare(t, {
    webTemplates: [{ name: 'Home' }], ads: [{ name: 'Ad' }], tags: [{ name: 'Tag' }],
  }, { webTemplates: [], ads: [], tags: [] });
  assert.equal(result.status, 1);
  assert.equal(result.diff.categories.webTemplates.status, 'fail');
  // Ads are nonconfiguration data and remain intentionally excluded.
  assert.equal(result.diff.categories.ads.status, 'excluded');
  assert.equal(result.diff.categories.tags.status, 'warn');
});

test('parse errors in either or both snapshots prevent a passing comparison', async (t) => {
  for (const side of ['sdm', 'edm', 'both']) {
    await t.test(side, (t) => {
      const errors = { webPages: [{ filePath: 'Home.webpage.yml', message: 'invalid YAML' }] };
      const result = compare(t, {}, {}, {
        sdm: side !== 'edm' ? errors : {},
        edm: side !== 'sdm' ? errors : {},
      });
      assert.equal(result.status, 1);
      assert.equal(result.diff.overallStatus, 'fail');
      assert.deepEqual(result.diff.parseErrors[side === 'edm' ? 'edm' : 'sdm'], errors);
      assert.match(result.stderr, /snapshot parse error/);
    });
  }
});

test('one-sided companion content hash warns in either direction', async (t) => {
  for (const [sdmHash, edmHash] of [['hash', null], [null, 'hash']]) {
    await t.test(`${sdmHash} to ${edmHash}`, (t) => {
      const result = compare(t, { webTemplates: [{ name: 'Home', contentHash: sdmHash }] },
        { webTemplates: [{ name: 'Home', contentHash: edmHash }] });
      assert.equal(result.diff.overallStatus, 'warn');
      assert.equal(result.diff.categories.webTemplates.contentChanged.length, 1);
    });
  }
});

test('two absent hashes remain equal', (t) => {
  const result = compare(t, { webTemplates: [{ name: 'Home', contentHash: null }] },
    { webTemplates: [{ name: 'Home' }] });
  assert.equal(result.diff.overallStatus, 'pass');
});

test('pipe characters cannot collide across identity fields', (t) => {
  const result = compare(t, { contentSnippets: [{ name: 'a|b', language: 'c' }] },
    { contentSnippets: [{ name: 'a', language: 'b|c' }] });
  assert.equal(result.status, 1);
  assert.equal(result.diff.categories.contentSnippets.missingInEdm.length, 1);
  assert.equal(result.diff.categories.contentSnippets.extraInEdm.length, 1);
});

test('navigation identities include parent set and language', (t) => {
  const result = compare(t, { webLinks: [
    { name: 'Home', parentSet: 'Main', language: 'en-US' },
    { name: 'Home', parentSet: 'Footer', language: 'en-US' },
  ] }, { webLinks: [
    { name: 'Home', parentSet: 'Main', language: 'fr-FR' },
    { name: 'Home', parentSet: 'Footer', language: 'en-US' },
  ] });
  assert.equal(result.status, 1);
  assert.equal(result.diff.categories.webLinks.missingInEdm.length, 1);
});

test('duplicate identities cannot silently overwrite one another', (t) => {
  const records = [{ name: 'Repeated', slug: 'first' }, { name: 'Repeated', slug: 'second' }];
  const result = compare(t, { basicForms: records }, { basicForms: records });
  assert.equal(result.status, 1);
  assert.equal(result.diff.categories.basicForms.duplicateKeys.sdm.length, 1);
  assert.match(result.stdout, /duplicate identities/);
});

test('missing inventory is rejected rather than treated as empty', (t) => {
  const result = compare(t, undefined, {});
  assert.equal(result.status, 1);
  assert.equal(result.diff, null);
  assert.match(result.stderr, /inventory object/);
});

test('null snapshots and null inventory records produce descriptive validation errors', (t) => {
  const missing = compare(t, {}, {}, { sdmSnapshot: null });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /sdm snapshot must contain an inventory object/);
  assert.doesNotMatch(missing.stderr, /TypeError|Cannot read properties/);
  const record = compare(t, { webTemplates: [null] }, {});
  assert.equal(record.status, 1);
  assert.match(record.stderr, /inventory records must be objects/);
  assert.doesNotMatch(record.stderr, /TypeError|Cannot read properties/);
});
