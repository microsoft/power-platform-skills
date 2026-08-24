'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const LIB = path.join(
  PLUGIN_ROOT,
  'assets/apple-fastlane/fastlane/lib/apple_certificates.rb',
);
const WORK = path.join(__dirname, '.apple-fastlane-certificates-work');
const EXTERNAL = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'PowerPlatformSkills',
  'mobile-apps',
  'certificate-test-staging',
);
const TEAM = 'A1B2C3D4E5';
const CONFIRM = `ensure-signing-certificates-${TEAM}`;
const NOW = '2026-08-21T05:00:00Z';

test.afterEach(() => {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.rmSync(EXTERNAL, { recursive: true, force: true });
});

function certificate(type, expiresAt, overrides = {}) {
  return {
    resource_id: `${type}-resource`,
    type,
    expires_at: expiresAt,
    usable: true,
    ...overrides,
  };
}

function state(certificates) {
  return {
    team_found: true,
    pending_agreements: false,
    certificates_readable: true,
    certificates,
  };
}

function healthy() {
  return [
    certificate('apple-development', '2027-08-21T05:00:00Z'),
    certificate('apple-distribution', '2027-08-21T05:00:00Z'),
  ];
}

function runRuby(states, options = {}) {
  fs.mkdirSync(WORK, { recursive: true });
  const output = path.join(WORK, 'apple-ios-certificates.json');
  const source = [
    `require ${JSON.stringify(LIB)}`,
    'class MockAdapter',
    '  attr_reader :calls',
    '  def initialize(states, failure)',
    '    @states = states',
    '    @failure = failure',
    '    @calls = []',
    '  end',
    '  def inspect_state(team_id:)',
    '    @calls << ["inspect", team_id]',
    '    raw = @states.length > 1 ? @states.shift : @states.first',
    '    raw[:certificates].each { |cert| cert[:expires_at] = Time.parse(cert[:expires_at].to_s) }',
    '    raw',
    '  end',
    '  def create_certificate(team_id:, type:, renew:)',
    '    @calls << ["create", team_id, type, renew]',
    '    raise MobileAppAppleCertificates::QuotaExhausted if @failure == "quota"',
    '    raise MobileAppAppleCertificates::ImportFailed if @failure == "import"',
    '  end',
    'end',
    `states = JSON.parse(${JSON.stringify(JSON.stringify(states))}, symbolize_names: true)`,
    `adapter = MockAdapter.new(states, ${JSON.stringify(options.failure || '')})`,
    'begin',
    '  result = MobileAppAppleCertificates.run(',
    `    team_id: ${JSON.stringify(TEAM)}, confirm: ${JSON.stringify(options.confirm || '')},`,
    `    refresh: ${JSON.stringify(String(options.refresh || false))}, adapter: adapter,`,
    `    output_path: ${JSON.stringify(output)}, now: Time.parse(${JSON.stringify(NOW)}))`,
    '  puts JSON.generate({ result: result, calls: adapter.calls })',
    'rescue MobileAppAppleCertificates::Blocked => error',
    '  puts JSON.generate({ blocked: error.code, details: error.details, calls: adapter.calls })',
    '  exit 2',
    'end',
  ].join('\n');
  return { output, result: spawnSync('ruby', ['-e', source], { encoding: 'utf8' }) };
}

test('reuses valid modern identities in the dedicated keychain', () => {
  const run = runRuby([state(healthy())]);
  assert.equal(run.result.status, 0, run.result.stderr);
  const parsed = JSON.parse(run.result.stdout);
  assert.deepEqual(parsed.calls.map(([operation]) => operation), ['inspect', 'inspect']);
  assert.deepEqual(parsed.result.certificates.map(({ type, action }) => [type, action]), [
    ['apple-development', 'reused'],
    ['apple-distribution', 'reused'],
  ]);
  assert.deepEqual(
    Object.keys(parsed.result.certificates[0]),
    ['resourceId', 'type', 'expiresAt', 'action', 'proof'],
  );
});

test('missing identities require exact confirmation then create both without force or revoke', () => {
  const blocked = runRuby([state([])]);
  assert.equal(blocked.result.status, 2);
  const proposal = JSON.parse(blocked.result.stdout);
  assert.equal(proposal.blocked, 'mutation-confirmation-required');
  assert.equal(proposal.details.confirmation_token, CONFIRM);
  assert.deepEqual(proposal.details.mutations, [
    'create-apple-development',
    'create-apple-distribution',
  ]);

  const created = runRuby([state([]), state(healthy())], { confirm: CONFIRM });
  assert.equal(created.result.status, 0, created.result.stderr);
  assert.deepEqual(JSON.parse(created.result.stdout).calls.map(([operation]) => operation), [
    'inspect', 'create', 'create', 'inspect',
  ]);
  const fastfile = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'assets/apple-fastlane/fastlane/Fastfile'),
    'utf8',
  );
  assert.match(fastfile, /generate_apple_certs:\s*true/);
  assert.match(fastfile, /force:\s*renew/);
  assert.doesNotMatch(fastfile, /revoke_certificate|revoke_expired|delete!/);
  assert.deepEqual(
    JSON.parse(created.result.stdout).calls.filter(([operation]) => operation === 'create'),
    [
      ['create', TEAM, 'apple-development', false],
      ['create', TEAM, 'apple-distribution', false],
    ],
  );
});

test('near-expiry identity renews only its type inside the 30-day window', () => {
  const nearExpiry = healthy();
  nearExpiry[0].expires_at = '2026-09-01T05:00:00Z';
  const refreshed = healthy();
  const run = runRuby([state(nearExpiry), state(refreshed)], { confirm: CONFIRM });
  assert.equal(run.result.status, 0, run.result.stderr);
  const parsed = JSON.parse(run.result.stdout);
  assert.deepEqual(parsed.calls.filter(([operation]) => operation === 'create'), [
    ['create', TEAM, 'apple-development', true],
  ]);
  assert.equal(parsed.result.renewalWindowDays, 30);
});

test('Fastfile certificate adapter passes force only for confirmed renewal intent', () => {
  const fastfile = path.join(PLUGIN_ROOT, 'assets/apple-fastlane/fastlane/Fastfile');
  const source = [
    'def default_platform(*); end',
    'def desc(*); end',
    'def lane(*); end',
    `load ${JSON.stringify(fastfile)}`,
    'def with_sensitive_certificate_action_ui; yield; end',
    'calls = []',
    'adapter = ApplePortalCertificateAdapter.new(',
    '  keychain_path: "sanitized-keychain", portal: Object.new,',
    '  certificate_action: ->(parameters) { calls << parameters }',
    ')',
    `adapter.create_certificate(team_id: ${JSON.stringify(TEAM)}, type: "apple-development", renew: false)`,
    `adapter.create_certificate(team_id: ${JSON.stringify(TEAM)}, type: "apple-development", renew: true)`,
    'puts JSON.generate(calls.map { |entry| { force: entry[:force], team_id: entry[:team_id] } })',
  ].join('\n');
  const result = spawnSync('ruby', ['-e', source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    { force: false, team_id: TEAM },
    { force: true, team_id: TEAM },
  ]);
});

test('quota exhaustion stops for an Apple administrator decision', () => {
  const run = runRuby([state([])], { confirm: CONFIRM, failure: 'quota' });
  assert.equal(run.result.status, 2);
  assert.equal(
    JSON.parse(run.result.stdout).blocked,
    'certificate-quota-admin-decision-required',
  );
});

test('dedicated-keychain import failure blocks without a handoff', () => {
  const run = runRuby([state([])], { confirm: CONFIRM, failure: 'import' });
  assert.equal(run.result.status, 2);
  assert.equal(JSON.parse(run.result.stdout).blocked, 'dedicated-keychain-import-failed');
  assert.equal(fs.existsSync(run.output), false);
});

test('private external staging is mode 0700 and cleaned after success and failure', () => {
  const stagingRoot = EXTERNAL;
  fs.mkdirSync(stagingRoot, { recursive: true });
  const source = [
    `require ${JSON.stringify(LIB)}`,
    `root = ${JSON.stringify(stagingRoot)}`,
    'path = nil',
    'begin',
    '  MobileAppAppleCertificates.with_private_staging(root: root) do |directory|',
    '    path = directory',
    '    @mode = File.stat(directory).mode & 0o777',
    '    raise "expected" if ENV["FAIL"] == "1"',
    '  end',
    'rescue',
    'end',
    'puts JSON.generate({ path: path, exists: File.exist?(path), mode: @mode })',
  ].join('\n');
  for (const fail of ['0', '1']) {
    const result = spawnSync('ruby', ['-e', source], {
      encoding: 'utf8',
      env: { ...process.env, FAIL: fail },
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.exists, false);
    assert.equal(parsed.mode, 0o700);
    assert.equal(path.dirname(parsed.path), stagingRoot);
  }
});

test('Fastfile suppresses certificate action output and exposes only safe handoff fields', () => {
  const fastfile = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'assets/apple-fastlane/fastlane/Fastfile'),
    'utf8',
  );
  assert.match(fastfile, /with_sensitive_certificate_action_ui/);
  assert.match(fastfile, /keychain_path:\s*options\[:keychain_path\]/);
  assert.match(fastfile, /ensure_signing_certificates/);
  assert.doesNotMatch(fastfile, /UI\.(?:message|success).*find-identity/);

  const run = runRuby([state(healthy())]);
  const persisted = fs.readFileSync(run.output, 'utf8');
  assert.doesNotMatch(
    persisted,
    /certificate name|sha-?1|private.key|keychain.path|password|security find|codesign/i,
  );
});
