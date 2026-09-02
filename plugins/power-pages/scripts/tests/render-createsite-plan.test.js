const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'render-createsite-plan.js');

const ENGLISH_LABELS = {
  navigation: {
    group: 'Plan',
    overview: 'Overview',
    design: 'Design',
    pages: 'Pages & Components',
    deployment: 'Deployment & Review',
  },
  overview: {
    title: 'Overview',
    description: 'Implementation plan for {siteName}',
    stats: { pages: 'Pages', components: 'Shared Components', routes: 'Routes' },
    nextSteps: {
      title: 'What happens next',
      design: {
        title: 'Apply design tokens',
        description: 'Fonts, palette, motion, and backgrounds written into your theme',
      },
      components: {
        title: 'Build shared components',
        descriptionOne: '{count} reusable component used across pages',
        descriptionOther: '{count} reusable components used across pages',
      },
      pages: {
        title: 'Create pages',
        descriptionOne: '{count} page with routing and navigation',
        descriptionOther: '{count} pages with routing and navigation',
      },
      verify: {
        title: 'Verify & accessibility',
        description: 'axe-core audit, Playwright checks, and user review',
      },
    },
  },
  design: {
    title: 'Design',
    description: 'Typography, palette, motion, and background treatments',
    typography: 'Typography',
    palette: 'Color palette',
    motion: 'Motion & animation',
    backgrounds: 'Background treatment',
    primaryRole: 'Primary — body & UI',
    secondaryRole: 'Secondary — headings',
  },
  pages: {
    title: 'Pages & Components',
    description: 'Pages to build, their content outline, and the shared components they rely on',
    pages: 'Pages',
    components: 'Shared components',
    routing: 'Routing',
    path: 'Path',
    page: 'Page',
    content: 'Content',
    componentsUsed: 'Components used',
    usedBy: 'Used by',
    noComponents: 'No shared components planned yet.',
  },
  deployment: {
    title: 'Deployment & Review',
    description: 'Verification checklist and deployment options',
    verify: 'Before handoff — verify',
    agentChecks: 'Agent verification',
    agentChecksDescription: 'The agent will run and report these checks before handoff.',
    makerReview: 'Maker review',
    makerReviewDescription: 'Review these judgment-based items in the live preview.',
    options: 'Deployment options',
    recommended: 'Recommended',
  },
  common: { noneSpecified: 'None specified.' },
  footer: { aiWarning: 'AI-generated content may be incorrect' },
};

const SAMPLE_DATA = {
  SITE_NAME: 'Contoso Portal',
  PLAN_TITLE: 'Implementation Plan',
  FRAMEWORK: 'React',
  SITE_LANGUAGE: 'English (United States)',
  SITE_LOCALE: 'en-US',
  SITE_DIRECTION: 'ltr',
  AESTHETIC: 'Minimal & Clean',
  MOOD: 'Professional & Trustworthy',
  SUMMARY: 'An internal portal for Contoso consultants with directory, announcements, and docs.',
  PLAN_LABELS: ENGLISH_LABELS,
  TYPOGRAPHY_DATA: {
    primary: { name: 'DM Sans', sample: 'Aa Bb Cc', reason: 'Neutral sans for body and UI' },
    secondary: { name: 'Space Grotesk', sample: 'Headings', reason: 'Geometric display for headings' },
  },
  PALETTE_DATA: [
    { var: '--color-primary', hex: '#1E3A5F', description: 'Primary brand' },
    { var: '--color-secondary', hex: '#4A90A4', description: 'Accent' },
    { var: '--color-bg', hex: '#F7F8FA', description: 'Background' },
  ],
  MOTION_DATA: [
    { label: 'Page transitions', description: 'Fade-in 300ms on route change' },
  ],
  BACKGROUNDS_DATA: [
    { label: 'Hero section', description: 'Gradient overlay on Unsplash photo' },
  ],
  PAGES_DATA: [
    {
      name: 'Home',
      route: '/',
      description: 'Landing page for the portal',
      content: ['Hero section', 'Quick links', 'Recent announcements'],
      components: ['Navbar', 'Hero', 'QuickLinks'],
    },
    {
      name: 'Directory',
      route: '/directory',
      description: 'Searchable consultant directory',
      content: ['Search bar', 'Consultant cards'],
      components: ['Navbar', 'ConsultantCard'],
    },
  ],
  COMPONENTS_DATA: [
    { name: 'Navbar', purpose: 'Top navigation', usedBy: ['Home', 'Directory'] },
    { name: 'Hero', purpose: 'Landing hero section', usedBy: ['Home'] },
  ],
  ROUTES_DATA: [
    { path: '/', page: 'Home' },
    { path: '/directory', page: 'Directory' },
  ],
  REVIEW_DATA: {
    agentChecks: [
      'All pages load without console errors',
      'Logical CSS and mixed-direction boundaries pass the bidirectional-readiness audit',
    ],
    makerReview: [
      'Language and terminology are appropriate',
      'Visual hierarchy feels natural in both directions',
    ],
  },
  DEPLOYMENT_DATA: [
    { title: 'Deploy now to Power Pages', description: 'Runs /deploy-site to publish.', recommended: true },
    { title: 'Skip for now', description: 'Continue locally, deploy later.' },
  ],
};

test('render-createsite-plan renders HTML from --data file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'createsite-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'plan.html');

  fs.writeFileSync(dataPath, JSON.stringify(SAMPLE_DATA, null, 2), 'utf8');

  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(fs.existsSync(outputPath));

  const html = fs.readFileSync(outputPath, 'utf8');
  assert.match(html, /Contoso Portal/);
  assert.match(html, /Implementation Plan/);
  assert.match(html, /React/);
  assert.match(html, /English \(United States\)<\/span> <bdi dir="ltr">\(en-US, ltr\)<\/bdi>/);
  assert.match(html, /Minimal &amp; Clean|Minimal & Clean/);
  assert.match(html, /DM Sans/);
  assert.match(html, /#1E3A5F/);
  assert.match(html, /Directory/);
  assert.match(html, /Navbar/);
  assert.match(html, /"agentChecks":\["All pages load without console errors"/);
  assert.match(html, /"makerReview":\["Language and terminology are appropriate"/);
  assert.match(html, /Agent verification/);
  assert.match(html, /Maker review/);
  assert.match(html, /Deploy now to Power Pages/);
  assert.ok(
    html.indexOf('data-label="footer.aiWarning"') < html.indexOf('<script id="typographyData"'),
    'localized footer must exist before the script applies data-label text'
  );
  assert.match(html, /<img class="logo" src="\.\/power-pages-icon\.png" alt="Power Pages" \/>/);

  const iconPath = path.join(tempDir, 'power-pages-icon.png');
  const sourceIcon = path.join(
    __dirname, '..', '..', 'skills', 'create-site', 'assets', 'shared', 'power-pages-icon.png'
  );
  assert.deepEqual(fs.readFileSync(iconPath), fs.readFileSync(sourceIcon), 'icon bytes should match shared asset');
});

test('render-createsite-plan renders HTML from --data-inline JSON', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'createsite-plan-'));
  const outputPath = path.join(tempDir, 'plan-inline.html');

  const result = spawnSync(
    process.execPath,
    [scriptPath, '--output', outputPath, '--data-inline', JSON.stringify(SAMPLE_DATA)],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(fs.existsSync(outputPath));

  const html = fs.readFileSync(outputPath, 'utf8');
  assert.match(html, /Contoso Portal/);
  assert.match(html, /Space Grotesk/);
});

test('render-createsite-plan renders localized LTR labels and locale metadata', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'createsite-plan-'));
  const outputPath = path.join(tempDir, 'plan-es.html');
  const spanish = {
    ...SAMPLE_DATA,
    PLAN_TITLE: 'Plan de implementación',
    SITE_LANGUAGE: 'Español (España)',
    SITE_LOCALE: 'es-ES',
    PLAN_LABELS: {
      ...ENGLISH_LABELS,
      navigation: {
        group: 'Plan',
        overview: 'Resumen',
        design: 'Diseño',
        pages: 'Páginas y componentes',
        deployment: 'Implementación y revisión',
      },
      overview: {
        ...ENGLISH_LABELS.overview,
        title: 'Resumen',
        description: 'Plan de implementación para {siteName}',
      },
      deployment: {
        ...ENGLISH_LABELS.deployment,
        agentChecks: 'Verificación del agente',
        agentChecksDescription: 'El agente ejecutará e informará estas comprobaciones.',
        makerReview: 'Revisión del creador',
        makerReviewDescription: 'Revise estos elementos de criterio en la vista previa.',
      },
      footer: { aiWarning: 'El contenido generado por IA puede ser incorrecto' },
    },
    SUMMARY: 'Un portal interno para consultores de Contoso.',
    REVIEW_DATA: {
      agentChecks: ['La dirección del documento coincide con la configuración regional'],
      makerReview: ['La jerarquía visual resulta natural'],
    },
  };

  const result = spawnSync(
    process.execPath,
    [scriptPath, '--output', outputPath, '--data-inline', JSON.stringify(spanish)],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const html = fs.readFileSync(outputPath, 'utf8');
  assert.match(html, /<html lang="es-ES" dir="ltr">/);
  assert.match(html, /Plan de implementación/);
  assert.match(html, /"overview":"Resumen"/);
  assert.match(html, /Plan de implementación para \{siteName\}/);
  assert.match(html, /Un portal interno para consultores de Contoso/);
  assert.match(html, /"agentChecks":"Verificación del agente"/);
  assert.match(html, /"makerReview":"Revisión del creador"/);
  assert.match(html, /La dirección del documento coincide/);
  assert.match(html, /La jerarquía visual resulta natural/);
  assert.match(html, /React/);
  assert.match(html, /--color-primary/);
  assert.match(html, /"route":"\/directory"/);
  assert.match(html, /<bdi class="pill pill-framework" dir="ltr">React<\/bdi>/);
});

test('render-createsite-plan renders RTL metadata and direction-safe layout', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'createsite-plan-'));
  const outputPath = path.join(tempDir, 'plan-ar.html');
  const arabic = {
    ...SAMPLE_DATA,
    PLAN_TITLE: 'خطة التنفيذ',
    SITE_LANGUAGE: 'العربية (المملكة العربية السعودية)',
    SITE_LOCALE: 'ar-SA',
    SITE_DIRECTION: 'rtl',
    PLAN_LABELS: {
      ...ENGLISH_LABELS,
      navigation: {
        group: 'الخطة',
        overview: 'نظرة عامة',
        design: 'التصميم',
        pages: 'الصفحات والمكونات',
        deployment: 'النشر والمراجعة',
      },
      overview: {
        ...ENGLISH_LABELS.overview,
        title: 'نظرة عامة',
        description: 'خطة التنفيذ لـ {siteName}',
      },
      deployment: {
        ...ENGLISH_LABELS.deployment,
        agentChecks: 'تحقق الوكيل',
        agentChecksDescription: 'سيقوم الوكيل بتنفيذ هذه الفحوصات والإبلاغ عنها.',
        makerReview: 'مراجعة المنشئ',
        makerReviewDescription: 'راجع عناصر الحكم هذه في المعاينة المباشرة.',
      },
      footer: { aiWarning: 'قد يكون المحتوى الذي تم إنشاؤه بواسطة الذكاء الاصطناعي غير صحيح' },
    },
    REVIEW_DATA: {
      agentChecks: ['يتطابق اتجاه المستند مع الإعدادات المحلية'],
      makerReview: ['يبدو التسلسل الهرمي المرئي طبيعياً'],
    },
  };

  const result = spawnSync(
    process.execPath,
    [scriptPath, '--output', outputPath, '--data-inline', JSON.stringify(arabic)],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const html = fs.readFileSync(outputPath, 'utf8');
  assert.match(html, /<html lang="ar-SA" dir="rtl">/);
  assert.match(html, /"overview":"نظرة عامة"/);
  assert.match(html, /"agentChecks":"تحقق الوكيل"/);
  assert.match(html, /"makerReview":"مراجعة المنشئ"/);
  assert.match(html, /border-inline-start/);
  assert.match(html, /border-inline-end/);
  assert.match(html, /padding-inline-start/);
  assert.match(html, /inset-inline-end/);
  assert.doesNotMatch(
    html,
    /(?:border|padding|margin)-(?:left|right)|text-align:\s*(?:left|right)|(?:^|[;{])(?:left|right):/m
  );
  assert.match(html, /\.page-route,[^{]+\{direction:ltr;unicode-bidi:isolate;\}/);
  assert.match(html, /id="agentChecksContainer"/);
  assert.match(html, /id="makerReviewContainer"/);
});

test('render-createsite-plan escapes string placeholders used in HTML text contexts', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'createsite-plan-'));
  const outputPath = path.join(tempDir, 'plan-strings.html');
  const unsafe = {
    ...SAMPLE_DATA,
    SITE_NAME: 'Contoso </title><script>window.__titlePwned=1</script>',
    PLAN_TITLE: 'Plan <b>bold</b>',
    FRAMEWORK: 'React <script>window.__frameworkPwned=1</script>',
    AESTHETIC: 'Minimal & Clean <img src=x>',
    MOOD: 'Professional > Casual',
  };

  const result = spawnSync(
    process.execPath,
    [scriptPath, '--output', outputPath, '--data-inline', JSON.stringify(unsafe)],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const html = fs.readFileSync(outputPath, 'utf8');
  assert.doesNotMatch(html, /<script>window\.__titlePwned=1<\/script>/);
  assert.doesNotMatch(html, /<script>window\.__frameworkPwned=1<\/script>/);
  assert.match(html, /Contoso &lt;\/title&gt;&lt;script&gt;window\.__titlePwned=1&lt;\/script&gt;/);
  assert.match(html, /Plan &lt;b&gt;bold&lt;\/b&gt;/);
  assert.match(html, /Minimal &amp; Clean &lt;img src=x&gt;/);
  assert.match(html, /Professional &gt; Casual/);
});

test('render-createsite-plan fails with no arguments', () => {
  const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:/);
});

test('render-createsite-plan fails with invalid --data-inline JSON', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'createsite-plan-'));
  const outputPath = path.join(tempDir, 'plan.html');

  const result = spawnSync(
    process.execPath,
    [scriptPath, '--output', outputPath, '--data-inline', '{bad json}'],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /not valid JSON/);
});

test('render-createsite-plan fails with invalid --data file JSON', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'createsite-plan-'));
  const dataPath = path.join(tempDir, 'bad-data.json');
  const outputPath = path.join(tempDir, 'plan.html');

  fs.writeFileSync(dataPath, '{bad json}', 'utf8');

  const result = spawnSync(
    process.execPath,
    [scriptPath, '--output', outputPath, '--data', dataPath],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--data file is not valid JSON/);
  assert.equal(fs.existsSync(outputPath), false);
});

test('render-createsite-plan fails when required keys are missing', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'createsite-plan-'));
  const outputPath = path.join(tempDir, 'plan.html');

  const incomplete = { ...SAMPLE_DATA };
  delete incomplete.PAGES_DATA;
  delete incomplete.ROUTES_DATA;

  const result = spawnSync(
    process.execPath,
    [scriptPath, '--output', outputPath, '--data-inline', JSON.stringify(incomplete)],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing required keys/);
  assert.match(result.stderr, /PAGES_DATA/);
  assert.match(result.stderr, /ROUTES_DATA/);
});

test('render-createsite-plan escapes </script> and < inside JSON data to prevent HTML injection', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'createsite-plan-'));
  const outputPath = path.join(tempDir, 'plan-xss.html');

  const malicious = {
    ...SAMPLE_DATA,
    SUMMARY: 'Summary with </script><script>window.__summaryPwned=1;</script> and <strong>markup</strong>.',
    PLAN_LABELS: {
      ...ENGLISH_LABELS,
      navigation: {
        ...ENGLISH_LABELS.navigation,
        overview: '</script><script>window.__labelPwned=1;</script>',
      },
      deployment: {
        ...ENGLISH_LABELS.deployment,
        recommended: '" onmouseover="window.__attributePwned=1',
      },
    },
    PAGES_DATA: [
      {
        name: '</script><script>window.__pwned=1;</script>',
        route: '/evil',
        description: '<img src=x onerror=alert(1)>',
        content: ['line with </script> closing tag'],
        components: ['OK'],
      },
    ],
    REVIEW_DATA: {
      agentChecks: ['</script><script>window.__reviewPwned=1;</script>'],
      makerReview: ['" onmouseover="window.__makerPwned=1'],
    },
  };

  const result = spawnSync(
    process.execPath,
    [scriptPath, '--output', outputPath, '--data-inline', JSON.stringify(malicious)],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const html = fs.readFileSync(outputPath, 'utf8');
  // Raw </script> must NOT appear inside any JSON data blob — it would close the script tag.
  // The escaped form </script> is safe: JSON.parse decodes it back to the original string at runtime.
  assert.ok(
    !/<\/script>[^<]*window\.__pwned/i.test(html),
    'rendered HTML leaks a literal </script> inside injected data'
  );
  assert.ok(
    !html.includes('</script><script>window.__summaryPwned=1;</script>'),
    'rendered HTML leaks a literal </script> from SUMMARY'
  );
  assert.ok(
    !html.includes('</script><script>window.__labelPwned=1;</script>'),
    'rendered HTML leaks a literal </script> from PLAN_LABELS'
  );
  assert.ok(
    !html.includes('</script><script>window.__reviewPwned=1;</script>'),
    'rendered HTML leaks a literal </script> from REVIEW_DATA'
  );
  assert.doesNotMatch(html, /data-recommended-label="[^"]*onmouseover=/);
  assert.match(html, /"text":"Summary with \\u003c\/script>\\u003cscript>window\.__summaryPwned=1;\\u003c\/script>/);
  assert.match(html, /\\u003c\/script>/);
});

test('render-createsite-plan rejects missing localized labels', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'createsite-plan-'));
  const outputPath = path.join(tempDir, 'plan.html');
  const incomplete = {
    ...SAMPLE_DATA,
    PLAN_LABELS: {
      ...ENGLISH_LABELS,
      footer: {},
    },
  };

  const result = spawnSync(
    process.execPath,
    [scriptPath, '--output', outputPath, '--data-inline', JSON.stringify(incomplete)],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /PLAN_LABELS is missing localized values/);
  assert.match(result.stderr, /footer\.aiWarning/);
  assert.equal(fs.existsSync(outputPath), false);
});

test('render-createsite-plan rejects the legacy flat review checklist', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'createsite-plan-'));
  const outputPath = path.join(tempDir, 'plan.html');
  const legacy = {
    ...SAMPLE_DATA,
    REVIEW_DATA: ['All pages load without console errors'],
  };

  const result = spawnSync(
    process.execPath,
    [scriptPath, '--output', outputPath, '--data-inline', JSON.stringify(legacy)],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /REVIEW_DATA must be an object with agentChecks and makerReview arrays/);
  assert.equal(fs.existsSync(outputPath), false);
});

test('render-createsite-plan requires both review responsibility groups', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'createsite-plan-'));
  const outputPath = path.join(tempDir, 'plan.html');
  const missingMakerReview = {
    ...SAMPLE_DATA,
    REVIEW_DATA: {
      agentChecks: ['Automated checks pass'],
      makerReview: [],
    },
  };

  const result = spawnSync(
    process.execPath,
    [scriptPath, '--output', outputPath, '--data-inline', JSON.stringify(missingMakerReview)],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires non-empty string arrays: makerReview/);
  assert.equal(fs.existsSync(outputPath), false);
});

test('render-createsite-plan rejects locale and direction mismatches', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'createsite-plan-'));
  const outputPath = path.join(tempDir, 'plan.html');
  const mismatched = { ...SAMPLE_DATA, SITE_LOCALE: 'ar-SA', SITE_DIRECTION: 'ltr' };

  const result = spawnSync(
    process.execPath,
    [scriptPath, '--output', outputPath, '--data-inline', JSON.stringify(mismatched)],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match ar-SA/);
  assert.equal(fs.existsSync(outputPath), false);
});

test('render-createsite-plan rejects non-canonical locale tags', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'createsite-plan-'));
  const outputPath = path.join(tempDir, 'plan.html');
  const nonCanonical = { ...SAMPLE_DATA, SITE_LOCALE: 'EN-us' };

  const result = spawnSync(
    process.execPath,
    [scriptPath, '--output', outputPath, '--data-inline', JSON.stringify(nonCanonical)],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Use "en-US" instead/);
  assert.equal(fs.existsSync(outputPath), false);
});

test('render-createsite-plan rejects translated labels that drop renderer tokens', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'createsite-plan-'));
  const outputPath = path.join(tempDir, 'plan.html');
  const missingToken = {
    ...SAMPLE_DATA,
    PLAN_LABELS: {
      ...ENGLISH_LABELS,
      overview: {
        ...ENGLISH_LABELS.overview,
        description: 'Implementation plan',
      },
    },
  };

  const result = spawnSync(
    process.execPath,
    [scriptPath, '--output', outputPath, '--data-inline', JSON.stringify(missingToken)],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must preserve renderer tokens/);
  assert.match(result.stderr, /overview\.description \(\{siteName\}\)/);
  assert.equal(fs.existsSync(outputPath), false);
});

test('render-createsite-plan refuses to overwrite existing file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'createsite-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'plan.html');

  fs.writeFileSync(dataPath, JSON.stringify(SAMPLE_DATA, null, 2), 'utf8');

  const result1 = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });
  assert.equal(result1.status, 0, result1.stderr || result1.stdout);

  const original = fs.readFileSync(outputPath, 'utf8');

  const result2 = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });
  assert.equal(result2.status, 1);
  assert.match(result2.stderr, /Output file already exists/);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), original);
});
