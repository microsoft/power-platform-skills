const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { renderReviewedPlan } = require('../render-customize-declarative-site-plan');
const { externalImagePlan, renderDocument, successfulImageCheck } = require('./customization-plan-test-helpers');

const scriptPath = path.join(__dirname, '..', 'render-customize-declarative-site-plan.js');
const fixturePath = path.join(
  __dirname,
  'fixtures',
  'customize-declarative-site-plan.json'
);
const SAMPLE_PLAN = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

function writePlan(tempDir, plan = SAMPLE_PLAN) {
  const dataPath = path.join(tempDir, 'plan.json');
  fs.writeFileSync(dataPath, JSON.stringify(plan, null, 2), 'utf8');
  return dataPath;
}

test('renders a declarative customization plan and copies the shared icon', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'declarative-plan-'));
  const dataPath = writePlan(tempDir);
  const outputPath = path.join(tempDir, 'plan.html');
  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const html = fs.readFileSync(outputPath, 'utf8');
  assert.match(html, /Contoso Event Portal/);
  assert.match(html, /EventPortal/);
  assert.match(html, /Pages &amp; navigation/);
  assert.match(html, /Content &amp; components/);
  assert.match(html, /Visual assets/);
  assert.match(html, /Create the Speakers page and navigation link/);
  assert.match(html, /\/speakers/);
  assert.match(html, /Primary Navigation/);
  assert.match(html, /Conference speaker portrait/);
  assert.match(html, /Example Photographer/);
  assert.match(html, /Conference speaker presenting to an audience/);
  assert.match(html, /Retain the template structure while adding pages and sections/);
  assert.match(html, /Page relationships/);
  assert.match(html, /Approval authorizes local customization only/);
  assert.doesNotMatch(html, /Technical implementation trace|technicalDetails|technicalOperations/);

  const iconPath = path.join(tempDir, 'power-pages-icon.png');
  const sourceIcon = path.join(
    __dirname, '..', '..', 'skills', 'create-site', 'assets', 'shared', 'power-pages-icon.png'
  );
  assert.deepEqual(fs.readFileSync(iconPath), fs.readFileSync(sourceIcon));
});

test('rejects missing required plan keys', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'declarative-plan-'));
  const incomplete = { ...SAMPLE_PLAN };
  delete incomplete.operations;
  const dataPath = writePlan(tempDir, incomplete);
  const outputPath = path.join(tempDir, 'plan.html');
  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing required plan keys: operations/);
  assert.equal(fs.existsSync(outputPath), false);
});

test('requires visual assets in schema-version-1 plans', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'declarative-plan-'));
  const missingAssets = structuredClone(SAMPLE_PLAN);
  delete missingAssets.assets;
  const missingData = writePlan(tempDir, missingAssets);
  const missingOutput = path.join(tempDir, 'missing-assets.html');
  const rejected = spawnSync(
    process.execPath,
    [scriptPath, '--output', missingOutput, '--data', missingData],
    { encoding: 'utf8' }
  );
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Missing required plan keys: assets/);
});

test('rejects unsafe or incomplete visual asset records', () => {
  const cases = [
    [
      'unapproved Unsplash host',
      (plan) => {
        plan.assets[0].source.downloadUrl = 'https://images.unsplash.com.example.test/photo.jpg';
      },
      /approved Unsplash HTTPS hosts/,
    ],
    [
      'credentialed Unsplash URL',
      (plan) => {
        plan.assets[0].source.downloadUrl =
          'https://user:secret@images.unsplash.com/photo.jpg';
      },
      /without credentials or custom ports/,
    ],
    [
      'missing localized alt text',
      (plan) => {
        plan.assets[0].accessibility.altByLocale = {};
      },
      /missing alt text for locale en-US/,
    ],
    [
      'wrong operation owner',
      (plan) => {
        plan.assets[0].webFileOperationId = 'create-speakers-page';
      },
      /must reference an author-web-file operation/,
    ],
    [
      'unbound cache path',
      (plan) => {
        plan.assets[0].preparation.cachePath =
          '.powerpages-customization/assets/other-speaker.jpg';
      },
      /cachePath must be an input/,
    ],
    [
      'unconsumed public URL',
      (plan) => {
        plan.operations[1].outputBindings = {};
      },
      /publicUrl must be consumed through an approved output binding/,
    ],
    [
      'protocol-relative existing URL',
      (plan) => {
        plan.assets[0].source = { type: 'existing-site' };
        plan.assets[0].preparation = { status: 'existing' };
        plan.assets[0].existingPublicUrl = '//example.test/photo.jpg';
        delete plan.assets[0].webFileOperationId;
      },
      /must be site-root-relative/,
    ],
    [
      'agent-authored raster image',
      (plan) => {
        plan.assets[0].source = { type: 'agent-authored' };
      },
      /agent-authored assets must be SVG/,
    ],
  ];

  for (const [name, mutate, expected] of cases) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'declarative-plan-'));
    const plan = structuredClone(SAMPLE_PLAN);
    mutate(plan);
    const dataPath = writePlan(tempDir, plan);
    const outputPath = path.join(tempDir, 'plan.html');
    const result = spawnSync(
      process.execPath,
      [scriptPath, '--output', outputPath, '--data', dataPath],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, expected, name);
  }
});

test('rejects duplicate operation identifiers', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'declarative-plan-'));
  const duplicate = {
    ...SAMPLE_PLAN,
    operations: [SAMPLE_PLAN.operations[0], { ...SAMPLE_PLAN.operations[0] }],
  };
  const dataPath = writePlan(tempDir, duplicate);
  const outputPath = path.join(tempDir, 'plan.html');
  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /duplicate operation id add-speaker-images/);
});

test('rejects unsupported skills and dependencies that are not ordered', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'declarative-plan-'));
  const unsupported = {
    ...SAMPLE_PLAN,
    operations: [
      {
        ...SAMPLE_PLAN.operations[0],
        skill: 'invent-portal-metadata',
      },
    ],
  };
  const unsupportedPath = writePlan(tempDir, unsupported);
  const unsupportedOutput = path.join(tempDir, 'unsupported.html');
  const unsupportedResult = spawnSync(
    process.execPath,
    [scriptPath, '--output', unsupportedOutput, '--data', unsupportedPath],
    { encoding: 'utf8' }
  );
  assert.equal(unsupportedResult.status, 1);
  assert.match(unsupportedResult.stderr, /unsupported operation skill invent-portal-metadata/);

  const unordered = {
    ...SAMPLE_PLAN,
    operations: [
      {
        ...SAMPLE_PLAN.operations[1],
        dependsOn: ['add-speaker-images'],
      },
      SAMPLE_PLAN.operations[0],
    ],
  };
  const unorderedPath = path.join(tempDir, 'unordered.json');
  fs.writeFileSync(unorderedPath, JSON.stringify(unordered, null, 2), 'utf8');
  const unorderedOutput = path.join(tempDir, 'unordered.html');
  const unorderedResult = spawnSync(
    process.execPath,
    [scriptPath, '--output', unorderedOutput, '--data', unorderedPath],
    { encoding: 'utf8' }
  );
  assert.equal(unorderedResult.status, 1);
  assert.match(unorderedResult.stderr, /depends on add-speaker-images, which must appear earlier/);
});

test('rejects output bindings that do not reference declared dependencies', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'declarative-plan-'));
  const invalid = structuredClone(SAMPLE_PLAN);
  invalid.operations[1].dependsOn = [];
  const dataPath = writePlan(tempDir, invalid);
  const outputPath = path.join(tempDir, 'invalid-binding.html');
  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /output binding heroImageUrl must reference an operation in dependsOn/);
});

test('rejects deployment model fields and undeclared bound outputs', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'declarative-plan-'));
  const withModel = structuredClone(SAMPLE_PLAN);
  withModel.site.modelVersion = 'Enhanced';
  let dataPath = writePlan(tempDir, withModel);
  let result = spawnSync(
    process.execPath,
    [scriptPath, '--output', path.join(tempDir, 'invalid-model.html'), '--data', dataPath],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /deployment-only/);

  const withUndeclaredOutput = structuredClone(SAMPLE_PLAN);
  withUndeclaredOutput.operations[1].outputBindings.heroImageUrl.output = 'missingUrl';
  dataPath = path.join(tempDir, 'undeclared-output.json');
  fs.writeFileSync(dataPath, JSON.stringify(withUndeclaredOutput), 'utf8');
  result = spawnSync(
    process.execPath,
    [scriptPath, '--output', path.join(tempDir, 'invalid-output.html'), '--data', dataPath],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /references undeclared output missingUrl/);
});

test('escapes embedded JSON and text placeholders', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'declarative-plan-'));
  const unsafe = {
    ...SAMPLE_PLAN,
    site: {
      ...SAMPLE_PLAN.site,
      name: 'Portal </title><script>window.__titlePwned=1</script>',
    },
    summary: '</script><script>window.__summaryPwned=1</script>',
  };
  const dataPath = writePlan(tempDir, unsafe);
  const outputPath = path.join(tempDir, 'plan.html');
  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const html = fs.readFileSync(outputPath, 'utf8');
  assert.doesNotMatch(html, /<script>window\.__titlePwned=1<\/script>/);
  assert.ok(!html.includes('</script><script>window.__summaryPwned=1</script>'));
  assert.match(html, /\\u003c\/script\\u003e/);
});

test('refuses to overwrite an existing plan', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'declarative-plan-'));
  const dataPath = writePlan(tempDir);
  const outputPath = path.join(tempDir, 'plan.html');

  const first = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });
  const second = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });

  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /Output file already exists/);
});

test('a failed external image cannot create review HTML or a successful check report', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'failed-image-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'plan.html');
  await assert.rejects(renderReviewedPlan(externalImagePlan(), output, {
    check: async () => { throw new Error('Image URL returned HTTP 404.'); },
  }), /HTTP 404/);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('review rendering records and displays image checks without changing image delivery', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checked-image-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plan = externalImagePlan();
  const output = path.join(root, 'plan.html');
  let calls = 0;
  const result = await renderReviewedPlan(plan, output, {
    check: async (url) => { calls++; return successfulImageCheck(url); },
  });
  assert.equal(calls, 1);
  assert.equal(result.imageChecks, `${output}.image-checks.json`);
  const report = JSON.parse(fs.readFileSync(result.imageChecks, 'utf8'));
  const document = renderDocument(fs.readFileSync(output, 'utf8'));
  assert.match(document.get('imageVerification').innerHTML, /Image source checks passed before review/);
  assert.match(document.get('imageVerification').innerHTML, /2026-01-01T00:00:00.000Z/);
  assert.equal(report.images[0].url, plan.assets[0].externalUrl);
  assert.equal(result.verifiedImages, 1);
  assert.deepEqual(fs.readdirSync(root).sort(), ['plan.html', 'plan.html.image-checks.json', 'power-pages-icon.png']);
  await assert.rejects(renderReviewedPlan(plan, output, {
    check: () => assert.fail('Existing artifacts must fail before repeating network checks.'),
  }), /already exists/);
});

test('the CLI enforces public-image verification before rendering external sources', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-review-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plan = externalImagePlan(['https://127.0.0.1/image.png']);
  const data = writePlan(root, plan);
  const output = path.join(root, 'plan.html');
  const result = spawnSync(process.execPath, [scriptPath, '--output', output, '--data', data], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /public Internet addresses/);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(`${output}.image-checks.json`), false);
});
