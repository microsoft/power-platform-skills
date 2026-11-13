import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gradeArtifacts, inspectHtml, validateContract } from '../artifacts.mjs';
import { closeBrowser } from '../browser-checks.mjs';

after(closeBrowser);
const diagram = `erDiagram
  CUSTOMER ||--o{ ORDER : places
  CUSTOMER {
    string customerid PK
  }
  ORDER {
    string orderid PK
    string customerid FK
  }`;
const modelContract = {
  files: [{
    path: 'docs/model.html', type: 'html', requiredText: ['customer', 'order'],
    headings: ['Customer orders'], minTextLength: 40,
    diagram: {
      entities: [{ name: 'CUSTOMER', attributes: ['customerid'] }, { name: 'ORDER', attributes: ['orderid', 'customerid'] }],
      relationships: [{ from: 'CUSTOMER', to: 'ORDER', cardinality: '||--o{' }],
    },
  }],
};
const document = body => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Customer orders</title><style>body{margin:0;padding:16px;box-sizing:border-box;font:16px system-ui}*{box-sizing:border-box}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body>${body}</body></html>`;
const modelDocument = code => document(`<h1>Customer orders</h1><p>Each order belongs to one customer. A customer can have no orders or many orders.</p><pre class="mermaid">${code.replaceAll('}', '&#125;')}</pre>`);

async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'pp-artifact-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'docs'));
  return root;
}

test('real ER golden renders and records reviewable desktop, mobile, and SVG evidence', async t => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'docs/model.html'), modelDocument(diagram));
  const evidenceDir = path.join(root, 'review');
  const result = await gradeArtifacts({ contract: modelContract, workDir: root, suiteDir: root, evidenceDir });
  assert.equal(result.passed, true, result.evidence);
  assert.ok((await readFile(path.join(evidenceDir, 'model.html-1440.png'))).length > 1000);
  assert.ok((await readFile(path.join(evidenceDir, 'model.html-390.png'))).length > 1000);
  assert.match(await readFile(path.join(evidenceDir, 'model.html-er-1.svg'), 'utf8'), /CUSTOMER/);
});

test('ER syntax, cardinality, and missing attributes fail independently', async t => {
  const root = await workspace(t);
  for (const [label, code] of [
    ['syntax', diagram.replace('||--o{', 'not-an-edge')],
    ['cardinality', diagram.replace('||--o{', '||--||')],
    ['attribute', diagram.replace('string customerid FK', 'string unrelated FK')],
  ]) {
    await writeFile(path.join(root, 'docs/model.html'), modelDocument(code));
    const result = await gradeArtifacts({ contract: modelContract, workDir: root, suiteDir: root });
    assert.equal(result.passed, false, `${label} mutation escaped the grader`);
  }
});

test('equivalent reversed ER edges and logical-name casing are accepted', async t => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'docs/model.html'), modelDocument(diagram.replace('CUSTOMER ||--o{ ORDER', 'ORDER }o--|| CUSTOMER')));
  const contract = structuredClone(modelContract);
  contract.files[0].diagram.entities[0].name = 'customer';
  const result = await gradeArtifacts({ contract, workDir: root, suiteDir: root });
  assert.equal(result.passed, true, result.evidence);
});

test('hidden script claims cannot pass visible document requirements', async t => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'docs/report.html'), document('<h1>Plan</h1><p>No evidence supplied.</p><script>const hidden = "rollback verified";</script>'));
  const result = await gradeArtifacts({
    contract: { files: [{ path: 'docs/report.html', type: 'html', requiredText: ['rollback verified'] }] },
    workDir: root, suiteDir: root,
  });
  assert.equal(result.passed, false);
  assert.match(result.evidence, /rollback verified/);
});

test('rendered tabs are read rather than grading only the initial pane', async t => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'docs/report.html'), document(`
    <h1>Approval plan</h1><button data-tab="details" onclick="document.getElementById('details').hidden=false">Details</button>
    <section id="details" hidden><h2>Rollback</h2><p>Restore the exported source after approval.</p></section>`));
  const result = await gradeArtifacts({
    contract: { files: [{ path: 'docs/report.html', type: 'html', requiredText: ['Restore the exported source'], headings: ['Rollback'] }] },
    workDir: root, suiteDir: root,
  });
  assert.equal(result.passed, true, result.evidence);
});

test('workspace scripts render report content and their runtime errors fail the grade', async t => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'docs/report.html'), document('<h1>Plan</h1><main id="plan"></main><script src="./report.js"></script>'));
  const contract = { files: [{ path: 'docs/report.html', type: 'html', requiredText: ['Local report content'] }] };
  await writeFile(path.join(root, 'docs/report.js'), "document.querySelector('#plan').textContent = 'Local report content';");
  let result = await gradeArtifacts({ contract, workDir: root, suiteDir: root });
  assert.equal(result.passed, true, result.evidence);
  await writeFile(path.join(root, 'docs/report.js'), "document.querySelector('#plan').textContent = 'Local report content'; throw new Error('broken');");
  result = await gradeArtifacts({ contract, workDir: root, suiteDir: root });
  assert.equal(result.passed, false);
  assert.match(result.evidence, /document scripts run without errors/);
});

test('nested disclosures in reports without tabs expose their content and headings', async t => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'docs/report.html'), document(`
    <nav><button aria-expanded="false" onclick="document.getElementById('menu').hidden=false">Menu</button>
    <p id="menu" hidden>Navigation menu opened.</p></nav>
    <h1>Plan</h1><details><summary>More</summary><details><summary>Details</summary>
    <h2>Rollback</h2><p>Restore the exported source after approval.</p></details></details>
    <button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true'); document.getElementById('outer').hidden=false">Security</button>
    <section id="outer" hidden>
      <button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true'); document.getElementById('inner').hidden=false">Access</button>
      <p id="inner" hidden>Confirm least privilege before deployment.</p>
    </section>`));
  const result = await gradeArtifacts({
    contract: { files: [{ path: 'docs/report.html', type: 'html', requiredText: ['Restore the exported source', 'Confirm least privilege'], forbiddenText: ['Navigation menu opened'], headings: ['Rollback'] }] },
    workDir: root, suiteDir: root,
  });
  assert.equal(result.passed, true, result.evidence);
});

test('unfilled renderer tokens and script errors still fail report artifacts', async t => {
  const root = await workspace(t);
  for (const body of [
    '<h1>Plan</h1><p>Approval __SUMMARY__</p>',
    '<h1>Plan</h1><p>Approval</p><script>throw new Error("Broken report");</script>',
  ]) {
    await writeFile(path.join(root, 'docs/report.html'), document(body));
    const result = await gradeArtifacts({
      contract: { files: [{ path: 'docs/report.html', type: 'html', responsive: false, requiredText: ['Approval'] }] },
      workDir: root, suiteDir: root,
    });
    assert.equal(result.passed, false);
  }
});

test('report overflow is allowed while generated sites must fit phone and desktop viewports', async t => {
  const root = await workspace(t);
  const file = { path: 'docs/plan.html', type: 'html', requiredText: ['Repair booking'] };
  await writeFile(path.join(root, file.path), document('<h1>Repair booking</h1><div style="width:600px">Proposed component states</div>'));
  const report = await gradeArtifacts({
    contract: { files: [{ ...file, responsive: false }] }, workDir: root, suiteDir: root,
  });
  assert.equal(report.passed, true, report.evidence);
  assert.ok(!report.details.some(check => /readable.*layout/.test(check.name)));
  const site = await gradeArtifacts({ contract: { files: [file] }, workDir: root, suiteDir: root });
  assert.equal(site.passed, false);
  assert.match(site.evidence, /readable 390px layout/);
  await writeFile(path.join(root, file.path), document('<h1>Repair booking</h1><div style="width:600px;max-width:100%">Working booking form</div>'));
  const responsiveSite = await gradeArtifacts({ contract: { files: [file] }, workDir: root, suiteDir: root });
  assert.equal(responsiveSite.passed, true, responsiveSite.evidence);
});

test('create-site design contract rejects a missing design section and missing design substance', async t => {
  const root = await workspace(t);
  const suiteDir = path.resolve(import.meta.dirname, '../../power-pages/create-site');
  const contract = JSON.parse(await readFile(path.join(suiteDir, 'checks/repair-customer-plan.json'), 'utf8'));
  await mkdir(path.join(root, 'inputs'));
  await writeFile(path.join(root, 'inputs/repair-customer-plan.json'), await readFile(path.join(suiteDir, 'fixtures/repair-customer-plan.json')));
  const plan = '<h1>Contoso Repairs</h1><p>React /book /track. Keyboard booking, loading state, and approval required.</p>';
  const design = `<h2>Design direction</h2><p>Typography pairs a readable body font with compact display headings.
  The palette preserves brand primary #175a40 with white labels at AA contrast.
  The phone-first hero offers booking before the fold; the signature status timeline explains the next repair step.
  Motion confirms state changes, with reduced-motion behavior that removes animated transitions.</p>`;
  for (const [body, expected] of [
    [plan + '<p>' + 'Proposed delivery details. '.repeat(24) + '</p>', false],
    [plan + design.replace('Design direction', 'Experience'), false],
    [plan + design, true],
  ]) {
    await writeFile(path.join(root, 'docs/repair-customer-plan.html'), document(body));
    const result = await gradeArtifacts({ contract, workDir: root, suiteDir });
    assert.equal(result.passed, expected, result.evidence);
  }
});

test('document JavaScript cannot contact even a listening local endpoint', async t => {
  const root = await workspace(t);
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end('forbidden'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/probe`;
  await writeFile(path.join(root, 'docs/report.html'), document(`<h1>Offline plan</h1><p>Approval required.</p><img src="${endpoint}" alt="Blocked external image"><script src="${endpoint}"></script><script>fetch(${JSON.stringify(endpoint)}).catch(()=>{});</script>`));
  const result = await gradeArtifacts({
    contract: { files: [{ path: 'docs/report.html', type: 'html', requiredText: ['Approval required'] }] },
    workDir: root, suiteDir: root,
  });
  assert.equal(result.passed, true, result.evidence);
  assert.equal(requests, 0);
});

test('JSON/YAML parsing, preservation, and absence checks do not silently pass malformed evidence', async t => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'original.txt'), 'original');
  await writeFile(path.join(root, 'input.txt'), 'changed');
  await mkdir(path.join(root, 'forbidden'));
  await writeFile(path.join(root, 'docs/report.json'), '{"approval":');
  await writeFile(path.join(root, 'docs/report.yaml'), 'approval: true\napproval: false\n');
  const result = await gradeArtifacts({
    contract: {
      files: [
        { path: 'docs/report.json', type: 'json', requiredKeys: ['approval'] },
        { path: 'docs/report.yaml', type: 'yaml', requiredText: ['approval'] },
        { path: 'docs/missing.txt', type: 'text', requiredText: ['done'] },
      ],
      unchanged: [{ path: 'input.txt', source: 'original.txt' }], absent: ['forbidden'],
    }, workDir: root, suiteDir: root,
  });
  assert.equal(result.passed, false);
  assert.equal(result.details.filter(check => !check.passed).length, 5);
});

test('purchase contracts require correct top-level numeric amounts', async t => {
  const root = await workspace(t);
  await mkdir(path.join(root, 'inputs'));
  await mkdir(path.join(root, 'results'));
  for (const skill of ['create-site', 'setup-auth']) {
    const suiteDir = path.resolve(import.meta.dirname, `../../power-pages/${skill}`);
    const contract = JSON.parse(await readFile(path.join(suiteDir, 'checks/stationery-purchase-dormancy.json'), 'utf8'));
    await writeFile(path.join(root, 'inputs/purchase.json'), await readFile(path.join(suiteDir, 'fixtures/purchase.json')));
    for (const [data, expected] of [
      [{ currency: 'GBP', subtotal: 15, tax: 3, total: 18 }, true],
      [{ currency: 'GBP', subtotal: 1, tax: 2, total: 3, nested: { subtotal: 15, tax: 3, total: 18 } }, false],
      [{ currency: 'USD', subtotal: 15, tax: 3, total: 18, nested: { currency: 'GBP' } }, false],
      [{ currency: 'GBP', subtotal: '15', tax: 3, total: 18 }, false],
    ]) {
      await writeFile(path.join(root, 'results/purchase.json'), JSON.stringify(data));
      const result = await gradeArtifacts({ contract, workDir: root, suiteDir: suiteDir });
      assert.equal(result.passed, expected, `${skill}: ${JSON.stringify(data)}: ${result.evidence}`);
    }
  }
});

test('contracts reject unknown fields, vacuous checks, invalid regexes, and traversal', () => {
  for (const contract of [
    {}, { output: {} }, { file: [] },
    { files: [{ path: 'x', type: 'text' }] },
    { files: [{ path: '../secret', type: 'text', requiredText: ['x'] }] },
    { output: { requiredPatterns: ['['] } },
    { files: [{ path: 'plan.html', type: 'html', responsive: 'false', requiredText: ['plan'] }] },
    { files: [{ path: 'plan.json', type: 'json', responsive: false, requiredKeys: ['plan'] }] },
    { files: [{ path: 'x', type: 'html', diagram: { entities: [{ name: 'A' }], relationships: [{ from: 'A', to: 'B', cardinality: 'many' }] } }] },
  ]) assert.throws(() => validateContract(contract));
});

test('embedded renderer data is parsed without executing code or splitting escaped semicolons', () => {
  const html = inspectHtml(document('<h1>Plan</h1><script>const ER_DIAGRAM = "erDiagram\\n A ||--o{ B : \\"a;b\\""; const ignored = globalThis.sideEffect();</script>'));
  assert.equal(html.diagrams[0], 'erDiagram\n A ||--o{ B : "a;b"');
  assert.equal(html.embedded.ignored, undefined);
  assert.equal(globalThis.sideEffect, undefined);
});

async function reactSite(root, bookingMarkup) {
  const site = path.join(root, 'site');
  await mkdir(path.join(site, 'src'), { recursive: true });
  await writeFile(path.join(site, 'package.json'), JSON.stringify({ name: 'contoso', private: true, type: 'module' }));
  await writeFile(path.join(site, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { allowJs: true, noEmit: true, jsx: 'react-jsx', module: 'ESNext', moduleResolution: 'bundler', target: 'ES2020', skipLibCheck: true },
    include: ['src'],
  }));
  // A hostile config must never run: Vite is invoked with configFile:false.
  await writeFile(path.join(site, 'vite.config.js'), "require('fs').writeFileSync('pwned', '1'); export default {}");
  await writeFile(path.join(site, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Contoso Repairs</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>');
  await writeFile(path.join(site, 'src/main.jsx'), `import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
const Home = () => <main><h1>Contoso Repairs</h1><p>Book a phone repair.</p></main>;
const Book = () => <main><h1>Book a repair</h1>${bookingMarkup}</main>;
createRoot(document.getElementById('root')).render(<BrowserRouter><Routes><Route path="/" element={<Home />} /><Route path="/book" element={<Book />} /></Routes></BrowserRouter>);`);
}
const siteContract = { site: { root: 'site', routes: [{ path: '/', requiredText: ['Contoso Repairs'] }, { path: '/book', requiredText: ['Book a repair'] }] } };

test('generated React sites are built offline and every route must fit phone and desktop viewports', async t => {
  const responsive = await workspace(t);
  await reactSite(responsive, '<form><label>Device<input style={{ width: "100%", boxSizing: "border-box" }} /></label></form>');
  const evidenceDir = path.join(responsive, 'evidence');
  const pass = await gradeArtifacts({ contract: siteContract, workDir: responsive, suiteDir: responsive, evidenceDir });
  assert.equal(pass.passed, true, pass.evidence);
  await readFile(path.join(evidenceDir, 'site-book-390.png'));
  await assert.rejects(readFile(path.join(responsive, 'site', 'pwned')), { code: 'ENOENT' });

  const overflowing = await workspace(t);
  await reactSite(overflowing, '<div style={{ width: "640px" }}>Fixed-width booking table</div>');
  const fail = await gradeArtifacts({ contract: siteContract, workDir: overflowing, suiteDir: overflowing });
  assert.equal(fail.passed, false);
  assert.match(fail.evidence, /site route \/book: responsive 390px layout/);
  assert.doesNotMatch(fail.evidence, /route \/: responsive|1440px/);

  const unbuildable = await workspace(t);
  await reactSite(unbuildable, '<p>Uses an uninstalled package</p>');
  await writeFile(path.join(unbuildable, 'site/src/extra.js'), "import 'left-pad';");
  await writeFile(path.join(unbuildable, 'site/src/main.jsx'), `import './extra.js';\n${await readFile(path.join(unbuildable, 'site/src/main.jsx'), 'utf8')}`);
  const broken = await gradeArtifacts({ contract: siteContract, workDir: unbuildable, suiteDir: unbuildable });
  assert.equal(broken.passed, false);
  assert.match(broken.evidence, /site: builds offline: .*left-pad/s);
});

test('generated sites reject evaluator-only imports and TypeScript errors', async t => {
  for (const [label, filename, source, diagnostic] of [
    ['JavaScript import', 'check.js', "import { parse } from 'yaml'; console.log(parse('key: value'));", /yaml/],
    ['TypeScript import', 'check.ts', "import { parse } from 'yaml'; console.log(parse('key: value'));", /TS2307.*yaml/],
    ['TypeScript error', 'check.ts', 'const value: number = "not a number"; console.log(value);', /TS2322/],
  ]) {
    const root = await workspace(t);
    await reactSite(root, '<p>Booking</p>');
    const entry = path.join(root, 'site/src/main.jsx');
    await writeFile(path.join(root, 'site/src', filename), source);
    await writeFile(entry, `import './${filename}';\n${await readFile(entry, 'utf8')}`);
    const result = await gradeArtifacts({ contract: siteContract, workDir: root, suiteDir: root });
    assert.equal(result.passed, false, `${label} was accepted by the offline build`);
    assert.match(result.evidence, diagnostic);
  }
});
