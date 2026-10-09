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
    './lib/sdk-http-client.js': {
      createAzHttpClient: (env) => {
        events.push({ type: 'client', env });
        return { marker: 'az-client', env };
      },
    },
    './vendor/cds-maker-sdk.cjs': {
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

// --- the documents that send the planner to it ------------------------------------------------------------

const PLUGIN = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(PLUGIN, ...parts), 'utf8');
// Whitespace folded and a block quote's `> ` marker dropped: the documents wrap their lines and the checks below read
// sentences.
const squash = (text) => text.replace(/^>\s?/gm, '').replace(/\s+/g, ' ');
// The planner's own section on language detection, up to the next `### ` heading.
function languageSection() {
  const planner = read('agents', 'genpage-planner.md');
  const start = planner.indexOf('### Detect Configured Languages');
  const end = planner.indexOf('\n### ', start + 1);
  assert.ok(start !== -1 && end !== -1, 'the planner has a Detect Configured Languages section');
  return planner.slice(start, end);
}

test('the planner, the genpage skill and the references run the script first — `pac model list-languages` only comes after it', () => {
  for (const parts of [['agents', 'genpage-planner.md'], ['skills', 'genpage', 'SKILL.md'], ['references', 'localization.md'], ['references', 'rules.md'], ['references', 'plan-schema.md']]) {
    const text = read(...parts);
    const script = text.indexOf('list-languages.js');
    const pac = text.indexOf('pac model list-languages');
    assert.ok(script !== -1, `${parts.join('/')} names the script`);
    assert.ok(pac === -1 || script < pac, `${parts.join('/')} names the script before the command that falls back on it`);
  }
  const section = languageSection();
  assert.match(section, /^node "\$\{PLUGIN_ROOT\}\/scripts\/list-languages\.js" --env '<envUrl>'$/m);
  assert.match(section, /`<LCID> <Code> \u2014 RTL: Yes\|No`/, 'the line the plan carries is unchanged');
  assert.match(squash(read('skills', 'genpage', 'SKILL.md')), /Language detection \(`node "\$\{PLUGIN_ROOT\}\/scripts\/list-languages\.js" --env '<envUrl>'`; when that exits non-zero, `pac model list-languages --environment '<envUrl>'` \u2014 the Azure CLI is not needed here\) \u2014 only on new-page path/);
});

test('the planner falls back to `pac model list-languages` on ANY non-zero exit of the script — decided by the exit status, never by a phrase of the message', () => {
  const section = languageSection();
  const text = squash(section);
  // The script first, then the rule, then `pac` as a command of its own in a fenced block.
  const script = section.indexOf('node "${PLUGIN_ROOT}/scripts/list-languages.js"');
  const rule = section.indexOf('**Any non-zero exit');
  const pac = section.search(/^pac model list-languages --environment '<envUrl>'$/m);
  assert.ok(script !== -1 && script < rule && rule < pac, `script ${script} < rule ${rule} < pac ${pac}`);
  assert.match(section, /```powershell\r?\npac model list-languages --environment '<envUrl>'\r?\n```/);
  assert.match(text, /decide by the exit status, never by the wording of the message/);
  // A script that never answers is a failure too: what ends it is the shell tool giving up, not an exit status.
  assert.match(text, /\*\*Any non-zero exit \u2014 or no answer before your shell tool gives up \u2014 means the script could not read the languages; decide by the exit status, never by the wording of the message\.\*\*/);
  // The fallback reads the environment the script was given. Without `--environment`, `pac` answers for the active organization of its
  // auth profile, and the plan would carry another environment's languages under this environment's URL.
  assert.match(text, /Pass the same `<envUrl>` the script was given: without `--environment`, `pac` answers for the active organization of its auth profile, which is not necessarily the environment this plan is for/);
  // What the rule must not be: a trigger on a phrase. The sign-in advice `Run 'az login' first` is what ONE of the
  // client's failures says; a missing Azure CLI, a slow one and a token another tenant refuses say something else,
  // and the planner took each of those for "any other failure", reported it and stopped.
  assert.doesNotMatch(text, /Run 'az login' first/);
  // And no failure turns into a request that the user sign in: this flow works without `az`.
  assert.doesNotMatch(text, /needs_input/);
  assert.match(text, /do not stop and do not ask the user to run `az login`/);
  assert.match(text, /`\/genpage` has never needed `az` for a page over existing entities or mock data/);
  // `<envUrl>` is the column `pac auth list` prints ("Environment Url"); `Org URL:` is the line of `pac org who`.
  assert.match(text, /`<envUrl>` is the selected environment's `Environment Url` from the `pac auth list` table \(Step 2; the `Org URL:` line of `pac org who` is the same address\)/);
});

test('the planner says it fell back — in the log and in its report of the environment — and stops only when pac fails too', () => {
  const text = squash(languageSection());
  assert.match(text, /Then \*\*say that you did\*\*/);
  assert.match(text, /In `workflow-log\.md`, record the script's command line with its result \(its stdout, or its stderr when stdout is empty\), and then the `pac model list-languages` line with its table, each verbatim/);
  assert.match(text, /In your report of the environment, say so: "Languages read with `pac model list-languages`: the languages script could not read them/);
  assert.match(text, /If `pac model list-languages` fails as well, report that and stop\. Never assume the environment is English-only/);
  // A failed read prints its JSON on stdout; a usage error exits 1 before any read and prints nothing there.
  assert.match(text, /A failed read prints `\{ "ok": false, "error": "\u2026", "code": "\u2026" \}` on stdout \(`code` only when the SDK gave one\); a usage error, such as an `--env` that carries a path, prints nothing there and names the flag on stderr/);
  // The commands a log records verbatim include the fallback, as it is run: pinned to the environment.
  assert.match(squash(read('agents', 'genpage-planner.md')), /`` `pac model list-languages --environment '<envUrl>'` `` \(the fallback below\)/);
  // The section stops in one place only: when pac fails too. A second stop — on one code of the script, say — would keep the planner from the
  // fallback for the very failures the fallback is for. Its words say "stop" twice: "do not stop" (for az) and "report that and stop".
  assert.strictEqual((text.match(/\bstop\b/gi) || []).length, 2, 'no stop but the two this test names');
  assert.match(text, /do not stop and do not ask the user to run `az login`/);
});

test('README\u2019s promise — /genpage works without az for pages over existing entities or mock data — is still true: its one az read falls back to pac', () => {
  const readme = squash(read('README.md'));
  assert.match(readme, /Without `az`, the `\/genpage` skill still works for pages over existing entities or mock data \u2014 it only fails when entity creation is needed\./);
  assert.match(readme, /Detecting the environment's languages uses `az` when it is signed in and falls back to `pac model list-languages --environment '<envUrl>'` when it is not\./);
  // The planner's section is what makes the sentence true: without the fallback the first step of every new page needs az.
  assert.match(squash(languageSection()), /fall back to the command that read the languages before this script, which signs in through `pac`/);
});

// Without `--environment`, `pac model list-languages` answers for the ACTIVE organization of pac's auth profile — not necessarily the environment the
// plan is for — so a document that tells the planner to run it, or names it as the fallback, names the pinned command. (The planner's own section is
// pinned above, where it gives the command; its later sentences refer to it by name.)
test('every document that names the fallback names it pinned to the environment', () => {
  for (const parts of [['skills', 'genpage', 'SKILL.md'], ['README.md'], ['references', 'localization.md'], ['references', 'plan-schema.md'], ['references', 'rules.md'], ['AGENTS.md']]) {
    const text = read(...parts);
    assert.ok(text.includes('pac model list-languages'), `${parts.join('/')} names the fallback`);
    assert.deepStrictEqual(text.match(/pac model list-languages(?! --environment '<envUrl>')/g) || [], [], `${parts.join('/')} names it without --environment`);
  }
});

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
