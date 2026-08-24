'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateContract } = require('../validate-apple-ios-provisioning');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const LIB = path.join(
  PLUGIN_ROOT,
  'assets/apple-fastlane/fastlane/lib/apple_profiles.rb',
);
const FIXTURES = path.join(__dirname, 'fixtures', 'apple-profiles');
const WORK = path.join(__dirname, '.apple-fastlane-profiles-work');
const TEAM = 'A1B2C3D4E5';
const BUNDLE = 'com.contoso.fieldapp';
const NOW = '2026-08-21T06:00:00Z';
const DEVELOPMENT_ID = 'apple-development-resource';
const DISTRIBUTION_ID = 'apple-distribution-resource';

test.afterEach(() => fs.rmSync(WORK, { recursive: true, force: true }));

function plist(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.plist.json`), 'utf8'));
}

function prerequisiteFiles() {
  fs.mkdirSync(WORK, { recursive: true });
  const identifier = {
    version: 1,
    status: 'ready',
    mode: 'developer-portal-only',
    teamId: TEAM,
    bundleId: BUNDLE,
    identifier: {
      resourceId: 'identifier-resource',
      platform: 'ios',
      type: 'explicit',
      action: 'reused',
      proof: 'exact-identifier-readback',
    },
    pushCapability: {
      capability: 'aps-environment',
      enabled: true,
      action: 'reused',
      proof: 'app-id-capability-readback',
    },
    proof: {
      verifiedAt: '2026-08-21T05:30:00Z',
      validUntil: '2026-08-21T06:30:00Z',
    },
  };
  const certificates = {
    version: 1,
    status: 'ready',
    teamId: TEAM,
    certificates: [
      {
        resourceId: DEVELOPMENT_ID,
        type: 'apple-development',
        expiresAt: '2027-08-21T06:00:00Z',
        proof: 'dedicated-keychain-code-signing-identity',
      },
      {
        resourceId: DISTRIBUTION_ID,
        type: 'apple-distribution',
        expiresAt: '2027-08-21T06:00:00Z',
        proof: 'dedicated-keychain-code-signing-identity',
      },
    ],
    proof: {
      verifiedAt: '2026-08-21T05:30:00Z',
      validUntil: '2026-08-21T06:30:00Z',
    },
  };
  const identifierPath = path.join(WORK, 'apple-ios-identifier.json');
  const certificatesPath = path.join(WORK, 'apple-ios-certificates.json');
  fs.writeFileSync(identifierPath, JSON.stringify(identifier));
  fs.writeFileSync(certificatesPath, JSON.stringify(certificates));
  return { identifierPath, certificatesPath };
}

function rubyMetadata(plistValue, expectedType) {
  const source = [
    `require ${JSON.stringify(LIB)}`,
    `plist = JSON.parse(${JSON.stringify(JSON.stringify(plistValue))})`,
    'resolver = lambda do |value|',
    `  if value == "sanitized-development-certificate"`,
    `    { resource_id: ${JSON.stringify(DEVELOPMENT_ID)}, type: "apple-development" }`,
    '  elsif value == "sanitized-distribution-certificate"',
    `    { resource_id: ${JSON.stringify(DISTRIBUTION_ID)}, type: "apple-distribution" }`,
    '  end',
    'end',
    'begin',
    '  metadata = MobileAppAppleProfiles.metadata_from_plist(plist, certificate_resolver: resolver)',
    '  MobileAppAppleProfiles.verify_metadata!(',
    `    metadata, type: ${JSON.stringify(expectedType)}, team_id: ${JSON.stringify(TEAM)},`,
    `    bundle_id: ${JSON.stringify(BUNDLE)}, device_count: 2,`,
    `    certificate: { "resourceId" => ${JSON.stringify(expectedType === 'development' ? DEVELOPMENT_ID : DISTRIBUTION_ID)},`,
    `      "type" => ${JSON.stringify(expectedType === 'development' ? 'apple-development' : 'apple-distribution')} },`,
    '    device_digest: MobileAppAppleProfiles.device_digest(plist.fetch("ProvisionedDevices")),',
    `    now: Time.parse(${JSON.stringify(NOW)}))`,
    '  puts JSON.generate(metadata.transform_values { |value| value.is_a?(Time) ? value.iso8601 : value })',
    'rescue MobileAppAppleProfiles::Blocked => error',
    '  puts JSON.generate({ blocked: error.code })',
    '  exit 2',
    'end',
  ].join('\n');
  return spawnSync('ruby', ['-e', source], { encoding: 'utf8' });
}

function metadata(type, overrides = {}) {
  const development = type === 'development';
  return {
    uuid: development
      ? '11111111-2222-3333-4444-555555555555'
      : 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    name: `Sanitized ${type}`,
    team_id: TEAM,
    bundle_id: BUNDLE,
    application_identifier: `${TEAM}.${BUNDLE}`,
    entitlement_team_id: TEAM,
    expires_at: '2027-08-21T06:00:00Z',
    provisioned_device_count: 2,
    provisioned_device_digest: `sha256:${require('node:crypto').createHash('sha256')
      .update(['sanitized-device-1', 'sanitized-device-2'].map((value) => value.toUpperCase()).sort().join('\n'))
      .digest('hex')}`,
    get_task_allow: development,
    aps_environment: development ? 'development' : 'production',
    provisions_all_devices: false,
    beta_reports_active: false,
    certificate_resource_id: development ? DEVELOPMENT_ID : DISTRIBUTION_ID,
    certificate_type: development ? 'apple-development' : 'apple-distribution',
    ...overrides,
  };
}

function runProfiles(options = {}) {
  const { identifierPath, certificatesPath } = prerequisiteFiles();
  const output = path.join(WORK, 'apple-ios-provisioning.json');
  const profiles = options.profiles || {
    development: metadata('development'),
    'ad-hoc': metadata('ad-hoc'),
  };
  const source = [
    `require ${JSON.stringify(LIB)}`,
    'class MockAdapter',
    '  attr_reader :calls',
    '  def initialize(profiles, install_failure)',
    '    @profiles = profiles',
    '    @install_failure = install_failure',
    '    @calls = []',
    '  end',
    '  def inspect_state(team_id:, bundle_id:)',
    '    @calls << ["inspect", team_id, bundle_id]',
    `    { team_found: true, pending_agreements: false, profiles_readable: true,`,
    `      registered_device_count: ${options.registeredCount ?? 2}, enabled_device_count: ${options.enabledCount ?? 2},`,
    `      enabled_device_digest: @profiles.fetch("development").fetch("provisioned_device_digest") }`,
    '  end',
    '  def obtain_profile(team_id:, bundle_id:, type:, certificate:, force:)',
    '    @calls << ["obtain", type, force]',
    '    raw = @profiles.fetch(type)',
    '    value = raw.transform_keys(&:to_sym)',
    '    value[:expires_at] = Time.parse(value[:expires_at])',
    '    value[:provisioned_device_count] = 2 if force',
    '    { source_path: "sanitized-external-profile", metadata: value }',
    '  end',
    '  def install_profile(profile)',
    '    @calls << ["install", profile[:metadata][:uuid]]',
    '    raise MobileAppAppleProfiles::InstallFailed if @install_failure',
    '    profile[:metadata]',
    '  end',
    '  def cleanup!; @calls << ["cleanup"]; end',
    'end',
    `profiles = JSON.parse(${JSON.stringify(JSON.stringify(profiles))})`,
    `adapter = MockAdapter.new(profiles, ${options.installFailure ? 'true' : 'false'})`,
    'begin',
    '  result = MobileAppAppleProfiles.run(',
    `    team_id: ${JSON.stringify(TEAM)}, bundle_id: ${JSON.stringify(BUNDLE)},`,
    `    confirm: ${JSON.stringify(options.confirm || '')}, refresh: ${JSON.stringify(String(options.refresh || false))},`,
    `    devices_changed: ${JSON.stringify(String(options.devicesChanged || false))},`,
    `    keychain: { "serviceIdentifier" => "com.microsoft.mobile.apple", "pathFingerprint" => "sha256:${'a'.repeat(64)}" },`,
    `    identifier_path: ${JSON.stringify(identifierPath)}, certificates_path: ${JSON.stringify(certificatesPath)},`,
    `    output_path: ${JSON.stringify(output)}, adapter: adapter, now: Time.parse(${JSON.stringify(NOW)}))`,
    '  puts JSON.generate({ result: result, calls: adapter.calls })',
    'rescue MobileAppAppleProfiles::Blocked => error',
    '  puts JSON.generate({ blocked: error.code, details: error.details, calls: adapter.calls })',
    '  exit 2',
    'end',
  ].join('\n');
  return { output, result: spawnSync('ruby', ['-e', source], { encoding: 'utf8' }) };
}

test('sanitized plist fixtures parse without real profiles or certificate data', () => {
  for (const type of ['development', 'ad-hoc']) {
    const result = rubyMetadata(plist(type), type);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.provisioned_device_count, 2);
    assert.equal(parsed.bundle_id, BUNDLE);
    assert.doesNotMatch(result.stdout, /sanitized-device/);
    assert.doesNotMatch(result.stdout, /DeveloperCertificates|ProvisionedDevices/);
  }
});

test('reuses, installs, verifies, and emits the final safe contract only after all proofs', () => {
  const run = runProfiles();
  assert.equal(run.result.status, 0, run.result.stderr);
  const parsed = JSON.parse(run.result.stdout);
  assert.deepEqual(parsed.calls.map(([operation]) => operation), [
    'inspect', 'obtain', 'obtain', 'install', 'install', 'cleanup',
  ]);
  const contract = JSON.parse(fs.readFileSync(run.output, 'utf8'));
  assert.deepEqual(validateContract(contract, {
    expectedTeam: TEAM,
    expectedBundle: BUNDLE,
    now: new Date(NOW),
  }), []);
  assert.equal(contract.profiles.development.getTaskAllow, true);
  assert.equal(contract.profiles.adHoc.getTaskAllow, false);
  assert.equal(contract.profiles.development.certificateResourceId, DEVELOPMENT_ID);
  assert.equal(contract.profiles.adHoc.certificateResourceId, DISTRIBUTION_ID);
  assert.doesNotMatch(JSON.stringify(contract), /mobileprovision|sanitized-device|private|keychain-db/i);
});

test('stale device coverage requires exact count and narrow refresh confirmation', () => {
  const profiles = {
    development: metadata('development', { provisioned_device_count: 1 }),
    'ad-hoc': metadata('ad-hoc'),
  };
  const blocked = runProfiles({ profiles });
  assert.equal(blocked.result.status, 2);
  const proposal = JSON.parse(blocked.result.stdout);
  assert.equal(proposal.blocked, 'profile-refresh-confirmation-required');
  assert.deepEqual(proposal.details.scope, ['development']);
  assert.equal(proposal.details.device_count, 2);
  assert.equal(proposal.details.reasons.development, 'profile-device-coverage-stale');
  const token = `refresh-provisioning-profiles-${TEAM}-${BUNDLE}-2-development`;

  const refreshed = runProfiles({ profiles, confirm: token, refresh: true });
  assert.equal(refreshed.result.status, 0, refreshed.result.stderr);
  const calls = JSON.parse(refreshed.result.stdout).calls;
  assert.deepEqual(calls.filter(([operation, , force]) => operation === 'obtain' && force), [
    ['obtain', 'development', true],
  ]);
});

test('new devices explicitly refresh both profile scopes rather than broad force', () => {
  const token = `refresh-provisioning-profiles-${TEAM}-${BUNDLE}-2-development+ad-hoc`;
  const blocked = runProfiles({ devicesChanged: true });
  assert.equal(blocked.result.status, 2);
  assert.deepEqual(JSON.parse(blocked.result.stdout).details.scope, ['development', 'ad-hoc']);

  const refreshed = runProfiles({ devicesChanged: true, confirm: token, refresh: true });
  assert.equal(refreshed.result.status, 0, refreshed.result.stderr);
  const calls = JSON.parse(refreshed.result.stdout).calls;
  assert.deepEqual(calls.filter(([operation, , force]) => operation === 'obtain' && force), [
    ['obtain', 'development', true],
    ['obtain', 'ad-hoc', true],
  ]);
});

test('wrong identity, certificate, APNs mode, expiry, and missing enabled devices block safely', () => {
  const mutations = [
    ['team_id', 'Z9Y8X7W6V5'],
    ['bundle_id', 'com.contoso.other'],
    ['certificate_resource_id', 'wrong-resource'],
    ['aps_environment', 'production'],
    ['expires_at', '2026-08-21T06:30:00Z'],
  ];
  for (const [field, value] of mutations) {
    const result = rubyMetadata({
      ...plist('development'),
      ...(field === 'team_id' ? { TeamIdentifier: [value] } : {}),
      ...(field === 'bundle_id' ? {
        Entitlements: {
          ...plist('development').Entitlements,
          'application-identifier': `${TEAM}.${value}`,
        },
      } : {}),
      ...(field === 'aps_environment' ? {
        Entitlements: {
          ...plist('development').Entitlements,
          'aps-environment': value,
        },
      } : {}),
      ...(field === 'expires_at' ? { ExpirationDate: value } : {}),
      ...(field === 'certificate_resource_id'
        ? { DeveloperCertificates: ['sanitized-distribution-certificate'] }
        : {}),
    }, 'development');
    assert.equal(result.status, 2, field);
    assert.match(JSON.parse(result.stdout).blocked, /mismatch|expired/);
  }

  const disabled = runProfiles({ registeredCount: 3, enabledCount: 0 });
  assert.equal(disabled.result.status, 2);
  assert.equal(JSON.parse(disabled.result.stdout).blocked, 'registered-enabled-devices-required');
});

test('install failure emits no final provisioning contract', () => {
  const run = runProfiles({ installFailure: true });
  assert.equal(run.result.status, 2);
  assert.equal(JSON.parse(run.result.stdout).blocked, 'profile-install-failed');
  assert.equal(fs.existsSync(run.output), false);
});

test('Fastfile uses sigh safely, exact certificates, standard install location, and no project copy', () => {
  const fastfile = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'assets/apple-fastlane/fastlane/Fastfile'),
    'utf8',
  );
  assert.match(fastfile, /get_provisioning_profile\(\*\*parameters\)/);
  assert.match(fastfile, /app_identifier:\s*bundle_id/);
  assert.match(fastfile, /team_id:\s*team_id/);
  assert.match(fastfile, /cert_id:\s*certificate\.fetch\("resourceId"\)/);
  assert.match(fastfile, /readonly:\s*!force/);
  assert.match(fastfile, /force:\s*force/);
  assert.match(fastfile, /apple_profile_directory\.js/);
  assert.doesNotMatch(fastfile, /FileUtils\.cp.*project|\.\/.*mobileprovision/);
});

test('Fastfile loads and top-level profile adapter preserves selected Portal team', () => {
  const fastfile = path.join(PLUGIN_ROOT, 'assets/apple-fastlane/fastlane/Fastfile');
  const source = [
    'def default_platform(*); end',
    'def desc(*); end',
    '$lanes = {}',
    'def lane(name, &block); $lanes[name] = block; end',
    'module UI',
    '  def self.success(*); end',
    '  def self.user_error!(message); raise message; end',
    'end',
    'module Spaceship',
    '  module Portal',
    '    class Certificate',
    '      APPLE_CERTIFICATE_TYPE_IDS = {}',
    '    end',
    '  end',
    'end',
    `load ${JSON.stringify(fastfile)}`,
    'class FakePortal',
    '  attr_accessor :team_id',
    '  attr_reader :device_team',
    `  def teams; [{ "teamId" => ${JSON.stringify(TEAM)} }]; end`,
    '  def list_pending_agreements; []; end',
    '  def certificates(*, **); []; end',
    '  def devices(mac:, include_disabled:)',
    '    @device_team = @team_id',
    '    [{ "deviceNumber" => "sanitized-device", "devicePlatform" => "ios", "deviceClass" => "iphone", "status" => "c" }]',
    '  end',
    'end',
    'portal = FakePortal.new',
    '$portal = portal',
    'def authenticated_apple_portal; $portal; end',
    'module MobileAppAppleProfiles',
    '  def self.run(**args)',
    '    $lane_adapter = args.fetch(:adapter).class.name',
    `    { "teamId" => ${JSON.stringify(TEAM)}, "bundleId" => ${JSON.stringify(BUNDLE)}, "profiles" => {} }`,
    '  end',
    'end',
    '$stdin.define_singleton_method(:tty?) { true }',
    '$lanes.fetch(:ensure_provisioning_profiles).call({',
    `  team_id: ${JSON.stringify(TEAM)}, bundle_id: ${JSON.stringify(BUNDLE)},`,
    '  keychain_path: "sanitized", keychain_service_identifier: "service",',
    '  keychain_path_fingerprint: "sha256:' + 'a'.repeat(64) + '"',
    '})',
    'adapter = ApplePortalProfileAdapter.new(',
    '  keychain_path: "sanitized", profile_action: ->(_) {}, portal: portal, xcode_version: "Xcode 16.0"',
    ')',
    `state = adapter.inspect_state(team_id: ${JSON.stringify(TEAM)}, bundle_id: ${JSON.stringify(BUNDLE)})`,
    'directory = adapter.send(:provisioning_profiles_directory)',
    'puts JSON.generate({',
    '  lane_adapter: $lane_adapter, team: portal.team_id, device_team: portal.device_team,',
    '  count: state[:enabled_device_count], directory: directory',
    '})',
  ].join('\n');
  const result = spawnSync('ruby', ['-e', source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    lane_adapter: 'ApplePortalProfileAdapter',
    team: TEAM,
    device_team: TEAM,
    count: 1,
    directory: path.join(
      require('node:os').homedir(),
      'Library',
      'Developer',
      'Xcode',
      'UserData',
      'Provisioning Profiles',
    ),
  });
});
