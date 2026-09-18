'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n?/g, '\n');
const debug = read('skills/debug-app/SKILL.md');
const startup = read('skills/debug-app/references/startup-diagnostics.md');
const create = read('skills/create-mobile-app/SKILL.md');

function section(content, from, to) {
  const start = content.indexOf(from);
  const end = content.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `Missing section ${from} / ${to}`);
  return content.slice(start, end);
}

test('startup diagnosis is discoverable and does not require installed dependencies or a live app', () => {
  const frontmatter = debug.split('---')[1];
  assert.match(frontmatter, /install\/startup failures/);
  assert.match(frontmatter, /QR\/device-opening problems even before an app is loaded/);
  assert.doesNotMatch(debug, /Run AFTER the app is loaded|Run only after the app is loaded/);
  assert.match(debug, /`\/debug-app startup/);
  assert.match(startup, /missing `node_modules`, Metro config, generated files/);
  assert.match(startup, /findings, not reasons to refuse diagnosis/);
  assert.match(debug, /targeted compatibility inspection below instead of\nthe shared blanket version check/);
});

test('healthy runtime sessions and read-only subcommands bypass setup mutations', () => {
  const dispatch = section(debug, '### 0.setup', '### 0.preflight');
  assert.match(dispatch, /healthy live app with a runtime symptom, skip setup/);
  assert.match(dispatch, /not merely a mismatched port\/platform/);
  assert.match(dispatch, /state initialization \(0\.1\) before\nPhase 0\.2/);
  assert.match(dispatch, /Record `startupOutcome`/);
  assert.match(dispatch, /no native app is connected, report runtime\nverification pending/);
  const early = section(debug, '**Early-return subcommands:**', '**Tip');
  assert.match(early, /`status`[\s\S]*execute only Phase 0\.0 discovery/);
  assert.match(early, /Do not run project preflight/);
  assert.match(early, /Never stop Metro/);
  assert.match(startup, /`--no-fix`[\s\S]*cannot install, edit, start\/stop\/restart Metro/);
  assert.match(startup, /`status` writes no state/);
  assert.match(startup, /direct `\/debug-app` request already asks for diagnosis/);
  assert.match(startup, /failure in an unshared terminal cannot\nwake an idle agent/);
});

test('inspection classifies installation and compatibility before assuming a package defect', () => {
  for (const category of ['Broken installation', 'Node/dependency compatibility',
    'Install access/network failure', 'Metro/pre-start failure',
    'Device connectivity / QR opening', 'Native compatibility', 'App defect / potential package defect']) {
    assert.ok(startup.includes(`| ${category} |`));
  }
  assert.match(startup, /correctly installed package is not automatically a broken install/);
  assert.match(startup, /direct-declarations-match[\s\S]*not proof the full lockfile is valid/);
  assert.match(startup, /A package stack frame, export-resolution failure, or two failed attempts alone is insufficient proof/);
  assert.match(startup, /Do not route ordinary setup failures directly to `\/report-issue`/);
});

test('locked restoration is approved and cannot become an upgrade or a lockfile rewrite', () => {
  const restore = section(startup, '## S3.', '## S4.');
  assert.match(restore, /Dependency \*\*upgrades belong to a separate upgrade workflow\*\*/);
  assert.match(restore, /Do not silently invoke `\/check-updates`/);
  assert.match(restore, /lock is missing, malformed, inconsistent, or unsupported/);
  assert.match(restore, /compatible active Node\/npm toolchain/);
  assert.match(restore, /Do not delete\/regenerate\nthe lock/);
  assert.match(restore, /Restore locked dependencies/);
  assert.match(restore, /On explicit\napproval, record hashes/);
  assert.match(restore, /npm ci --ignore-scripts --no-audit --no-fund/);
  assert.match(restore, /obtain explicit approval for those before running/);
  assert.match(restore, /Verify manifest and lock hashes are unchanged/);
  assert.match(startup, /silence, cancellation, dismissal, a recommendation, or consent to create the app\nis not consent/);
});

test('README recommends diagnosis before reporting without blocking explicit issue requests', () => {
  const readme = read('README.md');
  assert.match(readme, /try `\/debug-app` before reporting an issue/);
  assert.match(readme, /\/debug-app startup "npm run dev fails/);
  assert.match(readme, /use `\/report-issue` with the sanitized/);
  assert.match(readme, /not a barrier to an explicit issue-report/);
});

test('startup retries preserve process ownership and require actual device evidence', () => {
  const retry = section(startup, '## S4.', '## S5.');
  assert.match(retry, /Keep installation approval separate from process control/);
  assert.match(retry, /canonical `npm run dev`/);
  assert.match(retry, /never reuse|do not reuse the dead session's cursor/i);
  assert.match(retry, /current native bundle\/log evidence and user confirmation/);
  assert.match(retry, /At most one locked restore[\s\S]*two evidence-driven startup retries/);
  assert.match(retry, /include prior caller attempts/);
  assert.match(startup, /Never kill by process name or reuse a stale PID/);
  assert.match(startup, /Never use browser runtime tests or direct Metro HTTP probes/);
});

test('installation success without symptom verification cannot yield a healthy result', () => {
  const results = startup.slice(startup.indexOf('## S5.'));
  assert.match(results, /\| `verification-pending` \|/);
  assert.match(results, /Do not report the app fixed or enter a green clean-cycle exit/);
  assert.match(results, /return\nto `\/create-mobile-app` instead of starting a long runtime monitor/);
  assert.match(debug, /pending\/blocked\/cancelled returns without a green runtime result/);
  assert.match(startup, /Do not block creation waiting for a device/);
  assert.match(startup, /reported QR\/opening failure, in contrast, stays pending/);
});

test('create shares one failure workflow and forwards the project, evidence, and attempt count', () => {
  const launch = section(create, '### Step 12 —', '### Step 12.5');
  assert.match(launch, /Diagnose startup/);
  assert.match(launch, /Do not start a separate repair\/reinstall\/restart loop/);
  assert.match(launch, /Invoke skill: \/debug-app/);
  assert.match(launch, /startup "<original sanitized startup symptom>"/);
  assert.match(launch, /--working-dir "<working_dir>"/);
  assert.match(launch, /failed_command: npm run dev/);
  assert.match(launch, /startup_attempts:/);
  assert.match(launch, /return_to_caller: true/);
  assert.match(launch, /Creation approval is not dependency-restoration or restart\napproval/);
  assert.match(launch, /child returns without the runtime monitor/);
});

test('sensitive startup evidence and older-project instruction adoption stay opt-in', () => {
  assert.match(startup, /Never require a terminal ID/);
  assert.match(startup, /Do not persist raw installation output/);
  assert.match(startup, /scripts\/redact-debug-diagnostic\.js/);
  assert.match(startup, /Optional guidance adoption for older apps is separate from repair/);
  assert.match(startup, /preserve all existing customer instruction bytes/);
  assert.match(startup, /Never run\nfresh-template preparation on a generated app/);
  assert.match(startup, /Host\/MSAL source|preserve host\/MSAL source/i);
});
