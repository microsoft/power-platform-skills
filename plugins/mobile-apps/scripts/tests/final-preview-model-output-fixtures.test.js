'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { canonicalJson, sha256Hex } = require('../lib/product-experience-contracts');
const {
  findSupportedBrowser,
  validateRenderedLayout,
} = require('../lib/final-preview-browser-layout');
const {
  buildFinalPreviewContract,
  validateHtml,
  validateStructuralQuality,
} = require('../validate-product-experience-preview');
const { runVariant } = require('./helpers/run-live-build-plan-acceptance');
const {
  flightPreview,
  gymPreview,
  repairedFlightPreview,
  repairedGymPreview,
  receivingPreview,
} = require('./fixtures/final-preview-model-outputs');

const TOKEN_FIXTURES = {
  flight: {
    colors: {
      bg: '#f4f7f6', surface: '#ffffff', primary: '#075d66', accent: '#d9efed',
      text: '#142523', textMuted: '#5d706d', border: '#cfdedb',
      statusSuccess: '#187a50', statusWarning: '#9a650d', statusDanger: '#b4232f', statusInfo: '#176b87',
    },
    typography: { family: 'Georgia', size: 24, weight: 700, lineHeight: 1.18, tracking: 0 },
  },
  gym: {
    colors: {
      bg: '#f4f6f2', surface: '#ffffff', primary: '#155f4d', accent: '#e5f3b5',
      text: '#17231f', textMuted: '#596b64', border: '#ced9d3',
      statusSuccess: '#207a4d', statusWarning: '#ad6500', statusDanger: '#bd2d27', statusInfo: '#276b78',
    },
    typography: { family: 'Avenir Next', size: 23, weight: 750, lineHeight: 1.2, tracking: 0.01 },
  },
  receiving: {
    colors: {
      bg: '#f6f6f4', surface: '#ffffff', primary: '#d30b18', accent: '#fde7e9',
      text: '#202020', textMuted: '#66645f', border: '#dedcd7',
      statusSuccess: '#2c7a45', statusWarning: '#b36a00', statusDanger: '#d30b18', statusInfo: '#476d89',
    },
    typography: { family: 'Helvetica Neue', size: 22, weight: 700, lineHeight: 1.2, tracking: 0 },
  },
};

function probeDom(errors = []) {
  const encoded = Buffer.from(JSON.stringify({ errors })).toString('base64');
  return `<html data-preview-layout-result="${encoded}"></html>`;
}

function readUrl(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ body, statusCode: response.statusCode }));
    }).once('error', reject);
  });
}

const REPAIRED_CASES = [
  {
    id: 'flight',
    definition: { id: 'repaired-flight', scenario: 'flightCommerce', mode: 'connector-only' },
    render: repairedFlightPreview,
  },
  {
    id: 'gym',
    definition: { id: 'repaired-gym', scenario: 'gymMaintenance', mode: 'mixed' },
    render: repairedGymPreview,
  },
  {
    id: 'receiving',
    definition: { id: 'repaired-receiving', scenario: 'icrcReceiving', mode: 'dataverse' },
    render: receivingPreview,
  },
];

function contractFor(run, tokenFixture) {
  const tokenContract = {
    ok: true,
    ready: true,
    source: 'supplied-model-output-fixture',
    revision: sha256Hex(canonicalJson(tokenFixture)),
    ...tokenFixture,
  };
  return buildFinalPreviewContract({
    experience: run.artifacts.bundle.experience,
    scope: run.artifacts.bundle.scope,
    journey: run.artifacts.bundle.journey,
    compiled: run.artifacts.compiled,
    scenario: run.artifacts.scenario,
    navigation: run.artifacts.navigation,
    tokenContract,
    signatureComponentsSource: `export interface ${run.domain}SignatureProps { state: 'ready' | 'busy'; }\n`,
  });
}

test('supplied flight, gym, and receiving previews satisfy semantic contracts', () => {
  const cases = [
    {
      id: 'flight',
      definition: { id: 'fixture-flight', scenario: 'flightCommerce', mode: 'connector-only', offline: false },
      render: flightPreview,
      composition: 'editorial-merchandise-runway',
      evidence: [/Cabin collection/, /Seat-aware availability/],
    },
    {
      id: 'gym',
      definition: { id: 'fixture-gym', scenario: 'gymMaintenance', mode: 'mixed', offline: false },
      render: gymPreview,
      composition: 'equipment-command-surface',
      evidence: [/Equipment identity/, /Scan to record/, /Maintenance and safety/],
    },
    {
      id: 'receiving',
      definition: { id: 'fixture-receiving', scenario: 'icrcReceiving', mode: 'dataverse', offline: true },
      render: receivingPreview,
      composition: 'dense-receiving-ledger',
      evidence: [/Receiving queue/, /Condition check/, /Evidence capture/],
    },
  ];

  const htmlById = {};
  for (const candidate of cases) {
    const run = runVariant(candidate.definition);
    const contract = contractFor(run, TOKEN_FIXTURES[candidate.id]);
    const html = candidate.render(contract);
    const validation = validateHtml(html, contract);
    assert.deepEqual(validation.errors, [], `${candidate.id}: ${JSON.stringify(validation.errors)}`);
    assert.match(html, new RegExp(`data-composition-id="${candidate.composition}"`));
    assert.deepEqual(
      contract.selectedScreenIds,
      run.storyboardScreenIds,
      `${candidate.id} changed semantic screen selection`,
    );
    assert.deepEqual(
      contract.requirements.map((requirement) => requirement.requirementId),
      run.artifacts.bundle.scope.requirements.map((requirement) => requirement.id),
      `${candidate.id} changed approved requirements`,
    );
    for (const evidence of candidate.evidence) assert.match(html, evidence);
    htmlById[candidate.id] = html;
  }

  assert.equal(new Set(Object.values(htmlById)).size, 3);
  assert.notEqual(
    htmlById.flight.match(/<main[\s\S]*<\/main>/)[0],
    htmlById.gym.match(/<main[\s\S]*<\/main>/)[0],
  );
  assert.notEqual(
    htmlById.gym.match(/<main[\s\S]*<\/main>/)[0],
    htmlById.receiving.match(/<main[\s\S]*<\/main>/)[0],
  );
});

test('captured sparse previews fail structural quality while receiving passes', () => {
  const cases = [
    {
      id: 'flight',
      definition: { id: 'fixture-flight', scenario: 'flightCommerce', mode: 'connector-only' },
      render: flightPreview,
      expected: false,
      expectedCodes: [
        'preview-mobile-frame-missing',
        'preview-review-not-collapsed',
        'preview-navigation-unstyled',
      ],
    },
    {
      id: 'gym',
      definition: { id: 'fixture-gym', scenario: 'gymMaintenance', mode: 'mixed' },
      render: gymPreview,
      expected: false,
      expectedCodes: [
        'preview-mobile-frame-missing',
        'preview-review-not-collapsed',
        'preview-navigation-unstyled',
      ],
    },
    {
      id: 'receiving',
      definition: { id: 'fixture-receiving', scenario: 'icrcReceiving', mode: 'dataverse' },
      render: receivingPreview,
      expected: true,
      expectedCodes: [],
    },
  ];

  for (const candidate of cases) {
    const run = runVariant(candidate.definition);
    const contract = contractFor(run, TOKEN_FIXTURES[candidate.id]);
    const html = candidate.render(contract);
    assert.deepEqual(validateHtml(html, contract).errors, [], `${candidate.id} semantic contract`);
    const quality = validateStructuralQuality(html, contract);
    assert.equal(quality.errors.length === 0, candidate.expected, JSON.stringify(quality.errors));
    const codes = new Set(quality.errors.map((error) => error.code));
    for (const code of candidate.expectedCodes) assert.ok(codes.has(code), `${candidate.id}: ${code}`);
  }
});

test('browser absence never blocks final preview validation', async () => {
  const result = await validateRenderedLayout(
    '<!doctype html><html><body></body></html>',
    { screens: [] },
    { browserExecutable: null },
  );
  assert.deepEqual(result, {
    status: 'skipped',
    reason: 'browser-unavailable',
    errors: [],
    viewports: [],
  });
});

test('repaired flight, gym, and receiving previews pass mandatory quality gates', () => {
  for (const candidate of REPAIRED_CASES) {
    const run = runVariant(candidate.definition);
    const contract = contractFor(run, TOKEN_FIXTURES[candidate.id]);
    const contractBeforeValidation = canonicalJson(contract);
    const html = candidate.render(contract);
    assert.deepEqual(validateHtml(html, contract).errors, [], `${candidate.id} semantic contract`);
    assert.deepEqual(validateStructuralQuality(html, contract).errors, [], `${candidate.id} structure`);
    assert.equal(
      canonicalJson(contract),
      contractBeforeValidation,
      `${candidate.id} quality validation mutated canonical builder inputs`,
    );
  }
});

test('supported browser validates all three repaired previews', async (context) => {
  if (!findSupportedBrowser()) {
    context.skip('browser executable not installed');
    return;
  }
  for (const candidate of REPAIRED_CASES) {
    const run = runVariant(candidate.definition);
    const contract = contractFor(run, TOKEN_FIXTURES[candidate.id]);
    const rendered = await validateRenderedLayout(candidate.render(contract), contract);
    if (rendered.status === 'skipped') {
      context.skip(`browser probe unavailable: ${rendered.reason}`);
      return;
    }
    assert.equal(rendered.status, 'passed', `${candidate.id}: ${JSON.stringify(rendered.errors)}`);
  }
});

test('completed browser probes surface precise optional layout findings', async () => {
  const findings = [
    {
      code: 'preview-layout-content-clipped',
      message: 'home clips vertical content with no scroll path',
    },
    {
      code: 'preview-layout-elements-overlap',
      message: 'home contains overlapping text or actions',
    },
  ];
  const result = await validateRenderedLayout('<!doctype html><html></html>', { screens: [] }, {
    browserExecutable: '/fixed/test-browser',
    viewports: [{ name: 'mobile', width: 390, height: 844 }],
    runBrowser({ executable, url, viewport }) {
      assert.equal(executable, '/fixed/test-browser');
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/preview$/);
      assert.deepEqual(viewport, { name: 'mobile', width: 390, height: 844 });
      return { status: 0, error: null, stdout: probeDom(findings) };
    },
  });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.errors, findings.map((finding) => ({
    ...finding,
    message: `mobile: ${finding.message}`,
  })));
});

test('browser launch failures are nonblocking skips', async () => {
  const result = await validateRenderedLayout('<!doctype html><html></html>', { screens: [] }, {
    browserExecutable: '/fixed/test-browser',
    viewports: [{ name: 'mobile', width: 390, height: 844 }],
    runBrowser() {
      throw new Error('simulated browser launch failure');
    },
  });
  assert.deepEqual(result, {
    status: 'skipped',
    reason: 'browser-unavailable',
    errors: [],
    viewports: [],
  });
});

test('loopback browser rendering is read-only, private, and cleaned up', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-loopback-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const previewFile = path.join(directory, '_plan_preview.html');
  const html = '<!doctype html><html><body>loopback preview marker</body></html>';
  fs.writeFileSync(previewFile, html);
  let servedUrl;
  let serverAddress;
  let closed = false;
  const result = await validateRenderedLayout(fs.readFileSync(previewFile, 'utf8'), { screens: [] }, {
    browserExecutable: '/fixed/test-browser',
    viewports: [{ name: 'mobile', width: 390, height: 844 }],
    onServerStarted(loopback) {
      servedUrl = loopback.url;
      serverAddress = loopback.address;
    },
    onServerClosed() { closed = true; },
    async runBrowser({ url }) {
      const response = await readUrl(url);
      assert.equal(response.statusCode, 200);
      assert.match(response.body, /loopback preview marker/);
      return { status: 0, error: null, stdout: probeDom() };
    },
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.viewports[0].adapter, 'local-chromium');
  assert.equal(serverAddress.address, '127.0.0.1');
  assert.ok(serverAddress.port > 0);
  assert.equal(closed, true);
  await assert.rejects(readUrl(servedUrl));
  assert.equal(fs.readFileSync(previewFile, 'utf8'), html);
});

test('browser adapter preference is agent, connected, then local Chromium', async () => {
  const calls = [];
  const result = await validateRenderedLayout('<!doctype html><html></html>', { screens: [] }, {
    agentBrowserAdapter() {
      calls.push('agent');
      return { status: 0, error: null, stdout: probeDom() };
    },
    connectedBrowserAdapter() {
      calls.push('connected');
      return { status: 0, error: null, stdout: probeDom() };
    },
    browserExecutable: '/fixed/test-browser',
    runBrowser() {
      calls.push('local');
      return { status: 0, error: null, stdout: probeDom() };
    },
    viewports: [{ name: 'mobile', width: 390, height: 844 }],
  });
  assert.equal(result.status, 'passed');
  assert.deepEqual(calls, ['agent']);
  assert.equal(result.viewports[0].adapter, 'agent-browser');
});