#!/usr/bin/env node

// Validates that design changes were applied to a Power Pages code site.
// Runs as a Stop hook to verify typography, colors, and animations were implemented.

const fs = require('fs');
const path = require('path');
const { approve, block, runValidation, findProjectRoot } = require('../../../scripts/lib/validation-helpers');

runValidation((cwd) => {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) approve(); // Not a Power Pages project, skip

  // Collect all CSS content from the project to check for design indicators
  const cssContent = collectCssContent(projectRoot);
  if (!cssContent) approve(); // No CSS files found — not a design session, skip

  // Only validate if design indicators are present (Google Fonts import or CSS variables).
  // If neither exists, this wasn't a design session — skip.
  const hasGoogleFonts = checkGoogleFontsImport(projectRoot);
  const hasCssVariables = cssContent.includes('--color-') || cssContent.includes('--font-');
  if (!hasGoogleFonts && !hasCssVariables) approve();

  const errors = [];

  // 1. Check for CSS custom properties (design system)
  if (!hasCssVariables) {
    errors.push('No CSS variables found (--color-* or --font-*). Design changes should use CSS custom properties for consistency.');
  }

  // 2. Check for Google Fonts import
  if (!hasGoogleFonts) {
    errors.push('No Google Fonts import found. Distinctive typography requires custom font loading.');
  }

  // 3. Check for animations/transitions
  const hasAnimations = cssContent.includes('@keyframes') || cssContent.includes('animation:') || cssContent.includes('animation-name:');
  const hasTransitions = cssContent.includes('transition:') || cssContent.includes('transition-property:');
  if (!hasAnimations && !hasTransitions) {
    errors.push('No CSS animations or transitions found. Design should include motion for polish.');
  }

  // 4. Check for generic font usage (the ones we explicitly avoid)
  const genericFontPattern = /font-family:\s*['"]?(Inter|Roboto|Open Sans|Lato|Arial|Helvetica)['"]?\s*[,;]/i;
  if (genericFontPattern.test(cssContent)) {
    errors.push('Generic fonts detected (Inter/Roboto/Arial/etc). Use distinctive typography choices instead.');
  }

  if (errors.length > 0) {
    block('Design validation found issues:\n- ' + errors.join('\n- '));
  }

  approve();
});

/**
 * Collects all CSS content from common locations in the project.
 * @returns {string|null} Combined CSS content, or null if no CSS files found
 */
function collectCssContent(projectRoot) {
  const cssFiles = [];
  const searchDirs = [
    path.join(projectRoot, 'src'),
    path.join(projectRoot, 'src', 'styles'),
    path.join(projectRoot, 'src', 'assets'),
  ];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      collectCssFilesRecursive(dir, cssFiles, 0);
    } catch {}
  }

  if (cssFiles.length === 0) return null;

  let combined = '';
  for (const file of cssFiles) {
    try {
      combined += fs.readFileSync(file, 'utf8') + '\n';
    } catch {}
  }

  return combined || null;
}

/**
 * Recursively collects CSS/SCSS files up to 3 levels deep.
 */
function collectCssFilesRecursive(dir, files, depth) {
  if (depth > 3) return;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
        collectCssFilesRecursive(fullPath, files, depth + 1);
      } else if (entry.isFile() && /\.(css|scss|less)$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
  } catch {}
}

/**
 * Checks for Google Fonts import in index.html or CSS files.
 */
function checkGoogleFontsImport(projectRoot) {
  const htmlCandidates = [
    path.join(projectRoot, 'index.html'),
    path.join(projectRoot, 'src', 'index.html'),
  ];

  // Check HTML files for <link> to Google Fonts
  for (const htmlPath of htmlCandidates) {
    if (fs.existsSync(htmlPath)) {
      try {
        const content = fs.readFileSync(htmlPath, 'utf8');
        if (content.includes('fonts.googleapis.com') || content.includes('fonts.gstatic.com')) {
          return true;
        }
      } catch {}
    }
  }

  // Check for Astro layouts
  const layoutDir = path.join(projectRoot, 'src', 'layouts');
  if (fs.existsSync(layoutDir)) {
    try {
      for (const entry of fs.readdirSync(layoutDir, { withFileTypes: true })) {
        if (entry.isFile()) {
          const content = fs.readFileSync(path.join(layoutDir, entry.name), 'utf8');
          if (content.includes('fonts.googleapis.com') || content.includes('fonts.gstatic.com')) {
            return true;
          }
        }
      }
    } catch {}
  }

  // Check CSS files for @import of Google Fonts
  const cssDirs = [
    path.join(projectRoot, 'src'),
    path.join(projectRoot, 'src', 'styles'),
  ];
  for (const dir of cssDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && /\.(css|scss)$/.test(entry.name)) {
          const content = fs.readFileSync(path.join(dir, entry.name), 'utf8');
          if (content.includes('fonts.googleapis.com')) return true;
        }
      }
    } catch {}
  }

  return false;
}
