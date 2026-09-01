'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validate } = require('../validate-apple-fastlane-preflight');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const LIB = path.join(PLUGIN_ROOT, 'assets/apple-fastlane/fastlane/lib/apple_preflight.rb');
const WORK = path.join(__dirname, '.apple-fastlane-preflight-work');
const TEAM = 'A1B2C3D4E5';
const BUNDLE = 'com.contoso.fieldapp';
const NOW = new Date('2026-08-21T05:00:00.000Z');

test.afterEach(() => {
  fs.rmSync(WORK, { recursive: true, force: true });
});

function runRuby(observation, refresh = false) {
  fs.mkdirSync(WORK, { recursive: true });
  const output = path.join(WORK, 'apple-ios-preflight.json');
  const rubyObservation = `{ ${Object.entries(observation)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join(', ')} }`;
  const source = [
    `require ${JSON.stringify(LIB)}`,
    'class MockAdapter',
    `  def probe(team_id:, bundle_id:); ${rubyObservation}; end`,
    'end',
    'begin',
    '  result = MobileAppApplePreflight.run(',
    `    team_id: ${JSON.stringify(TEAM)}, bundle_id: ${JSON.stringify(BUNDLE)},`,
    `    refresh: ${JSON.stringify(String(refresh))}, adapter: MockAdapter.new,`,
    `    output_path: ${JSON.stringify(output)}, now: Time.utc(2026, 8, 21, 5, 0, 0))`,
    '  puts JSON.generate(result)',
    'rescue MobileAppApplePreflight::Blocked => error',
    '  puts JSON.generate({ blocked: error.code })',
    '  exit 2',
    'end',
  ].join('\n');
  return { output, result: spawnSync('ruby', ['-e', source], { encoding: 'utf8' }) };
}

const READY = {
  team_found: true,
  pending_agreements: false,
  identifiers_readable: true,
  certificates_readable: true,
  profiles_readable: true,
  identifier_present: true,
};

test('mocked Fastlane proof writes only safe exact identity and read access', () => {
  const { output, result } = runRuby(READY);
  assert.equal(result.status, 0, result.stderr);
  const document = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.deepEqual(validate(document, {
    expectedTeam: TEAM,
    expectedBundle: BUNDLE,
    now: NOW,
  }), []);
  assert.equal(document.identifier.status, 'present');
  assert.doesNotMatch(JSON.stringify(document), /@|password|session|cookie|2fa/i);
});

test('mocked missing identifier is a safe later-phase handoff, not a failure', () => {
  const { output, result } = runRuby({ ...READY, identifier_present: false });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).identifier.status, 'missing');
});

test('agreement parser ignores success metadata but blocks non-empty agreement payloads', () => {
  const source = [
    `require ${JSON.stringify(LIB)}`,
    'require "json"',
    'values = [',
    '  MobileAppApplePreflight.pending_agreements?({"resultCode" => 0, "success" => true, "pendingAgreements" => []}),',
    '  MobileAppApplePreflight.pending_agreements?({"agreements" => [{"status" => "PENDING"}]})',
    ']',
    'puts JSON.generate(values)',
  ].join('\n');
  const result = spawnSync('ruby', ['-e', source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [false, true]);
});

test('mocked agreement and permission failures block without a handoff', () => {
  let run = runRuby({ ...READY, pending_agreements: true });
  assert.equal(run.result.status, 2);
  assert.match(run.result.stdout, /"blocked":"agreements"/);
  assert.equal(fs.existsSync(run.output), false);

  run = runRuby({ ...READY, profiles_readable: false });
  assert.equal(run.result.status, 2);
  assert.match(run.result.stdout, /"blocked":"cip-permissions"/);
  assert.equal(fs.existsSync(run.output), false);
});

test('existing proof requires an explicit refresh path', () => {
  const first = runRuby(READY);
  assert.equal(first.result.status, 0, first.result.stderr);
  const second = runRuby(READY);
  assert.equal(second.result.status, 2);
  assert.match(second.result.stdout, /refresh-approval-required/);
  const refreshed = runRuby(READY, true);
  assert.equal(refreshed.result.status, 0, refreshed.result.stderr);
});

test('validator rejects mocked Fastlane output containing account identity or sessions', () => {
  const { output, result } = runRuby(READY);
  assert.equal(result.status, 0, result.stderr);
  const document = JSON.parse(fs.readFileSync(output, 'utf8'));
  document.authentication.email = ['account', 'example.invalid'].join('@');
  document.session = ['sensitive', 'value'].join('-');
  assert.deepEqual(validate(document, {
    expectedTeam: TEAM,
    expectedBundle: BUNDLE,
    now: NOW,
  }), ['sensitive-content-forbidden']);
});

test('skill eval inventory covers the preflight routes', () => {
  const evals = require(path.join(
    PLUGIN_ROOT,
    'skills/setup-apple-ios/evals/evals.json',
  ));
  assert.equal(evals.skill_name, 'setup-apple-ios');
  assert.deepEqual(
    evals.evals.map(({ id }) => id),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
  );
});

test('Fastfile keeps authentication interactive and profile setup guarded', () => {
  const fastfile = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'assets/apple-fastlane/fastlane/Fastfile'),
    'utf8',
  );
  assert.match(fastfile, /UI\.input\("Apple ID/);
  assert.match(fastfile, /UI\.password\("Apple password/);
  assert.match(fastfile, /portal\.login\(apple_id, apple_password\)/);
  assert.match(fastfile, /ApplePortalRuntime\.authenticated_portal/);
  assert.doesNotMatch(fastfile, /def authenticated_apple_portal/);
  assert.doesNotMatch(fastfile, /portal = authenticated_apple_portal/);
  assert.match(fastfile, /with_stage\("authentication-service"\)/);
  assert.match(fastfile, /ApplePortalRuntime\.with_stage\("identifiers-response-processing"\)/);
  assert.match(fastfile, /APPLE_PREFLIGHT_BLOCKED=#\{error\.code\}/);
  assert.match(fastfile, /safe_preflight_runtime_code\(error\)/);
  assert.match(fastfile, /when NoMethodError then "preflight-no-method"/);
  assert.match(fastfile, /ApplePortalRuntime\.safe_preflight_runtime_code\(error\)/);
  assert.match(fastfile, /def has_valid_session\s+false/m);
  assert.match(fastfile, /def store_cookie\(path: nil\)\s+true/m);
  assert.doesNotMatch(fastfile, /Tempfile|\/tmp/);
  assert.match(fastfile, /Logger\.new\(File::NULL\)/);
  assert.match(fastfile, /\$stdin\.tty\?/);
  assert.match(fastfile, /FASTLANE_SESSION/);
  assert.doesNotMatch(fastfile, /password:\s*options/);
  assert.match(fastfile, /lane :ensure_identifier_capabilities/);
  assert.match(fastfile, /UI\.password\("Device UDID/);
  assert.match(fastfile, /register_device\(name:/);
  assert.match(fastfile, /register_devices\(devices_file:/);
  assert.match(fastfile, /lane :register_apple_devices/);
  assert.match(fastfile, /MATCHED_COUNT=.*ENABLED=/);
  assert.doesNotMatch(fastfile, /udid:\s*options/);
  assert.match(fastfile, /lane :ensure_signing_certificates/);
  assert.match(fastfile, /lane :ensure_provisioning_profiles/);
  assert.match(fastfile, /get_provisioning_profile\(\*\*parameters\)/);
  assert.doesNotMatch(fastfile, /lane :verify_apple_provisioning/);
});
