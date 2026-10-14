'use strict';
// The skills, agents, references, README and docs tell an agent which commands to run. scripts/apps.js, list-tables.js, list-languages.js, list-connections.js,
// connector.js, solution-settings.js, genpage-upload.js and genpage.js replaced the `pac` commands those documents used to name (pac-replaced-commands.test.js and
// pac-fallback-commands.test.js pin that no SCRIPT runs one). Nothing executes a document, so without this a regression to the old command — or a flag the script does
// not have — is invisible until an agent runs it. Three pins:
//   1. the `pac` commands the documents name are exactly the ones that stay: signing in, the environment and the version, and a connector's tables (no script lists them);
//   2. every command a document gives for one of the eight scripts uses that script's own subcommand and flags (and the table of them is itself checked against the script);
//   3. each flow's document names the script that does its work, and says what a failed read means.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pageFolderFiles } = require('../lib/genpage-sdk.js');
const { pageHash } = require('../lib/genpage-base.js');

const PLUGIN = path.join(__dirname, '..', '..');
const SCRIPTS_DIR = path.join(PLUGIN, 'scripts');

// What a document may tell an agent about, as text. AGENTS.md and CHANGELOG.md are for contributors: they say what the scripts replaced, by name, on purpose.
function markdownIn(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) markdownIn(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}
const DOCS = [
  ...['skills', 'agents', 'references', 'docs'].flatMap((dir) => markdownIn(path.join(PLUGIN, dir))),
  path.join(PLUGIN, 'README.md'),
];
const rel = (file) => path.relative(PLUGIN, file).replace(/\\/g, '/');
// Line endings normalized: a Windows checkout turns them into CRLF, and a pattern measured in lines then read differently there.
const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const doc = (...parts) => read(path.join(PLUGIN, ...parts));
const squash = (text) => text.replace(/^[ \t]*>[ \t]?/gm, '').replace(/\s+/g, ' ');

// --- 1. the pac commands that stay ---------------------------------------------------------------------------------------------------------------------------------
// `pac auth` / `pac org who` choose the environment and sign in, `pac help` reads the version, and `pac model genpage list-connector-tables` lists a connector's tables, which no script does.
// Every other `pac` command a document names is one a script replaced, or one only a script runs: `pac model list`, `create`, `list-tables`, `list-languages`, every page verb of
// `pac model genpage` (`upload`, `list`, `download`, `generate-types`, `add`, `transpile` — genpage-upload.js and genpage.js do them), the two connector verbs and `pac connection list`
// (connector.js and list-connections.js run them as fallbacks, and a document never tells the agent to), and the two `pac solution` commands of the deployment settings
// (solution-settings.js's fallbacks).
const STAYS = new Set(['list-connector-tables']);
// The page verbs of `pac model genpage` the scripts replaced. No document names one as the way to do anything.
const REPLACED_PAGE_VERBS = ['upload', 'list', 'download', 'generate-types', 'add', 'transpile'];
// A `pac` command in a document: the first word names the group, and up to two more words name the command (`pac model genpage list --app-id`). The pattern is case-sensitive on purpose:
// "PAC CLI" is the product, `pac` the command, and "pac is Y" in a sentence names no group.
const PAC_COMMAND = /\bpac(?:\.exe)?\s+(auth|org|model|solution|connection|package|pcf|canvas|admin|application|data|env|help|install|use)\b((?:[ \t]+[a-z][\w-]*){0,2})/g;

function pacCommands(text) {
  const found = [];
  for (const m of text.matchAll(PAC_COMMAND)) {
    const words = [m[1], ...m[2].trim().split(/\s+/).filter(Boolean)];
    found.push({ words, at: text.slice(0, m.index).split('\n').length });
  }
  return found;
}

function staysPac(words) {
  const [group, ...rest] = words;
  if (group === 'help' || group === 'auth' || group === 'org') return true;
  if (group !== 'model') return false;
  // `pac model genpage …`: the family named on its own in a sentence is not a command; a verb must be one that stays.
  return rest[0] === 'genpage' && (rest.length === 1 || STAYS.has(rest[1]));
}

function strayCommands(text) {
  return pacCommands(text).filter(({ words }) => !staysPac(words)).map(({ words, at }) => ({ command: `pac ${words.join(' ')}`, at }));
}

test('the pac commands the documents name are the ones that stay — none of the commands a script replaced', () => {
  const stray = [];
  for (const file of DOCS) {
    for (const { command, at } of strayCommands(read(file))) stray.push(`${rel(file)}:${at}: ${command}`);
  }
  assert.deepEqual(stray, [], `a document tells the agent to run a pac command a script replaced:\n${stray.join('\n')}`);
});

test('the pac command reader sees what it guards', () => {
  const sample = [
    'Run `pac model list --environment x`, then `pac model create --name y`, `pac model list-tables`, `pac model list-languages`.',
    'pac model genpage upload --page-id z; pac model genpage list-connector-operations; pac model genpage get-connector-schema --operation o.',
    '`pac solution create-settings` and `pac solution import --settings-file s`; `pac connection list`.',
    'pac model genpage list --app-id a; pac model genpage download; pac model genpage generate-types; pac model genpage add; pac model genpage transpile.',
    'Fine: pac help; pac auth list; `pac auth` profile; pac org who; pac model genpage list-connector-tables --dataset d; the `pac model genpage` family; "PAC CLI"; pac is Y; the `pac` profile.',
  ].join('\n');
  const verdicts = pacCommands(sample).map(({ words }) => [`pac ${words.join(' ')}`, staysPac(words)]);
  assert.deepEqual(verdicts.filter(([, ok]) => !ok).map(([command]) => command), [
    'pac model list',
    'pac model create',
    'pac model list-tables',
    'pac model list-languages',
    'pac model genpage upload',
    'pac model genpage list-connector-operations',
    'pac model genpage get-connector-schema',
    'pac solution create-settings',
    'pac solution import',
    'pac connection list',
    'pac model genpage list',
    'pac model genpage download',
    'pac model genpage generate-types',
    'pac model genpage add',
    'pac model genpage transpile',
  ]);
  assert.deepEqual(verdicts.filter(([, ok]) => ok).map(([command]) => command), [
    'pac help', 'pac auth list', 'pac auth', 'pac org who', 'pac model genpage list-connector-tables', 'pac model genpage',
  ]);
});

// The page verbs that stayed on pac until genpage.js and genpage-upload.js did them. One test per verb, so a verb that is quietly allowed again is named: each fails the scan above,
// in a sentence, as a line of its own and inside a fenced command that goes on over a backtick.
for (const verb of REPLACED_PAGE_VERBS) {
  test(`a document that names \`pac model genpage ${verb}\` fails the scan: a script does it now`, () => {
    assert.equal(staysPac(['model', 'genpage', verb]), false);
    for (const text of [
      `Run \`pac model genpage ${verb} --environment '<org-url>'\` first.`,
      `pac model genpage ${verb}\n`,
      `\`\`\`powershell\npac model genpage ${verb} \`\n  --app-id '<id>'\n\`\`\``,
    ]) {
      assert.deepEqual(strayCommands(text).map(({ command }) => command), [`pac model genpage ${verb}`], text);
    }
  });
}

test('the one page verb of `pac model genpage` a document may still name is list-connector-tables — and the family named on its own is no command', () => {
  assert.deepEqual([...STAYS], ['list-connector-tables']);
  assert.equal(staysPac(['model', 'genpage', 'list-connector-tables']), true);
  assert.equal(staysPac(['model', 'genpage']), true);
  assert.deepEqual(strayCommands('Not through `pac model genpage`, and not `pac model genpage list-connector-tables --dataset d` either.'), []);
});

// The verb names are the scan's only handle on a command that is not spelled `pac model genpage …`. The type generator's own word and the transpile verb are in no document at all: the
// generator is `genpage.js types`, and the upload compiles the page.
test('no document names the retired type-generator verb or the pac transpile', () => {
  const found = [];
  for (const file of DOCS) {
    const text = read(file);
    for (const [name, pattern] of [['generate-types', /\bgenerate-types\b/], ['genpage transpile', /\bgenpage\s+transpile\b/]]) {
      if (pattern.test(text)) found.push(`${rel(file)}: ${name}`);
    }
  }
  assert.deepEqual(found, []);
});

// --- 2. the commands the documents give for the scripts ----------------------------------------------------------------------------------------------------------
// The flags each script takes (a script's own contract: validateFlags in the script). The documents are held to this table, and the table to the scripts' source, so neither can
// drift alone: a document that names a flag the script lacks fails here, and a flag in this table that the script dropped fails below.
const CONTRACT = {
  'apps.js': { commands: { list: ['env', 'search'], create: ['env', 'name', 'solution', 'page-id', 'unique-name', 'description', 'publish'] } },
  'list-tables.js': { flags: ['env', 'search', 'exact', 'type'] },
  'list-languages.js': { flags: ['env'] },
  'list-connections.js': { flags: [] },
  'connector.js': {
    commands: {
      operations: ['env', 'connector-id', 'connection-id'],
      schema: ['env', 'connector-id', 'connection-id', 'operation', 'dataset', 'table'],
    },
  },
  'solution-settings.js': {
    commands: { template: ['env', 'solution', 'package', 'out', 'force'], import: ['env', 'package', 'settings'] },
  },
  'genpage-upload.js': {
    flags: ['env', 'app-id', 'code-file', 'compiled-code-file', 'page-id', 'name', 'name-file', 'data-sources', 'clear-data-sources', 'prompt', 'prompt-file', 'agent-message',
      'agent-message-file', 'model', 'connectors', 'actions', 'add-to-sitemap', 'overwrite-deployed'],
  },
  // The page verbs the skills ran through `pac model genpage`; the table is the script's own VERBS (checked below).
  'genpage.js': {
    commands: {
      list: ['env', 'app-id', 'include-unpublished'],
      download: ['env', 'page-id', 'output-directory', 'app-id'],
      types: ['env', 'data-sources', 'output-file', 'detail'],
      'add-to-app': ['env', 'app-id', 'page-id', 'title'],
      'remove-from-app': ['env', 'app-id', 'page-id', 'allow-empty-navigation'],
      delete: ['env', 'page-id', 'allow-destructive'],
    },
  },
};
const SCRIPT_PATH = new RegExp(`scripts/(${Object.keys(CONTRACT).map((name) => name.replace('.', '\\.')).join('|')})(?![\\w-])`, 'g');

// The commands a document gives for these scripts: each place a script path appears, with the arguments that follow it. Inside a ```powershell / ```bash block a command goes on over
// the lines that end in a backtick (PowerShell) or a backslash (bash); anywhere else it is an inline code span and ends at the closing backtick.
function scriptCommands(text) {
  const lines = text.split('\n');
  const found = [];
  let fence = null;
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^\s*```(\w*)/.exec(lines[i]);
    if (open) { fence = fence === null ? (open[1] || 'plain') : null; continue; }
    const shell = fence !== null && /^(powershell|pwsh|bash|sh)$/.test(fence);
    for (const m of lines[i].matchAll(SCRIPT_PATH)) {
      let args = lines[i].slice(m.index + m[0].length);
      if (shell) {
        for (let k = i; /[`\\]\s*$/.test(lines[k]) && k + 1 < lines.length; k += 1) {
          args = `${args.replace(/[`\\]\s*$/, '')} ${lines[k + 1].trim()}`;
        }
      } else {
        args = args.split('`')[0];
        // `scripts/connector.js` on its own is the script named in a sentence, not a command.
        if (!args.trim()) continue;
      }
      // `${PLUGIN_ROOT}/scripts/apps.js" list --env '<envUrl>'`: the path's closing quote, then the subcommand, then the flags.
      const tokens = args.replace(/^["']/, '').trim().split(/\s+/).filter(Boolean);
      found.push({
        script: m[1],
        subcommand: tokens[0] && !tokens[0].startsWith('--') && !/^['"<]/.test(tokens[0]) ? tokens[0] : null,
        flags: [...args.matchAll(/(?:^|\s)--([a-z][\w-]*)/g)].map((flag) => flag[1]),
        at: i + 1,
      });
    }
  }
  return found;
}

test('every command a document gives for a script that replaced a pac command uses that script\'s own subcommand and flags', () => {
  const problems = [];
  const seen = new Set();
  for (const file of DOCS) {
    for (const { script, subcommand, flags, at } of scriptCommands(read(file))) {
      seen.add(script);
      const where = `${rel(file)}:${at}: ${script}`;
      const contract = CONTRACT[script];
      let allowed = contract.flags;
      if (contract.commands) {
        allowed = contract.commands[subcommand];
        if (!allowed) { problems.push(`${where} ${subcommand || '(no subcommand)'} is not one of ${Object.keys(contract.commands).join(', ')}`); continue; }
      } else if (subcommand && script !== 'list-connections.js') {
        problems.push(`${where} takes no subcommand, got '${subcommand}'`);
      }
      for (const flag of flags) if (!allowed.includes(flag)) problems.push(`${where} ${subcommand || ''} has no --${flag}`);
    }
  }
  assert.deepEqual(problems, []);
  // Each of the eight is given to the agent somewhere: a script no document names is a command nobody was told about.
  assert.deepEqual(Object.keys(CONTRACT).filter((name) => !seen.has(name)), [], 'every script that replaced a pac command is named in a document');
});

test('the table of flags is the scripts\' own: every flag in it is one the script\'s source declares', () => {
  for (const [name, contract] of Object.entries(CONTRACT)) {
    const source = fs.readFileSync(path.join(SCRIPTS_DIR, name), 'utf8');
    const flags = contract.flags || [...new Set(Object.values(contract.commands).flat())];
    for (const flag of flags) {
      assert.ok(source.includes(`--${flag}`) || source.includes(`'${flag}'`), `${name} no longer declares --${flag}`);
    }
  }
});

// genpage.js exports its verbs, so its row of the table is held to them exactly: the same commands, and for each the same flags — one the script gained is one the documents may use.
test('the table of genpage.js commands is the script\'s own VERBS, command for command and flag for flag', () => {
  const { VERBS } = require('../genpage.js');
  const table = CONTRACT['genpage.js'].commands;
  assert.deepEqual(Object.keys(table).sort(), Object.keys(VERBS).sort());
  for (const [verb, flags] of Object.entries(table)) assert.deepEqual([...flags].sort(), [...VERBS[verb].known].sort(), `genpage.js ${verb}`);
});

test('the command reader sees what it guards', () => {
  const sample = [
    'Run `node "${PLUGIN_ROOT}/scripts/apps.js" list --env \'<envUrl>\' --search \'x\'` first.',
    '```powershell',
    'node "${PLUGIN_ROOT}/scripts/genpage-upload.js" `',
    "  --env '<org-url>' `",
    "  --code-file '<f>' `",
    '  --add-to-sitemap',
    'node "${PLUGIN_ROOT}/scripts/check-auth.js" --require-pac',
    '```',
    '```markdown',
    "- Command: `node \"${PLUGIN_ROOT}/scripts/connector.js\" schema --env '<e>' --dataset d --table t`",
    '```',
    '```powershell',
    'node "${PLUGIN_ROOT}/scripts/genpage.js" types `',
    "  --env '<envUrl>' `",
    "  --data-sources 'a,b' `",
    "  --output-file '<f>'",
    '```',
    'Not a command: the script `scripts/genpage.js` named in a sentence, and `scripts/genpage-base.js record --page-id x`, which no table covers.',
  ].join('\n');
  assert.deepEqual(scriptCommands(sample).map(({ script, subcommand, flags }) => [script, subcommand, flags]), [
    ['apps.js', 'list', ['env', 'search']],
    ['genpage-upload.js', null, ['env', 'code-file', 'add-to-sitemap']],
    ['connector.js', 'schema', ['env', 'dataset', 'table']],
    ['genpage.js', 'types', ['env', 'data-sources', 'output-file']],
  ]);
});

// --- 3. each flow names the script that does its work -----------------------------------------------------------------------------------------------------------
test('the planner, the skills and the authoring playbook run list-tables.js and apps.js, and a failed read is never "nothing exists"', () => {
  const planner = squash(doc('agents', 'genpage-planner.md'));
  assert.match(planner, /node "\$\{PLUGIN_ROOT\}\/scripts\/list-tables\.js" --env '<envUrl>' --search 'entity1,entity2' --exact/);
  assert.match(planner, /`--exact` keeps only the tables whose logical name \*\*is\*\* a search term \(any letter case\) and names the terms that have none in `missing`/);
  assert.match(planner, /node "\$\{PLUGIN_ROOT\}\/scripts\/list-tables\.js" --env '<envUrl>' --type custom/);
  assert.match(planner, /a failed read is never "no entities exist", and nothing is created on it/);
  assert.match(planner, /node "\$\{PLUGIN_ROOT\}\/scripts\/apps\.js" list --env '<envUrl>'/);
  assert.match(planner, /`published` \(users can open the app\) and `unpublishedChanges` \(a saved edit is waiting for a publish\) are two separate facts/);
  assert.match(planner, /a failed read is never "no apps"/);
  assert.match(planner, /`apps\.js create` refuses a call without `--solution`/);

  const playbook = squash(doc('references', 'authoring-flow.md'));
  assert.match(playbook, /node "\$\{PLUGIN_ROOT\}\/scripts\/list-tables\.js" --env '<envUrl>' --search 'entity1,entity2' --exact/);
  assert.match(playbook, /node "\$\{PLUGIN_ROOT\}\/scripts\/list-tables\.js" --env '<envUrl>' --type custom/);
  assert.match(playbook, /node "\$\{PLUGIN_ROOT\}\/scripts\/apps\.js" list --env '<envUrl>'/);
  assert.match(playbook, /a failed read is never "no entities exist", and nothing is created on it/);

  const appBuilder = squash(doc('skills', 'app-builder', 'SKILL.md'));
  assert.match(appBuilder, /`scripts\/list-tables\.js --env <envUrl> --search … --exact` and `scripts\/apps\.js list --env <envUrl>`/);
  assert.match(appBuilder, /A failed read \(exit 1\) is reported and ends the step — never read it as "nothing exists"\./);

  const edit = squash(doc('skills', 'genpage', 'edit-flow.md'));
  assert.match(edit, /node "\$\{PLUGIN_ROOT\}\/scripts\/apps\.js" list --env '<envUrl>'/);
  assert.match(edit, /`published` \(users can open the app\) and `unpublishedChanges` \(a saved edit is waiting for a publish\) are two separate facts/);
  assert.match(edit, /a failed read is never "no apps"/);

  const skill = squash(doc('skills', 'genpage', 'SKILL.md'));
  assert.match(skill, /Entity existence detection \(`node "\$\{PLUGIN_ROOT\}\/scripts\/list-tables\.js" --env '<envUrl>' --search '<entities>' --exact`\)/);
  assert.match(skill, /App detection \(`node "\$\{PLUGIN_ROOT\}\/scripts\/apps\.js" list --env '<envUrl>'`\)/);
});

// A new app opens on the pages it is made with, and the platform refuses an empty navigation: the first page comes first, with no app, then the app is made from it, then the rest.
test('the genpage skill creates a new app from its first page: no app in Phase 3, the first page with no app, apps.js create --page-id --publish, then the other pages', () => {
  const skill = squash(doc('skills', 'genpage', 'SKILL.md'));
  const phase3 = skill.split('### Phase 3: App Creation/Selection')[1].split('### Phase 4:')[0];
  assert.match(phase3, /\*\*If "create new":\*\* nothing is created in this phase\. A new app opens on the pages it is made with — the platform refuses an app whose navigation is empty — so `apps\.js create` needs the id of a page that already exists\./);
  assert.match(phase3, /`--solution` is mandatory and takes the solution's \*\*unique name\*\*/);
  assert.doesNotMatch(phase3, /pac model create|--publish/, 'Phase 3 creates nothing, so it runs no create');

  const deploy = skill.split('### Phase 6: Deploy')[1].split('### Phase 6.5')[0];
  const newApp = deploy.split('#### A new app: the first page, then the app, then the rest')[1];
  assert.ok(newApp, 'Phase 6 has the new-app section');
  const first = newApp.indexOf('**The first page, with no app.**');
  const app = newApp.indexOf('**The app, from that page.**');
  const rest = newApp.indexOf('**The remaining pages.**');
  assert.ok(first >= 0 && first < app && app < rest, 'the order is the first page, the app, then the other pages');
  assert.match(newApp, /Run the create above without `--app-id` and without `--add-to-sitemap`\./);
  assert.match(newApp, /node "\$\{PLUGIN_ROOT\}\/scripts\/apps\.js" create ` --env '<org-url>' ` --name '<App Name>' ` --solution '<Solution unique name>' ` --page-id '<first-page-id>' ` --publish/);
  assert.match(newApp, /\*\*`--publish` is mandatory:\*\* without it the new app stays in draft/);
  assert.match(newApp, /a create into `Default` needs no add and did not fail/);
  assert.match(newApp, /Upload each with `--app-id '<appId>'` and `--add-to-sitemap`/);
  // The create itself pins the default public view of each table the first page reads — so there is no step 4 of re-uploading the page to pin them, and no `record` of the new app's
  // id to make that re-upload possible: a page with no app is recorded with the page alone (genpage-base.test.js), and the first update that names the app records it
  // (genpage-upload.test.js, "the new-app flow"). apps.js create's own tests (apps.test.js, apps-real-bundle.test.js) pin that it pins them.
  assert.match(newApp, /"navigation", "dataSources", "pinnedViews", … \}` — store `appId` for the rest of the run\./);
  assert.match(newApp, /The create also pins the default public view of each table the page reads into the app's components, so that the maker's "\/" picker lists the page's tables \(`dataSources` are the tables, `pinnedViews` the views\); a `warnings` entry says when a table has no default public view to pin/);
  assert.doesNotMatch(newApp, /first page's tables|Pin the page's tables|table views to the app|\*\*The first page's tables\.\*\*|update that names the app/, 'no step re-uploads the first page to pin its tables');
  assert.doesNotMatch(skill, /record` with the new app's id|before the update in step 4/, 'nor is a marker recorded with the new app\'s id for that step');
  const appsSource = fs.readFileSync(path.join(SCRIPTS_DIR, 'apps.js'), 'utf8');
  for (const field of ['pinnedViews', 'dataSources', 'defaultViews']) assert.ok(appsSource.includes(field), `apps.js create still reports and reads ${field}`);
  // What a failed create left: `written` says, and each answer has its own next step.
  assert.match(newApp, /`"written": false` means nothing was made: fix what the message names and run it again\./);
  assert.match(newApp, /`"written": true` means the app or its sitemap exists/);
  assert.match(newApp, /run it again with `--unique-name '<name>'`/);
  assert.match(newApp, /`"written": null` means the platform could not be read back, so the outcome is unknown: look in the environment for what `lookFor` names/);
  // The create of the first page says what an app-less create is, and the logged command for it has neither flag.
  assert.match(deploy, /\*\*A new app\*\* \(the plan says `create new`\): there is no app to name yet\. Create the app's \*\*first page with no `--app-id` and no `--add-to-sitemap`\*\*/);
  assert.match(deploy, /A new app's first page is created with no app, so its logged command has neither `--app-id` nor `--add-to-sitemap`/);
  // The planner's and the troubleshooting guide's account of it is the same.
  assert.match(squash(doc('references', 'troubleshooting.md')), /it deploys the first page, then creates the app from it with `scripts\/apps\.js create` \(Phase 6\), and adds the other pages to it\./);
  assert.match(squash(doc('README.md')), /the app is created in step 8, from the first page deployed \(`scripts\/apps\.js create`\), because an app opens on its pages/);
});

test('the genpage skill deploys through genpage-upload.js with nothing of the pac upload left: no --help pre-flight, no build minimum, no rule about a name', () => {
  const skill = squash(doc('skills', 'genpage', 'SKILL.md'));
  const edit = squash(doc('skills', 'genpage', 'edit-flow.md'));
  assert.match(skill, /`genpage-upload\.js` writes the bindings into the page's `config\.json` through the SDK, so there is no `--help` to pre-flight and no minimum `pac` build for them; a file that is not a JSON array is refused before anything is written\./);
  assert.match(skill, /\*\*Deploy through `scripts\/genpage-upload\.js`\.\*\* It writes the page through the SDK/);
  assert.match(skill, /The page's name is stored exactly as written: a straight double quote \(`"`\) or a `%` in it is neither refused nor escaped\./);
  assert.match(skill, /An update that gives no `--name-file`, `--model`, `--data-sources`, `--connectors` or `--actions` keeps the page's own name, model, data sources and bindings/);
  assert.match(edit, /A name is stored exactly as written — a straight double quote \(`"`\) or a `%` included — and none is refused\./);
  for (const [name, text] of [['SKILL.md', skill], ['edit-flow.md', edit], ['troubleshooting.md', squash(doc('references', 'troubleshooting.md'))], ['app-spec-schema.md', squash(doc('references', 'app-spec-schema.md'))]]) {
    assert.doesNotMatch(text, /pac\.cmd|upload --help|requires a pac build|PowerPlatform-Scale-AdminTools|is refused before anything is uploaded: pac stores/i, `${name} still carries a rule of the pac upload`);
    assert.doesNotMatch(text, /pac preserves|so pac clears|pac would otherwise|pac stores whatever|pac leaves a page's/i, `${name} still says what pac does with an omitted field`);
  }
});

test('the connector builder runs connector.js for operations and a REST schema, says where the connections came from, and leaves the tabular read to pac', () => {
  const builder = squash(doc('agents', 'genpage-connector-builder.md'));
  assert.match(builder, /node "\$\{PLUGIN_ROOT\}\/scripts\/connector\.js" operations --env '<ENV_URL>' --connector-id <connectorName> --connection-id <connId>/);
  assert.match(builder, /node "\$\{PLUGIN_ROOT\}\/scripts\/connector\.js" schema --env '<ENV_URL>' --connector-id <connectorName> --connection-id <connId> --operation <op>/);
  assert.match(builder, /node "\$\{PLUGIN_ROOT\}\/scripts\/connector\.js" schema --env '<ENV_URL>' --connector-id <connectorName> --connection-id <connId> --dataset <ds> --table <tableId>/);
  assert.match(builder, /`source` is `"sdk"` or `"pac"`; with `"pac"` the answer carries `fallback`/);
  assert.match(builder, /This form is always answered by `pac` \(`"source": "pac"`, no `fallback`\): the plugin cannot build the client the SDK reads a connector's tables with/);
  assert.match(builder, /`connectionsSource` is `"sdk"`/);
  assert.match(builder, /`connectionsFallback` \(`\{ code, message \}`\) says why the SDK was not used/);
  assert.match(builder, /a token the service refused — HTTP 401 or 403, `CONNECTIVITY_UNAUTHORIZED` —/, 'the refusal of a token is among the reasons pac is asked');
  assert.match(builder, /`pac model genpage list-connector-tables --environment '<ENV_URL>' --connector-id <connectorName> --connection-id <connId> \[--dataset <ds>\]` may help pick the table: no script replaces it, because the plugin cannot build the client the SDK reads a connector's tables with/);
  // The failure contract of list-connections.js: one ok:false line for every failure past the arguments, the code when the error has one; a usage error is stderr alone.
  assert.match(builder, /Every failure past the arguments — the SDK's read, `pac`, the connection references, an environment URL that is not a Dataverse one — prints one `\{ "ok": false, "error" \}` line on stdout, with the error's `code` when it has one/);
  assert.match(builder, /a usage error \(no URL, an unknown flag\) is the problem on stderr alone/);
  assert.doesNotMatch(builder, /any other failure \(pac output|prints its message on stderr alone|the SDK has no read of a connector's tables/, 'the old contract, and the old reason for the tabular read, are gone');
  assert.match(squash(doc('references', 'connectors.md')), /from `connector\.js schema --operation`/);
  assert.match(squash(doc('references', 'connectors.md')), /`genpage-upload\.js --connectors <connectors\.json>` then persists that array into the deployed page's `config\.json`/);
  assert.match(squash(doc('references', 'custom-api.md')), /`genpage-upload\.js --actions <actions\.json>` then persists that array into the deployed page's `config\.json`/);
  assert.match(squash(doc('agents', 'genpage-customapi-builder.md')), /the working-dir binding file for `genpage-upload\.js --actions`/);
});

test('the genpage skill sets deployment settings through solution-settings.js', () => {
  const skill = squash(doc('skills', 'genpage', 'SKILL.md'));
  assert.match(skill, /node "\$\{PLUGIN_ROOT\}\/scripts\/solution-settings\.js" template --env '<envUrl>' --solution '<solutionUniqueName>' --out '<settings\.json>'/);
  assert.match(skill, /node "\$\{PLUGIN_ROOT\}\/scripts\/solution-settings\.js" import --env '<target-envUrl>' --package '<solution\.zip>' --settings '<settings\.json>'/);
  assert.match(skill, /an existing `--out` is not replaced unless `--force` is given, so a file already filled in is not lost/);
  // The whole guarantee and its limits, not only the guarantee: what is kept out; a short value that is known not to be a secret; a short value whose type is not known; the decoding limits.
  assert.match(skill, /A secret value and a connection id are kept out of what they print — a text that quotes one is withheld, or has it replaced by `<redacted>` — with these limits: /);
  assert.match(skill, /a value of fewer than six characters that is known not to be a secret is not hidden; /);
  assert.match(skill, /one whose type is not known \(the `pac` route, a name the package does not define\) is found only as a whole word, so it is printed when glued to letters, digits, marks or underscores or written inside an escape the sanitizer does not decode; /);
  assert.match(skill, /and a value quoted in part, hashed, base64-encoded, written as an HTML entity beyond XML's five, Unicode-normalized or nested in more than three levels of encoding is not recognised\./);
  assert.doesNotMatch(skill, /never a settings value or a connection id/, 'the skill does not promise more than the sanitizer does');
});

test('the genpage skill generates the types with genpage.js, and a failure of it ends the phase — a column is never guessed', () => {
  const skill = squash(doc('skills', 'genpage', 'SKILL.md'));
  const phase4 = skill.split('### Phase 4: Generate RuntimeTypes (Conditional)')[1].split('### Phase 4.5')[0];
  assert.match(phase4, /`genpage\.js types` is the SDK's type generator — the maker portal's own — read from the environment now:/);
  assert.match(phase4, /node "\$\{PLUGIN_ROOT\}\/scripts\/genpage\.js" types ` --env '<org-url>' ` --data-sources 'entity1,entity2' ` --output-file '<working-dir>\/RuntimeTypes\.ts'/);
  assert.match(phase4, /It prints `\{ "ok": true, "outputFile", "dataSources", "detail", "bytes" \}`\. A failure \(exit 1, `"ok": false` with a `code` — for example `GENPAGE_TABLE_NOT_FOUND`, which names the `table` the environment does not have\) ends the phase: report why, and never guess column names\./);
  assert.match(skill, /Pages themselves are written, read and deleted through the SDK with the same az token, and so are the type generator and the page listing and download \(`scripts\/genpage\.js`\)\./);
  assert.match(squash(doc('skills', 'app-builder', 'SKILL.md')), /node "\$\{PLUGIN_ROOT\}\/scripts\/genpage\.js" types --env <envUrl> --data-sources "<entity1,entity2,…>" --output-file <working-dir>\/RuntimeTypes\.ts/);
  assert.match(squash(doc('skills', 'app-builder', 'SKILL.md')), /The script prints `\{ "ok": true, "outputFile", "dataSources", "detail", "bytes" \}`; a failure \(exit 1, `"ok": false`\) stops the step — report why, since the page workers must not guess column names\./);
  assert.match(squash(doc('references', 'authoring-flow.md')), /\*\*Type generation\*\* — `genpage\.js types` → `RuntimeTypes\.ts`\./);
  assert.match(squash(doc('references', 'troubleshooting.md')), /`node "\$\{PLUGIN_ROOT\}\/scripts\/genpage\.js" types …` prints `\{ "ok": false, "error", "code" \}` and exits 1 when it cannot write the schema/);
  assert.match(squash(doc('references', 'troubleshooting.md')), /A table the environment does not have prints `"code": "GENPAGE_TABLE_NOT_FOUND"` with the `table` it names — check the logical name \(not the display name; a custom table has its publisher prefix\) and that the environment is the one that holds the table\./);
});

// What the edit flow says the download writes is what genpage.js writes — the folder's files come from pageFolderFiles (genpage.test.js reads the bytes it puts on disk) — and what it says the
// base marker does with those bytes is what lib/genpage-base.js does.
test('the edit flow lists, downloads and types with genpage.js, and what it says the download writes and the marker reads is what the script and the marker do', () => {
  const edit = squash(doc('skills', 'genpage', 'edit-flow.md'));
  assert.match(edit, /`node "\$\{PLUGIN_ROOT\}\/scripts\/genpage\.js" list --env '<envUrl>' --app-id '<id>'`/);
  assert.match(edit, /node "\$\{PLUGIN_ROOT\}\/scripts\/genpage\.js" list --env '<envUrl>' --app-id '<app-id>'/);
  assert.match(edit, /The script prints `\{ "ok": true, "scope": "app", "appId", "layer": "published", "count": N, "pages": \[ \{ "pageId", "name", "title" \} \] \}`/);
  assert.match(edit, /`name` is the page's own name and `title` the navigation entry's \(renaming a page leaves its title as it was\): present the `name`\./);
  assert.match(edit, /`--include-unpublished` reads the saved one the app designer holds \(`layer: "saved"`\)/);
  assert.match(edit, /An entry whose page is not in the environment has `name: null` and `"exists": false`: do not offer it\. If the script fails \(exit 1\), report why and stop — a failed read is never "no pages"\./);
  assert.match(edit, /node "\$\{PLUGIN_ROOT\}\/scripts\/genpage\.js" download ` --env '<envUrl>' ` --app-id '<app-id>' ` --page-id '<page-id>' ` --output-directory '<working-dir>'/);
  assert.match(edit, /`page\.tsx` \(source\), `config\.json` \(entity list \+ model \+ bindings\), `prompt\.txt` \(the page's prompt, or its conversation when it has several; left out for a page that has none\)/);
  assert.match(edit, /`replaced` names the files that already held other bytes and were overwritten/);
  assert.match(edit, /leaves the folder as it was\. With `--app-id` the page must be in that app's saved navigation, or nothing is downloaded \(`GENPAGE_NOT_IN_APP`\)\./);
  assert.match(edit, /the download adds no byte order mark and no line break at the end \(a download an earlier release made with `pac` added both\)\./);
  assert.match(edit, /The marker hashes the page with any byte order mark removed, every line ending read as LF and the final blank lines dropped/);
  assert.match(edit, /node "\$\{PLUGIN_ROOT\}\/scripts\/genpage\.js" types ` --env '<envUrl>' ` --data-sources 'entity1,entity2' ` --output-file '<working-dir>\/RuntimeTypes\.ts'/);
  assert.match(edit, /a failure \(exit 1, `"ok": false`\) means there are no verified column names: report why, and make no edit that needs them\./);
  assert.doesNotMatch(edit, /\*\*Page ID\*\*|writes a BOM and a final CRLF/, 'nothing of the pac listing and download is left');

  // The planner reads the files that way: the script's folder has no page.js, and a prompt.txt only when the page has a prompt.
  const planner = squash(doc('agents', 'genpage-edit-planner.md'));
  assert.match(planner, /`genpage\.js download --app-id <\.\.\.> --page-id <\.\.\.> --output-directory <working-dir>` \(the orchestrator has run it\) produces the following structure:/);
  assert.match(planner, /└── prompt\.txt +← The page's prompt, or its conversation when it has several \(READ THIS; absent when the page has none\)/);
  assert.match(planner, /A page that was prompted more than once holds its prompts as `Conversation with N prompts:` followed by the numbered prompts; a page with no prompt has no `prompt\.txt` — go on without it\./);
  assert.doesNotMatch(planner, /(?<![\w-])page\.js\b/, 'the script writes no page.js');

  const page = { name: 'Overview', source: 'const x = 1;\r\n', dataSources: ['account'], model: 'm', conversation: [{ sender: 'user', message: 'Show an overview' }] };
  const files = pageFolderFiles(page);
  assert.deepEqual(Object.keys(files), ['page.tsx', 'config.json', 'prompt.txt'], 'page.tsx, config.json and prompt.txt — and no page.js');
  assert.equal(files['page.tsx'], 'const x = 1;\r\n', 'the stored text exactly: no byte order mark added, its own final line break kept, none appended');
  assert.equal(files['config.json'], '{"dataSources":["account"],"model":"m"}');
  assert.equal(files['prompt.txt'], 'Show an overview');
  assert.deepEqual(Object.keys(pageFolderFiles({ ...page, conversation: [] })), ['page.tsx', 'config.json'], 'a page with no prompt has no prompt.txt');
  assert.equal(pageFolderFiles({ ...page, conversation: [{ sender: 'user', message: 'a' }, { sender: 'agent', message: 'ok' }, { sender: 'user', message: 'b' }] })['prompt.txt'],
    'Conversation with 2 prompts:\r\n1. a\r\n2. b');
  assert.equal(pageHash('\uFEFFconst x = 1;\r\n'), pageHash('const x = 1;\n'), 'a byte order mark and a CRLF line break are no difference');
  assert.equal(pageHash('a\r\nb\r\n\r\n'), pageHash('a\nb'), 'nor are the final blank lines');
  assert.notEqual(pageHash('a\nb'), pageHash('a\n\nb'), 'a blank line between content is the page\'s');
});

// The page verbs genpage.js did not replace but ADDED: where a document sent the maker to Maker — to put a page in an app, to take it out of one, to delete it — it now names the verb. Each of them
// changes an app or deletes a page, so the text says to ask first; delete is refused until `--allow-destructive` says it is meant, and what it would remove is what the refusal says
// (genpage.test.js: "without --allow-destructive the backend is asked not to delete").
test('the new page verbs are offered where the text used to send the maker to Maker: add a page to an app, take it out of one, delete it — after asking', () => {
  const skill = squash(doc('skills', 'genpage', 'SKILL.md'));
  assert.match(skill, /List the environment's pages: `node "\$\{PLUGIN_ROOT\}\/scripts\/genpage\.js" list --env '<org-url>'` prints every page of the environment, drafts included, as `\{ "pageId", "name" \}`, and a failed read \(exit 1, `"ok": false`\) is never "the page is not there"\./);
  assert.match(skill, /add it to the app's navigation with `node "\$\{PLUGIN_ROOT\}\/scripts\/genpage\.js" add-to-app --env '<org-url>' --app-id '<app-id>' --page-id '<page-id>'` \(it publishes the app and proves the page shows in the published navigation\)/);
  assert.match(skill, /Or delete the page and re-run the create: `node "\$\{PLUGIN_ROOT\}\/scripts\/genpage\.js" delete --env '<org-url>' --page-id '<page-id>'` first says what it would remove — the page, its file rows and its conversation messages — and deletes nothing; ask the user, and only if they agree run it again with `--allow-destructive`, which removes them for good — an unattended run stops at that refusal instead, since suppressing a prompt never authorizes a delete — and it is refused while an app's navigation names the page \(the refusal names the apps; `genpage\.js remove-from-app` takes the page out of each\)\./);
  assert.match(skill, /run `genpage-base\.js record --page-id '<page-id>' --file '<working-dir>\/<file>\.tsx'` with no `--app-id` \(no app holds the page yet, so the marker records the page alone, and the first update that names the new app records the app\) and go on with step 2 of "A new app" below/);
  assert.doesNotMatch(skill, /Look for the page in Maker|in Maker, or `pac|add it to the app's navigation \(in Maker/, 'the maker is not sent to Maker for what a verb does');

  const appBuilder = squash(doc('skills', 'app-builder', 'SKILL.md'));
  assert.match(appBuilder, /Detach it from that app — ask the user first, since this changes another app\. The halt names the app and prints the command with the app's `id` filled in \(`<id of app …>` stands where the id could not be read, and `scripts\/apps\.js list --env <envUrl> --search <name>` gives it\); `node "\$\{PLUGIN_ROOT\}\/scripts\/genpage\.js" remove-from-app --env <envUrl> --app-id <that app's id> --page-id <page id>` takes the page out of that app's navigation and publishes that app \(everything it has saved goes live with it; the page itself stays\)\. Or detach it in Maker\. `--allow-destructive` does \*\*not\*\* bypass this halt\./);
  const schema = squash(doc('references', 'app-spec-schema.md'));
  assert.match(schema, /add it to the app's navigation with `node "\$\{PLUGIN_ROOT\}\/scripts\/genpage\.js" add-to-app --env <envUrl> --app-id <this app's id> --page-id <page id>` \(it publishes the app and proves the page in what runs\) and re-run; otherwise remove the stale id from the manifest\/spec \(or delete the page with `node "\$\{PLUGIN_ROOT\}\/scripts\/genpage\.js" delete --env <envUrl> --page-id <page id>`, which says what it would remove and deletes nothing until it is run again with `--allow-destructive` — ask the user first, it is permanent\) and re-run\./);
  assert.match(schema, /Detach it from that app first — ask the user, since this changes another app: the halt names the app and prints the command with the app's `id` filled in \(`<id of app …>` stands where the id could not be read, and `scripts\/apps\.js list --env <envUrl> --search <name>` gives it\), and `node "\$\{PLUGIN_ROOT\}\/scripts\/genpage\.js" remove-from-app --env <envUrl> --app-id <that app's id> --page-id <page id>` takes the page out of its navigation and publishes it \(everything that app has saved goes live with it; the page itself stays\) — or detach it in Maker\./);
  assert.match(squash(doc('docs', 'app-builder-capabilities.md')), /`pages-shared-across-apps` \(`--allow-destructive` does NOT bypass; detach the page from the other app with `scripts\/genpage\.js remove-from-app`, or in Maker\)/);
  assert.doesNotMatch(`${appBuilder} ${schema}`, /Detach it in Maker\.? `--allow-destructive`|add it to the app's navigation in the maker, publish the app and re-run/, 'neither document still sends the maker to Maker alone');
});

test('the docs that draw the flows name the scripts: apps.js list, genpage.js and genpage-upload.js', () => {
  const architecture = doc('docs', 'architecture.md');
  assert.match(architecture, /^ +apps\.js list$/m);
  assert.match(architecture, /^ +genpage\.js list$/m);
  assert.match(architecture, /^ +genpage\.js download$/m);
  assert.match(architecture, /^ +genpage-upload\.js --page-id \.\.\.$/m);
  assert.match(architecture, /RuntimeTypes\.ts +<-- Phase 4 +\(genpage\.js types\)/);
  assert.match(architecture, /Which entities feed `genpage\.js types`/);
  assert.match(architecture, /│ Generate pages +│ +genpage\.js types → RuntimeTypes\.ts/);
  assert.match(architecture, /│ {2}genpage\.js types \+ {8}│ +write-page-plan\.js projects the spec into/);
  const design = squash(doc('docs', 'app-builder-design.md'));
  assert.match(design, /generate-pages \(main loop\) +genpage\.js types \+ page-builder agents/);
  assert.match(design, /Run 1 materializes tables so `genpage\.js types` can emit `RuntimeTypes\.ts`\./);
  assert.match(design, /1\. runs `genpage\.js types` → `RuntimeTypes\.ts`;/);
  // The design record is read by outsiders: the two passages that carried a review marker keep their reason and say it plainly.
  assert.match(design, /cross-env deploy \/ recreate, and a page's id is an opaque identity its source should not carry\)\./);
  assert.match(design, /\*\*Deployment protocol \(safe recovery\)\.\*\* The listing must fail closed:/);
});
