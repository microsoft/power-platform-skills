'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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

function runValidator(projectRoot) {
  return spawnSync(process.execPath, [VALIDATOR_PATH], {
    input: JSON.stringify({ cwd: projectRoot }),
    encoding: 'utf8',
  });
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
