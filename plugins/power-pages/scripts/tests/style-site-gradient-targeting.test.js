'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, ids } = require('./style-site-fixtures');
const { preparePlan, validatePlan, validateRequest, planHash } = require('../lib/style-site-plan');
const { inspectSite, hash } = require('../lib/classic-site-style-context');
const { reviewPlan } = require('../lib/style-site-summary');
const { applyPlan } = require('../../skills/style-site/scripts/apply-style-plan');
const { verify } = require('../../skills/style-site/scripts/validate-style-site');
const { main: workflow } = require('../../skills/style-site/scripts/style-site-workflow');

const gradient = 'linear-gradient(135deg, #17324d 0%, #285b70 100%)';
const colors = ['#285b70', '#584477', '#285948'];

function columns(f, inline = false) {
  const tag = `<div class="col-md-4 columnBlockLayout"${inline ? ' style="padding: 12px; background: #fff;"' : ''}>`;
  const labels = ['Services', 'Resources', 'Support'];
  const unchanged = `<section id="elsewhere">${tag}\r\n<h3>Elsewhere</h3></div></section>`;
  const before = `<section id="features" class="row sectionBlockLayout">\r\n` +
    labels.map((label) => `${tag}\r\n<h3>${label}</h3><p>{{ user.fullname }}</p></div>`).join('\r\n') +
    `\r\n</section>\r\n${unchanged}`;
  f.put(f.copyPath, before);
  f.request.components = labels.map((label, index) => ({
    id: `feature-${index}`, label, kind: 'section', sourcePath: f.copyPath,
    ...(!inline ? { className: `pp-feature-${index}` } : {}),
  }));
  f.request.styles = labels.map((label, index) => ({
    id: `feature-fill-${index}`, componentId: `feature-${index}`, owner: 'custom', scope: 'page',
    studioComponent: 'Section', declarations: { 'background-image': gradient.replace(colors[0], colors[index]) },
    rationale: 'Style only the inspected feature column, preserving native grid classes and other sections.',
    ...(inline ? { location: 'inline', inlineTarget: tag, inlineContext: { after: `\r\n<h3>${label}</h3>` } } : {}),
  }));
  f.request.classEdits = inline ? [] : labels.map((label, index) => ({
    path: f.copyPath, match: tag, className: `pp-feature-${index}`, context: { after: `\r\n<h3>${label}</h3>` },
  }));
  return { tag, before, unchanged };
}

for (const major of [3, 5]) {
  for (const inline of [false, true]) {
    test(`three identical columns get only their requested gradients (Bootstrap ${major}, inline ${inline})`, (t) => {
      const f = fixture(t, { major, prefix: major === 5 ? '' : 'adx_', nested: major === 5 });
      const { before, unchanged } = columns(f, inline);
      const baseline = inspectSite(f.root);
      const plan = preparePlan(f.root, f.request);
      assert.equal(validatePlan(plan), plan);
      const review = reviewPlan(plan);
      assert.equal(review.route.name, 'small-change');
      if (!inline) assert.deepEqual(review.classEdits, f.request.classEdits, 'Full review preserves exact contextual anchors.');
      assert.ok(review.studioSupport.every((group) => group.properties[0].status === 'unsupported'));
      assert.match(plan.warnings.join('\n'), /Not editable through Section's Studio Design panel: background-image/);
      assert.deepEqual(inspectSite(f.root).files, baseline.files, 'Preparing is read-only.');
      const markup = plan.writes.find((write) => write.path === f.copyPath);
      assert.equal(markup.before, before);
      assert.ok(markup.after.endsWith(unchanged), 'Similar columns elsewhere are untouched.');
      assert.equal((markup.after.match(/\{\{ user.fullname \}\}/g) || []).length, 3);
      if (inline) {
        assert.equal(plan.writes.length, 1);
        assert.equal((markup.after.match(/background-image: linear-gradient/g) || []).length, 3);
        assert.equal((markup.after.match(/padding: 12px; background: #fff;/g) || []).length, 4);
      } else {
        assert.equal(plan.writes.length, 2);
        const css = plan.writes.find((write) => write.kind === 'css');
        for (const index of [0, 1, 2]) {
          assert.ok(markup.after.includes(`class="col-md-4 columnBlockLayout pp-feature-${index}"`));
          assert.ok(css.after.includes(`.pp-feature-${index} {\n  background-image: ${gradient.replace(colors[0], colors[index])};`));
        }
        assert.doesNotMatch(css.after, /\.col-md-4|#features|nth-child|!important/);
      }
      const receipt = path.join(f.work, 'receipt.json');
      const applied = applyPlan(plan, { apply: true, approvedHash: plan.planHash, receipt });
      assert.equal(applied.status, 'applied');
      assert.ok(applied.warnings.some((warning) => warning.includes('background-image')));
      assert.equal(verify(plan, JSON.parse(fs.readFileSync(receipt))).status, 'verified-local-files');
      assert.equal(applyPlan(plan).status, 'already-applied');
      for (const file of baseline.files.filter((entry) => !plan.writes.some((write) => write.path === entry.path))) {
        assert.equal(hash(fs.readFileSync(path.join(f.root, file.path), 'utf8')), file.hash, file.path);
      }
    });
  }
}

test('contextual hooks may reuse one treatment in a correctly scoped shared stylesheet', (t) => {
  const f = fixture(t);
  columns(f);
  f.request.components = [f.request.components[0]];
  f.request.styles = [f.request.styles[0]];
  f.request.styles[0].scope = 'site';
  f.request.styles[0].targetId = f.assets['custom.css'].id;
  for (const edit of f.request.classEdits) edit.className = f.request.components[0].className;
  const plan = preparePlan(f.root, f.request);
  assert.equal(validatePlan(plan), plan);
  assert.equal(reviewPlan(plan).route.name, 'expanded');
  assert.equal(plan.placements[0].path, f.assets['custom.css'].path);
  assert.ok(plan.placements[0].affectedPageIds.includes(ids.sectionLocale));
  assert.equal((plan.writes.find((write) => write.kind === 'class').after.match(/ pp-feature-0/g) || []).length, 3);
});

test('owning inline background shorthand still blocks ineffective gradient CSS', (t) => {
  const f = fixture(t);
  const { tag, before } = columns(f);
  const replacement = tag.replace('>', ' style="background: #fff;">');
  f.put(f.copyPath, before.replaceAll(tag, replacement));
  f.request.classEdits.forEach((edit) => { edit.match = replacement; });
  assert.throws(() => preparePlan(f.root, f.request), /Inline background overrides stylesheet/);
});

test('context drift, missing anchors, wrong scope and rehashed edits cannot bypass source guards', (t) => {
  const f = fixture(t);
  const { before } = columns(f);
  const plan = preparePlan(f.root, f.request);
  const noContext = structuredClone(f.request);
  noContext.classEdits.forEach((edit) => { delete edit.context; });
  assert.throws(() => preparePlan(f.root, noContext), /exactly one opening tag/);
  const traversal = structuredClone(f.request);
  traversal.components[0].sourcePath = '..\\outside.webpage.copy.html';
  traversal.classEdits[0].path = traversal.components[0].sourcePath;
  assert.throws(() => preparePlan(f.root, traversal), /existing page copy/);
  const wrongLocale = { ...f.request, pageId: ids.sectionLocale };
  assert.throws(() => preparePlan(f.root, wrongLocale), /selected localized page source/);
  const changedTarget = structuredClone(plan);
  changedTarget.request.classEdits[0].context.after = '\r\n<h3>Elsewhere</h3>';
  changedTarget.planHash = planHash(changedTarget);
  assert.throws(() => validatePlan(changedTarget), /beyond the approved class\/inline edits/);
  const changedMarkup = structuredClone(plan);
  const write = changedMarkup.writes.find((entry) => entry.kind === 'class');
  write.after = write.after.replace('<h3>Elsewhere</h3>', '<h3>Modified</h3>');
  write.afterHash = hash(write.after);
  changedMarkup.planHash = planHash(changedMarkup);
  assert.throws(() => validatePlan(changedMarkup), /beyond the approved class\/inline edits/);
  f.put(f.copyPath, before.replace('>Services<', '>Changed<'));
  assert.throws(() => preparePlan(f.root, f.request), /context no longer matches/);
  assert.throws(() => applyPlan(plan, { apply: true, approvedHash: plan.planHash, receipt: path.join(f.work, 'receipt.json') }), /changed|stale|drift/i);
  assert.equal(fs.existsSync(path.join(f.work, 'receipt.json')), false);
});

test('source contexts are permitted only on guarded local placements', (t) => {
  const f = fixture(t);
  columns(f);
  const request = structuredClone(f.request);
  request.styles[0].inlineContext = { after: 'text' };
  assert.throws(() => validateRequest(request), /require location: inline/);
  request.styles[0].owner = 'studio';
  request.styles[0].handoffReason = 'user-requested';
  request.styles[0].studioAction = 'Requested instructions.';
  assert.throws(() => validateRequest(request), /cannot request local placement/);
  for (const context of [null, {}, { index: 0 }, { after: true }]) {
    f.request.classEdits[0].context = context;
    assert.throws(() => validateRequest(f.request), /Source context/);
  }
});

test('coordinator flags gradient readability, preserves warnings and independently verifies the approved diff', (t) => {
  const f = fixture(t);
  columns(f);
  const requestPath = path.join(f.work, 'request.json');
  fs.writeFileSync(requestPath, JSON.stringify(f.request));
  const prepared = workflow(['--operation', 'prepare', '--siteRoot', f.root, '--request', requestPath, '--out', path.join(f.work, 'revision')]);
  assert.equal(prepared.status, 'ready-for-review');
  assert.equal(prepared.contrastReview, 'required-before-approval');
  const review = JSON.parse(fs.readFileSync(prepared.artifacts.review, 'utf8'));
  assert.deepEqual(review.classEdits, f.request.classEdits);
  assert.ok(review.studioSupport.every((group) => group.warnings.some((warning) => warning.includes('background-image'))));
  const applied = workflow(['--operation', 'apply', '--plan', prepared.artifacts.plan, '--approvedHash', prepared.planHash, '--receipt', path.join(f.work, 'receipt.json')]);
  assert.equal(applied.status, 'applied');
  assert.equal(applied.verification.status, 'verified-local-files');
});
