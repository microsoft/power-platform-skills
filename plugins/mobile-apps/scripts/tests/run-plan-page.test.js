'use strict';

/**
 * Executes the generated run-plan page's script against a real plan, in a minimal DOM stub.
 *
 * The other run-plan tests read `assets/run-plan.html` as text and assert on its source. That
 * catches a missing function but not a page that throws halfway through rendering, and it cannot
 * tell the difference between a renderer that draws a diagram and one that reads a field nothing
 * ever writes. Both of those shipped: `renderScreens` read a `screens.mermaid` string that no
 * producer set, so the screen graph silently showed its empty state, and `showSource` was defined
 * twice with the second copy silently overriding the first.
 *
 * Running the script is the only check that distinguishes those from a working page.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { initState, outputPath, save, setPhone, setSection } = require('../app-docs');

/** Mermaid's crow's-foot tokens. Anything else aborts the parse and blanks the diagram. */
const ER_CARDINALITY_TOKENS = ['||--||', '}o--o{', '}o--||', '||--o{'];

function node(id) {
  return {
    id,
    tagName: 'DIV',
    children: [],
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    _text: '',
    _html: '',
    get textContent() { return this._text; },
    set textContent(value) { this._text = String(value); },
    get innerHTML() { return this._html; },
    set innerHTML(value) { this._html = String(value); },
    appendChild(child) { this.children.push(child); return child; },
    append(...kids) { this.children.push(...kids); },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    addEventListener() {}, removeEventListener() {}, remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, focus() {}, scrollIntoView() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
  };
}

/**
 * Run every executable `<script>` in the page and report what it did.
 *
 * `<script type="application/json" id="...">` blocks are the page's own state, read back with
 * `JSON.parse(getElementById(id).textContent)`. They are data, so they are registered as element
 * content rather than executed - running them as JavaScript is a syntax error on the first colon.
 */
function runPage(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');

  const data = new Map();
  const scripts = [];
  for (const [, attributes, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    const id = (attributes.match(/id\s*=\s*["']([^"']+)["']/) || [])[1];
    if (/type\s*=\s*["']application\/json["']/.test(attributes) && id) data.set(id, body);
    else if (body.trim()) scripts.push(body);
  }

  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        const created = node(id);
        if (data.has(id)) created.textContent = data.get(id);
        elements.set(id, created);
      }
      return elements.get(id);
    },
    createElement(tag) {
      const created = node(`<${tag}>`);
      created.tagName = tag.toUpperCase();
      if (created.tagName === 'TEMPLATE') {
        // Enough of a <template> for the sanitizer to run end to end. The stub cannot parse
        // HTML, so `content` is an empty inert fragment: this proves the page drives the
        // sanitizer without throwing. What the sanitizer strips is asserted against the
        // source separately, in the cleaning test below.
        created.content = { ...node('#fragment'), querySelectorAll: () => [] };
      }
      return created;
    },
    createTextNode(text) { const created = node('#text'); created.textContent = String(text); return created; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
    body: node('body'), documentElement: node('html'),
    hidden: false, readyState: 'complete',
  };

  const diagrams = [];
  const errors = [];
  const sandbox = {
    document,
    window: {
      document,
      addEventListener() {}, removeEventListener() {},
      location: { hash: '', reload() {} },
      matchMedia() { return { matches: false, addEventListener() {} }; },
      setTimeout() { return 0; }, setInterval() { return 0; }, scrollTo() {}, scrollY: 0,
    },
    location: { hash: '', reload() {} },
    sessionStorage: {
      store: new Map(),
      getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
      setItem(key, value) { this.store.set(key, String(value)); },
      removeItem(key) { this.store.delete(key); },
    },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    // Stand in for the real Mermaid: record what the page asked it to draw. Rendering is
    // Mermaid's job; what this test owns is that the page asks, and asks with valid source.
    mermaid: {
      initialize() {},
      render(id, source) { diagrams.push({ id, source }); return Promise.resolve({ svg: '<svg/>' }); },
    },
    navigator: { userAgent: 'node' },
    console: { log() {}, warn() {}, error(message) { errors.push(String(message)); } },
    setTimeout() { return 0; }, clearTimeout() {},
    setInterval() { return 0; }, clearInterval() {},
    requestAnimationFrame() { return 0; },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const thrown = [];
  for (const source of scripts) {
    try {
      vm.runInContext(source, sandbox, { timeout: 10000 });
    } catch (error) {
      thrown.push(error);
    }
  }

  function textOf(target) {
    if (!target.children.length) return target.textContent;
    return target.children.map(textOf).join('\n');
  }
  const rendered = (id) => textOf(document.getElementById(id));

  return { diagrams, errors, thrown, elements, rendered, scriptCount: scripts.length };
}

/** A plan far enough along to exercise every renderer: all sections set, mid-build. */
function fullPlan() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-plan-page-'));
  let state = initState(root, { appName: 'Field Service', dataPlatform: 'Dataverse + connectors' });

  state = setSection(state, 'environment', {
    displayName: 'Contoso (Dev)',
    environmentUrl: 'https://contoso.crm.dynamics.com',
    publisherPrefix: 'contoso',
  });
  state = setSection(state, 'requirements', {
    appName: 'Field Service', industry: 'Field service', brief: 'Technicians close jobs offline.',
    features: ['Job list', 'Photo capture'],
  });
  state = setSection(state, 'architecture', {
    dataPlatform: 'Dataverse + connectors',
    nativeCapabilities: [{ name: 'Camera', reason: 'Photos are the completion evidence.' }],
    connectors: [{ name: 'SharePoint', reason: 'Manuals are already maintained there.' }],
  }, 'approved');
  state = setSection(state, 'dataModel', {
    tables: [
      {
        logicalName: 'contoso_workorder', displayName: 'Work order', status: 'new',
        purpose: 'One dispatched visit.', reason: 'A case spans weeks; a visit does not.',
        columns: [
          { logicalName: 'contoso_workorderid', type: 'Unique identifier', key: 'PK' },
          // "Yes/No" is a real Dataverse type whose slash is outside Mermaid's ATTRIBUTE_WORD.
          { logicalName: 'contoso_urgent', type: 'Yes/No' },
          { logicalName: 'contoso_siteid', type: 'Lookup', key: 'FK' },
        ],
        // Human shorthand from native-app-plan.md, not a Mermaid token.
        relationships: [{ relatedTable: 'contoso_site', name: 'at site', cardinality: 'N:1' }],
      },
      {
        logicalName: 'contoso_site', displayName: 'Site', status: 'reused',
        purpose: 'Where the asset lives.', reason: 'Sites are already maintained by the service desk.',
        columns: [{ logicalName: 'contoso_siteid', type: 'Unique identifier', key: 'PK' }],
        relationships: [],
      },
    ],
  }, 'approved');
  state = setSection(state, 'offline', {
    enabled: true, mode: 'Selective sync', tables: ['contoso_workorder'],
    rationale: 'Plant rooms have no signal.',
  }, 'approved');
  state = setSection(state, 'screens', {
    navigation: 'Bottom tabs (Today, Sites) with a stack pushed from each tab.',
    list: [
      { name: 'Sign in', route: '/login', purpose: 'Tenant sign-in.', capabilities: ['Biometrics'] },
      { name: 'Today', route: '/(app)/today', purpose: "Today's jobs.", capabilities: ['Offline'] },
      { name: 'Work order', route: '/(app)/work-order/[id]', purpose: 'The visit.', capabilities: [] },
      { name: 'Capture', route: '/(app)/work-order/[id]/photos', purpose: 'Photos.', capabilities: ['Camera'] },
    ],
  }, 'approved');
  state = setSection(state, 'design', {
    direction: 'High-contrast utility.', headingFont: 'Segoe UI', bodyFont: 'Segoe UI',
    darkMode: 'enabled', palette: [{ name: 'Primary', value: '#742774' }],
  }, 'approved');
  state = setSection(state, 'auth', { status: 'Configured' });
  state = setSection(state, 'trust', {
    permissions: [
      { name: 'Camera', status: 'on-demand', detail: 'Requested when photo capture starts.', activation: 'Lens runs only while the capture sheet is open.' },
      { name: 'Photo library', status: 'system-mediated', detail: 'The OS picker returns one image; no library grant is taken.' },
      { name: 'Biometric unlock', status: 'per-operation', detail: 'Authenticated at each unlock; no standing grant.' },
      { name: 'Notifications', status: 'on-startup', detail: 'Asked for during onboarding.' },
      { name: 'Microphone', status: 'not-requested', detail: 'No audio workflow exists in the app.' },
      // An unrecognised status must not be able to overstate what the app reaches for.
      { name: 'Location', status: 'whatever-this-is', detail: 'Site coordinates come from Dataverse.' },
    ],
    handles: ['Work order records.', 'Work or school account sign-in.'],
    notCollected: ['No contact list or calendar.', 'No advertising identifier.'],
    battery: [{ name: 'No continuous GPS', detail: 'No background location updates or geofences.' }],
  }, 'approved');

  setPhone(state, { stage: 'building' });
  save(root, state);
  return { root, htmlPath: outputPath(root) };
}

test('the generated page runs to completion without throwing', () => {
  const { htmlPath } = fullPlan();
  const result = runPage(htmlPath);

  assert.ok(result.scriptCount > 0, 'the page must ship an executable script');
  assert.deepEqual(
    result.thrown.map((error) => `${error.message}\n${(error.stack || '').split('\n')[1] || ''}`),
    [],
    'the page script threw while rendering a complete plan',
  );
  assert.deepEqual(result.errors, [], 'the page logged an error while rendering');
});

test('both diagrams are drawn, from the structured plan rather than a supplied string', () => {
  const { htmlPath } = fullPlan();
  const { diagrams } = runPage(htmlPath);

  const er = diagrams.find((d) => d.source.startsWith('erDiagram'));
  const graph = diagrams.find((d) => d.source.startsWith('flowchart'));

  assert.ok(er, 'the ER diagram was never handed to mermaid');
  assert.ok(graph, 'the screen graph was never handed to mermaid');

  // Derived from `tables[]`: the slash in "Yes/No" is sanitized and "N:1" became a real token.
  assert.match(er.source, /contoso_workorder/);
  assert.doesNotMatch(er.source, /Yes\/No/, 'an unsanitized type would abort the parse');
  const cardinalities = [...er.source.matchAll(/^ {4}\S+ (\S+) \S+ : /gm)].map((m) => m[1]);
  assert.ok(cardinalities.length > 0, 'the ER diagram has no relationships');
  for (const token of cardinalities) {
    assert.ok(ER_CARDINALITY_TOKENS.includes(token), `'${token}' is not a mermaid cardinality token`);
  }

  // Derived from `list[]` route nesting: a child route hangs off its parent, not off the shell.
  assert.match(graph.source, /SHELL\{\{"Bottom tabs"\}\}/, 'the shell label should be the leading phrase');
  const edges = [...graph.source.matchAll(/^ {4}(\S+) --> (\S+)$/gm)].map((m) => [m[1], m[2]]);
  const idOf = (name) => (graph.source.match(new RegExp(`^ {4}(S\\d+)\\["${name}"\\]$`, 'm')) || [])[1];

  const today = idOf('Today');
  const workOrder = idOf('Work order');
  const capture = idOf('Capture');
  const signIn = idOf('Sign in');
  assert.ok(today && workOrder && capture && signIn, 'every screen should appear as a node');

  const has = (from, to) => edges.some(([a, b]) => a === from && b === to);
  assert.ok(has(signIn, 'SHELL'), 'a screen outside (app) leads into the shell');
  assert.ok(has('SHELL', today), 'a top-level (app) screen hangs off the shell');
  assert.ok(has(workOrder, capture), 'a nested route hangs off its parent screen');
  assert.ok(!has('SHELL', capture), 'a nested route must not also hang off the shell');
});

test('object-shaped plan entries render as their names, never as [object Object]', () => {
  const { htmlPath } = fullPlan();
  const { elements, rendered } = runPage(htmlPath);

  // Capabilities and connectors are `{ name, reason }`. The overview listed them through a
  // plain join, so every entry rendered as "[object Object]" while the Capabilities tab - which
  // normalized the same data - looked fine.
  for (const [id, element] of elements) {
    const text = (function collect(node) {
      return node.children.length ? node.children.map(collect).join(' ') : node.textContent;
    })(element);
    assert.ok(
      !text.includes('[object Object]'),
      `#${id} stringified an object instead of reading its name`,
    );
  }

  const architecture = rendered('architectureFacts');
  assert.match(architecture, /Camera/, 'the capability name should reach the overview');
  assert.match(architecture, /SharePoint/, 'the connector name should reach the overview');
});

test('enumerable fields render as a list rather than a run-on sentence', () => {
  const { htmlPath } = fullPlan();
  const { elements } = runPage(htmlPath);

  const listItems = (id) => {
    const found = [];
    (function walk(node) {
      if (node.tagName === 'LI') found.push(node.textContent);
      node.children.forEach(walk);
    })(elements.get(id));
    return found;
  };

  // Features are separate things; joined with commas they read as one unparseable sentence.
  const features = listItems('requirementsFacts');
  assert.deepEqual(features, ['Job list', 'Photo capture']);

  // The offline rationale is authored as paragraphs, one per decision.
  const offline = listItems('offlineBlock');
  assert.equal(offline.length, 0, 'a single-paragraph rationale stays prose');
});

test('a plan with no screens yet shows the empty state instead of drawing an empty graph', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-plan-empty-'));
  save(root, initState(root, { appName: 'Early', dataPlatform: 'unknown' }));

  const { diagrams, thrown, errors } = runPage(outputPath(root));
  assert.deepEqual(thrown.map((e) => e.message), [], 'an empty plan must still render');
  assert.deepEqual(errors, []);
  assert.equal(
    diagrams.filter((d) => d.source.startsWith('flowchart')).length, 0,
    'with no screens there is nothing to draw',
  );
});

test('a multi-paragraph rationale becomes one bullet per point', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-plan-offline-'));
  let state = initState(root, { appName: 'Offline', dataPlatform: 'dataverse' });
  state = setSection(state, 'offline', {
    enabled: true,
    mode: 'Selective sync',
    tables: ['contoso_workorder'],
    // Authored as blank-line-separated points, which is how the plan records a rationale.
    rationale: 'Plant rooms have no signal.\n\nOnly the next two days are cached.\n\nWrites replay in order.',
  }, 'approved');
  save(root, state);

  const { elements, thrown } = runPage(outputPath(root));
  assert.deepEqual(thrown.map((e) => e.message), []);

  const items = [];
  (function walk(node) {
    if (node.tagName === 'LI') items.push(node.textContent);
    node.children.forEach(walk);
  })(elements.get('offlineBlock'));

  assert.deepEqual(items, [
    'Plant rooms have no signal.',
    'Only the next two days are cached.',
    'Writes replay in order.',
  ]);
});

test('a named font is applied to the card that names it, and only if it is a safe name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-plan-font-'));
  let state = initState(root, { appName: 'Fonts', dataPlatform: 'dataverse' });
  state = setSection(state, 'design', {
    direction: 'Utility.',
    headingFont: 'Segoe UI Variable Display',
    // A name that would close the quoted family and append a declaration must be refused
    // outright rather than escaped, so nothing from the plan can reach the stylesheet.
    bodyFont: 'Evil", x:expression(alert(1)), "',
    darkMode: 'enabled',
    palette: [{ name: 'Primary', value: '#742774' }],
  }, 'approved');
  save(root, state);

  const { elements, thrown } = runPage(outputPath(root));
  assert.deepEqual(thrown.map((e) => e.message), []);

  const styled = [];
  (function walk(node) {
    if (node.style && node.style.fontFamily) styled.push(node.style.fontFamily);
    node.children.forEach(walk);
  })(elements.get('designFacts'));

  assert.deepEqual(styled, ['"Segoe UI Variable Display", system-ui, sans-serif'],
    'the safe name is applied with a fallback; the crafted one is dropped');
});

test('the screens stage with nothing to show falls back to the building animation', () => {
  // The skill is told to skip the stage switch when --no-design or "Skip preview" means no
  // _plan_preview.html was written. If it switches anyway, the phone must keep animating rather
  // than render an empty carousel with dead prev/next controls.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-plan-nocarousel-'));
  const state = initState(root, { appName: 'No design', dataPlatform: 'dataverse' });
  setPhone(state, { stage: 'screens', screens: [] });
  save(root, state);

  const { elements, thrown } = runPage(outputPath(root));
  assert.deepEqual(thrown.map((e) => e.message), []);

  const classes = [];
  (function walk(node) {
    if (node.className) classes.push(node.className);
    node.children.forEach(walk);
  })(elements.get('deviceScreen'));

  assert.ok(classes.some((c) => String(c).split(' ').includes('bld')), 'expected the build animation');
  assert.ok(!classes.some((c) => String(c).split(' ').includes('car')), 'expected no carousel');
  assert.equal(elements.get('railTitle').textContent, 'Building your app');
});

test('the trust report states when each permission is used, and downgrades an unknown status', () => {
  const { htmlPath } = fullPlan();
  const { elements, thrown } = runPage(htmlPath);
  assert.deepEqual(thrown.map((e) => e.message), []);

  const rows = [];
  (function walk(node) {
    if (String(node.className).split(' ').includes('perm')) rows.push(node);
    node.children.forEach(walk);
  })(elements.get('permissionList'));
  assert.equal(rows.length, 6, 'every recorded permission gets a row');

  const flat = (node) => (node.children.length ? node.children.map(flat).join(' ') : node.textContent);
  const text = rows.map(flat).join(' | ');

  // A capability the app never asks for is the entry a reviewer actually needs, so it must be
  // listed rather than omitted.
  assert.match(text, /Microphone[\s\S]*NOT REQUESTED/);
  // The badge names the acquisition pattern, not just whether access exists: "at startup" and
  // "on demand" end with the same grant but differ entirely in how it was obtained.
  assert.match(text, /Camera[\s\S]*ON DEMAND/);
  assert.match(text, /Photo library[\s\S]*SYSTEM-MEDIATED/);
  assert.match(text, /Biometric unlock[\s\S]*PER OPERATION/);
  assert.match(text, /Notifications[\s\S]*AT STARTUP/);

  // Authorization and activation are separate events and are reported separately.
  assert.match(text, /Hardware: Lens runs only while the capture sheet is open\./);

  // An unrecognised status resolves to the weakest claim, never to "on demand".
  const location = rows.find((row) => flat(row).includes('Location'));
  assert.match(flat(location), /NOT REQUESTED/, 'an unknown status must not overstate access');

  // Each row carries when-and-why, not just a name and a badge.
  assert.match(text, /Requested when photo capture starts\./);

  // Each row leads with an inline SVG, not a unicode glyph: geometric shapes were unreadable
  // at this size. Distinctness is the point - if two permission types share an icon the column
  // is decoration.
  const icons = rows.map((row) => row.children[0].innerHTML);
  for (const icon of icons) {
    assert.match(icon, /^<svg viewBox="0 0 24 24"/, 'every row needs a drawn icon');
    assert.ok(icon.includes('stroke="currentColor"'), 'icons must inherit the row colour');
  }
  assert.equal(new Set(icons).size, icons.length, 'no two permission types may share an icon');
});

test('the trust report separates what is handled from what is not collected', () => {
  const { htmlPath } = fullPlan();
  const { elements } = runPage(htmlPath);
  const flat = (node) => (node.children.length ? node.children.map(flat).join(' ') : node.textContent);

  const handles = flat(elements.get('handlesCard'));
  const notCollected = flat(elements.get('notCollectedCard'));
  assert.match(handles, /What the app handles/);
  assert.match(handles, /Work order records\./);
  assert.match(notCollected, /What the app does not collect/);
  assert.match(notCollected, /No contact list or calendar\./);
  assert.ok(!handles.includes('No contact list'), 'the two lists must not bleed together');

  assert.match(flat(elements.get('batteryList')), /No continuous GPS[\s\S]*geofences/);
});

test('every icon a capability name can select is actually drawn', () => {
  // permissionIconName returns a key into ICON_PATHS. A typo on either side yields
  // "undefined" inside the <svg>, which renders as an empty box rather than failing.
  const template = fs.readFileSync(path.resolve(__dirname, '..', '..', 'assets', 'run-plan.html'), 'utf8');

  const defined = new Set(
    [...template.matchAll(/^    ([a-z]+): '<(?:rect|path|circle|ellipse)/gm)].map((m) => m[1]),
  );
  assert.ok(defined.size >= 10, `expected the full icon set, found ${defined.size}`);

  const selected = [...template.matchAll(/^    \[\/[^\]]*\/, '([a-z]+)'\]/gm)].map((m) => m[1]);
  assert.ok(selected.length > 0, 'the keyword map must select icons');
  for (const key of selected) {
    assert.ok(defined.has(key), `keyword map selects '${key}', which ICON_PATHS does not define`);
  }

  // Callers pass a fallback naming their list ('device', 'plug'); anything unrecognised drops
  // to the hard-coded last resort. All three must be real icons.
  const fallbacks = [
    ...[...template.matchAll(/permissionIcon\([^)]*?'([a-z]+)'\s*:\s*'([a-z]+)'/g)].flatMap((m) => [m[1], m[2]]),
    (template.match(/return ICON_PATHS\[fallback\] \? fallback : '([a-z]+)';/) || [])[1],
  ].filter(Boolean);
  assert.ok(fallbacks.length >= 3, `expected caller and last-resort fallbacks, got ${fallbacks}`);
  for (const key of fallbacks) {
    assert.ok(defined.has(key), `fallback '${key}' is not a defined icon`);
  }
});

test('a background-tracking capability does not borrow the on-demand location pin', () => {
  // "Background location" contains "location", so keyword order is what keeps the two apart.
  // Getting this wrong would show a never-requested capability with the icon of one the app
  // actively asks for - the exact claim this report exists to make precisely.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-plan-icons-'));
  let state = initState(root, { appName: 'Icons', dataPlatform: 'dataverse' });
  state = setSection(state, 'trust', {
    permissions: [
      { name: 'Location', status: 'on-demand', detail: 'Read on arrival.' },
      { name: 'Background location', status: 'not-requested', detail: 'No geofences.' },
    ],
  }, 'approved');
  save(root, state);

  const { elements, thrown } = runPage(outputPath(root));
  assert.deepEqual(thrown.map((e) => e.message), []);

  const rows = [];
  (function walk(node) {
    if (String(node.className).split(' ').includes('perm')) rows.push(node);
    node.children.forEach(walk);
  })(elements.get('permissionList'));
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].children[0].innerHTML, rows[1].children[0].innerHTML);
});

test('a blocked run shows a waiting-for-input banner, and clears it when unblocked', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-plan-await-'));
  let state = initState(root, { appName: 'Waiting', dataPlatform: 'dataverse' });
  // A section held at `proposed` is the plan showing something for review while the terminal
  // waits on the answer.
  state = setSection(state, 'dataModel', { tables: [] }, 'proposed');
  save(root, state);

  let page = runPage(outputPath(root));
  assert.deepEqual(page.thrown.map((e) => e.message), []);
  assert.equal(page.elements.get('inputBanner').hidden, false, 'a proposed section must raise the banner');
  assert.match(page.elements.get('inputBannerPrompt').textContent, /Review the data model/);

  // Approving it is what takes the banner down - nothing else has to remember to.
  state = setSection(state, 'dataModel', { tables: [] }, 'approved');
  save(root, state);
  page = runPage(outputPath(root));
  assert.equal(page.elements.get('inputBanner').hidden, true, 'approval must clear the banner');
});

test('dismissing the banner is scoped to the prompt that was dismissed', () => {
  // Otherwise closing one gate's banner would silently suppress every later gate, and the user
  // would stop being told the run is blocked.
  const template = fs.readFileSync(path.resolve(__dirname, '..', '..', 'assets', 'run-plan.html'), 'utf8');
  assert.match(template, /banner\.hidden = !prompt \|\| dismissedPrompt === prompt/);
  assert.match(template, /if \(!prompt\) dismissedPrompt = null/);
});

test('the topbar pills say what their numbers mean', () => {
  const { htmlPath } = fullPlan();
  const { elements } = runPage(htmlPath);
  // "4 of 11" and "unknown" on their own read as unlabelled noise.
  assert.match(elements.get('pillProgress').textContent, /^Step \d+ of \d+$/);

  const template = fs.readFileSync(path.resolve(__dirname, '..', '..', 'assets', 'run-plan.html'), 'utf8');
  assert.match(template, /pill-platform">Data: __HTML_DATA_PLATFORM__/);
});

test('the planner markdown is linked only once it exists on disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-plan-doc-'));
  const state = initState(root, { appName: 'Linked', dataPlatform: 'dataverse' });
  save(root, state);

  const links = (page) => {
    const found = [];
    for (const [, element] of page.elements) {
      (function walk(node) {
        if (String(node.className).split(' ').includes('plan-doc')) found.push(node);
        node.children.forEach(walk);
      })(element);
    }
    return found;
  };

  // The planner writes native-app-plan.md at Step 3. Before that a link would 404 in the
  // user's browser, so it is not emitted at all.
  assert.deepEqual(links(runPage(outputPath(root))), [], 'no link before the file exists');

  // The plan is written into docs/, so the file sits one level up.
  fs.writeFileSync(path.join(root, 'native-app-plan.md'), '# Plan\n');
  save(root, state);
  const shown = links(runPage(outputPath(root)));
  assert.ok(shown.length >= 1, 'the link appears once the planner has written its output');
  assert.match(shown[0].textContent, /Full screen specs|Read the full plan/);

  // Markdown belongs in an editor, and a browser cannot invoke the OS default app for a link -
  // an editor URL scheme is the only route that works from a file:// page.
  const template = fs.readFileSync(path.resolve(__dirname, '..', '..', 'assets', 'run-plan.html'), 'utf8');
  assert.match(template, /summary\.planDocEditorHref \|\| summary\.planDocHref/,
    'prefer the editor link, but never leave a reader without one stranded');
  assert.match(template, /plan-doc-raw/, 'the plain file link must remain available');
});

test('the full-size screens are linked under the phone, once they exist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-plan-preview-'));
  const state = initState(root, { appName: 'Preview', dataPlatform: 'dataverse' });
  save(root, state);

  const railLink = (page) => {
    const found = [];
    (function walk(node) {
      if (String(node.className).split(' ').includes('rail-link')) found.push(node);
      node.children.forEach(walk);
    })(page.elements.get('railPreviewLink'));
    return found;
  };

  // `/design-system` writes it at Step 6.75; before that the link would 404.
  assert.deepEqual(railLink(runPage(outputPath(root))), [], 'no link before the file exists');

  // Written into docs/, beside the plan, where every reviewable artifact is collected.
  fs.writeFileSync(path.join(root, '_plan_preview.html'), '<html></html>');
  save(root, state);
  const shown = railLink(runPage(outputPath(root)));
  assert.equal(shown.length, 1, 'the link appears once the preview is rendered');
  assert.match(shown[0].textContent, /full size/i);
});

test('the create skill renders the screen preview but never opens it', () => {
  const skill = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'skills', 'create-mobile-app', 'SKILL.md'), 'utf8',
  );

  // The plan shows these screens in its phone frame and links out to the file, so a browser tab
  // opening mid-run interrupts a user who is already watching the plan.
  for (const block of skill.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)) {
    assert.ok(
      !/_plan_preview\.html/.test(block[1]),
      `a runnable command still touches the screen preview: ${block[1].trim().slice(0, 80)}`,
    );
  }
  // It must still be rendered - the carousel takes its markup from those blocks - and it is
  // written into docs/ with every other artifact the user is asked to look at.
  assert.match(skill, /Render `_plan_preview\.html`/);
});

test('the QR is drawn in the phone and linked for scanning full size', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-plan-qr-'));
  const state = initState(root, { appName: 'QR', dataPlatform: 'dataverse' });
  // What the `phone --stage qr --qr-image` CLI path produces: the code inlined for the phone,
  // plus a relative path for opening the file itself.
  setPhone(state, {
    stage: 'qr',
    qrImage: 'data:image/png;base64,iVBORw0KGgo=',
    qrHref: '../.expo/metro-qr.png',
    qrUrl: 'exp://192.168.1.4:8081',
  });
  save(root, state);

  const { elements, thrown } = runPage(outputPath(root));
  assert.deepEqual(thrown.map((e) => e.message), []);

  const links = [];
  (function walk(node) {
    if (String(node.className).split(' ').includes('rail-link')) links.push(node);
    node.children.forEach(walk);
  })(elements.get('railPreviewLink'));
  assert.equal(links.length, 1, 'the QR gets a link under the phone');
  assert.match(links[0].textContent, /QR code full size/);

  // The link must be the file, not the inlined copy: browsers block top-level navigation to a
  // data: URL, so linking the data URI would silently do nothing.
  const template = fs.readFileSync(path.resolve(__dirname, '..', '..', 'assets', 'run-plan.html'), 'utf8');
  assert.match(template, /add\(phone\.qrHref,/);
  assert.doesNotMatch(template, /add\(phone\.qrImage,/);

  // And it is still drawn inside the phone, which is what survives `.expo/` being cleaned.
  const screen = elements.get('deviceScreen');
  const imgs = [];
  (function walk(node) {
    if (node.tagName === 'IMG') imgs.push(node);
    node.children.forEach(walk);
  })(screen);
  assert.equal(imgs.length, 1, 'the QR image stays in the phone frame');

  // A QR is useless without the app that reads it, and this is the end of the run.
  const stores = [];
  (function walk(node) {
    if (String(node.className).split(' ').includes('store-btn')) stores.push(node);
    node.children.forEach(walk);
  })(elements.get('railPreviewLink'));
  assert.equal(stores.length, 2, 'both stores are offered at the QR stage');

  const flatten = (node) => (node.children.length ? node.children.map(flatten).join(' ') : node.textContent);
  assert.match(stores.map(flatten).join(' | '), /App Store[\s\S]*Google Play/);

  // Each badge leads with its store's mark - a text-only pill does not read as a store button.
  const marks = stores.map((button) => {
    const found = [];
    (function walk(node) {
      if (String(node.className).split(' ').includes('store-logo')) found.push(node.innerHTML);
      node.children.forEach(walk);
    })(button);
    return found[0] || '';
  });
  assert.equal(marks.filter((m) => m.startsWith('<svg viewBox="0 0 24 24"')).length, 2,
    'both badges need a drawn mark');
  assert.notEqual(marks[0], marks[1], 'the two stores must not share a mark');
  // The Play mark's colours are its identity, so they are fixed rather than inherited.
  assert.match(marks[1], /fill="#/);
  assert.match(marks[0], /fill="currentColor"/);
});

test('the store links are only offered once the app can actually be used', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-plan-store-'));
  const state = initState(root, { appName: 'Early', dataPlatform: 'dataverse' });
  save(root, state);

  const stores = [];
  (function walk(node) {
    if (String(node.className).split(' ').includes('store-btn')) stores.push(node);
    node.children.forEach(walk);
  })(runPage(outputPath(root)).elements.get('railPreviewLink'));
  // Sending someone to install a player while their app is still being generated hands them
  // something they cannot use yet.
  assert.deepEqual(stores, [], 'no store links during the build');

  const template = fs.readFileSync(path.resolve(__dirname, '..', '..', 'assets', 'run-plan.html'), 'utf8');
  // These are the only links in the plan that leave the machine.
  assert.match(template, /rel', 'noopener noreferrer'/);
  // Locale-neutral: the plan is a file people share across markets.
  assert.doesNotMatch(template, /apps\.apple\.com\/[a-z]{2}\//);
});

test('the skill points at the plan instead of opening the QR in a window', () => {
  const skill = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'skills', 'create-mobile-app', 'SKILL.md'), 'utf8',
  );
  // The plan draws the QR and links it, so a window opening over a run the user is watching
  // adds nothing. Asserted on runnable commands, not prose - the prose states the rule and
  // would trip a naive whole-file match.
  for (const block of skill.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)) {
    assert.ok(
      !/(open|xdg-open|Start-Process|start "")\s+"?\$METRO_QR/.test(block[1]),
      `a runnable command still opens the QR: ${block[1].trim().slice(0, 70)}`,
    );
  }
  assert.match(skill, /do \*\*not\*\* open the PNG/);
});

test('the plan carries the same AI disclaimer as every other plan page', () => {
  const template = fs.readFileSync(path.resolve(__dirname, '..', '..', 'assets', 'run-plan.html'), 'utf8');

  // Worded exactly as the power-pages artifacts word it, so a reader meets one sentence across
  // the plugins rather than a different hedge in each.
  assert.match(template, /<footer class="ai-footer">AI-generated content may be incorrect<\/footer>/);

  // It is fixed to the viewport, so the page and the sticky device rail must both stop short of
  // it; otherwise their last line sits underneath it.
  assert.match(template, /body\{[^}]*padding-bottom:var\(--footer-h\)/);
  assert.match(template, /\.rail\{[^}]*calc\(100vh - 65px - var\(--footer-h\)\)/);
});

test('the carousel says the mockups are not the built app, and only while they are shown', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-plan-note-'));
  const state = initState(root, { appName: 'Note', dataPlatform: 'dataverse' });

  // Building: nothing to caveat yet.
  save(root, state);
  assert.equal(runPage(outputPath(root)).elements.get('railNote').hidden, true);

  // Screens: the user is looking at approximations rendered from the specs.
  setPhone(state, { stage: 'screens', screens: [{ name: 'Today', html: '<div>Today</div>' }] });
  save(root, state);
  const shown = runPage(outputPath(root)).elements.get('railNote');
  assert.equal(shown.hidden, false);
  assert.match(shown.textContent, /mockups[\s\S]*differ/i);

  // QR: the phone now shows a real code, so the caveat would be wrong.
  setPhone(state, { stage: 'qr', qrImage: 'data:image/png;base64,iVBORw0KGgo=' });
  save(root, state);
  assert.equal(runPage(outputPath(root)).elements.get('railNote').hidden, true);
});

test('the page carries a policy that makes injected mockup markup inert', () => {
  const template = fs.readFileSync(path.resolve(__dirname, '..', '..', 'assets', 'run-plan.html'), 'utf8');

  const csp = template.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(csp, 'the plan must ship a CSP');
  const policy = csp[1];

  // Nothing loads unless this policy names it.
  assert.match(policy, /default-src 'none'/);
  // A script injected through a mockup carries no nonce, and inline handlers need
  // 'unsafe-inline', which is deliberately absent from script-src.
  assert.match(policy, /script-src 'nonce-__ATTR_CSP_NONCE__' https:\/\/cdn\.jsdelivr\.net/);
  assert.doesNotMatch(policy.match(/script-src[^;]*/)[0], /unsafe-inline|unsafe-eval/);
  // Every image the plan shows is inlined, so an injected <img src> cannot call out.
  assert.match(policy, /img-src data:/);
  assert.doesNotMatch(policy, /connect-src|frame-src/);

  // The nonce the policy names must be the one the page's own scripts carry.
  assert.ok(template.includes('<script nonce="__ATTR_CSP_NONCE__"'), 'page scripts need the nonce');
});

test('generated markup is cleaned before it reaches the document', () => {
  const template = fs.readFileSync(path.resolve(__dirname, '..', '..', 'assets', 'run-plan.html'), 'utf8');

  // Parsed into a <template>, whose content is inert: nothing runs and no resource is fetched
  // while it is being cleaned.
  assert.match(template, /holder\.content\.querySelectorAll\('\*'\)/);
  for (const tag of ['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'FORM']) {
    assert.ok(template.includes(`'${tag}'`), `${tag} must be stripped from mockups`);
  }
  assert.match(template, /\/\^on\/i\.test\(name\)/, 'every on* handler must be removed');
  assert.match(template, /javascript:\|data:text\\\/html/, 'executing and navigating URLs must be refused');

  // The two places that take generated markup both go through it.
  const sanitized = [...template.matchAll(/appendChild\(sanitizeMockup\(/g)];
  assert.equal(sanitized.length, 2, 'mockups and mermaid output both need cleaning');
  // And neither assigns it straight in.
  assert.doesNotMatch(template, /frame\.innerHTML/);
  assert.doesNotMatch(template, /panel\.innerHTML = result\.svg/);
});

test('the third-party script is pinned by version and by content', () => {
  const template = fs.readFileSync(path.resolve(__dirname, '..', '..', 'assets', 'run-plan.html'), 'utf8');

  const tag = template.match(/<script[^>]*cdn\.jsdelivr\.net[^>]*>/s);
  assert.ok(tag, 'the page loads one script from the CDN');
  const attrs = tag[0];

  // A floating major resolves to whatever is latest when the plan is opened, so the code running
  // inside a page holding the environment URL, tenant id and the whole plan could change with
  // nothing changing here.
  assert.doesNotMatch(attrs, /mermaid@\d+\//, 'the version must be exact, not a floating major');
  assert.match(attrs, /mermaid@\d+\.\d+\.\d+\//);

  // The CSP pins where a script may come from; only integrity pins what it is.
  assert.match(attrs, /integrity="sha(256|384|512)-[A-Za-z0-9+/]+={0,2}"/);
  // Integrity is not enforced on a cross-origin script without this.
  assert.match(attrs, /crossorigin="anonymous"/);
  // And it still carries the nonce the CSP names.
  assert.match(attrs, /nonce="__ATTR_CSP_NONCE__"/);

  // A refusal must degrade, not break: the page falls back to the diagram source.
  assert.match(template, /typeof mermaid === 'undefined'/);
  assert.match(template, /Mermaid could not load/);
});

test('two relationships between the same tables both survive into the diagram', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-plan-rels-'));
  let state = initState(root, { appName: 'Rels', dataPlatform: 'dataverse' });
  state = setSection(state, 'dataModel', {
    tables: [
      {
        logicalName: 'contoso_request', displayName: 'Request', status: 'new',
        columns: [{ logicalName: 'contoso_requestid', type: 'Unique identifier', key: 'PK' }],
        // A requester and an approver lookup to the same table. Keying the dedup on the table
        // pair alone drew the first and silently dropped the second.
        relationships: [
          { relatedTable: 'systemuser', name: 'requested by', cardinality: 'N:1' },
          { relatedTable: 'systemuser', name: 'approved by', cardinality: 'N:1' },
        ],
      },
      {
        logicalName: 'systemuser', displayName: 'User', status: 'reused',
        columns: [{ logicalName: 'systemuserid', type: 'Unique identifier', key: 'PK' }],
        relationships: [],
      },
    ],
  }, 'approved');
  save(root, state);

  const { diagrams, thrown } = runPage(outputPath(root));
  assert.deepEqual(thrown.map((e) => e.message), []);
  const er = diagrams.find((d) => d.source.startsWith('erDiagram'));
  assert.ok(er, 'the ER diagram must render');
  assert.match(er.source, /"requested by"/);
  assert.match(er.source, /"approved by"/);

  // The reverse declaration of the same relationship is still suppressed.
  const edges = [...er.source.matchAll(/^ {4}\S+ \S+ \S+ : "([^"]+)"$/gm)].map((m) => m[1]);
  assert.equal(edges.length, new Set(edges).size, 'no relationship may be drawn twice');
});

test('the two plan-document links are siblings, not one inside the other', () => {
  const template = fs.readFileSync(path.resolve(__dirname, '..', '..', 'assets', 'run-plan.html'), 'utf8');
  // An <a> inside an <a> is invalid and leaves keyboard and screen-reader users with an
  // ambiguous control.
  assert.doesNotMatch(template, /link\.appendChild\(raw\)/);
  assert.match(template, /container\.appendChild\(link\);\s*\n\s*container\.appendChild\(raw\);/);
});

test('every function the page defines is defined exactly once', () => {
  // `showSource` was defined twice, the second copy silently replacing the first. Duplicates are
  // invisible at runtime, so the only way to see one is to count the definitions.
  const template = fs.readFileSync(path.resolve(__dirname, '..', '..', 'assets', 'run-plan.html'), 'utf8');
  const counts = new Map();
  for (const [, name] of template.matchAll(/^ {2}function ([A-Za-z0-9_]+)\(/gm)) {
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([name]) => name);
  assert.deepEqual(duplicates, [], 'these functions are defined more than once');
});
