const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'render-customize-declarative-site-plan.js');

const SAMPLE_PLAN = {
  schemaVersion: 1,
  site: {
    name: 'Contoso Event Portal',
    websiteRecordId: '00000000-0000-0000-0000-000000000001',
    templateName: 'EventPortal',
    siteRoot: '.powerpages-site',
    languages: ['en-US'],
  },
  summary: 'Adapt the Event Portal for a developer conference.',
  preservation: 'Retain the template structure while adding pages and sections.',
  aesthetic: 'Bold & Vibrant',
  mood: 'Technical & Precise',
  capabilities: [
    {
      name: 'Webpage authoring',
      status: 'ready',
      evidence: ['web-pages/'],
      ownerSkill: 'author-webpage',
      note: 'Page records are available.',
    },
  ],
  operations: [
    {
      id: 'add-speaker-images',
      skill: 'author-web-file',
      action: 'import',
      summary: 'Add the approved speaker images.',
      target: { parentPage: 'Home' },
      locales: [],
      inputs: { sourcePaths: ['assets/speaker-1.jpg'] },
      dependsOn: [],
      resolvedDependencies: {},
      preserve: [],
      expectedOutputs: ['web-file metadata', 'public asset URL'],
    },
    {
      id: 'create-speakers-page',
      skill: 'author-webpage',
      action: 'create',
      summary: 'Create the Speakers page and navigation link.',
      target: { name: 'Speakers', route: '/speakers' },
      locales: ['en-US'],
      inputs: { navigation: 'Primary Navigation' },
      dependsOn: ['add-speaker-images'],
      resolvedDependencies: {},
      preserve: [],
      expectedOutputs: ['root webpage', 'localized webpage shell'],
    },
  ],
  warnings: ['The local changes are not live until deployment succeeds.'],
  verification: [
    { label: 'Page relationships', description: 'Verify parent, template, and navigation.' },
  ],
  deployment: [
    {
      title: 'Deploy after verification',
      description: 'Invoke deploy-site after local validation.',
      recommended: true,
    },
  ],
};

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
  assert.match(html, /create-speakers-page/);
  assert.match(html, /author-webpage/);
  assert.match(html, /Page relationships/);

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
