'use strict';

// WCAG 2.4.2 Page Titled, across the whole crawl rather than per page.
//
// axe's document-title rule only catches a missing or empty <title>. The common
// failure on Power Pages code sites is different: a Vite/React SPA ships one static
// <title> in index.html and never updates it on navigation, so every route has the
// same title and screen reader users cannot tell pages apart. That is only visible
// when titles from several routes are compared, which is why this is a pure function
// over all pages instead of an in-page check.

const { makeFinding } = require('../report');

const HELP_URL = 'https://www.w3.org/WAI/WCAG22/Understanding/page-titled.html';

// pages: [{ route, title }] — one entry per audited route (desktop pass only, since
// the title does not depend on viewport).
function analyzeTitles(pages) {
  const missing = [];
  const byTitle = new Map();
  for (const p of pages) {
    const title = (p.title || '').trim();
    if (!title) {
      missing.push({ route: p.route });
      continue;
    }
    const key = title.toLowerCase();
    if (!byTitle.has(key)) byTitle.set(key, { title, routes: [] });
    byTitle.get(key).routes.push(p.route);
  }

  const results = [];
  for (const m of missing) {
    results.push({
      route: m.route,
      finding: makeFinding({
        id: 'pp-page-title-missing',
        impact: 'serious',
        wcag: ['2.4.2'],
        description: 'Page has no title. Set a descriptive document.title for this route.',
        helpUrl: HELP_URL,
        nodes: [{ target: 'title', html: '', summary: 'document.title is empty' }],
      }),
    });
  }
  // A single route sharing the site name with nothing else is fine; flag only when
  // two or more distinct routes share a title.
  for (const { title, routes } of byTitle.values()) {
    if (routes.length < 2) continue;
    for (const route of routes) {
      results.push({
        route,
        finding: makeFinding({
          id: 'pp-page-title-duplicate',
          impact: 'moderate',
          wcag: ['2.4.2'],
          heuristic: true,
          description: 'Several routes share the same title. Give each page a title that describes its purpose, for example "Contact us | Contoso".',
          helpUrl: HELP_URL,
          nodes: [{ target: 'title', html: '', summary: `"${title.slice(0, 120)}" is used by ${routes.length} routes` }],
        }),
      });
    }
  }
  return results;
}

module.exports = { analyzeTitles };
