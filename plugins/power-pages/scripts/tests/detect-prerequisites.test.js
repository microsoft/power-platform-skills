const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildProbeInvocation,
  parsePacVersion,
  parseAzVersion,
  parseDotnetVersion,
  parseGitVersion,
  parseGhVersion,
  parseGhAuthStatus,
  parsePacAuthWho,
  parseAzAccountShow,
  compareVersions,
  latestStableVersion,
  buildActions,
  tenantMismatch,
} = require('../../skills/setup-prerequisites/scripts/detect-prerequisites');

// Captured from `pac help` on 1.51.1 — the version carries a `+<git-sha>` build
// suffix that must not leak into the comparison against NuGet's plain semver.
const PAC_HELP = `
Microsoft PowerPlatform CLI

Version: 1.51.1+g8a2ec33

Usage: pac [command] [options]
`;

// Captured from `pac auth who` on 2.9.3. Note the "Tenant Id" casing, and that
// the banner opens with a "Connected as" line before the label/value block.
const PAC_AUTH_WHO = `
Connected as user@contoso.com

Type:                       User
Cloud:                      Public
Tenant Id:                  72f988bf-86f1-41af-91ab-2d7cd011db47
Tenant Country:             IN
User:                       user@contoso.com
Environment Id:             11111111-1111-1111-1111-111111111111
Organization Friendly Name: Contoso Dev
`;

function statusFixture(overrides = {}) {
  return Object.assign(
    {
      node: { available: true, version: '22.11.0' },
      git: { available: true, version: '2.53.0' },
      dotnet: { available: true, version: '10.0.102' },
      pac: { available: true, version: '1.51.1', updateAvailable: false },
      az: { available: true, version: '2.77.0' },
      gh: { available: true, version: '2.96.0', optional: true },
      pacAuth: { signedIn: true, tenantId: 'tenant-a' },
      azAuth: { signedIn: true, tenantId: 'tenant-a' },
      ghAuth: { signedIn: true, account: 'octocat' },
    },
    overrides
  );
}

// The Azure CLI installs only `az.cmd` on Windows, which Node refuses to spawn
// directly, so every Windows probe goes through `cmd.exe /c`.
test('buildProbeInvocation routes Windows probes through cmd.exe', () => {
  assert.deepEqual(buildProbeInvocation('az', ['version', '-o', 'tsv'], 'win32'), {
    file: 'cmd.exe',
    args: ['/c', 'az', 'version', '-o', 'tsv'],
  });
});

test('buildProbeInvocation runs the command directly off Windows', () => {
  for (const platform of ['darwin', 'linux']) {
    assert.deepEqual(buildProbeInvocation('az', ['account', 'show'], platform), {
      file: 'az',
      args: ['account', 'show'],
    });
  }
});

test('parsePacVersion strips the build-metadata suffix', () => {  assert.equal(parsePacVersion(PAC_HELP), '1.51.1');
});

test('parsePacVersion returns null for missing or unparseable output', () => {
  assert.equal(parsePacVersion(null), null);
  assert.equal(parsePacVersion('command not found: pac'), null);
});

test('parseAzVersion reads the version from tsv output', () => {
  assert.equal(parseAzVersion('2.77.0\t2.77.0\t\t\n'), '2.77.0');
  assert.equal(parseAzVersion(null), null);
});

test('parseDotnetVersion handles stable and preview SDKs', () => {
  assert.equal(parseDotnetVersion('10.0.102\n'), '10.0.102');
  assert.equal(parseDotnetVersion('9.0.100-preview.1.24101.2\n'), '9.0.100-preview.1.24101.2');
  assert.equal(parseDotnetVersion(null), null);
});

test('parseGitVersion reads upstream and Apple-shipped builds', () => {
  assert.equal(parseGitVersion('git version 2.53.0\n'), '2.53.0');
  assert.equal(parseGitVersion('git version 2.39.5 (Apple Git-154)\n'), '2.39.5');
  assert.equal(parseGitVersion('git version 2.51.0.windows.1\n'), '2.51.0');
  assert.equal(parseGitVersion(null), null);
  assert.equal(parseGitVersion('command not found: git'), null);
});

test('parsePacAuthWho extracts tenant, user, and cloud', () => {
  const auth = parsePacAuthWho(PAC_AUTH_WHO);
  assert.equal(auth.signedIn, true);
  assert.equal(auth.tenantId, '72f988bf-86f1-41af-91ab-2d7cd011db47');
  assert.equal(auth.user, 'user@contoso.com');
  assert.equal(auth.cloud, 'Public');
});

test('parsePacAuthWho accepts the older "Tenant ID" casing', () => {
  const auth = parsePacAuthWho('Tenant ID: t-1\nUser: u@c.com');
  assert.equal(auth.tenantId, 't-1');
});

test('parsePacAuthWho reports signed out when no profile exists', () => {
  assert.deepEqual(parsePacAuthWho('No profiles were found on this computer.'), {
    signedIn: false,
    tenantId: null,
    user: null,
    cloud: null,
  });
  assert.equal(parsePacAuthWho(null).signedIn, false);
  assert.equal(parsePacAuthWho('some unrelated banner text').signedIn, false);
});

test('parseAzAccountShow extracts tenant, user, and subscription', () => {
  const account = parseAzAccountShow(
    JSON.stringify({ tenantId: 'tenant-a', user: { name: 'user@contoso.com' }, name: 'Pay-As-You-Go' })
  );
  assert.deepEqual(account, {
    signedIn: true,
    tenantId: 'tenant-a',
    user: 'user@contoso.com',
    subscription: 'Pay-As-You-Go',
  });
});

test('parseAzAccountShow treats a subscription-less account as signed in', () => {
  const account = parseAzAccountShow(JSON.stringify({ tenantId: 'tenant-a', user: { name: 'u@c.com' } }));
  assert.equal(account.signedIn, true);
  assert.equal(account.subscription, null);
});

test('parseAzAccountShow reports signed out for null, non-JSON, and empty payloads', () => {
  assert.equal(parseAzAccountShow(null).signedIn, false);
  assert.equal(parseAzAccountShow("Please run 'az login' to setup account.").signedIn, false);
  assert.equal(parseAzAccountShow('{}').signedIn, false);
  assert.equal(parseAzAccountShow('null').signedIn, false);
});

test('compareVersions orders versions and ignores prerelease suffixes', () => {
  assert.equal(compareVersions('1.51.1', '1.52.0'), 1);
  assert.equal(compareVersions('1.52.0', '1.51.1'), -1);
  assert.equal(compareVersions('1.51.1', '1.51.1'), 0);
  assert.equal(compareVersions('1.51.1-preview', '1.51.1'), 0);
  assert.equal(compareVersions('1.51', '1.51.0'), 0);
  assert.equal(compareVersions(null, '1.51.1'), 0);
});

test('latestStableVersion picks the last stable entry', () => {
  assert.equal(latestStableVersion(['1.50.1', '1.51.1', '1.52.1']), '1.52.1');
  assert.equal(latestStableVersion(['1.50.1', '1.52.0-preview']), '1.50.1');
  assert.equal(latestStableVersion([]), null);
  assert.equal(latestStableVersion(undefined), null);
});

test('parseGhVersion ignores the release URL on the second line', () => {
  const banner = 'gh version 2.96.0 (2026-07-02)\nhttps://github.com/cli/cli/releases/tag/v2.96.0\n';
  assert.equal(parseGhVersion(banner), '2.96.0');
  assert.equal(parseGhVersion(null), null);
  assert.equal(parseGhVersion('command not found: gh'), null);
});

// Captured from gh 2.96.0 with two hosts configured. The whole report goes to
// stderr, and gh exits 1 because the enterprise host is broken — even though
// github.com is authenticated. Reading this as "signed out" was a real bug.
const GH_AUTH_MULTI_HOST = `github.com
  ✓ Logged in to github.com account octocat (GH_TOKEN)
  - Active account: true
  - Token scopes: 'gist', 'repo', 'workflow'

contoso.ghe.com
  X Failed to log in to contoso.ghe.com using token (GH_TOKEN)
  - Active account: true
  - The token in GH_TOKEN is invalid.
`;

test('parseGhAuthStatus reads a signed-in account', () => {
  assert.deepEqual(parseGhAuthStatus('  ✓ Logged in to github.com account octocat (keyring)\n'), {
    signedIn: true,
    account: 'octocat',
  });
});

test('parseGhAuthStatus prefers github.com when several hosts are configured', () => {
  assert.deepEqual(parseGhAuthStatus(GH_AUTH_MULTI_HOST), { signedIn: true, account: 'octocat' });
});

// The inverse of the capture above: an enterprise host works, github.com does
// not. /report-issue files against github.com, so this must read as signed out
// rather than deferring the failure to `gh issue create`.
test('parseGhAuthStatus does not accept an enterprise-only login', () => {
  const enterpriseOnly = `github.com
  X Failed to log in to github.com account octocat (GH_TOKEN)
  - The token in GH_TOKEN is invalid.

contoso.ghe.com
  ✓ Logged in to contoso.ghe.com account alice (keyring)
  - Active account: true
`;
  assert.deepEqual(parseGhAuthStatus(enterpriseOnly), { signedIn: false, account: null });
});

test('parseGhAuthStatus does not read a failed host as signed in', () => {
  const failedOnly = `contoso.ghe.com
  X Failed to log in to contoso.ghe.com using token (GH_TOKEN)
  - The token in GH_TOKEN is invalid.
`;
  assert.deepEqual(parseGhAuthStatus(failedOnly), { signedIn: false, account: null });
});

test('parseGhAuthStatus accepts the older "as <account>" phrasing', () => {
  assert.deepEqual(parseGhAuthStatus('✓ Logged in to github.com as octocat (oauth_token)'), {
    signedIn: true,
    account: 'octocat',
  });
});

test('parseGhAuthStatus reports signed out for null and the empty-hosts message', () => {
  assert.deepEqual(parseGhAuthStatus(null), { signedIn: false, account: null });
  assert.deepEqual(parseGhAuthStatus('You are not logged into any GitHub hosts.'), {
    signedIn: false,
    account: null,
  });
});

test('buildActions is empty when everything is present and signed in', () => {
  assert.deepEqual(buildActions(statusFixture()), []);
});

test('buildActions reports one install per missing tool', () => {
  const actions = buildActions(
    statusFixture({
      git: { available: false, version: null },
      dotnet: { available: false, version: null },
      az: { available: false, version: null },
      azAuth: { signedIn: false, tenantId: null },
    })
  );
  assert.deepEqual(actions, [
    { tool: 'git', kind: 'install' },
    { tool: 'dotnet', kind: 'install' },
    { tool: 'az', kind: 'install' },
  ]);
});

test('buildActions does not ask a missing CLI to sign in', () => {
  const actions = buildActions(
    statusFixture({
      pac: { available: false, version: null, updateAvailable: false },
      pacAuth: { signedIn: false, tenantId: null },
    })
  );
  assert.deepEqual(actions, [{ tool: 'pac', kind: 'install' }]);
});

test('buildActions offers a pac update only when pac is installed', () => {
  const actions = buildActions(
    statusFixture({ pac: { available: true, version: '1.50.1', updateAvailable: true } })
  );
  assert.deepEqual(actions, [{ tool: 'pac', kind: 'update' }]);
});

test('buildActions asks a signed-out but installed CLI to sign in', () => {
  const actions = buildActions(statusFixture({ azAuth: { signedIn: false, tenantId: null } }));
  assert.deepEqual(actions, [{ tool: 'az', kind: 'signin' }]);
});

test('tenantMismatch flags differing tenants', () => {
  const mismatch = tenantMismatch(
    { signedIn: true, tenantId: 'tenant-a' },
    { signedIn: true, tenantId: 'tenant-b' }
  );
  assert.deepEqual(mismatch, { pacTenantId: 'tenant-a', azTenantId: 'tenant-b' });
});

test('tenantMismatch ignores casing differences', () => {
  assert.equal(
    tenantMismatch({ signedIn: true, tenantId: 'TENANT-A' }, { signedIn: true, tenantId: 'tenant-a' }),
    null
  );
});

test('tenantMismatch stays silent when either side is signed out or unknown', () => {
  assert.equal(tenantMismatch({ signedIn: false }, { signedIn: true, tenantId: 'tenant-b' }), null);
  assert.equal(
    tenantMismatch({ signedIn: true, tenantId: null }, { signedIn: true, tenantId: 'tenant-b' }),
    null
  );
});

// The GitHub CLI backs exactly one skill (/report-issue), so it is offered but
// never withholds the ready verdict.
test('buildActions marks GitHub CLI install and sign-in as optional', () => {
  const missing = buildActions(
    statusFixture({ gh: { available: false, version: null, optional: true } })
  );
  assert.deepEqual(missing, [{ tool: 'gh', kind: 'install', optional: true }]);

  const signedOut = buildActions(statusFixture({ ghAuth: { signedIn: false, account: null } }));
  assert.deepEqual(signedOut, [{ tool: 'gh', kind: 'signin', optional: true }]);
});

test('buildActions does not ask a missing GitHub CLI to sign in', () => {
  const actions = buildActions(
    statusFixture({
      gh: { available: false, version: null, optional: true },
      ghAuth: { signedIn: false, account: null },
    })
  );
  assert.deepEqual(actions, [{ tool: 'gh', kind: 'install', optional: true }]);
});

test('required actions are never marked optional', () => {
  const actions = buildActions(
    statusFixture({
      git: { available: false, version: null },
      pac: { available: true, version: '1.50.1', updateAvailable: true },
      azAuth: { signedIn: false, tenantId: null },
    })
  );
  assert.ok(actions.length > 0);
  for (const action of actions) assert.equal(action.optional, undefined);
});
