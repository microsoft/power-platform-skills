'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(pluginRoot, file), 'utf8');
const entrySkills = ['add-native', 'deploy', 'edit-app', 'debug-app', 'report-issue'];
const nativeHelpers = ['add-camera', 'add-geolocation', 'add-pdf-report', 'add-pdf-viewer', 'add-pen-input'];
const agents = ['native-app-planner', 'screen-planner', 'screen-builder', 'data-model-architect', 'offline-profile-architect'];
const resolver = 'node "${PLUGIN_ROOT}/scripts/resolve-mobile-release.js" --project-root "<working_dir>"';

function codeBlock(source, marker) {
  const blocks = [...source.matchAll(/```(?:ts|typescript|tsx)\n([\s\S]*?)```/g)];
  const block = blocks.find((match) => match[1].includes(marker));
  assert.ok(block, `Missing example: ${marker}`);
  return block[1];
}

test('entry skills and native helpers resolve the existing app and share lifecycle policy', () => {
  const files = [
    ...entrySkills.map((skill) => `skills/${skill}/SKILL.md`),
    ...nativeHelpers.map((skill) => `skills/add-native/${skill}/SKILL.md`),
  ];
  for (const file of files) {
    const source = read(file);
    assert.ok(source.includes(resolver), `${file}: missing app-matched resolver`);
    assert.match(source, /mobile-release-lifecycle\.md/, file);
    assert.doesNotMatch(source, /\$\{PLUGIN_ROOT\}\/template\/package\.json/, file);
    assert.doesNotMatch(source, /Re-scaffold via \/create-mobile-app|adopt the current template's Metro config/, file);
  }
});

test('all planning and building agents receive the same release context, not plugin-native pins', () => {
  for (const agent of agents) {
    const source = read(`agents/${agent}.md`);
    assert.match(source, /mobile-release-lifecycle\.md/, agent);
    assert.match(source, /sanitized[\s\S]{0,100}resolved (?:release )?context/i, agent);
    assert.doesNotMatch(source, /\$\{PLUGIN_ROOT\}\/template\/package\.json/, agent);
  }
  const builder = read('agents/screen-builder.md');
  assert.match(builder, /missing wrapper is `BLOCKED`/);
  assert.doesNotMatch(builder, /TODO\(native-not-yet-added\)/);
  assert.match(builder, /source\/UI work may[\s\S]{0,120}unverified/);
  const planner = read('agents/native-app-planner.md');
  assert.match(planner, /`nativePackages`/);
  assert.match(planner, /`managedDependencies`/);
  assert.match(planner, /Do not collapse distinct nested package versions/);
  assert.match(planner, /requirements-only[\s\S]{0,90}cannot authorize native mutation/);
});

test('release links are valid local references from every owned surface', () => {
  const files = [
    ...entrySkills.map((skill) => `skills/${skill}/SKILL.md`),
    ...nativeHelpers.map((skill) => `skills/add-native/${skill}/SKILL.md`),
    ...agents.map((agent) => `agents/${agent}.md`),
    'skills/add-native/references/native-controls.md',
    'shared/version-check.md',
    'shared/references/javascript-dependency-planning.md',
  ];
  for (const file of files) {
    const source = read(file);
    for (const [, target] of source.matchAll(/\]\(([^)\s]*(?:mobile-release-lifecycle|native-controls)\.md)\)/g)) {
      assert.ok(fs.existsSync(path.resolve(pluginRoot, path.dirname(file), target)), `${file}: ${target}`);
    }
  }
});

test('deploy checks both actual intended base versions and fingerprints before build and every push', () => {
  const source = read('skills/deploy/SKILL.md');
  for (const platform of ['android', 'ios']) {
    assert.ok(source.includes(`${resolver} --platform ${platform} --base-version "<actual-intended-${platform}-base-version>" --base-fingerprint "<actual-intended-${platform}-base-fingerprint>"`));
  }
  assert.ok(source.indexOf('### Step 1.2') < source.indexOf('### Step 1.5'));
  assert.match(source, /Missing selection is a blocker/);
  assert.match(source, /version label alone does not[\s\S]{0,60}prove matching native runtime content/);
  assert.match(source, /missing or mismatched fingerprint blocks/);
  assert.match(source, /requirements-only[\s\S]{0,70}cannot authorize deployment/);
  assert.match(source, /Unknown\/missing release or base records[\s\S]{0,120}STOP/);
  assert.match(source, /no `deploy without compatibility` override/);
  assert.match(source, /Re-run Step 1\.2[\s\S]{0,160}fingerprints before this push/);
  assert.match(source, /Hermes magic bytes[\s\S]{0,180}compatibility/);
  assert.match(source, /not.*newest bundled template|never use the newest bundled template/);
});

test('deployment retains app-ID two-pass packaging, offline reconciliation, and user confirmation', () => {
  const source = read('skills/deploy/SKILL.md');
  assert.match(source, /two full build\+push cycles are required/);
  assert.match(source, /In cycle 2, `npm run build` \*and\* the Step 2\.4 native packaging commands must all re-run/);
  assert.match(source, /npm run bundle:android/);
  assert.match(source, /npm run bundle:ios/);
  assert.match(source, /c61fbc03/);
  assert.match(source, /powerapps-customer-assets-android\/manifest\.json/);
  assert.match(source, /powerapps-customer-assets-ios\/manifest\.json/);
  assert.match(source, /offline-profile-delta\.js/);
  assert.match(source, /exact phrase `deploy without offline`/);
  assert.match(source, /exact phrase `yes deploy to <env-name>`/);
  assert.match(source, /explicitly type `override`/);
  assert.match(source, /Do not proceed on a bare `y`/);
});

test('controls adoption is conditional and documents the public aggregate contract', () => {
  const source = read('skills/add-native/references/native-controls.md');
  assert.match(source, /root is metadata, not a runtime[\s\S]{0,20}barrel/);
  assert.match(source, /power-apps-native-controls\/pdf` \| `NativePdfViewer`/);
  assert.match(source, /power-apps-native-controls\/pen` \| `PenInputNative`, `PenInputStatus`, `PenInputErrorCode`/);
  assert.match(source, /power-apps-native-controls\/geolocation` \| `BgLocationClient`, `geoService`, `AuthMethod`, `ConnectionType`/);
  assert.match(source, /no barcode subpath/);
  for (const version of ['0.2.0', '0.2.9', '0.1.9', '0.2.3', '0.4.2', '0.83.6']) {
    assert.ok(source.includes(version), `Missing published controls fact: ${version}`);
  }
  assert.match(source, /Expo 55/);
  assert.match(source, /not evidence of Expo 57 compatibility/);
  assert.match(source, /Do not install the aggregate to[\s\S]{0,20}fix older binaries/);
  assert.match(source, /Legacy leaf imports are allowed only when the resolved release actually includes[\s\S]{0,50}matching leaf and version/);
  assert.match(source, /installed public README, exports, and types/);
});

test('control wrapper examples guard platforms before lazy literal subpath imports', () => {
  for (const [helper, marker, subpath] of [
    ['add-pdf-viewer', 'export async function openHttpsPdf', 'pdf'],
    ['add-pen-input', 'export async function captureSignature', 'pen'],
    ['add-geolocation', 'export async function getCurrentLocation', 'geolocation'],
  ]) {
    const source = read(`skills/add-native/${helper}/SKILL.md`);
    const example = codeBlock(source, marker);
    const guard = example.indexOf("Platform.OS !== 'ios' && Platform.OS !== 'android'");
    const lazyImport = example.indexOf(`await import('@microsoft/power-apps-native-controls/${subpath}')`);
    assert.ok(guard >= 0 && lazyImport > guard, `${helper}: native guard must precede import`);
    assert.ok(example.lastIndexOf('try {', lazyImport) > guard, `${helper}: import must be caught`);
    assert.doesNotMatch(example, /from ['"]@microsoft\/power-apps-native-/);
    assert.doesNotMatch(example, /import\(['"]@microsoft\/power-apps-native-controls['"]\)/);
    assert.match(source, /legacy/i);
    assert.match(source, /verified release|resolved release/);
  }
});

test('PDF and pen wrappers preserve useful failure and artifact boundaries', () => {
  const pdf = read('skills/add-native/add-pdf-viewer/SKILL.md');
  const pen = read('skills/add-native/add-pen-input/SKILL.md');
  const native = read('skills/add-native/SKILL.md');
  assert.match(pdf, /content:\/\/.*blob:.*http:\/\//);
  assert.match(pdf, /response\.error === 'NATIVE_MODULE_MISSING'/);
  assert.match(pen, /result\.error === PenInputErrorCode\.NativeModuleMissing/);
  assert.match(pen, /result\.error === PenInputErrorCode\.UserCancelled/);
  assert.match(pen, /PNG data URI/);
  assert.match(native, /Dataverse File\/Image columns use host controls/);
  assert.match(native, /Never put File column bytes in the create\/update JSON body/);
  assert.match(native, /Service\.upload|generated `upload\(\.\.\.\)`/);
});

test('one-shot location does not inherit tracking setup and shared tracking is explicit', () => {
  const source = read('skills/add-native/add-geolocation/SKILL.md');
  const oneShot = codeBlock(source, 'export async function getCurrentLocation');
  assert.match(oneShot, /new BgLocationClient\(\)\.getCurrentLocation\(\)/);
  assert.doesNotMatch(oneShot, /app_id|geoService|dataSource|startTracking|msdyn_locationrecords/);
  assert.match(source, /no `app_id`, data source, target table, or `startTracking`/);
  assert.match(source, /0\.2\.3[\s\S]{0,120}background permissions[\s\S]{0,70}trackInBackground: false/);
  assert.match(source, /Tracking is shared/);
  assert.match(source, /`stopTracking\(\)` and `isTracking\(\)` have no `app_id`/);
  assert.match(source, /unrelated screen's unmount/);
  assert.match(source, /tracking-only/);
  assert.match(source, /BLOCKED \(target table missing\)/);
  assert.match(source, /configureSync.*HttpSyncContract/);
  assert.match(source, /Do not replace native behavior[\s\S]{0,60}JS timers, upload loops/);
});

test('native registration and permission wrapping cannot become customer-side workarounds', () => {
  const source = read('skills/add-native/references/native-controls.md');
  assert.match(source, /enableNativeControls[\s\S]{0,200}verified host release/);
  assert.match(source, /0\.4\.0 lacks it/);
  assert.match(source, /Package inclusion/);
  assert.match(source, /OS declarations/);
  assert.match(source, /Runtime permission grants/);
  assert.match(source, /actually invokes a capability/);
  assert.match(source, /does[\s\S]{0,20}\*\*not\*\* remove unused default Android permissions/);
  assert.match(source, /Different declarations need another verified base/);
  assert.match(source, /permission wrapping is deferred/);
});

test('source-only editing and JS planning stay available without a native compatibility claim', () => {
  const edit = read('skills/edit-app/SKILL.md');
  const js = read('shared/references/javascript-dependency-planning.md');
  const version = read('shared/version-check.md');
  assert.match(edit, /block native mutations, not[\s\S]{0,60}pure source\/UI planning and editing/);
  assert.match(edit, /exact verified release/);
  assert.match(edit, /Release context: <sanitized resolved tuple/);
  assert.match(edit, /Approve and apply/);
  assert.match(edit, /--plan-only/);
  assert.match(js, /block native mutations, not pure source\/UI/);
  assert.match(js, /npm install --save-exact <package>@<exact-version>/);
  assert.doesNotMatch(js, /known-good version for the current template baseline/);
  assert.match(version, /immutable, prebuilt native runtime/);
  assert.match(version, /does not prebuild or compile new native code/);
  assert.match(version, /--base-fingerprint <fingerprint>/);
  assert.match(version, /Missing or[\s\S]{0,30}mismatched fingerprint blocks deployment/);
  assert.doesNotMatch(version, /Adding a native capability =|Pinned version|JSON\.stringify\(require\('\.\/app\.json'\)/);
});

test('debug and report surfaces preserve package ownership and sanitized evidence', () => {
  const debug = read('skills/debug-app/SKILL.md');
  const report = read('skills/report-issue/SKILL.md');
  assert.match(debug, /route verified-release migrations to `\/check-updates`/);
  assert.match(debug, /Never patch or fork first-party native packages/);
  assert.match(debug, /User consent to a dependency install does not waive this gate/);
  assert.match(report, /Reporting must still work|reporting must still work/);
  assert.match(report, /sanitized tuple/);
  assert.match(report, /--base-fingerprint <actual-intended-fingerprint>/);
  assert.match(report, /No raw app\/auth config/);
  assert.doesNotMatch(report, /console\.log\(JSON\.stringify\(\{env:|paste that output into the issue|include the full Metro\/Gradle\/Xcode log/);
  assert.match(report, /microsoft\/power-platform-skills\/issues\/new/);
});

test('all existing workflow telemetry checkpoint IDs remain unchanged', () => {
  const expected = {
    'add-native': ['resolve_native_capability', 'dispatch_native_capability', 'generate_native_wrapper', 'validate_native_wrapper'],
    deploy: ['build_power_apps_bundle', 'validate_offline_profile_coverage', 'push_app_to_power_platform'],
    'edit-app': ['assess_app_health_and_drift', 'analyze_edit_impact', 'revise_affected_app_plan', 'approve_app_mutation_plan', 'apply_app_mutations', 'rebuild_affected_screens', 'validate_edited_app', 'refresh_app_preview_and_history'],
    'debug-app': ['validate_metro_session', 'capture_runtime_baseline', 'collect_runtime_logs', 'classify_runtime_failures', 'confirm_runtime_health', 'repair_and_verify_runtime_issue'],
    'report-issue': ['capture_issue_description', 'collect_issue_diagnostics', 'render_issue_report', 'generate_issue_submission_url'],
  };
  for (const [skill, checkpoints] of Object.entries(expected)) {
    const source = read(`skills/${skill}/SKILL.md`);
    const actual = [...source.matchAll(/\*\*Telemetry checkpoint: `([^`]+)`\*\*/g)].map((match) => match[1]);
    assert.deepEqual(actual, checkpoints, skill);
    assert.match(source, /scripts\/check-version\.js/, `${skill}: startup notification`);
  }
});

test('explicit local diagnostics are consistently scoped without promoting production defaults', () => {
  for (const skill of ['create-mobile-app', 'check-updates', 'edit-app', 'add-native', 'deploy', 'debug-app', 'report-issue']) {
    assert.match(read(`skills/${skill}/SKILL.md`), /--diagnostic-artifacts/, skill);
  }
  for (const helper of nativeHelpers) {
    assert.match(read(`skills/add-native/${helper}/SKILL.md`), /--diagnostic-artifacts/, helper);
  }
  const policy = JSON.parse(read('shared/mobile-releases.json'));
  assert.deepEqual(policy, { schemaVersion: 1, defaultRelease: null, releases: [] });
  const lifecycle = read('shared/references/mobile-release-lifecycle.md');
  assert.match(lifecycle, /source manifest[\s\S]{0,120}not evidence of a matching binary/);
  assert.match(lifecycle, /actual APK/);
  assert.match(lifecycle, /--dry-run --diagnostic-artifacts/);
  assert.match(lifecycle, /run `--no-install` separately/);
  assert.doesNotMatch(lifecycle, /stage-diagnostic/);
  assert.match(lifecycle, /reference is intentionally uninstalled/);
  assert.match(lifecycle, /absolute paths stay internal/);
  assert.match(lifecycle, /Do not discard `diagnostic` fields/);
  assert.match(lifecycle, /Managed baseline semver ranges may be[\s\S]{0,80}exact verified reference resolutions/);
  assert.match(read('skills/check-updates/SKILL.md'), /Diagnostic replay requires a standalone npm app/);
  assert.match(read('skills/check-updates/SKILL.md'), /This mode ends after Step 2/);
  assert.match(read('skills/check-updates/SKILL.md'), /Do not continue to[\s\S]{0,30}Steps 3-4/);
  assert.match(read('skills/check-updates/SKILL.md'), /skip the[\s\S]{0,40}`npm outdated` discovery/);
  assert.match(lifecycle, /Do not disable offline automatically|Do not delete profiles,/);
  assert.match(lifecycle, /new host and template package major/);
  assert.match(read('skills/deploy/SKILL.md'), /Reject any `--diagnostic-artifacts`[\s\S]{0,100}before building or pushing/);
  assert.match(read('skills/debug-app/SKILL.md'), /actual supported counters/);
});
