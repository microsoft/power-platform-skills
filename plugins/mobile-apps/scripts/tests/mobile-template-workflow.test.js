'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const updates = read('skills/check-updates/SKILL.md');
const create = read('skills/create-mobile-app/SKILL.md');
const lifecycle = read('shared/references/mobile-release-lifecycle.md');

test('native updates are evaluated independently of outdated-host discovery', () => {
  assert.match(updates, /even when the host is absent from `outdated\.json`/);
  assert.match(updates, /--requirements-only/);
  assert.match(updates, /Equal supported targets are valid/);
  assert.match(updates, /Do not require or fabricate template advancement/);
  assert.match(updates, /even if `hostInstallRequired` is false/);
  assert.doesNotMatch(updates, /Do not run `upgrade-template`/);
});

test('rehearsal, full-chain approval, drift checks and recovery are separate gates', () => {
  const rehearsal = updates.indexOf('Prepare isolated preview');
  const perEdge = updates.indexOf('repeat dry-run and apply');
  const approval = updates.indexOf('Apply reviewed release');
  const apply = updates.indexOf('### Apply only the approved plan');
  assert.ok(rehearsal < perEdge && perEdge < approval && approval < apply);
  assert.match(updates, /nonzero preview is never automatically a clean plan/);
  assert.match(updates, /`--no-install` to simulate state advancement/);
  assert.match(updates, /under `<working_dir>`/);
  assert.match(updates, /Changed inputs invalidate approval/);
  assert.match(updates, /restore only touched files/);
  assert.match(updates, /rollback or journal recovery cannot complete safely/);
  assert.match(updates, /Never report `DONE` for a partial migration/);
  assert.match(updates, /Skipping excludes all coupled packages/);
});

test('JavaScript updates retain approval and audit safeguards without native bumps', () => {
  assert.match(updates, /Skip package.*recommended default/);
  assert.match(updates, /exact JS dependency exceptions/);
  assert.match(updates, /installed transitive closure adds native code/);
  assert.match(updates, /isDirect: true/);
  assert.match(updates, /Ignore string-only `via` rollups/);
  assert.match(updates, /Never run `npx expo install --fix`/);
  for (const checkpoint of [
    'check_mobile_app_plugin_version', 'update_native_host_dependency',
    'update_microsoft_dependencies', 'update_remaining_npm_dependencies',
  ]) assert.ok(updates.includes(`\`${checkpoint}\``), checkpoint);
});

test('creation resolves immutable published package metadata before planning or data mutations', () => {
  assert.match(create, /Missing or incompatible published package metadata means `BLOCKED` before scaffolding or data-platform mutations/);
  assert.match(create, /mobile-template-lifecycle\.js acquire/);
  assert.match(create, /Separately approve dependency installation/);
  assert.match(create, /Never run acquisition over a non-empty directory/);
  assert.match(create, /Pass its sanitized compatibility context to every planner\/builder/);
  assert.match(create, /`app\.json` byte-for-byte/);
  assert.match(create, /project-rooted aliases/);
  assert.doesNotMatch(create, /npx degit|template#main/);
  assert.match(lifecycle, /no plugin-owned release catalogue/);
  assert.match(lifecycle, /host's `compatibility\/current\.json` owns/);
  assert.match(updates, /npm outdated --json --depth=0/);
  assert.match(updates, /--host-version "<exact-host-version>"/);
  assert.doesNotMatch(updates, /--release "<release-id>"|empty production catalogue/);
  assert.match(lifecycle, /Per-customer optional-permission selection during wrapping\s+is not part/);
  assert.match(create, /mobile-template-lifecycle\.js destination --destination/);
  assert.match(create, /does\s+not apply to an existing app or a creation continuation/);
  assert.match(create, /missing root remains `BLOCKED`/);
  assert.match(create, /Only after acquisition\s+approval may the package CLI create the destination/);
  const readme = read('README.md');
  assert.ok(readme.indexOf('copilot plugin install') < readme.indexOf('resolve-mobile-release.js'));
  assert.ok(readme.indexOf('export PLUGIN_ROOT=') < readme.indexOf('resolve-mobile-release.js'));
});

test('README creation never installs after failed resolution, acquisition or directory entry', t => {
  const commands = [...read('README.md').matchAll(/```sh\n([\s\S]*?)```/g)]
    .map(match => match[1]).find(block => block.includes('--destination ./my-mobile-app'));
  assert.ok(commands);
  const bashPaths = process.platform === 'win32'
    ? (spawnSync('where.exe', ['bash'], { encoding: 'utf8' }).stdout || '').split(/\r?\n/)
    : [];
  const bash = bashPaths.find(entry => /[\\/]Git[\\/]/i.test(entry)) || 'bash';
  const stubs = `
node() {
  case "$1" in
    */resolve-mobile-release.js) [ "$FAILURE_STAGE" != resolution ] ;;
    */mobile-template-lifecycle.js)
      [ "$FAILURE_STAGE" != acquisition ] || return 1
      [ "$FAILURE_STAGE" != directory ] || return 0
      "$REAL_NODE" -e 'require("node:fs").mkdirSync("my-mobile-app")'
      ;;
    *) return 99 ;;
  esac
}
npm() {
  [ "$1" = ci ] || return 98
  "$REAL_NODE" -e 'const fs=require("node:fs"); fs.writeFileSync("install-ran.txt", fs.realpathSync.native(process.cwd()))'
}
`;
  for (const failure of ['resolution', 'acquisition', 'directory', 'none']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mobile creation owner's "));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const destination = path.join(directory, 'my-mobile-app');
    if (failure === 'acquisition') {
      fs.mkdirSync(destination);
      fs.writeFileSync(path.join(destination, 'customer.txt'), 'preserve customer content');
    }
    const result = spawnSync(bash, ['-s'], {
      cwd: directory, input: `${stubs}\n${commands}`, encoding: 'utf8', timeout: 10000,
      env: {
        ...process.env, FAILURE_STAGE: failure, PLUGIN_ROOT: '/fixture plugin',
        REAL_NODE: process.execPath.replaceAll('\\', '/'),
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status === 0, failure === 'none', result.stderr);
    assert.equal(fs.existsSync(path.join(directory, 'install-ran.txt')), false);
    assert.equal(fs.existsSync(path.join(destination, 'install-ran.txt')), failure === 'none');
    if (failure === 'none') {
      assert.equal(fs.readFileSync(path.join(destination, 'install-ran.txt'), 'utf8'), fs.realpathSync.native(destination));
    }
    if (failure === 'acquisition') {
      assert.equal(fs.readFileSync(path.join(destination, 'customer.txt'), 'utf8'), 'preserve customer content');
    }
  }
});

test('deployment instructions require all three actual selected-base values', () => {
  const commands = [...lifecycle.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)]
    .map(match => match[1]).find(block => block.includes('--base-version'));
  assert.ok(commands);
  for (const option of ['version', 'fingerprint', 'runtime-version']) {
    assert.ok(commands.includes(`--base-${option} "<actual-base-${option}>"`));
  }
  assert.match(lifecycle, /Obtain all three values[\s\S]*from the selected deployment target/);
  assert.match(lifecycle, /not by copying expected policy values just to pass/);
});
