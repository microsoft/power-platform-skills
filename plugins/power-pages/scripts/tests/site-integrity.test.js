'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  partitionDeferredFindings,
  validateSiteIntegrity,
} = require('../lib/site-integrity');
const {
  createTempProject,
  writeProjectFile,
} = require('./test-utils');

const CLI_PATH = path.join(__dirname, '..', 'validate-site-integrity.js');

test('defers exact recorded static bidi blockers but not unsafe or changed findings', () => {
  const recorded = [
    {
      file: 'src/Form.tsx',
      line: 10,
      rule: 'fixed-direction',
      message: 'fixed direction',
      fingerprint: 'fixed-fingerprint',
    },
    {
      file: 'src/Card.tsx',
      line: 20,
      rule: 'directional-physical-utility',
      message: 'physical utility',
      fingerprint: 'utility-fingerprint',
    },
  ];
  const result = partitionDeferredFindings([
    ...recorded,
    {
      file: 'src/theme.css',
      line: 30,
      rule: 'unicode-bidi-override',
      message: 'unsafe override',
    },
    {
      file: 'src/Card.tsx',
      line: 20,
      rule: 'directional-physical-utility',
      message: 'changed physical utility',
      fingerprint: 'changed-fingerprint',
    },
  ], recorded);

  assert.deepEqual(result.deferred, recorded);
  assert.deepEqual(
    result.blocking.map((finding) => finding.rule),
    ['unicode-bidi-override', 'directional-physical-utility']
  );
});

test('does not defer a replacement defect with the same legacy message identity', () => {
  const recorded = [{
    file: 'src/Code.tsx',
    line: 10,
    rule: 'fixed-direction',
    message: 'Fixed markup direction: dir="ltr"',
    fingerprint: 'original-element',
  }];
  const replacement = [{
    ...recorded[0],
    fingerprint: 'replacement-element',
  }];

  const result = partitionDeferredFindings(replacement, recorded);

  assert.deepEqual(result.deferred, []);
  assert.deepEqual(result.blocking, replacement);
});

test('skips declarative Power Pages projects', (t) => {
  const projectRoot = createTempProject(t);
  const result = validateSiteIntegrity(projectRoot);

  assert.equal(result.skipped, true);
  assert.deepEqual(result.errors, []);
});

test('blocks deterministic bidirectional regressions without requiring localization', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/Card.css', '.card { margin-left: 1rem; }');

  const result = validateSiteIntegrity(projectRoot);

  assert.equal(result.skipped, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /directional-physical-css/);
});

test('reports content expansion findings without blocking', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/Button.css', '.label {\n  width: 8rem;\n}');

  const result = validateSiteIntegrity(projectRoot);

  assert.deepEqual(result.errors, []);
  assert.equal(result.reviewFindings.length, 1);
  assert.equal(result.reviewFindings[0].rule, 'fixed-content-size-review');
});

test('includes localization resource failures when a manifest exists', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, '.powerpages-localization.json', '{ invalid json');

  const result = validateSiteIntegrity(projectRoot);

  assert.ok(result.errors.some((error) => /not valid JSON/.test(error)));
});

test('defers known bidi blockers while opposite-direction locales remain unavailable', (t) => {
  const projectRoot = createTempProject(t);
  const availabilityPath = 'src/i18n/localeAvailability.ts';
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'package.json', JSON.stringify({
    dependencies: {
      react: '^19.0.0',
      'react-dom': '^19.0.0',
      i18next: '^25.0.0',
      'react-i18next': '^16.0.0',
    },
  }));
  writeProjectFile(projectRoot, 'src/i18n/locales/en-US.json', '{"title":"Home"}');
  writeProjectFile(projectRoot, 'src/i18n/locales/ar-SA.json', '{"title":"الرئيسية"}');
  writeProjectFile(
    projectRoot,
    'src/i18n/index.ts',
    "import i18next from 'i18next'; i18next.init({ fallbackLng: 'en-US' });\n" +
    "import { isLocaleAvailable } from './localeAvailability';\n" +
    "export const selectorLocales = ['en-US', 'ar-SA'].filter(isLocaleAvailable);"
  );
  writeProjectFile(projectRoot, availabilityPath, `
    const unavailableLocales = new Set(['ar-SA']);
    export const isLocaleAvailable = (locale: string) => !unavailableLocales.has(locale);
  `);
  writeProjectFile(projectRoot, 'src/components/LanguageSelector.tsx', `
    import { isLocaleAvailable } from '../i18n/localeAvailability';
    export function LanguageSelector() {
      document.documentElement.lang = 'en-US';
      document.documentElement.dir = 'ltr';
      return ['en-US', 'ar-SA'].filter(isLocaleAvailable).map((locale) => locale);
    }
  `);
  writeProjectFile(projectRoot, 'src/theme.css', '.card { margin-left: 1rem; }');
  writeProjectFile(projectRoot, '.powerpages-localization.json', JSON.stringify({
    schemaVersion: 1,
    framework: 'react',
    mode: 'runtime',
    packageName: 'react-i18next',
    packageVersion: '^16.0.0',
    packageVerification: { status: 'verified', source: 'known-capability' },
    locales: ['en-US', 'ar-SA'],
    defaultLocale: 'en-US',
    translationMethod: 'agent',
    resourcePaths: {
      'en-US': 'src/i18n/locales/en-US.json',
      'ar-SA': 'src/i18n/locales/ar-SA.json',
    },
    generatedFiles: ['src/components/LanguageSelector.tsx'],
    managedFiles: ['src/i18n/index.ts', availabilityPath],
    unavailableLocales: ['ar-SA'],
    bidirectionalReadiness: {
      status: 'pending-remediation',
      findings: [{
        severity: 'error',
        file: 'src/theme.css',
        line: 1,
        rule: 'directional-physical-css',
        message: 'Use a logical CSS property, or add an adjacent validated bidi-physical exception: .card { margin-left: 1rem; }',
      }],
    },
    adoptedExistingConfiguration: false,
    lastOperation: 'extend',
    updatedAt: '2026-07-30T00:00:00.000Z',
  }));

  const result = validateSiteIntegrity(projectRoot);

  assert.deepEqual(result.errors, []);
  assert.ok(result.reviewFindings.some((finding) =>
    finding.rule === 'directional-physical-css' &&
    /Deferred while opposite-direction locales are unavailable/.test(finding.message)
  ));
});

test('pending remediation still blocks newly introduced bidi defects', (t) => {
  const projectRoot = createTempProject(t);
  const availabilityPath = 'src/i18n/localeAvailability.ts';
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'package.json', JSON.stringify({
    dependencies: {
      react: '^19.0.0',
      'react-dom': '^19.0.0',
      i18next: '^25.0.0',
      'react-i18next': '^16.0.0',
    },
  }));
  writeProjectFile(projectRoot, 'src/i18n/locales/en-US.json', '{"title":"Home"}');
  writeProjectFile(projectRoot, 'src/i18n/locales/ar-SA.json', '{"title":"الرئيسية"}');
  writeProjectFile(
    projectRoot,
    'src/i18n/index.ts',
    "import i18next from 'i18next'; i18next.init({ fallbackLng: 'en-US' });\n" +
    "import { isLocaleAvailable } from './localeAvailability';\n" +
    "export const selectorLocales = ['en-US', 'ar-SA'].filter(isLocaleAvailable);"
  );
  writeProjectFile(projectRoot, availabilityPath, `
    const unavailableLocales = new Set(['ar-SA']);
    export const isLocaleAvailable = (locale: string) => !unavailableLocales.has(locale);
  `);
  writeProjectFile(projectRoot, 'src/components/LanguageSelector.tsx', `
    import { isLocaleAvailable } from '../i18n/localeAvailability';
    export function LanguageSelector() {
      document.documentElement.lang = 'en-US';
      document.documentElement.dir = 'ltr';
      return ['en-US', 'ar-SA'].filter(isLocaleAvailable).map((locale) => locale);
    }
  `);
  writeProjectFile(
    projectRoot,
    'src/theme.css',
    '.known { margin-left: 1rem; }\n.new { padding-right: 1rem; }'
  );
  writeProjectFile(projectRoot, '.powerpages-localization.json', JSON.stringify({
    schemaVersion: 1,
    framework: 'react',
    mode: 'runtime',
    packageName: 'react-i18next',
    packageVersion: '^16.0.0',
    packageVerification: { status: 'verified', source: 'known-capability' },
    locales: ['en-US', 'ar-SA'],
    defaultLocale: 'en-US',
    translationMethod: 'agent',
    resourcePaths: {
      'en-US': 'src/i18n/locales/en-US.json',
      'ar-SA': 'src/i18n/locales/ar-SA.json',
    },
    generatedFiles: ['src/components/LanguageSelector.tsx'],
    managedFiles: ['src/i18n/index.ts', availabilityPath],
    unavailableLocales: ['ar-SA'],
    bidirectionalReadiness: {
      status: 'pending-remediation',
      findings: [{
        severity: 'error',
        file: 'src/theme.css',
        line: 1,
        rule: 'directional-physical-css',
        message: 'Use a logical CSS property, or add an adjacent validated bidi-physical exception: .known { margin-left: 1rem; }',
      }],
    },
    adoptedExistingConfiguration: false,
    lastOperation: 'extend',
    updatedAt: '2026-07-30T00:00:00.000Z',
  }));

  const result = validateSiteIntegrity(projectRoot);

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /src\/theme\.css:2/);
  assert.equal(result.reviewFindings.length, 1);
});

test('one recorded finding cannot defer a second same-line declaration', (t) => {
  const projectRoot = createTempProject(t);
  const availabilityPath = 'src/i18n/localeAvailability.ts';
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'package.json', JSON.stringify({
    dependencies: {
      react: '^19.0.0',
      'react-dom': '^19.0.0',
      i18next: '^25.0.0',
      'react-i18next': '^16.0.0',
    },
  }));
  writeProjectFile(projectRoot, 'src/i18n/locales/en-US.json', '{"title":"Home"}');
  writeProjectFile(projectRoot, 'src/i18n/locales/ar-SA.json', '{"title":"الرئيسية"}');
  writeProjectFile(
    projectRoot,
    'src/i18n/index.ts',
    "import i18next from 'i18next'; i18next.init({ fallbackLng: 'en-US' });\n" +
    "import { isLocaleAvailable } from './localeAvailability';\n" +
    "export const selectorLocales = ['en-US', 'ar-SA'].filter(isLocaleAvailable);"
  );
  writeProjectFile(projectRoot, availabilityPath, `
    const unavailableLocales = new Set(['ar-SA']);
    export const isLocaleAvailable = (locale: string) => !unavailableLocales.has(locale);
  `);
  writeProjectFile(projectRoot, 'src/components/LanguageSelector.tsx', `
    import { isLocaleAvailable } from '../i18n/localeAvailability';
    export function LanguageSelector() {
      document.documentElement.lang = 'en-US';
      document.documentElement.dir = 'ltr';
      return ['en-US', 'ar-SA'].filter(isLocaleAvailable).map((locale) => locale);
    }
  `);
  const cssLine = '.known { margin-left: 1rem; padding-right: 1rem; }';
  writeProjectFile(projectRoot, 'src/theme.css', cssLine);
  writeProjectFile(projectRoot, '.powerpages-localization.json', JSON.stringify({
    schemaVersion: 1,
    framework: 'react',
    mode: 'runtime',
    packageName: 'react-i18next',
    packageVersion: '^16.0.0',
    packageVerification: { status: 'verified', source: 'known-capability' },
    locales: ['en-US', 'ar-SA'],
    defaultLocale: 'en-US',
    translationMethod: 'agent',
    resourcePaths: {
      'en-US': 'src/i18n/locales/en-US.json',
      'ar-SA': 'src/i18n/locales/ar-SA.json',
    },
    generatedFiles: ['src/components/LanguageSelector.tsx'],
    managedFiles: ['src/i18n/index.ts', availabilityPath],
    unavailableLocales: ['ar-SA'],
    bidirectionalReadiness: {
      status: 'pending-remediation',
      findings: [{
        severity: 'error',
        file: 'src/theme.css',
        line: 1,
        rule: 'directional-physical-css',
        message: `Use a logical CSS property, or add an adjacent validated bidi-physical exception: ${cssLine}`,
      }],
    },
    adoptedExistingConfiguration: false,
    lastOperation: 'extend',
    updatedAt: '2026-07-30T00:00:00.000Z',
  }));

  const result = validateSiteIntegrity(projectRoot);

  assert.equal(result.errors.length, 1);
  assert.equal(result.reviewFindings.length, 1);
});

test('CLI exits 2 for blocking integrity errors', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/Card.css', '.card { padding-right: 1rem; }');

  const result = spawnSync(
    process.execPath,
    [CLI_PATH, '--projectRoot', projectRoot],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /site integrity validation failed/i);
});
