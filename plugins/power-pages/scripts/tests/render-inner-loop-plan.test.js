'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const {
  render, escapeHtml, STATE_LABEL, NEXT_STEP,
} = require('../../skills/plan-inner-loop/scripts/render-inner-loop-plan');

const TEMPLATE_PATH = path.join(
  __dirname, '..', '..',
  'skills', 'plan-inner-loop', 'assets', 'inner-loop-plan-template.html',
);

function loadTemplate() {
  return fs.readFileSync(TEMPLATE_PATH, 'utf8');
}

test('render-inner-loop-plan: template file exists and is non-trivial', () => {
  const t = loadTemplate();
  assert.ok(t.length > 1000, 'template should be > 1KB');
  assert.match(t, /__SITE_NAME__/);
  assert.match(t, /__STATE__/);
  assert.match(t, /plan-status/);
});

test('render-inner-loop-plan: STATE_LABEL has all 7 states', () => {
  const expected = ['Disconnected', 'Clean', 'Dirty', 'Stale', 'Mixed', 'Conflicted', 'Broken'];
  for (const s of expected) {
    assert.ok(STATE_LABEL[s], `STATE_LABEL.${s} missing`);
    assert.ok(STATE_LABEL[s].title, `STATE_LABEL.${s}.title missing`);
    assert.ok(STATE_LABEL[s].desc, `STATE_LABEL.${s}.desc missing`);
  }
});

test('render-inner-loop-plan: NEXT_STEP has all 7 states with cmd+desc', () => {
  const expected = ['Disconnected', 'Clean', 'Dirty', 'Stale', 'Mixed', 'Conflicted', 'Broken'];
  for (const s of expected) {
    assert.ok(NEXT_STEP[s], `NEXT_STEP.${s} missing`);
    assert.ok(NEXT_STEP[s].cmd, `NEXT_STEP.${s}.cmd missing`);
    assert.ok(NEXT_STEP[s].desc, `NEXT_STEP.${s}.desc missing`);
    assert.ok(Array.isArray(NEXT_STEP[s].alts), `NEXT_STEP.${s}.alts must be array`);
  }
});

test('render-inner-loop-plan: escapeHtml handles all the dangerous chars', () => {
  assert.equal(escapeHtml('<script>alert("x")&y</script>'),
    '&lt;script&gt;alert(&quot;x&quot;)&amp;y&lt;/script&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(123), '123');
});

test('render-inner-loop-plan: throws on null data', () => {
  assert.throws(() => render(loadTemplate(), null), /data must be an object/);
});

test('render-inner-loop-plan: Disconnected state — minimal payload', () => {
  const html = render(loadTemplate(), {
    siteName: 'MySite',
    generatedAt: '2026-05-30T12:00:00Z',
    state: 'Disconnected',
    binding: { bound: false },
    changes: { count: 0, items: [] },
    updates: { count: 0, items: [] },
    conflicts: { count: 0, items: [] },
    prereqs: {},
    flags: {},
  });
  assert.match(html, /Inner Loop · MySite/);
  assert.match(html, /class="plan-status disconnected"/);
  assert.match(html, />Disconnected</);
  assert.match(html, /No binding detected/);
  assert.match(html, /git-configure/);
  // No __PLACEHOLDER__ tokens should remain
  assert.ok(!/__[A-Z_]+__/.test(html), 'no placeholders should remain unreplaced');
});

test('render-inner-loop-plan: Clean state — bound, no work', () => {
  const html = render(loadTemplate(), {
    siteName: 'Clean Site',
    generatedAt: '2026-05-30T12:00:00Z',
    state: 'Clean',
    binding: {
      bound: true, bindingType: 'env',
      organization: 'myorg', project: 'myproj', repository: 'myrepo',
      branch: 'main', folder: 'src', envUrl: 'https://contoso.crm.dynamics.com',
    },
    changes: { count: 0, items: [] },
    updates: { count: 0, items: [] },
    conflicts: { count: 0, items: [] },
    prereqs: { pacCli: true, azCli: true, managedEnv: true, repoInitialized: true },
    flags: {},
  });
  assert.match(html, /class="plan-status clean"/);
  assert.match(html, /Everything is in sync/);
  assert.match(html, /myorg/);
  assert.match(html, /contoso\.crm\.dynamics\.com/);
  assert.match(html, /no action required/);
  assert.ok(!/__[A-Z_]+__/.test(html));
});

test('render-inner-loop-plan: Dirty state with items in changes table', () => {
  const html = render(loadTemplate(), {
    siteName: 'X', generatedAt: 'T', state: 'Dirty',
    binding: { bound: true, bindingType: 'env', branch: 'main' },
    changes: {
      count: 2,
      items: [
        { componentName: 'About', componentType: 'mspp_webpage', changeType: 'Add', filePath: 'webpages/About.json' },
        { componentName: 'Layout', componentType: 'mspp_webtemplate', changeType: 'Modify', filePath: 'web-templates/Layout.html' },
      ],
    },
    updates: { count: 0, items: [] },
    conflicts: { count: 0, items: [] },
    prereqs: {},
    flags: {},
  });
  assert.match(html, /Pending changes \(2\)/);
  assert.match(html, /About/);
  assert.match(html, /mspp_webpage/);
  assert.match(html, /class="badge add"/);
  assert.match(html, /class="badge mod"/);
  // post-VPC-merge: render now suggests commit-to-git --dry-run for pre-flight
  assert.match(html, /commit-to-git --dry-run/);
});

test('render-inner-loop-plan: Stale state shows sync-from-git', () => {
  const html = render(loadTemplate(), {
    siteName: 'X', generatedAt: 'T', state: 'Stale',
    binding: { bound: true, branch: 'main' },
    changes: { count: 0, items: [] },
    updates: { count: 3, items: [
      { componentName: 'NewPage', componentType: 'mspp_webpage', changeType: 'Add' },
    ] },
    conflicts: { count: 0, items: [] },
    prereqs: {},
    flags: {},
  });
  assert.match(html, /sync-from-git/);
  assert.match(html, /class="plan-status stale"/);
  assert.match(html, /Incoming updates \(1\)/);
});

test('render-inner-loop-plan: Conflicted state shows resolve-conflicts', () => {
  const html = render(loadTemplate(), {
    siteName: 'X', generatedAt: 'T', state: 'Conflicted',
    binding: { bound: true, branch: 'main' },
    changes: { count: 0, items: [] },
    updates: { count: 0, items: [] },
    conflicts: { count: 1, items: [
      { componentName: 'About', componentType: 'mspp_webpage', conflictReason: 'concurrent edit by alice' },
    ] },
    prereqs: {},
    flags: {},
  });
  assert.match(html, /resolve-conflicts/);
  assert.match(html, /class="plan-status conflicted"/);
  assert.match(html, /Conflicts \(1\)/);
  assert.match(html, /concurrent edit by alice/);
});

test('render-inner-loop-plan: Mixed state shows both commands', () => {
  const html = render(loadTemplate(), {
    siteName: 'X', generatedAt: 'T', state: 'Mixed',
    binding: { bound: true },
    changes: { count: 1, items: [{ componentName: 'A', componentType: 'mspp_webpage', changeType: 'Add' }] },
    updates: { count: 1, items: [{ componentName: 'B', componentType: 'mspp_webpage', changeType: 'Add' }] },
    conflicts: { count: 0, items: [] },
    prereqs: {},
    flags: {},
  });
  assert.match(html, /class="plan-status mixed"/);
  assert.match(html, /sync-from-git.+commit-to-git/i);
});

test('render-inner-loop-plan: unknown state falls back to Broken', () => {
  const html = render(loadTemplate(), {
    siteName: 'X', generatedAt: 'T', state: 'Bogus',
    binding: { bound: true },
    changes: { count: 0, items: [] },
    updates: { count: 0, items: [] },
    conflicts: { count: 0, items: [] },
    prereqs: {},
    flags: {},
  });
  assert.match(html, /diagnose-git-integration/);
  assert.match(html, /Broken state/);
});

test('render-inner-loop-plan: flags render as warning pills', () => {
  const html = render(loadTemplate(), {
    siteName: 'X', generatedAt: 'T', state: 'Clean',
    binding: { bound: true },
    changes: { count: 0, items: [] },
    updates: { count: 0, items: [] },
    conflicts: { count: 0, items: [] },
    prereqs: {},
    flags: { refreshError: 'timeout after 5s', partialData: true },
  });
  assert.match(html, /class="flag"/);
  assert.match(html, /refreshError: timeout after 5s/);
  assert.match(html, /partialData/);
});

test('render-inner-loop-plan: HTML in componentName is escaped (XSS protection)', () => {
  const html = render(loadTemplate(), {
    siteName: 'X', generatedAt: 'T', state: 'Dirty',
    binding: { bound: true },
    changes: { count: 1, items: [
      { componentName: '<script>alert(1)</script>', componentType: 'mspp_webpage', changeType: 'Add' },
    ] },
    updates: { count: 0, items: [] },
    conflicts: { count: 0, items: [] },
    prereqs: {},
    flags: {},
  });
  assert.ok(!/<script>alert/.test(html), 'raw <script> tag must not appear');
  assert.match(html, /&lt;script&gt;alert/);
});

test('render-inner-loop-plan: prereq booleans render as OK / Missing icons', () => {
  const html = render(loadTemplate(), {
    siteName: 'X', generatedAt: 'T', state: 'Clean',
    binding: { bound: true },
    changes: { count: 0, items: [] },
    updates: { count: 0, items: [] },
    conflicts: { count: 0, items: [] },
    prereqs: { pacCli: true, azCli: false, managedEnv: null },
    flags: {},
  });
  assert.match(html, /✓ OK/);
  assert.match(html, /✗ Missing/);
});

test('render-inner-loop-plan: overflow row when items > 25', () => {
  const items = Array.from({ length: 30 }).map((_, i) => ({
    componentName: 'P' + i, componentType: 'mspp_webpage', changeType: 'Add',
  }));
  const html = render(loadTemplate(), {
    siteName: 'X', generatedAt: 'T', state: 'Dirty',
    binding: { bound: true },
    changes: { count: 30, items },
    updates: { count: 0, items: [] },
    conflicts: { count: 0, items: [] },
    prereqs: {},
    flags: {},
  });
  assert.match(html, /\+ 5 more/);
});

test('render-inner-loop-plan: envUrl that is not a valid URL still renders', () => {
  const html = render(loadTemplate(), {
    siteName: 'X', generatedAt: 'T', state: 'Clean',
    binding: { bound: true, envUrl: 'not-a-url' },
    changes: { count: 0, items: [] },
    updates: { count: 0, items: [] },
    conflicts: { count: 0, items: [] },
    prereqs: {},
    flags: {},
  });
  // Should not throw — falls back to the raw string
  assert.match(html, /not-a-url/);
});
