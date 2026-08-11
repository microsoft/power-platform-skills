const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const scriptsDir = path.join(__dirname, '..');
const attack = '<img src=x onerror="globalThis.pwned=1"> \' "</script><script>globalThis.pwned=2</script> ` ${globalThis.pwned=3}';

const DATA_MODEL_DATA = {
  SITE_NAME: 'Contoso Portal',
  SUMMARY: 'A customer order data model.',
  PREFIX: 'cr123',
  TABLES_DATA: [{
    id: 'cr123_order',
    logicalName: 'cr123_order',
    displayName: 'Order',
    status: 'new',
    rationale: 'Stores customer orders.',
    columns: [{
      logicalName: 'cr123_orderid',
      displayName: 'Order ID',
      type: 'Uniqueidentifier',
      required: true,
      key: 'PK',
      isNew: true,
    }],
    relationships: [],
  }],
  RATIONALE_DATA: [{ icon: '🏗️', title: 'Simple ownership', desc: 'Orders belong to contacts.' }],
  ER_DIAGRAM: 'erDiagram\n    CONTACT ||--o{ CR123_ORDER : places',
};

const PERMISSIONS_DATA = {
  SITE_NAME: 'Contoso Portal',
  SUMMARY: 'Contact-scoped order permissions.',
  ROLES_DATA: [{
    id: 'r1',
    name: 'Authenticated Users',
    desc: 'Signed-in customers',
    builtin: true,
    isNew: false,
    color: '#8890a4',
  }],
  PERMISSIONS_DATA: [{
    id: 'p1',
    name: 'Order - Contact',
    displayName: 'Order',
    table: 'cr123_order',
    scope: 'Contact',
    read: true,
    create: true,
    write: true,
    delete: false,
    append: false,
    appendto: false,
    roles: ['r1'],
    parent: null,
    parentRelationship: null,
    rationale: { scope: 'Customers only access their own orders.', read: 'Shows order history.' },
    isNew: true,
  }],
  RATIONALE_DATA: [{ icon: '🔒', title: 'Least privilege', desc: 'Contact scope isolates records.' }],
};

function render(scriptName, data) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'plan.html');
  fs.writeFileSync(dataPath, JSON.stringify(data), 'utf8');

  const result = spawnSync(
    process.execPath,
    [path.join(scriptsDir, scriptName), '--output', outputPath, '--data', dataPath],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return fs.readFileSync(outputPath, 'utf8');
}

class FakeElement {
  constructor() {
    this._innerHTML = '';
    this._textContent = '';
    this.style = {};
    this.dataset = {};
    this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
    this.parentElement = this;
  }

  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) { this._innerHTML = String(value ?? ''); }
  get textContent() { return this._textContent; }
  set textContent(value) {
    this._textContent = String(value ?? '');
    this._innerHTML = this._textContent
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  setSourceText(value) {
    this._textContent = value;
    this._innerHTML = value;
  }

  addEventListener() {}
  appendChild() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  setAttribute() {}
  remove() {}
}

function executeInlineRenderer(html, { skipMermaid = false, svg = null } = {}) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const inline = scripts.find((match) =>
    !/\bsrc\s*=/.test(match[1]) && !/\btype\s*=\s*"application\/json"/.test(match[1])
  );
  assert.ok(inline, 'expected an inline report renderer');

  let source = inline[2];
  if (skipMermaid) {
    source = source.replace(
      /mermaid\.initialize\([\s\S]*?\);\s*renderRationale\(\);\s*renderTables\(\);\s*renderErDiagram\(\);\s*$/,
      `renderRationale();\nrenderTables();${svg ? "\ncolorErDiagram(document.getElementById('erDiagram'));" : ''}`
    );
  }

  const elements = new Map();
  for (const match of html.matchAll(/<script id="([^"]+)" type="application\/json">([\s\S]*?)<\/script>/gi)) {
    const element = new FakeElement();
    element.setSourceText(match[2]);
    elements.set(match[1], element);
  }
  if (svg) {
    const erDiagram = new FakeElement();
    erDiagram.querySelector = (selector) => selector === 'svg' ? svg : null;
    elements.set('erDiagram', erDiagram);
  }
  const document = {
    head: new FakeElement(),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement());
      return elements.get(id);
    },
    querySelector() { return new FakeElement(); },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement() { return new FakeElement(); },
    importNode(node) { return node; },
  };

  vm.runInNewContext(source, {
    document,
    console,
    mermaid: { initialize() {}, render() { throw new Error('not used by this test'); } },
    requestAnimationFrame(callback) { callback(); },
    DOMParser: class {},
    URL,
  });

  return elements;
}

function assertCsp(html) {
  const nonce = html.match(/script-src 'nonce-([^']+)'/)[1];
  assert.ok(nonce);
  assert.match(html, new RegExp(`<script nonce="${nonce.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.doesNotMatch(html, /\sonclick=/i);
}

test('ordinary data model and permissions plans still render', () => {
  const dataModelHtml = render('render-data-model-plan.js', DATA_MODEL_DATA);
  const permissionsHtml = render('render-permissions-plan.js', PERMISSIONS_DATA);

  assert.match(dataModelHtml, /Contoso Portal/);
  assert.match(dataModelHtml, /cr123_order/);
  assert.match(dataModelHtml, /const ER_DIAGRAM = "erDiagram\\n/);
  assert.match(permissionsHtml, /Contact-scoped order permissions\./);
  assert.match(permissionsHtml, /Authenticated Users/);
  assertCsp(dataModelHtml);
  assertCsp(permissionsHtml);
});

test('data model plan neutralizes hostile text in placeholders, JSON, and innerHTML rendering', () => {
  const hostile = {
    ...DATA_MODEL_DATA,
    SITE_NAME: attack,
    SUMMARY: attack,
    PREFIX: attack,
    ER_DIAGRAM: attack,
    TABLES_DATA: [{
      ...DATA_MODEL_DATA.TABLES_DATA[0],
      logicalName: attack,
      displayName: attack,
      rationale: attack,
      columns: [{
        ...DATA_MODEL_DATA.TABLES_DATA[0].columns[0],
        logicalName: attack,
        displayName: attack,
        type: attack,
      }],
      relationships: [{ description: attack, relatedTable: attack, type: attack, foreignKey: attack }],
    }],
    RATIONALE_DATA: [{ icon: attack, title: attack, desc: attack }],
  };

  const html = render('render-data-model-plan.js', hostile);
  assert.doesNotMatch(html, /<\/script><script>globalThis\.pwned/);
  assert.match(html, /\\u003c\/script\\u003e\\u003cscript\\u003e/);
  assert.match(html, /const ER_DIAGRAM = "[^"]*\\u003cimg/);

  const elements = executeInlineRenderer(html, { skipMermaid: true });
  const rendered = elements.get('rationaleContainer').innerHTML + elements.get('tablesContainer').innerHTML;
  assert.doesNotMatch(rendered, /<img\b|<script\b/i);
  assert.match(rendered, /&lt;img src=x onerror=&quot;globalThis\.pwned=1&quot;&gt;/);
});

test('data model plan normalizes unexpected statuses for stats, cards, and SVG colors', () => {
  const attributes = {};
  const fillPath = {
    setAttribute(name, value) { attributes[`fillPath.${name}`] = value; },
  };
  const strokePath = {
    getAttribute() { return '#000000'; },
    setAttribute(name, value) { attributes[`strokePath.${name}`] = value; },
  };
  const headerGroup = {
    tagName: 'g',
    querySelectorAll(selector) { return selector === 'path' ? [fillPath, strokePath] : []; },
  };
  const entityNode = {
    children: [],
    getAttribute(name) { return name === 'id' ? 'erSvg1-entity-CR123_ORDER-0' : null; },
    querySelector(selector) { return selector === '.outer-path' ? headerGroup : null; },
    querySelectorAll() { return []; },
  };
  const svg = {
    querySelectorAll(selector) { return selector === 'g.node' ? [entityNode] : []; },
  };
  const html = render('render-data-model-plan.js', {
    ...DATA_MODEL_DATA,
    TABLES_DATA: [{ ...DATA_MODEL_DATA.TABLES_DATA[0], status: attack }],
  });

  const elements = executeInlineRenderer(html, { skipMermaid: true, svg });

  assert.equal(elements.get('statNew').textContent, '0');
  assert.equal(elements.get('statModified').textContent, '0');
  assert.equal(elements.get('statReused').textContent, '1');
  assert.match(elements.get('tablesContainer').innerHTML, /status-reused">reused<\/span>/);
  assert.equal(attributes['fillPath.fill'], '#c8e6c9');
  assert.equal(attributes['strokePath.stroke'], '#107c10');
  assert.ok(Object.values(attributes).every(value => value !== undefined && value !== 'undefined'));
});

test('permissions plan neutralizes hostile text, event attributes, quotes, and interpolation syntax', () => {
  const hostile = {
    ...PERMISSIONS_DATA,
    SITE_NAME: attack,
    SUMMARY: attack,
    ROLES_DATA: [{ ...PERMISSIONS_DATA.ROLES_DATA[0], name: attack, desc: attack, color: attack }],
    PERMISSIONS_DATA: [{
      ...PERMISSIONS_DATA.PERMISSIONS_DATA[0],
      name: attack,
      displayName: attack,
      table: attack,
      scope: attack,
      parentRelationship: attack,
      rationale: { scope: attack, read: attack },
    }],
    RATIONALE_DATA: [{ icon: attack, title: attack, desc: attack }],
  };

  const html = render('render-permissions-plan.js', hostile);
  assert.doesNotMatch(html, /<\/script><script>globalThis\.pwned/);
  assert.match(html, /\\u003cimg src=x onerror=\\"globalThis\.pwned=1\\"/);

  const elements = executeInlineRenderer(html);
  const rendered = [
    elements.get('rationaleContainer').innerHTML,
    elements.get('rolesContainer').innerHTML,
    elements.get('permsContainer').innerHTML,
  ].join('');
  assert.doesNotMatch(rendered, /<img\b|<script\b|onclick=/i);
  assert.match(rendered, /&lt;img src=x onerror=&quot;globalThis\.pwned=1&quot;&gt;/);
  assert.match(rendered, /` \$\{globalThis\.pwned=3\}/);
});

test('cloud flow and server logic plans escape nested values before innerHTML rendering', () => {
  const role = {
    id: 'r1',
    name: attack,
    desc: attack,
    builtin: false,
    isNew: true,
    color: attack,
  };
  const cloudFlowHtml = render('render-cloudflow-plan.js', {
    SITE_NAME: attack,
    PLAN_TITLE: 'Cloud Flow Plan',
    SUMMARY: attack,
    WEB_ROLES_DATA: [role],
    CLOUD_FLOWS_DATA: [{
      id: 'flow-1',
      name: attack,
      displayName: attack,
      flowId: attack,
      state: attack,
      description: attack,
      scenario: attack,
      rationale: attack,
      webRoles: [{ id: 'r1', reasoning: attack }],
    }],
    RATIONALE_DATA: [{ icon: attack, title: attack, desc: attack }],
  });
  const cloudElements = executeInlineRenderer(cloudFlowHtml);
  const cloudRendered = ['flowSummary', 'rationaleContainer', 'rolesContainer', 'flowsContainer']
    .map(id => cloudElements.get(id).innerHTML)
    .join('');
  assert.doesNotMatch(cloudRendered, /<img\b|<script\b|onclick=/i);
  assert.match(cloudRendered, /&lt;img src=x onerror=&quot;globalThis\.pwned=1&quot;&gt;/);

  const serverLogicHtml = render('render-serverlogic-plan.js', {
    SITE_NAME: attack,
    PLAN_TITLE: 'Server Logic Plan',
    SUMMARY: attack,
    WEB_ROLES_DATA: [role],
    SERVER_LOGICS_DATA: [{
      id: 'logic-1',
      name: attack,
      displayName: attack,
      status: 'create',
      apiUrl: attack,
      rationale: attack,
      webRoles: [{ id: 'r1', reasoning: attack }],
      functions: [{ name: attack, purpose: attack, reasoning: attack }],
    }],
    RATIONALE_DATA: [{ icon: attack, title: attack, desc: attack }],
    SECRETS_DATA: null,
  });
  const serverElements = executeInlineRenderer(serverLogicHtml);
  const serverRendered = ['statusSummary', 'rationaleContainer', 'rolesContainer', 'serverLogicContainer']
    .map(id => serverElements.get(id).innerHTML)
    .join('');
  assert.doesNotMatch(serverRendered, /<img\b|<script\b|onclick=/i);
  assert.match(serverRendered, /&lt;img src=x onerror=&quot;globalThis\.pwned=1&quot;&gt;/);
});

test('backend and create-site plans allowlist dynamic attributes and escape nested text', () => {
  const backendHtml = render('render-backend-plan.js', {
    SITE_NAME: attack,
    PLAN_TITLE: 'Backend Integration Plan',
    SUMMARY: attack,
    ITEMS_DATA: [{
      name: attack,
      approach: 'webapi',
      description: attack,
      reasoning: attack,
      complexity: attack,
      status: attack,
      depends: attack,
      details: [{ label: attack, value: attack }],
      docs: [{ label: attack, url: attack }],
    }],
    RATIONALE_DATA: [{ icon: attack, title: attack, desc: attack }],
    DATA_FLOWS_DATA: [{
      trigger: attack,
      description: attack,
      steps: [{ approach: 'webapi', name: attack, detail: attack }],
    }],
  });
  const backendElements = executeInlineRenderer(backendHtml);
  const backendRendered = ['rationaleContainer', 'dataflowContainer', 'orderContainer', 'itemsContainer']
    .map(id => backendElements.get(id).innerHTML)
    .join('');
  assert.doesNotMatch(backendRendered, /<img\b|<script\b|onclick=/i);
  assert.match(backendRendered, /&lt;img src=x onerror=&quot;globalThis\.pwned=1&quot;&gt;/);
  assert.doesNotMatch(backendRendered, /href="javascript:/i);

  const createSiteHtml = render('render-createsite-plan.js', {
    SITE_NAME: attack,
    PLAN_TITLE: 'Implementation Plan',
    FRAMEWORK: attack,
    AESTHETIC: attack,
    MOOD: attack,
    SUMMARY: attack,
    TYPOGRAPHY_DATA: {
      primary: { name: attack, sample: attack, reason: attack },
      secondary: null,
    },
    PALETTE_DATA: [{ var: attack, hex: attack, description: attack }],
    MOTION_DATA: [{ label: attack, description: attack }],
    BACKGROUNDS_DATA: [{ label: attack, description: attack }],
    PAGES_DATA: [{ name: attack, route: attack, description: attack, content: [attack], components: [attack] }],
    COMPONENTS_DATA: [{ name: attack, purpose: attack, usedBy: [attack] }],
    ROUTES_DATA: [{ path: attack, page: attack }],
    REVIEW_DATA: [attack],
    DEPLOYMENT_DATA: [{ title: attack, description: attack, recommended: true }],
  });
  const createSiteElements = executeInlineRenderer(createSiteHtml);
  const createSiteRendered = [
    'typographyContainer',
    'paletteContainer',
    'motionContainer',
    'backgroundsContainer',
    'pagesContainer',
    'componentsContainer',
    'routesBody',
    'reviewContainer',
    'deploymentContainer',
  ].map(id => createSiteElements.get(id).innerHTML).join('');
  assert.doesNotMatch(createSiteRendered, /<img\b|<script\b|onclick=/i);
  assert.match(createSiteRendered, /font-family:var\(--sans\)/);
  assert.match(createSiteRendered, /background:transparent/);
});

test('security review escapes unknown severity labels before composing report HTML', () => {
  const html = render('render-review.js', {
    REPORT_NAME: attack,
    SITE_NAME: attack,
    GOAL_LABEL: attack,
    SCOPE_LABEL: attack,
    GENERATED_AT: '2026-08-06',
    REVIEW_DATA: {
      summary: attack,
      totals: { pass: 1 },
      sections: [{
        id: 'section',
        icon: attack,
        label: attack,
        findings: [{
          id: 'finding',
          severity: attack,
          title: attack,
          details: attack,
        }],
      }],
      nextSteps: [attack],
    },
  });
  const elements = executeInlineRenderer(html);
  const rendered = elements.get('contentRoot').innerHTML + elements.get('sidebar').innerHTML;
  assert.doesNotMatch(rendered, /<img\b|<script\b|onclick=/i);
  assert.match(rendered, /&lt;IMG SRC=X ONERROR=&quot;GLOBALTHIS\.PWNED=1&quot;&gt;/);
});
