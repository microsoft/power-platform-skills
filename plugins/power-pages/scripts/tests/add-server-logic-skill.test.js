const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SKILL_DIR = path.join(__dirname, '..', '..', 'skills', 'add-server-logic');
const SKILL_PATH = path.join(SKILL_DIR, 'SKILL.md');
const SITE_INTEGRITY_PATH = path.resolve(
  SKILL_DIR,
  '..',
  '..',
  'references',
  'site-modification-integrity.md'
);
const REFERENCE_NAMES = [
  'server-logic-docs.md',
  'server-logic-plan-data-format.md',
  'server-logic-implementation.md',
  'server-logic-table-permissions.md',
  'server-logic-secrets-workflow.md',
  'frontend-integration-reference.md',
  'server-logic-troubleshooting.md',
];
const skill = fs.readFileSync(SKILL_PATH, 'utf8');
const references = REFERENCE_NAMES.map((name) =>
  fs.readFileSync(path.join(SKILL_DIR, 'references', name), 'utf8')
);
const siteIntegrity = fs.readFileSync(SITE_INTEGRITY_PATH, 'utf8');
const fullSkill = [skill, ...references].join('\n');

test('main skill stays concise and does not bind to one agent runtime', () => {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatter, 'skill frontmatter must be present');
  assert.doesNotMatch(frontmatter[1], /^(?:allowed-tools|model):/m);
  assert.doesNotMatch(fullSkill, /mcp__plugin_|TaskCreate|TaskUpdate|TaskList|AskUserQuestion/);
  assert.ok(skill.split('\n').length < 300, 'conditional detail belongs in references');
});

test('every progressively loaded reference exists', () => {
  for (const reference of REFERENCE_NAMES) {
    assert.ok(fs.existsSync(path.join(SKILL_DIR, 'references', reference)), reference);
    assert.ok(skill.includes(`references/${reference}`), `${reference} must be reachable`);
  }
  assert.ok(skill.includes('${PLUGIN_ROOT}/references/site-modification-integrity.md'));
  assert.ok(fs.existsSync(SITE_INTEGRITY_PATH), 'site-modification-integrity.md');
  assert.match(siteIntegrity, /configured locale resource/i);
  assert.match(siteIntegrity, /bidirectional/i);
  assert.match(siteIntegrity, /expansion/i);
});

test('all approval gates and data-gathering prompts remain discoverable', () => {
  const gates = [
    'add-server-logic:1.5.deploy-first',
    'add-server-logic:2.1.2.use-custom-actions',
    'add-server-logic:2.3.1.keyvault',
    'add-server-logic:4.4.plan-approval',
    'add-server-logic:7.2a.no-vaults',
    'add-server-logic:9.1.frontend-scope',
    'add-server-logic:11.3.deploy',
    'add-server-logic:11.3.test',
  ];
  const lines = fullSkill.split('\n');
  for (const gate of gates) {
    assert.ok(fullSkill.includes(`<!-- gate: ${gate} `), `${gate} must remain cataloged`);
    const markerIndex = lines.findIndex((line) => line.includes(`<!-- gate: ${gate} `));
    assert.ok(
      lines.slice(markerIndex, markerIndex + 11).some((line) => line.includes('🚦 **Gate')),
      `${gate} must retain nearby human-readable approval guidance`
    );
  }
  const secretsReference = REFERENCE_NAMES.find((name) => name.includes('server-logic-secrets'));
  assert.match(
    secretsReference,
    /-workflow\.md$/,
    'the secrets gate must remain in a linted workflow reference'
  );

  const subPrompts = [
    'per-item custom-action mapping',
    'requirement clarification',
    'Key Vault selection',
    'Key Vault provisioning parameters',
  ];
  for (const prompt of subPrompts) {
    assert.ok(fullSkill.includes(`<!-- not-a-gate: ${prompt}`), `${prompt} must remain marked`);
  }
});

test('approval and secret-handling safeguards remain explicit', () => {
  assert.match(skill, /get approval before writing server logic or creating environment variables/i);
  assert.match(skill, /\*\*Initial request:\*\* \$ARGUMENTS/);
  assert.match(skill, /Put every endpoint in `SERVER_LOGICS_DATA`/);
  assert.match(skill, /Never ask the user to share secret values in chat/);
  assert.match(
    fullSkill,
    /Do \*\*not\*\* ask for the secret value|secret values must never pass through the conversation/
  );
  assert.match(skill, /Use the available deployment capability only after yes/);
  assert.match(skill, /ask whether to run the live endpoint testing workflow/);
  assert.doesNotMatch(fullSkill, /\/(?:create-site|deploy-site|test-site|activate-site)(?![\w-])/);
  assert.doesNotMatch(fullSkill, /deterministic (?:writer|scripts)/);
  assert.match(
    fs.readFileSync(
      path.join(SKILL_DIR, 'references', 'server-logic-table-permissions.md'),
      'utf8'
    ),
    /wait for approval before creating any files/i
  );
  assert.match(skill, /Before changing SPA UI, read.*site-modification-integrity\.md/);
});

test('CSRF guidance preserves the baseline non-GET requirement', () => {
  const frontendReference = fs.readFileSync(
    path.join(SKILL_DIR, 'references', 'frontend-integration-reference.md'),
    'utf8'
  );
  const troubleshooting = fs.readFileSync(
    path.join(SKILL_DIR, 'references', 'server-logic-troubleshooting.md'),
    'utf8'
  );
  assert.match(skill, /POST, PUT, PATCH, and DELETE requests require a CSRF token/);
  assert.match(skill, /GET requests are exempt from antiforgery validation/);
  assert.match(frontendReference, /CSRF token is required for non-GET requests only/);
  assert.match(frontendReference, /if \(method !== 'GET'\)/);
  assert.match(troubleshooting, /GET requests are exempt from antiforgery validation/);
  assert.doesNotMatch(troubleshooting, /Failed to get CSRF token/);
});

test('upstream runtime and Dataverse guidance remains reachable', () => {
  const implementation = fs.readFileSync(
    path.join(SKILL_DIR, 'references', 'server-logic-implementation.md'),
    'utf8'
  );
  const frontendReference = fs.readFileSync(
    path.join(SKILL_DIR, 'references', 'frontend-integration-reference.md'),
    'utf8'
  );
  const planReference = fs.readFileSync(
    path.join(SKILL_DIR, 'references', 'server-logic-plan-data-format.md'),
    'utf8'
  );
  assert.match(implementation, /Callbacks.*arrow functions/i);
  assert.match(implementation, /with\\s\*\\\(/);
  assert.match(implementation, /Function\\s\*\\\(/);
  assert.match(implementation, /Anonymous callbacks.*\.map\(function/);
  assert.match(implementation, /JSON\.parse\(Server\.Connector\.Dataverse\.RetrieveRecord/);
  assert.match(implementation, /read query options without a leading/);
  assert.match(frontendReference, /OData-EntityId/);
  assert.match(frontendReference, /Pass read query options without a leading/);
  assert.doesNotMatch(implementation, /Preserve input and response contracts/);
  assert.doesNotMatch(implementation, /Validate every required query\/body value before coercing/i);
  assert.doesNotMatch(skill, /success\/error response shapes with their property names and types/);
  assert.doesNotMatch(planReference, /success and error response shapes, property names, and value types/);
  assert.doesNotMatch(planReference, /Never ask for approval on an incomplete plan/);
});

test('frontend envelope guidance uses the documented lowercase response fields', () => {
  const frontendReference = fs.readFileSync(
    path.join(SKILL_DIR, 'references', 'frontend-integration-reference.md'),
    'utf8'
  );
  assert.match(frontendReference, /"success": true/);
  assert.match(frontendReference, /"data":/);
  assert.match(frontendReference, /"error": null/);
  assert.match(frontendReference, /envelope\.success/);
  assert.match(frontendReference, /envelope\.data/);
  assert.match(frontendReference, /envelope\.error/);
  assert.doesNotMatch(frontendReference, /readServerLogicData/);
  assert.doesNotMatch(frontendReference, /Success\s*\?\?/);
});

test('upstream trace diagnostics distinguish inline logs from trace identifiers', () => {
  const troubleshooting = fs.readFileSync(
    path.join(SKILL_DIR, 'references', 'server-logic-troubleshooting.md'),
    'utf8'
  );
  assert.match(troubleshooting, /x-ms-user-trace` response header/);
  assert.match(troubleshooting, /x-ms-user-trace-id/);
  assert.match(troubleshooting, /do not decode the identifier as logs/);
});
