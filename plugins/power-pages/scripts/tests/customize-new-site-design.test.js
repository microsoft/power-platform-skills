const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { validateCustomizationPlan, planHash } = require('../lib/customize-declarative-site-plan');
const { renderCustomizationPlan } = require('../render-customize-declarative-site-plan');
const { publishApprovedPlan } = require('../promote-customize-declarative-site-plan');
const { updateExecution } = require('../update-customize-declarative-site-execution');

function newSitePlan() {
  const plan = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'customize-declarative-site-plan.json'), 'utf8'
  ));
  plan.site.templateName = 'StarterLayout1';
  plan.newSiteDesign = {
    bootstrapMajor: 5,
    typography: 'Approved serif headings and readable sans-serif body with a clear type scale.',
    palette: 'Ivory surfaces, navy text, teal actions; resolve foreground/surface contrast.',
    spacing: '8px rhythm with generous section separation.',
    composition: 'Image-and-copy hero, speaker portraits, agenda, final registration action.',
    responsive: 'Stack native columns and preserve portrait focal points on narrow screens.',
    imagery: 'required',
  };
  plan.operations.push({
    id: 'style-new-site',
    skill: 'style-site',
    action: 'style',
    target: { scope: 'site' },
    locales: plan.site.languages,
    inputs: { scope: 'site', details: 'Apply the approved new-site design direction.' },
    dependsOn: [plan.operations.at(-1).id],
    outputBindings: {},
    preserve: ['Bootstrap, protected defaults, native wrappers, navigation and authentication.'],
    expectedOutputs: ['receiptPath'],
  });
  return plan;
}

function externalImagePlan() {
  const plan = newSitePlan();
  plan.newSiteDesign.imageDelivery = 'external-url';
  const asset = plan.assets[0];
  asset.delivery = 'external-url';
  asset.externalUrl = asset.source.downloadUrl;
  delete asset.source.downloadUrl;
  delete asset.webFileOperationId;
  asset.preparation = { status: 'remote' };
  plan.operations.shift();
  const page = plan.operations[0];
  page.dependsOn = [];
  page.outputBindings = {};
  page.inputs.heroImageUrl = asset.externalUrl;
  return plan;
}

function setImageUrl(plan, value) {
  plan.assets[0].externalUrl = value;
  plan.operations[0].inputs.heroImageUrl = value;
}

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'new-site-design-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function renderDocument(html) {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)]
    .map((match) => [match[1], { innerHTML: '', textContent: '' }]));
  for (const match of html.matchAll(/<script id="([^"]+)" type="application\/json">([\s\S]*?)<\/script>/g)) {
    elements.get(match[1]).textContent = match[2];
  }
  const document = {
    getElementById: (id) => elements.get(id),
    querySelectorAll: () => [],
    createElement: () => ({
      set textContent(value) {
        this.innerHTML = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      },
    }),
  };
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    vm.runInNewContext(script[1], { document });
  }
  return elements;
}

test('new-site design accepts meaningful imagery and transitive styling dependencies', () => {
  const plan = newSitePlan();
  assert.equal(validateCustomizationPlan(plan), plan);
  const hash = planHash(plan);
  plan.newSiteDesign.palette = 'Warm white and charcoal with amber actions.';
  assert.notEqual(planHash(plan), hash);
});

test('new creation uses Unsplash or supplied CDN URLs without staging or Web File operations', () => {
  for (const provider of ['unsplash', 'user-provided']) {
    const plan = externalImagePlan();
    if (provider === 'user-provided') {
      plan.assets[0].source = { type: provider, license: 'User-owned CDN image approved for the site.' };
      setImageUrl(plan, 'https://cdn.example.com/media/team?width=1200&format=webp');
    }
    assert.equal(validateCustomizationPlan(plan), plan);
    assert.ok(plan.operations.every((operation) => operation.skill !== 'author-web-file'));
    assert.deepEqual(plan.assets[0].preparation, { status: 'remote' });
    assert.deepEqual(plan.operations[0].outputBindings, {});
  }
});

test('URL image delivery rejects unsafe addresses and mixed or unresolved asset contracts', () => {
  const cases = [
    ...[
      'http://cdn.example.com/photo.jpg', '//cdn.example.com/photo.jpg',
      'javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///image.png',
      'https://user:password@cdn.example.com/photo.jpg', 'https:\\\\cdn.example.com\\photo.jpg',
      'https://cdn.example.com/\nphoto.jpg', ' https://cdn.example.com/photo.jpg', 'not-a-url',
    ].map((url) => [url, (p) => setImageUrl(p, url), /HTTPS/]),
    ['not a remote asset', (p) => { p.assets[0].preparation.status = 'staged'; }, /status must be remote/],
    ['staged bytes', (p) => { p.assets[0].preparation.cachePath = 'image.jpg'; }, /staged-file metadata/],
    ['invented content hash', (p) => { p.assets[0].preparation.sha256 = 'a'.repeat(64); }, /staged-file metadata/],
    ['Web File dependency', (p) => { p.assets[0].webFileOperationId = 'import-image'; }, /Web File/],
    ['mixed local URL', (p) => { p.assets[0].existingPublicUrl = '/image.jpg'; }, /Web File/],
    ['missing license basis', (p) => { delete p.assets[0].source.license; }, /source.license/],
    ['unhosted generated image', (p) => { p.assets[0].source.type = 'agent-authored'; }, /user-provided or Unsplash image/],
    ['font delivery', (p) => { p.assets[0].kind = 'font'; }, /user-provided or Unsplash image/],
    ['unused image URL', (p) => { delete p.operations[0].inputs.heroImageUrl; }, /exact approved static input/],
    ['incorrect Unsplash host', (p) => { setImageUrl(p, 'https://images.unsplash.com.example.test/photo.jpg'); }, /approved Unsplash HTTPS hosts/],
    ['conflicting Unsplash URL', (p) => { p.assets[0].source.downloadUrl = 'https://images.unsplash.com/other'; }, /must match externalUrl/],
    ['unsupported creation policy', (p) => { p.newSiteDesign.imageDelivery = 'web-file'; }, /imageDelivery must be external-url/],
  ];
  for (const [label, mutate, expected] of cases) {
    const plan = externalImagePlan();
    mutate(plan);
    assert.throws(() => validateCustomizationPlan(plan), expected, label);
  }
  const imported = newSitePlan();
  imported.newSiteDesign.imageDelivery = 'external-url';
  assert.throws(() => validateCustomizationPlan(imported), /not Web File imports/);
  delete imported.newSiteDesign.imageDelivery;
  assert.equal(validateCustomizationPlan(imported), imported, 'previously approved Web File plans remain valid');
});

test('URL-mode creation may reuse existing site images without importing new image files', () => {
  const plan = newSitePlan();
  plan.newSiteDesign.imageDelivery = 'external-url';
  const asset = plan.assets[0];
  asset.source = { type: 'existing-site' };
  asset.preparation = { status: 'existing' };
  asset.existingPublicUrl = '/existing-hero.jpg';
  delete asset.webFileOperationId;
  plan.operations.shift();
  plan.operations[0].dependsOn = [];
  plan.operations[0].outputBindings = {};
  plan.operations[0].inputs.heroImageUrl = asset.existingPublicUrl;
  assert.equal(validateCustomizationPlan(plan), plan);
});

test('external image URLs can be consumed by nested native component inputs', () => {
  const plan = externalImagePlan();
  const url = plan.assets[0].externalUrl;
  delete plan.operations[0].inputs.heroImageUrl;
  plan.operations[0].inputs.sections = [{
    layout: 'one-column',
    columns: [{ elements: [{ type: 'image', source: url, alt: 'Conference speaker.' }] }],
  }];
  assert.equal(validateCustomizationPlan(plan), plan);
});

test('external image review escapes untrusted URL text without creating an image request', (t) => {
  const root = temporaryRoot(t);
  const plan = externalImagePlan();
  plan.assets[0].source = { type: 'user-provided', license: 'User-approved source.' };
  setImageUrl(plan, 'https://cdn.example.com/image?label="><script>alert(1)</script>');
  const output = path.join(root, 'escaped-image-url.html');
  renderCustomizationPlan(plan, output, { emitStatus: false });
  const html = fs.readFileSync(output, 'utf8');
  const card = renderDocument(html).get('assetChanges').innerHTML;
  assert.match(card, /label=&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(card, /<script>|<img\b/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});

test('URL-based creation renders exact delivery details and resolves image inputs without an import', (t) => {
  const root = temporaryRoot(t);
  const plan = externalImagePlan();
  const originalHash = planHash(plan);
  setImageUrl(plan, `${plan.assets[0].externalUrl}&h=800`);
  assert.notEqual(planHash(plan), originalHash);
  const dataPath = path.join(root, 'url-plan.json');
  fs.writeFileSync(dataPath, JSON.stringify(plan), 'utf8');
  publishApprovedPlan({ projectRoot: root, dataPath });
  const htmlPath = path.join(root, 'docs', 'customize-declarative-site', 'current-plan.html');
  const document = renderDocument(fs.readFileSync(htmlPath, 'utf8'));
  const assetCard = document.get('assetChanges').innerHTML;
  assert.match(assetCard, /Direct external HTTPS URL \(not imported\)/);
  assert.match(assetCard, /images\.unsplash\.com\/photo-example\?w=1200&amp;fit=crop&amp;h=800/);
  assert.match(assetCard, /Power Pages permissions do not protect this URL/);
  assert.doesNotMatch(assetCard, /<img\b|Prepared file/);
  assert.match(document.get('newSiteDesign').innerHTML, /no image downloads or Web File imports/);
  const resolved = updateExecution({
    projectRoot: root, action: 'resolve', operationId: 'create-speakers-page',
  });
  assert.equal(resolved.resolvedInputs.heroImageUrl, plan.assets[0].externalUrl);
  assert.equal(resolved.designContext.imageDelivery, 'external-url');
  assert.deepEqual(resolved.operation.dependsOn, []);
  const receipt = updateExecution({ projectRoot: root, action: 'status' });
  assert.deepEqual(receipt.operations.map((operation) => operation.id), ['create-speakers-page', 'style-new-site']);
  assert.equal(fs.existsSync(path.join(root, '.powerpages-customization')), false);
  assert.equal(fs.existsSync(path.join(root, 'web-files')), false);
});

test('existing-site schema-1 plans need neither a new design brief nor added images', () => {
  const plan = newSitePlan();
  delete plan.newSiteDesign;
  plan.assets = [];
  plan.operations = [];
  plan.aesthetic = null;
  plan.mood = null;
  assert.equal(validateCustomizationPlan(plan), plan);
});

test('new-site design rejects incomplete briefs, decorative-only imagery, and early styling', () => {
  const cases = [
    ['null brief', (p) => { p.newSiteDesign = null; }, /newSiteDesign must be an object/],
    ['unknown Bootstrap', (p) => { p.newSiteDesign.bootstrapMajor = 4; }, /verified Bootstrap major/],
    ['string Bootstrap', (p) => { p.newSiteDesign.bootstrapMajor = '5'; }, /verified Bootstrap major/],
    ['implicit legacy choice', (p) => { p.newSiteDesign.bootstrapMajor = 3; }, /compatibilityReason/],
    ['missing type direction', (p) => { delete p.newSiteDesign.typography; }, /typography/],
    ['empty palette', (p) => { p.newSiteDesign.palette = ' '; }, /palette/],
    ['missing spacing', (p) => { delete p.newSiteDesign.spacing; }, /spacing/],
    ['missing composition', (p) => { delete p.newSiteDesign.composition; }, /composition/],
    ['missing responsive plan', (p) => { delete p.newSiteDesign.responsive; }, /responsive/],
    ['missing aesthetic', (p) => { p.aesthetic = null; }, /aesthetic/],
    ['missing mood', (p) => { p.mood = null; }, /mood/],
    ['missing imagery decision', (p) => { delete p.newSiteDesign.imagery; }, /imagery/],
    ['implicit opt-out', (p) => { p.newSiteDesign.imagery = 'user-declined'; }, /imageryReason/],
    ['no images', (p) => { p.assets = []; }, /meaningful content imagery/],
    ['logo only', (p) => { p.assets[0].kind = 'logo'; }, /meaningful content imagery/],
    ['decoration only', (p) => { p.assets[0].accessibility.decorative = true; }, /meaningful content imagery/],
    ['brand image only', (p) => { p.assets[0].role = 'brand'; }, /meaningful content imagery/],
    ['no styling', (p) => { p.operations.pop(); }, /requires a style-site operation/],
    ['styling without dependencies', (p) => { p.operations.at(-1).dependsOn = []; }, /depend on all structural/],
    ['styling before all structure', (p) => {
      p.operations.at(-1).dependsOn = [p.operations[0].id];
    }, /depend on all structural/],
  ];
  for (const [label, mutate, expected] of cases) {
    const plan = newSitePlan();
    mutate(plan);
    assert.throws(() => validateCustomizationPlan(plan), expected, label);
  }
});

test('explicit Bootstrap 3 compatibility and image opt-out remain available', () => {
  const plan = newSitePlan();
  plan.newSiteDesign.bootstrapMajor = 3;
  plan.newSiteDesign.compatibilityReason = 'User explicitly selected Standard compatibility.';
  plan.newSiteDesign.imagery = 'user-declined';
  plan.newSiteDesign.imageryReason = 'User requested a text-only service directory.';
  plan.assets = [];
  assert.equal(validateCustomizationPlan(plan), plan);
});

test('approval HTML safely embeds the complete brief and keeps existing-site plans optional', (t) => {
  const root = temporaryRoot(t);
  const plan = newSitePlan();
  plan.newSiteDesign.palette = 'Navy </script><img src=x onerror=alert(1)> and ivory';
  const output = path.join(root, 'new-site.html');
  renderCustomizationPlan(plan, output, { emitStatus: false });
  const html = fs.readFileSync(output, 'utf8');
  const embedded = html.match(/<script id="newSiteDesignData" type="application\/json">([\s\S]*?)<\/script>/);
  assert.deepEqual(JSON.parse(embedded[1]), plan.newSiteDesign);
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
  assert.match(html, /New-site design direction/);
  assert.match(html, /approval plan, not a live site preview/);
  assert.doesNotMatch(html, /__JSON_NEW_SITE_DESIGN_DATA__/);
  const displayed = renderDocument(html).get('newSiteDesign').innerHTML;
  assert.match(displayed, /Navy &lt;\/script&gt;&lt;img/);
  assert.match(displayed, /Meaningful content imagery included/);
  assert.match(displayed, /Stack native columns/);
  delete plan.newSiteDesign;
  const existingOutput = path.join(root, 'existing-site.html');
  renderCustomizationPlan(plan, existingOutput, { emitStatus: false });
  assert.match(fs.readFileSync(existingOutput, 'utf8'),
    /<script id="newSiteDesignData" type="application\/json">null<\/script>/);
  assert.equal(renderDocument(fs.readFileSync(existingOutput, 'utf8')).get('newSiteDesign').innerHTML, '');
});

test('approval document displays explicit imagery and Bootstrap compatibility exceptions', (t) => {
  const root = temporaryRoot(t);
  const plan = newSitePlan();
  plan.newSiteDesign.bootstrapMajor = 3;
  plan.newSiteDesign.compatibilityReason = 'User selected Standard compatibility.';
  plan.newSiteDesign.imagery = 'user-declined';
  plan.newSiteDesign.imageryReason = 'User requested no imagery.';
  plan.assets = [];
  const output = path.join(root, 'opt-out.html');
  renderCustomizationPlan(plan, output, { emitStatus: false });
  const displayed = renderDocument(fs.readFileSync(output, 'utf8')).get('newSiteDesign').innerHTML;
  assert.match(displayed, /3 - User selected Standard compatibility/);
  assert.match(displayed, /User declined: User requested no imagery/);
});

test('published execution carries the hashed design context without mixing it into owner inputs', (t) => {
  const root = temporaryRoot(t);
  const plan = newSitePlan();
  const dataPath = path.join(root, 'approved.json');
  fs.writeFileSync(dataPath, JSON.stringify(plan), 'utf8');
  publishApprovedPlan({ projectRoot: root, dataPath });
  const result = updateExecution({
    projectRoot: root, action: 'resolve', operationId: plan.operations[0].id,
  });
  assert.deepEqual(result.designContext, {
    ...plan.newSiteDesign, aesthetic: plan.aesthetic, mood: plan.mood,
  });
  assert.deepEqual(result.resolvedInputs, plan.operations[0].inputs);
  assert.throws(() => updateExecution({
    projectRoot: root, action: 'resolve', operationId: 'style-new-site',
  }), /incomplete dependencies/);
  for (const operation of plan.operations) {
    const resolved = updateExecution({
      projectRoot: root, action: 'resolve', operationId: operation.id,
    });
    assert.deepEqual(resolved.designContext, result.designContext);
    updateExecution({ projectRoot: root, action: 'start', operationId: operation.id });
    const outputs = Object.fromEntries(operation.expectedOutputs.map((key) => [key, `verified-${key}`]));
    const outputsPath = path.join(root, `${operation.id}-outputs.json`);
    fs.writeFileSync(outputsPath, JSON.stringify(outputs), 'utf8');
    updateExecution({ projectRoot: root, action: 'complete', operationId: operation.id, outputsPath });
  }
  assert.equal(updateExecution({ projectRoot: root, action: 'finish' }).status, 'completed');
  const canonical = path.join(root, 'docs', 'customize-declarative-site', 'current-plan.json');
  plan.newSiteDesign.composition = 'Unapproved changed composition';
  fs.writeFileSync(canonical, JSON.stringify(plan), 'utf8');
  assert.throws(() => updateExecution({
    projectRoot: root, action: 'resolve', operationId: plan.operations[0].id,
  }), /does not match current-plan.json/);
});
