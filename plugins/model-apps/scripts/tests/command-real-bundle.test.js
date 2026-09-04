'use strict';
// REAL BUNDLE: the commanding (custom ribbon button) authoring contract.
//
// The plugin already authors commands, but its unit coverage runs against a hand-written mock. This
// pins what the VENDORED bundle actually emits, so a re-vendor that changes the command wire shape
// fails here instead of silently producing buttons that never appear.
//
// The shape matters and is easy to get wrong: controls live inside `commandBars[].groups[].controls`,
// NOT directly on the bar. Putting them on the bar is accepted structurally and then emits NOTHING —
// `pushArtifact` still returns `saved: true` with zero HTTP writes. That is a silent no-op, and it
// is exactly why this file asserts on the captured writes rather than on `saved`.
//
// It also records, in executable form, the two limits that are easy to mis-remember as "the SDK
// cannot do custom buttons":
//   * A titled TOP-LEVEL group is a PLATFORM limit, not an SDK one. The SDK models `title` and
//     round-trips a fetched titled group, but creating a new top-level Group row is rejected by
//     Dataverse ("Group button must have parentappactionid"). Note the plugin's own `commandDef`
//     builds `groups: [{ id: '', title: '', controls }]` — an untitled group — for this reason.
//   * CONDITIONAL (rule-evaluated) visibility is Power Fx bound to a component library, which cannot
//     be authored headlessly. `hidden`/`disabled` are STATIC booleans; there is no JavaScript
//     visibility for modern commands.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const dirs = [];

function sdkWithCapture() {
  const { createMakerSdk } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-'));
  dirs.push(dir);
  const writes = [];
  let minted = 0;
  const httpClient = {
    get: async () => ({ status: 200, headers: {}, body: { value: [] } }),
    post: async (url, body) => {
      writes.push({ verb: 'post', url: String(url), body });
      minted += 1;
      const id = `5${String(minted).padStart(7, '0')}-5555-5555-5555-555555555555`;
      return { status: 204, headers: { 'odata-entityid': `https://contoso.crm.dynamics.com/api/data/v9.2/appactions(${id})` }, body: {} };
    },
    patch: async (url, body) => { writes.push({ verb: 'patch', url: String(url), body }); return { status: 204, headers: {}, body: {} }; },
    put: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspacePath: dir, instanceUrl: 'https://contoso.crm.dynamics.com', httpClient });
  sdk.initWorkspace();
  return { sdk, writes };
}

// Mirrors the shape the plugin's own `commandDef` builds.
function commandDef(controls, location = 'MainGrid') {
  return {
    entityLogicalName: 'account',
    commandBars: [{ location, groups: [{ id: '', title: '', controls }] }],
  };
}

test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test('REAL BUNDLE: a custom button with a JavaScript on-click reaches the wire', async () => {
  const { sdk, writes } = sdkWithCapture();
  const art = sdk.createArtifact('command', commandDef([{
    id: 'cr_hello',
    type: 'Button',
    label: 'Say Hello',
    action: {
      type: 'javascript',
      webResourceId: '66666666-6666-6666-6666-666666666666',
      functionName: 'Contoso.sayHello',
      parameters: [],
    },
  }]));
  assert.ok(art && art.id, 'createArtifact returns a command artifact');

  const pushed = await sdk.pushArtifact('command', art.id);
  assert.strictEqual(pushed.saved, true, `push commits; warnings=${JSON.stringify(pushed.warnings || [])}`);
  // Assert on WRITES, not on `saved`: a mis-shaped definition still reports saved:true while
  // emitting nothing at all.
  assert.ok(writes.length > 0, 'the push actually issued HTTP writes — saved:true alone is not proof');

  const all = JSON.stringify(writes);
  assert.match(all, /appaction/i, 'a command row is written');
  assert.match(all, /Contoso\.sayHello/, 'the JS function name reaches the wire — without it the button is inert');
  assert.match(all, /66666666-6666-6666-6666-666666666666/, 'the handler web resource is bound to the button');
});

test('REAL BUNDLE: Button, FlyoutAnchor and SplitButton all emit writes', async () => {
  // "Custom buttons are supported" is otherwise a claim with no executable meaning, and a re-vendor
  // could narrow the accepted set without any existing test noticing.
  for (const type of ['Button', 'FlyoutAnchor', 'SplitButton']) {
    const { sdk, writes } = sdkWithCapture();
    const art = sdk.createArtifact('command', commandDef([{ id: `cr_${type.toLowerCase()}`, type, label: type }]));
    const pushed = await sdk.pushArtifact('command', art.id);
    assert.strictEqual(pushed.saved, true, `${type} pushes cleanly`);
    assert.ok(writes.length > 0, `${type} actually emitted writes rather than silently no-op'ing`);
  }
});

test('REAL BUNDLE: hidden/disabled reach the wire as real booleans, not rules or strings', async () => {
  // The limit worth recording: `hidden: true` is a fixed state, not a rule. Rule-evaluated
  // visibility on modern commands is Power Fx + a component library and cannot be authored
  // headlessly, so an author must not expect "hide when status = closed" to be expressible here.
  const { sdk, writes } = sdkWithCapture();
  const art = sdk.createArtifact('command', commandDef([
    { id: 'cr_static', type: 'Button', label: 'Static', hidden: true, disabled: true },
  ]));
  const pushed = await sdk.pushArtifact('command', art.id);
  assert.strictEqual(pushed.saved, true);
  assert.ok(writes.length > 0, 'a static hidden/disabled button still writes');

  // POSITIVE assertions on the observed wire shape:
  //   { …, "buttonlabeltext": "Static", "hidden": true, "isdisabled": true }
  // A negative-only test ("no rule expression appears") would pass for three DIFFERENT failures:
  // the SDK dropping both flags, coercing them to the strings "true"/"false", or inverting them.
  // Naming the real keys and the real types is what makes this a contract test.
  const body = writes.map((w) => w.body).find((b) => b && b.hidden !== undefined);
  assert.ok(body, 'a command row carrying the visibility flags was written; got ' + JSON.stringify(writes.map((w) => w.body)).slice(0, 300));
  assert.strictEqual(body.hidden, true, '`hidden` is a real boolean on the wire, not a string and not inverted');
  assert.strictEqual(body.isdisabled, true, '`disabled` maps to `isdisabled`, also a real boolean');

  // And the negative still holds: no unevaluated rule expression is carried.
  assert.doesNotMatch(JSON.stringify(writes), /statuscode eq/i, 'no rule expression — these are static flags');
});

test('the plugin builds an UNTITLED group, because titled top-level groups are a platform limit', () => {
  // A PLATFORM limit ("Group button must have parentappactionid" -> HTTP 400), not an SDK gap. The
  // types expose `CommandGroup.title`, which reads like support until a push fails — so pin that the
  // plugin deliberately emits an empty title rather than inviting the failure.
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'sdk-build.js'), 'utf8');
  const m = /groups:\s*\[\{\s*id:\s*''\s*,\s*title:\s*''/.exec(src);
  assert.ok(m,
    "commandDef must build groups with an empty title — a titled top-level group is rejected by "
    + 'Dataverse with HTTP 400, so authoring one would fail the build');
});
