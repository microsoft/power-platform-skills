'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  LOCALIZATION_CAPABILITIES,
  classifyLocaleDirections,
  detectFramework,
  detectLocalization,
  detectSiteLanguage,
  discoverLocalizationImplementation,
  getFrameworkLocalizationAvailability,
  getLocaleDirection,
  getLocalizationModeAvailability,
  inspectProject,
  protectedTokenSignature,
  resolveLocale,
  verifyInitializationEvidence,
  validateLocalizationManifestShape,
  validateLocales,
} = require('../lib/localization-config');
const { createTempProject, writeProjectFile } = require('./test-utils');
const CONFIG_PATH = path.join(__dirname, '..', 'lib', 'localization-config.js');

function writePackage(projectRoot, dependencies) {
  writeProjectFile(projectRoot, 'package.json', JSON.stringify({ dependencies }, null, 2));
}

test('centralizes framework modes, recommendations, packages, and peers', () => {
  assert.deepEqual(LOCALIZATION_CAPABILITIES.frameworks.react.supportedModes, ['runtime']);
  assert.deepEqual(LOCALIZATION_CAPABILITIES.frameworks.react.availableModes, ['runtime']);
  assert.deepEqual(
    LOCALIZATION_CAPABILITIES.frameworks.angular.supportedModes,
    ['runtime', 'static']
  );
  assert.deepEqual(LOCALIZATION_CAPABILITIES.frameworks.angular.availableModes, ['runtime']);
  assert.equal(LOCALIZATION_CAPABILITIES.frameworks.angular.recommendedMode, 'runtime');
  assert.equal(
    LOCALIZATION_CAPABILITIES.frameworks.angular.recommendedPackages.static,
    '@angular/localize'
  );
  assert.deepEqual(
    LOCALIZATION_CAPABILITIES.frameworks.angular.frameworkPeers,
    ['@angular/core', '@angular/compiler', '@angular/compiler-cli']
  );
  assert.deepEqual(
    LOCALIZATION_CAPABILITIES.packages['astro-built-in'],
    { framework: 'astro', mode: 'static', builtIn: true }
  );
  assert.deepEqual(LOCALIZATION_CAPABILITIES.frameworks.astro.availableModes, []);
  assert.equal(LOCALIZATION_CAPABILITIES.frameworks.astro.recommendedMode, null);
});

test('reports centralized localization mode availability and stable reasons', () => {
  assert.deepEqual(getLocalizationModeAvailability('react', 'runtime'), {
    framework: 'react',
    mode: 'runtime',
    supported: true,
    available: true,
    status: 'available',
    recommendedPackage: 'react-i18next',
    builtIn: false,
  });

  const angularStatic = getLocalizationModeAvailability('angular', 'static');
  assert.equal(angularStatic.supported, true);
  assert.equal(angularStatic.available, false);
  assert.equal(angularStatic.status, 'temporarily-unavailable');
  assert.equal(
    angularStatic.reasonCode,
    'angular-static-temporarily-unavailable'
  );
  assert.match(angularStatic.reason, /Angular runtime localization is available/);
  assert.match(angularStatic.reason, /validated runtime alternatives are allowed/);

  const astro = getFrameworkLocalizationAvailability('astro');
  assert.deepEqual(astro.availableModes, []);
  assert.equal(astro.modes.static.available, false);
  assert.equal(astro.modes.static.recommendedPackage, 'astro-built-in');
  assert.equal(astro.modes.static.builtIn, true);
  assert.equal(
    astro.modes.static.reasonCode,
    'astro-static-temporarily-unavailable'
  );
});

test('includes detected framework availability in project inspection', (t) => {
  const projectRoot = createTempProject(t);
  writePackage(projectRoot, { astro: '^6.1.0' });

  const inspection = inspectProject(projectRoot);
  assert.equal(inspection.framework.framework, 'astro');
  assert.deepEqual(inspection.availability.availableModes, []);
  assert.equal(
    inspection.availability.modes.static.reasonCode,
    'astro-static-temporarily-unavailable'
  );
});

test('exposes mode availability through the shared CLI', () => {
  const frameworkResult = spawnSync(
    process.execPath,
    [CONFIG_PATH, 'mode-availability', '--framework', 'astro'],
    { encoding: 'utf8' }
  );
  assert.equal(frameworkResult.status, 0, frameworkResult.stderr);
  assert.deepEqual(JSON.parse(frameworkResult.stdout).availableModes, []);

  const modeResult = spawnSync(
    process.execPath,
    [
      CONFIG_PATH,
      'mode-availability',
      '--framework',
      'angular',
      '--mode',
      'static',
    ],
    { encoding: 'utf8' }
  );
  assert.equal(modeResult.status, 1);
  assert.equal(
    JSON.parse(modeResult.stdout).reasonCode,
    'angular-static-temporarily-unavailable'
  );
});

test('detects each supported framework from primary dependency evidence', (t) => {
  const cases = [
    ['react', { react: '^19.0.0', 'react-dom': '^19.0.0' }],
    ['vue', { vue: '^3.5.0' }],
    ['angular', { '@angular/core': '^19.1.0' }],
    ['astro', { astro: '^6.1.0' }],
  ];

  for (const [expected, dependencies] of cases) {
    const projectRoot = createTempProject(t);
    writePackage(projectRoot, dependencies);
    assert.equal(detectFramework(projectRoot).framework, expected);
  }
});

test('reports ambiguous primary framework evidence instead of guessing', (t) => {
  const projectRoot = createTempProject(t);
  writePackage(projectRoot, {
    react: '^19.0.0',
    'react-dom': '^19.0.0',
    vue: '^3.5.0',
  });

  const result = detectFramework(projectRoot);
  assert.equal(result.framework, null);
  assert.equal(result.ambiguous, true);
  assert.deepEqual(result.candidates, ['react', 'vue']);
});

test('treats conflicting primary configuration markers as ambiguous', (t) => {
  const projectRoot = createTempProject(t);
  writePackage(projectRoot, {
    react: '^19.0.0',
    'react-dom': '^19.0.0',
  });
  writeProjectFile(projectRoot, 'angular.json', '{}');

  const result = detectFramework(projectRoot);
  assert.equal(result.ambiguous, true);
  assert.deepEqual(result.candidates, ['react', 'angular']);
});

test('canonicalizes, visibly deduplicates, and validates registry subtags', () => {
  const result = validateLocales('en-us, fr-FR, en-US, xx-YY');

  assert.equal(result.valid, false);
  assert.deepEqual(result.locales, ['en-US', 'fr-FR']);
  assert.deepEqual(result.canonicalization, [{ input: 'en-us', canonical: 'en-US' }]);
  assert.deepEqual(result.duplicates, [{ input: 'en-US', canonical: 'en-US' }]);
  assert.match(result.invalid[0].reason, /unknown language subtag "xx"/);
});

test('resolves a single locale and its writing direction', () => {
  const spanish = resolveLocale('es-es');
  assert.equal(spanish.locale, 'es-ES');
  assert.equal(spanish.script, 'Latn');
  assert.equal(spanish.direction, 'ltr');
  assert.equal(getLocaleDirection('ar-SA'), 'rtl');
  assert.equal(getLocaleDirection('x-contoso'), 'ltr');
});

test('resolves direction from explicit or likely writing script', () => {
  const cases = [
    ['ar-SA', 'Arab', 'rtl'],
    ['az-Latn', 'Latn', 'ltr'],
    ['az-Arab', 'Arab', 'rtl'],
    ['ku-Latn', 'Latn', 'ltr'],
    ['ku-Arab', 'Arab', 'rtl'],
    ['pa-Guru', 'Guru', 'ltr'],
    ['pa-Arab', 'Arab', 'rtl'],
    ['sd-Deva', 'Deva', 'ltr'],
    ['sd-Arab', 'Arab', 'rtl'],
    ['ar-Latn', 'Latn', 'ltr'],
    ['wo-Gara', 'Gara', 'rtl'],
    ['phn-Phnx', 'Phnx', 'rtl'],
  ];

  for (const [locale, script, direction] of cases) {
    const result = resolveLocale(locale);
    assert.equal(result.valid, true, locale);
    assert.equal(result.script, script, locale);
    assert.equal(result.direction, direction, locale);
  }
});

test('classifies locale sets by their resolved directions', () => {
  assert.equal(
    classifyLocaleDirections(['en-US', 'fr-FR']).classification,
    'ltr-only'
  );
  assert.equal(
    classifyLocaleDirections(['ar-SA', 'he-IL']).classification,
    'rtl-only'
  );
  assert.equal(
    classifyLocaleDirections(['en-US', 'ar-SA']).classification,
    'mixed'
  );
});

test('validates bidirectional readiness and unavailable locale manifest fields', () => {
  const manifest = {
    schemaVersion: 1,
    framework: 'react',
    mode: 'runtime',
    packageName: 'i18next',
    packageVersion: '25.0.0',
    defaultLocale: 'en-US',
    locales: ['en-US', 'ar-SA'],
    translationMethod: 'agent',
    lastOperation: 'add',
    updatedAt: '2026-01-01T00:00:00.000Z',
    generatedFiles: [],
    managedFiles: [],
    resourcePaths: {},
    adoptedExistingConfiguration: false,
    packageVerification: {
      status: 'verified',
      source: 'known-capability',
    },
    unavailableLocales: ['ar-SA'],
    bidirectionalReadiness: {
      status: 'pending-remediation',
      findings: [],
      renderedFindings: [{
        caseId: 'calendar--open--desktop--ar',
        rule: 'computed-direction-mismatch',
        severity: 'error',
        message: 'Expected rtl but found ltr.',
        selector: '.calendar',
      }],
    },
  };

  assert.deepEqual(validateLocalizationManifestShape(manifest), []);
  assert.match(
    validateLocalizationManifestShape({
      ...manifest,
      unavailableLocales: undefined,
    }).join('\n'),
    /Pending bidirectional remediation requires at least one unavailable locale/
  );
  assert.match(
    validateLocalizationManifestShape({
      ...manifest,
      bidirectionalReadiness: { status: 'unknown', findings: [] },
    }).join('\n'),
    /bidirectionalReadiness\.status must be/
  );
  assert.match(
    validateLocalizationManifestShape({
      ...manifest,
      unavailableLocales: [],
      bidirectionalReadiness: {
        status: 'ready',
        findings: [],
        renderedFindings: manifest.bidirectionalReadiness.renderedFindings,
      },
    }).join('\n'),
    /Ready bidirectional readiness cannot contain unresolved renderedFindings/
  );
  assert.match(
    validateLocalizationManifestShape({
      ...manifest,
      bidirectionalReadiness: {
        status: 'approved-with-limitations',
        findings: [],
        renderedFindings: manifest.bidirectionalReadiness.renderedFindings,
      },
    }).join('\n'),
    /cannot contain rendered errors/
  );
  assert.match(
    validateLocalizationManifestShape({
      ...manifest,
      bidirectionalReadiness: {
        status: 'pending-remediation',
        findings: [],
        renderedFindings: [{ severity: 'error' }],
      },
    }).join('\n'),
    /renderedFindings\[0\]\.caseId/
  );
});

test('detects the persisted single-site language from document attributes', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'index.html', '<html lang="es-ES" dir="ltr"><body></body></html>');

  assert.deepEqual(detectSiteLanguage(projectRoot, 'react'), {
    detected: true,
    valid: true,
    locale: 'es-ES',
    direction: 'ltr',
    source: 'index.html',
    conflicts: [],
  });
});

test('reports missing or incorrect document direction', (t) => {
  const missingRoot = createTempProject(t);
  writeProjectFile(missingRoot, 'src/index.html', '<html lang="ar-SA"><body></body></html>');
  assert.match(
    detectSiteLanguage(missingRoot, 'angular').conflicts.join('\n'),
    /missing a valid html dir attribute/
  );

  const mismatchedRoot = createTempProject(t);
  writeProjectFile(
    mismatchedRoot,
    'src/index.html',
    '<html lang="ar-SA" dir="ltr"><body></body></html>'
  );
  assert.match(
    detectSiteLanguage(mismatchedRoot, 'angular').conflicts.join('\n'),
    /resolves to "rtl"/
  );
});

test('accepts scripts, regions, variants, extensions, and private-use suffixes', () => {
  const result = validateLocales([
    'zh-Hant-TW',
    'sl-rozaj-biske',
    'de-DE-u-co-phonebk',
    'en-US-x-contoso',
  ]);

  assert.equal(result.valid, true, JSON.stringify(result.invalid));
  assert.deepEqual(result.locales, [
    'zh-Hant-TW',
    'sl-biske-rozaj',
    'de-DE-u-co-phonebk',
    'en-US-x-contoso',
  ]);
});

test('accepts and canonicalizes registry grandfathered and private-use-only tags', () => {
  const result = validateLocales(['i-klingon', 'en-GB-oed', 'x-contoso']);

  assert.equal(result.valid, true, JSON.stringify(result.invalid));
  assert.deepEqual(result.locales, ['tlh', 'en-GB-oxendict', 'x-contoso']);
  assert.deepEqual(result.canonicalization, [
    { input: 'i-klingon', canonical: 'tlh' },
    { input: 'en-GB-oed', canonical: 'en-GB-oxendict' },
  ]);
});

test('detects existing localization and manifest conflicts', (t) => {
  const projectRoot = createTempProject(t);
  writePackage(projectRoot, { react: '^19.0.0', 'react-dom': '^19.0.0' });
  writeProjectFile(projectRoot, '.powerpages-localization.json', JSON.stringify({
    packageName: 'react-i18next',
    locales: ['en-US', 'fr-FR'],
    defaultLocale: 'en-US',
  }));
  fs.mkdirSync(path.join(projectRoot, 'src', 'i18n'), { recursive: true });

  const result = detectLocalization(projectRoot);
  assert.equal(result.detected, true);
  assert.equal(result.valid, false);
  assert.match(result.conflicts.join('\n'), /react-i18next.*not installed/);
  assert.deepEqual(result.resourceDirectories, ['src/i18n']);
});

test('treats a malformed localization manifest as repair-required evidence', (t) => {
  const projectRoot = createTempProject(t);
  writePackage(projectRoot, { react: '^19.0.0', 'react-dom': '^19.0.0' });
  writeProjectFile(projectRoot, '.powerpages-localization.json', '{not-json');

  const result = detectLocalization(projectRoot);
  assert.equal(result.detected, true);
  assert.equal(result.valid, false);
  assert.match(result.conflicts.join('\n'), /exists but is not valid JSON/);
});

test('reports malformed manifest field types during inspection instead of throwing', (t) => {
  const projectRoot = createTempProject(t);
  writePackage(projectRoot, { react: '^19.0.0', 'react-dom': '^19.0.0' });
  writeProjectFile(projectRoot, '.powerpages-localization.json', JSON.stringify({
    mode: 42,
    packageName: [],
    locales: 42,
    defaultLocale: {},
    resourcePaths: [],
  }));

  const result = detectLocalization(projectRoot);
  assert.equal(result.detected, true);
  assert.equal(result.valid, false);
  assert.match(result.conflicts.join('\n'), /locales must be an array of non-empty strings/);
  assert.match(result.conflicts.join('\n'), /resourcePaths must be an object/);
});

test('derives mode, locales, default, and resources for a manifestless existing setup', (t) => {
  const projectRoot = createTempProject(t);
  writePackage(projectRoot, {
    react: '^19.0.0',
    'react-dom': '^19.0.0',
    i18next: '^25.0.0',
    'react-i18next': '^16.0.0',
  });
  writeProjectFile(projectRoot, 'src/i18n/index.ts', "i18next.init({ fallbackLng: 'en-US' });");
  writeProjectFile(projectRoot, 'src/i18n/locales/en-US.json', '{"home":"Home"}');
  writeProjectFile(projectRoot, 'src/i18n/locales/fr-FR.json', '{"home":"Accueil"}');
  writeProjectFile(
    projectRoot,
    'src/components/LanguageSelector.tsx',
    "export function LanguageSelector(){ changeLanguage('fr-FR'); document.documentElement.lang='fr-FR'; document.documentElement.dir='ltr'; }"
  );

  const result = detectLocalization(projectRoot);
  assert.equal(result.valid, true, result.conflicts.join('\n'));
  assert.equal(result.packageName, 'react-i18next');
  assert.equal(result.mode, 'runtime');
  assert.deepEqual(result.locales, ['en-US', 'fr-FR']);
  assert.equal(result.defaultLocale, 'en-US');
  assert.equal(result.resourcePaths['fr-FR'], 'src/i18n/locales/fr-FR.json');
});

test('reports unavailable static evidence even when an Angular manifest claims runtime', (t) => {
  const projectRoot = createTempProject(t);
  writePackage(projectRoot, {
    '@angular/core': '^19.1.0',
    '@angular/compiler': '^19.1.0',
    '@angular/compiler-cli': '^19.1.0',
    '@angular/localize': '^19.1.0',
    '@jsverse/transloco': '^7.6.0',
  });
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
    'src/app/i18n.ts',
    "provideTransloco({}); setActiveLang('fr-FR'); document.documentElement.lang='fr-FR'; document.documentElement.dir='ltr';"
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
    generatedFiles: [],
    managedFiles: ['src/app/i18n.ts'],
    adoptedExistingConfiguration: false,
    lastOperation: 'create',
    updatedAt: '2026-07-30T00:00:00.000Z',
  }));

  const result = detectLocalization(projectRoot);
  assert.equal(result.mode, 'runtime');
  assert.deepEqual(
    result.unavailableModeEvidence.map((entry) => entry.detail).sort(),
    ['@angular/localize', 'Angular i18n build configuration']
  );
  assert.match(
    result.conflicts.join('\n'),
    /manifest mode "runtime" conflicts with detected static mode evidence/
  );
  assert.match(
    result.conflicts.join('\n'),
    /Angular static localization is temporarily unavailable/
  );
});

test('scans source files incrementally and stops after all signals are found', (t) => {
  const projectRoot = createTempProject(t);
  const implementation =
    "i18next.init({}); changeLanguage('fr-FR'); " +
    "document.documentElement.lang='fr-FR'; document.documentElement.dir='ltr';";
  writeProjectFile(projectRoot, 'src/a.ts', implementation);
  writeProjectFile(projectRoot, 'src/z.ts', 'x'.repeat(5000));

  const result = discoverLocalizationImplementation(
    projectRoot,
    'react',
    'runtime',
    false,
    null
  );

  assert.deepEqual(result.files, ['src/a.ts']);
  assert.equal(result.scan.stoppedEarly, true);
  assert.equal(result.scan.bytesRead, Buffer.byteLength(implementation));
  assert.deepEqual(result.scan.skippedFiles, []);
});

test('enforces per-file and total source scan limits with diagnostics', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'src/a-large.ts', 'x'.repeat(1000));
  writeProjectFile(
    projectRoot,
    'src/b.ts',
    "i18next.init({}); changeLanguage('fr'); " +
    "document.documentElement.lang='fr'; document.documentElement.dir='ltr';"
  );

  const skippedResult = discoverLocalizationImplementation(
    projectRoot,
    'react',
    'runtime',
    false,
    null,
    { maxFileBytes: 300, maxTotalBytes: 1000 }
  );
  assert.equal(skippedResult.scan.skippedFiles.length, 1);
  assert.equal(skippedResult.scan.skippedFiles[0].reason, 'file-size-limit');
  assert.equal(skippedResult.scan.stoppedEarly, true);

  const limitedRoot = createTempProject(t);
  writeProjectFile(limitedRoot, 'src/a.ts', 'x'.repeat(80));
  writeProjectFile(
    limitedRoot,
    'src/b.ts',
    "i18next.init({}); changeLanguage('fr'); " +
    "document.documentElement.lang='fr'; document.documentElement.dir='ltr';"
  );
  const limitedResult = discoverLocalizationImplementation(
    limitedRoot,
    'react',
    'runtime',
    false,
    null,
    { maxFileBytes: 1000, maxTotalBytes: 100 }
  );
  assert.equal(limitedResult.scan.limitReached, true);
  assert.equal(limitedResult.scan.bytesRead, 80);
  assert.deepEqual(limitedResult.files, ['src/a.ts']);
});

test('verifies custom package initialization using an imported package and exact marker', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(
    projectRoot,
    'src/i18n/custom.ts',
    "import customI18n from 'custom-i18n/runtime'; customI18n.initialize({});"
  );

  const valid = verifyInitializationEvidence(projectRoot, 'custom-i18n', {
    file: 'src/i18n/custom.ts',
    marker: 'customI18n.initialize(',
  });
  assert.equal(valid.valid, true, valid.reason);

  const missingMarker = verifyInitializationEvidence(projectRoot, 'custom-i18n', {
    file: 'src/i18n/custom.ts',
    marker: 'customI18n.start(',
  });
  assert.equal(missingMarker.valid, false);
  assert.match(missingMarker.reason, /marker was not found/);

  const outsideProject = verifyInitializationEvidence(projectRoot, 'custom-i18n', {
    file: path.join('..', 'outside.ts'),
    marker: 'initialize(',
  });
  assert.equal(outsideProject.valid, false);
  assert.match(outsideProject.reason, /inside the project root/);
});

test('extracts protected translation tokens deterministically', () => {
  const signature = protectedTokenSignature(
    'Hello {{name}}, open <a href="https://contoso.com">{count}</a> (%s)'
  );

  assert.deepEqual(signature, [
    '%s',
    '<a href="https://contoso.com">',
    '</a>',
    '{count}',
    '{{name}}',
  ].sort());
});

test('preserves protected tokens after non-BMP characters and ICU expressions', () => {
  const signature = protectedTokenSignature(
    '😀😀 {count, plural, other {# items}} https://safe.example'
  );

  assert.equal(signature.includes('https://safe.example'), true);
});

test('distinguishes quoted ICU literals from runtime arguments', () => {
  assert.notDeepEqual(
    protectedTokenSignature("{count, plural, other {'{notAToken}'}}"),
    protectedTokenSignature('{count, plural, other {{notAToken}}}')
  );
  assert.equal(
    protectedTokenSignature("{count, plural, other {'{notAToken}'}}")
      .includes('ICU_LITERAL:{notAToken}'),
    true
  );
});

test('protects ICU arguments and selectors', () => {
  const signature = protectedTokenSignature(
    '{count, plural, =0 {No items} one {# item} other {# items}}'
  );

  assert.deepEqual(signature, [
    'ICU:count:#',
    'ICU:count:#',
    'ICU:count:=0',
    'ICU:count:one',
    'ICU:count:other',
    'ICU:count:plural',
  ]);
});

test('protects arbitrary ICU select keys without treating branch text as placeholders', () => {
  const signature = protectedTokenSignature(
    '{gender, select, male {He updated {count, number}.} ' +
    'female {She updated {count, number}.} other {They updated {count, number}.}}'
  );

  assert.equal(signature.includes('ICU:gender:male'), true);
  assert.equal(signature.includes('ICU:gender:female'), true);
  assert.equal(signature.includes('ICU:gender:other'), true);
  assert.equal(signature.includes('ICU:count:number'), true);
  assert.equal(signature.includes('{He}'), false);
  assert.equal(signature.includes('{She}'), false);
});

test('protects nested plural and select structures', () => {
  const signature = protectedTokenSignature(
    '{count, plural, one {{gender, select, male {His item} female {Her item} other {Their item}}} ' +
    'other {{gender, select, male {His items} female {Her items} other {Their items}}}}'
  );

  for (const token of [
    'ICU:count:plural',
    'ICU:count:one',
    'ICU:count:other',
    'ICU:gender:select',
    'ICU:gender:male',
    'ICU:gender:female',
  ]) {
    assert.equal(signature.includes(token), true, `Missing ${token}`);
  }
});

test('protects two-part ICU number, date, and time expressions', () => {
  assert.deepEqual(protectedTokenSignature('{price, number}'), ['ICU:price:number']);
  assert.deepEqual(protectedTokenSignature('{created, date}'), ['ICU:created:date']);
  assert.deepEqual(protectedTokenSignature('{created, time}'), ['ICU:created:time']);
});

test('rejects localization packages that target another detected framework', (t) => {
  const projectRoot = createTempProject(t);
  writePackage(projectRoot, {
    react: '^19.0.0',
    'react-dom': '^19.0.0',
    'vue-i18n': '^11.0.0',
  });
  writeProjectFile(projectRoot, 'src/i18n/index.ts', "i18next.init({ fallbackLng: 'en-US' });");
  writeProjectFile(projectRoot, 'src/i18n/locales/en-US.json', '{"home":"Home"}');
  writeProjectFile(projectRoot, 'src/i18n/locales/fr-FR.json', '{"home":"Accueil"}');
  writeProjectFile(
    projectRoot,
    'src/components/LanguageSelector.tsx',
    "export function LanguageSelector(){ document.documentElement.lang='en-US'; document.documentElement.dir='ltr'; }"
  );

  const result = detectLocalization(projectRoot);
  assert.equal(result.valid, false);
  assert.match(result.conflicts.join('\n'), /do not match detected react framework/);
});
