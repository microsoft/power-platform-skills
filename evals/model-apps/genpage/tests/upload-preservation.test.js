'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WORKFLOW_ASSERTIONS, PHASE_EXPECTATIONS } = require('../lib/assertions-layer-1.js');

const PROMPT_RULE = [...WORKFLOW_ASSERTIONS.keys()].find((key) => key.startsWith('Phase 6 / 6.5'));
const CREATE = 'Phase 6: Create uploads use name-file and preserve the exact approved name prompt and agent-message text';
const EDIT = 'Edit Phase 6: Updates preserve omitted name model data sources and untouched connector and action bindings';
const APP = '11111111-1111-4111-8111-111111111111';
const PAGE = '66666666-6666-4666-8666-666666666666';
const name = 'Revenue $100 $(Get-Date)';
const prompt = 'Build the "Revenue" summary.\nKeep %PATH%, &, | and all approved text.\n';
const agentMessage = 'Created the approved summary.\n';
const connector = { logicalName: 'cnt_docs', connectorId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline', dataset: 'https://contoso.sharepoint.com/sites/team', tables: ['77777777-7777-4777-8777-777777777777'] };
const action = { name: 'cnt_ApproveOrder', isFunction: false, boundEntityLogicalName: 'salesorder', displayName: 'Approve Order', parameterKinds: { Comment: 'String' } };

function uploadFixture(edit = false, { appless = false } = {}) {
  const beforeConfig = { model: 'gpt-4.1', dataSources: ['account'], connectorBindings: [connector], actionBindings: [action] };
  const beforePage = { pageId: PAGE, appId: APP, name: edit ? 'Renamed Revenue' : name, navigationTitle: edit ? 'Original Dashboard' : name };
  // A create with no app is the first page of a new app: the app is built from it afterwards, so it has no --app-id and nothing to place it in.
  const afterPage = appless ? { pageId: PAGE, name } : beforePage;
  const text = edit ? 'Add sorting only.\n' : prompt;
  const call = {
    id: 'upload',
    command: `node scripts\\genpage-upload.js --env https://contoso.crm.dynamics.com ${appless ? '' : `--app-id ${APP} `}--code-file page.tsx --prompt-file prompt.txt --agent-message-file agent-message.txt `
      + (edit ? `--page-id ${PAGE}` : `--name-file page-name.txt --model gpt-4.1${appless ? '' : ' --add-to-sitemap'}`),
    result: { ok: true, pageId: PAGE, ...(!appless && { appId: APP }), updated: edit },
    writes: 1,
    // What genpage-upload.js hands the page backend: a flag that was omitted is absent, so an update that renames nothing sends no name, model or data sources.
    forwarded: edit
      ? { appId: APP, pageId: PAGE, prompt: text, agentMessage }
      : { name: beforePage.name, model: 'gpt-4.1', prompt: text, agentMessage },
  };
  return {
    contractVersion: 2,
    manifest: {
      contractVersion: 2, provenance: 'synthetic',
      uploads: [{ event: 'upload', mode: edit ? 'update' : 'create', approvedName: edit ? undefined : name, approvedPrompt: text, approvedAgentMessage: agentMessage,
        ...(edit && { beforeConfig: 'before/config.json', beforePage: 'before/page.json' }), afterConfig: 'after/config.json', afterPage: 'after/page.json', changes: {} }],
    },
    events: [call],
    workflowLog: `## Phase 6 - Deploy\n${call.command}\nPrompt scope: ${edit ? 'delta' : 'full page description'}\n`,
    genpagePlan: `## User Requirements\n${prompt}\n## Environment\nSolution: Default\n`,
    files: [{ name: 'page.tsx', content: 'const GeneratedComponent = () => null;\nexport default GeneratedComponent;\n' }],
    artifacts: {
      'prompt.txt': text, 'agent-message.txt': agentMessage, 'page-name.txt': name + '\n',
      'before/config.json': JSON.stringify(beforeConfig), 'before/page.json': JSON.stringify(beforePage),
      'after/config.json': JSON.stringify(edit ? beforeConfig : { model: 'gpt-4.1', dataSources: [], connectorBindings: [], actionBindings: [] }),
      'after/page.json': JSON.stringify(afterPage),
    },
  };
}

function score(fixture) {
  return WORKFLOW_ASSERTIONS.get(PROMPT_RULE)({ fixture, eval: { id: 20 } });
}

function changeArtifact(fixture, path, mutate) {
  const value = JSON.parse(fixture.artifacts[path]);
  mutate(value);
  fixture.artifacts[path] = JSON.stringify(value);
}

test('create uses name-file without rewriting approved text', () => {
  const good = uploadFixture();
  assert.equal(score(good).status, 'pass');
  const inline = uploadFixture();
  inline.workflowLog = 'pac model genpage upload --name "Revenue $100 $(Get-Date)" --prompt "Build it" --add-to-sitemap';
  inline.events[0].command = inline.workflowLog;
  assert.equal(score(inline).status, 'fail', 'the audit unsafe raw transport must not score current-compliant');
  for (const mutate of [
    (fixture) => { fixture.events[0].command = fixture.events[0].command.replace('--name-file page-name.txt', '--name Revenue'); },
    (fixture) => { fixture.artifacts['page-name.txt'] = 'Revenue \n'; },
    (fixture) => { fixture.artifacts['prompt.txt'] = prompt.replace(/"/g, "'"); },
    (fixture) => { fixture.events[0].forwarded.prompt = prompt.trimEnd(); },
    (fixture) => { fixture.events[0].forwarded.agentMessage = 'Something else'; },
    (fixture) => { fixture.events[0].forwarded.name = 'Revenue '; },
    (fixture) => { fixture.events[0].command += ' --prompt inline'; },
  ]) {
    const fixture = uploadFixture();
    mutate(fixture);
    assert.equal(score(fixture).status, 'fail');
  }
  assert.equal(typeof PHASE_EXPECTATIONS.get(CREATE), 'function');
  assert.equal(PHASE_EXPECTATIONS.get(CREATE)({ fixture: good }).status, 'pass');
});

test('a create needs no app: the first page of a new app has no --app-id and no --add-to-sitemap, and a create that names an app places its page', () => {
  const first = uploadFixture(false, { appless: true });
  assert.equal(score(first).status, 'pass', 'an app-less create is the first page of a new app');
  assert.equal(PHASE_EXPECTATIONS.get(CREATE)({ fixture: first }).status, 'pass');
  for (const [mutate, reason] of [
    [(fixture) => { fixture.events[0].command += ' --add-to-sitemap'; }, /--add-to-sitemap needs --app-id/],
    [(fixture) => { fixture.events[0].result.appId = APP; }, /does not preserve the requested app\/page identity/],
  ]) {
    const fixture = uploadFixture(false, { appless: true });
    mutate(fixture);
    const result = score(fixture);
    assert.equal(result.status, 'fail');
    assert.match(result.reason, reason);
  }
  // Naming an app places the page in it; a create that names one and leaves the page out of its navigation is not the skill's create.
  const unplaced = uploadFixture();
  unplaced.events[0].command = unplaced.events[0].command.replace(' --add-to-sitemap', '');
  const placed = score(unplaced);
  assert.equal(placed.status, 'fail');
  assert.match(placed.reason, /a create that names an app must include --add-to-sitemap/);
  const notAGuid = uploadFixture();
  notAGuid.events[0].command = notAGuid.events[0].command.replace(`--app-id ${APP}`, '--app-id not-a-guid');
  assert.match(score(notAGuid).reason, /upload app-id is not a GUID/);
});

test('edit keeps name model and untouched bindings', () => {
  const good = uploadFixture(true);
  assert.equal(score(good).status, 'pass');
  for (const mutate of [
    (fixture) => { changeArtifact(fixture, 'after/page.json', (page) => { page.name = page.navigationTitle; }); },
    (fixture) => { changeArtifact(fixture, 'after/config.json', (config) => { config.model = ''; }); },
    (fixture) => { changeArtifact(fixture, 'after/config.json', (config) => { config.connectorBindings = []; }); },
    (fixture) => { changeArtifact(fixture, 'after/config.json', (config) => { config.actionBindings = []; }); },
    (fixture) => { changeArtifact(fixture, 'after/config.json', (config) => { config.dataSources = []; }); },
    // Nothing is forwarded for a flag the update left out: the page backend keeps the page's own, and a value sent anyway is a change nobody approved.
    (fixture) => { fixture.events[0].forwarded.model = 'gpt-5'; },
    (fixture) => { fixture.events[0].forwarded.name = 'Another name'; },
    (fixture) => { fixture.events[0].forwarded.dataSources = []; },
    (fixture) => { fixture.events[0].command += ' --connectors empty.json'; fixture.artifacts['empty.json'] = '[]'; },
    (fixture) => { fixture.events[0].result.pageId = APP; },
    (fixture) => { fixture.events[0].command += ' --add-to-sitemap'; },
    (fixture) => { fixture.events[0].command = fixture.events[0].command.replace(`--app-id ${APP} `, ''); },
  ]) {
    const fixture = uploadFixture(true);
    mutate(fixture);
    assert.equal(score(fixture).status, 'fail');
  }
  assert.equal(typeof PHASE_EXPECTATIONS.get(EDIT), 'function');
  assert.equal(PHASE_EXPECTATIONS.get(EDIT)({ fixture: good }).status, 'pass');
});

test('an update that names the page of an app-less create that did not finish completes it, with or without the app', () => {
  // genpage-upload.js: a create whose publish or placement failed leaves its page unfinished, and naming that page again completes it — for a page created with no app,
  // without --app-id; with --add-to-sitemap when the create was asked to place it. Any other update names its app and omits --add-to-sitemap.
  const failedCreate = (appId) => ({
    id: 'create', command: `node scripts\\genpage-upload.js --env https://contoso.crm.dynamics.com ${appId ? `--app-id ${appId} ` : ''}--code-file page.tsx --prompt-file prompt.txt --agent-message-file agent-message.txt --name-file page-name.txt --model gpt-4.1${appId ? ' --add-to-sitemap' : ''}`,
    result: { ok: false, pageId: PAGE, ...(appId && { appId }), error: 'page was created, but publishing it failed' },
  });
  const finish = (tail) => ({ id: 'upload', command: `node scripts\\genpage-upload.js --env https://contoso.crm.dynamics.com ${tail} --code-file page.tsx --prompt-file prompt.txt --agent-message-file agent-message.txt`, result: { ok: true, pageId: PAGE, updated: true } });
  const run = (...events) => {
    const fixture = uploadFixture(true);
    delete fixture.manifest.uploads;
    fixture.events = events;
    return fixture;
  };
  const appless = finish(`--page-id ${PAGE}`);
  assert.equal(score(run(failedCreate(null), appless)).status, 'pass', 'an app-less create is finished by naming its page, with no app');
  assert.equal(score(run(failedCreate(null), { ...appless, id: 'other', command: appless.command.replace(PAGE, '88888888-8888-4888-8888-888888888888'), result: { ...appless.result, pageId: '88888888-8888-4888-8888-888888888888' } })).status, 'fail', 'another page is an ordinary update, which names its app');
  assert.equal(score(run(appless)).status, 'fail', 'with no unfinished create ahead of it, an update with no app is an ordinary one');
  const placed = finish(`--app-id ${APP} --page-id ${PAGE} --add-to-sitemap`);
  placed.result.appId = APP;
  assert.equal(score(run(failedCreate(APP), placed)).status, 'pass', 'the placement that failed is finished with --page-id and --add-to-sitemap');
  assert.match(score(run({ ...failedCreate(APP), result: { ok: true, pageId: PAGE, appId: APP, updated: false } }, placed)).reason, /update must name a valid page id and omit sitemap placement/, 'a create that finished leaves nothing to complete');
});

test('explicit rename and model win without changing the navigation title', () => {
  const fixture = uploadFixture(true);
  const row = fixture.manifest.uploads[0];
  row.changes.name = 'Revenue Revised';
  row.changes.model = 'gpt-5';
  fixture.artifacts['rename.txt'] = row.changes.name + '\n';
  fixture.events[0].command += ' --name-file rename.txt --model gpt-5';
  Object.assign(fixture.events[0].forwarded, { name: row.changes.name, model: row.changes.model });
  changeArtifact(fixture, 'after/page.json', (page) => { page.name = row.changes.name; });
  changeArtifact(fixture, 'after/config.json', (config) => { config.model = row.changes.model; });
  assert.equal(score(fixture).status, 'pass');
  changeArtifact(fixture, 'after/page.json', (page) => { page.navigationTitle = row.changes.name; });
  assert.equal(score(fixture).status, 'fail');
});

test('connector and action sets preserve, add, remove and explicitly clear with full bare arrays', () => {
  for (const [kind, flag, key, added] of [
    ['connectors', 'connectors', 'connectorBindings', { ...connector, logicalName: 'cnt_weather', connectorId: '/providers/Microsoft.PowerApps/apis/shared_msnweather', dataset: '', tables: undefined, operations: ['CurrentWeather'] }],
    ['actions', 'actions', 'actionBindings', { name: 'cnt_GetOrderSummary', isFunction: true, displayName: 'Summary', parameterKinds: { OrderId: 'Guid' } }],
  ]) {
    for (const mode of ['add', 'remove', 'clear']) {
      const fixture = uploadFixture(true);
      const original = kind === 'connectors' ? connector : action;
      const idKey = kind === 'connectors' ? 'logicalName' : 'name';
      fixture.manifest.uploads[0].changes[kind] = mode === 'add' ? { add: [added] } : mode === 'remove' ? { remove: [original[idKey]] } : { clear: true };
      const retained = { ...original, [idKey]: `${original[idKey]}_retained` };
      if (mode === 'remove') changeArtifact(fixture, 'before/config.json', (config) => { config[key].push(retained); });
      const expected = mode === 'add' ? [original, added] : mode === 'remove' ? [retained] : [];
      fixture.artifacts[`${flag}.json`] = JSON.stringify(expected);
      fixture.events[0].command += ` --${flag} ${flag}.json`;
      changeArtifact(fixture, 'after/config.json', (config) => { config[key] = expected; });
      assert.equal(score(fixture).status, 'pass', `${kind} ${mode}`);
      fixture.artifacts[`${flag}.json`] = JSON.stringify({ [key]: expected });
      assert.equal(score(fixture).status, 'fail', 'config wrapper is not a bare array');
    }
    const missingUntouched = uploadFixture(true);
    missingUntouched.manifest.uploads[0].changes[kind] = { add: [added] };
    missingUntouched.artifacts[`${flag}.json`] = JSON.stringify([added]);
    missingUntouched.events[0].command += ` --${flag} ${flag}.json`;
    changeArtifact(missingUntouched, 'after/config.json', (config) => { config[key] = [added]; });
    assert.equal(score(missingUntouched).status, 'fail', `${kind}: add cannot erase the original`);
  }
});

test('a name is stored exactly as approved: a straight quote, a percent sign and a command substitution are only text', () => {
  for (const approvedName of ['Say "hi"', 'Margin 100%', 'Revenue $100 $(Get-Date)', "Maker's Revenue", 'Revenue \u201cFY\u201d']) {
    const fixture = uploadFixture();
    fixture.manifest.uploads[0].approvedName = approvedName;
    fixture.artifacts['page-name.txt'] = approvedName + '\n';
    fixture.events[0].forwarded.name = approvedName;
    changeArtifact(fixture, 'after/page.json', (page) => { page.name = approvedName; page.navigationTitle = approvedName; });
    assert.equal(score(fixture).status, 'pass', approvedName);
    // The page backend does not escape, so a quote stored as `\"` (the way an earlier release stored it) is a different name from the approved one.
    if (approvedName.includes('"')) {
      changeArtifact(fixture, 'after/page.json', (page) => { page.name = approvedName.replace(/"/g, '\\"'); });
      assert.equal(score(fixture).status, 'fail', `${approvedName}: an escaped quote is not the approved name`);
    }
  }
  // A straight quote is not refused any more: a create recorded as refused for it is not a successful one.
  const refused = uploadFixture();
  refused.manifest.uploads[0].approvedName = 'Say "hi"';
  refused.artifacts['page-name.txt'] = 'Say "hi"\n';
  refused.events[0].result = { ok: false, error: 'The page name contains an ASCII double quote.' };
  refused.events[0].writes = 0;
  delete refused.events[0].forwarded;
  const result = score(refused);
  assert.equal(result.status, 'fail', 'a quote is stored, so a create that was refused for one is wrong');
  assert.match(result.reason, /expected successful upload is refused or has no single page write/);
});

test('an update that gives no name, model or data sources keeps the page\u2019s own and sends nothing for them', () => {
  // The own name an earlier release stored with an escaped quote stays as it is: the page backend rewrites nothing it was not asked to.
  for (const ownName of ['Say \\"hi\\"', 'Margin 100%', 'Say "hi"']) {
    const fixture = uploadFixture(true);
    changeArtifact(fixture, 'before/page.json', (page) => { page.name = ownName; });
    changeArtifact(fixture, 'after/page.json', (page) => { page.name = ownName; });
    assert.equal(score(fixture).status, 'pass', ownName);
    // Re-sent, or stored differently, it is no longer the page's own.
    fixture.events[0].forwarded.name = ownName;
    assert.equal(score(fixture).status, 'fail', `${ownName}: an omitted name is not sent again`);
    delete fixture.events[0].forwarded.name;
    changeArtifact(fixture, 'after/page.json', (page) => { page.name = `${ownName} (edited)`; });
    assert.equal(score(fixture).status, 'fail', `${ownName}: the stored name changed`);
  }
  // An update that does give a model or data sources sends exactly those, and the read-back agrees.
  const explicit = uploadFixture(true);
  explicit.manifest.uploads[0].changes.dataSources = ['account', 'contact'];
  explicit.manifest.uploads[0].changes.model = 'gpt-5';
  explicit.events[0].command += ' --data-sources account,contact --model gpt-5';
  Object.assign(explicit.events[0].forwarded, { dataSources: ['account', 'contact'], model: 'gpt-5' });
  changeArtifact(explicit, 'after/config.json', (config) => { config.dataSources = ['account', 'contact']; config.model = 'gpt-5'; });
  assert.equal(score(explicit).status, 'pass');
  explicit.events[0].forwarded.dataSources = ['account'];
  assert.equal(score(explicit).status, 'fail', 'the data sources sent are not the ones asked for');
  // `--clear-data-sources` is the one way to empty the list, and it sends an empty one.
  const cleared = uploadFixture(true);
  cleared.manifest.uploads[0].changes.dataSources = [];
  cleared.events[0].command += ' --clear-data-sources';
  cleared.events[0].forwarded.dataSources = [];
  changeArtifact(cleared, 'after/config.json', (config) => { config.dataSources = []; });
  assert.equal(score(cleared).status, 'pass');
  delete cleared.events[0].forwarded.dataSources;
  assert.equal(score(cleared).status, 'fail', 'clearing sends an empty list, not nothing');
});

test('#673 divergence refusals stop before the page backend writes, and only the logged explicit choice authorizes an overwrite', () => {
  for (const code of ['no-base', 'deployed-changed', 'deployed-unreadable']) {
    const refused = uploadFixture(true);
    refused.manifest.uploads[0].outcome = 'refused';
    refused.events[0].result = {
      ok: false, code, pageId: PAGE, appId: APP, error: `refused: ${code}`,
      ...(code === 'deployed-changed' && { lines: { added: 3, removed: 1 }, deployedCopy: 'page.tsx.deployed.tsx' }),
    };
    refused.events[0].writes = 0;
    delete refused.events[0].forwarded;
    assert.equal(score(refused).status, 'pass', code);
    refused.events[0].writes = 1;
    assert.equal(score(refused).status, 'fail', `${code}: the refusal must precede the page backend write`);
  }
  const noSummary = uploadFixture(true);
  noSummary.manifest.uploads[0].outcome = 'refused';
  noSummary.events[0].result = { ok: false, code: 'deployed-changed', pageId: PAGE, appId: APP, error: 'refused' };
  noSummary.events[0].writes = 0;
  delete noSummary.events[0].forwarded;
  assert.equal(score(noSummary).status, 'fail', 'deployed-changed must carry its line summary');
  const createRefused = uploadFixture();
  createRefused.manifest.uploads[0].outcome = 'refused';
  createRefused.events[0].result = { ok: false, code: 'no-base', pageId: PAGE, appId: APP, error: 'refused' };
  createRefused.events[0].writes = 0;
  delete createRefused.events[0].forwarded;
  assert.equal(score(createRefused).status, 'fail', 'a divergence refusal can only answer an update');

  const overwrite = uploadFixture(true);
  overwrite.events[0].command += ' --overwrite-deployed';
  overwrite.events[0].result.overwroteDeployed = true;
  assert.equal(score(overwrite).status, 'fail', 'an overwrite without the logged choice is unauthorized');

  function logAround(fixture, before, after = '') {
    fixture.workflowLog = `${before}## Phase 6 - Deploy\n${fixture.events[0].command}\n${after}Prompt scope: delta\n`;
  }
  const optionsOnly = uploadFixture(true);
  optionsOnly.events[0].command += ' --overwrite-deployed';
  logAround(optionsOnly, 'Options: Overwrite the deployed changes | Stop so I can merge\n');
  assert.equal(score(optionsOnly).status, 'fail', 'an options list is not a choice');
  const stopped = uploadFixture(true);
  stopped.events[0].command += ' --overwrite-deployed';
  logAround(stopped, 'Choice: Stop so I can merge\n');
  assert.equal(score(stopped).status, 'fail', 'stopping is not consent to overwrite');
  const after = uploadFixture(true);
  after.events[0].command += ' --overwrite-deployed';
  logAround(after, '', 'Choice: Overwrite the deployed changes\n');
  assert.equal(score(after).status, 'fail', 'a choice after the command does not authorize it');
  const before = uploadFixture(true);
  before.events[0].command += ' --overwrite-deployed';
  before.events[0].result.overwroteDeployed = true;
  logAround(before, 'Choice: Overwrite the deployed changes\n');
  assert.equal(score(before).status, 'pass', 'the last Choice line before the command authorizes the overwrite');

  const contradictory = uploadFixture(true);
  contradictory.events[0].result = {
    ok: true, code: 'deployed-changed', pageId: PAGE, appId: APP,
    lines: { added: 3, removed: 1 },
  };
  const contradicted = score(contradictory);
  assert.equal(contradicted.status, 'fail', 'a divergence code cannot ride on ok:true / writes:1 / forwarded');
  assert.match(contradicted.reason, /must stop the update before the page backend writes/);

  // Each clause on its own: a recorded refusal row skips the row-level write checks, so only the
  // per-call rule can catch these.
  const okWithoutWrite = uploadFixture(true);
  okWithoutWrite.manifest.uploads[0].outcome = 'refused';
  okWithoutWrite.events[0].result = { ok: true, code: 'no-base', pageId: PAGE, appId: APP };
  okWithoutWrite.events[0].writes = 0;
  delete okWithoutWrite.events[0].forwarded;
  assert.equal(score(okWithoutWrite).status, 'fail', 'a divergence code is never a success, even with no write');
  const forwardedRefusal = uploadFixture(true);
  forwardedRefusal.manifest.uploads[0].outcome = 'refused';
  forwardedRefusal.events[0].result = { ok: false, code: 'deployed-unreadable', pageId: PAGE, appId: APP, error: 'refused' };
  forwardedRefusal.events[0].writes = 0;
  assert.equal(score(forwardedRefusal).status, 'fail', 'a refusal cannot have forwarded arguments to the page backend');
});

test('an overwrite approval is consumed by one upload and does not cover a later one', () => {
  const PAGE2 = '88888888-8888-4888-8888-888888888888';
  const commandFor = (pageId) => uploadFixture(true).events[0].command.replace(`--page-id ${PAGE}`, `--page-id ${pageId}`) + ' --overwrite-deployed';
  const pair = (lines, pageIds) => {
    const fixture = uploadFixture(true);
    delete fixture.manifest.uploads;
    fixture.events = pageIds.map((pageId, index) => {
      const call = uploadFixture(true).events[0];
      call.id = `upload-${index}`;
      call.command = commandFor(pageId);
      call.result = { ...call.result, pageId, overwroteDeployed: true };
      call.forwarded = { ...call.forwarded, pageId };
      return call;
    });
    fixture.workflowLog = `${lines.join('\n')}\n`;
    return fixture;
  };
  const same = commandFor(PAGE);
  const reused = score(pair([
    'Choice: Overwrite the deployed changes',
    same,
    'Choice: Stop so I can merge',
    same,
  ], [PAGE, PAGE]));
  assert.equal(reused.status, 'fail', 'a later identical upload must not reuse the first approval');
  assert.match(reused.reason, /Overwrite the deployed changes/);

  const twoPages = score(pair([
    'Choice: Overwrite the deployed changes',
    commandFor(PAGE),
    commandFor(PAGE2),
  ], [PAGE, PAGE2]));
  assert.equal(twoPages.status, 'fail', 'one approval cannot cover overwrite uploads to two pages');
  assert.match(twoPages.reason, /Overwrite the deployed changes/);

  const each = score(pair([
    'Choice: Overwrite the deployed changes',
    commandFor(PAGE),
    'Choice: Overwrite the deployed changes',
    commandFor(PAGE2),
  ], [PAGE, PAGE2]));
  assert.equal(each.status, 'pass', 'an approval immediately before each upload authorizes that upload only');

  // An approval consumed by an upload that did NOT overwrite (`=false`) is spent: a later bare
  // `--overwrite-deployed`, whose command starts with the earlier one's text, gets the Stop answer.
  const explicitFalse = commandFor(PAGE).replace(/ --overwrite-deployed$/, ' --overwrite-deployed=false');
  const spent = pair([
    'Choice: Overwrite the deployed changes',
    explicitFalse,
    'Choice: Stop so I can merge',
    commandFor(PAGE),
  ], [PAGE, PAGE]);
  spent.events[0].command = explicitFalse;
  delete spent.events[0].result.overwroteDeployed;
  const spentScore = score(spent);
  assert.equal(spentScore.status, 'fail', 'an approval spent by an =false upload cannot authorize a later overwrite');
  assert.match(spentScore.reason, /Overwrite the deployed changes/);

  // The logged line must carry the call's exact command. Out-of-order evidence makes the bare
  // overwrite look for its entry first; a prefix match would hand it the approval logged before the
  // `=false` command, instead of the Stop logged before its own.
  const outOfOrder = pair([
    'Choice: Overwrite the deployed changes',
    explicitFalse,
    'Choice: Stop so I can merge',
    commandFor(PAGE),
  ], [PAGE, PAGE]);
  outOfOrder.events[1].command = explicitFalse;
  delete outOfOrder.events[1].result.overwroteDeployed;
  assert.equal(score(outOfOrder).status, 'fail', 'a longer command that merely starts with this one is a different upload');
});

test('current upload evidence cannot hide missing or unassociated calls', () => {
  const empty = uploadFixture();
  empty.events = [];
  delete empty.manifest.uploads;
  assert.equal(score(empty).status, 'fail', 'a current complete workflow must actually upload');
  const unassociated = uploadFixture();
  unassociated.workflowLog += '\npac model genpage upload --name "unsafe" --prompt "borrowed"\n';
  assert.equal(score(unassociated).status, 'fail', 'every logged upload must have its own result event');
  assert.equal(score(uploadFixture()).status, 'pass');
});

test('the dedicated preservation assertions fail without their own evidence', () => {
  const grade = (text, fixture) => PHASE_EXPECTATIONS.get(text)({ fixture, eval: { id: 20 } });
  assert.equal(grade(CREATE, uploadFixture()).status, 'pass');
  assert.equal(grade(EDIT, uploadFixture(true)).status, 'pass');
  for (const [text, edit] of [[CREATE, false], [EDIT, true]]) {
    const missing = uploadFixture(edit);
    delete missing.manifest.uploads;
    const result = grade(text, missing);
    assert.equal(result.status, 'fail', `${text}: no manifest.uploads must not pass on the transport verdict alone`);
    assert.match(result.reason, /no (create|update) upload preservation evidence/);
  }
  // Each assertion needs a row for its own mode: create evidence cannot satisfy the edit check.
  const createOnly = grade(EDIT, uploadFixture());
  assert.equal(createOnly.status, 'fail');
  assert.match(createOnly.reason, /no update upload preservation evidence/);
  const refusedOnly = uploadFixture();
  refusedOnly.manifest.uploads[0].outcome = 'refused';
  assert.match(grade(CREATE, refusedOnly).reason, /no create upload preservation evidence/, 'a refused create is not create evidence');
});
