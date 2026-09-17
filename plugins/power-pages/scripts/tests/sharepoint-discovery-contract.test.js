const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const skill = fs.readFileSync(path.join(root, 'skills/sharepoint-to-power-pages/SKILL.md'), 'utf8');
const reference = fs.readFileSync(path.join(root, 'references/sharepoint-migration.md'), 'utf8');
const source = reference.split('## Source discovery and branding')[1].split('## Backend paths')[0];
const backend = reference.split('## Backend paths')[1];

test('SharePoint discovery has no API-call or token-acquisition recipe', () => {
  assert.match(source, /Browser-only boundary/);
  assert.doesNotMatch(source, /\baz\s+(?:rest|account|get-access-token)\b/i);
  assert.doesNotMatch(source, /https:\/\/graph\.microsoft\.com|\/sites\/\{site-id\}|\/_api\//i);
  assert.doesNotMatch(source, /\bfetch\s*\(|new\s+XMLHttpRequest/);
  assert.match(source, /Do not call `fetch`\/XHR/);
  assert.match(source, /capture\/replay network requests/);
});

test('browser access requires an opened sign-in page and user completion before inspection', () => {
  assert.match(skill, /gate: sharepoint-to-power-pages:4\.browser-sign-in \| category=pause/);
  assert.match(source, /open that page in a user-visible window/);
  assert.match(source, /The user enters credentials/);
  assert.match(source, /same browser context/);
  assert.match(source, /Confirm the expected site\/list\/document content is visible/);
  assert.match(source, /Virtualized lists show only part of their contents/);
  assert.match(source, /Record internal names, data types, relationships, and hidden columns as unverified/);
});

test('destination runtime integration remains distinct from browser-only source discovery', () => {
  assert.match(backend, /Browser-only discovery does not remove their own/);
  assert.match(backend, /\/_api\/<EntitySetName>/);
  assert.match(backend, /sharepointdocumentlocation/);
  assert.match(backend, /Power Pages session-authenticated runtime APIs are not a fallback/);
});

function phase(number) {
  const header = `## Phase ${number}: `;
  const start = skill.indexOf(header);
  assert.notEqual(start, -1, `Phase ${number} must exist.`);
  return skill.slice(start + header.length).split(/^## (?:Phase \d+:|Progress tracking)/m)[0];
}

test('the scaffold is shown immediately after intake, before source discovery and implementation', () => {
  assert.match(phase(2), /2\.scaffold/);
  assert.match(phase(3), /^Scaffold and launch/);
  assert.match(phase(3), /skills\/create-site\/SKILL\.md/);
  assert.match(phase(3), /npm run dev/);
  assert.match(phase(3), /browser_snapshot/);
  assert.match(phase(3), /DEV_SERVER_URL/);
  assert.match(phase(3), /Do not wait for SharePoint sign-in/);
  assert.match(phase(3), /URL.*shared|share.*URL/i);
  assert.match(phase(4), /^Discover sources/);
  assert.match(phase(5), /^Build against the live preview/);
});

test('live updates remain visible through implementation and do not trigger early deployment', () => {
  assert.match(phase(3), /Live Preview Status Protocol/);
  assert.match(phase(3), /awaitingInput/);
  assert.match(phase(5), /hot reload/);
  assert.match(phase(5), /every.*page.*component/i);
  assert.match(phase(5), /running/);
  assert.match(phase(5), /If the server fails, restore the live preview/);
  assert.match(phase(3), /avoid duplicate servers or re-scaffolding/);
  assert.match(phase(3), /Source sign-in must not replace the user's live-preview tab/);
  for (let number = 1; number <= 6; number++) {
    assert.doesNotMatch(phase(number), /invoke `\/power-pages:(?:deploy-site|activate-site)`/i);
  }
});

test('finished local previews get deployment and existing activation handling without requiring a pilot first', () => {
  const deployment = phase(7);
  assert.match(deployment, /7\.deploy/);
  assert.match(deployment, /Deploy now/);
  assert.match(deployment, /Keep local/);
  assert.match(deployment, /first-time local preview/);
  assert.match(deployment, /invoke `\/power-pages:deploy-site`/i);
  assert.match(deployment, /check-activation-status\.js/);
  assert.match(deployment, /`activated: true`/);
  assert.match(deployment, /`activated: false`/);
  assert.match(deployment, /\/power-pages:activate-site/);
  assert.match(deployment, /Do not repeat/);
  assert.match(deployment, /unknown/);
  assert.match(deployment, /If deployment fails or is cancelled.*do not start activation/);
  assert.match(deployment, /If declined, record uploaded but not activated/);
  assert.ok(deployment.indexOf('7.deploy') < deployment.indexOf('7.prepare-backend'));
  assert.doesNotMatch(deployment, /For a local preview.*go directly to handoff/);
});

test('phase references preserve scoped browser discovery and approval before customization', () => {
  assert.match(source, /`4\.browser-sign-in`/);
  assert.match(phase(4), /4\.inspect-source/);
  assert.match(phase(4), /4\.exposure-plan/);
  assert.match(phase(4), /For the inspect choice only/);
  assert.match(phase(4), /replaces a duplicate create-site plan-approval question/);
  assert.match(phase(6), /return to Phase 4 if scope changes/);
  assert.doesNotMatch(skill, /3\.browser-sign-in|3\.exposure-plan|5\.prepare-backend|5\.data-operation|7\.release/);
});

test('list discovery inventories the approved sites before explicit multiselection', () => {
  assert.match(source, /Site contents/);
  assert.match(source, /all accessible lists before asking which to expose/);
  assert.match(source, /document libraries/);
  assert.match(source, /coverage partial/);
  assert.match(phase(4), /4\.select-lists/);
  assert.match(phase(4), /multi-select/);
  assert.match(phase(4), /one virtual table for every selected list/);
  assert.match(phase(4), /If no lists are selected, skip list provisioning/);
});
