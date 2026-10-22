'use strict';
// scripts/list-languages.js, end to end through its main(): flags, the origin check, the one SDK read, the planner's
// output, and the throwaway workspace — with the SDK and the HTTP client stubbed (the real bundle is driven in
// list-languages-real-bundle.test.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadCli } = require('./helpers/cli-harness.js');
const realAuth = require('../lib/dataverse-auth.js');
const { withThrowawaySdk } = require('../lib/throwaway-sdk.js');

const SCRIPT = path.resolve(__dirname, '..', 'list-languages.js');
const ENV = 'https://contoso.crm.dynamics.com';

// Runs main() with `argv`. `answer` is what `getEnvironmentLanguages` resolves, or a function that rejects/throws.
// The stubbed emitResult ends the run the way the real one does (process.exit), so a test can see what came after.
async function run(argv, answer = { baseLanguage: 1033, provisioned: [1033], available: [1033] }) {
  const events = [];
  const emitted = [];
  const emitOptions = [];
  const requires = {
    './lib/dataverse-auth.js': {
      ...realAuth,
      emitResult: (ok, payload, options) => {
        emitted.push({ ok, payload });
        emitOptions.push(options);
        const exit = new Error(`process.exit(${ok ? 0 : 1})`);
        exit.exitCode = ok ? 0 : 1;
        throw exit;
      },
    },
    // The throwaway-workspace lifecycle is the real one (lib/throwaway-sdk.js); only the SDK and the client it makes are stubs.
    './lib/throwaway-sdk.js': {
      withThrowawaySdk: (options, runWith) => withThrowawaySdk({
        ...options,
        deps: {
          createAzHttpClient: (env) => {
            events.push({ type: 'client', env });
            return { marker: 'az-client', env };
          },
          makerSdk: {
            createNodeWorkspaceStorage: (dir) => ({ dir }),
            createMakerSdk: (cfg) => {
              events.push({ type: 'sdk', cfg });
              // Only the one method the script may call: any other (initWorkspace, a workspace read) is a TypeError.
              return {
                getEnvironmentLanguages: async () => {
                  events.push({ type: 'getEnvironmentLanguages' });
                  if (typeof answer === 'function') return answer();
                  return answer;
                },
              };
            },
          },
        },
      }, runWith),
    },
  };
  const cli = loadCli(SCRIPT, { requires, argv });
  let exitCode = 0;
  try {
    await cli.main();
  } catch (err) {
    if (typeof err.exitCode !== 'number') throw err;
    exitCode = err.exitCode;
  }
  const sdk = events.find((e) => e.type === 'sdk');
  return { events, emitted, emitOptions, exitCode, stderr: cli.stderrText(), stdout: cli.stdoutText(), workspaceDir: sdk && sdk.cfg.workspaceStorage.dir };
}

test('no --env is a usage error: nothing is read and no workspace is made', async () => {
  const r = await run([]);
  assert.strictEqual(r.exitCode, 1);
  assert.strictEqual(r.stdout, '', 'a usage error prints nothing on stdout: the planner reads a line there only for a failed read');
  assert.match(r.stderr, /Usage: node scripts\/list-languages\.js --env <envUrl>/);
  assert.deepStrictEqual(r.events, []);
  assert.deepStrictEqual(r.emitted, []);
});

test('an unknown flag, or --env with no value, is refused naming the flag', async () => {
  const typo = await run(['--envv', ENV]);
  assert.strictEqual(typo.exitCode, 1);
  assert.strictEqual(typo.stdout, '', 'nothing on stdout');
  assert.match(typo.stderr, /unknown flag\(s\): --envv \(did you mean --env\?\)/);
  assert.deepStrictEqual(typo.events, []);

  const bare = await run(['--env']);
  assert.strictEqual(bare.exitCode, 1);
  assert.strictEqual(bare.stdout, '', 'nothing on stdout');
  assert.match(bare.stderr, /--env requires a value/);
  assert.deepStrictEqual(bare.events, []);
});

test('an --env that is not a Dataverse https origin is refused before any token or SDK exists', async () => {
  for (const env of ['https://example.com', 'http://contoso.crm.dynamics.com', 'https://contoso.crm.dynamics.com/api/data/v9.2', 'contoso.crm.dynamics.com']) {
    const r = await run(['--env', env]);
    assert.strictEqual(r.exitCode, 1, env);
    assert.strictEqual(r.stdout, '', `${env}: nothing on stdout`);
    assert.match(r.stderr, /is not a Dataverse environment URL/, env);
    assert.match(r.stderr, /Usage: node scripts\/list-languages\.js/, env);
    assert.deepStrictEqual(r.events, [], `${env}: no client, no SDK`);
  }
});

test('it reads the languages once through the az-token client for the normalized origin, and prints the planner\u2019s JSON', async () => {
  const r = await run(['--env', 'https://Contoso.CRM.dynamics.com/'], { baseLanguage: 1033, provisioned: [1033, 1025, 1036], available: [1033, 1025, 1036, 3082] });
  assert.strictEqual(r.exitCode, 0);
  assert.deepStrictEqual(r.events.map((e) => e.type), ['client', 'sdk', 'getEnvironmentLanguages'], 'one client, one SDK, one read');
  assert.strictEqual(r.events[0].env, ENV, 'the client is built for the origin, lower-cased and without the slash');
  assert.strictEqual(r.events[1].cfg.instanceUrl, ENV);
  assert.strictEqual(r.events[1].cfg.httpClient.marker, 'az-client');

  assert.strictEqual(r.emitted.length, 1);
  const { ok, payload } = r.emitted[0];
  assert.strictEqual(ok, true);
  assert.strictEqual(payload.ok, true);
  assert.deepStrictEqual(Object.keys(payload).sort(), ['baseLanguage', 'languages', 'ok', 'summary', 'unmapped']);
  assert.strictEqual(payload.baseLanguage.lcid, 1033);
  assert.strictEqual(payload.baseLanguage.code, 'en-US');
  assert.deepStrictEqual(payload.languages.map((l) => [l.lcid, l.code, l.rtl]), [[1033, 'en-US', false], [1025, 'ar-SA', true], [1036, 'fr-FR', false]]);
  assert.deepStrictEqual(payload.unmapped, []);
  assert.deepStrictEqual(payload.summary, ['1033 en-US \u2014 RTL: No', '1025 ar-SA \u2014 RTL: Yes', '1036 fr-FR \u2014 RTL: No']);
  // Each language carries a name only as a courtesy: a string, or null where this host's Intl has none.
  for (const l of payload.languages) assert.ok(l.name === null || (typeof l.name === 'string' && l.name), `${l.lcid} name`);
  assert.strictEqual(r.stderr, '', 'a clean read prints nothing on stderr');
});

test('the throwaway workspace is removed after a read, and after a failed one', async () => {
  const ok = await run(['--env', ENV]);
  assert.ok(ok.workspaceDir, 'the SDK was given a workspace directory');
  assert.strictEqual(fs.existsSync(ok.workspaceDir), false, 'removed after a read');

  const bad = await run(['--env', ENV], () => { throw new Error('boom'); });
  assert.ok(bad.workspaceDir);
  assert.strictEqual(fs.existsSync(bad.workspaceDir), false, 'removed after a failed read');
});

test('a failed read exits 1 with the SDK\u2019s own code and message, never an English default', async () => {
  const unreadable = Object.assign(
    new Error('The org\u2019s languages could not be read: RetrieveProvisionedLanguages answered no list of language codes in \u2018RetrieveProvisionedLanguages\u2019. Nothing is assumed in its place \u2014 retry, or check the caller\u2019s access to the org.'),
    { code: 'ENVIRONMENT_LANGUAGES_UNREADABLE' }
  );
  const r = await run(['--env', ENV], () => { throw unreadable; });
  assert.strictEqual(r.exitCode, 1);
  assert.deepStrictEqual(r.emitted, [{ ok: false, payload: { ok: false, error: unreadable.message, code: 'ENVIRONMENT_LANGUAGES_UNREADABLE' } }]);
  assert.ok(!r.emitted.some((e) => e.ok), 'no success was emitted beside it');
});

test('a failure that carries no SDK code carries its message and no code field', async () => {
  const r = await run(['--env', ENV], async () => { throw new Error('boom'); });
  assert.strictEqual(r.exitCode, 1);
  assert.deepStrictEqual(r.emitted, [{ ok: false, payload: { ok: false, error: 'boom' } }]);
});

// What the real SDK throws when the az-token client cannot supply a token, or the platform refuses it, is a
// ConnectionError: `code: 'CONNECTION_ERROR'`, with `statusCode` 0 for a failure before any answer (the client's own
// error is wrapped, so an Azure CLI that is missing, signed out or slow reads like a dropped connection) and the HTTP
// status for a refusal. Those messages are the ones the real client and the real bundle produce
// (list-languages-real-bundle.test.js drives them through both). Nothing in them is a code the planner could match —
// which is why it falls back on the exit status alone — so what matters here is that every one of them is a LOUD
// failure: exit 1, `ok: false`, the message, and nothing that reads as an answer.
test('every Azure CLI or identity failure is an ordinary failed read: exit 1, `ok: false`, the SDK\u2019s CONNECTION_ERROR', async () => {
  const origin = `${ENV}/api/data/v9.0/organizations?$select=languagecode`;
  const failures = {
    'the Azure CLI is not installed': [0, `Transport failure reaching ${origin}: Could not get an Azure CLI token for ${ENV}: Azure CLI (\`az\`) is not on PATH. Install it from https://aka.ms/azure-cli and run \`az login\`.`],
    'the Azure CLI is signed out': [0, `Transport failure reaching ${origin}: Failed to get Azure CLI token for ${ENV}. Run 'az login' first.`],
    'the Azure CLI is too slow': [0, `Transport failure reaching ${origin}: Could not get an Azure CLI token for ${ENV}: \`az account get-access-token\` did not answer within 60 s.`],
    'the token is for another tenant': [401, `HTTP 401 from ${origin}: Unauthorized`],
    'the identity is not a user of the environment': [403, `HTTP 403 from ${origin}: The user is not a member of the organization.`],
  };
  for (const [why, [statusCode, message]] of Object.entries(failures)) {
    const failure = Object.assign(new Error(message), { code: 'CONNECTION_ERROR', statusCode });
    const r = await run(['--env', ENV], () => { throw failure; });
    assert.strictEqual(r.exitCode, 1, why);
    assert.deepStrictEqual(r.emitted, [{ ok: false, payload: { ok: false, error: message, code: 'CONNECTION_ERROR' } }], why);
    assert.strictEqual(r.stdout, '', `${why}: nothing but the emitted result`);
  }
});

test('an unknown BASE language is reported in `unmapped` and on stderr although it is not provisioned', async () => {
  const r = await run(['--env', ENV], { baseLanguage: 4096, provisioned: [1033], available: [1033] });
  assert.strictEqual(r.exitCode, 0);
  const { payload } = r.emitted[0];
  assert.deepStrictEqual(payload.baseLanguage, { lcid: 4096, code: null, name: null, rtl: null });
  assert.deepStrictEqual(payload.unmapped, [4096]);
  assert.deepStrictEqual(payload.languages.map((l) => l.lcid), [1033]);
  assert.match(r.stderr, /LCID 4096 has no culture code in this plugin's table/);
});

test('both outcomes are printed as pure ASCII: the script asks emitResult to escape every other character', async () => {
  const ok = await run(['--env', ENV]);
  assert.deepStrictEqual(ok.emitOptions, [{ ascii: true }]);
  const bad = await run(['--env', ENV], () => { throw new Error('boom'); });
  assert.deepStrictEqual(bad.emitOptions, [{ ascii: true }]);
});

test('an LCID the table cannot name is reported on stderr and in `unmapped`, with null in its place', async () => {
  const r = await run(['--env', ENV], { baseLanguage: 1033, provisioned: [1033, 4096], available: [1033] });
  assert.strictEqual(r.exitCode, 0);
  const { payload } = r.emitted[0];
  assert.deepStrictEqual(payload.unmapped, [4096]);
  assert.deepStrictEqual(payload.languages[1], { lcid: 4096, code: null, name: null, rtl: null });
  assert.strictEqual(payload.summary[1], '4096 unknown \u2014 RTL: unknown');
  assert.match(r.stderr, /LCID 4096 has no culture code in this plugin's table/);
});

test('the script is a CLI only when run directly, and exports the read for the real-bundle test', () => {
  const mod = require('../list-languages.js');
  assert.deepStrictEqual(Object.keys(mod), ['readLanguages']);
  assert.strictEqual(typeof mod.readLanguages, 'function');
});

// --- the planner's example --------------------------------------------------------------------------------
// There is no `pac model list-languages` behind the script (every /genpage page operation needs the Azure CLI, so a fallback that
// avoided it bought nothing), and scripts/tests/pac-fallback-commands.test.js pins that no script runs the command. What the DOCUMENTS
// say is pinned below: the planner, the skill and the references name the script as the only source, a failed read ends language
// detection, and README says that deploying a page needs `az`.

const PLUGIN = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(PLUGIN, ...parts), 'utf8');
// Whitespace collapsed (and a Windows checkout's CRLF with it), and a block quote's `>` markers dropped: the documents wrap their lines differently.
const squash = (text) => text.replace(/^[ \t]*>[ \t]?/gm, '').replace(/\s+/g, ' ');

test('the planner\u2019s example output is the shape — and the exact ASCII text — the script prints, field for field', () => {
  const { describeEnvironmentLanguages } = require('../lib/lcid-cultures.js');
  const block = /```json\r?\n(\{"ok":true[^\r\n]*\})\r?\n```/.exec(read('agents', 'genpage-planner.md'));
  assert.ok(block, 'the planner shows the script\u2019s JSON line');
  assert.match(block[1], /^[\x00-\x7e]*$/, 'the script prints pure ASCII, so the example does');
  assert.ok(block[1].includes('"1033 en-US \\u2014 RTL: No"'), 'the dash of a summary line is the \\uXXXX escape the script writes');
  const example = JSON.parse(block[1]);
  const real = { ok: true, ...describeEnvironmentLanguages({ baseLanguage: 1033, provisioned: [1033, 1025] }) };
  assert.deepStrictEqual(Object.keys(example), Object.keys(real));
  assert.deepStrictEqual(Object.keys(example.baseLanguage), Object.keys(real.baseLanguage));
  assert.deepStrictEqual(Object.keys(example.languages[0]), Object.keys(real.languages[0]));
  assert.deepStrictEqual(example.languages.map((l) => [l.lcid, l.code, l.rtl]), real.languages.map((l) => [l.lcid, l.code, l.rtl]));
  assert.deepStrictEqual(example.summary, real.summary);
});

// What the documents say about the languages. The planner is headless, so its text is the whole of the rule.
test('the planner reads the languages with the script alone, and a failed read ends language detection — it reports why, stops, and never assumes English', () => {
  const planner = squash(read('agents', 'genpage-planner.md'));
  assert.match(planner, /with the plugin's own script\. It is the only source: it reads them through the SDK with the Azure CLI \(`az`\) token, which every `\/genpage` page operation needs anyway\./);
  assert.match(planner, /\*\*Any non-zero exit — or no answer before your shell tool gives up — means the script could not read the languages; decide by the exit status, never by the wording of the message\.\*\*/);
  assert.match(planner, /the SDK reports all of these alike, as `CONNECTION_ERROR`, so no code tells them apart\./);
  assert.match(planner, /\*\*A failed read ends language detection: report why and stop\.\*\*/);
  assert.match(planner, /Never assume the environment is English-only — the plan's localization decision depends on this answer — and never read languages from any other source: there is none\./);
  assert.match(planner, /record the command and that result in `workflow-log\.md` verbatim/);
  // The retired advice: do not stop, do not ask for az login, fall back to pac, and say so.
  assert.doesNotMatch(planner, /has never needed `az`|do not stop and do not ask the user to run `az login`|fall back to the command that read the languages|Languages read with|\(the fallback below\)|when you fell back to it/);
  // The skill's Phase 1 says the same in a line.
  assert.match(squash(read('skills', 'genpage', 'SKILL.md')), /Language detection \(`node "\$\{PLUGIN_ROOT\}\/scripts\/list-languages\.js" --env '<envUrl>'` — the only source of the environment's languages: when it fails, report why and stop, never assume the environment is English-only\)/);
});

test('no document names a fallback for the languages: the planner, the skill, the references and README name the script alone', () => {
  for (const parts of [['agents', 'genpage-planner.md'], ['skills', 'genpage', 'SKILL.md'], ['references', 'localization.md'], ['references', 'plan-schema.md'], ['references', 'rules.md'], ['README.md']]) {
    const text = squash(read(...parts));
    assert.doesNotMatch(text, /pac model list-languages/, `${parts.join('/')} names the retired fallback`);
    assert.doesNotMatch(text, /fell back to|its fallback is|or its fallback|when that script cannot read them/i, `${parts.join('/')} still describes a fallback`);
  }
  assert.match(squash(read('references', 'localization.md')), /non-English language via `scripts\/list-languages\.js`\. English-only environments/);
  assert.match(squash(read('references', 'localization.md')), /\(run by the planner during requirements gathering; it is the only source of the environment's languages\)/);
  assert.match(squash(read('references', 'plan-schema.md')), /marked `— RTL` when `scripts\/list-languages\.js` reports `rtl: true` for it — e\.g\./);
  assert.match(squash(read('references', 'rules.md')), /only when `scripts\/list-languages\.js` reports multiple configured languages OR any non-English language\./);
});

// README's account of `az`: it is what every Dataverse call authenticates with, generative pages included (they are written through the SDK, not through `pac model genpage`), and the language read has no
// `pac` fallback — so a deploy needs `az`, and a machine without it gets the reason, never an English default. The README that said /genpage worked without `az` for a page over existing entities or
// mock data was true only while a `pac` fallback stood behind the language read and `pac` wrote the pages; neither is so now. Its account of what `pac` is still for — sign-in, the environment, the
// version, where it steps in for three scripts and a tabular connector's tables and columns — is pinned here too, since a README that still gave `pac` the type generator would send an agent to a command that is gone.
test('README says az is needed for every Dataverse call, pages included, that the language read has no pac fallback, and what pac is still for', () => {
  const readme = squash(read('README.md'));
  assert.match(readme, /\| \[Azure CLI\]\([^)]*\) \(`az`\) \| Every Dataverse call — tables, apps, languages, entity creation and generative pages — and the Power Apps service token that reading connections and connector metadata uses \|/);
  assert.match(readme, /`az` is what every Dataverse call authenticates with — listing tables, apps and languages, entity creation, and the generative pages themselves, which are written, read and deleted through the bundled SDK, not through `pac model genpage`/);
  assert.match(readme, /\*\*Deploying a page needs `az`\*\*, and so does detecting the environment's languages: there is no `pac` fallback for either, so a missing or signed-out `az` ends language detection with the reason, never with an English default\./);
  assert.match(readme, /`pac` signs you in and chooses the environment, and steps in for the connection, connector and deployment-settings scripts only where the SDK has no route or refuses \(`connectionsSource` or `source` says which answered; `connectionsFallback` or `fallback` says why the SDK did not\)\. It also lists a tabular connector's tables \(`pac model genpage list-connector-tables`; no script wraps it\), and `scripts\/connector\.js schema --dataset --table` reads a table's columns through `pac`: the plugin cannot build the client the SDK reads a connector's tables with\. The type generator, the page listing and download, and putting a page in an app, taking it out and deleting it are the SDK's too \(`scripts\/genpage\.js`\), so they need `az` and no `pac`\./);
  // The promise the old paragraph made, and the fallback that backed it, are gone.
  assert.doesNotMatch(readme, /Without `az`, the `\/genpage` skill still works|falls back to `pac model list-languages`|uses `az` when it is signed in/);
  // The prerequisites table names what `pac` is still for — sign-in, the environment and the version, the three fallbacks, a tabular connector's table columns and the one list no script wraps — not the commands the scripts replaced.
  assert.match(readme, /\| \[PAC CLI\]\([^)]*\) > 2\.10\.0 \| Signing in, choosing the environment and reading the CLI version \(`pac auth`, `pac org who`, `pac help`\); the fallbacks of the connection, connector and deployment-settings scripts; reading a tabular connector's table columns \(`scripts\/connector\.js schema --dataset --table`\); and listing a tabular connector's tables, which no script wraps \(`pac model genpage list-connector-tables`\) \|/);
  assert.doesNotMatch(readme, /Schema generation, app creation, table listing, deployment|type generator \(`pac model genpage generate-types`\)|runs `pac model genpage generate-types`|schema generation \(`generate-types`\)/);
  // The steps and the technology list say the same: the schema is `genpage.js types`, and pac is sign-in, the environment, the fallbacks and a tabular connector's tables and columns.
  assert.match(readme, /6\. \*\*Generate schema\*\* — runs `scripts\/genpage\.js types` \(the SDK's type generator\) for Dataverse entity pages/);
  assert.match(readme, /- \*\*PAC CLI\*\* — sign-in and environment choice, the fallbacks of the connection, connector and deployment-settings scripts, and a tabular connector's tables and columns \(`pac model genpage list-connector-tables`, `scripts\/connector\.js schema --dataset --table`\); pages, their schema and their listing, download and removal go through the bundled SDK/);
});

// README's account of where a deployed page lands: a page needs no app, and it is in an app's navigation only when the upload names the app (`--app-id`) AND asks for the placement
// (`--add-to-sitemap`). An app named alone only pins the default views of the page's tables — genpage-upload.js does exactly that (genpage-upload.test.js pins it), and refuses the
// placement without the app. The README that said a page "is added to one when you name it" left out the second flag.
test('README says a page is added to an app\'s navigation only when the upload names the app and asks for the placement, and that the app alone only pins its tables\' views', () => {
const readme = squash(read('README.md'));
assert.match(readme, /8\. \*\*Deploy\*\* — writes the page through the bundled SDK \(`scripts\/genpage-upload\.js`\); a page needs no app, and is added to an app's navigation only when the upload names the app \(`--app-id`\) and asks for the placement \(`--add-to-sitemap`\) — `--app-id` alone only pins the default views of the page's tables in the app\. For a new app the first page is deployed first, then the app is created from it, then the other pages are added/);
assert.doesNotMatch(readme, /is added to one when you name it/);
});

// --- end to end: the real script in a real process ---------------------------------------------------------
// What the planner's rule leans on — exit 0 with one line it can read, exit 1 with an `ok: false` line for every
// failure — and what keeps the line readable on any console code page (pure ASCII on stdout) are properties of a PROCESS, not of main().

const { spawnSync } = require('node:child_process');
const os = require('node:os');
const PRELOAD = path.resolve(__dirname, 'helpers', 'fake-org-languages-preload.js');

const runScript = (env, nodeArgs = []) => spawnSync(process.execPath, [...nodeArgs, SCRIPT, '--env', ENV], { env, encoding: 'utf8', timeout: 120000 });
const stdoutLines = (r) => r.stdout.split(/\r?\n/).filter(Boolean);

test('END TO END: against a fake org the real script prints one pure-ASCII JSON line, which decodes to the planner\u2019s shape, and exits 0', () => {
  const org = { base: 1033, provisioned: [1033, 1025, 1044], available: [1033, 1025, 1044] };
  const r = runScript({ ...process.env, FAKE_ORG_LANGUAGES: JSON.stringify(org) }, ['--require', PRELOAD]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stderr, '');
  assert.strictEqual(stdoutLines(r).length, 1, 'one line');
  // A raw dash would reach a Windows PowerShell 5.1 capture as mojibake (UTF-8 read as the OEM code page): the line
  // carries escapes instead.
  assert.match(r.stdout, /^[\x00-\x7e\r\n]*$/, 'pure ASCII');
  assert.ok(r.stdout.includes('\\u2014'), 'the summary lines\u2019 dash is an escape');
  const result = JSON.parse(stdoutLines(r)[0]);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.summary, ['1033 en-US \u2014 RTL: No', '1025 ar-SA \u2014 RTL: Yes', '1044 nb-NO \u2014 RTL: No']);
  assert.deepStrictEqual(result.languages.map((l) => l.lcid), [1033, 1025, 1044]);
  assert.deepStrictEqual(result.unmapped, []);
});

test('END TO END: a refused read prints one `ok: false` ASCII line on stdout, the message as written on stderr, and exits 1', () => {
  const refuse = { status: 403, message: 'The user \u2014 is not a member of the organization.' };
  const r = runScript({ ...process.env, FAKE_ORG_LANGUAGES: JSON.stringify({ refuse }) }, ['--require', PRELOAD]);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(stdoutLines(r).length, 1, 'one line');
  assert.match(r.stdout, /^[\x00-\x7e\r\n]*$/, 'pure ASCII');
  const result = JSON.parse(stdoutLines(r)[0]);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'CONNECTION_ERROR');
  assert.ok(result.error.includes('HTTP 403') && result.error.includes('The user \u2014 is not a member of the organization.'), result.error);
  assert.ok(!('languages' in result) && !('baseLanguage' in result), 'nothing that reads as an answer');
  assert.ok(r.stderr.includes('The user \u2014 is not a member'), 'stderr is for people: the message, not escaped');
});

test('END TO END, with the Azure CLI not on PATH: exit 1 and an `ok: false` line — no languages, and no English default in their place', () => {
  const { resolveExecutable } = require('../lib/process-runner.js');
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'no-az-'));
  try {
    const env = { ...process.env };
    // Windows names the variable `Path`, and a second spelling beside it would leave the child one of the two.
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
    env.PATH = emptyPath;
    assert.strictEqual(resolveExecutable('az', { env }), null, 'the premise: no `az` is found under this PATH');
    const r = runScript(env);
    assert.strictEqual(r.status, 1, r.stderr);
    assert.strictEqual(stdoutLines(r).length, 1, 'one line');
    const result = JSON.parse(stdoutLines(r)[0]);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'CONNECTION_ERROR');
    assert.match(result.error, /Azure CLI/, 'it says what failed');
    assert.ok(!('languages' in result) && !('baseLanguage' in result), 'no answer, not even an English one');
    assert.match(r.stderr, /Azure CLI/);
  } finally {
    fs.rmSync(emptyPath, { recursive: true, force: true });
  }
});
