const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildInitialState } = require('../../skills/migrate-datamodel/scripts/lib/migration-state-schema');
const { renderLiveReport } = require('../../skills/migrate-datamodel/scripts/lib/render-live-report');

function components(sdm, edm, sdmErrors = {}) {
  const state = buildInitialState({ webSiteId: 'site-id', outputDir: 'migration-reports' });
  const snapshot = (inventory, parseErrors = {}) => ({
    counts: Object.fromEntries(Object.entries(inventory).map(([category, records]) => [category, records.length])),
    inventory, parseErrors,
  });
  const html = renderLiveReport(state, { sdmSnapshot: snapshot(sdm, sdmErrors), edmSnapshot: snapshot(edm) });
  return html.slice(html.indexOf('id="tab-pages"'), html.indexOf('id="tab-migration"') > 0
    ? html.indexOf('id="tab-migration"') : undefined);
}

test('equal inventory counts cannot hide replacement identities or changed values in the report', () => {
  const replaced = components({ webTemplates: [{ name: 'Before' }] }, { webTemplates: [{ name: 'After' }] });
  assert.match(replaced, /comp-pill mismatch/);
  assert.match(replaced, /Different records/);
  assert.doesNotMatch(replaced, /comp-pill match"/);
  const changed = components({ siteSettings: [{ name: 'Search', value: 'true' }] },
    { siteSettings: [{ name: 'Search', value: 'false' }] });
  assert.match(changed, /comp-pill warn/);
  assert.match(changed, /Changed records/);
  assert.match(changed, /0 of 1 categories matched/);
});

test('parse failures, ambiguous identities and one-sided content loss cannot render a clean match', () => {
  const records = { webTemplates: [{ name: 'Header', contentHash: 'hash' }] };
  assert.match(components(records, records, { webTemplates: [{ message: 'invalid YAML' }] }),
    /Incomplete snapshot/);
  const duplicate = { basicForms: [{ name: 'Same', slug: 'one' }, { name: 'Same', slug: 'two' }] };
  assert.match(components(duplicate, duplicate), /comp-pill mismatch/);
  assert.match(components(records, { webTemplates: [{ name: 'Header', contentHash: null }] }),
    /comp-pill warn/);
  assert.match(components(records, records), /1 of 1 categories matched/);
});

test('prompt links allow local files but never executable URI schemes', () => {
  const state = buildInitialState({ webSiteId: 'site-id', outputDir: 'migration-reports' });
  for (const promptPath of ['javascript:alert(1)', 'data:text/html,test', '\tjavascript:alert(1)', '//contoso.com/x', 'file://contoso.com/share/prompt.txt']) {
    state.augmentedPrompts.plugin = { status: 'ready', path: promptPath };
    const html = renderLiveReport(state);
    assert.ok(!html.includes(`href="${promptPath}"`));
    assert.match(html, /unsupported link/);
  }
  for (const promptPath of ['plugin-remediation-prompt.txt', 'file:///tmp/plugin-prompt.txt']) {
    state.augmentedPrompts.plugin.path = promptPath;
    assert.ok(renderLiveReport(state).includes(`href="${promptPath}"`));
  }
});

test('customization report links reuse local-file validation and visibly reject unsupported links', () => {
  const state = buildInitialState({ webSiteId: 'site-id', outputDir: 'migration-reports' });
  state.customizationReport = { totalFindings: 1, breakdown: { liquid: 1 } };
  for (const value of ['javascript:alert(1)', 'data:text/html,test', '//contoso.com/x',
    'file://contoso.com/share/report.html', 'java\nscript:alert(1)']) {
    state.customizationReport.path = value;
    const html = renderLiveReport(state);
    assert.doesNotMatch(html, /class="cust-open-btn"/);
    assert.match(html, /Customization report unavailable: unsupported link/);
  }
  for (const value of ['customization-report.html', 'file:///tmp/report.html']) {
    state.customizationReport.path = value;
    assert.ok(renderLiveReport(state).includes(`class="cust-open-btn" href="${value}"`));
  }
});

test('portal links allow HTTPS without credentials and otherwise render inert text with an explanation', () => {
  const state = buildInitialState({ webSiteId: 'site-id', outputDir: 'migration-reports' });
  for (const value of ['javascript:alert(1)', 'data:text/html,test', '//contoso.com',
    'http://contoso.com', 'https://maker@contoso.com', 'https://contoso.com/\npath']) {
    state.site.portalUrl = value;
    const html = renderLiveReport(state);
    assert.doesNotMatch(html, /<a class="context-value"/);
    assert.match(html, /Unsupported portal link; HTTPS URL required/);
  }
  state.site.portalUrl = 'https://contoso.powerappsportals.com/';
  assert.match(renderLiveReport(state), /<a class="context-value" href="https:\/\/contoso\.powerappsportals\.com\/"/);
});

test('diff commands encode apostrophes separately for PowerShell and Bash and preserve other shell characters', () => {
  const state = buildInitialState({ webSiteId: 'site-id', outputDir: 'migration-reports' });
  const livePath = "C:\\O'Brien\\$(literal); & page.html";
  const stagedPath = "C:\\O'Brien\\staged `file`.html";
  const html = renderLiveReport(state, { remediationDiff: { files: [{
    relativePath: 'page.html', livePath, stagedPath, hunks: [],
  }] } });
  const commands = Object.fromEntries([...html.matchAll(
    /data-label="Copy (PowerShell|Bash) diff command" data-copy="([^"]*)"/g,
  )].map((match) => [match[1], match[2].replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')]));
  assert.deepEqual(commands, {
    PowerShell: `code --diff '${livePath.replace(/'/g, "''")}' '${stagedPath.replace(/'/g, "''")}'`,
    Bash: `code --diff '${livePath.replace(/'/g, "'\\''")}' '${stagedPath.replace(/'/g, "'\\''")}'`,
  });
  const invalid = renderLiveReport(state, { remediationDiff: { files: [{
    relativePath: 'page.html', livePath: 'bad\npath', stagedPath,
  }] } });
  assert.doesNotMatch(invalid, /data-label="Copy (PowerShell|Bash) diff command"/);
  assert.match(invalid, /Diff command unavailable: missing or unsupported file path/);
});

test('form steps and access-rule changes participate in the live comparison', () => {
  const step = { name: 'Details', parentForm: 'Order', targetEntity: 'account' };
  const missing = components({ advancedFormSteps: [step] }, { advancedFormSteps: [] });
  assert.match(missing, /Forms &amp; Lists/);
  assert.match(missing, /comp-pill mismatch/);
  assert.match(missing, /Details in Order/);
  const changed = components({ webpageRules: [{ name: 'Restrict', right: 2 }] },
    { webpageRules: [{ name: 'Restrict', right: 0 }] });
  assert.match(changed, /comp-pill warn/);
  assert.match(changed, /Changed records/);
});

for (const track of ['A', 'B']) {
  test(`track ${track} labels the existing percentage as workflow completion`, () => {
    const state = buildInitialState({
      webSiteId: '00000000-0000-0000-0000-000000000001',
      outputDir: 'migration-reports',
      track,
    });
    const steps = state.phases.flatMap((phase) => phase.subSteps);
    for (const completed of [0, 1, steps.length]) {
      for (const [index, step] of steps.entries()) {
        step.status = index < completed ? 'completed' : 'pending';
      }
      const percent = Math.round(completed / steps.length * 100);
      const html = renderLiveReport(state);
      assert.ok(html.includes(
        `<div class="stat-num">${percent}%</div><div class="stat-label">Workflow completion</div>`,
      ));
      assert.ok(html.includes(
        `<div class="stat-num">${completed} / ${steps.length}</div><div class="stat-label">Sub-steps</div>`,
      ));
    }
  });

  test(`track ${track} shows input pauses above every tab without implying active processing`, () => {
    const state = buildInitialState({ webSiteId: 'site-id', outputDir: 'migration-reports', track });
    state.approvalGate = null;
    state.phases[2].status = 'in-progress';
    state.currentOperation = { label: 'Migrating references', startedAt: state.skillStartedAt };
    state.pendingInput = { requiredAction: 'Restart the site, then confirm completion.' };
    const html = renderLiveReport(state);
    const notice = html.indexOf('<section class="approval-banner"');
    assert.ok(notice > 0 && notice < html.indexOf('<div class="layout">'));
    assert.equal((html.match(/id="user-action-notice"/g) || []).length, 1);
    assert.match(html, /role="alert" aria-labelledby="user-action-title"/);
    assert.match(html, /Your input is needed/);
    assert.match(html, /Restart the site, then confirm completion\./);
    assert.match(html, /Return to the migration conversation and provide your response\./);
    assert.match(html, /class="status-pill pending" href="#user-action-notice">Input needed/);
    assert.match(html, /inputNotice\.style\.scrollMarginTop = \(topbar\.offsetHeight \+ 16\)/);
    assert.doesNotMatch(html, /data-now-running data-op-started-at=/);

    state.pendingInput = null;
    const resumed = renderLiveReport(state);
    assert.doesNotMatch(resumed, /id="user-action-notice"/);
    assert.match(resumed, /data-now-running data-op-started-at=/);
    assert.match(resumed, /In Progress · Phase 3/);
  });

  test(`track ${track} preserves existing approval instructions in the report-wide notice`, () => {
    const state = buildInitialState({ webSiteId: 'site-id', outputDir: 'migration-reports', track });
    delete state.pendingInput;
    state.approvalGate = { phaseId: 2, kind: 'phase-start' };
    state.phases[0].status = 'in-progress';
    state.currentOperation = { label: 'Old operation', startedAt: state.skillStartedAt };
    const html = renderLiveReport(state);
    assert.ok(html.indexOf('id="user-action-notice"') < html.indexOf('<div class="layout">'));
    assert.match(html, /Awaiting Approval — Phase 2/);
    assert.match(html, /To approve and continue/);
    assert.match(html, /To cancel/);
    assert.doesNotMatch(html, /data-now-running data-op-started-at=/);
    assert.match(html, track === 'A' ? /Approve to start Phase 2: Configuration/ : /Approve to start Phase 2: Setting Up Metadata/);
  });
}

test('required actions and response locations render as text, not executable HTML', () => {
  const state = buildInitialState({ webSiteId: 'site-id', outputDir: 'migration-reports' });
  state.pendingInput = {
    requiredAction: '<img src=x onerror="alert(1)"> & review',
    responseLocation: '<script>alert(2)</script>',
  };
  const html = renderLiveReport(state);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; review/);
  assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img src=x|<script>alert\(2\)/);
});

for (const track of ['A', 'B']) {
  test(`track ${track} offers in-session runtime testing and distinguishes waiting from running`, () => {
    const state = buildInitialState({ webSiteId: 'site-id', outputDir: 'migration-reports', track });
    state.approvalGate = { phaseId: 4, kind: 'phase-start' };
    const approval = renderLiveReport(state);
    assert.match(approval, /offers <strong>Run now<\/strong> in the migration conversation/);
    assert.match(approval, /report an earlier run, defer, or skip/);
    assert.match(approval, /Optional rollback remains a separate choice/);
    assert.doesNotMatch(approval, /recommended via separate/);

    state.approvalGate = null;
    state.phases[3].status = 'in-progress';
    const runtimeStep = state.phases[3].subSteps.find((step) => step.id === '4.1');
    runtimeStep.status = 'in-progress';
    state.currentOperation = { label: 'Testing migrated site', startedAt: state.skillStartedAt };
    const phasesBefore = JSON.stringify(state.phases);
    const running = renderLiveReport(state);
    assert.match(running, /Now running: Testing migrated site/);
    assert.match(running, /class="now-running-bar-fill now-running-bar-indeterminate"/);
    assert.doesNotMatch(running, /data-op-expected-sec="/);
    assert.equal(JSON.stringify(state.phases), phasesBefore);
    assert.equal(state.phases[3].subSteps.find((step) => step.id === '4.2').status, 'pending');

    state.pendingInput = { requiredAction: 'Log in through the browser, then confirm here.' };
    const waiting = renderLiveReport(state);
    assert.match(waiting, /Log in through the browser, then confirm here\./);
    assert.doesNotMatch(waiting, /data-now-running data-op-started-at=/);
    assert.equal(JSON.stringify(state.phases), phasesBefore);
  });
}

test('runtime-test instructions wire Run now to the existing skill and preserve consent and report lifecycle', () => {
  const skill = fs.readFileSync(path.join(__dirname, '../../skills/migrate-datamodel/SKILL.md'), 'utf8');
  const runtime = skill.slice(skill.indexOf('### 4.1 Runtime Smoke Test'), skill.indexOf('### 4.2 Final Status'));
  assert.match(skill, /^allowed-tools:.*\bSkill\b/m);
  assert.match(runtime, /\| Run now, I've already run it, Defer until later, Skip entirely \|/);
  assert.match(runtime, /Use the \*\*Skill tool\*\* to invoke `power-pages:test-site` with `<SITE_URL>`/);
  assert.match(runtime, /do not launch a separate agent\/session or duplicate its browser workflow/);
  assert.match(runtime, /Phase 4 approval alone does not start the test/);
  assert.match(runtime, /--set-input '\{"requiredAction":"Choose Run now/);
  assert.match(runtime, /--set-step 4\.1 --status in-progress/);
  assert.match(runtime, /--set-operation '\{"label":"Testing migrated site"/);
  assert.match(runtime, /Before any test-owned login, permission, or continue\/stop question, show `--set-input`/);
  assert.match(runtime, /--clear-operation`, including on cancellation, tool failure, or early stop/);
  assert.match(runtime, /Never ask for passwords or tokens/);
  assert.match(runtime, /Do not submit forms or change site data/);
  assert.doesNotMatch(runtime, /Open a SEPARATE|Why we don't auto-invoke/);
});

test('runtime-test outcomes require fresh evidence and retain warnings, incomplete runs and user choices', () => {
  const skill = fs.readFileSync(path.join(__dirname, '../../skills/migrate-datamodel/SKILL.md'), 'utf8');
  const runtime = skill.slice(skill.indexOf('### 4.1 Runtime Smoke Test'), skill.indexOf('### 4.2 Final Status'));
  assert.match(runtime, /`docs\/alm\/last-test-site\.json`/);
  assert.match(runtime, /its `url` matches the confirmed site/);
  assert.match(runtime, /its `runAt` belongs to this invocation/);
  assert.match(runtime, /Never reuse a stale report or a report for another site/);
  assert.match(runtime, /`runOutcome: passed-with-warnings`/);
  assert.match(runtime, /actual tested\/failed\/skipped counts and any untested scope/);
  assert.match(runtime, /Not completed, with the explicit reason; never report passed/);
  assert.match(runtime, /Record this as \*\*user-reported\*\*/);
  assert.match(runtime, /Do not automatically retry/);
  assert.match(runtime, /"id":"runtime-smoke-test"/);
  assert.match(runtime, /records the resolved choice, not proof that all runtime checks passed/);
});

test('malformed saved pending input produces an explicit render error', () => {
  const state = buildInitialState({ webSiteId: 'site-id', outputDir: 'migration-reports' });
  for (const value of [false, [], 'question', {}, { requiredAction: null }, { requiredAction: 'Continue?', responseLocation: 1 }]) {
    state.pendingInput = value;
    assert.throws(() => renderLiveReport(state), /Pending input/);
  }
});

test('workflow instructions cover input notice lifecycle and both tracks manual-action pauses', () => {
  const skill = fs.readFileSync(path.join(__dirname, '../../skills/migrate-datamodel/SKILL.md'), 'utf8');
  assert.match(skill, /Show every user-input pause \(both tracks\)/);
  assert.match(skill, /before every skill-owned question, choice, confirmation, or manual-action wait/);
  assert.match(skill, /Before initialization there is no HTML report/);
  for (const action of ['Provide the Portal ID', 'Confirm in the migration conversation whether to activate',
    'Restart the site in Power Platform admin center', 'Review the SDM-to-EDM metadata diff',
    'Import the site configuration metadata']) {
    assert.ok(skill.includes(`--set-input '{"requiredAction":"${action}`), action);
  }
  assert.match(skill, /`--clear-input` \*\*before\*\* continuing or stopping/);
  assert.match(skill, /If the user says "Not yet".*keep the notice/);
});

test('approved package installation shows an indeterminate bar without advancing migration', () => {
  for (const track of ['A', 'B']) {
    const state = buildInitialState({ webSiteId: 'site-id', outputDir: 'migration-reports', track });
    state.approvalGate = null;
    state.phases[0].status = 'completed';
    state.phases[1].status = 'in-progress';
    state.phases[1].subSteps.find((step) => step.id === '2.2').status = 'completed';
    state.currentOperation = {
      label: 'Installing PowerPages_ProgramRegistration_V2',
      detail: 'Installation accepted; verifying installed version.',
      startedAt: '2026-01-01T12:00:00Z',
    };
    state.lastUpdatedAt = '2026-01-01T12:02:05Z';
    const phasesBefore = JSON.stringify(state.phases);
    const html = renderLiveReport(state);
    assert.match(html, /Now running: Installing PowerPages_ProgramRegistration_V2/);
    assert.match(html, /Installation accepted; verifying installed version\./);
    assert.match(html, /class="now-running-bar-fill now-running-bar-indeterminate"/);
    assert.match(html, /data-now-running-elapsed>2m 05s/);
    assert.doesNotMatch(html, /data-op-expected-sec="|<span class="now-running-poll">/);
    assert.ok(html.indexOf('data-now-running data-op-started-at=') < html.indexOf('<div class="layout">'));
    assert.equal(JSON.stringify(state.phases), phasesBefore);
    assert.ok(state.phases[2].subSteps.every((step) => step.status === 'pending'));

    state.currentOperation = null;
    assert.doesNotMatch(renderLiveReport(state), /data-now-running data-op-started-at=/);
  }
});

test('package progress instructions cover all installation paths and asynchronous verification', () => {
  const skill = fs.readFileSync(path.join(__dirname, '../../skills/migrate-datamodel/SKILL.md'), 'utf8');
  assert.equal((skill.match(/\[Package installation progress\]\(#package-installation-progress\)/g) || []).length, 3);
  assert.match(skill, /--set-operation '\{"label":"Installing <PACKAGE_NAME>","detail":/);
  assert.match(skill, /Keep the banner active through asynchronous installation and verification/);
  assert.match(skill, /Do not invent an installation percentage or ETA/);
  assert.match(skill, /keep the same `Installing <PACKAGE_NAME>` label/);
  assert.match(skill, /Do not start a second install just because the first one is slow/);
  assert.match(skill, /On verified completion, `--clear-operation`/);
  assert.match(skill, /Fresh report only:.*Phase 1 is already running/);
  assert.match(skill, /`--approve-and-start 1`.*existing work/);
  assert.match(skill, /On resume, preserve the saved phase, pending input, and approval gate/);
});
