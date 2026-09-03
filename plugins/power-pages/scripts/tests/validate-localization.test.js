'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { createTempProject, writeProjectFile } = require('./test-utils');

const VALIDATOR_PATH = path.join(
  __dirname,
  '..',
  '..',
  'skills',
  'add-localization',
  'scripts',
  'validate-localization.js'
);
const { compareXlfResources, extractXlfMessages } = require(VALIDATOR_PATH);

function runValidator(projectRoot) {
  return spawnSync(process.execPath, [VALIDATOR_PATH], {
    input: JSON.stringify({ cwd: projectRoot }),
    encoding: 'utf8',
  });
}

function createLocalizedReactProject(t, overrides = {}) {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'package.json', JSON.stringify({
    dependencies: {
      react: '^19.0.0',
      'react-dom': '^19.0.0',
      i18next: '^25.0.0',
      'react-i18next': '^16.0.0',
    },
  }));
  writeProjectFile(projectRoot, 'src/i18n/locales/en-US.json', JSON.stringify({
    greeting: 'Hello {{name}}',
    navigation: { home: 'Home' },
  }));
  writeProjectFile(projectRoot, 'src/i18n/locales/fr-FR.json', JSON.stringify({
    greeting: 'Bonjour {{name}}',
    navigation: { home: 'Accueil' },
  }));
  writeProjectFile(
    projectRoot,
    'src/components/LanguageSelector.tsx',
    "export function LanguageSelector(){ document.documentElement.lang='en-US'; document.documentElement.dir='ltr'; return null; }"
  );
  writeProjectFile(
    projectRoot,
    'src/i18n/index.ts',
    "import i18next from 'i18next'; i18next.init({ fallbackLng: 'en-US' });"
  );
  writeProjectFile(projectRoot, '.powerpages-localization.json', JSON.stringify({
    schemaVersion: 1,
    framework: 'react',
    mode: 'runtime',
    packageName: 'react-i18next',
    packageVersion: '^16.0.0',
    packageVerification: {
      status: 'verified',
      source: 'known-capability',
    },
    locales: ['en-US', 'fr-FR'],
    defaultLocale: 'en-US',
    translationMethod: 'agent',
    resourcePaths: {
      'en-US': 'src/i18n/locales/en-US.json',
      'fr-FR': 'src/i18n/locales/fr-FR.json',
    },
    generatedFiles: ['src/components/LanguageSelector.tsx'],
    managedFiles: ['src/i18n/index.ts'],
    unavailableLocales: [],
    bidirectionalReadiness: {
      status: 'ready',
      localeReadiness: {
        'en-US': { status: 'ready' },
        'fr-FR': { status: 'ready' },
      },
      findings: [],
      renderedFindings: [],
    },
    adoptedExistingConfiguration: false,
    lastOperation: 'create',
    updatedAt: '2026-07-30T00:00:00.000Z',
    ...overrides,
  }));
  return projectRoot;
}

function createManifestlessAngularStaticProject(t) {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'package.json', JSON.stringify({
    dependencies: {
      '@angular/core': '^19.1.0',
      '@angular/compiler': '^19.1.0',
      '@angular/compiler-cli': '^19.1.0',
      '@angular/localize': '^19.1.0',
    },
  }));
  writeProjectFile(projectRoot, 'angular.json', JSON.stringify({
    projects: {
      portal: {
        i18n: { sourceLocale: 'en-US' },
      },
    },
  }));
  writeProjectFile(projectRoot, 'src/locale/messages.en-US.xlf', '<xliff></xliff>');
  writeProjectFile(projectRoot, 'src/locale/messages.fr-FR.xlf', '<xliff></xliff>');
  writeProjectFile(
    projectRoot,
    'src/app/language-selector.ts',
    "export class LanguageSelector { switchLanguage(){ document.documentElement.lang='fr-FR'; document.documentElement.dir='ltr'; } }"
  );
  return projectRoot;
}

function createManifestlessAstroStaticProject(t) {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'package.json', JSON.stringify({
    dependencies: { astro: '^6.1.0' },
  }));
  writeProjectFile(
    projectRoot,
    'astro.config.mjs',
    "export default { i18n: { defaultLocale: 'en-US', locales: ['en-US', 'ja-JP'] } };"
  );
  writeProjectFile(projectRoot, 'src/i18n/en-US.json', '{"home":"Home"}');
  writeProjectFile(projectRoot, 'src/i18n/ja-JP.json', '{"home":"Home JA"}');
  writeProjectFile(
    projectRoot,
    'src/pages/index.astro',
    "---\nconst href = getRelativeLocaleUrl('ja-JP');\n---\n<html lang=\"en-US\" dir=\"ltr\"><a href={href}>LanguageSelector</a></html>"
  );
  return projectRoot;
}

function createAngularRuntimeProjectWithStaticResidue(t) {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'package.json', JSON.stringify({
    dependencies: {
      '@angular/core': '^19.1.0',
      '@angular/compiler': '^19.1.0',
      '@angular/compiler-cli': '^19.1.0',
      '@angular/localize': '^19.1.0',
      '@jsverse/transloco': '^7.6.0',
    },
  }));
  writeProjectFile(projectRoot, 'angular.json', JSON.stringify({
    projects: {
      portal: {
        i18n: { sourceLocale: 'en-US' },
      },
    },
  }));
  writeProjectFile(projectRoot, 'src/assets/i18n/en-US.json', '{"home":"Home"}');
  writeProjectFile(projectRoot, 'src/assets/i18n/fr-FR.json', '{"home":"Accueil"}');
  writeProjectFile(
    projectRoot,
    'src/app/i18n/locale-coordinator.service.ts',
    "import '@jsverse/transloco'; provideTransloco({}); setActiveLang('fr-FR'); document.documentElement.lang='fr-FR'; const direction = locale === 'ar-SA' ? 'rtl' : 'ltr'; document.documentElement.dir=direction; export class LanguageSelector {}"
  );
  writeProjectFile(projectRoot, '.powerpages-localization.json', JSON.stringify({
    schemaVersion: 1,
    framework: 'angular',
    mode: 'runtime',
    packageName: '@jsverse/transloco',
    packageVersion: '^7.6.0',
    packageVerification: {
      status: 'verified',
      source: 'known-capability',
    },
    locales: ['en-US', 'fr-FR'],
    defaultLocale: 'en-US',
    translationMethod: 'agent',
    resourcePaths: {
      'en-US': 'src/assets/i18n/en-US.json',
      'fr-FR': 'src/assets/i18n/fr-FR.json',
    },
    generatedFiles: ['src/app/i18n/locale-coordinator.service.ts'],
    managedFiles: [],
    unavailableLocales: [],
    bidirectionalReadiness: {
      status: 'ready',
      localeReadiness: {
        'en-US': { status: 'ready' },
        'fr-FR': { status: 'ready' },
      },
      findings: [],
      renderedFindings: [],
    },
    adoptedExistingConfiguration: false,
    lastOperation: 'reconfigure',
    updatedAt: '2026-07-30T00:00:00.000Z',
  }));
  return projectRoot;
}

test('approves when no localization manifest exists', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('blocks a partial manifestless localization setup', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'package.json', JSON.stringify({
    dependencies: {
      react: '^19.0.0',
      'react-dom': '^19.0.0',
      'react-i18next': '^16.0.0',
      i18next: '^25.0.0',
    },
  }));

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /localization\.json.*missing.*setup.*incomplete/i);
  assert.match(result.stderr, /no locale resources/);
});

test('approves a complete manifestless localization setup for safe adoption', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'package.json', JSON.stringify({
    dependencies: {
      react: '^19.0.0',
      'react-dom': '^19.0.0',
      'react-i18next': '^16.0.0',
      i18next: '^25.0.0',
    },
  }));
  writeProjectFile(projectRoot, 'src/i18n/index.ts', "i18next.init({ fallbackLng: 'en-US' });");
  writeProjectFile(projectRoot, 'src/i18n/locales/en-US.json', '{"home":"Home"}');
  writeProjectFile(projectRoot, 'src/i18n/locales/fr-FR.json', '{"home":"Accueil"}');
  writeProjectFile(
    projectRoot,
    'src/components/LanguageSelector.tsx',
    "export function LanguageSelector(){ changeLanguage('fr-FR'); document.documentElement.lang='fr-FR'; document.documentElement.dir='ltr'; }"
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('blocks manifestless adoption when resource keys or protected tokens differ', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'package.json', JSON.stringify({
    dependencies: {
      react: '^19.0.0',
      'react-dom': '^19.0.0',
      'react-i18next': '^16.0.0',
      i18next: '^25.0.0',
    },
  }));
  writeProjectFile(projectRoot, 'src/i18n/index.ts', "i18next.init({ fallbackLng: 'en-US' });");
  writeProjectFile(projectRoot, 'src/i18n/locales/en-US.json', '{"home":"Hello {name}","about":"About"}');
  writeProjectFile(projectRoot, 'src/i18n/locales/fr-FR.json', '{"home":"Bonjour"}');
  writeProjectFile(
    projectRoot,
    'src/components/LanguageSelector.tsx',
    "export function LanguageSelector(){ changeLanguage('fr-FR'); document.documentElement.lang='fr-FR'; document.documentElement.dir='ltr'; }"
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /resources are not safe to adopt/);
  assert.match(result.stderr, /missing translation keys: about/);
  assert.match(result.stderr, /protected interpolation\/markup tokens/);
});

test('reports malformed manifest field types instead of throwing', (t) => {
  const projectRoot = createLocalizedReactProject(t, {
    locales: { default: 'en-US' },
    resourcePaths: [],
    generatedFiles: 'src/components/LanguageSelector.tsx',
  });

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /locales must be an array/);
  assert.match(result.stderr, /resourcePaths must be an object/);
  assert.match(result.stderr, /generatedFiles must be an array/);
  assert.doesNotMatch(result.stderr, /TypeError/);
});

test('approves a complete runtime localization setup', (t) => {
  const projectRoot = createLocalizedReactProject(t);
  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('blocks mixed-direction runtime localization without a locale coordinator', (t) => {
  const projectRoot = createLocalizedReactProject(t, {
    locales: ['en-US', 'ar-SA'],
    resourcePaths: {
      'en-US': 'src/i18n/locales/en-US.json',
      'ar-SA': 'src/i18n/locales/ar-SA.json',
    },
    bidirectionalReadiness: {
      status: 'ready',
      localeReadiness: {
        'en-US': { status: 'ready' },
        'ar-SA': { status: 'ready' },
      },
      findings: [],
      renderedFindings: [],
    },
  });
  writeProjectFile(projectRoot, 'src/i18n/locales/ar-SA.json', JSON.stringify({
    greeting: 'مرحبا {{name}}',
    navigation: { home: 'الرئيسية' },
  }));

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires one managed locale coordinator/i);
});

test('approves a mixed-direction runtime localization with a coordinator', (t) => {
  const coordinatorPath = 'src/i18n/localeCoordinator.ts';
  const projectRoot = createLocalizedReactProject(t, {
    locales: ['en-US', 'ar-SA'],
    resourcePaths: {
      'en-US': 'src/i18n/locales/en-US.json',
      'ar-SA': 'src/i18n/locales/ar-SA.json',
    },
    managedFiles: ['src/i18n/index.ts', coordinatorPath],
    bidirectionalReadiness: {
      status: 'ready',
      localeReadiness: {
        'en-US': { status: 'ready' },
        'ar-SA': { status: 'ready' },
      },
      findings: [],
      renderedFindings: [],
    },
  });
  writeProjectFile(projectRoot, 'src/i18n/locales/ar-SA.json', JSON.stringify({
    greeting: 'مرحبا {{name}}',
    navigation: { home: 'الرئيسية' },
  }));
  writeProjectFile(projectRoot, coordinatorPath, `
    import i18next from 'i18next';
    export async function switchLocale(locale: string) {
      await i18next.changeLanguage(locale);
      document.documentElement.lang = locale;
      document.documentElement.dir = locale === 'ar-SA' ? 'rtl' : 'ltr';
      localStorage.setItem('site-locale', locale);
    }
  `);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('blocks a mixed-direction coordinator with a fixed document direction', (t) => {
  const coordinatorPath = 'src/i18n/localeCoordinator.ts';
  const projectRoot = createLocalizedReactProject(t, {
    locales: ['en-US', 'ar-SA'],
    resourcePaths: {
      'en-US': 'src/i18n/locales/en-US.json',
      'ar-SA': 'src/i18n/locales/ar-SA.json',
    },
    managedFiles: ['src/i18n/index.ts', coordinatorPath],
    bidirectionalReadiness: {
      status: 'ready',
      localeReadiness: {
        'en-US': { status: 'ready' },
        'ar-SA': { status: 'ready' },
      },
      findings: [],
      renderedFindings: [],
    },
  });
  writeProjectFile(projectRoot, 'src/i18n/locales/ar-SA.json', JSON.stringify({
    greeting: 'مرحبا {{name}}',
    navigation: { home: 'الرئيسية' },
  }));
  writeProjectFile(projectRoot, coordinatorPath, `
    import i18next from 'i18next';
    export async function switchLocale(locale: string) {
      await i18next.changeLanguage(locale);
      document.documentElement.lang = locale;
      document.documentElement.dir = 'ltr';
      localStorage.setItem('site-locale', locale);
    }
  `);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /derive document direction from the selected locale/i);
});

test('enforces unavailable locales for same-direction locale sets', (t) => {
  const projectRoot = createLocalizedReactProject(t, {
    unavailableLocales: ['fr-FR'],
    bidirectionalReadiness: {
      status: 'pending-remediation',
      localeReadiness: {
        'en-US': { status: 'ready' },
        'fr-FR': { status: 'pending-remediation' },
      },
      findings: [],
      renderedFindings: [],
    },
  });

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires one managed locale availability module/i);
});

test('requires readiness metadata for same-direction localization', (t) => {
  const projectRoot = createLocalizedReactProject(t, {
    bidirectionalReadiness: undefined,
  });

  const result = runValidator(projectRoot);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /require bidirectionalReadiness metadata/i);
});

test('requires maker-approved limitation evidence to exist in the project', (t) => {
  const evidence = 'docs/bidirectional-evidence/run-1/calendar.png';
  const projectRoot = createLocalizedReactProject(t, {
    bidirectionalReadiness: {
      status: 'approved-with-limitations',
      localeReadiness: {
        'en-US': { status: 'ready' },
        'fr-FR': { status: 'approved-with-limitations' },
      },
      findings: [],
      renderedFindings: [{
        caseId: 'calendar--open--desktop--fr',
        rule: 'rendered-semantic-review',
        severity: 'review',
        message: 'The vendor-owned calendar arrow remains unchanged.',
        selector: '.calendar',
        scope: 'locale',
        affectedLocales: ['fr-FR'],
        disposition: {
          status: 'maker-approved',
          impact: 'Calendar navigation remains understandable and usable.',
          evidence,
          approvedAt: '2026-09-03T12:00:00.000Z',
        },
      }],
    },
  });

  let result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /limitation evidence does not exist/i);

  writeProjectFile(projectRoot, evidence, 'screenshot evidence');
  result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('allows a mixed-direction locale to remain unavailable pending remediation', (t) => {
  const availabilityPath = 'src/i18n/localeAvailability.ts';
  const projectRoot = createLocalizedReactProject(t, {
    locales: ['en-US', 'ar-SA'],
    resourcePaths: {
      'en-US': 'src/i18n/locales/en-US.json',
      'ar-SA': 'src/i18n/locales/ar-SA.json',
    },
    unavailableLocales: ['ar-SA'],
    managedFiles: ['src/i18n/index.ts', availabilityPath],
    bidirectionalReadiness: {
      status: 'pending-remediation',
      localeReadiness: {
        'en-US': { status: 'ready' },
        'ar-SA': { status: 'pending-remediation' },
      },
      findings: [],
      renderedFindings: [{
        caseId: 'calendar--open--desktop--ar',
        rule: 'computed-direction-mismatch',
        severity: 'error',
        message: 'Expected rtl but found ltr.',
        selector: '.calendar',
        scope: 'locale',
        affectedLocales: ['ar-SA'],
      }],
    },
  });
  writeProjectFile(projectRoot, 'src/i18n/locales/ar-SA.json', JSON.stringify({
    greeting: 'مرحبا {{name}}',
    navigation: { home: 'الرئيسية' },
  }));
  writeProjectFile(projectRoot, availabilityPath, `
    const unavailableLocales = new Set(['ar-SA']);
    export const isLocaleAvailable = (locale: string) => !unavailableLocales.has(locale);
  `);
  writeProjectFile(projectRoot, 'src/components/LanguageSelector.tsx', `
    import { isLocaleAvailable } from '../i18n/localeAvailability';
    export const LanguageSelector = () => {
      document.documentElement.lang = 'en-US';
      document.documentElement.dir = 'ltr';
      return ['en-US', 'ar-SA'].filter(isLocaleAvailable).map((locale) => locale);
    };
  `);
  fs.appendFileSync(
    path.join(projectRoot, 'src/i18n/index.ts'),
    "\nimport { isLocaleAvailable } from './localeAvailability';\n" +
    "export const selectorLocales = ['en-US', 'ar-SA'].filter(isLocaleAvailable);\n" +
    "async function activateLocaleForAudit(locale) {\n" +
    "  await i18next.changeLanguage(locale);\n" +
    "  document.documentElement.lang = locale;\n" +
    "  document.documentElement.dir = locale === 'ar-SA' ? 'rtl' : 'ltr';\n" +
    "}\n" +
    "if (import.meta.env.DEV) {\n" +
    "  window.__powerPagesLocalizationAudit = {\n" +
    "    activate: (locale) => activateLocaleForAudit(locale),\n" +
    "  };\n" +
    "}\n"
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('keeps a previously ready RTL locale available when only a new RTL locale is pending', (t) => {
  const availabilityPath = 'src/i18n/localeAvailability.ts';
  const coordinatorPath = 'src/i18n/localeCoordinator.ts';
  const projectRoot = createLocalizedReactProject(t, {
    locales: ['en-US', 'he-IL', 'ar-SA'],
    resourcePaths: {
      'en-US': 'src/i18n/locales/en-US.json',
      'he-IL': 'src/i18n/locales/he-IL.json',
      'ar-SA': 'src/i18n/locales/ar-SA.json',
    },
    unavailableLocales: ['ar-SA'],
    managedFiles: ['src/i18n/index.ts', availabilityPath, coordinatorPath],
    bidirectionalReadiness: {
      status: 'pending-remediation',
      localeReadiness: {
        'en-US': { status: 'ready' },
        'he-IL': { status: 'ready' },
        'ar-SA': { status: 'pending-remediation' },
      },
      findings: [],
      renderedFindings: [{
        caseId: 'arabic-calendar--open--desktop--ar',
        rule: 'localized-font-failure',
        severity: 'error',
        message: 'The Arabic calendar font is unreadable.',
        selector: '.calendar',
        scope: 'locale',
        affectedLocales: ['ar-SA'],
      }],
    },
  });
  writeProjectFile(projectRoot, 'src/i18n/locales/he-IL.json', JSON.stringify({
    greeting: 'שלום {{name}}',
    navigation: { home: 'בית' },
  }));
  writeProjectFile(projectRoot, 'src/i18n/locales/ar-SA.json', JSON.stringify({
    greeting: 'مرحبا {{name}}',
    navigation: { home: 'الرئيسية' },
  }));
  writeProjectFile(projectRoot, availabilityPath, `
    const unavailableLocales = new Set(['ar-SA']);
    export const isLocaleAvailable = (locale: string) => !unavailableLocales.has(locale);
  `);
  writeProjectFile(projectRoot, 'src/components/LanguageSelector.tsx', `
    import { isLocaleAvailable } from '../i18n/localeAvailability';
    export const LanguageSelector = () => {
      document.documentElement.lang = 'en-US';
      document.documentElement.dir = 'ltr';
      return ['en-US', 'he-IL', 'ar-SA'].filter(isLocaleAvailable).map((locale) => locale);
    };
  `);
  writeProjectFile(projectRoot, coordinatorPath, `
    import i18next from 'i18next';
    import { isLocaleAvailable } from './localeAvailability';
    export async function switchLocale(locale: string) {
      if (!isLocaleAvailable(locale)) return;
      await i18next.changeLanguage(locale);
      document.documentElement.lang = locale;
      document.documentElement.dir = locale === 'he-IL' ? 'rtl' : 'ltr';
      localStorage.setItem('site-locale', locale);
    }
  `);
  fs.appendFileSync(
    path.join(projectRoot, 'src/i18n/index.ts'),
    "\nimport { isLocaleAvailable } from './localeAvailability';\n" +
    "export const selectorLocales = ['en-US', 'he-IL', 'ar-SA'].filter(isLocaleAvailable);\n" +
    "async function activateLocaleForAudit(locale) {\n" +
    "  await i18next.changeLanguage(locale);\n" +
    "  document.documentElement.lang = locale;\n" +
    "  document.documentElement.dir = locale === 'en-US' ? 'ltr' : 'rtl';\n" +
    "}\n" +
    "if (import.meta.env.DEV) {\n" +
    "  window.__powerPagesLocalizationAudit = {\n" +
    "    activate: (locale) => activateLocaleForAudit(locale),\n" +
    "  };\n" +
    "}\n"
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('requires pending locale availability to be applied at activation boundaries', (t) => {
  const availabilityPath = 'src/i18n/localeAvailability.ts';
  const projectRoot = createLocalizedReactProject(t, {
    locales: ['en-US', 'ar-SA'],
    resourcePaths: {
      'en-US': 'src/i18n/locales/en-US.json',
      'ar-SA': 'src/i18n/locales/ar-SA.json',
    },
    unavailableLocales: ['ar-SA'],
    managedFiles: ['src/i18n/index.ts', availabilityPath],
    bidirectionalReadiness: {
      status: 'pending-remediation',
      localeReadiness: {
        'en-US': { status: 'ready' },
        'ar-SA': { status: 'pending-remediation' },
      },
      findings: [],
      renderedFindings: [{
        caseId: 'calendar--open--desktop--ar',
        rule: 'computed-direction-mismatch',
        severity: 'error',
        message: 'Expected rtl but found ltr.',
        selector: '.calendar',
        scope: 'locale',
        affectedLocales: ['ar-SA'],
      }],
    },
  });
  writeProjectFile(projectRoot, 'src/i18n/locales/ar-SA.json', JSON.stringify({
    greeting: 'مرحبا {{name}}',
    navigation: { home: 'الرئيسية' },
  }));
  writeProjectFile(projectRoot, availabilityPath, `
    const unavailableLocales = new Set(['ar-SA']);
    export const isLocaleAvailable = (locale: string) => !unavailableLocales.has(locale);
  `);
  fs.appendFileSync(
    path.join(projectRoot, 'src/i18n/index.ts'),
    "\nimport { isLocaleAvailable } from './localeAvailability';\n" +
    "isLocaleAvailable('en-US');\n" +
    "export const diagnostics = ['en-US'].filter(isLocaleAvailable);\n" +
    "async function activateLocaleForAudit(locale) {\n" +
    "  return i18next.changeLanguage(locale);\n" +
    "}\n" +
    "window.__powerPagesLocalizationAudit = {\n" +
    "  activate: (locale) => activateLocaleForAudit(locale),\n" +
    "};\n"
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /does not apply isLocaleAvailable/i);
  assert.match(result.stderr, /managed availability logic/i);
  assert.match(result.stderr, /must be development-gated/i);
});

test('requires readiness metadata for mixed-direction localization', (t) => {
  const projectRoot = createLocalizedReactProject(t, {
    locales: ['en-US', 'ar-SA'],
    resourcePaths: {
      'en-US': 'src/i18n/locales/en-US.json',
      'ar-SA': 'src/i18n/locales/ar-SA.json',
    },
    bidirectionalReadiness: undefined,
  });
  writeProjectFile(projectRoot, 'src/i18n/locales/ar-SA.json', JSON.stringify({
    greeting: 'مرحبا {{name}}',
    navigation: { home: 'الرئيسية' },
  }));

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /require bidirectionalReadiness metadata/i);
});

test('approves an explicitly unverified custom package with initialization evidence', (t) => {
  const projectRoot = createLocalizedReactProject(t, {
    packageName: 'custom-react-i18n',
    packageVersion: '^2.0.0',
    packageVerification: {
      status: 'unverified',
      source: 'user-approved',
      evidenceUrl: 'https://custom.example.test/runtime',
    },
    initializationEvidence: {
      file: 'src/i18n/custom-provider.ts',
      marker: 'customI18n.initialize(',
    },
    managedFiles: ['src/i18n/custom-provider.ts'],
  });
  writeProjectFile(projectRoot, 'package.json', JSON.stringify({
    dependencies: {
      react: '^19.0.0',
      'react-dom': '^19.0.0',
      'custom-react-i18n': '^2.0.0',
    },
  }));
  writeProjectFile(
    projectRoot,
    'src/i18n/custom-provider.ts',
    "import customI18n from 'custom-react-i18n'; customI18n.initialize({ locale: 'en-US' });"
  );
  writeProjectFile(projectRoot, 'src/i18n/index.ts', 'export {};');

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('blocks custom initialization evidence when its marker is absent', (t) => {
  const projectRoot = createLocalizedReactProject(t, {
    packageName: 'custom-react-i18n',
    packageVersion: '^2.0.0',
    packageVerification: {
      status: 'unverified',
      source: 'user-approved',
    },
    initializationEvidence: {
      file: 'src/i18n/custom-provider.ts',
      marker: 'customI18n.initialize(',
    },
    managedFiles: ['src/i18n/custom-provider.ts'],
  });
  writeProjectFile(projectRoot, 'package.json', JSON.stringify({
    dependencies: {
      react: '^19.0.0',
      'react-dom': '^19.0.0',
      'custom-react-i18n': '^2.0.0',
    },
  }));
  writeProjectFile(
    projectRoot,
    'src/i18n/custom-provider.ts',
    "import customI18n from 'custom-react-i18n'; export default customI18n;"
  );
  writeProjectFile(projectRoot, 'src/i18n/index.ts', 'export {};');

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /initialization marker was not found/);
});

test('requires package verification metadata for schema version 1', (t) => {
  const projectRoot = createLocalizedReactProject(t, {
    packageVerification: undefined,
  });

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /packageVerification must be an object/);
});

test('accepts an evidence-backed manifest framework when project evidence is ambiguous', (t) => {
  const projectRoot = createLocalizedReactProject(t);
  writeProjectFile(projectRoot, 'package.json', JSON.stringify({
    dependencies: {
      react: '^19.0.0',
      'react-dom': '^19.0.0',
      vue: '^3.5.0',
      'react-i18next': '^16.0.0',
      i18next: '^25.0.0',
    },
  }));

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('blocks missing locale keys and protected-token mismatches', (t) => {
  const projectRoot = createLocalizedReactProject(t);
  writeProjectFile(projectRoot, 'src/i18n/locales/fr-FR.json', JSON.stringify({
    greeting: 'Bonjour',
  }));

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing translation keys: navigation.home/);
  assert.match(result.stderr, /protected interpolation\/markup tokens/);
});

test('blocks a default locale that is not configured', (t) => {
  const projectRoot = createLocalizedReactProject(t, { defaultLocale: 'de-DE' });
  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /defaultLocale must be one of the configured locales/);
});

test('blocks when the configured package is absent', (t) => {
  const projectRoot = createLocalizedReactProject(t, {
    packageName: 'missing-i18n-package',
    packageVerification: {
      status: 'unverified',
      source: 'user-approved',
    },
  });
  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /is not installed/);
});

test('blocks a framework-package-mode mismatch', (t) => {
  const projectRoot = createLocalizedReactProject(t, { mode: 'static' });
  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /react does not support "static"/);
  assert.match(result.stderr, /react-i18next.*runtime localization/);
});

test('blocks manifests that select temporarily unavailable localization modes', (t) => {
  const angularRoot = createManifestlessAngularStaticProject(t);
  const angularResult = runValidator(angularRoot);
  assert.equal(angularResult.status, 2);
  assert.match(
    angularResult.stderr,
    /Angular static localization is temporarily unavailable/
  );

  const astroRoot = createManifestlessAstroStaticProject(t);
  const astroResult = runValidator(astroRoot);
  assert.equal(astroResult.status, 2);
  assert.match(
    astroResult.stderr,
    /No Astro localization mode is currently available/
  );
});

test('blocks Angular runtime validation while static implementation residue remains', (t) => {
  const projectRoot = createAngularRuntimeProjectWithStaticResidue(t);
  const result = runValidator(projectRoot);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Angular static localization is temporarily unavailable/);
  assert.match(result.stderr, /Remove or migrate detected @angular\/localize/);
  assert.match(result.stderr, /Remove or migrate detected Angular i18n build configuration/);
});

test('blocks noncanonical manifest locale values', (t) => {
  const projectRoot = createLocalizedReactProject(t, {
    locales: ['en-us', 'fr-FR'],
    defaultLocale: 'en-us',
    resourcePaths: {
      'en-us': 'src/i18n/locales/en-US.json',
      'fr-FR': 'src/i18n/locales/fr-FR.json',
    },
    bidirectionalReadiness: {
      status: 'ready',
      localeReadiness: {
        'en-us': { status: 'ready' },
        'fr-FR': { status: 'ready' },
      },
      findings: [],
      renderedFindings: [],
    },
  });
  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /valid, canonical, and unique/);
});

test('allows intentional blank target values in blank translation mode', (t) => {
  const projectRoot = createLocalizedReactProject(t, { translationMethod: 'blank' });
  writeProjectFile(projectRoot, 'src/i18n/locales/fr-FR.json', JSON.stringify({
    greeting: '',
    navigation: { home: '' },
  }));

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('allows preserved stale translations in manifest-backed synchronization', (t) => {
  const projectRoot = createLocalizedReactProject(t);
  writeProjectFile(projectRoot, 'src/i18n/locales/fr-FR.json', JSON.stringify({
    greeting: 'Bonjour {{name}}',
    navigation: { home: 'Accueil' },
    legacy: 'Texte conservé',
  }));

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('extracts XLIFF 1.2 and XLIFF 2 messages', () => {
  assert.deepEqual(
    extractXlfMessages(
      '<trans-unit id="greeting"><source xml:lang="en">Hello</source><target>Bonjour</target></trans-unit>'
    ),
    { greeting: { source: 'Hello', target: 'Bonjour' } }
  );
  assert.deepEqual(
    extractXlfMessages('<unit id="greeting"><segment><source>Hello</source><target>Bonjour</target></segment></unit>'),
    { greeting: { source: 'Hello', target: 'Bonjour' } }
  );
  assert.deepEqual(
    extractXlfMessages(
      '<unit id="account">' +
      '<segment id="title"><source>Account</source><target>Compte</target></segment>' +
      '<segment id="count"><source>{count} items</source><target>{count} éléments</target></segment>' +
      '</unit>'
    ),
    {
      'account#title': { source: 'Account', target: 'Compte' },
      'account#count': { source: '{count} items', target: '{count} éléments' },
    }
  );
});

test('blocks stale target-only XLIFF messages', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(
    projectRoot,
    'src/locale/messages.xlf',
    '<trans-unit id="home"><source>Home</source><target>Home</target></trans-unit>'
  );
  writeProjectFile(
    projectRoot,
    'src/locale/messages.fr.xlf',
    '<trans-unit id="home"><source>Home</source><target>Accueil</target></trans-unit>' +
    '<trans-unit id="stale"><source>Old</source><target>Ancien</target></trans-unit>'
  );
  const errors = [];

  compareXlfResources(projectRoot, {
    locales: ['en-US', 'fr-FR'],
    defaultLocale: 'en-US',
    translationMethod: 'agent',
    resourcePaths: {
      'en-US': 'src/locale/messages.xlf',
      'fr-FR': 'src/locale/messages.fr.xlf',
    },
  }, errors);

  assert.deepEqual(errors, ['fr-FR: stale XLF messages: stale']);
});

test('blocks missing language selector and lang/dir behavior', (t) => {
  const projectRoot = createLocalizedReactProject(t, {
    generatedFiles: ['src/i18n/index.ts'],
  });
  writeProjectFile(projectRoot, 'src/i18n/index.ts', 'export const locale = "en-US";');

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /language selector/);
  assert.match(result.stderr, /document direction/);
  assert.match(result.stderr, /document language/);
});
