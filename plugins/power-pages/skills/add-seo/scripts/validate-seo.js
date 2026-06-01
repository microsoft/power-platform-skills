#!/usr/bin/env node

// Validates SEO assets added to a Power Pages code site.
// Runs as a Stop hook to verify robots.txt, sitemap.xml, and meta tags were created.

const fs = require('fs');
const path = require('path');
const { approve, block, runValidation, findPath } = require('../../../scripts/lib/validation-helpers');

runValidation((cwd) => {
  const configPath = findPath(cwd, 'powerpages.config.json');
  if (!configPath) approve(); // Not a Power Pages project, skip

  const projectRoot = path.dirname(configPath);
  const publicDir = path.join(projectRoot, 'public');

  if (!fs.existsSync(publicDir)) approve();

  // Check if any SEO file exists — if none, this wasn't an SEO session, skip
  const hasRobots = fs.existsSync(path.join(publicDir, 'robots.txt'));
  const hasSitemap = fs.existsSync(path.join(publicDir, 'sitemap.xml'));
  if (!hasRobots && !hasSitemap) approve();

  const errors = [];

  // 1. robots.txt
  if (!hasRobots) {
    errors.push('Missing public/robots.txt');
  } else {
    const content = fs.readFileSync(path.join(publicDir, 'robots.txt'), 'utf8');
    if (!content.includes('User-agent:')) errors.push('robots.txt: missing User-agent directive');
    if (!content.toLowerCase().includes('sitemap:')) errors.push('robots.txt: missing Sitemap directive');
  }

  // 2. sitemap.xml
  if (!hasSitemap) {
    errors.push('Missing public/sitemap.xml');
  } else {
    const content = fs.readFileSync(path.join(publicDir, 'sitemap.xml'), 'utf8');
    if (!content.includes('<urlset')) errors.push('sitemap.xml: missing <urlset> element');
    if (!content.includes('<loc>')) errors.push('sitemap.xml: missing <loc> entries');
    if (content.includes('<PRODUCTION_URL>') || content.includes('<TODAY_DATE>')) {
      errors.push('sitemap.xml: contains unreplaced template placeholders');
    }
  }

  // 3. Meta tags in index.html
  const indexPath = findIndexHtml(projectRoot);
  if (indexPath) {
    const content = fs.readFileSync(indexPath, 'utf8');
    if (!content.includes('meta name="description"')) errors.push('index.html: missing meta description tag');
    if (!content.includes('meta name="viewport"')) errors.push('index.html: missing viewport meta tag');
  }

  if (errors.length > 0) {
    block('SEO validation failed:\n- ' + errors.join('\n- '));
  }

  approve();
});

function findIndexHtml(projectRoot) {
  const candidates = [
    path.join(projectRoot, 'index.html'),
    path.join(projectRoot, 'src', 'index.html'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // For Astro, check layout files
  const layoutDir = path.join(projectRoot, 'src', 'layouts');
  if (fs.existsSync(layoutDir)) {
    try {
      for (const entry of fs.readdirSync(layoutDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.astro')) {
          return path.join(layoutDir, entry.name);
        }
      }
    } catch {}
  }

  return null;
}
