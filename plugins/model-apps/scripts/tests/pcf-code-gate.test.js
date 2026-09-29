'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseManifest } = require('../lib/pcf-manifest.js');
const { scanSource, featureCoherence, gateSources } = require('../lib/pcf-code-gate.js');

const FILE = 'src/index.ts';

function codes(findings) {
  return findings.map((finding) => finding.code).sort();
}

function scan(text, options = {}) {
  return scanSource(FILE, text, { controlType: 'standard', ...options });
}

function scanFile(file, text, options = {}) {
  return scanSource(file, text, { controlType: 'standard', ...options });
}

function assertCode(findings, code, severity, expectedFile = FILE) {
  const finding = findings.find((item) => item.code === code);
  assert.ok(finding, `${code} missing from ${codes(findings).join(', ')}`);
  assert.equal(finding.severity, severity);
  assert.equal(finding.file, expectedFile);
  assert.equal(typeof finding.line, 'number');
  assert.ok(finding.line > 0);
  assert.match(finding.message, /unsupported|unsafe|internal|manifest|feature|Pages|virtual|updateView|unsupported API/i);
  assert.match(finding.message, /use|read|declare|guard|avoid|replace|move|bind|let|prefer/i);
  assert.match(finding.message, /https:\/\/learn\.microsoft\.com\//);
  return finding;
}

function assertClean(text, options = {}) {
  assert.deepEqual(scan(text, options), []);
}

function manifest(features = '') {
  const xml = `<?xml version="1.0" encoding="utf-8" ?>
  <manifest>
    <control namespace="Contoso.Controls" constructor="Gate" version="1.0.0" display-name-key="Gate" description-key="Gate">
      <resources><code path="index.ts" /></resources>
      ${features ? `<feature-usage>${features}</feature-usage>` : ''}
    </control>
  </manifest>`;
  const parsed = parseManifest(xml);
  assert.deepEqual(parsed.errors, []);
  return parsed.model;
}

function usesFeature(name, required = 'false') {
  return `<uses-feature name="${name}" required="${required}" />`;
}

const sourceRuleCases = [
  ['PCF_CODE_XRM', 'const id = Xrm.Page.data.entity.getId();', 'const id = context.parameters.entityId.raw;'],
  ['PCF_CODE_PARENT_WINDOW', 'const host = window.parent.location.href;', 'const host = context.client.getClientUrl();'],
  ['PCF_CODE_PARENT_WINDOW', 'parent.Xrm.Page.data.refresh();', 'const refresh = context.webAPI.retrieveRecord;'],
  ['PCF_CODE_EVAL', 'eval("alert(1)");', 'const fn = () => "safe";'],
  ['PCF_CODE_EVAL', 'const fn = new Function("return 1");', 'const fn = () => 1;'],
  ['PCF_CODE_RAW_ASSIGN', 'context.parameters.rating.raw = 5;', 'notifyOutputChanged();'],
  ['PCF_CODE_HOST_DOM', 'document.querySelector("#app");', 'container.querySelector("#app");'],
  ['PCF_CODE_HOST_DOM', 'document.body.classList.add("x");', 'container.classList.add("x");'],
  ['PCF_CODE_INNERHTML', 'container.innerHTML = "<p>x</p>";', 'container.textContent = "x";'],
  ['PCF_CODE_INNERHTML', 'return <div dangerouslySetInnerHTML={{ __html: label }} />;', 'return <div>{label}</div>;'],
  ['PCF_CODE_STORAGE', 'localStorage.setItem("key", value);', 'this.state.value = value;'],
  ['PCF_CODE_STORAGE', 'sessionStorage.getItem("key");', 'this.state.value;'],
  ['PCF_CODE_DIRECT_API', 'const url = "/api/data/v9.2/accounts";', 'context.webAPI.retrieveMultipleRecords("account");'],
  ['PCF_CODE_REFRESH_IN_UPDATEVIEW', 'updateView(context) { context.parameters.rows.refresh(); }', 'updateView(context) { this.lastContext = context; }'],
  ['PCF_CODE_INTERNAL_CONTEXT', 'const id = context.mode.contextInfo.entityId;', 'const id = context.parameters.entityId.raw;'],
  ['PCF_CODE_INTERNAL_CONTEXT', 'const page = context.page;', 'const id = context.parameters.entityId.raw;'],
  ['PCF_CODE_INTERNAL_CONTEXT', 'const page = (context as any).page;', 'const name = context.parameters.entityName.raw;'],
  ['PCF_CODE_INTERNAL_CONTEXT', '(context as any).factory.fireEvent(eventName, customizer);', 'context.factory.requestRender();'],
];

for (const [code, bad, good] of sourceRuleCases) {
  test(`scanSource reports ${code} for unsupported source`, () => {
    assertCode(scan(bad), code, code === 'PCF_CODE_HOST_DOM' || code === 'PCF_CODE_INNERHTML' || code === 'PCF_CODE_STORAGE' || code === 'PCF_CODE_DIRECT_API' || code === 'PCF_CODE_REFRESH_IN_UPDATEVIEW' ? 'warning' : 'error');
  });

  test(`scanSource does not report ${code} for supported source`, () => {
    assert.ok(!codes(scan(good)).includes(code));
  });

  test(`scanSource ignores ${code} tokens that appear only in comments or strings`, () => {
    if (code === 'PCF_CODE_DIRECT_API') {
      assert.deepEqual(scan('// "/api/data/v9.2/accounts"'), []);
    } else {
      assert.deepEqual(scan(`// ${bad}\nconst note = ${JSON.stringify(bad)};`), []);
    }
  });
}

test('scanSource reports PCF_VIRTUAL_OWN_ROOT for virtual controls that create their own React root', () => {
  assertCode(scan('ReactDOM.render(<App />, container);', { controlType: 'virtual' }), 'PCF_VIRTUAL_OWN_ROOT', 'error');
  assertCode(scan('createRoot(container).render(<App />);', { controlType: 'virtual' }), 'PCF_VIRTUAL_OWN_ROOT', 'error');
});

test('scanSource allows non-virtual controls to own their React root', () => {
  assertClean('ReactDOM.render(<App />, container);');
  assertClean('createRoot(container).render(<App />);');
});

test('scanSource ignores virtual-root tokens that appear only in comments or strings', () => {
  assert.deepEqual(scan('// ReactDOM.render(<App />, container)\nconst s = "createRoot(container)";', { controlType: 'virtual' }), []);
});

test('scanSource preserves source line numbers after masking comments and strings', () => {
  const findings = scan('const s = "Xrm.Page";\n// eval("x")\n\ncontext.page.getInput();');

  assert.equal(assertCode(findings, 'PCF_CODE_INTERNAL_CONTEXT', 'error').line, 4);
});

test('scanSource allows the documented grid customizer bridge marker to call factory.fireEvent', () => {
  assert.deepEqual(scanFile('src/customizerBridge.ts', `// pcf-extension-pattern: grid-customizer
// Adapter for the documented grid customizer template.
(context as any).factory.fireEvent(eventName, customizer);`), []);
});

test('scanSource does not allow the grid customizer marker outside customizerBridge files', () => {
  assertCode(scan(`// pcf-extension-pattern: grid-customizer
// Marker belongs in customizerBridge.ts only.
(context as any).factory.fireEvent(eventName, customizer);`), 'PCF_CODE_INTERNAL_CONTEXT', 'error');
});

test('scanSource reports refresh inside TypeScript-annotated updateView methods', () => {
  assertCode(scan(`
export class Control {
  public updateView(context: ComponentFramework.Context<IInputs>): void {
    context.parameters.rows.refresh();
  }
}`), 'PCF_CODE_REFRESH_IN_UPDATEVIEW', 'warning');

  assertCode(scanFile('src/index.tsx', `
export class Control {
  public updateView(context: ComponentFramework.Context<IInputs>): React.ReactElement {
    context.parameters.rows.refresh();
    return <span />;
  }
}`), 'PCF_CODE_REFRESH_IN_UPDATEVIEW', 'warning', 'src/index.tsx');
});

test('scanSource does not report refresh in helpers outside updateView', () => {
  assert.deepEqual(scan(`
export class Control {
  public updateView(context: ComponentFramework.Context<IInputs>): void {
    this.refreshRows(context);
  }

  private refreshRows(context: ComponentFramework.Context<IInputs>): void {
    context.parameters.rows.refresh();
  }
}`), []);
});

test('scanSource reports direct API URLs in strings and templates but not JSX text', () => {
  assertCode(scan('fetch("/api/data/v9.2/accounts");'), 'PCF_CODE_DIRECT_API', 'warning');
  assertCode(scan("const u = '/api/data/v9.2/accounts';"), 'PCF_CODE_DIRECT_API', 'warning');
  assertCode(scan('const url = `${context.client.getClientUrl()}/api/data/v9.2/accounts`;'), 'PCF_CODE_DIRECT_API', 'warning');
  assert.deepEqual(scanFile('src/index.tsx', 'export const Help = () => <span>/api/data/ docs</span>;'), []);
  assert.deepEqual(scanFile('src/index.tsx', 'export const Help = () => <span>"/api/data/" docs</span>;'), []);
});

test('scanSource turns lexer failures into unparseable warnings', () => {
  const findings = scanSource('src/broken.ts', 'const x = 1;', {
    controlType: 'standard',
    lex: () => {
      throw new Error('simulated lexer failure');
    },
  });

  assertCode(findings, 'PCF_CODE_UNPARSEABLE', 'warning', 'src/broken.ts');
});

test('featureCoherence reports undeclared WebAPI use and passes when declared', () => {
  assertCode(featureCoherence(manifest(), [{ file: FILE, text: 'context.webAPI.retrieveMultipleRecords("account");' }], ['model']), 'PCF_FEATURE_UNDECLARED', 'error');
  assert.deepEqual(featureCoherence(manifest(usesFeature('WebAPI')), [{ file: FILE, text: 'context.webAPI.retrieveMultipleRecords("account");' }], ['model']), []);
});

test('featureCoherence treats optional-chained WebAPI use as feature use', () => {
  assertCode(featureCoherence(manifest(), [{ file: FILE, text: 'context.webAPI?.retrieveMultipleRecords("account");' }], ['model']), 'PCF_FEATURE_UNDECLARED', 'error');
  assert.deepEqual(featureCoherence(manifest(usesFeature('WebAPI')), [{ file: FILE, text: 'context.webAPI?.retrieveMultipleRecords("account");' }], ['model']), []);
});

test('featureCoherence turns lexer failures into unparseable warnings', () => {
  const findings = featureCoherence(manifest(), [{ file: 'src/broken.ts', text: 'context.webAPI.retrieveRecord("account", id);' }], ['model'], {
    lex: () => {
      throw new Error('simulated lexer failure');
    },
  });

  assertCode(findings, 'PCF_CODE_UNPARSEABLE', 'warning', 'src/broken.ts');
});

test('featureCoherence ignores WebAPI words that appear only in comments or strings', () => {
  assert.deepEqual(featureCoherence(manifest(), [{ file: FILE, text: '// context.webAPI.retrieveRecord\nconst s = "context.webAPI";' }], ['model']), []);
});

test('featureCoherence reports undeclared Utility use and passes when declared', () => {
  assertCode(featureCoherence(manifest(), [{ file: FILE, text: 'context.utils.lookupObjects({});' }], ['model']), 'PCF_FEATURE_UNDECLARED', 'error');
  assert.deepEqual(featureCoherence(manifest(usesFeature('Utility')), [{ file: FILE, text: 'context.utils.lookupObjects({});' }], ['model']), []);
});

test('featureCoherence treats optional-chained Utility use as feature use and Pages API use', () => {
  const text = 'context.utils?.getEntityMetadata("account");';

  assertCode(featureCoherence(manifest(), [{ file: FILE, text }], ['model']), 'PCF_FEATURE_UNDECLARED', 'error');
  assertCode(featureCoherence(manifest(usesFeature('Utility')), [{ file: FILE, text }], ['pages']), 'PCF_PAGES_API', 'error');
});

test('featureCoherence ignores Utility words that appear only in comments or strings', () => {
  assert.deepEqual(featureCoherence(manifest(), [{ file: FILE, text: '// context.utils.lookupObjects\nconst s = "context.utils";' }], ['model']), []);
});

test('featureCoherence reports undeclared Device method use and passes when declared', () => {
  assertCode(featureCoherence(manifest(), [{ file: FILE, text: 'context.device.captureImage();' }], ['model']), 'PCF_FEATURE_UNDECLARED', 'error');
  assert.deepEqual(featureCoherence(manifest(usesFeature('Device.captureImage')), [{ file: FILE, text: 'context.device.captureImage();' }], ['model']), []);
});

test('featureCoherence treats optional-chained Device method calls as feature and Pages API use', () => {
  const text = 'context.device?.captureImage?.();';

  assertCode(featureCoherence(manifest(), [{ file: FILE, text }], ['model']), 'PCF_FEATURE_UNDECLARED', 'error');
  assertCode(featureCoherence(manifest(usesFeature('Device.captureImage')), [{ file: FILE, text }], ['pages']), 'PCF_PAGES_API', 'error');
});

test('featureCoherence ignores Device words that appear only in comments or strings', () => {
  assert.deepEqual(featureCoherence(manifest(), [{ file: FILE, text: '// context.device.captureImage\nconst s = "context.device.captureImage";' }], ['model']), []);
});

test('featureCoherence reports unused declared features and passes when each feature is used', () => {
  assertCode(featureCoherence(manifest(usesFeature('WebAPI')), [{ file: FILE, text: 'context.parameters.name.raw;' }], ['model']), 'PCF_FEATURE_UNUSED', 'warning', '<manifest>');
  assert.deepEqual(featureCoherence(manifest(`${usesFeature('WebAPI')}${usesFeature('Utility')}${usesFeature('Device.captureImage')}`), [{ file: FILE, text: 'context.webAPI.retrieveRecord("account", id); context.utils.lookupObjects({}); context.device.captureImage();' }], ['model']), []);
});

test('featureCoherence reports Pages device calls without method-level guards and passes with method-level guards', () => {
  assertCode(featureCoherence(manifest(usesFeature('Device.captureImage')), [{ file: FILE, text: 'if (context.device) { context.device.captureImage(); }' }], ['pages']), 'PCF_PAGES_API', 'error');
  assert.deepEqual(featureCoherence(manifest(usesFeature('Device.captureImage')), [{ file: FILE, text: 'if (typeof context.device?.captureImage === "function") { context.device.captureImage(); }' }], ['pages']), []);
});

test('featureCoherence rejects unsafe dotted method guards and accepts namespace plus method guards', () => {
  assertCode(featureCoherence(manifest(usesFeature('Device.captureImage')), [{ file: FILE, text: 'if (typeof context.device.captureImage === "function") { context.device.captureImage(); }' }], ['pages']), 'PCF_PAGES_API', 'error');
  assert.deepEqual(featureCoherence(manifest(usesFeature('Device.captureImage')), [{ file: FILE, text: 'if (context.device && typeof context.device.captureImage === "function") { context.device.captureImage(); }' }], ['pages']), []);
});

test('featureCoherence accepts parenthesized and composed method guards', () => {
  assert.deepEqual(featureCoherence(manifest(usesFeature('Device.captureImage')), [{ file: FILE, text: 'if ((typeof context.device?.captureImage === "function")) { context.device.captureImage(); }' }], ['pages']), []);
  assert.deepEqual(featureCoherence(manifest(usesFeature('Device.captureImage')), [{ file: FILE, text: 'if (ready && typeof context.device?.captureImage === "function") { context.device.captureImage(); }' }], ['pages']), []);
  assert.deepEqual(featureCoherence(manifest(usesFeature('Device.captureImage')), [{ file: FILE, text: 'if (ready && context.device && typeof context.device.captureImage === "function") { context.device.captureImage(); }' }], ['pages']), []);
});

test('featureCoherence does not treat a string-only method guard as a Pages guard', () => {
  assertCode(featureCoherence(manifest(usesFeature('Device.captureImage')), [{ file: FILE, text: 'const note = \'typeof context.device?.captureImage === "function"\'; context.device.captureImage();' }], ['pages']), 'PCF_PAGES_API', 'error');
});

test('featureCoherence does not treat a comment-only method guard as a Pages guard', () => {
  assertCode(featureCoherence(manifest(usesFeature('Device.captureImage')), [{ file: FILE, text: '// if (typeof context.device?.captureImage === "function") {\ncontext.device.captureImage();' }], ['pages']), 'PCF_PAGES_API', 'error');
});

test('featureCoherence reports Pages utility calls without method-level guards and passes with method-level guards', () => {
  assertCode(featureCoherence(manifest(usesFeature('Utility')), [{ file: FILE, text: 'if (context.utils) { context.utils.lookupObjects({}); }' }], ['pages']), 'PCF_PAGES_API', 'error');
  assert.deepEqual(featureCoherence(manifest(usesFeature('Utility')), [{ file: FILE, text: 'if (typeof context.utils?.lookupObjects === "function") { context.utils.lookupObjects({}); }' }], ['pages']), []);
});

test('featureCoherence ignores Pages API words that appear only in comments or strings', () => {
  assert.deepEqual(featureCoherence(manifest(), [{ file: FILE, text: '// context.device.captureImage\nconst s = "context.utils.lookupObjects";' }], ['pages']), []);
});

test('gateSources partitions errors and warnings and labels code-gate output as heuristic diagnostics', () => {
  const result = gateSources({
    manifestModel: manifest(),
    sources: [{ file: FILE, text: 'Xrm.Page.data.refresh(); document.body; context.webAPI.retrieveRecord("account", id);' }],
    hosts: ['model'],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(codes(result.errors), ['PCF_CODE_XRM', 'PCF_FEATURE_UNDECLARED']);
  assert.deepEqual(codes(result.warnings), ['PCF_CODE_HOST_DOM']);
  for (const finding of [...result.errors, ...result.warnings]) {
    assert.match(finding.message, /heuristic diagnostic/i);
  }
});
