const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'render-auth-report.js');

const SAMPLE_DATA = {
  META_DATA: {
    siteName: 'Contoso Portal',
    reportDate: '2026-05-27',
    framework: 'React',
    nextStepsHtml: '<ol><li>Deploy with <code>pac pages upload-code-site</code>.</li></ol>',
  },
  PROVIDERS_DATA: [
    {
      type: 'External',
      displayName: 'Entra External ID',
      name: 'EntraExternal',
      identifier: 'https://contoso.ciamlogin.com/...',
      authority: 'https://contoso.ciamlogin.com/tenant-id',
      clientId: 'abc-123',
      redirectUri: 'https://contoso.powerappsportals.com/signin-EntraExternal',
      scopes: 'openid profile email',
      registrationClaimsMapping: 'firstname=given_name,lastname=family_name,emailaddress1=email',
      loginClaimsMapping: null,
      contactLinking: 'Link to existing contact by email',
      profileSync: 'First sign-in only',
      federatedLogout: 'Disabled',
      isPrimary: true,
    },
  ],
  LOCAL_AUTH_DATA: null,
  OPTIONAL_FEATURES_DATA: {
    profilePage: true,
    termsAndConditions: true,
    termsEnforced: false,
    federatedLogout: false,
    sessionKeepAlive: true,
  },
  SITE_SETTINGS_DATA: [
    { name: 'Authentication/Registration/ProfileRedirectEnabled', value: 'false' },
    { name: 'Webapi/contact/enabled', value: 'true' },
  ],
  TABLE_PERMISSIONS_DATA: [
    {
      name: 'My Profile - Edit Own Contact',
      table: 'contact',
      scope: 'Self (756150004)',
      read: true,
      write: true,
      create: false,
      delete: false,
    },
  ],
  FILES_DATA: [
    { path: 'src/pages/UserProfile.tsx', action: 'Created', notes: '' },
    { path: 'src/components/AuthButton.tsx', action: 'Updated', notes: 'Evolved to dropdown shape' },
  ],
};

test('render-auth-report renders HTML from --data file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-report-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'auth-report.html');

  fs.writeFileSync(dataPath, JSON.stringify(SAMPLE_DATA, null, 2), 'utf8');

  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(fs.existsSync(outputPath));

  const html = fs.readFileSync(outputPath, 'utf8');

  // Title in HTML <title> is set by inline JS, so just confirm SITE_NAME made it in
  assert.match(html, /Contoso Portal/);
  // Provider details
  assert.match(html, /Entra External ID/);
  assert.match(html, /firstname=given_name/);
  // Site settings
  assert.match(html, /ProfileRedirectEnabled/);
  // Table permissions
  assert.match(html, /My Profile - Edit Own Contact/);
  assert.match(html, /Self \(756150004\)/);
  // Files table
  assert.match(html, /UserProfile\.tsx/);
  assert.match(html, /AuthButton\.tsx/);
  // Standard AI-generated footer matches the convention used by other reports
  assert.match(html, /AI-generated content may be incorrect/);
  // Vertical tabs structure
  assert.match(html, /data-tab="overview"/);
  assert.match(html, /data-tab="next-steps"/);
});

test('render-auth-report fails with no arguments', () => {
  const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:/);
});

test('render-auth-report fails when --data file is missing a required key', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-report-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'auth-report.html');

  // Omit META_DATA so the renderTemplate helper reports it as missing
  const broken = Object.assign({}, SAMPLE_DATA);
  delete broken.META_DATA;
  fs.writeFileSync(dataPath, JSON.stringify(broken), 'utf8');

  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing required keys/);
  assert.match(result.stderr, /META_DATA/);
});

test('render-auth-report refuses to overwrite an existing output file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-report-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'auth-report.html');

  fs.writeFileSync(dataPath, JSON.stringify(SAMPLE_DATA), 'utf8');

  // First run succeeds
  const result1 = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });
  assert.equal(result1.status, 0, result1.stderr || result1.stdout);
  const original = fs.readFileSync(outputPath, 'utf8');

  // Second run with the same output path must fail without modifying the file
  const result2 = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });
  assert.equal(result2.status, 1);
  assert.match(result2.stderr, /Output file already exists/);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), original);
});

test('render-auth-report handles empty arrays and null LOCAL_AUTH_DATA cleanly', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-report-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'auth-report.html');

  const minimal = {
    META_DATA: {
      siteName: 'Empty Site',
      reportDate: '2026-05-27',
      framework: '',
      nextStepsHtml: '',
    },
    PROVIDERS_DATA: [],
    LOCAL_AUTH_DATA: null,
    OPTIONAL_FEATURES_DATA: {},
    SITE_SETTINGS_DATA: [],
    TABLE_PERMISSIONS_DATA: [],
    FILES_DATA: [],
  };
  fs.writeFileSync(dataPath, JSON.stringify(minimal), 'utf8');

  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const html = fs.readFileSync(outputPath, 'utf8');
  assert.match(html, /Empty Site/);
  // No unreplaced template placeholders in the output
  assert.doesNotMatch(html, /__[A-Z][A-Z0-9_]+__/);
});
