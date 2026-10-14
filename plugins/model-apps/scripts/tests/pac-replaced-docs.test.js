'use strict';
// The skills, agents, references, README and docs tell an agent which commands to run. scripts/apps.js, list-tables.js, list-languages.js, list-connections.js,
// connector.js, solution-settings.js and genpage-upload.js replaced the `pac` commands those documents used to name (pac-replaced-commands.test.js and
// pac-fallback-commands.test.js pin that no SCRIPT runs one). Nothing executes a document, so without this a regression to the old command — or a flag the script does
// not have — is invisible until an agent runs it. Three pins:
//   1. the `pac` commands the documents name are exactly the ones that stay: signing in and the environment, the type generator, the page verbs no script replaces yet;
//   2. every command a document gives for one of the seven scripts uses that script's own subcommand and flags (and the table of them is itself checked against the script);
//   3. each flow's document names the script that does its work, and says what a failed read means.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
// `pac auth` / `pac org who` choose the environment and sign in; `pac help` reads the version; `pac model genpage` keeps the verbs no script replaces yet (the type generator, listing,
// download, add, transpile, and a connector's tables). Every other `pac` command a document names is one a script replaced: `pac model list`, `create`, `list-tables`, `list-languages`,
// `genpage upload`, the two connector verbs the connector script answers, `pac connection list`, and the two `pac solution` commands of the deployment settings.
const STAYS = new Set(['generate-types', 'list', 'download', 'add', 'transpile', 'list-connector-tables']);
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

test('the pac commands the documents name are the ones that stay — none of the commands a script replaced', () => {
  const stray = [];
  for (const file of DOCS) {
    for (const { words, at } of pacCommands(read(file))) {
      if (!staysPac(words)) stray.push(`${rel(file)}:${at}: pac ${words.join(' ')}`);
    }
  }
  assert.deepEqual(stray, [], `a document tells the agent to run a pac command a script replaced:\n${stray.join('\n')}`);
});

test('the pac command reader sees what it guards', () => {
  const sample = [
    'Run `pac model list --environment x`, then `pac model create --name y`, `pac model list-tables`, `pac model list-languages`.',
    'pac model genpage upload --page-id z; pac model genpage list-connector-operations; pac model genpage get-connector-schema --operation o.',
    '`pac solution create-settings` and `pac solution import --settings-file s`; `pac connection list`.',
    'Fine: pac help; pac auth list; `pac auth` profile; pac org who; pac model genpage list --app-id a; pac model genpage download; pac model genpage generate-types;',
    'pac model genpage add; pac model genpage transpile; pac model genpage list-connector-tables --dataset d; the `pac model genpage` family; "PAC CLI"; pac is Y; the `pac` profile.',
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
  ]);
  assert.deepEqual(verdicts.filter(([, ok]) => ok).map(([command]) => command), [
    'pac help', 'pac auth list', 'pac auth', 'pac org who', 'pac model genpage list', 'pac model genpage download', 'pac model genpage generate-types',
    'pac model genpage add', 'pac model genpage transpile', 'pac model genpage list-connector-tables', 'pac model genpage',
  ]);
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
  // Each of the seven is given to the agent somewhere: a script no document names is a command nobody was told about.
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
  ].join('\n');
  assert.deepEqual(scriptCommands(sample).map(({ script, subcommand, flags }) => [script, subcommand, flags]), [
    ['apps.js', 'list', ['env', 'search']],
    ['genpage-upload.js', null, ['env', 'code-file', 'add-to-sitemap']],
    ['connector.js', 'schema', ['env', 'dataset', 'table']],
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
  const tables = newApp.indexOf("**The first page's tables.**");
  assert.ok(first >= 0 && first < app && app < rest && rest < tables, 'the order is the first page, the app, the other pages, then the first page\'s tables');
  assert.match(newApp, /Run the create above without `--app-id` and without `--add-to-sitemap`\./);
  assert.match(newApp, /node "\$\{PLUGIN_ROOT\}\/scripts\/apps\.js" create ` --env '<org-url>' ` --name '<App Name>' ` --solution '<Solution unique name>' ` --page-id '<first-page-id>' ` --publish/);
  assert.match(newApp, /\*\*`--publish` is mandatory:\*\* without it the new app stays in draft/);
  assert.match(newApp, /a create into `Default` needs no add and did not fail/);
  assert.match(newApp, /Upload each with `--app-id '<appId>'` and `--add-to-sitemap`/);
  assert.match(newApp, /Upload the first page again as an update that names the app/);
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
  assert.match(builder, /This form is always answered by `pac` \(`"source": "pac"`, no `fallback`\): the SDK has no read of a connector's tables/);
  assert.match(builder, /`connectionsSource` is `"sdk"`/);
  assert.match(builder, /`connectionsFallback` \(`\{ code, message \}`\) says why the SDK was not used/);
  assert.match(builder, /`pac model genpage list-connector-tables --environment '<ENV_URL>' --connector-id <connectorName> --connection-id <connId> \[--dataset <ds>\]` may help pick the table: no script replaces it/);
  assert.match(builder, /A failure of the SDK's own read prints `\{ "ok": false, "error", "code" \}` on stdout; any other failure/);
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
  assert.match(skill, /never a settings value or a connection id/);
});

test('the docs that draw the flows name the scripts: apps.js list and genpage-upload.js', () => {
  const architecture = doc('docs', 'architecture.md');
  assert.match(architecture, /^ +apps\.js list$/m);
  assert.match(architecture, /^ +genpage-upload\.js --page-id \.\.\.$/m);
});
