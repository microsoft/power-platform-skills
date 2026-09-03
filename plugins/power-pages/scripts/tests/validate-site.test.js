'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { createTempProject, writeProjectFile } = require('./test-utils');
const {
  auditBidirectionalReadiness,
} = require('../lib/bidirectional-readiness');

const VALIDATOR_PATH = path.join(
  __dirname,
  '..',
  '..',
  'skills',
  'create-site',
  'scripts',
  'validate-site.js'
);

function createProject(t, html) {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', JSON.stringify({
    $schema: 'https://www.schemastore.org/powerpages.config.json',
    compiledPath: 'dist',
    siteName: 'Contoso Customer Portal',
    defaultLandingPage: 'index.html',
  }));
  writeProjectFile(projectRoot, 'package.json', JSON.stringify({
    scripts: { build: 'vite build', dev: 'vite' },
    dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
  }));
  writeProjectFile(projectRoot, '.gitignore', 'node_modules\n');
  writeProjectFile(projectRoot, 'index.html', html);
  writeProjectFile(projectRoot, 'src/main.tsx', 'export {};');
  writeProjectFile(projectRoot, '.git/HEAD', 'ref: refs/heads/main\n');
  return projectRoot;
}

function createAngularProject(t, angularConfig, htmlPath, html) {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', JSON.stringify({
    $schema: 'https://www.schemastore.org/powerpages.config.json',
    compiledPath: 'dist/portal/browser',
    siteName: 'Contoso Customer Portal',
    defaultLandingPage: 'index.html',
  }));
  writeProjectFile(projectRoot, 'package.json', JSON.stringify({
    scripts: { build: 'ng build', dev: 'ng serve' },
    dependencies: { '@angular/core': '^20.0.0' },
  }));
  writeProjectFile(projectRoot, '.gitignore', 'node_modules\n');
  writeProjectFile(projectRoot, 'angular.json', JSON.stringify(angularConfig));
  if (htmlPath) writeProjectFile(projectRoot, htmlPath, html);
  writeProjectFile(projectRoot, 'src/main.ts', 'export {};');
  writeProjectFile(projectRoot, '.git/HEAD', 'ref: refs/heads/main\n');
  return projectRoot;
}

function runValidator(projectRoot) {
  return spawnSync(process.execPath, [VALIDATOR_PATH], {
    input: JSON.stringify({ cwd: projectRoot }),
    encoding: 'utf8',
  });
}

function runValidatorWithArgs(projectRoot, locale, direction) {
  return spawnSync(
    process.execPath,
    [
      VALIDATOR_PATH,
      '--expectedLocale',
      locale,
      '--expectedDirection',
      direction,
    ],
    {
      cwd: projectRoot,
      encoding: 'utf8',
    }
  );
}

test('create-site validator accepts a canonical non-English document language', (t) => {
  const projectRoot = createProject(
    t,
    '<html lang="es-ES" dir="ltr"><body><div id="root"></div></body></html>'
  );
  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('create-site validator blocks a direction mismatch', (t) => {
  const projectRoot = createProject(
    t,
    '<html lang="ar-SA" dir="ltr"><body><div id="root"></div></body></html>'
  );
  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /resolves to "rtl"/);
});

test('create-site validator reports the expected missing document path', (t) => {
  const projectRoot = createProject(
    t,
    '<html lang="en-US" dir="ltr"><body></body></html>'
  );
  fs.unlinkSync(path.join(projectRoot, 'index.html'));

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Root document was not found/);
  assert.match(result.stderr, /Expected: index\.html/);
});

test('create-site validator honors a custom Angular index path', (t) => {
  const projectRoot = createAngularProject(
    t,
    {
      projects: {
        portal: {
          targets: {
            build: {
              options: { index: 'src/shell.html' },
            },
          },
        },
      },
    },
    'src/shell.html',
    '<html lang="fr-FR" dir="ltr"><body></body></html>'
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('create-site validator reports ambiguous Angular index configuration', (t) => {
  const projectRoot = createAngularProject(
    t,
    {
      projects: {
        first: {
          targets: { build: { options: { index: 'src/first.html' } } },
        },
        second: {
          targets: { build: { options: { index: 'src/second.html' } } },
        },
      },
    },
    null,
    null
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Root document configuration is invalid/);
  assert.match(result.stderr, /multiple application index documents/);
});

test('create-site validator accepts approved language through direct arguments', (t) => {
  const projectRoot = createProject(
    t,
    '<html lang="es-ES" dir="ltr"><body></body></html>'
  );

  const result = runValidatorWithArgs(projectRoot, 'es-ES', 'ltr');
  assert.equal(result.status, 0, result.stderr);
});

test('create-site validator blocks direct argument language mismatches', (t) => {
  const projectRoot = createProject(
    t,
    '<html lang="en-US" dir="ltr"><body></body></html>'
  );

  const result = runValidatorWithArgs(projectRoot, 'es-ES', 'ltr');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /approved site locale is "es-ES"/);
});

test('create-site validator rejects an inconsistent direct expected direction', (t) => {
  const projectRoot = createProject(
    t,
    '<html lang="ar-SA" dir="rtl"><body></body></html>'
  );

  const result = runValidatorWithArgs(projectRoot, 'ar-SA', 'ltr');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /does not match ar-SA, which resolves to "rtl"/);
});

test('create-site validator rejects incomplete or unknown direct arguments', (t) => {
  const projectRoot = createProject(
    t,
    '<html lang="en-US" dir="ltr"><body></body></html>'
  );

  const incomplete = spawnSync(
    process.execPath,
    [VALIDATOR_PATH, '--expectedLocale', 'en-US'],
    { cwd: projectRoot, encoding: 'utf8' }
  );
  assert.equal(incomplete.status, 2);
  assert.match(incomplete.stderr, /Usage: validate-site\.js/);

  const unknown = spawnSync(
    process.execPath,
    [
      VALIDATOR_PATH,
      '--expectedLocale',
      'en-US',
      '--expectedDirection',
      'ltr',
      '--other',
      'value',
    ],
    { cwd: projectRoot, encoding: 'utf8' }
  );
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Usage: validate-site\.js/);
});

test('create-site validator blocks direction-sensitive physical CSS', (t) => {
  const projectRoot = createProject(
    t,
    '<html lang="en-US" dir="ltr"><body><div id="root"></div></body></html>'
  );
  writeProjectFile(projectRoot, 'src/theme.css', '.callout { padding-left: 1rem; }');

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Bidirectional readiness.*directional-physical-css/);
});

test('create-site validator allows an exact blocker isolated behind an unavailable locale', (t) => {
  const projectRoot = createProject(
    t,
    '<html lang="en-US" dir="ltr"><body><div id="root"></div></body></html>'
  );
  writeProjectFile(projectRoot, 'package.json', JSON.stringify({
    scripts: { build: 'vite build', dev: 'vite' },
    dependencies: {
      react: '^19.0.0',
      'react-dom': '^19.0.0',
      i18next: '^25.0.0',
      'react-i18next': '^16.0.0',
    },
  }));
  writeProjectFile(projectRoot, 'src/i18n/locales/en-US.json', '{"title":"Home"}');
  writeProjectFile(projectRoot, 'src/i18n/locales/ar-SA.json', '{"title":"الرئيسية"}');
  writeProjectFile(projectRoot, 'src/i18n/index.ts', `
    import i18next from 'i18next';
    import { isLocaleAvailable } from './localeAvailability';
    i18next.init({ fallbackLng: 'en-US' });
    export const selectorLocales = ['en-US', 'ar-SA'].filter(isLocaleAvailable);
  `);
  writeProjectFile(projectRoot, 'src/i18n/localeAvailability.ts', `
    const unavailableLocales = new Set(['ar-SA']);
    export const isLocaleAvailable = (locale: string) => !unavailableLocales.has(locale);
  `);
  writeProjectFile(projectRoot, 'src/components/LanguageSelector.tsx', `
    import { isLocaleAvailable } from '../i18n/localeAvailability';
    export function LanguageSelector() {
      const locale = 'en-US';
      document.documentElement.lang = locale;
      document.documentElement.dir = locale === 'ar-SA' ? 'rtl' : 'ltr';
      return ['en-US', 'ar-SA'].filter(isLocaleAvailable).map((item) => item);
    }
  `);
  writeProjectFile(projectRoot, 'src/theme.css', '.card { margin-left: 1rem; }');
  const recordedFinding = auditBidirectionalReadiness(projectRoot).findings.find(
    (finding) => finding.rule === 'directional-physical-css'
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
    managedFiles: [
      'src/i18n/index.ts',
      'src/i18n/localeAvailability.ts',
    ],
    unavailableLocales: ['ar-SA'],
    bidirectionalReadiness: {
      status: 'pending-remediation',
      localeReadiness: {
        'en-US': { status: 'ready' },
        'ar-SA': { status: 'pending-remediation' },
      },
      findings: [{
        ...recordedFinding,
        scope: 'locale',
        affectedLocales: ['ar-SA'],
      }],
      renderedFindings: [],
    },
    adoptedExistingConfiguration: false,
    lastOperation: 'create',
    updatedAt: '2026-09-03T12:00:00.000Z',
  }));

  const result = runValidator(projectRoot);

  assert.equal(result.status, 0, result.stderr);
});
