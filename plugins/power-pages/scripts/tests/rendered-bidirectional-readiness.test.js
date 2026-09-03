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
  assert.ok(errors.some((error) => /LTR -> RTL -> LTR/.test(error)));
  assert.ok(errors.some((error) => /RTL -> LTR -> RTL/.test(error)));
});

test('rejects malformed nested checks instead of silently weakening coverage', () => {
  const spec = validSpec();
  const state = spec.components[0].states[0];
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

test('runtime transitions fail when preservation selectors do not exist', async () => {
  const spec = validSpec();
  spec.runtimeSwitching = true;
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
    first() { return this; }
    async count() { return 1; }
    async click() {
      this.page.clicks += 1;
      if (this.selector.includes('ar-SA')) {
        this.page.locale = 'ar-SA';
        this.page.direction = 'rtl';
      } else {
        this.page.locale = 'en-US';
        this.page.direction = 'ltr';
      }
      if (this.page.clicks === 2) {
        this.page.expanded = 'false';
        this.page.handlers.console?.({
          type: () => 'error',
          text: () => 'locale transition failed internally',
        });
      }
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
    async goto() {}
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
