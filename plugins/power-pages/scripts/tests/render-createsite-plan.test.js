const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'render-createsite-plan.js');

const SAMPLE_DATA = {
  SITE_NAME: 'Contoso Portal',
  PLAN_TITLE: 'Implementation Plan',
  FRAMEWORK: 'React',
  AESTHETIC: 'Minimal & Clean',
  MOOD: 'Professional & Trustworthy',
  SUMMARY: 'An internal portal for Contoso consultants with directory, announcements, and docs.',
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
  REVIEW_DATA: [
    'All pages load without console errors',
    'Navigation links work and highlight the active page',
  ],
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
  assert.match(html, /Minimal &amp; Clean|Minimal & Clean/);
  assert.match(html, /DM Sans/);
  assert.match(html, /#1E3A5F/);
  assert.match(html, /Directory/);
  assert.match(html, /Navbar/);
  assert.match(html, /Deploy now to Power Pages/);
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
    PAGES_DATA: [
      {
        name: '</script><script>window.__pwned=1;</script>',
        route: '/evil',
        description: '<img src=x onerror=alert(1)>',
        content: ['line with </script> closing tag'],
        components: ['OK'],
      },
    ],
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
  assert.match(html, /"text":"Summary with \\u003c\/script>\\u003cscript>window\.__summaryPwned=1;\\u003c\/script>/);
  assert.match(html, /\\u003c\/script>/);
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
