'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  buildVerificationCases,
  runRenderedBidirectionalAudit,
  summarizeFindings,
  validateRunSpec,
} = require('../lib/rendered-bidirectional-readiness');
const {
  beginLocalizationVerification,
  readLocalizationVerificationTransaction,
} = require('../lib/localization-verification-transaction');
const { createTempProject, writeProjectFile } = require('./test-utils');

const cliPath = path.join(__dirname, '..', 'audit-rendered-bidirectional-readiness.js');

function validSpec() {
  return {
    version: 1,
    runtimeSwitching: false,
    viewports: [
      { name: 'desktop', width: 1280, height: 720 },
      { name: 'narrow', width: 390, height: 844 },
    ],
    locales: [
      {
        id: 'en',
        locale: 'en-US',
        direction: 'ltr',
        activate: [{ type: 'use-current' }],
        expect: [{ selector: 'h1', text: 'Home' }],
      },
      {
        id: 'pseudo-rtl',
        locale: 'ar-XB',
        direction: 'rtl',
        pseudo: true,
        activate: [{ type: 'set-document', locale: 'ar-XB', direction: 'rtl' }],
      },
    ],
    components: [{
      id: 'search-form',
      name: 'Search form',
      classification: 'direction-aware',
      route: '/',
      selector: '[data-bidi-id="search-form"]',
      viewports: ['desktop', 'narrow'],
      states: [{
        name: 'empty',
        targets: [{
          selector: '[data-bidi-id="search-form"]',
          expectedDirection: 'inherit',
        }],
      }],
    }],
  };
}

function pendingRuntimeSpec() {
  const spec = validSpec();
  spec.runtimeSwitching = true;
  spec.defaultLocaleId = 'en';
  spec.locales[0].activate = [{
    type: 'click',
    selector: '[data-locale="en-US"]',
  }];
  spec.locales[1] = {
    id: 'ar',
    locale: 'ar-SA',
    direction: 'rtl',
    activate: [{
      type: 'activate-locale',
      method: 'click',
      locale: 'ar-SA',
      selector: '[data-locale="ar-SA"]',
    }],
    expect: [{ selector: 'h1', text: 'مرحبا' }],
  };
  spec.transitions = [
    { name: 'en-ar-en', route: '/', sequence: ['en', 'ar', 'en'] },
    { name: 'ar-en-ar', route: '/', sequence: ['ar', 'en', 'ar'] },
  ];
  return spec;
}

function pendingRuntimeManifest(options = {}) {
  return {
    schemaVersion: 1,
    framework: 'react',
    mode: 'runtime',
    packageName: 'react-i18next',
    packageVersion: '^16.0.0',
    packageVerification: {
      status: 'verified',
      source: 'known-capability',
    },
    locales: ['en-US', 'ar-SA'],
    defaultLocale: 'en-US',
    translationMethod: 'agent',
    resourcePaths: {
      'en-US': 'src/i18n/locales/en-US.json',
      'ar-SA': 'src/i18n/locales/ar-SA.json',
    },
    generatedFiles: [],
    managedFiles: ['src/i18n/localeCoordinator.ts'],
    unavailableLocales: options.exposed ? [] : ['ar-SA'],
    bidirectionalReadiness: {
      status: 'pending-remediation',
      localeReadiness: {
        'en-US': { status: 'ready' },
        'ar-SA': { status: 'pending-remediation' },
      },
      findings: [],
      renderedFindings: [{
        caseId: 'calendar--open--desktop--ar',
        rule: 'localized-font-failure',
        severity: 'error',
        message: 'Arabic font rendering failed.',
        selector: '.calendar',
        scope: 'locale',
        affectedLocales: ['ar-SA'],
      }],
    },
    adoptedExistingConfiguration: false,
    lastOperation: 'add',
    updatedAt: '2026-09-03T00:00:00.000Z',
  };
}

function beginPendingVerification(projectRoot) {
  const manifestPath = writeProjectFile(
    projectRoot,
    '.powerpages-localization.json',
    JSON.stringify(pendingRuntimeManifest())
  );
  const transaction = beginLocalizationVerification(projectRoot, ['ar-SA']);
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(pendingRuntimeManifest({ exposed: true }))
  );
  return transaction;
}

test('validates a complete LTR and RTL rendered verification specification', () => {
  assert.deepEqual(validateRunSpec(validSpec()), []);
});

test('requires complete component, viewport, direction, and runtime round-trip coverage', () => {
  const spec = validSpec();
  spec.locales.pop();
  spec.components[0].viewports.push('tablet');
  spec.components.push({
    id: 'vendor-calendar',
    name: 'Vendor calendar',
    classification: 'unknown-third-party',
    route: '/calendar',
    selector: '.calendar',
    viewports: ['desktop'],
    states: [{ name: 'open' }],
  });
  spec.runtimeSwitching = true;

  const errors = validateRunSpec(spec);

  assert.ok(errors.some((error) => /LTR and RTL/.test(error)));
  assert.ok(errors.some((error) => /unknown viewport "tablet"/.test(error)));
  assert.ok(errors.some((error) => /third-party targets/.test(error)));
  assert.ok(errors.some((error) => /valid defaultLocaleId/.test(error)));
});

test('rejects malformed nested checks instead of silently weakening coverage', () => {
  const spec = validSpec();
  const state = spec.components[0].states[0];
  spec.locales[1].activate.push({ type: 'execute-script' });
  state.setup = [{ type: 'execute-script' }];
  state.targets = [{
    selector: '.target',
    expectedDirection: 'inherit',
    allowClipping: 'false',
    externalOpaque: 'false',
  }];
  state.focusOrder = 42;
  state.computed = [{
    selector: '.target',
    property: 'text-align',
    expected: { rtl: 42 },
  }];
  spec.components[0].manualChecks = 'mirror the icon';
  spec.transitions = [{
    name: 'invalid',
    route: '/',
    sequence: ['en', 'pseudo-rtl'],
    viewport: 'tablet',
    preserve: '#field',
    preserveFocus: '',
    preserveRoute: 'true',
    setup: [{ type: 'execute-script' }],
  }];

  const errors = validateRunSpec(spec);

  assert.ok(errors.some((error) => /allowClipping must be boolean/.test(error)));
  assert.ok(errors.some((error) => /externalOpaque must be boolean/.test(error)));
  assert.ok(errors.some((error) => /focusOrder must be an array/.test(error)));
  assert.ok(errors.some((error) => /expected\.rtl must be a string/.test(error)));
  assert.ok(errors.some((error) => /manualChecks must be an array/.test(error)));
  assert.ok(errors.some((error) => /unknown viewport "tablet"/.test(error)));
  assert.ok(errors.some((error) => /preserve must be an array/.test(error)));
  assert.ok(errors.some((error) => /preserveFocus must be a non-empty/.test(error)));
  assert.ok(errors.some((error) => /preserveRoute must be boolean/.test(error)));
  assert.equal(
    errors.filter((error) => /\.type is invalid/.test(error)).length,
    3
  );
});

test('validates explicit application-state preservation entries', () => {
  const spec = validSpec();
  spec.transitions = [{
    name: 'state',
    route: '/',
    sequence: ['en', 'pseudo-rtl'],
    preserve: [
      { selector: '#panel', kind: 'attribute' },
      { selector: '#counter', kind: 'unsupported' },
    ],
  }];

  const errors = validateRunSpec(spec);

  assert.ok(errors.some((error) => /name is required for attribute/.test(error)));
  assert.ok(errors.some((error) => /kind must be auto, value, checked/.test(error)));
});

test('requires runtime round trips for every real non-default locale', () => {
  const spec = validSpec();
  spec.runtimeSwitching = true;
  spec.defaultLocaleId = 'en';
  spec.locales[1] = {
    id: 'ar',
    locale: 'ar-SA',
    direction: 'rtl',
    activate: [{ type: 'click', selector: '[data-locale="ar-SA"]' }],
    expect: [{ selector: 'h1', text: 'مرحبا' }],
  };
  spec.locales.push({
    id: 'fr',
    locale: 'fr-FR',
    direction: 'ltr',
    activate: [{ type: 'click', selector: '[data-locale="fr-FR"]' }],
    expect: [{ selector: 'h1', text: 'Accueil' }],
  });
  spec.transitions = [
    { name: 'en-ar-en', route: '/', sequence: ['en', 'ar', 'en'] },
    { name: 'ar-en-ar', route: '/', sequence: ['ar', 'en', 'ar'] },
  ];

  const errors = validateRunSpec(spec);

  assert.ok(errors.some((error) => /en -> fr -> en/.test(error)));
  assert.ok(errors.some((error) => /fr -> en -> fr/.test(error)));
  assert.ok(!errors.some((error) => /en -> ar -> en/.test(error)));
});

test('reconciles runtime verification locales with the localization manifest', () => {
  const spec = validSpec();
  spec.runtimeSwitching = true;
  spec.defaultLocaleId = 'en';
  spec.locales[0].activate = [{
    type: 'click',
    selector: '[data-locale="en-US"]',
  }];
  spec.locales[1] = {
    id: 'ar',
    locale: 'ar-SA',
    direction: 'rtl',
    activate: [{ type: 'click', selector: '[data-locale="ar-SA"]' }],
    expect: [{ selector: 'h1', text: 'مرحبا' }],
  };
  spec.transitions = [
    { name: 'en-ar-en', route: '/', sequence: ['en', 'ar', 'en'] },
    { name: 'ar-en-ar', route: '/', sequence: ['ar', 'en', 'ar'] },
  ];

  const missingLocaleErrors = validateRunSpec(spec, {
    locales: ['en-US', 'he-IL', 'ar-SA'],
    defaultLocale: 'en-US',
    mode: 'runtime',
  });
  assert.ok(missingLocaleErrors.some((error) =>
    /real locales must exactly match/i.test(error)
  ));

  const wrongDefaultErrors = validateRunSpec(spec, {
    locales: ['en-US', 'ar-SA'],
    defaultLocale: 'ar-SA',
    mode: 'runtime',
  });
  assert.ok(wrongDefaultErrors.some((error) =>
    /defaultLocaleId must match/i.test(error)
  ));

  spec.locales[1].direction = 'ltr';
  const directionErrors = validateRunSpec(spec, {
    locales: ['en-US', 'ar-SA'],
    defaultLocale: 'en-US',
    mode: 'runtime',
  });
  assert.ok(directionErrors.some((error) =>
    /direction must be rtl for ar-SA/i.test(error)
  ));

  spec.locales[1].direction = 'rtl';
  const unavailableErrors = validateRunSpec(spec, {
    locales: ['en-US', 'ar-SA'],
    defaultLocale: 'en-US',
    mode: 'runtime',
    unavailableLocales: ['ar-SA'],
  });
  assert.ok(unavailableErrors.some((error) =>
    /currently available localization manifest locales/i.test(error)
  ));
  assert.ok(unavailableErrors.some((error) =>
    /unavailableLocaleChecks must exactly match/i.test(error)
  ));

  const unavailableSpec = validSpec();
  unavailableSpec.runtimeSwitching = true;
  unavailableSpec.defaultLocaleId = 'en';
  unavailableSpec.locales[0].activate = [{
    type: 'click',
    selector: '[data-locale="en-US"]',
  }];
  unavailableSpec.unavailableLocaleChecks = [{
    locale: 'ar-SA',
    selectors: ['[data-locale="ar-SA"]'],
  }];
  assert.deepEqual(validateRunSpec(unavailableSpec, {
    locales: ['en-US', 'ar-SA'],
    defaultLocale: 'en-US',
    mode: 'runtime',
    unavailableLocales: ['ar-SA'],
  }), []);
});

test('requires transaction targets to use one locale-bound application control', () => {
  const spec = pendingRuntimeSpec();
  spec.locales[1].activate = [
    {
      type: 'set-attribute',
      selector: 'html',
      name: 'lang',
      value: 'ar-SA',
    },
  ];

  const errors = validateRunSpec(spec, {
    locales: ['en-US', 'ar-SA'],
    defaultLocale: 'en-US',
    mode: 'runtime',
    unavailableLocales: [],
    verificationLocales: ['ar-SA'],
  });

  assert.ok(errors.some((error) => /exactly one activate-locale action/i.test(error)));
  assert.ok(errors.some((error) => /only activate-locale and wait actions/i.test(error)));
});

test('does not allow a runtime manifest to disable runtime transition checks', () => {
  const errors = validateRunSpec(validSpec(), {
    locales: ['en-US'],
    defaultLocale: 'en-US',
    mode: 'runtime',
    unavailableLocales: [],
  });

  assert.ok(errors.some((error) =>
    /runtime localization manifests require runtimeSwitching: true/i.test(error)
  ));
});

test('expands every applicable state, viewport, and locale into a separate case', () => {
  const spec = validSpec();
  spec.components[0].states.push({ name: 'focused' });

  const cases = buildVerificationCases(spec);

  assert.equal(cases.length, 8);
  assert.deepEqual(
    new Set(cases.map((item) => item.state.name)),
    new Set(['empty', 'focused'])
  );
});

test('summarizes failed, review, and passed rendered cases', () => {
  const findings = [
    { severity: 'error' },
    { severity: 'review' },
  ];
  const results = [
    { status: 'failed' },
    { status: 'review' },
    { status: 'passed' },
  ];

  assert.deepEqual(summarizeFindings(findings, results), {
    cases: 3,
    passed: 1,
    review: 1,
    failed: 1,
    errors: 1,
    reviewFindings: 1,
  });
});

test('CLI runs the complete case matrix and emits JSON through a project Playwright install', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(
    projectRoot,
    'node_modules/playwright/index.js',
    `
      class Locator {
        constructor(page, selector) { this.page = page; this.selector = selector; }
        first() { return this; }
        async count() { return 1; }
        async click() {
          if (this.selector.includes('ar-SA')) {
            this.page.locale = 'ar-SA';
            this.page.direction = 'rtl';
          }
        }
        async textContent() {
          return this.page.direction === 'rtl' ? 'مرحبا' : 'Home';
        }
        async getAttribute() { return null; }
        async evaluate() {
          return {
            visible: true,
            direction: this.page.direction,
            textAlign: 'start',
            overflowX: 'visible',
            overflowY: 'visible',
            clipped: false,
            outsideViewport: false,
            rect: { left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40 }
          };
        }
      }
      class Page {
        constructor() { this.locale = 'en-US'; this.direction = 'ltr'; }
        on() {}
        async goto() {}
        url() { return 'http://localhost:4173/'; }
        async waitForTimeout() {}
        locator(selector) { return new Locator(this, selector); }
        async evaluate(fn, arg) {
          const source = String(fn);
          if (source.includes('document.documentElement.lang =')) {
            this.locale = arg.locale;
            this.direction = arg.direction;
            return;
          }
          if (source.includes('lang: document.documentElement.lang')) {
            return { lang: this.locale, direction: this.direction };
          }
          if (source.includes('horizontalOverflow')) {
            return { horizontalOverflow: false, overflowPixels: 0 };
          }
        }
        async close() {}
      }
      class Browser {
        async newPage() { return new Page(); }
        async close() {}
      }
      module.exports = { chromium: { launch: async () => new Browser() } };
    `
  );
  const spec = validSpec();
  spec.locales[1].pseudo = false;
  spec.locales[1].locale = 'ar-SA';
  spec.locales[1].activate = [{ type: 'click', selector: '[data-locale="ar-SA"]' }];
  spec.locales[1].expect = [{ selector: 'h1', text: 'مرحبا' }];
  const outputPath = path.join(projectRoot, 'docs', 'bidi', 'report.json');
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      '--url', 'http://localhost:4173',
      '--projectRoot', projectRoot,
      '--spec-inline', JSON.stringify(spec),
      '--output', outputPath,
    ],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.cases, 4);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.errors, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), report);
});

test('CLI exits 2 for an invalid run specification', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(
    projectRoot,
    'node_modules/playwright/index.js',
    'module.exports = { chromium: { launch: async () => ({ close: async () => {} }) } };'
  );
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      '--url', 'http://localhost:4173',
      '--projectRoot', projectRoot,
      '--spec-inline', '{}',
    ],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Invalid rendered bidirectional run specification/);
});

test('CLI argument errors mark an active verification transaction failed', (t) => {
  const projectRoot = createTempProject(t);
  beginPendingVerification(projectRoot);

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      '--url', 'http://localhost:4173',
      '--projectRoot', projectRoot,
    ],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
  assert.equal(
    readLocalizationVerificationTransaction(projectRoot).transaction.state,
    'remediation-required'
  );
});

test('CLI rejects unknown arguments and marks an active transaction failed', (t) => {
  const projectRoot = createTempProject(t);
  beginPendingVerification(projectRoot);

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      '--url', 'http://localhost:4173',
      '--projectRoot', projectRoot,
      '--spec-inline', JSON.stringify(pendingRuntimeSpec()),
      '--ouptut', path.join(projectRoot, 'report.json'),
    ],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown or misplaced argument "--ouptut"/);
  assert.equal(
    readLocalizationVerificationTransaction(projectRoot).transaction.state,
    'remediation-required'
  );
});

test('CLI requires the localization manifest for runtime switching', (t) => {
  const projectRoot = createTempProject(t);
  const spec = validSpec();
  spec.runtimeSwitching = true;
  spec.defaultLocaleId = 'en';

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      '--url', 'http://localhost:4173',
      '--projectRoot', projectRoot,
      '--spec-inline', JSON.stringify(spec),
    ],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /is required when runtimeSwitching is enabled/);
});

test('CLI marks an active verification transaction failed when browser startup fails', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(
    projectRoot,
    'node_modules/playwright/index.js',
    "const error = new Error('synthetic browser load failure');\n" +
      "error.code = 'SYNTHETIC_FAILURE';\n" +
      'throw error;\n'
  );
  beginPendingVerification(projectRoot);
  const spec = pendingRuntimeSpec();

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      '--url', 'http://localhost:4173',
      '--projectRoot', projectRoot,
      '--spec-inline', JSON.stringify(spec),
    ],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /synthetic browser load failure/);
  assert.equal(
    readLocalizationVerificationTransaction(projectRoot).transaction.state,
    'remediation-required'
  );
});

test('CLI refuses non-loopback locale verification URLs', (t) => {
  const projectRoot = createTempProject(t);
  beginPendingVerification(projectRoot);

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      '--url', 'https://preview.example.test',
      '--projectRoot', projectRoot,
      '--spec-inline', JSON.stringify(pendingRuntimeSpec()),
    ],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /must use a loopback development URL/i);
  assert.equal(
    readLocalizationVerificationTransaction(projectRoot).transaction.state,
    'remediation-required'
  );
});

test('CLI marks verification failed when report output cannot be written', (t) => {
  const projectRoot = createTempProject(t);
  beginPendingVerification(projectRoot);
  writeProjectFile(
    projectRoot,
    'node_modules/playwright/index.js',
    `
      class Locator {
        constructor(page, selector) { this.page = page; this.selector = selector; }
        first() { return this; }
        async count() { return 1; }
        async click() {
          const isArabic = this.selector.includes('ar-SA');
          this.page.locale = isArabic ? 'ar-SA' : 'en-US';
          this.page.direction = isArabic ? 'rtl' : 'ltr';
        }
        async textContent() { return this.page.direction === 'rtl' ? 'مرحبا' : 'Home'; }
        async getAttribute() { return null; }
        async evaluate() {
          return {
            exists: true, visible: true, direction: this.page.direction,
            textAlign: 'start', overflowX: 'visible', overflowY: 'visible',
            clipped: false, outsideViewport: false,
            rect: { left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40 }
          };
        }
      }
      class Page {
        constructor() { this.locale = 'en-US'; this.direction = 'ltr'; }
        on() {}
        async goto() {}
        url() { return 'http://localhost:4173/'; }
        async waitForTimeout() {}
        locator(selector) { return new Locator(this, selector); }
        async evaluate(fn) {
          const source = String(fn);
          if (source.includes('lang: document.documentElement.lang')) {
            return { lang: this.locale, direction: this.direction };
          }
          if (source.includes('horizontalOverflow')) {
            return { horizontalOverflow: false, overflowPixels: 0 };
          }
          if (source.includes('timeOrigin: performance.timeOrigin')) {
            return { route: '/', timeOrigin: 1 };
          }
        }
        async close() {}
      }
      module.exports = {
        chromium: {
          launch: async () => ({
            newPage: async () => new Page(),
            close: async () => {}
          })
        }
      };
    `
  );
  const outputDirectory = path.join(projectRoot, 'report-target');
  fs.mkdirSync(outputDirectory);

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      '--url', 'http://localhost:4173',
      '--projectRoot', projectRoot,
      '--spec-inline', JSON.stringify(pendingRuntimeSpec()),
      '--output', outputDirectory,
    ],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 2);
  assert.equal(
    readLocalizationVerificationTransaction(projectRoot).transaction.state,
    'remediation-required'
  );
});

test('CLI verifies an in-progress locale through its normal selector', (t) => {
  const projectRoot = createTempProject(t);
  beginPendingVerification(projectRoot);
  writeProjectFile(
    projectRoot,
    'node_modules/playwright/index.js',
    `
      class Locator {
        constructor(page, selector) { this.page = page; this.selector = selector; }
        first() { return this; }
        nth() { return this; }
        async count() { return 1; }
        async isVisible() { return true; }
        async click() {
          const isArabic = this.selector.includes('ar-SA');
          this.page.locale = isArabic ? 'ar-SA' : 'en-US';
          this.page.direction = isArabic ? 'rtl' : 'ltr';
        }
        async textContent() {
          return this.page.direction === 'rtl' ? 'مرحبا' : 'Home';
        }
        async getAttribute() { return null; }
        async evaluate() {
          return {
            exists: true,
            visible: true,
            direction: this.page.direction,
            textAlign: 'start',
            overflowX: 'visible',
            overflowY: 'visible',
            clipped: false,
            outsideViewport: false,
            rect: {
              left: 0,
              top: 0,
              right: 100,
              bottom: 40,
              width: 100,
              height: 40
            }
          };
        }
      }
      class Page {
        constructor() {
          this.locale = 'en-US';
          this.direction = 'ltr';
        }
        on() {}
        async goto() {}
        url() { return 'http://localhost:4173/'; }
        async waitForTimeout() {}
        locator(selector) { return new Locator(this, selector); }
        async evaluate(fn) {
          const source = String(fn);
          if (source.includes('lang: document.documentElement.lang')) {
            return { lang: this.locale, direction: this.direction };
          }
          if (source.includes('horizontalOverflow')) {
            return { horizontalOverflow: false, overflowPixels: 0 };
          }
          if (source.includes('timeOrigin: performance.timeOrigin')) {
            return { route: '/', timeOrigin: 1 };
          }
        }
        async close() {}
      }
      class Browser {
        async newPage() { return new Page(); }
        async close() {}
      }
      module.exports = { chromium: { launch: async () => new Browser() } };
    `
  );

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      '--url', 'http://localhost:4173',
      '--projectRoot', projectRoot,
      '--spec-inline', JSON.stringify(pendingRuntimeSpec()),
    ],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(JSON.parse(result.stdout).summary.errors, 0);
  assert.equal(
    readLocalizationVerificationTransaction(projectRoot).transaction.state,
    'verified'
  );
});

test('transaction verification fails if a locale control leaves loopback', async () => {
  const spec = pendingRuntimeSpec();
  spec.locales[1].activate.push({ type: 'wait', ms: 50 });

  class Locator {
    constructor(page, selector) {
      this.page = page;
      this.selector = selector;
    }
    first() { return this; }
    async count() { return 1; }
    async textContent() {
      return this.page.direction === 'rtl' ? 'مرحبا' : 'Home';
    }
    async getAttribute() { return null; }
    async evaluate() {
      return {
        exists: true,
        visible: true,
        direction: this.page.direction,
        textAlign: 'start',
        overflowX: 'visible',
        overflowY: 'visible',
        clipped: false,
        outsideViewport: false,
        rect: {
          left: 0,
          top: 0,
          right: 100,
          bottom: 40,
          width: 100,
          height: 40,
        },
      };
    }
    async click() {
      const isArabic = this.selector.includes('ar-SA');
      this.page.locale = isArabic ? 'ar-SA' : 'en-US';
      this.page.direction = isArabic ? 'rtl' : 'ltr';
      if (isArabic) this.page.pendingRedirect = true;
    }
  }
  class Page {
    constructor() {
      this.locale = 'en-US';
      this.direction = 'ltr';
      this.currentUrl = 'http://localhost:4173/';
    }
    on() {}
    async goto() { this.currentUrl = 'http://localhost:4173/'; }
    url() { return this.currentUrl; }
    async waitForTimeout() {
      if (this.pendingRedirect) {
        this.currentUrl = 'https://preview.example.test/ar-SA';
        this.pendingRedirect = false;
      }
    }
    locator(selector) { return new Locator(this, selector); }
    async evaluate(fn) {
      const source = String(fn);
      if (source.includes('lang: document.documentElement.lang')) {
        return { lang: this.locale, direction: this.direction };
      }
      if (source.includes('horizontalOverflow')) {
        return { horizontalOverflow: false, overflowPixels: 0 };
      }
      if (source.includes('timeOrigin: performance.timeOrigin')) {
        return { route: '/', timeOrigin: 1 };
      }
    }
    async close() {}
  }

  const report = await runRenderedBidirectionalAudit({
    url: 'http://localhost:4173',
    spec,
    localizationContext: {
      locales: ['en-US', 'ar-SA'],
      defaultLocale: 'en-US',
      mode: 'runtime',
      unavailableLocales: [],
      verificationLocales: ['ar-SA'],
    },
    chromium: {
      launch: async () => ({
        newPage: async () => new Page(),
        close: async () => {},
      }),
    },
  });

  assert.ok(report.findings.some(
    (finding) => finding.rule === 'rendered-case-failure' &&
      /left the required loopback origin/.test(finding.message)
  ));
});

test('accepts an intentionally absent restricted target', async () => {
  const spec = validSpec();
  spec.components[0].states[0].targets = [{
    selector: '#restricted-vendor-surface',
    expectVisible: false,
    externalOpaque: true,
  }];

  class Locator {
    constructor(page, selector) {
      this.page = page;
      this.selector = selector;
    }
    first() { return this; }
    async count() { return this.selector === '#restricted-vendor-surface' ? 0 : 1; }
    async textContent() { return 'Home'; }
    async getAttribute() { return null; }
  }
  class Page {
    constructor() {
      this.keyboard = { press: async () => {} };
      this.locale = 'en-US';
      this.direction = 'ltr';
    }
    on() {}
    async goto() {}
    async waitForTimeout() {}
    locator(selector) { return new Locator(this, selector); }
    async evaluate(fn, arg) {
      const source = String(fn);
      if (source.includes('document.documentElement.lang =')) {
        this.locale = arg.locale;
        this.direction = arg.direction;
      } else if (source.includes('lang: document.documentElement.lang')) {
        return { lang: this.locale, direction: this.direction };
      } else if (source.includes('horizontalOverflow')) {
        return { horizontalOverflow: false, overflowPixels: 0 };
      }
    }
    async close() {}
  }

  const report = await runRenderedBidirectionalAudit({
    url: 'http://localhost:4173',
    spec,
    chromium: {
      launch: async () => ({
        newPage: async () => new Page(),
        close: async () => {},
      }),
    },
  });

  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.errors, 0);
});

test('checks every selector match for locales excluded from rendered activation', async () => {
  const spec = validSpec();
  spec.runtimeSwitching = true;
  spec.defaultLocaleId = 'en';
  spec.locales[0].activate = [{
    type: 'click',
    selector: '[data-locale="en-US"]',
  }];
  spec.unavailableLocaleChecks = [{
    locale: 'ar-SA',
    selectors: ['[data-locale="ar-SA"]'],
  }];

  class Locator {
    constructor(page, selector, index = 0) {
      this.page = page;
      this.selector = selector;
      this.index = index;
    }
    first() { return this.nth(0); }
    nth(index) { return new Locator(this.page, this.selector, index); }
    async count() {
      return this.selector.includes('ar-SA') ? 2 : 1;
    }
    async isVisible() {
      return false;
    }
    async click() { this.page.exposed = true; }
    async textContent() { return 'Home'; }
    async getAttribute() { return null; }
    async evaluate(fn) {
      const source = String(fn);
      if (this.selector.includes('ar-SA') &&
          source.includes('tagName.toLowerCase')) {
        return 'option';
      }
      if (this.selector.includes('ar-SA') &&
          source.includes("closest('select')")) {
        return this.index === 1 && this.page.exposed;
      }
      return {
        exists: true,
        visible: true,
        direction: 'ltr',
        textAlign: 'start',
        overflowX: 'visible',
        overflowY: 'visible',
        clipped: false,
        outsideViewport: false,
        rect: {
          left: 0,
          top: 0,
          right: 100,
          bottom: 40,
          width: 100,
          height: 40,
        },
      };
    }
  }
  class Page {
    constructor() {
      this.keyboard = { press: async () => {} };
      this.exposed = false;
    }
    on() {}
    async goto() {}
    async waitForTimeout() {}
    locator(selector) { return new Locator(this, selector); }
    async evaluate(fn) {
      const source = String(fn);
      if (source.includes('lang: document.documentElement.lang')) {
        return { lang: 'en-US', direction: 'ltr' };
      }
      if (source.includes('horizontalOverflow')) {
        return { horizontalOverflow: false, overflowPixels: 0 };
      }
      if (source.includes('timeOrigin: performance.timeOrigin')) {
        return { route: '/', timeOrigin: 1 };
      }
    }
    async close() {}
  }

  const report = await runRenderedBidirectionalAudit({
    url: 'http://localhost:4173',
    spec,
    localizationContext: {
      locales: ['en-US', 'ar-SA'],
      defaultLocale: 'en-US',
      mode: 'runtime',
      unavailableLocales: ['ar-SA'],
    },
    chromium: {
      launch: async () => ({
        newPage: async () => new Page(),
        close: async () => {},
      }),
    },
  });

  assert.ok(report.findings.some(
    (finding) => finding.rule === 'unavailable-locale-exposed'
  ));
});

test('runtime transitions fail when preservation selectors do not exist', async () => {
  const spec = validSpec();
  spec.runtimeSwitching = true;
  spec.defaultLocaleId = 'en';
  spec.locales[0].activate = [{ type: 'click', selector: '[data-locale="en-US"]' }];
  spec.locales[1].pseudo = false;
  spec.locales[1].locale = 'ar-SA';
  spec.locales[1].activate = [{ type: 'click', selector: '[data-locale="ar-SA"]' }];
  spec.locales[1].expect = [{ selector: 'h1', text: 'مرحبا' }];
  spec.transitions = [
    {
      name: 'ltr-rtl-ltr',
      route: '/',
      sequence: ['en', 'pseudo-rtl', 'en'],
      preserve: ['#missing'],
      preserveFocus: '#missing',
    },
    {
      name: 'rtl-ltr-rtl',
      route: '/',
      sequence: ['pseudo-rtl', 'en', 'pseudo-rtl'],
      preserve: ['#missing'],
      preserveFocus: '#missing',
    },
  ];

  class Locator {
    constructor(page, selector) {
      this.page = page;
      this.selector = selector;
    }
    first() { return this; }
    async count() { return this.selector === '#missing' ? 0 : 1; }
    async click() {
      if (this.selector.includes('ar-SA')) {
        this.page.locale = 'ar-SA';
        this.page.direction = 'rtl';
      } else if (this.selector.includes('en-US')) {
        this.page.locale = 'en-US';
        this.page.direction = 'ltr';
      }
    }
    async textContent() {
      return this.page.direction === 'rtl' ? 'مرحبا' : 'Home';
    }
    async getAttribute() { return null; }
    async evaluate(fn) {
      const source = String(fn);
      if (source.includes('getComputedStyle')) {
        return {
          visible: true,
          direction: this.page.direction,
          textAlign: 'start',
          overflowX: 'visible',
          overflowY: 'visible',
          clipped: false,
          outsideViewport: false,
          rect: { left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40 },
        };
      }
      return '';
    }
  }
  class Page {
    constructor() {
      this.locale = 'en-US';
      this.direction = 'ltr';
      this.keyboard = { press: async () => {} };
    }
    on() {}
    async goto() {}
    async waitForTimeout() {}
    locator(selector) { return new Locator(this, selector); }
    async evaluate(fn, arg) {
      const source = String(fn);
      if (source.includes('document.documentElement.lang =')) {
        this.locale = arg.locale;
        this.direction = arg.direction;
        return;
      }
      if (source.includes('lang: document.documentElement.lang')) {
        return { lang: this.locale, direction: this.direction };
      }
      if (source.includes('horizontalOverflow')) {
        return { horizontalOverflow: false, overflowPixels: 0 };
      }
      if (source.includes('timeOrigin: performance.timeOrigin')) {
        return { route: '/', timeOrigin: 1 };
      }
    }
    async close() {}
  }
  const chromium = {
    launch: async () => ({
      newPage: async () => new Page(),
      close: async () => {},
    }),
  };

  const report = await runRenderedBidirectionalAudit({
    url: 'http://localhost:4173',
    spec,
    chromium,
  });

  assert.ok(report.findings.some(
    (finding) => finding.rule === 'locale-switch-preservation-target-missing'
  ));
  assert.equal(report.summary.failed, 2);
});

test('runtime transitions capture console errors and explicit application-state loss', async () => {
  const spec = validSpec();
  spec.runtimeSwitching = true;
  spec.defaultLocaleId = 'en';
  spec.locales[0].activate = [{ type: 'click', selector: '[data-locale="en-US"]' }];
  spec.locales[1].pseudo = false;
  spec.locales[1].locale = 'ar-SA';
  spec.locales[1].activate = [{
    type: 'activate-locale',
    method: 'click',
    locale: 'ar-SA',
    selector: '[data-locale="ar-SA"]',
  }];
  spec.locales[1].expect = [{ selector: 'h1', text: 'مرحبا' }];
  spec.transitions = [
    {
      name: 'ltr-rtl-ltr',
      route: '/',
      sequence: ['en', 'pseudo-rtl', 'en'],
      preserve: [
        { selector: '#panel', kind: 'attribute', name: 'aria-expanded' },
        { selector: '#panel', kind: 'checked' },
      ],
    },
    {
      name: 'rtl-ltr-rtl',
      route: '/',
      sequence: ['pseudo-rtl', 'en', 'pseudo-rtl'],
      preserve: [
        { selector: '#panel', kind: 'attribute', name: 'aria-expanded' },
        { selector: '#panel', kind: 'checked' },
      ],
    },
  ];

  class Locator {
    constructor(page, selector) {
      this.page = page;
      this.selector = selector;
    }
    first() { return this.nth(0); }
    nth(index) {
      const locator = new Locator(this.page, this.selector);
      locator.index = index;
      return locator;
    }
    async count() { return 1; }
    async isVisible() { return true; }
    async click() {
      this.page.activate(
        this.selector.includes('ar-SA') ? 'ar-SA' : 'en-US'
      );
    }
    async textContent() {
      return this.page.direction === 'rtl' ? 'مرحبا' : 'Home';
    }
    async getAttribute() { return null; }
    async evaluate(fn, arg) {
      const source = String(fn);
      if (source.includes('requested.kind')) {
        if (arg.kind === 'checked') {
          return { unsupported: true, kind: arg.kind };
        }
        return {
          unsupported: false,
          kind: arg.kind,
          value: this.page.expanded,
        };
      }
      return {
        exists: true,
        visible: true,
        direction: this.page.direction,
        textAlign: 'start',
        overflowX: 'visible',
        overflowY: 'visible',
        clipped: false,
        outsideViewport: false,
        rect: { left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40 },
      };
    }
  }
  class Page {
    constructor() {
      this.locale = 'en-US';
      this.direction = 'ltr';
      this.expanded = 'true';
      this.clicks = 0;
      this.handlers = {};
      this.keyboard = { press: async () => {} };
    }
    on(name, handler) { this.handlers[name] = handler; }
    url() { return 'http://localhost:4173/'; }
    activate(locale) {
      this.clicks += 1;
      this.locale = locale;
      this.direction = locale === 'ar-SA' ? 'rtl' : 'ltr';
      if (this.clicks === 2) {
        this.expanded = 'false';
        this.handlers.console?.({
          type: () => 'error',
          text: () => 'locale transition failed internally',
        });
      }
    }
    async goto() {}
    async waitForTimeout() {}
    locator(selector) { return new Locator(this, selector); }
    async evaluate(fn, arg) {
      const source = String(fn);
      if (source.includes('lang: document.documentElement.lang')) {
        return { lang: this.locale, direction: this.direction };
      }
      if (source.includes('horizontalOverflow')) {
        return { horizontalOverflow: false, overflowPixels: 0 };
      }
      if (source.includes('timeOrigin: performance.timeOrigin')) {
        return { route: '/', timeOrigin: 1 };
      }
    }
    async close() {}
  }

  const report = await runRenderedBidirectionalAudit({
    url: 'http://localhost:4173',
    spec,
    localizationContext: {
      locales: ['en-US', 'ar-SA'],
      defaultLocale: 'en-US',
      mode: 'runtime',
      unavailableLocales: [],
      verificationLocales: ['ar-SA'],
    },
    chromium: {
      launch: async () => ({
        newPage: async () => new Page(),
        close: async () => {},
      }),
    },
  });

  assert.ok(report.findings.some(
    (finding) => finding.rule === 'browser-console-error' &&
      finding.caseId.startsWith('transition--')
  ));
  assert.ok(report.findings.some(
    (finding) => finding.rule === 'locale-switch-lost-state'
  ));
  assert.ok(report.findings.some(
    (finding) => finding.rule === 'locale-switch-preservation-unsupported'
  ));
  assert.equal(report.summary.failed, 2);
});
