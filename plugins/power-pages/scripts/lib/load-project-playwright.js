// Resolves the Playwright library installed in a generated site project.
//
// The plugin ships no node_modules (marketplace installs copy only the plugin directory),
// so browser scripts borrow the project's own `playwright` dev dependency. A global
// install is tried first, then the project, then playwright-core as a fallback for
// projects that installed only the core package.

const path = require('node:path');

function loadProjectPlaywright(projectRoot, { requireFn = require } = {}) {
  // require() treats a relative path without a leading "./" as a package name, so a
  // relative --project-root such as "My Site" would never resolve. Anchor it to the cwd.
  const root = path.resolve(projectRoot);
  const candidates = [
    'playwright',
    path.join(root, 'node_modules', 'playwright'),
    'playwright-core',
    path.join(root, 'node_modules', 'playwright-core'),
  ];
  for (const candidate of candidates) {
    try {
      return requireFn(candidate);
    } catch {
      // Try the next location.
    }
  }
  return null;
}

module.exports = { loadProjectPlaywright };
