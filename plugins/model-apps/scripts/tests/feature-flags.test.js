'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { makeTempDir } = require('./helpers/temp-dirs.js');

const libPath = path.join(__dirname, '..', 'lib', 'feature-flags.js');
const lib = require(libPath);
const {
  isEnabled,
  envVarName,
  parseBool,
  describe,
  validateFlags,
  KNOWN_FLAGS,
  FLAGS,
} = lib;

// --- Committed defaults and fail-closed fallback ---------------------------

test('connectors flag is retired and unknown fail-closed', () => {
  const json = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'feature-flags.json'), 'utf8')
  );
  assert.equal(Object.prototype.hasOwnProperty.call(json, 'connectors'), false);
  assert.equal(KNOWN_FLAGS.includes('connectors'), false);
  assert.equal(isEnabled('connectors', { env: { GENPAGE_ENABLE_CONNECTORS: '1' } }), false);
  assert.match(validateFlags({ connectors: true })[0], /unknown flag/i);
  const lib = require(libPath);
  for (const removed of ['isConnectorsEnabled', 'exitIfConnectorsDisabled', 'connectorsDisabledMessage']) {
    assert.equal(lib[removed], undefined, `${removed} must stay removed now that connectors have no flag`);
  }
});
// Custom API support shipped ON in 2.18.0 and 2.19.0 with its platform dependencies live in every region, so the flag was removed (the lifecycle
// in feature-flags.js): Custom API discovery, authoring and upload are always available. As an unknown flag it would now read as disabled, so
// nothing may keep a trace of it that something could still ask for.
test('the custom-api flag is retired: no catalogue entry, no committed key, no helper, and its variable no longer changes anything', () => {
  const json = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'feature-flags.json'), 'utf8')
  );
  assert.equal(Object.prototype.hasOwnProperty.call(json, 'custom-api'), false);
  assert.deepEqual(validateFlags(json), []);
  assert.equal(KNOWN_FLAGS.includes('custom-api'), false);
  assert.equal(FLAGS['custom-api'], undefined);
  for (const value of [undefined, '0', '1']) {
    const env = value === undefined ? {} : { GENPAGE_ENABLE_CUSTOM_API: value };
    assert.equal(isEnabled('custom-api', { env }), false, `unknown flags fail closed, whatever GENPAGE_ENABLE_CUSTOM_API says (${value})`);
  }
  assert.match(validateFlags({ 'custom-api': true })[0], /unknown flag/i);
  for (const removed of ['isCustomApiEnabled', 'exitIfCustomApiDisabled', 'customApiDisabledMessage']) {
    assert.equal(lib[removed], undefined, `${removed} must stay removed now that Custom API support has no flag`);
  }
});

test('feature-flags.js --list shows no custom-api line, and no warning about it, whatever GENPAGE_ENABLE_CUSTOM_API says', () => {
  for (const value of [undefined, '0', '1']) {
    const env = { ...process.env };
    delete env.GENPAGE_ENABLE_CUSTOM_API;
    if (value !== undefined) env.GENPAGE_ENABLE_CUSTOM_API = value;
    const res = spawnSync(process.execPath, [libPath, '--list'], { encoding: 'utf8', env });
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stdout, /custom-api/, `GENPAGE_ENABLE_CUSTOM_API=${value}`);
    assert.doesNotMatch(res.stderr, /custom-api/, `GENPAGE_ENABLE_CUSTOM_API=${value}`);
    assert.match(res.stdout, /^custom-telemetry: /m);
    assert.match(res.stdout, /^dataverse-operations: /m);
  }
});

// With the flag gone, a probe left anywhere would read it as disabled and turn Custom API support off where it ran. So no caller may stay in any
// tree that runs or describes this plugin: the plugin itself (scripts, hooks, agents, skills, references, samples, docs, and its tests and test
// helpers), the pcf plugin (it carries copies of model-apps scripts), and both eval trees (graders, runners, and their tests and helpers). Only
// what names the flag on purpose is let through, file by file and probe by probe: the release history, the runs that eval fixtures recorded (an
// older run probed the flag; the graders neither require nor refuse that probe), and the tests that pin the retirement or hand such a recorded
// probe to a grader.
const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
const RETIRED_FLAG_ROOTS = ['plugins/model-apps', 'plugins/pcf', 'evals/model-apps', 'evals/pcf'];
const RETIRED_FLAG_PROBES = {
  // As a skill, an agent or a recorded run writes it: node "${PLUGIN_ROOT}/scripts/lib/feature-flags.js" <flag>, the flag name after the script.
  cli: /feature-flags\.js["'`]?\s+["'`]?custom-api\b/,
  library: /\b(?:isEnabled|envVarName)\(\s*["'`]custom-api["'`]/,
  helper: /\b(?:isCustomApiEnabled|exitIfCustomApiDisabled|customApiDisabledMessage)\b/,
  // A setting or a read of the variable: GENPAGE_ENABLE_CUSTOM_API=0, { GENPAGE_ENABLE_CUSTOM_API: '1' }, process.env.GENPAGE_ENABLE_CUSTOM_API,
  // env['GENPAGE_ENABLE_CUSTOM_API'], $env:GENPAGE_ENABLE_CUSTOM_API, ${GENPAGE_ENABLE_CUSTOM_API}, %GENPAGE_ENABLE_CUSTOM_API%. Prose that names
  // it ("`GENPAGE_ENABLE_CUSTOM_API` is ignored") is none of these.
  variable: /GENPAGE_ENABLE_CUSTOM_API["'`]?\s*[=:]|(?:\.|\[\s*["'`]|\$env:|\$\{?|%)GENPAGE_ENABLE_CUSTOM_API\b/,
};
const RETIRED_FLAG_FILES = /\.(?:md|js|cjs|mjs|jsx|json|ts|tsx|ps1|sh|cmd|bat|ya?ml)$/i;
// A run an eval fixture recorded — its workflow log and its tool results — keeps the CLI probes the run made, and nothing else is let through
// there: any other kind of probe, or a script in a fixture folder, is a caller.
const RECORDED_RUN = /^evals\/[^/]+\/[^/]+\/fixtures\/[^/]+\/(?:workflow-log\.md|tool-results\.json)$/;
const RETIRED_FLAG_ALLOWED = new Map([
  ['plugins/model-apps/CHANGELOG.md', { history: true, probes: Object.keys(RETIRED_FLAG_PROBES) }],
  // Pins the retirement: the flag reads disabled, its helpers are gone, and its variable changes nothing.
  ['plugins/model-apps/scripts/tests/feature-flags.test.js', { probes: ['library', 'helper', 'variable'] }],
  // Discovery reads no gate and lists the same whatever the variable says.
  ['plugins/model-apps/scripts/tests/list-custom-apis.test.js', { probes: ['helper', 'variable'] }],
  // The dataverse-operations gate ignores the variable.
  ['plugins/model-apps/scripts/tests/list-dataverse-operations.test.js', { probes: ['variable'] }],
  // A recorded probe decides no grade, and the reader of recorded tool results reads the probe commands the fixtures hold.
  ['evals/model-apps/genpage/tests/action-binding-union.test.js', { probes: ['cli'] }],
  ['evals/model-apps/genpage/tests/built-in-operation-pattern.test.js', { probes: ['cli'] }],
  ['evals/model-apps/genpage/tests/custom-api-lifecycle.test.js', { probes: ['cli'] }],
  ['evals/model-apps/genpage/tests/fixture-tool-results.test.js', { probes: ['cli'] }],
]);

// Every probe in the scanned roots under `root`: `found` holds the ones nothing lets through, `allowed` the files on the list above with the
// kinds they hold, `recorded` the recorded runs that hold a CLI probe, and `visited` every file read. Other test files run beside this one and
// some make and remove folders inside these roots (capture-fixture.test.js writes a fixture under evals/model-apps/genpage/fixtures), so an
// entry that is gone by the time it is read is skipped: it was never part of what the plugin ships.
function retiredFlagScan(root) {
  const found = [];
  const allowed = new Map();
  const recorded = [];
  const visited = new Set();
  const gone = (error) => error && error.code === 'ENOENT';
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (gone(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (!['node_modules', '.git'].includes(entry.name)) walk(full);
        continue;
      }
      if (!entry.isFile() || !RETIRED_FLAG_FILES.test(entry.name)) continue;
      let text;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch (error) {
        if (gone(error)) continue;
        throw error;
      }
      visited.add(relative);
      const kinds = Object.keys(RETIRED_FLAG_PROBES).filter((kind) => RETIRED_FLAG_PROBES[kind].test(text));
      if (!kinds.length) continue;
      const permitted = RECORDED_RUN.test(relative) ? ['cli'] : (RETIRED_FLAG_ALLOWED.get(relative)?.probes || []);
      for (const kind of kinds) {
        if (!permitted.includes(kind)) found.push(`${relative}: ${kind}`);
        else if (RECORDED_RUN.test(relative)) recorded.push(relative);
        else allowed.set(relative, [...(allowed.get(relative) || []), kind]);
      }
    }
  };
  for (const scanned of RETIRED_FLAG_ROOTS) {
    const dir = path.join(root, ...scanned.split('/'));
    if (fs.existsSync(dir)) walk(dir);
  }
  return { found, allowed, recorded, visited };
}

test('nothing the plugin ships asks for the custom-api flag: no script, hook, agent, skill, reference, test helper, pcf copy or eval grader probes it', () => {
  const { found, allowed, recorded, visited } = retiredFlagScan(REPO_ROOT);
  assert.deepEqual(found, []);
  // Every root is read down to its tests, helpers and fixtures: a known file from each is among the files scanned.
  for (const file of [
    'plugins/model-apps/scripts/list-custom-apis.js', 'plugins/model-apps/scripts/lib/feature-flags.js', 'plugins/model-apps/hooks/hooks.json',
    'plugins/model-apps/agents/genpage-customapi-builder.md', 'plugins/model-apps/skills/genpage/SKILL.md', 'plugins/model-apps/references/custom-api.md',
    'plugins/model-apps/scripts/tests/list-custom-apis.test.js', 'plugins/model-apps/scripts/tests/helpers/fake-custom-api-preload.js',
    'plugins/pcf/scripts/check-auth.js', 'plugins/pcf/AGENTS.md',
    'evals/model-apps/genpage/lib/custom-api-contract.js', 'evals/model-apps/genpage/run-layer-1.js', 'evals/model-apps/genpage/EVAL_GUIDE.md',
    'evals/model-apps/genpage/tests/custom-api-lifecycle.test.js', 'evals/model-apps/genpage/fixtures/24-custom-api-lifecycle/workflow-log.md',
    'evals/model-apps/app-builder/run-app-builder.js', 'evals/pcf/run-pcf.js',
  ]) {
    assert.ok(visited.has(file), `${file} was scanned`);
  }
  assert.ok(visited.size > 1000, `scanned ${visited.size} files`);
  // A file is let through only while it still holds what it is let through for, so the list cannot outgrow its purpose.
  for (const [file, { history }] of RETIRED_FLAG_ALLOWED) {
    if (!history) assert.ok(allowed.has(file), `${file} no longer names the flag: take it off RETIRED_FLAG_ALLOWED`);
  }
  assert.ok(recorded.length > 0, 'the recorded runs that probed the flag were read');
});

test('the custom-api flag scan finds a caller planted in any root — a pcf script, an eval grader, a test helper, a new test, a fixture script — and lets through only what names the flag on purpose', () => {
  const root = makeTempDir('retired-flag-scan-');
  // Built from parts, so that this file holds no probe of a kind it is not let through for.
  const FLAG = ['custom', 'api'].join('-');
  const VARIABLE = ['GENPAGE', 'ENABLE', 'CUSTOM', 'API'].join('_');
  const probe = {
    cli: `node "\${PLUGIN_ROOT}/scripts/lib/feature-flags.js" ${FLAG}\n`,
    library: `'use strict';\nmodule.exports = (flags) => flags.isEnabled('${FLAG}');\n`,
    helper: `const { exitIf${'CustomApi'}Disabled } = require('./lib/feature-flags.js');\n`,
    variable: `if (process.env.${VARIABLE} === '0') process.exit(3);\n`,
    shell: `if ($env:${VARIABLE} -eq '0') { exit 3 }\n`,
    prose: `\`${VARIABLE}\` is ignored.\n`,
  };
  const plant = (relative, text) => {
    const file = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const callers = [
    ['plugins/model-apps/scripts/flag-probe.cjs', 'library'],
    ['plugins/model-apps/hooks/flag-probe.ps1', 'shell'],
    ['plugins/model-apps/skills/genpage/SKILL.md', 'cli'],
    ['plugins/model-apps/scripts/tests/helpers/flag-probe.cjs', 'library'],
    ['plugins/model-apps/scripts/tests/new-feature.test.js', 'cli'],
    ['plugins/pcf/scripts/flag-probe.cjs', 'library'],
    ['plugins/pcf/skills/pcf-create/SKILL.md', 'cli'],
    ['evals/model-apps/genpage/lib/flag-probe.cjs', 'library'],
    ['evals/model-apps/genpage/run-layer-3.js', 'variable'],
    ['evals/pcf/lib/flag-probe.js', 'helper'],
    // A list entry lets through only its own kinds, a recorded run only the CLI probe, and a script in a fixture folder nothing.
    ['evals/model-apps/genpage/tests/action-binding-union.test.js', 'library'],
    ['evals/model-apps/genpage/fixtures/24-custom-api-lifecycle/workflow-log.md', 'library'],
    ['evals/model-apps/genpage/fixtures/24-custom-api-lifecycle/capture.js', 'cli'],
  ];
  const letThrough = [
    ['plugins/model-apps/CHANGELOG.md', 'library'],
    ['plugins/model-apps/README.md', 'prose'],
    ['evals/model-apps/genpage/tests/custom-api-lifecycle.test.js', 'cli'],
    ['evals/model-apps/genpage/fixtures/16-account-list/tool-results.json', 'cli'],
    ['plugins/pcf/node_modules/some-package/index.js', 'library'],
  ];
  for (const [relative, kind] of [...callers, ...letThrough]) plant(relative, probe[kind]);
  const { found, visited } = retiredFlagScan(root);
  const kindOf = { shell: 'variable' };
  assert.deepEqual(found.sort(), callers.map(([relative, kind]) => `${relative}: ${kindOf[kind] || kind}`).sort());
  for (const [relative] of letThrough.slice(0, 4)) assert.ok(visited.has(relative), `${relative} was read`);
  assert.equal(visited.has('plugins/pcf/node_modules/some-package/index.js'), false, 'installed packages are not read');
});

test('custom-telemetry flag is OFF by default (no env override)', () => {
  // custom-telemetry has no helper of its own (it gates code generation, not scripts), so
  // the generic probe is the contract the skill markdown actually calls.
  assert.equal(isEnabled('custom-telemetry', { env: {} }), false);
});

test('unknown flags are OFF (fail-closed)', () => {
  assert.equal(isEnabled('does-not-exist', { env: {} }), false);
});

test('missing/invalid flags file is treated as all-OFF', () => {
  assert.equal(
    isEnabled('custom-telemetry', { env: {}, flagsPath: path.join(__dirname, 'no-such-flags.json') }),
    false
  );
});

// --- Env override precedence (env wins over committed config) ----------------

test('env var enables a flag that is false in config', () => {
  assert.equal(
    isEnabled('custom-telemetry', { env: { GENPAGE_ENABLE_CUSTOM_TELEMETRY: '1' }, flags: { 'custom-telemetry': false } }),
    true
  );
});

test('env var OFF overrides config true', () => {
  assert.equal(
    isEnabled('custom-telemetry', { env: { GENPAGE_ENABLE_CUSTOM_TELEMETRY: '0' }, flags: { 'custom-telemetry': true } }),
    false
  );
});

test('unrecognized env value defers to config', () => {
  assert.equal(
    isEnabled('custom-telemetry', { env: { GENPAGE_ENABLE_CUSTOM_TELEMETRY: 'maybe' }, flags: { 'custom-telemetry': true } }),
    true
  );
});

test('config true enables when env is unset', () => {
  assert.equal(isEnabled('custom-telemetry', { env: {}, flags: { 'custom-telemetry': true } }), true);
});

// --- Helpers ----------------------------------------------------------------

test('envVarName maps flag names to GENPAGE_ENABLE_<FLAG>', () => {
  assert.equal(envVarName('custom-telemetry'), 'GENPAGE_ENABLE_CUSTOM_TELEMETRY');
  assert.equal(envVarName('multi-word flag'), 'GENPAGE_ENABLE_MULTI_WORD_FLAG');
});

test('parseBool recognizes common truthy/falsey tokens, defers otherwise', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) assert.equal(parseBool(v), true, `truthy: ${v}`);
  for (const v of ['0', 'false', 'no', 'off', 'OFF']) assert.equal(parseBool(v), false, `falsey: ${v}`);
  for (const v of [undefined, null, '', '   ', 'maybe']) assert.equal(parseBool(v), null, `defer: ${String(v)}`);
});

// --- Committed config keeps each feature's own default ---------------------

test('committed feature-flags.json ships custom-telemetry: false', () => {
  const json = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'feature-flags.json'), 'utf8')
  );
  assert.equal(json['custom-telemetry'], false);
});

// --- CLI probe (deterministic gate for the skill markdown) ------------------

test('CLI prints "disabled" and exits 1 for an explicit opt-out', () => {
  const res = spawnSync(process.execPath, [libPath, 'custom-telemetry'], {
    encoding: 'utf8',
    env: { ...process.env, GENPAGE_ENABLE_CUSTOM_TELEMETRY: '0' },
  });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /disabled/);
});

test('CLI prints "enabled" and exits 0 when env override ON', () => {
  const res = spawnSync(process.execPath, [libPath, 'custom-telemetry'], {
    encoding: 'utf8',
    env: { ...process.env, GENPAGE_ENABLE_CUSTOM_TELEMETRY: '1' },
  });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /enabled/);
});

test('CLI prints "disabled" and exits 1 for the retired custom-api flag, even with its old variable set', () => {
  for (const value of [undefined, '1']) {
    const env = { ...process.env };
    delete env.GENPAGE_ENABLE_CUSTOM_API;
    if (value !== undefined) env.GENPAGE_ENABLE_CUSTOM_API = value;
    const res = spawnSync(process.execPath, [libPath, 'custom-api'], { encoding: 'utf8', env });
    assert.equal(res.status, 1, res.stderr);
    assert.equal(res.stdout, 'disabled\n');
  }
});

test('CLI without a flag name exits 2 with usage', () => {
  const res = spawnSync(process.execPath, [libPath], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Usage:/);
});

// --- known-flag registry + describe() + validation --------------------------

test('KNOWN_FLAGS includes custom-telemetry', () => {
  assert.ok(KNOWN_FLAGS.includes('custom-telemetry'));
});

test('describe reports effective state and source per known flag', () => {
  const envOn = describe({ env: { GENPAGE_ENABLE_CUSTOM_TELEMETRY: '1' }, flags: { 'custom-telemetry': false } });
  const c1 = envOn.find((f) => f.flag === 'custom-telemetry');
  assert.equal(c1.enabled, true);
  assert.equal(c1.source, 'env');

  const fileOn = describe({ env: {}, flags: { 'custom-telemetry': true } });
  const c2 = fileOn.find((f) => f.flag === 'custom-telemetry');
  assert.equal(c2.enabled, true);
  assert.equal(c2.source, 'file');

  const dflt = describe({ env: {}, flags: {} });
  const c3 = dflt.find((f) => f.flag === 'custom-telemetry');
  assert.equal(c3.enabled, false);
  assert.equal(c3.source, 'default');
});

test('validateFlags warns on unknown keys and non-boolean values, ignores _comment', () => {
  assert.deepEqual(validateFlags({ 'custom-telemetry': false, _comment: 'x' }), []);
  assert.match(validateFlags({ 'custom-telemetri': true })[0], /unknown flag/i);
  assert.match(validateFlags({ 'custom-telemetry': 'yes' })[0], /boolean/i);
});

// --- flag catalog: status tracking for experimental / in-progress features --

test('FLAGS catalog documents custom-telemetry with a status and summary', () => {
  assert.ok(FLAGS['custom-telemetry'], 'custom-telemetry flag should be in the catalog');
  assert.ok(['experimental', 'in-progress', 'ga'].includes(FLAGS['custom-telemetry'].status));
  assert.match(FLAGS['custom-telemetry'].summary, /telemetry|Application Insights/i);
  assert.ok(FLAGS['custom-telemetry'].dependencies, 'should document what it depends on');
  assert.match(FLAGS['custom-telemetry'].enableEnv, /GENPAGE_ENABLE_CUSTOM_TELEMETRY/);
});

test('KNOWN_FLAGS is derived from the FLAGS catalog', () => {
  assert.deepEqual(KNOWN_FLAGS, Object.keys(FLAGS));
});

test('describe includes the status for each known flag', () => {
  const d = describe({ env: {}, flags: {} });
  for (const flag of KNOWN_FLAGS) assert.equal(d.find((f) => f.flag === flag).status, FLAGS[flag].status, flag);
});

// --- dataverse-operations: its own default-OFF gate, which never decides Custom API support ------------------

const DATAVERSE_OPERATIONS_LINE = 'Dataverse built-in operation authoring is disabled (feature flag "dataverse-operations" is OFF). '
  + 'Set GENPAGE_ENABLE_DATAVERSE_OPERATIONS=1 to offer WhoAmI and RetrieveVersion. '
  + 'Existing bindings are preserved; runtime governance and user privileges still apply.';

test('dataverse-operations is a registered flag: its env override turns it on, and the retired custom-api variable decides nothing', () => {
  // An unregistered flag ignores its env var (isEnabled fails closed for unknown names), so registration is what this pins.
  assert.equal(isEnabled('dataverse-operations', { env: { GENPAGE_ENABLE_DATAVERSE_OPERATIONS: '1' } }), true);
  assert.ok(KNOWN_FLAGS.includes('dataverse-operations'));
  assert.equal(FLAGS['dataverse-operations'].status, 'experimental');
  assert.equal(FLAGS['dataverse-operations'].enableEnv, 'GENPAGE_ENABLE_DATAVERSE_OPERATIONS=1');
  assert.match(FLAGS['dataverse-operations'].summary, /WhoAmI/);
  assert.match(FLAGS['dataverse-operations'].summary, /RetrieveVersion/);
  assert.equal(envVarName('dataverse-operations'), 'GENPAGE_ENABLE_DATAVERSE_OPERATIONS');
  // The retired custom-api variable is no switch for this flag either way.
  assert.equal(isEnabled('dataverse-operations', { env: { GENPAGE_ENABLE_CUSTOM_API: '1' } }), false);
  assert.equal(isEnabled('dataverse-operations', { env: { GENPAGE_ENABLE_CUSTOM_API: '0', GENPAGE_ENABLE_DATAVERSE_OPERATIONS: '1' } }), true);
});

test('dataverse-operations ships OFF; an unset, blank or unrecognized env value defers to the file, which is not a forced false', () => {
  const json = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'feature-flags.json'), 'utf8'));
  assert.equal(json['dataverse-operations'], false);
  assert.deepEqual(validateFlags(json), []);
  assert.equal(isEnabled('dataverse-operations', { env: {} }), false);
  for (const value of [undefined, '', '   ', 'maybe', 'enable']) {
    const env = value === undefined ? {} : { GENPAGE_ENABLE_DATAVERSE_OPERATIONS: value };
    assert.equal(isEnabled('dataverse-operations', { env, flags: {} }), false, `${JSON.stringify(value)} over a file without the flag`);
    assert.equal(isEnabled('dataverse-operations', { env, flags: { 'dataverse-operations': true } }), true, `${JSON.stringify(value)} defers to a file that says true`);
  }
  for (const value of ['0', 'false', 'NO', ' off ']) {
    assert.equal(isEnabled('dataverse-operations', { env: { GENPAGE_ENABLE_DATAVERSE_OPERATIONS: value }, flags: { 'dataverse-operations': true } }), false, value);
  }
  for (const value of ['1', 'true', 'YES', ' on ']) {
    assert.equal(isEnabled('dataverse-operations', { env: { GENPAGE_ENABLE_DATAVERSE_OPERATIONS: value }, flags: {} }), true, value);
  }
  assert.equal(isEnabled('dataverse-operations', { env: {}, flags: { 'dataverse-operations': 'true' } }), false, 'only a boolean true in the file turns it on');
  assert.equal(isEnabled('dataverse-operations', { env: {}, flagsPath: path.join(__dirname, 'no-such-flags.json') }), false, 'a missing file stays off');
  const listed = describe({ env: {}, flags: {} }).find((f) => f.flag === 'dataverse-operations');
  assert.deepEqual(listed, { flag: 'dataverse-operations', enabled: false, source: 'default', status: 'experimental' });
});

test('the dataverse-operations helpers print the one byte-stable gate line and exit 3', () => {
  assert.equal(lib.dataverseOperationsDisabledMessage(), DATAVERSE_OPERATIONS_LINE);
  assert.equal(lib.isDataverseOperationsEnabled({ env: {} }), false);
  assert.equal(lib.isDataverseOperationsEnabled({ env: { GENPAGE_ENABLE_DATAVERSE_OPERATIONS: 'on' } }), true);
  let exitCode = null;
  let written = '';
  lib.exitIfDataverseOperationsDisabled({ env: {}, flags: {}, exit: (c) => { exitCode = c; }, write: (s) => { written += s; } });
  assert.equal(exitCode, 3);
  assert.equal(written, `${DATAVERSE_OPERATIONS_LINE}\n`);
  let touched = false;
  lib.exitIfDataverseOperationsDisabled({ env: { GENPAGE_ENABLE_DATAVERSE_OPERATIONS: '1' }, exit: () => { touched = true; }, write: () => { touched = true; } });
  assert.equal(touched, false, 'ON is a no-op');
});

test('CLI probe: dataverse-operations prints "disabled" and exits 1 by default, "enabled" and 0 with the override; usage stays exit 2', () => {
  const env = { ...process.env };
  delete env.GENPAGE_ENABLE_DATAVERSE_OPERATIONS;
  const off = spawnSync(process.execPath, [libPath, 'dataverse-operations'], { encoding: 'utf8', env });
  assert.equal(off.status, 1, off.stderr);
  assert.equal(off.stdout, 'disabled\n');
  const on = spawnSync(process.execPath, [libPath, 'dataverse-operations'], { encoding: 'utf8', env: { ...env, GENPAGE_ENABLE_DATAVERSE_OPERATIONS: '1' } });
  assert.equal(on.status, 0, on.stderr);
  assert.equal(on.stdout, 'enabled\n');
  const usage = spawnSync(process.execPath, [libPath], { encoding: 'utf8', env });
  assert.equal(usage.status, 2);
});
