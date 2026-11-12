const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const pluginRoot = path.resolve(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(pluginRoot, relativePath), 'utf8');
}

test('setup-datamodel resolves code, nested non-SPA, and direct non-SPA contexts', () => {
  const skill = read(path.join('skills', 'setup-datamodel', 'SKILL.md'));

  assert.match(skill, /detect-project-context\.js/);
  assert.match(skill, /siteType: "spa"/);
  assert.match(skill, /siteType: "non-spa"/);
  assert.match(skill, /nested under[\s\S]*\.powerpages-site/);
  assert.match(skill, /opened directly[\s\S]*\.portalconfig\/[\s\S]*website\.yml/);
  assert.match(skill, /Non-SPA exports do not carry a reliable environment URL/);
});

test('non-SPA site analysis reference defines primary evidence and resolution', () => {
  const agent = read(path.join('agents', 'data-model-architect.md'));
  const referencePath = path.join(
    'skills',
    'setup-datamodel',
    'references',
    'non-spa-site-analysis.md',
  );
  const reference = read(referencePath);

  for (const component of [
    'basic-forms/',
    'advanced-forms/',
    'lists/',
    'table-permissions/',
    'site-settings/',
    'web-pages/',
    'web-templates/',
    'web-files/',
  ]) {
    assert.ok(reference.includes(component), `missing non-SPA evidence source: ${component}`);
  }

  assert.ok(agent.includes(referencePath.replaceAll(path.sep, '/')));
  assert.match(reference, /Liquid `\{% fetchxml %\}`/);
  assert.match(reference, /Webpage[\s\S]*Page Template[\s\S]*Web Template/);
  assert.match(reference, /content-snippets\/[\s\S]*only when reachable content contains/);
  assert.match(reference, /Saved views and their FetchXML for Lists/);
  assert.match(reference, /Dataverse metadata as the source of truth/);
});

test('non-SPA analysis is evidence-only and supports a no-change result', () => {
  const skill = read(path.join('skills', 'setup-datamodel', 'SKILL.md'));
  const agent = read(path.join('agents', 'data-model-architect.md'));
  const reference = read(
    path.join('skills', 'setup-datamodel', 'references', 'non-spa-site-analysis.md'),
  );

  assert.match(skill, /does not authorize edits to non-SPA site forms, lists, pages/);
  assert.match(agent, /Non-SPA components remain read-only evidence/);
  assert.match(reference, /Do not create or modify Forms/);
  assert.match(reference, /may legitimately produce no Dataverse changes/);
  assert.match(reference, /Unused or unreachable reference/);
  assert.match(reference, /Plain text, navigation labels, styling assets, and unused templates/);
});

test('non-SPA data-model completion does not recommend sample data by default', () => {
  const skill = read(path.join('skills', 'setup-datamodel', 'SKILL.md'));

  assert.match(skill, /For a SPA site or no-site schema session[\s\S]*`\/add-sample-data`/);
  assert.match(skill, /For a non-SPA site, do not suggest `\/add-sample-data`/);
});
