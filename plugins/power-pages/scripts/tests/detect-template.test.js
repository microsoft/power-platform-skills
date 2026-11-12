const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  resolve, loadInstalledSolutions,
} = require('../../skills/migrate-datamodel/scripts/detect-template');

for (const [label, inspection, anchors, decision, templateKey] of [
  ['agree', 'Partner', ['PartnerPortal'], 'install-v2', 'Partner'],
  ['anchor overrides inspection', 'Partner', ['CommunityPortal'], 'install-v2', 'Community'],
  ['inspection breaks tie', 'Partner', ['PartnerPortal', 'CommunityPortal'], 'install-v2', 'Partner'],
  ['ambiguous unmatched anchors', 'Partner', ['CommunityPortal', 'ESSPortal'], 'prompt-pick'],
  ['inspection without anchor', 'Partner', [], 'prompt-confirm'],
  ['single medium anchor', null, ['PowerPages_FAQ'], 'install-v2', 'FAQ'],
  ['customer self service', null, ['customerportal'], 'install-v2', 'CustomerSelfService'],
  ['multiple medium anchors', null, ['PowerPages_FAQ', 'PowerPages_BuildingPermit'], 'prompt-pick-or-install-all'],
  ['no evidence', null, [], 'low-complexity-skip'],
]) {
  test(`template resolution: ${label}`, () => {
    const result = resolve({ match: inspection, signals: [] }, anchors);
    assert.equal(result.decision, decision);
    if (templateKey) assert.equal(result.templateKey, templateKey);
    assert.equal(result.needsPrompt, decision.startsWith('prompt'));
  });
}

test('solution list BOMs are decoded and missing requested input fails explicitly', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-template-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'solutions.txt');
  for (const bytes of [
    Buffer.from('\uFEFFUnique Name  PowerPages_FAQ\r\n', 'utf8'),
    Buffer.from('\uFEFFUnique Name  PowerPages_FAQ\r\n', 'utf16le'),
    Buffer.from('\uFEFFUnique Name  PowerPages_FAQ\r\n', 'utf16le').swap16(),
  ]) {
    fs.writeFileSync(file, bytes);
    assert.deepEqual(loadInstalledSolutions({ solutions: [], solutionsFile: file }), ['PowerPages_FAQ']);
  }
  assert.throws(() => loadInstalledSolutions({ solutions: [], solutionsFile: path.join(root, 'missing.txt') }),
    /Could not read template detection input/);
});

test('template inspection accepts the nested downloaded configuration root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-template-site-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, '.powerpages-site');
  fs.mkdirSync(config);
  fs.writeFileSync(path.join(config, 'website.yml'), 'adx_name: Contoso');
  fs.writeFileSync(path.join(config, 'webrole.yml'), '- adx_key: partneradmin');
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '../../skills/migrate-datamodel/scripts/detect-template.js'),
    '--site-root', root, '--solutions', 'PartnerPortal',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).resolution.templateKey, 'Partner');
});
