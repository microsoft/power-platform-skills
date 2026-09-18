const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pluginRoot = path.join(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(pluginRoot, relativePath), 'utf8');
}

test('create-site can hand an Enhanced baseline to declarative customization', () => {
  const skill = read(path.join('skills', 'create-site', 'SKILL.md'));
  const workflow = read(path.join('skills', 'create-site', 'workflows', 'edm-site.md'));

  assert.match(skill, /allowed-tools: [^\n]*\bSkill\b/);
  assert.match(skill, /create-site:edm-8-customize/);
  assert.match(workflow, /Would you like to customize the downloaded declarative template now\?/);
  assert.match(workflow, /invoke `\/customize-declarative-site` through the `Skill` tool/);
  assert.match(workflow, /validated, committed baseline/);
});

test('customize-declarative-site coordinates owning skills without authoring records directly', () => {
  const skill = read(path.join('skills', 'customize-declarative-site', 'SKILL.md'));
  const contract = read(path.join(
    'skills',
    'customize-declarative-site',
    'references',
    'customization-plan-contract.md'
  ));

  assert.match(skill, /user-invocable: true/);
  assert.match(skill, /author-web-file/);
  assert.match(skill, /author-content-snippet/);
  assert.match(skill, /author-web-template/);
  assert.match(skill, /author-page-template/);
  assert.match(skill, /author-webpage-content/);
  assert.match(skill, /invoke `style-site` last/);
  assert.match(skill, /does not directly author webpage, snippet, web-file, web-template, page-template/);
  assert.match(skill, /current-plan\.json/);
  assert.match(skill, /history\/<UTC-timestamp>/);
  assert.match(skill, /promote-customize-declarative-site-plan\.js/);
  assert.match(contract, /layout: two-equal-columns/);
  assert.match(contract, /do not flatten\s+elements into numeric column indexes/i);
  assert.match(contract, /authoritative latest approved plan/);
});

test('deploy-site keeps code and declarative upload commands isolated', () => {
  const skill = read(path.join('skills', 'deploy-site', 'SKILL.md'));
  const declarative = read(path.join('skills', 'deploy-site', 'workflows', 'declarative-site.md'));

  assert.match(skill, /Site-Type Routing/);
  assert.match(skill, /pac pages upload-code-site --rootPath/);
  assert.match(skill, /Do not continue into the\s+code-site phases below/);
  assert.match(declarative, /Use `pac pages upload`, never `pac pages upload-code-site`/);
  assert.match(declarative, /--modelVersion "<Enhanced\|Standard>"/);
  assert.match(declarative, /Do not invoke `activate-site`/);
  assert.match(declarative, /deploy-site:declarative-5.upload/);
});
