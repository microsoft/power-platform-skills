const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { createTempProject } = require('./test-utils');

function runCreateSiteSetting(args) {
  const cliPath = path.join(__dirname, '..', 'create-site-setting.js');
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
  });
}

test('create-site-setting creates a value-backed site setting', (t) => {
  const projectRoot = createTempProject(t);
  const result = runCreateSiteSetting([
    '--projectRoot', projectRoot,
    '--name', 'Webapi/test/enabled',
    '--value', 'true',
    '--description', 'Enable test setting',
    '--type', 'boolean',
  ]);

  assert.equal(result.status, 0, result.stderr);

  const parsed = JSON.parse(result.stdout);
  const yaml = fs.readFileSync(parsed.filePath, 'utf8');

  assert.match(parsed.filePath, /Webapi-test-enabled\.sitesetting\.yml$/);
  assert.match(yaml, /^description: Enable test setting$/m);
  assert.match(yaml, /^name: Webapi\/test\/enabled$/m);
  assert.match(yaml, /^value: true$/m);
});

test('create-site-setting creates an environment-variable-backed site setting', (t) => {
  const projectRoot = createTempProject(t);
  const result = runCreateSiteSetting([
    '--projectRoot', projectRoot,
    '--name', 'TestEnvABC',
    '--envVarSchema', 'ABC',
  ]);

  assert.equal(result.status, 0, result.stderr);

  const parsed = JSON.parse(result.stdout);
  const yaml = fs.readFileSync(parsed.filePath, 'utf8');

  assert.match(yaml, /^envvar_schema: ABC$/m);
  assert.match(yaml, /^name: TestEnvABC$/m);
  assert.match(yaml, /^source: 1$/m);
  assert.doesNotMatch(yaml, /^value:/m);
  assert.doesNotMatch(yaml, /^description:/m);
});

test('create-site-setting rejects mixing environment-variable and value inputs', (t) => {
  const projectRoot = createTempProject(t);
  const result = runCreateSiteSetting([
    '--projectRoot', projectRoot,
    '--name', 'TestEnvABC',
    '--envVarSchema', 'ABC',
    '--value', 'ignored',
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot be combined with --value or --description/);
});

// --- YAML quoting edge cases ---
//
// The YAML writer must quote values that would change meaning when read back
// by a YAML 1.2 parser. The body-of-value character-class regex catches most
// cases, but a few values look harmless but still need quoting because they
// rely on the LEADING character.

function getWrittenYaml(t, settingName, value) {
  const projectRoot = createTempProject(t);
  const result = runCreateSiteSetting([
    '--projectRoot', projectRoot,
    '--name', settingName,
    '--value', value,
    '--description', 'test',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  return fs.readFileSync(parsed.filePath, 'utf8');
}

test('quotes values starting with a hyphen (would be a YAML sequence indicator unquoted)', (t) => {
  const yaml = getWrittenYaml(t, 'Test/HyphenLeading', '-foo');
  assert.match(yaml, /^value: "-foo"$/m);
});

test('quotes values starting with a single quote (would open an unterminated quoted scalar)', (t) => {
  const yaml = getWrittenYaml(t, 'Test/SQuoteLeading', "'foo");
  assert.match(yaml, /^value: "'foo"$/m);
});

test('quotes values starting with a double quote (would open an unterminated quoted scalar)', (t) => {
  const yaml = getWrittenYaml(t, 'Test/DQuoteLeading', '"foo');
  // The leading literal " in the value gets backslash-escaped inside the JSON-style YAML quoted scalar
  assert.match(yaml, /^value: "\\"foo"$/m);
});

test('quotes values starting with a tab character (not allowed by YAML 1.2 in plain scalars)', (t) => {
  const yaml = getWrittenYaml(t, 'Test/TabLeading', '\tfoo');
  assert.match(yaml, /^value: "\tfoo"$/m);
});

test('quotes YAML 1.2 bareword reserved values: true / false / null', (t) => {
  // These are strings the caller passed as the --value, but YAML would read them
  // back as boolean true/false/null. The site-setting code passes booleans
  // through --type=boolean, so `--value true` (without --type=boolean) means
  // the string "true". Without quoting, the YAML parser would re-coerce.
  assert.match(getWrittenYaml(t, 'Test/StrTrue',  'true'),  /^value: "true"$/m);
  assert.match(getWrittenYaml(t, 'Test/StrFalse', 'false'), /^value: "false"$/m);
  assert.match(getWrittenYaml(t, 'Test/StrNull',  'null'),  /^value: "null"$/m);
});

test('does NOT quote ordinary values with no special characters or leading indicators', (t) => {
  // Regression guard: the leading-character check must not over-quote plain
  // values. A value like "Contoso Portal" or "/signin-EntraExternal" should
  // emit as a bareword scalar.
  const yaml1 = getWrittenYaml(t, 'Test/PlainText', 'Contoso Portal');
  assert.match(yaml1, /^value: Contoso Portal$/m);
  const yaml2 = getWrittenYaml(t, 'Test/PathLike', '/signin-EntraExternal');
  assert.match(yaml2, /^value: \/signin-EntraExternal$/m);
});

// --- Writer / loader round-trip ---
//
// The whole point of the C5 quoting is that a value's meaning survives a
// round-trip through the YAML file. Without a symmetric unquote in the
// loader (powerpages-config.js#parseYamlScalar), the writer's quotes would
// be read back as literal characters, corrupting subsequent reads. Verify
// that loadSiteSettings() returns the ORIGINAL input string.

const { loadSiteSettings } = require('../lib/powerpages-config');

function roundTrip(t, settingName, value) {
  const projectRoot = createTempProject(t);
  const result = runCreateSiteSetting([
    '--projectRoot', projectRoot,
    '--name', settingName,
    '--value', value,
    '--description', 'round-trip test',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const siteSettingsDir = path.join(projectRoot, '.powerpages-site', 'site-settings');
  const settings = loadSiteSettings(siteSettingsDir);
  const found = settings.find(s => s.name === settingName);
  assert.ok(found, `setting ${settingName} not found after write`);
  return found;
}

test('round-trip preserves value with leading hyphen', (t) => {
  const setting = roundTrip(t, 'Test/RT/Hyphen', '-foo');
  assert.equal(setting.value, '-foo');
});

test('round-trip preserves value with embedded quotes', (t) => {
  const setting = roundTrip(t, 'Test/RT/EmbeddedQuotes', 'He said "hi"');
  assert.equal(setting.value, 'He said "hi"');
});

test('round-trip preserves YAML 1.2 reserved-bareword strings as strings (not coerced)', (t) => {
  // The writer quotes these to defend against bareword coercion; the loader
  // must unquote them back to the string. Without the C5 round-trip fix the
  // loader would return either the boolean true/false/null OR the literal
  // string with quote characters embedded.
  assert.equal(roundTrip(t, 'Test/RT/StrTrue',  'true').value,  'true');
  assert.equal(roundTrip(t, 'Test/RT/StrFalse', 'false').value, 'false');
  assert.equal(roundTrip(t, 'Test/RT/StrNull',  'null').value,  'null');
});

test('round-trip preserves value containing a literal backslash', (t) => {
  // \\ is the writer's escape for a literal backslash; the loader must unescape it.
  const setting = roundTrip(t, 'Test/RT/Backslash', 'back\\slash');
  assert.equal(setting.value, 'back\\slash');
});
