'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { shellBlocks } = require('./helpers/markdown-shell-blocks');

const pluginRoot = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(pluginRoot, file), 'utf8');
const entrySkills = ['add-native', 'deploy', 'edit-app', 'debug-app', 'report-issue'];
const nativeHelpers = ['add-camera', 'add-geolocation', 'add-pdf-report', 'add-pdf-viewer', 'add-pen-input'];
// architecture-planner is the screens-first fork of native-app-planner, so it carries the same contract.
const agents = ['native-app-planner', 'architecture-planner', 'screen-planner', 'screen-builder', 'data-model-architect', 'offline-profile-architect'];
const resolver = 'node "${PLUGIN_ROOT}/scripts/resolve-mobile-release.js" --project-root \'<working_dir>\'';

function codeBlock(source, marker) {
  const blocks = [...source.matchAll(/```(?:ts|typescript|tsx)\r?\n([\s\S]*?)```/g)];
  const block = blocks.find((match) => match[1].includes(marker));
  assert.ok(block, `Missing example: ${marker}`);
  return block[1];
}

function bashExecutable() {
  const candidates = process.platform === 'win32'
    ? (spawnSync('where.exe', ['bash'], { encoding: 'utf8' }).stdout || '').split(/\r?\n/)
    : [];
  return candidates.find(file => /[\\/]Git[\\/]/i.test(file)) || 'bash';
}

test('native example extraction supports LF and CRLF Markdown fences', () => {
  for (const newline of ['\n', '\r\n']) {
    for (const language of ['ts', 'typescript', 'tsx']) {
      const marker = 'export async function nativeExample() {}';
      const source = ['```js', 'unrelated();', '```', `\`\`\`${language}`, marker, '```'].join(newline);
      assert.equal(codeBlock(source, marker), `${marker}${newline}`);
      assert.throws(() => codeBlock(source, 'missingExample'), /Missing example/);
    }
  }
});

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

test('creation handoffs retain published npm acquisition and separate installation approval', () => {
  const planner = read('agents/native-app-planner.md');
  const start = planner.indexOf('Next steps for the orchestrator:');
  assert.ok(start >= 0);
  const handoff = planner.slice(start, planner.indexOf('\n```', start));
  assert.match(handoff, /orchestrator-approved/);
  assert.match(handoff, /exact stable published npm template/);
  assert.match(handoff, /verified package creation CLI/);
  assert.match(handoff, /separately approved shipped-lock `npm ci`/);
  assert.doesNotMatch(planner, /\bdegit\b|power-platform-skills\/plugins\/mobile-apps\/template#main/);
});

test('screen planning follows the foreground npm scaffold owner instead of a retired clone pipeline', () => {
  const planner = read('agents/screen-planner.md');
  const start = planner.indexOf('**The scaffolded project');
  assert.ok(start >= 0);
  const scaffold = planner.slice(start, planner.indexOf('## Workflow', start));
  assert.match(scaffold, /reviewed published npm template/);
  assert.match(scaffold, /separately approved shipped-lock `npm ci`/);
  assert.match(scaffold, /foreground-only/);
  assert.match(scaffold, /DEFERRED_CONCERNS\[\]/);
  assert.doesNotMatch(scaffold, /Step 2d background pipeline|clone\s*\u2192|cp -R|after JOIN/);

  // Step 2d is in the data-model-first flow; screens first has no planning-time scaffold step.
  const creation = read('skills/create-mobile-app/references/data-model-first.md');
  const mode = creation.slice(creation.indexOf('### Step 2d'), creation.indexOf('### Step 3'));
  assert.ok(mode.length > 0, 'data-model-first Step 2d');
  assert.match(mode, /fresh-template gate/);
  assert.match(mode, /separately approved shipped-lock `npm ci`/);
  assert.doesNotMatch(mode, /`npm install`/);
});

test('README keeps the bundled directory as a fixture rather than a new-app template source', () => {
  const entry = read('README.md').split(/\r?\n/).find(line => line.startsWith('- [`plugins/mobile-apps/template`]'));
  assert.ok(entry, 'Keep the fixture navigation link with its actual scope');
  assert.match(entry, /legacy preparation\/test fixture/);
  assert.match(entry, /missing-guidance defaults/);
  assert.match(entry, /not an app-template acquisition source/);
  assert.doesNotMatch(entry, /fresh-template working directory source/);

  const fixtureReadme = read('template/README.md');
  assert.match(fixtureReadme, /legacy preparation\/test fixture/);
  assert.match(fixtureReadme, /guarded \[plugin setup sequence\]\(\.\.\/README\.md#setup\)/);
  assert.match(fixtureReadme, /shipped-lock `npm ci`/);
  assert.match(fixtureReadme, /Run `\/check-updates` from the existing app/);
  assert.doesNotMatch(fixtureReadme, /\bnpx degit\b|--from-version|host@latest|Each run upgrades one template version/);
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
  assert.match(source, /Unknown\/missing package contracts or base metadata[\s\S]{0,120}STOP/);
  assert.match(source, /--base-runtime-version/);
  assert.match(source, /no `deploy without compatibility` override/);
  assert.match(source, /Re-run Step 1\.2[\s\S]{0,160}fingerprints before this push/);
  assert.match(source, /Hermes magic bytes[\s\S]{0,180}compatibility/);
  assert.match(source, /not.*newest bundled template|never use the newest bundled template/);
});

test('multi-command native admission blocks propagate the first resolver failure', t => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mobile-admission-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bash = bashExecutable();
  for (const [file, marker] of [
    ['skills/add-native/add-pdf-report/SKILL.md', "const required='expo-print'"],
    ['skills/deploy/SKILL.md', '--platform android'],
  ]) {
    const block = shellBlocks(read(file)).find(value => value.includes(marker));
    assert.ok(block, file);
    const command = block.replaceAll('<working_dir>', root.replaceAll('\\', '/').replaceAll("'", "'\\''"));
    const probe = 'count=0\nnode() { count=$((count + 1)); if [ \"$count\" -eq 1 ]; then return 23; fi; printf \"unexpected-followup\"; }\n';
    const result = spawnSync(bash, ['-s'], {
      input: probe + command, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 23, file);
    assert.equal(result.stdout, '', 'No later successful command may hide native admission failure');
  }
});
test('deployment retains app-ID two-pass packaging, offline reconciliation, and user confirmation', () => {
  const source = read('skills/deploy/SKILL.md');
  assert.match(source, /two full build\+push cycles are required/);
  assert.match(source, /In cycle 2, the web build, both native packaging commands, staging, and final upload verification must all re-run/);
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
  assert.match(source, /Preserve `power\.config\.json`/);
  assert.match(source, /A previous build must not satisfy this run's checks/);
  assert.doesNotMatch(source, /EXPORT_PID|Exported: dist|npx --no-install expo export/);
});

test('documented deployment builds stop at the first failed package command', t => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mobile-deploy commands-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const blocks = shellBlocks(read('skills/deploy/SKILL.md'));
  const phases = [
    ['bundle:web', ['generate-schemas', 'type-check', 'bundle:web']],
    ['bundle:android', ['bundle:android', 'bundle:ios']],
  ];
  for (const [marker, scripts] of phases) {
    const block = blocks.find(value => value.includes(`npm run ${marker}`));
    assert.ok(block, marker);
    const command = block.replaceAll('<working_dir>', root.replaceAll('\\', '/').replaceAll("'", "'\\''"));
    for (const failure of [...scripts, 'none']) {
      const result = spawnSync(bashExecutable(), ['-s'], {
        input: 'npm() { printf "%s\\n" "$2"; if [ "$2" = "$FAIL_SCRIPT" ]; then return 23; fi; return 0; }\n' + command,
        cwd: root, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, FAIL_SCRIPT: failure },
      });
      assert.equal(result.status, failure === 'none' ? 0 : 23, result.stderr);
      const last = scripts.indexOf(failure);
      assert.deepEqual(result.stdout.trim().split(/\r?\n/), last < 0 ? scripts : scripts.slice(0, last + 1));
    }
  }
});

test('documented staging preserves complete web/native payloads and checks the actual upload root', t => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mobile-deploy staging-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const blocks = shellBlocks(read('skills/deploy/SKILL.md'));
  const stage = blocks.find(value => value.includes('cp -R dist-web/. dist/'));
  const verify = blocks.find(value => value.includes('<reviewed-upload-root>'));
  assert.ok(stage && verify);
  const files = {
    'dist-web/index.html': Buffer.from('<script src="./_expo/static/js/web/entry.js"></script>'),
    'dist-web/_expo/static/js/web/entry.js': Buffer.from('web bundle'),
    'dist-web/assets/icon.png': Buffer.from([1, 2, 3, 4]),
    'dist/index.android.bundle.hbc': Buffer.from('c61fbc03c103191f', 'hex'),
    'dist/main.jsbundle.hbc': Buffer.from('c61fbc03c103191f', 'hex'),
    'dist/powerapps-customer-assets-android/manifest.json': Buffer.from('{"platform":"android"}'),
    'dist/powerapps-customer-assets-android/assets/native.png': Buffer.from([4, 3, 2, 1]),
    'dist/powerapps-customer-assets-android/firebase/google-services.json': Buffer.from('{"project_info":{}}'),
    'dist/powerapps-customer-assets-ios/manifest.json': Buffer.from('{"platform":"ios"}'),
  };
  const config = '{"appType":"MobileApp","buildPath":"./dist","buildEntryPoint":"index.html"}\n';
  fs.writeFileSync(path.join(root, 'power.config.json'), config);
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
  const shellPath = value => value.replaceAll('\\', '/').replaceAll("'", "'\\''");
  const result = spawnSync(bashExecutable(), ['-s'], {
    input: stage.replaceAll('<working_dir>', shellPath(root)),
    cwd: root, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  for (const [relative, content] of Object.entries(files)) {
    const staged = relative.replace(/^dist-web\//, 'dist/');
    assert.deepEqual(fs.readFileSync(path.join(root, staged)), content, staged);
  }
  assert.equal(fs.existsSync(path.join(root, 'dist/dist-web')), false);
  assert.equal(fs.readFileSync(path.join(root, 'power.config.json'), 'utf8'), config);

  const upload = path.join(root, 'reviewed upload');
  fs.cpSync(path.join(root, 'dist'), upload, { recursive: true });
  fs.unlinkSync(path.join(root, 'dist/main.jsbundle.hbc'));
  const check = () => spawnSync(bashExecutable(), ['-s'], {
    input: verify.replaceAll('<reviewed-upload-root>', shellPath(upload)),
    cwd: root, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(check().status, 0, 'Verify the selected upload directory, not the producer output');
  fs.writeFileSync(path.join(upload, 'main.jsbundle.hbc'), 'not Hermes bytecode');
  assert.notEqual(check().status, 0, 'Invalid staged bytecode must block the push');

  fs.unlinkSync(path.join(root, 'dist/index.html'));
  const missing = spawnSync(bashExecutable(), ['-s'], {
    input: stage.replaceAll('<working_dir>', shellPath(root)),
    cwd: root, encoding: 'utf8', timeout: 10000,
  });
  assert.notEqual(missing.status, 0);
  assert.equal(fs.existsSync(path.join(root, 'dist/index.html')), false, 'Do not stage a web-only payload after a native build failure');
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
  assert.match(source, /Current and historical package examples/);
  assert.match(source, /automatic install targets/);
  assert.match(source, /Resolve the actual app; a template may omit controls/);
  for (const file of ['agents/native-app-planner.md', 'agents/architecture-planner.md', 'skills/edit-app/SKILL.md']) {
    assert.match(read(file), /native-controls\.md#current-and-historical-package-examples/, file);
  }
  assert.match(source, /Do not install the aggregate to[\s\S]{0,20}fix older binaries/);
  assert.match(source, /Legacy leaf imports follow the same strict\/local rules for the matching version/);
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
  assert.match(edit, /source-only work can use installed contracts/);
  assert.match(edit, /Do not force repair before local startup/);
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

test('production workflows use published packages without advertising retired diagnostic acquisition', () => {
  for (const skill of ['create-mobile-app', 'check-updates', 'edit-app', 'add-native', 'debug-app', 'report-issue']) {
    assert.doesNotMatch(read(`skills/${skill}/SKILL.md`), /--diagnostic-artifacts/, skill);
  }
  for (const helper of nativeHelpers) {
    assert.doesNotMatch(read(`skills/add-native/${helper}/SKILL.md`), /--diagnostic-artifacts/, helper);
  }
  for (const file of [
    'AGENTS.md', 'README.md', 'shared/shared-instructions.md', 'shared/version-check.md',
    ...['create-mobile-app', 'check-updates', 'edit-app', 'add-native'].map(skill => `skills/${skill}/SKILL.md`),
    ...nativeHelpers.map(helper => `skills/add-native/${helper}/SKILL.md`),
  ]) {
    assert.doesNotMatch(read(file), /online-only Android|online-only test inventory/, file);
  }
  assert.equal(fs.existsSync(path.join(pluginRoot, 'shared/mobile-releases.json')), false);
  const lifecycle = read('shared/references/mobile-release-lifecycle.md');
  assert.match(lifecycle, /source manifest[\s\S]{0,120}not evidence of a[\s\S]{0,10}matching binary/);
  assert.match(lifecycle, /`--no-install` separately/);
  assert.doesNotMatch(lifecycle, /stage-diagnostic/);
  assert.match(lifecycle, /diagnostic artifact mode is retired/);
  assert.doesNotMatch(lifecycle, /--diagnostic-artifacts|diagnostic-57-v1/);
  const workflow = fs.readFileSync(path.resolve(pluginRoot, '../../.github/workflows/mobile-apps-script-tests.yml'), 'utf8');
  assert.match(workflow, /node --check plugins\/mobile-apps\/scripts\/lib\/mobile-package-artifacts\.js/);
  assert.doesNotMatch(workflow, /mobile-diagnostic-artifacts/);
  assert.match(lifecycle, /Do not delete profiles,/);
  assert.match(lifecycle, /native artifact hashes/);
  assert.match(lifecycle, /database upgrades[\s\S]{0,10}need separate device tests/);
  assert.match(read('skills/deploy/SKILL.md'), /Reject any `--diagnostic-artifacts`[\s\S]{0,100}before building or pushing/);
  assert.match(read('skills/debug-app/SKILL.md'), /actual[\s\S]{0,10}supported counters/);
});

test('upgrade rehearsals preserve source config context and require reviewed override resolutions', () => {
  const skill = read('skills/check-updates/SKILL.md');
  const lifecycle = read('shared/references/mobile-release-lifecycle.md');
  assert.match(skill, /restore-preview --project-root '<working_dir>' --preview-root '<preview_dir>'/);
  assert.match(skill, /Never run bare `npm ci`/);
  assert.match(skill, /check-sdk --project-root '<preview_dir>'/);
  assert.match(skill, /check-sdk --project-root '<working_dir>'/);
  assert.match(skill, /Expo compatibility, Expo Doctor, TypeScript and platform bundles are mandatory/);
  assert.match(skill, /any failure blocks application/);
  assert.match(skill, /Do not run strict app admission/);
  assert.doesNotMatch(skill, /resolve-mobile-release\.js[^\n]*--upgrade-only/);
  assert.doesNotMatch(skill, /`npx --no-install expo install --check`/);
  for (const source of [skill, lifecycle]) {
    assert.match(source, /restore-preview/);
    assert.match(source, /EXPO_OFFLINE=1/);
    assert.match(source, /installed SDK|frozen\s+SDK/);
    assert.match(source, /source dependencies from its\s+unchanged (?:source )?lock/);
    assert.match(source, /target-reference `NODE_PATH`/);
    assert.match(source, /source dependency context/);
    assert.match(source, /(?:Package override conflicts are blocking|override is a blocking preview)/);
    assert.match(source, /approve?[\s\S]{0,45}(?:exact resolution|exact override resolution)|approval for the[\s\S]{0,30}exact resolution/);
    assert.match(source, /EOVERRIDE/);
    assert.match(source, /[Tt]est-fixture-only/);
  }
});

test('upgrade skills reuse the verified external host CLI rather than duplicating installation', () => {
  const skill = read('skills/check-updates/SKILL.md');
  const lifecycle = read('shared/references/mobile-release-lifecycle.md');
  for (const source of [skill, lifecycle]) {
    assert.match(source, /mobile-template-lifecycle\.js acquire/);
    assert.match(source, /bin\["upgrade-template"\]/);
    assert.match(source, /guarded lock regeneration/);
    assert.match(source, /producer fix/);
    assert.match(source, /Player.build scripts|Player-build scripts/);
  }
  assert.match(skill, /separate private tooling installation/);
  assert.match(skill, /not by installing it into the old app's dependency graph/);
  assert.match(skill, /same verified reference host CLI/);
  assert.match(skill, /never[\s\S]{0,90}delete the app's lock or `node_modules`/);
  assert.doesNotMatch(skill, /Install the \*\*exact reviewed target host\*\* only in the disposable copy/);
  assert.match(lifecycle, /Published migrations use the host-owned strict npm installer/);
});
