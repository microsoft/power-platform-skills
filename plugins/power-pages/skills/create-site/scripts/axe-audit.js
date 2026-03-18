#!/usr/bin/env node

// Runs axe-core accessibility audit on a Power Pages dev server.
// Navigates to each route, injects axe-core from CDN, and reports violations.
//
// Usage:
//   node axe-audit.js --url http://localhost:5173 --routes /,/about,/contact --project-root /path/to/project
//
// Prerequisites:
//   npm install --save-dev playwright  (in the project directory)
//
// Output: JSON array of per-route audit results to stdout.
// Exit code: 1 if critical/serious violations found, 0 otherwise.

const path = require('path');
const { detectBrowser } = require('../../../scripts/lib/detect-browser');

const AXE_CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.3/axe.min.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) parsed.url = args[++i];
    else if (args[i] === '--routes' && args[i + 1]) parsed.routes = args[++i].split(',');
    else if (args[i] === '--project-root' && args[i + 1]) parsed.projectRoot = args[++i];
  }
  if (!parsed.url || !parsed.routes || !parsed.projectRoot) {
    console.error('Usage: node axe-audit.js --url <base-url> --routes <comma-separated> --project-root <path>');
    process.exit(1);
  }
  return parsed;
}

function loadPlaywright(projectRoot) {
  const attempts = [
    () => require('playwright'),
    () => require(path.join(projectRoot, 'node_modules', 'playwright')),
    () => require('playwright-core'),
    () => require(path.join(projectRoot, 'node_modules', 'playwright-core')),
  ];
  for (const attempt of attempts) {
    try { return attempt(); } catch {}
  }
  console.error('playwright not found. Run: npm install --save-dev playwright');
  process.exit(1);
}

async function main() {
  const { url, routes, projectRoot } = parseArgs();
  const { chromium } = loadPlaywright(projectRoot);
  const channel = detectBrowser();

  const browser = await chromium.launch({ channel, headless: true });
  const page = await browser.newPage();
  const results = [];

  for (const route of routes) {
    const pageUrl = `${url.replace(/\/$/, '')}${route}`;
    try {
      await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 15000 });
      await page.waitForTimeout(2000);

      // Inject axe-core from CDN
      await page.addScriptTag({ url: AXE_CDN_URL });
      await page.waitForFunction(() => typeof window.axe !== 'undefined', { timeout: 10000 });

      // Run axe-core audit against WCAG 2.2 AA (cumulative: includes 2.0 and 2.1)
      const audit = await page.evaluate(async () => {
        const res = await window.axe.run(document, {
          runOnly: {
            type: 'tag',
            values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
          },
        });
        return {
          violations: res.violations.map(v => ({
            id: v.id,
            impact: v.impact,
            description: v.description,
            helpUrl: v.helpUrl,
            nodes: v.nodes.map(n => ({
              html: n.html,
              target: n.target,
              failureSummary: n.failureSummary,
            })),
          })),
          passes: res.passes.length,
          incomplete: res.incomplete.length,
        };
      });

      results.push({ route, url: pageUrl, ...audit });
    } catch (err) {
      results.push({ route, url: pageUrl, error: err.message, violations: [], passes: 0, incomplete: 0 });
    }
  }

  await browser.close();

  // Output JSON results
  console.log(JSON.stringify(results, null, 2));

  // Exit with error code if critical/serious violations exist
  const hasCriticalOrSerious = results.some(r =>
    r.violations.some(v => v.impact === 'critical' || v.impact === 'serious')
  );
  process.exit(hasCriticalOrSerious ? 1 : 0);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
