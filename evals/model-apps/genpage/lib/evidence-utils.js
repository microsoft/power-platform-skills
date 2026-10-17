'use strict';

// HOW THE GRADERS READ A RECORDED COMMAND
//
// A command a grader reads — an event's `command` (and its `argv`, when it records one), or a line of a workflow log — is TEXT. The graders are not a shell: nothing here executes, expands,
// evaluates or follows what it reads, and no shell's grammar is modelled. What is read beyond the words is the verb of the plugin's scripts that take one (apps.js, genpage.js,
// solution-settings.js), and it is read the way the script reads its argv (`scriptRuns`):
//
//   - The text is cut into words (`tokenize`, line by line). A "double-quoted" or 'single-quoted' run is ONE word and loses its quotes, so a quoted mention — `--search "apps.js create"` —
//     is data, not a run.
//   - A RUN of a script is a word that is the script's path, in any letter case: `apps.js`, `scripts/apps.js`, `'D:/repo/…/apps.js'`, `.\scripts\apps.js`, also inside a Markdown code span. The words after
//     it are its arguments.
//   - The verb is the script's first positional argument, after its flags: `apps.js --env <url> create …` is `create`, as `apps.js create --env <url> …` is. A flag takes the next word unless that
//     starts with `--`, as lib/dataverse-auth.js parseArgs, which both scripts call, reads it — except a SWITCH (`--publish`, `--allow-destructive`: a flag the script's own flag list gives no value),
//     which takes none, so a switch in front of the verb does not hide it. solution-settings.js reads its verb as its first argument, and so is it read.
//   - EVERY run counts. `apps.js list …; apps.js create …` is two runs, and a call is a mutation when any one of them writes (workflow-evidence.js `isMutation`): a grader that read only the first
//     run missed the write behind a read. An event's argv is read after its text, as the arguments the text goes on with, so the verb may be in either.
//
// What is NOT done, by design — a reader of recorded text that modelled shell syntax would need a shell, and never be finished. A command is graded on the words it has:
//   - a command line handed to a wrapper as ONE string — `bash -c '…'`, `cmd /c "…"`, `pwsh -Command "…"`, `eval "…"` — is one quoted word, which is data: the run inside it is not read (the names
//     that only write, such as `genpage-upload.js`, `provision-entities.js` or `pac solution import`, are still found anywhere in the text);
//   - a variable (`$cmd`, `%CMD%`), a command substitution, an alias, an escape, a line continuation or a script run by another script is not expanded or followed, and the text of a here-document
//     is read as if it were commands;
//   - prose is not told from a command: a log line that names `apps.js create` after a read reads as a write (fail-closed), and a mention in a sentence that is not quoted reads as a run;
//   - `;`, `&&`, `||`, `|` and a newline are not told apart, and the flags of the commands of one call are read as one list: the environment a write is compared with its auth gate by is the
//     call's last `--env`, and a write in the same call as its gate is not judged against that gate;
//   - a quote that has no partner on its line is dropped, and a stray one in unquoted prose hides the words up to its partner;
//   - only the verbs of the three scripts above are read from the words; the other mutations are named in `isMutation` and found anywhere in the text. The phase expectations (expectation-evidence.js)
//     read a call's text and count a call once, however often it names a run, where `isMutation` also reads an event's argv.
// The graders' tests pin these limits (tests/script-verbs.test.js), so a change to the reading model has to change this comment with it.

const pathKey = (name) => String(name || '').replace(/\\/g, '/');
const fileName = (name) => pathKey(name).split('/').at(-1);
const isGuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function artifactText(fixture, name) {
  const key = pathKey(name);
  const value = fixture.artifacts?.[key] ?? fixture.files?.find((file) => file.name === key)?.content;
  if (typeof value !== 'string') throw new Error(`missing artifact ${key || '(no path)'}`);
  return value;
}

function artifactJson(fixture, name) {
  try { return JSON.parse(artifactText(fixture, name).replace(/^\uFEFF/, '')); } catch (error) {
    throw new Error(`${name}: ${error.message}`);
  }
}

// Recorded command text as tokens. A token is a "double-quoted" or 'single-quoted' run, which loses
// its quotes, or a run of other text up to a space or a quote; a quote with no partner is dropped.
//
// One join: a quoted run right after a `--flag=` token is that flag's value. The shell passes
// `--env='https://contoso.crm.dynamics.com'` to the script as the ONE argument
// `--env=https://contoso.crm.dynamics.com`; as two tokens, the URL was the first positional argument,
// so the graders took it for the verb and missed the write after it (`apps.js --env='…' create`).
// Nothing else is joined, though a shell would join more: a log writes the command inside markdown
// backticks (`node … --app-id '…'`), and the closing backtick right after a quoted value is no part
// of that value.
function tokenize(text) {
  const tokens = [];
  let end = -1;
  for (const match of text.matchAll(/"[^"]*"|'[^']*'|[^\s"']+/g)) {
    const quoted = /^["']/.test(match[0]);
    const value = quoted ? match[0].slice(1, -1) : match[0];
    if (quoted && match.index === end && /^--[\w-]+=$/.test(tokens.at(-1))) tokens[tokens.length - 1] += value;
    else tokens.push(value);
    end = match.index + match[0].length;
  }
  return tokens;
}

function commandInfo(call) {
  // Current evidence may keep argv directly. The fallback only tokenizes recorded command TEXT;
  // it never expands variables, evaluates quotes or executes a shell. Maker text must be in files,
  // so the current transport does not need a shell parser for arbitrary prompt/name contents.
  const tokens = call.argv || tokenize(String(call.command || ''));
  const flags = {};
  const positional = [];
  const problems = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const match = /^--([\w-]+)(?:=(.*))?$/.exec(tokens[i]);
    if (!match) { positional.push(tokens[i]); continue; }
    const name = match[1];
    if (Object.hasOwn(flags, name)) problems.push(`duplicate --${name}`);
    flags[name] = match[2] !== undefined ? match[2]
      : tokens[i + 1] && !tokens[i + 1].startsWith('--') ? tokens[++i] : true;
  }
  return { flags, positional, problems };
}

// --- The verb of a script's run ----------------------------------------------------------------------------------------------------------------------------------------------------

// A word without the Markdown backticks a log puts around a command (`node scripts/apps.js list`).
const unticked = (word) => String(word).replace(/^`+|`+$/g, '');
// A flag as lib/dataverse-auth.js parseArgs reads it: `--name`, or `--name=value` (the value may hold `=`).
const FLAG = /^--([\w-]+)(?:=(.*))?$/;
// The scripts that read their verb as their first argument — solution-settings.js is `const [command, ...rest] = argv` — and not as the first positional one after flags.
const FIRST_ARGUMENT = new Set(['solution-settings.js']);

// The flags of apps.js and genpage.js that take NO value: those a script's own flag declaration (`known` minus `needValue`, the contract its `validateFlags` holds a call to) lists as known and
// gives none. The scripts' argument reader (parseArgs) hands the next word to ANY flag, so `genpage.js --allow-destructive delete …` is, to the script, a call with no command, and it answers with
// a usage error; a grader that read it that way would read nothing where the call meant a delete. A switch takes none, and the verb after it is the verb. The declarations are the scripts' own, read
// when a flag first stands before a verb: the usual `apps.js list --env …` never needs them.
const FLAG_DECLARATIONS = { 'apps.js': 'COMMANDS', 'genpage.js': 'VERBS' };
const switchesOf = new Map();
function scriptSwitches(script) {
  if (!switchesOf.has(script)) {
    const declared = FLAG_DECLARATIONS[script];
    const commands = declared ? Object.values(require(`../../../../plugins/model-apps/scripts/${script}`)[declared]) : [];
    const valued = new Set(commands.flatMap((command) => command.needValue));
    switchesOf.set(script, new Set(commands.flatMap((command) => command.known).filter((flag) => !valued.has(flag))));
  }
  return switchesOf.get(script);
}

const isScriptPath = (word, script) => {
  // On Windows and macOS `APPS.JS` is `apps.js`, so the name is compared in lower case.
  const path = unticked(word).toLowerCase();
  return path === script || path.endsWith(`/${script}`) || path.endsWith(`\\${script}`);
};

// The verb of the run of `script` that starts after `tokens[at]`, and whether the run has a flag — before its verb, or right after it.
function readRun(tokens, at, script) {
  if (FIRST_ARGUMENT.has(script)) return { verb: at + 1 < tokens.length ? unticked(tokens[at + 1]) || null : null, hasFlag: false };
  let hasFlag = false;
  for (let i = at + 1; i < tokens.length; i += 1) {
    const word = unticked(tokens[i]);
    const flag = FLAG.exec(word);
    if (!flag) return { verb: word || null, hasFlag: hasFlag || FLAG.test(unticked(tokens[i + 1] ?? '')) };
    hasFlag = true;
    // The next word is the flag's value unless it is another flag; an EMPTY word is a value (`--description ''` reaches the script as an argument).
    if (flag[2] === undefined && i + 1 < tokens.length && !String(tokens[i + 1]).startsWith('--') && !scriptSwitches(script).has(flag[1])) i += 1;
  }
  return { verb: null, hasFlag };
}

/**
 * Every run of `script` (a file name: `apps.js`) in a recorded command, in order: `{ verb, hasFlag }`, the verb the script is run with (null when it has none).
 * `source` is the command text, or a call `{ command, argv }`: the argv goes on where the text ends, as arguments of its last run (`node scripts/apps.js` and `['create', …]`), or holds the
 * whole command (`node` and `['scripts/apps.js', 'create', …]`). The text is read line by line, so a quote left open in one line does not reach into the next.
 */
function scriptRuns(source, script) {
  const call = typeof source === 'string' ? { command: source } : source || {};
  const text = String(call.command ?? '');
  const argv = Array.isArray(call.argv) ? call.argv.map(String) : [];
  if (!text.toLowerCase().includes(script) && !argv.some((word) => word.toLowerCase().includes(script))) return [];
  const lines = text.split(/\r?\n/).map(tokenize);
  lines[lines.length - 1].push(...argv);
  return lines.flatMap((tokens) => tokens.flatMap((word, at) => (isScriptPath(word, script) ? [readRun(tokens, at, script)] : [])));
}

function gradeEvidence(check, fixture) {
  try {
    const problems = check(fixture);
    return problems.length ? { status: 'fail', reason: problems[0] } : { status: 'pass', reason: '' };
  } catch (error) {
    // Missing/malformed evidence is an eval FAILURE, never a success-shaped skip.
    return { status: 'fail', reason: error.message };
  }
}

module.exports = { pathKey, fileName, isGuid, artifactText, artifactJson, commandInfo, scriptRuns, scriptSwitches, gradeEvidence };
