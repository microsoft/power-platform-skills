const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SKILL_DIR = path.join(__dirname, '..', '..', 'skills', 'add-server-logic');
const SKILL_PATH = path.join(SKILL_DIR, 'SKILL.md');
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
  assert.match(skill, /Put every endpoint in `SERVER_LOGICS_DATA`/);
  assert.match(skill, /displayed endpoint count matches `SERVER_LOGICS_DATA`/);
  assert.match(skill, /Never ask the user to share secret values in chat/);
  assert.match(
    fullSkill,
    /Do \*\*not\*\* ask for the secret value|secret values must never pass through the conversation/
  );
  assert.match(skill, /Use the available deployment capability only after yes/);
  assert.match(skill, /ask whether to run the live endpoint testing workflow/);
  assert.doesNotMatch(fullSkill, /\/(?:deploy-site|test-site|activate-site)/);
  assert.doesNotMatch(fullSkill, /deterministic (?:writer|scripts)/);
  assert.match(
    fs.readFileSync(
      path.join(SKILL_DIR, 'references', 'server-logic-table-permissions.md'),
      'utf8'
    ),
    /wait for approval before creating any files/i
  );
  assert.match(
    fs.readFileSync(
      path.join(SKILL_DIR, 'references', 'server-logic-plan-data-format.md'),
      'utf8'
    ),
    /Never ask for approval on an incomplete plan/
  );
});

test('CSRF handling follows current server logic requirements', () => {
  const frontendReference = fs.readFileSync(
    path.join(SKILL_DIR, 'references', 'frontend-integration-reference.md'),
    'utf8'
  );
  assert.match(skill, /Every server logic API request, including GET, requires a CSRF token/);
  assert.match(frontendReference, /Every request to a server logic endpoint, including GET/);
  assert.doesNotMatch(frontendReference, /method !== 'GET'/);
});

test('implementation guidance validates inputs and upstream responses before success', () => {
  const implementation = fs.readFileSync(
    path.join(SKILL_DIR, 'references', 'server-logic-implementation.md'),
    'utf8'
  );
  assert.match(implementation, /Validate every required query\/body value before coercing/i);
  assert.match(implementation, /reject blank values as missing before numeric conversion/i);
  assert.match(implementation, /Treat non-2xx responses as failures/i);
  assert.match(implementation, /Define each endpoint's success and error JSON shapes/i);
  assert.match(implementation, /preserve the planned success fields/i);
  assert.match(implementation, /status:\s*"success"/);
  assert.match(implementation, /status:\s*"error"/);
  assert.match(skill, /success\/error response shapes with their property names and types/);
  assert.match(skill, /approved response contract/);
  assert.match(
    fs.readFileSync(
      path.join(SKILL_DIR, 'references', 'server-logic-plan-data-format.md'),
      'utf8'
    ),
    /success and error response shapes, property names, and value types/
  );
});

test('frontend envelope guidance supports documented and lowercase field names', () => {
  const frontendReference = fs.readFileSync(
    path.join(SKILL_DIR, 'references', 'frontend-integration-reference.md'),
    'utf8'
  );
  assert.match(frontendReference, /Success.*Data.*Error/s);
  assert.match(frontendReference, /Success\s*\?\?\s*[^;\n]*success/);
  assert.match(frontendReference, /Data\s*\?\?\s*[^;\n]*data/);
  assert.match(frontendReference, /Error\s*\?\?\s*[^;\n]*error/);

  const normalizer = frontendReference.match(
    /function readServerLogicData\(envelope: ServerLogicEnvelope\): string \{[\s\S]*?\n\}/
  );
  assert.ok(normalizer, 'envelope normalizer example must remain executable');
  const readServerLogicData = new Function(
    `${normalizer[0].replace(
      'function readServerLogicData(envelope: ServerLogicEnvelope): string {',
      'function readServerLogicData(envelope) {'
    )}; return readServerLogicData;`
  )();
  assert.equal(readServerLogicData({ Success: true, Data: '{"ok":true}' }), '{"ok":true}');
  assert.equal(readServerLogicData({ success: true, data: '{"ok":true}' }), '{"ok":true}');
  assert.throws(
    () => readServerLogicData({ Success: false, Error: 'denied', Data: null }),
    /denied/
  );
  assert.throws(
    () => readServerLogicData({ Success: true, Data: null }),
    /did not contain data/
  );
});
