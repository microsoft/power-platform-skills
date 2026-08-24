'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validate } = require('../validate-apple-identifier-capability');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const LIB = path.join(
  PLUGIN_ROOT,
  'assets/apple-fastlane/fastlane/lib/apple_identifier.rb',
);
const WORK = path.join(__dirname, '.apple-fastlane-identifier-work');
const TEAM = 'A1B2C3D4E5';
const OTHER_TEAM = 'Z9Y8X7W6V5';
const BUNDLE = 'com.contoso.fieldapp';
const CONFIRM = `ensure-identifier-capability-${TEAM}-${BUNDLE}`;

test.afterEach(() => {
  fs.rmSync(WORK, { recursive: true, force: true });
});

function exact({ push = true, team = TEAM, explicit = true, platform = 'ios' } = {}) {
  return {
    resource_id: 'ABC123XYZ',
    team_id: team,
    platform,
    explicit,
    push_enabled: push,
  };
}

function state(overrides = {}) {
  return {
    team_found: true,
    pending_agreements: false,
    identifiers_readable: true,
    selected_exact: exact(),
    other_team_exact: [],
    wildcard_conflicts: [],
    case_conflicts: [],
    ...overrides,
  };
}

function runRuby(states, options = {}) {
  fs.mkdirSync(WORK, { recursive: true });
  const output = path.join(WORK, 'apple-ios-identifier.json');
  const source = [
    `require ${JSON.stringify(LIB)}`,
    'class MockAdapter',
    '  attr_reader :calls',
    '  def initialize(states)',
    '    @states = states',
    '    @calls = []',
    '  end',
    '  def inspect_state(team_id:, bundle_id:)',
    '    @calls << ["inspect", team_id, bundle_id]',
    '    @states.length > 1 ? @states.shift : @states.first',
    '  end',
    '  def create_explicit_identifier(team_id:, bundle_id:, app_name:)',
    '    @calls << ["create", team_id, bundle_id, app_name]',
    '  end',
    '  def enable_push(team_id:, bundle_id:)',
    '    @calls << ["push", team_id, bundle_id]',
    '  end',
    'end',
    `states = JSON.parse(${JSON.stringify(JSON.stringify(states))}, symbolize_names: true)`,
    'adapter = MockAdapter.new(states)',
    'begin',
    '  result = MobileAppAppleIdentifier.run(',
    `    team_id: ${JSON.stringify(TEAM)}, bundle_id: ${JSON.stringify(BUNDLE)},`,
    `    app_name: "Field App", confirm: ${JSON.stringify(options.confirm || '')},`,
    `    refresh: ${JSON.stringify(String(options.refresh || false))},`,
    `    adapter: adapter, output_path: ${JSON.stringify(output)},`,
    '    now: Time.utc(2026, 8, 21, 5, 0, 0))',
    '  puts JSON.generate({ result: result, calls: adapter.calls })',
    'rescue MobileAppAppleIdentifier::Blocked => error',
    '  puts JSON.generate({ blocked: error.code, details: error.details, calls: adapter.calls })',
    '  exit 2',
    'end',
  ].join('\n');
  return { output, result: spawnSync('ruby', ['-e', source], { encoding: 'utf8' }) };
}

test('reuses an exact explicit iOS identifier with Push already enabled', () => {
  const run = runRuby([state()]);
  assert.equal(run.result.status, 0, run.result.stderr);
  const parsed = JSON.parse(run.result.stdout);
  assert.deepEqual(parsed.calls.map(([operation]) => operation), ['inspect', 'inspect']);
  assert.equal(parsed.result.identifier.action, 'reused');
  assert.equal(parsed.result.pushCapability.action, 'reused');
  assert.equal(parsed.result.mode, 'developer-portal-only');
  assert.deepEqual(parsed.result.appStoreConnect, {
    appCreated: false,
    listingCreated: false,
  });
});

test('missing identifier requires exact confirmation before any mutation', () => {
  const missing = state({ selected_exact: null });
  const run = runRuby([missing]);
  assert.equal(run.result.status, 2);
  assert.deepEqual(JSON.parse(run.result.stdout), {
    blocked: 'mutation-confirmation-required',
    details: {
      mutations: ['create-explicit-identifier', 'enable-push-notifications'],
      confirmation_token: CONFIRM,
    },
    calls: [['inspect', TEAM, BUNDLE]],
  });
  assert.equal(fs.existsSync(run.output), false);
});

test('creates the exact identifier, enables Push, and proves both by read-back', () => {
  const run = runRuby(
    [state({ selected_exact: null }), state()],
    { confirm: CONFIRM },
  );
  assert.equal(run.result.status, 0, run.result.stderr);
  const parsed = JSON.parse(run.result.stdout);
  assert.deepEqual(parsed.calls.map(([operation]) => operation), [
    'inspect', 'create', 'push', 'inspect',
  ]);
  assert.equal(parsed.result.identifier.action, 'created');
  assert.equal(parsed.result.pushCapability.action, 'enabled');
  assert.equal(parsed.result.identifier.platform, 'ios');
  assert.equal(parsed.result.teamId, TEAM);
  assert.equal(parsed.result.bundleId, BUNDLE);
  const persisted = fs.readFileSync(run.output, 'utf8');
  assert.deepEqual(validate(JSON.parse(persisted), {
    expectedTeam: TEAM,
    expectedBundle: BUNDLE,
    now: new Date('2026-08-21T05:30:00.000Z'),
  }), []);
  assert.doesNotMatch(persisted, /@|password|session|cookie|appleId|email/i);
});

test('enables Push on an existing exact identifier without creating or renaming it', () => {
  const run = runRuby(
    [state({ selected_exact: exact({ push: false }) }), state()],
    { confirm: CONFIRM },
  );
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.deepEqual(
    JSON.parse(run.result.stdout).calls.map(([operation]) => operation),
    ['inspect', 'push', 'inspect'],
  );
});

test('wrong-team, wildcard, and case-only conflicts block without mutation', () => {
  for (const [field, value, reason] of [
    ['other_team_exact', [{ team_id: OTHER_TEAM }], 'wrong-team-conflict'],
    ['wildcard_conflicts', [{ team_id: TEAM }], 'wildcard-conflict'],
    ['case_conflicts', [{ team_id: TEAM }], 'identifier-conflict'],
  ]) {
    const run = runRuby([state({ selected_exact: null, [field]: value })], {
      confirm: CONFIRM,
    });
    assert.equal(run.result.status, 2);
    assert.equal(JSON.parse(run.result.stdout).blocked, reason);
    assert.deepEqual(
      JSON.parse(run.result.stdout).calls.map(([operation]) => operation),
      ['inspect'],
    );
  }
});

test('permission, agreement, and failed read-back are safe blockers', () => {
  for (const [overrides, reason] of [
    [{ pending_agreements: true }, 'agreements'],
    [{ identifiers_readable: false }, 'cip-permissions'],
  ]) {
    const run = runRuby([state(overrides)]);
    assert.equal(run.result.status, 2);
    assert.equal(JSON.parse(run.result.stdout).blocked, reason);
  }

  const failedReadback = runRuby(
    [state({ selected_exact: null }), state({ selected_exact: null })],
    { confirm: CONFIRM },
  );
  assert.equal(failedReadback.result.status, 2);
  assert.equal(JSON.parse(failedReadback.result.stdout).blocked, 'identifier-readback-failed');
  assert.equal(fs.existsSync(failedReadback.output), false);
});

test('existing handoff requires separately approved refresh', () => {
  const first = runRuby([state()]);
  assert.equal(first.result.status, 0, first.result.stderr);
  const second = runRuby([state()]);
  assert.equal(second.result.status, 2);
  assert.equal(JSON.parse(second.result.stdout).blocked, 'refresh-approval-required');
  const refreshed = runRuby([state()], { refresh: true });
  assert.equal(refreshed.result.status, 0, refreshed.result.stderr);
});

test('validator rejects identity drift, ASC side effects, stale proof, and sensitive fields', () => {
  const run = runRuby([state()]);
  assert.equal(run.result.status, 0, run.result.stderr);
  const document = JSON.parse(fs.readFileSync(run.output, 'utf8'));
  document.teamId = OTHER_TEAM;
  document.appStoreConnect.appCreated = true;
  document.proof.validUntil = '2026-08-21T05:01:00.000Z';
  document.accountEmail = ['maker', 'example.invalid'].join('@');
  const issues = validate(document, {
    expectedTeam: TEAM,
    expectedBundle: BUNDLE,
    now: new Date('2026-08-21T05:30:00.000Z'),
  });
  assert.ok(issues.includes('team-mismatch'));
  assert.ok(issues.includes('app-store-connect-side-effect'));
  assert.ok(issues.includes('proof-window-invalid'));
  assert.ok(issues.includes('sensitive-content-forbidden'));
});

test('Fastfile uses only Portal primitives and delegates exact profile setup', () => {
  const fastfile = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'assets/apple-fastlane/fastlane/Fastfile'),
    'utf8',
  );
  assert.match(fastfile, /create_app!\(:explicit/);
  assert.match(fastfile, /AppService::PushNotification\.on/);
  assert.match(fastfile, /details_for_app/);
  assert.match(fastfile, /apple-ios-identifier\.json/);
  assert.doesNotMatch(fastfile, /Produce::ItunesConnect\.(?:new|run)|upload_to_app_store/);
  assert.doesNotMatch(fastfile, /delete_app!|update_app_name!/);
  assert.match(fastfile, /lane :ensure_signing_certificates/);
  assert.match(fastfile, /lane :ensure_provisioning_profiles/);
  assert.match(fastfile, /cert_id:\s*certificate\.fetch\("resourceId"\)/);
});
