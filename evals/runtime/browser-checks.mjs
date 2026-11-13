import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { confinedPath } from './paths.mjs';

const require = createRequire(import.meta.url);
const mermaidScript = path.join(path.dirname(require.resolve('mermaid/package.json')), 'dist/mermaid.min.js');
let browserPromise;

export function getBrowser() {
  if (!browserPromise) {
    // Only the SDK may reach Copilot. Document JS runs in a fresh browser context,
    // behind a dead proxy and request interception, with no host credentials or
    // bindings. No CDN, portal, API, WebSocket, or service worker is allowed.
    browserPromise = chromium.launch({
      headless: true, chromiumSandbox: true,
      env: {
        PATH: process.env.PATH ?? '', HOME: tmpdir(), USERPROFILE: tmpdir(),
        ...Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']
          .filter(key => process.env[key]).map(key => [key, process.env[key]])),
      },
      proxy: { server: 'http://127.0.0.1:9', bypass: '' },
      args: ['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    });
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (!browserPromise) return;
  const pending = browserPromise;
  browserPromise = undefined;
  await (await pending).close();
}

const mime = name => ({
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.woff2': 'font/woff2',
})[path.extname(name)] ?? 'application/octet-stream';

export async function inspectDocument({ html, workDir, relativeFile, diagram, responsive = true, evidenceDir, signal }) {
  signal?.throwIfAborted();
  const context = await (await getBrowser()).newContext({
    viewport: { width: 1440, height: 1000 }, bypassCSP: true,
    serviceWorkers: 'block', permissions: [], acceptDownloads: false,
  });
  const abort = () => { void context.close(); };
  signal?.addEventListener('abort', abort, { once: true });
  const checks = [];
  const diagnostics = [];
  const add = (name, passed) => checks.push({ name, passed: Boolean(passed) });
  try {
    await context.routeWebSocket('**/*', route => route.close());
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const runtimeErrors = [];
    page.on('pageerror', error => runtimeErrors.push(error.message));
    const mermaidSource = await readFile(mermaidScript, 'utf8');
    // Use the real document, including its inline render logic, with external
    // script tags removed. The trusted pinned Mermaid replaces the CDN version.
    const { stripExternalSources } = await import('./artifacts.mjs');
    // Load the UMD bundle as a classic script: Playwright init scripts isolate
    // top-level vars, but Mermaid's UMD footer reads them from globalThis.
    const source = stripExternalSources(html).replace(/<head(?:\s[^>]*)?>/, '$&<script src="/.eval-runtime/mermaid.js"></script><script>mermaid.initialize({startOnLoad:false,securityLevel:"strict"});</script>');
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.href === `https://eval.invalid/${relativeFile}` && route.request().isNavigationRequest()) {
        return route.fulfill({ contentType: 'text/html', body: source });
      }
      if (url.origin !== 'https://eval.invalid' || route.request().method() !== 'GET') return route.abort('blockedbyclient');
      if (url.pathname === '/.eval-runtime/mermaid.js') {
        return route.fulfill({ contentType: 'application/javascript', body: mermaidSource });
      }
      try {
        const name = decodeURIComponent(url.pathname.slice(1));
        if (name.split('/').some(part => part.startsWith('.'))) return route.abort('blockedbyclient');
        return route.fulfill({ contentType: mime(name), body: await readFile(await confinedPath(workDir, name)) });
      } catch (error) {
        if (error.code !== 'ENOENT' && !error.message.includes('path') && !error.message.includes('Symbolic')) throw error;
        return route.abort('blockedbyclient');
      }
    });
    await page.goto(`https://eval.invalid/${relativeFile}`, { waitUntil: 'load' });
    await page.evaluate(async () => { await document.fonts.ready; });
    const textSections = [];
    const headings = new Set();
    const captureContent = async () => {
      textSections.push(await page.locator('body').innerText());
      const visibleHeadings = await page.locator('h1,h2,h3,h4,h5,h6').evaluateAll(elements =>
        elements.filter(element => element.getClientRects().length > 0).map(element => element.innerText));
      for (const heading of visibleHeadings) headings.add(heading.trim());
    };
    const expandDetails = async () => {
      const expanders = page.locator('button#expandAllBtn, button[data-action="expand-all"], button[aria-expanded="false"]');
      const count = await expanders.count();
      for (let index = count - 1; index >= 0; index--) {
        if (await expanders.nth(index).isVisible()) await expanders.nth(index).click();
      }
    };
    await captureContent();
    const tabs = page.locator('button[data-tab], button[role="tab"], button.tab-btn, button.tab-button');
    const tabCount = await tabs.count();
    add('bounded document navigation', tabCount <= 24);
    for (let index = 0; index < Math.min(tabCount, 24); index++) {
      if (!await tabs.nth(index).isVisible()) continue;
      await tabs.nth(index).click();
      await expandDetails();
      await captureContent();
    }
    // The bundled data-model report generates the displayed graph from TABLES
    // and retains ER_DIAGRAM as a fallback. Check both, so a correct fallback
    // cannot conceal wrong relationships in the graph people actually see.
    const displayed = await page.evaluate(() => {
      try { return { code: typeof buildErDiagram === 'function' ? buildErDiagram(false) : null }; }
      catch { return { error: true }; }
    });
    add('displayed ER data is valid', !displayed.error);
    const diagramSources = [...new Set([...html.diagrams, ...(displayed.code ? [displayed.code] : [])])];
    add('visible document content', textSections.some(text => text.trim().length > 0));
    if (diagram) {
      add('ER source is present', diagramSources.length > 0);
      for (let index = 0; index < diagramSources.length; index++) {
        const code = diagramSources[index];
        let graph;
        try {
          graph = await page.evaluate(async ({ code, index }) => {
            mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });
            const parsed = await mermaid.mermaidAPI.getDiagramFromText(code);
            if (parsed.type !== 'er') throw new Error('Expected erDiagram');
            const entities = [...parsed.db.getEntities()].map(([name, entity]) => ({
              id: entity.id, name, attributes: entity.attributes,
            }));
            const relationships = parsed.db.getRelationships();
            const { svg } = await mermaid.render(`eval-er-${index}`, code);
            const holder = document.createElement('section');
            holder.setAttribute('data-eval-diagram', String(index));
            holder.style.cssText = 'background:white;color:black;padding:24px;overflow:auto;max-width:100%';
            holder.innerHTML = svg;
            document.body.append(holder);
            const root = holder.querySelector('svg');
            const box = root.getBoundingClientRect();
            const labels = [...root.querySelectorAll('text, .nodeLabel, .entityLabel, .attribute-type')]
              .filter(label => label.textContent.trim());
            const legible = labels.every(label => parseFloat(getComputedStyle(label).fontSize) >= 10);
            return { entities, relationships, svg, width: box.width, height: box.height,
              text: root.textContent, labels: labels.length, legible };
          }, { code, index });
          add(`ER ${index + 1} parses and renders`, graph.width > 0 && graph.height > 0 && graph.labels > 0);
          add(`ER ${index + 1} legible labels`, graph.legible);
          diagnostics.push({ diagram: index, width: graph.width, height: graph.height, labels: graph.labels });
        } catch (error) {
          // A missing browser/library is a harness error (thrown before this
          // point); Mermaid syntax errors are genuine artifact failures.
          if (!/parse|syntax|diagram|lexical|expected|mermaid/i.test(error.message)) throw error;
          add(`ER ${index + 1} parses and renders`, false);
          diagnostics.push({ diagram: index, error: error.message });
          continue;
        }
        for (const entity of diagram.entities) {
          const actual = graph.entities.find(value => value.name.toLowerCase() === entity.name.toLowerCase());
          add(`ER entity ${entity.name}`, Boolean(actual));
          for (const attribute of entity.attributes ?? []) {
            add(`ER ${entity.name}.${attribute}`, actual?.attributes?.some(value => value.name === attribute));
          }
        }
        for (const relation of diagram.relationships ?? []) {
          const expected = relation.cardinality;
          const split = expected.includes('--') ? '--' : '..';
          const [left, right] = expected.split(split);
          const card = marker => ({ '||': 'ONLY_ONE', 'o|': 'ZERO_OR_ONE', '|o': 'ZERO_OR_ONE',
            '}o': 'ZERO_OR_MORE', 'o{': 'ZERO_OR_MORE', '}|': 'ONE_OR_MORE', '|{': 'ONE_OR_MORE' })[marker];
          const a = graph.entities.find(value => value.name.toLowerCase() === relation.from.toLowerCase())?.id;
          const b = graph.entities.find(value => value.name.toLowerCase() === relation.to.toLowerCase())?.id;
          // Mermaid stores cardA at entity B and cardB at entity A. Compare the
          // AST rather than whitespace or labels in the original diagram text.
          // https://mermaid.js.org/syntax/entityRelationshipDiagram.html#relationship-syntax
          add(`ER relationship ${relation.from} ${expected} ${relation.to}`,
            graph.relationships.some(value =>
              ((value.entityA === a && value.entityB === b &&
                value.relSpec.cardB === card(left) && value.relSpec.cardA === card(right)) ||
               (value.entityA === b && value.entityB === a &&
                value.relSpec.cardA === card(left) && value.relSpec.cardB === card(right))) &&
              value.relSpec.relType === (split === '--' ? 'IDENTIFYING' : 'NON_IDENTIFYING')));
        }
        if (evidenceDir) {
          await mkdir(evidenceDir, { recursive: true });
          await writeFile(path.join(evidenceDir, `${path.basename(relativeFile)}-er-${index + 1}.svg`), graph.svg);
        }
        await page.locator(`[data-eval-diagram="${index}"]`).evaluate(element => element.remove());
      }
    }
    for (const width of [1440, 390]) {
      signal?.throwIfAborted();
      await page.setViewportSize({ width, height: 1000 });
      // Planning reports may contain wide tables without saying anything about
      // the proposed site's responsiveness. Keep captures for review, but gate
      // viewport layout only for artifacts whose contract requires it.
      if (responsive) {
        if (tabCount > 1) {
          let visible = 0;
          for (let index = 0; index < Math.min(tabCount, 24); index++) {
            if (await tabs.nth(index).isVisible()) visible++;
          }
          add(`tab navigation at ${width}px`, visible > 0);
        }
        const layout = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth > innerWidth + 2,
          empty: document.body.getBoundingClientRect().height === 0,
        }));
        add(`readable ${width}px layout`, !layout.overflow && !layout.empty);
      }
      if (evidenceDir) {
        await mkdir(evidenceDir, { recursive: true });
        await page.screenshot({ path: path.join(evidenceDir, `${path.basename(relativeFile)}-${width}.png`), fullPage: true });
      }
    }
    add('document scripts run without errors', runtimeErrors.length === 0);
    return {
      text: [...new Set(textSections)].join('\n'), headings: [...headings],
      checks, diagnostics: [...runtimeErrors, ...diagnostics],
    };
  } finally {
    signal?.removeEventListener('abort', abort);
    await context.close();
  }
}

// Generated sites are single-page apps: a navigation to /book must receive
// index.html so the client router can render it, while a request for a missing
// asset (anything with a file extension) must fail rather than fall back.
export async function inspectSite({ distDir, routes, evidenceDir, signal }) {
  signal?.throwIfAborted();
  const context = await (await getBrowser()).newContext({
    viewport: { width: 1440, height: 1000 }, bypassCSP: true,
    serviceWorkers: 'block', permissions: [], acceptDownloads: false,
  });
  const abort = () => { void context.close(); };
  signal?.addEventListener('abort', abort, { once: true });
  const checks = [];
  const add = (name, passed) => checks.push({ name, passed: Boolean(passed) });
  const texts = {};
  try {
    await context.routeWebSocket('**/*', route => route.close());
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'https://eval.invalid' || route.request().method() !== 'GET') return route.abort('blockedbyclient');
      const name = decodeURIComponent(url.pathname.slice(1));
      const asset = path.extname(name) !== '';
      if (name.split('/').some(part => part.startsWith('.'))) return route.abort('blockedbyclient');
      try {
        const file = asset ? name : 'index.html';
        return route.fulfill({ contentType: mime(file), body: await readFile(await confinedPath(distDir, file)) });
      } catch (error) {
        if (error.code !== 'ENOENT' && !error.message.includes('path') && !error.message.includes('Symbolic')) throw error;
        return route.abort('blockedbyclient');
      }
    });
    for (const spec of routes) {
      signal?.throwIfAborted();
      const label = `route ${spec.path}`;
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const runtimeErrors = [];
      page.on('pageerror', error => runtimeErrors.push(error.message));
      try {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.goto(`https://eval.invalid${spec.path}`, { waitUntil: 'load' });
        await page.waitForTimeout(250);
        const viewport = await page.locator('meta[name="viewport"]').getAttribute('content').catch(() => null);
        add(`${label}: device-width viewport`, /width\s*=\s*device-width/i.test(viewport ?? ''));
        texts[spec.path] = await page.locator('body').innerText();
        add(`${label}: renders a heading`, await page.locator('h1').filter({ visible: true }).count() > 0);
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          await page.waitForTimeout(100);
          const layout = await page.evaluate(() => ({
            overflow: document.documentElement.scrollWidth > innerWidth + 2,
            empty: document.body.getBoundingClientRect().height === 0,
          }));
          add(`${label}: responsive ${width}px layout`, !layout.overflow && !layout.empty);
          if (evidenceDir) {
            await mkdir(evidenceDir, { recursive: true });
            const slug = spec.path === '/' ? 'home' : spec.path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
            await page.screenshot({ path: path.join(evidenceDir, `site-${slug}-${width}.png`), fullPage: true });
          }
        }
        add(`${label}: runs without errors`, runtimeErrors.length === 0);
      } finally {
        await page.close();
      }
    }
    return { checks, texts };
  } finally {
    signal?.removeEventListener('abort', abort);
    await context.close();
  }
}
