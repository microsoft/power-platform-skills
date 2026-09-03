'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'render-add-localization-plan.js');

const ENGLISH_LABELS = {
  navigation: {
    group: 'Localization plan',
    overview: 'Overview',
    languages: 'Languages',
    changes: 'Changes',
    readiness: 'Bidirectional readiness',
    verification: 'Verification',
  },
  overview: {
    title: 'Localization overview',
    description: 'Localization implementation plan for {siteName}',
    framework: 'Framework',
    invocation: 'Invocation',
    operation: 'Operation',
    existingSetup: 'Existing localization',
    configuration: 'Approved configuration',
    frameworkEvidence: 'Framework evidence',
    existingDetails: 'Existing setup',
    conflicts: 'Conflicts',
    noConflicts: 'No conflicts detected.',
  },
  configuration: {
    package: 'Package',
    mode: 'Mode',
    defaultLocale: 'Default locale',
    translation: 'Translation population',
    selector: 'Language selector',
    verification: 'Package verification',
    selection: 'Package selection',
    evidenceSource: 'Evidence source',
    evidence: 'Evidence',
    initialization: 'Initialization evidence',
    rootRepair: 'Root document repair',
  },
  languages: {
    title: 'Languages',
    description: 'Source, existing, and newly added locales',
    language: 'Language',
    locale: 'Locale',
    direction: 'Direction',
    roles: 'Roles',
    availability: 'Availability',
  },
  changes: {
    title: 'Files and packages',
    description: 'Exact implementation delta after approval',
    path: 'Path or package',
    action: 'Action',
    reason: 'Reason',
  },
  readiness: {
    title: 'Bidirectional readiness',
    description: 'Direction transition, findings, and planned remediation',
    transition: 'Direction-set transition',
    findings: 'Readiness findings',
    noFindings: 'No readiness findings.',
    location: 'Location',
    rule: 'Rule',
    remediation: 'Planned remediation',
    physicalExceptions: 'Physical exceptions',
    scriptFonts: 'Script font changes',
    unavailableLocales: 'Locales pending remediation',
    none: 'None.',
  },
  verification: {
    title: 'Verification and limitations',
    description: 'Checks that will run before maker review',
    checks: 'Verification checks',
    limitations: 'Known limitations',
    noLimitations: 'No known limitations.',
  },
  status: {
    new: 'New',
    preserved: 'Preserved',
    changed: 'Changed',
    create: 'Create',
    update: 'Update',
    preserve: 'Preserve',
    replace: 'Replace',
    skip: 'Skip',
    source: 'Source',
    default: 'Default',
    existing: 'Existing',
    added: 'Added',
    available: 'Available',
    pendingRemediation: 'Pending remediation',
    verified: 'Verified',
    unverified: 'Unverified',
    yes: 'Yes',
    no: 'No',
  },
  packageSelection: {
    recommended: 'Recommended',
    alternative: 'Alternative',
    preserved: 'Preserved',
  },
  evidenceSource: {
    knownCapability: 'Known capability',
    packageDocumentation: 'Package documentation',
    officialDocumentation: 'Official documentation',
    userApproved: 'User approved',
  },
  severity: { error: 'Error', review: 'Review' },
  operation: {
    create: 'Create localization',
    addLanguages: 'Add languages',
    repair: 'Repair',
    reconfigure: 'Reconfigure',
  },
  invocation: { direct: 'Direct', createSite: 'From create-site' },
  footer: { aiWarning: 'AI-generated content may be incorrect' },
};

const SAMPLE_DATA = {
  SITE_NAME: 'Contoso Portal',
  PLAN_TITLE: 'Localization Implementation Plan',
  SOURCE_LANGUAGE: 'English (United States)',
  SOURCE_LOCALE: 'en-US',
  SOURCE_DIRECTION: 'ltr',
  FRAMEWORK: 'React',
  INVOCATION_CONTEXT: 'direct',
  OPERATION: 'create',
  EXISTING_LOCALIZATION_DETECTED: false,
  SUMMARY: 'Add French runtime localization while preserving English as the source and default.',
  PLAN_LABELS: ENGLISH_LABELS,
  DISCOVERY_DATA: {
    frameworkEvidence: ['package.json contains react and react-dom dependencies.'],
    existingSetup: ['No existing localization package, resources, or manifest were detected.'],
    conflicts: [],
  },
  CONFIGURATION_DATA: {
    package: {
      value: 'react-i18next 15.0.0',
      name: 'react-i18next',
      version: '15.0.0',
      status: 'new',
      verification: 'verified',
      selection: 'recommended',
      evidenceSource: 'known-capability',
      evidenceUrl: 'https://www.npmjs.com/package/react-i18next',
      initializationEvidence: null,
    },
    mode: { value: 'runtime', status: 'new' },
    defaultLocale: { value: 'en-US', status: 'preserved' },
    translation: {
      method: 'agent',
      value: 'Agent-generated translations',
      description: 'Translate from the approved English source resources.',
      warning: 'AI translations may contain errors - please verify them before publishing.',
    },
    selector: {
      value: 'Shared navigation',
      description: 'Switch locales without reloading and persist the browser preference.',
    },
    rootDocumentRepair: null,
  },
  LOCALES_DATA: [
    {
      language: 'English (United States)',
      locale: 'en-US',
      direction: 'ltr',
      roles: ['source', 'default', 'existing'],
      availability: 'available',
    },
    {
      language: 'French (France)',
      locale: 'fr-FR',
      direction: 'ltr',
      roles: ['added'],
      availability: 'available',
    },
  ],
  FILES_DATA: [
    {
      path: 'package.json',
      action: 'update',
      reason: 'Add the approved runtime localization dependencies.',
    },
    {
      path: 'src/i18n/index.ts',
      action: 'create',
      reason: 'Initialize the locale coordinator and fallback behavior.',
    },
  ],
  READINESS_DATA: {
    transition: 'ltr-only → ltr-only',
    findings: [
      {
        severity: 'review',
        file: 'src/components/Carousel.tsx',
        line: 42,
        rule: 'directional-geometry-review',
        message: 'Review carousel movement in both directions.',
        remediation: 'Use semantic next and previous movement and browser-test both directions.',
      },
    ],
    physicalExceptions: [],
    scriptFonts: ['Existing font supports Latin source and target content.'],
    unavailableLocales: [],
  },
  VALIDATION_DATA: [
    ['independent-validator', 'Run the independent localization validator.'],
    ['project-build', 'Run the existing project build.'],
    ['package-initialization', 'Verify package initialization.'],
    ['resource-completeness', 'Verify every locale resource has every source key.'],
    ['protected-tokens', 'Verify protected tokens are unchanged.'],
    ['locale-navigation', 'Verify the selector or static locale navigation.'],
    ['locale-state', 'Verify runtime persistence or static navigation state.'],
    ['fallback-behavior', 'Verify invalid and missing locale fallback.'],
    ['document-lang-dir', 'Verify the active document language and direction.'],
    ['browser-console', 'Verify the browser console has no localization errors.'],
    ['representative-routes', 'Verify representative routes and viewports.'],
    ['bidirectional-content', 'Verify RTL and mixed-direction content.'],
    ['localized-formatting', 'Verify locale-aware dates and numbers.'],
    ['script-fonts', 'Verify script font coverage and loading.'],
    ['directional-components', 'Verify directional components and assets.'],
    ['accessibility', 'Verify no serious accessibility regression.'],
  ].map(([id, description]) => ({ id, description })),
  LIMITATIONS_DATA: [],
};

function run(data, outputPath, mode = 'inline') {
  if (mode === 'file') {
    const dataPath = path.join(path.dirname(outputPath), 'plan-data.json');
    fs.writeFileSync(dataPath, JSON.stringify(data), 'utf8');
    return spawnSync(
      process.execPath,
      [scriptPath, '--output', outputPath, '--data', dataPath],
      { encoding: 'utf8' }
    );
  }
  return spawnSync(
    process.execPath,
    [scriptPath, '--output', outputPath, '--data-inline', JSON.stringify(data)],
    { encoding: 'utf8' }
  );
}

test('renders the localization plan in the source locale', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localization-plan-'));
  const outputPath = path.join(tempDir, 'add-localization-plan.html');
  const result = run(SAMPLE_DATA, outputPath, 'file');

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const html = fs.readFileSync(outputPath, 'utf8');
  assert.match(html, /<html lang="en-US" dir="ltr">/);
  assert.match(html, /Localization Implementation Plan/);
  assert.match(html, /Contoso Portal/);
  assert.match(html, /react-i18next 15\.0\.0/);
  assert.match(html, /package\.json contains react and react-dom/);
  assert.match(html, /Known capability/);
  assert.match(html, /fr-FR/);
  assert.match(html, /src\/i18n\/index\.ts/);
  assert.match(html, /directional-geometry-review/);
  assert.match(html, /AI translations may contain errors/);
  assert.ok(
    html.indexOf('data-label="footer.aiWarning"') < html.indexOf('<script id="siteNameData"'),
    'localized footer must exist before the script applies data-label text'
  );
  assert.ok(fs.existsSync(path.join(tempDir, 'power-pages-icon.png')));
});

test('keeps the plan in the source locale when the resulting default changes', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localization-plan-'));
  const outputPath = path.join(tempDir, 'add-localization-plan.html');
  const data = {
    ...SAMPLE_DATA,
    OPERATION: 'reconfigure',
    EXISTING_LOCALIZATION_DETECTED: true,
    CONFIGURATION_DATA: {
      ...SAMPLE_DATA.CONFIGURATION_DATA,
      defaultLocale: { value: 'fr-FR', status: 'changed' },
    },
    LOCALES_DATA: [
      {
        language: 'English (United States)',
        locale: 'en-US',
        direction: 'ltr',
        roles: ['source', 'existing'],
        availability: 'available',
      },
      {
        language: 'French (France)',
        locale: 'fr-FR',
        direction: 'ltr',
        roles: ['default', 'existing'],
        availability: 'available',
      },
    ],
  };

  const result = run(data, outputPath);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const html = fs.readFileSync(outputPath, 'utf8');
  assert.match(html, /<html lang="en-US" dir="ltr">/);
  assert.match(html, /"value":"fr-FR","status":"changed"/);
});

test('renders an RTL source-language plan with logical layout CSS', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localization-plan-'));
  const outputPath = path.join(tempDir, 'add-localization-plan.html');
  const data = {
    ...SAMPLE_DATA,
    PLAN_TITLE: 'خطة تنفيذ الترجمة',
    SOURCE_LANGUAGE: 'العربية',
    SOURCE_LOCALE: 'ar-SA',
    SOURCE_DIRECTION: 'rtl',
    SUMMARY: 'إضافة اللغة الإنجليزية مع الحفاظ على العربية كلغة المصدر.',
    PLAN_LABELS: {
      ...ENGLISH_LABELS,
      navigation: {
        group: 'خطة الترجمة',
        overview: 'نظرة عامة',
        languages: 'اللغات',
        changes: 'التغييرات',
        readiness: 'جاهزية الاتجاهين',
        verification: 'التحقق',
      },
      overview: {
        ...ENGLISH_LABELS.overview,
        title: 'نظرة عامة على الترجمة',
        description: 'خطة تنفيذ الترجمة لـ {siteName}',
      },
      footer: { aiWarning: 'قد يكون المحتوى الذي تم إنشاؤه بواسطة الذكاء الاصطناعي غير صحيح' },
    },
    CONFIGURATION_DATA: {
      ...SAMPLE_DATA.CONFIGURATION_DATA,
      defaultLocale: { value: 'ar-SA', status: 'preserved' },
    },
    LOCALES_DATA: [
      {
        language: 'العربية',
        locale: 'ar-SA',
        direction: 'rtl',
        roles: ['source', 'default', 'existing'],
        availability: 'available',
      },
      {
        language: 'الإنجليزية',
        locale: 'en-US',
        direction: 'ltr',
        roles: ['added'],
        availability: 'available',
      },
    ],
  };

  const result = run(data, outputPath);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const html = fs.readFileSync(outputPath, 'utf8');
  assert.match(html, /<html lang="ar-SA" dir="rtl">/);
  assert.match(html, /نظرة عامة على الترجمة/);
  assert.match(html, /border-inline-start/);
  assert.match(html, /border-inline-end/);
  assert.doesNotMatch(
    html,
    /(?:border|padding|margin)-(?:left|right)|text-align:\s*(?:left|right)|(?:^|[;{])(?:left|right):/m
  );
});

test('escapes localized and plan data embedded in HTML', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localization-plan-'));
  const outputPath = path.join(tempDir, 'add-localization-plan.html');
  const data = {
    ...SAMPLE_DATA,
    SUMMARY: '</script><script>window.__summaryPwned=1</script>',
    PLAN_LABELS: {
      ...ENGLISH_LABELS,
      navigation: {
        ...ENGLISH_LABELS.navigation,
        overview: '</script><script>window.__labelPwned=1</script>',
      },
    },
    FILES_DATA: [
      {
        path: '</script><script>window.__filePwned=1</script>',
        action: 'create',
        reason: '<img src=x onerror=alert(1)>',
      },
    ],
  };

  const result = run(data, outputPath);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const html = fs.readFileSync(outputPath, 'utf8');
  assert.doesNotMatch(html, /<\/script><script>window\.__(?:summary|label|file)Pwned/);
  assert.match(html, /\\u003c\/script>/);
});

test('rejects source locale and direction mismatches', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localization-plan-'));
  const outputPath = path.join(tempDir, 'add-localization-plan.html');
  const result = run(
    { ...SAMPLE_DATA, SOURCE_LOCALE: 'ar-SA', SOURCE_DIRECTION: 'ltr' },
    outputPath
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /SOURCE_DIRECTION "ltr" does not match ar-SA/);
  assert.equal(fs.existsSync(outputPath), false);
});

test('rejects missing localized labels', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localization-plan-'));
  const outputPath = path.join(tempDir, 'add-localization-plan.html');
  const data = {
    ...SAMPLE_DATA,
    PLAN_LABELS: { ...ENGLISH_LABELS, footer: {} },
  };
  const result = run(data, outputPath);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /footer\.aiWarning/);
});

test('rejects inconsistent default and locale-role data', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localization-plan-'));
  const outputPath = path.join(tempDir, 'add-localization-plan.html');
  const data = {
    ...SAMPLE_DATA,
    CONFIGURATION_DATA: {
      ...SAMPLE_DATA.CONFIGURATION_DATA,
      defaultLocale: { value: 'de-DE', status: 'changed' },
    },
  };
  const result = run(data, outputPath);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /defaultLocale\.value must match the default locale role/);
});

test('rejects unsafe unexpected statuses and incomplete verification coverage', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localization-plan-'));
  const statusOutput = path.join(tempDir, 'status.html');
  const unsafeStatus = {
    ...SAMPLE_DATA,
    CONFIGURATION_DATA: {
      ...SAMPLE_DATA.CONFIGURATION_DATA,
      translation: {
        ...SAMPLE_DATA.CONFIGURATION_DATA.translation,
        status: '" onmouseover="window.__pwned=1',
      },
    },
  };
  const statusResult = run(unsafeStatus, statusOutput);
  assert.equal(statusResult.status, 1);
  assert.match(statusResult.stderr, /translation must not define status/);

  const coverageOutput = path.join(tempDir, 'coverage.html');
  const incomplete = {
    ...SAMPLE_DATA,
    VALIDATION_DATA: [
      { id: 'project-build', description: 'Run the project build.' },
    ],
  };
  const coverageResult = run(incomplete, coverageOutput);
  assert.equal(coverageResult.status, 1);
  assert.match(coverageResult.stderr, /missing required checks/);
  assert.match(coverageResult.stderr, /independent-validator/);
});

test('accepts package documentation evidence and rejects invalid unverified evidence', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localization-plan-'));
  const validOutput = path.join(tempDir, 'package-docs.html');
  const packageDocs = {
    ...SAMPLE_DATA,
    CONFIGURATION_DATA: {
      ...SAMPLE_DATA.CONFIGURATION_DATA,
      package: {
        ...SAMPLE_DATA.CONFIGURATION_DATA.package,
        selection: 'alternative',
        evidenceSource: 'package-documentation',
        evidenceUrl: undefined,
      },
    },
  };
  const valid = run(packageDocs, validOutput);
  assert.equal(valid.status, 0, valid.stderr || valid.stdout);

  const invalidOutput = path.join(tempDir, 'unverified.html');
  const invalid = {
    ...SAMPLE_DATA,
    CONFIGURATION_DATA: {
      ...SAMPLE_DATA.CONFIGURATION_DATA,
      package: {
        ...SAMPLE_DATA.CONFIGURATION_DATA.package,
        verification: 'unverified',
        evidenceSource: 'package-documentation',
      },
    },
  };
  const invalidResult = run(invalid, invalidOutput);
  assert.equal(invalidResult.status, 1);
  assert.match(invalidResult.stderr, /must use evidenceSource "user-approved"/);

  const officialOutput = path.join(tempDir, 'official.html');
  const officialWithoutUrl = {
    ...SAMPLE_DATA,
    CONFIGURATION_DATA: {
      ...SAMPLE_DATA.CONFIGURATION_DATA,
      package: {
        ...SAMPLE_DATA.CONFIGURATION_DATA.package,
        selection: 'alternative',
        evidenceSource: 'official-documentation',
        evidenceUrl: undefined,
      },
    },
  };
  const officialResult = run(officialWithoutUrl, officialOutput);
  assert.equal(officialResult.status, 1);
  assert.match(officialResult.stderr, /requires an HTTPS evidenceUrl/);
});

test('rejects contradictory source roles, duplicate locales, and incomplete findings', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localization-plan-'));
  const localeOutput = path.join(tempDir, 'locales.html');
  const invalidLocales = {
    ...SAMPLE_DATA,
    LOCALES_DATA: [
      {
        language: 'English (United States)',
        locale: 'en-US',
        direction: 'ltr',
        roles: ['source', 'default', 'added'],
        availability: 'available',
      },
      {
        language: 'English duplicate',
        locale: 'en-US',
        direction: 'ltr',
        roles: ['existing'],
        availability: 'available',
      },
    ],
  };
  const localeResult = run(invalidLocales, localeOutput);
  assert.equal(localeResult.status, 1);
  assert.match(localeResult.stderr, /must not contain duplicate locale tags/);
  assert.match(localeResult.stderr, /source locale must use the existing role/);

  const findingOutput = path.join(tempDir, 'finding.html');
  const incompleteFinding = {
    ...SAMPLE_DATA,
    READINESS_DATA: {
      ...SAMPLE_DATA.READINESS_DATA,
      findings: [
        {
          severity: 'error',
          file: 'src/styles.css',
          line: 0,
          rule: 'directional-physical-css',
          message: 'Physical CSS blocks RTL.',
        },
      ],
    },
  };
  const findingResult = run(incompleteFinding, findingOutput);
  assert.equal(findingResult.status, 1);
  assert.match(findingResult.stderr, /line must be a positive integer/);
  assert.match(findingResult.stderr, /remediation must be a non-empty string/);
});

test('rejects plans for temporarily unavailable localization modes', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localization-plan-'));
  const angularOutput = path.join(tempDir, 'angular-static.html');
  const angularStatic = {
    ...SAMPLE_DATA,
    FRAMEWORK: 'Angular',
    CONFIGURATION_DATA: {
      ...SAMPLE_DATA.CONFIGURATION_DATA,
      package: {
        ...SAMPLE_DATA.CONFIGURATION_DATA.package,
        value: '@angular/localize 19.1.0',
        name: '@angular/localize',
        version: '19.1.0',
      },
      mode: {
        ...SAMPLE_DATA.CONFIGURATION_DATA.mode,
        value: 'static',
      },
    },
  };
  const angularResult = run(angularStatic, angularOutput);
  assert.equal(angularResult.status, 1);
  assert.match(angularResult.stderr, /Angular static localization is temporarily unavailable/);
  assert.equal(fs.existsSync(angularOutput), false);

  const astroOutput = path.join(tempDir, 'astro-static.html');
  const astroStatic = {
    ...angularStatic,
    FRAMEWORK: 'Astro',
    CONFIGURATION_DATA: {
      ...angularStatic.CONFIGURATION_DATA,
      package: {
        ...angularStatic.CONFIGURATION_DATA.package,
        value: 'Astro built-in i18n',
        name: 'astro-built-in',
        version: 'built-in',
      },
    },
  };
  const astroResult = run(astroStatic, astroOutput);
  assert.equal(astroResult.status, 1);
  assert.match(astroResult.stderr, /No Astro localization mode is currently available/);
  assert.equal(fs.existsSync(astroOutput), false);
});

test('rejects a known package that does not match the planned framework mode', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localization-plan-'));
  const output = path.join(tempDir, 'package-mismatch.html');
  const mismatch = {
    ...SAMPLE_DATA,
    FRAMEWORK: 'Angular',
    CONFIGURATION_DATA: {
      ...SAMPLE_DATA.CONFIGURATION_DATA,
      package: {
        ...SAMPLE_DATA.CONFIGURATION_DATA.package,
        value: '@angular/localize 19.1.0',
        name: '@angular/localize',
        version: '19.1.0',
      },
      mode: {
        ...SAMPLE_DATA.CONFIGURATION_DATA.mode,
        value: 'runtime',
      },
    },
  };

  const result = run(mismatch, output);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /@angular\/localize.*angular static localization, not angular runtime/
  );
  assert.equal(fs.existsSync(output), false);
});

test('rejects invalid JSON and refuses to overwrite an existing plan', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localization-plan-'));
  const invalidOutput = path.join(tempDir, 'invalid.html');
  const invalid = spawnSync(
    process.execPath,
    [scriptPath, '--output', invalidOutput, '--data-inline', '{bad json}'],
    { encoding: 'utf8' }
  );
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /not valid JSON/);

  const outputPath = path.join(tempDir, 'add-localization-plan.html');
  const first = run(SAMPLE_DATA, outputPath);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const original = fs.readFileSync(outputPath, 'utf8');
  const second = run(SAMPLE_DATA, outputPath);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /Output file already exists/);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), original);
});
