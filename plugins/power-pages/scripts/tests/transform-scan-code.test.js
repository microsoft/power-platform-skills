const test = require('node:test');
const assert = require('node:assert/strict');

const {
  transformOpengrep,
  transformTrivy,
} = require('../../skills/scan-code/scripts/transform-scan-code');

// --- transformOpengrep ---------------------------------------------------

test('transformOpengrep groups occurrences by check_id into one finding per rule', () => {
  const raw = {
    results: [
      {
        check_id: 'rule.sqli',
        path: '/proj/a.js',
        start: { line: 5 },
        extra: {
          severity: 'ERROR',
          message: 'SQL injection',
          metadata: { category: 'security', confidence: 'HIGH', vulnerability_class: ['SQL Injection'], references: ['https://x'] },
        },
      },
      {
        check_id: 'rule.sqli',
        path: '/proj/b.js',
        start: { line: 9 },
        extra: { severity: 'ERROR', message: 'SQL injection', metadata: { category: 'security', references: [] } },
      },
    ],
  };

  const findings = transformOpengrep(raw, '/proj');
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.severity, 'critical');
  assert.equal(f.category, 'security');
  assert.equal(f.confidence, 'HIGH');
  assert.equal(f.title, 'SQL Injection');
  assert.equal(f.tag, 'rule.sqli');
  assert.equal(f.location, 'a.js:5');
  assert.match(f.details, /2 occurrences/);
  assert.match(f.details, /References:/);
});

test('transformOpengrep maps WARNING and INFO severities', () => {
  const mk = (sev) => ({
    results: [{ check_id: 'r', path: '/p/x.js', start: { line: 1 }, extra: { severity: sev, message: 'm', metadata: {} } }],
  });
  assert.equal(transformOpengrep(mk('WARNING'), '/p')[0].severity, 'warning');
  assert.equal(transformOpengrep(mk('INFO'), '/p')[0].severity, 'info');
});

test('transformOpengrep returns [] when results is missing (empty "{}" fallback)', () => {
  assert.deepEqual(transformOpengrep({}, '/proj'), []);
  assert.deepEqual(transformOpengrep({ results: null }, '/proj'), []);
});

test('transformOpengrep does not throw when a rule omits references/metadata', () => {
  const raw = {
    results: [
      { check_id: 'r1', path: '/p/a.js', start: { line: 2 }, extra: { severity: 'WARNING', message: 'm', metadata: { category: 'best-practice' } } },
      { check_id: 'r2', path: '/p/b.js', start: { line: 3 }, extra: { severity: 'INFO', message: 'm' } },
    ],
  };
  const findings = transformOpengrep(raw, '/p');
  assert.equal(findings.length, 2);
  assert.doesNotMatch(findings[0].details, /References:/);
  assert.equal(findings[1].title, 'r2');
});

test('transformOpengrep relativize uses a path boundary, not a bare prefix', () => {
  const raw = {
    results: [
      { check_id: 'r', path: '/repo/app/src/x.js', start: { line: 1 }, extra: { severity: 'ERROR', message: 'm', metadata: {} } },
      { check_id: 'r2', path: '/repo/app2/y.js', start: { line: 1 }, extra: { severity: 'ERROR', message: 'm', metadata: {} } },
    ],
  };
  const findings = transformOpengrep(raw, '/repo/app');
  const byTag = Object.fromEntries(findings.map((f) => [f.tag, f.location]));
  assert.equal(byTag.r, 'src/x.js:1');
  assert.equal(byTag.r2, '/repo/app2/y.js:1'); // sibling prefix stays absolute
});

// --- transformTrivy ------------------------------------------------------

test('transformTrivy maps vulnerabilities, secrets, and licenses', () => {
  const raw = {
    Results: [
      {
        Target: '/proj/package-lock.json',
        Vulnerabilities: [
          { VulnerabilityID: 'CVE-1', PkgName: 'lodash', InstalledVersion: '1.0.0', FixedVersion: '1.0.1', Severity: 'HIGH', Title: 'Proto pollution' },
        ],
      },
      {
        Target: '/proj/.env',
        Secrets: [{ RuleID: 'aws-key', Category: 'AWS', Severity: 'CRITICAL', Title: 'AWS key', StartLine: 3 }],
      },
      {
        Target: '/proj',
        Licenses: [{ Severity: 'MEDIUM', Category: 'restricted', PkgName: 'pkg', FilePath: '/proj/LICENSE', Name: 'GPL-3.0' }],
      },
    ],
  };
  const findings = transformTrivy(raw, '/proj');
  assert.equal(findings.length, 3);

  const vuln = findings.find((f) => f.category === 'vulnerability');
  assert.equal(vuln.severity, 'high');
  assert.equal(vuln.tag, 'CVE-1');
  assert.equal(vuln.location, 'package-lock.json');
  assert.match(vuln.fix, /Upgrade lodash to 1\.0\.1/);

  const secret = findings.find((f) => f.category === 'secret');
  assert.equal(secret.severity, 'critical');
  assert.equal(secret.location, '.env:3');
  assert.match(secret.fix, /rotate/i);

  const license = findings.find((f) => f.category === 'license');
  assert.equal(license.severity, 'medium');
  assert.equal(license.tag, 'GPL-3.0');
});

test('transformTrivy omits the fix hint for a vulnerability with no FixedVersion', () => {
  const raw = {
    Results: [
      { Target: 't', Vulnerabilities: [{ VulnerabilityID: 'CVE-2', PkgName: 'p', InstalledVersion: '1', Severity: 'LOW', Title: 'x' }] },
    ],
  };
  const f = transformTrivy(raw, null)[0];
  assert.equal(f.severity, 'low');
  assert.equal(f.fix, null);
});

test('transformTrivy returns [] when Results is missing (empty "{}" fallback)', () => {
  assert.deepEqual(transformTrivy({}, '/proj'), []);
  assert.deepEqual(transformTrivy({ Results: null }, '/proj'), []);
});
