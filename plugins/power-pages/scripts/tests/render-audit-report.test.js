const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'render-audit-report.js');
const validatorPath = path.join(__dirname, '..', '..', 'skills', 'audit-permissions', 'scripts', 'validate-audit.js');

const SAMPLE_DATA = {
  SITE_NAME: 'Contoso Portal',
  AUDIT_DESC: 'Security audit of table permissions for Contoso Portal',
  SUMMARY: 'One major issue: anonymous users can read staff contact details.',
  FINDINGS_DATA: [{
    id: 'AH1',
    severity: 'major',
    dimension: 'anonymous-access-hygiene',
    title: 'Staff contact details readable by Anonymous',
    table: 'contoso_staff',
    reasoning: 'Staff-Public-Read grants Anonymous Global read.',
    fix: 'Restrict the permission to a staff role.',
    rootCause: 'permissions',
    rootCauseReason: 'The anonymous Global read grant alone exposes the data.',
  }],
  INVENTORY_DATA: [{
    name: 'Staff - Public Read',
    table: 'contoso_staff',
    scope: 'Global',
    roles: ['Anonymous Users'],
    read: true,
    create: false,
    write: false,
    delete: false,
    append: false,
    appendto: false,
  }],
  SCORECARD_DATA: {
    categories: [
      { name: 'Over-Exposure (Security)', score: 4.21 },
      { name: 'Under-Exposure (Usability & Coverage)', score: 5 },
      { name: 'Correctness (Validity & Alignment)', score: 5 },
    ],
    reportPaths: [{ label: 'HTML report', path: 'docs/permissions-audit.html' }],
  },
};

function render(t, data) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-report-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const dataPath = path.join(tempDir, 'audit-data.json');
  const outputPath = path.join(tempDir, 'permissions-audit.html');
  fs.writeFileSync(dataPath, JSON.stringify(data), 'utf8');
  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], { encoding: 'utf8' });
  return { result, outputPath };
}

test('renders a report with a scorecard that passes validation', (t) => {
  const { result, outputPath } = render(t, SAMPLE_DATA);
  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(outputPath, 'utf8');
  assert.doesNotMatch(html, /__(?:JSON_)?SCORECARD_DATA__/);
  assert.match(html, /const SCORECARD = \{/);
  const validation = spawnSync(process.execPath, [validatorPath, '--report', outputPath], { encoding: 'utf8' });
  assert.equal(validation.status, 0, validation.stderr);
});

test('renders a null scorecard when scoring was skipped', (t) => {
  const { result, outputPath } = render(t, { ...SAMPLE_DATA, SCORECARD_DATA: null });
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(outputPath, 'utf8'), /const SCORECARD = null;/);
});

test('fails when SCORECARD_DATA is missing', (t) => {
  const { SCORECARD_DATA, ...withoutScorecard } = SAMPLE_DATA;
  const { result, outputPath } = render(t, withoutScorecard);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing required keys in data file: SCORECARD_DATA/);
  assert.equal(fs.existsSync(outputPath), false);
});
