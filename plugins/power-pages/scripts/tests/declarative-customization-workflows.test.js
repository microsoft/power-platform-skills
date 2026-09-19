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
  assert.match(skill, /current-execution\.json/);
  assert.match(skill, /promote-customize-declarative-site-plan\.js/);
  assert.match(skill, /content-and-page-compositions\.md/);
  assert.match(skill, /outputBindings/);
  assert.match(skill, /--action resolve/);
  assert.match(skill, /publish the approved JSON/);
  assert.match(contract, /"layout": "two-equal-columns"/);
  assert.match(contract, /do not flatten\s+elements into numeric column indexes/i);
  assert.match(contract, /immutable latest approved plan/);
  assert.match(contract, /current-execution\.json/);
  assert.match(contract, /history\/<UTC-timestamp>/);
  assert.match(contract, /data-model-neutral/);
});

test('deploy-site keeps code and declarative upload commands isolated', () => {
  const skill = read(path.join('skills', 'deploy-site', 'SKILL.md'));
  const declarative = read(path.join('skills', 'deploy-site', 'workflows', 'declarative-site.md'));

  assert.match(skill, /Site-Type Routing/);
  assert.match(skill, /pac pages upload-code-site --rootPath/);
  assert.match(skill, /Do not continue into the\s+code-site phases below/);
  assert.match(declarative, /Use `pac pages upload`, never `pac pages upload-code-site`/);
  assert.match(declarative, /--modelVersion "<Enhanced\|Standard>"/);
  assert.match(declarative, /Data model: Pending verification/);
  assert.match(declarative, /First upload — create site records/);
  assert.match(declarative, /Which data model should be used for the first upload\?/);
  assert.match(declarative, /Do not recommend, preselect, or silently default either model/);
  assert.match(declarative, /different website record with the same site name/);
  assert.match(declarative, /Create this declarative site in the selected\s+environment using the chosen data model\?/);
  assert.match(declarative, /--websiteRecordId "<WEBSITE_RECORD_ID>"/);
  assert.match(declarative, /--siteRoot "<PROJECT_RELATIVE_SITE_ROOT>"/);
  assert.match(declarative, /Do not invoke `activate-site`/);
  assert.match(declarative, /deploy-site:declarative-5.upload/);
});
