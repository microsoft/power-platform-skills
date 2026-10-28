const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildModel,
  renderStatusPage,
} = require('../../skills/create-site/scripts/render-non-spa-status');

const SITE_URL = 'https://contoso-events.powerappsportals.com/';
const CATALOG_SHA = '0123456789abcdef0123456789abcdef01234567';
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

function options(overrides = {}) {
  return {
    output: path.join(os.tmpdir(), 'unused-non-spa-status.html'),
    templateName: 'EventPortal',
    modelVersion: 'Enhanced',
    status: 'accepted',
    siteName: 'Contoso Events',
    subdomain: 'contoso-events',
    language: '1033',
    languageName: 'English (United States)',
    languageCode: 'en-US',
    cloud: 'Public',
    catalogOwner: 'microsoft',
    catalogRepo: 'power-pages-samples',
    catalogSha: CATALOG_SHA,
    ...overrides,
  };
}

function template(overrides = {}) {
  return {
    name: 'EventPortal',
    displayName: 'Event Portal',
    description: 'Event Portal description',
    capabilities: [
      'Customizable event template',
      'List of events',
      'Event details with location, agenda, speakers, and sponsors',
      'Event registration page',
    ],
    requirements: ['Customer Insights - Journeys license'],
    warning: 'Some components require pro-developer customization.',
    previews: [{
      name: 'home',
      displayName: 'Home page',
      desktop: PNG_DATA_URL,
      mobile: PNG_DATA_URL,
    }],
    catalog: {
      owner: 'microsoft',
      repo: 'power-pages-samples',
      sha: CATALOG_SHA,
    },
    ...overrides,
  };
}

function rendererDeps(templateOverrides = {}) {
  return {
    loadNonSpaTemplatePresentation: async () => template(templateOverrides),
  };
}

test('buildModel combines Event Portal metadata, embedded previews, and current status', () => {
  const model = buildModel(options(), template({
    previews: [
      { name: 'home', displayName: 'Home page', desktop: PNG_DATA_URL, mobile: PNG_DATA_URL },
      { name: 'registration', displayName: 'Registration page', desktop: PNG_DATA_URL, mobile: PNG_DATA_URL },
      { name: 'about', displayName: 'About page', desktop: PNG_DATA_URL, mobile: PNG_DATA_URL },
    ],
  }));

  assert.equal(model.template.displayName, 'Event Portal');
  assert.match(model.brandIcon, /^data:image\/png;base64,/);
  assert.equal(model.template.previews.length, 3);
  assert.match(model.template.previews[0].desktop, /^data:image\/png;base64,/);
  assert.deepEqual(model.template.requirements, ['Customer Insights - Journeys license']);
  assert.equal(model.status.key, 'accepted');
  assert.equal(model.status.step, 0);
  assert.equal(model.status.activityState, 'working');
  assert.equal(model.status.terminal, false);
  assert.equal(model.status.openWebsiteUrl, null);
  assert.equal(model.status.notification, null);
  assert.equal(model.site.modelVersion, 'Enhanced');
  assert.deepEqual(model.site.language, {
    source: 'Organization default',
    name: 'English (United States)',
    code: 'en-US',
    lcid: '1033',
  });
  assert.equal(model.template.catalog.sha, CATALOG_SHA);
  assert.equal(model.refresh, true);
});

test('buildModel tracks validation and Git baseline in the same sixth UI step', () => {
  for (const status of ['validation', 'git']) {
    const model = buildModel(options({ status }), template());
    assert.equal(model.timeline.length, 6);
    assert.equal(model.status.step, 5);
    assert.equal(model.timeline[5][0], 'Local validation');
    assert.match(model.timeline[5][1], /Git baseline/);
    assert.ok(model.timeline.every(([title]) => title !== 'Git baseline'));
    assert.equal(model.status.key, status);
    assert.equal(model.status.activityState, 'working');
    assert.equal(model.status.terminal, false);
    assert.equal(model.refresh, true);
  }
  const git = buildModel(options({ status: 'git' }), template());
  assert.match(git.status.message, /initial Git baseline/);
});

test('buildModel keeps Git pauses and failures on the sixth UI step', () => {
  for (const activityState of ['awaiting-input', 'failed', 'canceled']) {
    const model = buildModel(options({
      status: 'git',
      activityState,
      ...(activityState === 'awaiting-input'
        ? { requiredAction: 'Configure Git author information.' }
        : {
            terminalReason: 'The baseline commit was not completed.',
            nextAction: 'Configure Git and retry the baseline commit.',
          }),
    }), template());
    assert.equal(model.status.step, 5);
    assert.equal(model.timeline.length, 6);
    assert.equal(model.status.activityState, activityState);
    assert.equal(model.status.terminal, activityState !== 'awaiting-input');
    assert.equal(model.status.openWebsiteUrl, null);
  }
});

test('buildModel renders Standard completion and model-mismatch details', () => {
  const ready = buildModel(
    options({ modelVersion: 'Standard', status: 'ready', siteUrl: SITE_URL }),
    template(),
  );
  assert.match(ready.status.result.message, /Standard model verified/);
  assert.equal(ready.status.activityState, 'complete');
  assert.equal(ready.status.terminal, true);
  assert.equal(ready.status.openWebsiteUrl, SITE_URL);
  assert.equal(ready.timeline.length, 6);
  assert.equal(ready.status.step, ready.timeline.length);
  assert.match(ready.status.result.message, /Git baseline created/);
  assert.equal(ready.refresh, false);

  const mismatch = buildModel(
    options({
      modelVersion: 'Standard',
      actualModelVersion: 'Enhanced',
      status: 'model-mismatch',
    }),
    template(),
  );
  assert.match(mismatch.status.message, /Enhanced instead of Standard/);
  assert.equal(mismatch.status.activityState, 'failed');
  assert.equal(mismatch.status.terminal, true);
  assert.equal(mismatch.status.openWebsiteUrl, null);
  assert.equal(mismatch.refresh, false);
});

test('buildModel represents user-input pauses without implying active processing', () => {
  const model = buildModel(
    options({
      status: 'registration',
      activityState: 'awaiting-input',
      requiredAction: 'Confirm the website record selected from PAC.',
      responseLocation: 'Return to the site creation conversation and provide your response.',
    }),
    template(),
  );

  assert.equal(model.status.step, 2);
  assert.equal(model.status.activityState, 'awaiting-input');
  assert.equal(model.status.terminal, false);
  assert.equal(model.status.chip, 'Input needed');
  assert.deepEqual(model.status.notification, {
    title: 'Your input is needed',
    requiredAction: 'Confirm the website record selected from PAC.',
    responseLocation: 'Return to the site creation conversation and provide your response.',
  });
  assert.equal(model.refresh, true);
});

test('buildModel renders failed and canceled phases as terminal non-working states', () => {
  const failed = buildModel(
    options({
      status: 'download',
      activityState: 'failed',
      terminalReason: 'PAC could not download the created site.',
      nextAction: 'Repair PAC authentication, then retry the download for this site.',
    }),
    template(),
  );
  assert.equal(failed.status.activityState, 'failed');
  assert.equal(failed.status.chip, 'Creation stopped');
  assert.equal(failed.status.terminal, true);
  assert.equal(failed.status.openWebsiteUrl, null);
  assert.deepEqual(failed.status.result, {
    title: 'Creation stopped',
    message: 'PAC could not download the created site.',
    nextAction: 'Repair PAC authentication, then retry the download for this site.',
  });
  assert.match(failed.status.footer, /before a usable local baseline/);
  assert.equal(failed.refresh, false);

  const canceled = buildModel(
    options({
      status: 'validation',
      activityState: 'canceled',
      terminalReason: 'Creation was canceled before validation completed.',
      nextAction: 'Resume validation later or keep the files already downloaded.',
    }),
    template(),
  );
  assert.equal(canceled.status.activityState, 'canceled');
  assert.equal(canceled.status.chip, 'Canceled');
  assert.equal(canceled.status.terminal, true);
  assert.equal(canceled.status.openWebsiteUrl, null);
  assert.equal(canceled.status.result.title, 'Creation canceled');
  assert.match(canceled.status.footer, /already created are preserved/);
  assert.equal(canceled.refresh, false);
});

test('buildModel retains the completed website link while awaiting customization input', () => {
  const ready = buildModel(
    options({
      status: 'ready',
      siteUrl: SITE_URL,
      activityState: 'awaiting-input',
      requiredAction: 'Choose whether to customize the downloaded template.',
    }),
    template(),
  );

  assert.equal(ready.status.activityState, 'awaiting-input');
  assert.equal(ready.status.openWebsiteUrl, SITE_URL);
  assert.equal(ready.status.terminal, false);
  assert.equal(ready.refresh, true);
});

test('buildModel embeds Starter Layout previews and capabilities', () => {
  for (const [name, displayName] of [
    ['StarterLayout1', 'Starter Layout 1'],
    ['StarterLayout2', 'Starter Layout 2'],
    ['StarterLayout3', 'Starter Layout 3'],
    ['StarterLayout4', 'Starter Layout 4'],
    ['StarterLayout5', 'Starter Layout 5'],
  ]) {
    const model = buildModel(
      options({ templateName: name }),
      template({
        name,
        displayName,
        capabilities: ['Home page', 'Subpages', 'Contact us', 'Search results'],
        previews: [
          { name: 'home', displayName: 'Home page', desktop: PNG_DATA_URL, mobile: PNG_DATA_URL },
          { name: 'subpage-1', displayName: 'Sub page 1', desktop: PNG_DATA_URL, mobile: PNG_DATA_URL },
          { name: 'subpage-2', displayName: 'Sub page 2', desktop: PNG_DATA_URL, mobile: PNG_DATA_URL },
        ],
      }),
    );

    assert.equal(model.template.displayName, displayName);
    assert.equal(model.template.previews.length, 3);
    assert.deepEqual(
      model.template.capabilities,
      ['Home page', 'Subpages', 'Contact us', 'Search results'],
    );
    for (const preview of model.template.previews) {
      assert.match(preview.desktop, /^data:image\/png;base64,/);
      assert.match(preview.mobile, /^data:image\/png;base64,/);
    }
  }
});

test('buildModel embeds the Blank page desktop and mobile previews', () => {
  const model = buildModel(
    options({ templateName: 'BlankPage', modelVersion: 'Standard' }),
    template({
      name: 'BlankPage',
      displayName: 'Blank page',
      capabilities: ['Home page'],
    }),
  );

  assert.equal(model.template.displayName, 'Blank page');
  assert.deepEqual(model.template.capabilities, ['Home page']);
  assert.equal(model.template.previews.length, 1);
  assert.match(model.template.previews[0].desktop, /^data:image\/png;base64,/);
  assert.match(model.template.previews[0].mobile, /^data:image\/png;base64,/);
});

test('buildModel uses the selected cloud for the provisional site URL', () => {
  const domains = {
    Public: 'powerappsportals.com',
    UsGov: 'powerappsportals.us',
    UsGovHigh: 'high.powerappsportals.us',
    UsGovDod: 'appsplatform.us',
    China: 'powerappsportals.cn',
  };

  for (const [cloud, domain] of Object.entries(domains)) {
    const model = buildModel(options({ cloud }), template());
    assert.equal(model.site.url, `https://contoso-events.${domain}`);
  }
});

test('renderStatusPage creates a standalone page and overwrites it as status advances', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-non-spa-status-'));
  const output = path.join(tempDir, 'status.html');

  try {
    const first = await renderStatusPage(options({ output }), rendererDeps());
    const acceptedHtml = fs.readFileSync(output, 'utf8');
    assert.equal(first.creationStatus, 'accepted');
    assert.match(first.url, /^file:/);
    assert.match(acceptedHtml, /Event Portal/);
    assert.match(acceptedHtml, /Customer Insights - Journeys license/);
    assert.match(acceptedHtml, /data:image\/png;base64,/);
    assert.match(acceptedHtml, /id="brandIcon"/);
    assert.match(acceptedHtml, /"modelVersion":"Enhanced"/);
    assert.match(acceptedHtml, new RegExp(CATALOG_SHA));
    assert.match(acceptedHtml, /working-indicator/);
    assert.match(acceptedHtml, /id="inputNotice"/);
    assert.match(acceptedHtml, /role="note" aria-label="Preview experience"/);
    const policy = acceptedHtml.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1]
      .replace(/&#39;/g, "'");
    assert.match(policy, /img-src data:/);
    assert.doesNotMatch(policy, /'self'|https?:/);
    assert.match(
      acceptedHtml,
      /This non-SPA site creation and customization experience is in preview/,
    );
    assert.match(
      acceptedHtml,
      /id="openWebsite"[^>]*target="_blank" rel="noopener noreferrer"/,
    );
    assert.match(acceptedHtml, /prefers-reduced-motion: reduce/);
    assert.match(acceptedHtml, /aria-pressed="true">Desktop/);
    assert.match(acceptedHtml, /role="tabpanel"/);
    assert.match(acceptedHtml, /ArrowRight/);
    assert.match(acceptedHtml, /Pause auto-refresh/);
    assert.match(acceptedHtml, /English \(United States\)/);
    assert.match(acceptedHtml, /Organization default/);
    assert.match(acceptedHtml, />AI-generated content may be incorrect</);
    assert.doesNotMatch(acceptedHtml, /id="statusKicker"/);
    assert.doesNotMatch(acceptedHtml, /__JSON_MODEL__/);

    await renderStatusPage(
      options({ output, status: 'ready', siteUrl: SITE_URL }),
      rendererDeps(),
    );
    const readyHtml = fs.readFileSync(output, 'utf8');
    assert.match(readyHtml, /"key":"ready"/);
    assert.match(readyHtml, /"openWebsiteUrl":"https:\/\/contoso-events\.powerappsportals\.com\/"/);
    assert.notEqual(readyHtml, acceptedHtml);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('renderStatusPage clears the input notification when processing resumes', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-non-spa-status-resume-'));
  const output = path.join(tempDir, 'status.html');

  try {
    await renderStatusPage(
      options({
        output,
        status: 'registration',
        activityState: 'awaiting-input',
        requiredAction: 'Confirm the website record.',
      }),
      rendererDeps(),
    );
    const waitingHtml = fs.readFileSync(output, 'utf8');
    assert.match(waitingHtml, /"activityState":"awaiting-input"/);
    assert.match(waitingHtml, /Confirm the website record\./);

    await renderStatusPage(options({ output, status: 'registration' }), rendererDeps());
    const resumedHtml = fs.readFileSync(output, 'utf8');
    assert.match(resumedHtml, /"activityState":"working"/);
    assert.match(resumedHtml, /"notification":null/);
    assert.doesNotMatch(resumedHtml, /Confirm the website record\./);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('renderStatusPage uses a stable temporary path when output is omitted', async () => {
  const result = await renderStatusPage(
    options({ output: undefined, subdomain: 'contoso-event-status-test' }),
    rendererDeps(),
  );

  try {
    assert.match(
      result.output,
      /power-platform-skills[\\/]create-site[\\/]contoso-event-status-test[\\/]status\.html$/,
    );
    assert.ok(fs.existsSync(result.output));
  } finally {
    fs.rmSync(path.dirname(result.output), { recursive: true, force: true });
  }
});

test('renderStatusPage requires and preserves the selected catalog identity', async () => {
  let loadedOptions;
  const deps = {
    loadNonSpaTemplatePresentation: async (value) => {
      loadedOptions = value;
      return template();
    },
  };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-declarative-catalog-'));

  try {
    await renderStatusPage(options({ output: path.join(tempDir, 'status.html') }), deps);
    assert.deepEqual(
      {
        owner: loadedOptions.owner,
        repo: loadedOptions.repo,
        sha: loadedOptions.sha,
        templateName: loadedOptions.templateName,
      },
      {
        owner: 'microsoft',
        repo: 'power-pages-samples',
        sha: CATALOG_SHA,
        templateName: 'EventPortal',
      },
    );
    await assert.rejects(
      renderStatusPage(options({
        output: path.join(tempDir, 'missing-sha.html'),
        catalogSha: '',
      }), deps),
      /--catalogSha/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('buildModel rejects unknown templates and statuses', () => {
  assert.throws(
    () => buildModel(options({ templateName: 'UnknownTemplate' }), template()),
    /Catalog metadata does not match --templateName/,
  );
  for (const activityState of ['failed', 'canceled']) {
    assert.throws(
      () =>
        buildModel(
          options({
            status: 'ready',
            siteUrl: SITE_URL,
            activityState,
            terminalReason: 'Optional customization did not start.',
            nextAction: 'Open the completed site.',
          }),
          template(),
        ),
      /completed site remains ready/,
    );
  }
  assert.throws(
    () => buildModel(options({ status: 'download', activityState: 'failed' }), template()),
    /--terminalReason is required/,
  );
  assert.throws(
    () =>
      buildModel(
        options({
          status: 'download',
          activityState: 'failed',
          terminalReason: 'Download failed.',
        }),
        template(),
      ),
    /--nextAction is required/,
  );
  assert.throws(
    () => buildModel(options({ cloud: 'Moon' }), template()),
    /Unsupported --cloud/,
  );
  assert.throws(
    () => buildModel(options({ language: 'English' }), template()),
    /positive integer LCID/,
  );
  assert.throws(
    () => buildModel(options({ status: 'invented' }), template()),
    /Unsupported --status/,
  );
  assert.throws(
    () => buildModel(options({ modelVersion: 'Automatic' }), template()),
    /must be Enhanced or Standard/,
  );
  assert.throws(
    () => buildModel(options({ activityState: 'paused' }), template()),
    /Unsupported --activityState/,
  );
  assert.throws(
    () => buildModel(options({ activityState: 'awaiting-input' }), template()),
    /--requiredAction is required/,
  );
  assert.throws(
    () => buildModel(options({ requiredAction: 'Choose a site.' }), template()),
    /only valid with --activityState awaiting-input/,
  );
  assert.throws(
    () =>
      buildModel(
        options({ status: 'ready', siteUrl: SITE_URL, activityState: 'working' }),
        template(),
      ),
    /cannot use --activityState working/,
  );
  assert.throws(
    () => buildModel(options({ status: 'ready' }), template()),
    /--siteUrl is required when --status is ready/,
  );
  for (const siteUrl of [
    'not-a-url',
    'http://contoso-events.powerappsportals.com',
    'https://user:secret@contoso-events.powerappsportals.com',
  ]) {
    assert.throws(
      () => buildModel(options({ status: 'ready', siteUrl }), template()),
      /--siteUrl must/,
      siteUrl,
    );
  }
});
