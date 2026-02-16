#!/usr/bin/env node

// Validates SEO assets added to a Power Pages code site.
// Runs as a Stop hook to verify robots.txt, sitemap.xml, and meta tags were created.

const fs = require('fs');
const path = require('path');

// Exit 0 = success (allow). Exit 2 = blocking error (stderr is fed back to Claude).
const approve = () => { process.exit(0); };
const block = (reason) => {
  process.stderr.write(reason);
  process.exit(2);
};

let inputData = '';
process.stdin.on('data', chunk => (inputData += chunk));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(inputData);
    const cwd = input.cwd;

    if (!cwd) approve();

    const configPath = findConfig(cwd);
    if (!configPath) approve(); // Not a Power Pages project, skip

    const projectRoot = path.dirname(configPath);
    const publicDir = path.join(projectRoot, 'public');

    // Only validate if public dir exists (SEO skill may not have run)
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
      if (!content.includes('User-agent:')) {
        errors.push('robots.txt: missing User-agent directive');
      }
      if (!content.toLowerCase().includes('sitemap:')) {
        errors.push('robots.txt: missing Sitemap directive');
      }
    }

    // 2. sitemap.xml
    if (!hasSitemap) {
      errors.push('Missing public/sitemap.xml');
    } else {
      const content = fs.readFileSync(path.join(publicDir, 'sitemap.xml'), 'utf8');
      if (!content.includes('<urlset')) {
        errors.push('sitemap.xml: missing <urlset> element');
      }
      if (!content.includes('<loc>')) {
        errors.push('sitemap.xml: missing <loc> entries');
      }
      if (content.includes('<PRODUCTION_URL>') || content.includes('<TODAY_DATE>')) {
        errors.push('sitemap.xml: contains unreplaced template placeholders');
      }
    }

    // 3. Meta tags in index.html
    const indexPath = findIndexHtml(projectRoot);
    if (indexPath) {
      const content = fs.readFileSync(indexPath, 'utf8');
      if (!content.includes('meta name="description"')) {
        errors.push('index.html: missing meta description tag');
      }
      if (!content.includes('meta name="viewport"')) {
        errors.push('index.html: missing viewport meta tag');
      }
    }

    if (errors.length > 0) {
      block('SEO validation failed:\n- ' + errors.join('\n- '));
    }

    approve();
  } catch {
    // Don't block on script errors
    approve();
  }
});

function findConfig(dir) {
  const direct = path.join(dir, 'powerpages.config.json');
  if (fs.existsSync(direct)) return direct;

  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
        const sub = path.join(dir, entry.name, 'powerpages.config.json');
        if (fs.existsSync(sub)) return sub;
      }
    }
  } catch {}

  return null;
}

function findIndexHtml(projectRoot) {
  // Check common locations for index.html
  const candidates = [
    path.join(projectRoot, 'index.html'),         // React/Vue (Vite)
    path.join(projectRoot, 'src', 'index.html'),   // Angular
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
