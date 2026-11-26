#!/usr/bin/env node

// Validates that authentication and authorization code was created for a
// Power Pages SPA site. Runs as a PostToolUse:Skill hook (configured in
// hooks/hooks.json) after the `Skill` tool fires for /power-pages:setup-auth.
//
// Because PostToolUse fires when the Skill tool LOADS (instructions are read
// into context) rather than when the skill has FINISHED its work, this
// validator gates on a finishing marker: the auth setup report HTML written
// by the skill's final Phase 8.3.5. Until that report exists, the skill is
// considered in-progress and validation silent-approves. This follows the
// marker-file recommendation in plugins/power-pages/PLUGIN_DEVELOPMENT_GUIDE.md.
// Other hosts run `--complete` from the site root: that mode does not need hook
// JSON and must reject unfinished work instead of taking the hook's skip paths.

const fs = require('fs');
const path = require('path');
const { approve, block, runValidation, findProjectRoot } = require('../../../scripts/lib/validation-helpers');

if (process.argv.includes('--complete')) {
  try {
    validateAuth(process.cwd(), true);
  } catch (error) {
    block(`Authentication completion validation failed: ${error.message}`);
  }
} else {
  runValidation(validateAuth);
}

function validateAuth(cwd, requireComplete = false) {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) {
    if (requireComplete) return block('Authentication validation requires a Power Pages project.');
    return approve();
  }

  // Check if any auth files exist — if none, this wasn't an auth session
  const authServiceExists = findAuthService(projectRoot);
  const typeDeclarationsExist = findTypeDeclarations(projectRoot);

  if (!authServiceExists && !typeDeclarationsExist && !requireComplete) return approve();

  // Marker gate: silent-approve until the skill writes its finishing report.
  // Without this gate, re-running setup-auth on a project that has stale auth
  // files from a previous attempt would block the new run before it could
  // overwrite them.
  if (!hasFinishingMarker(projectRoot)) {
    if (requireComplete) return block('Authentication setup report is missing; setup is not complete.');
    return approve();
  }

  const errors = [];

  if (!authServiceExists) {
    errors.push('Missing auth service (src/services/authService.ts or equivalent)');
  }

  if (!typeDeclarationsExist) {
    errors.push('Missing Power Pages type declarations (src/types/powerPages.d.ts)');
  }

  // Validate auth service content if it exists
  if (authServiceExists) {
    const content = fs.readFileSync(authServiceExists, 'utf8');
    if (!content.includes('login')) {
      errors.push('Auth service missing login function');
    }
    if (!content.includes('logout')) {
      errors.push('Auth service missing logout function');
    }
    if (!content.includes('getCurrentUser')) {
      errors.push('Auth service missing getCurrentUser function');
    }
    if (!content.includes('/_layout/tokenhtml') && !content.includes('fetchAntiForgeryToken')) {
      errors.push('Auth service missing anti-forgery token handling');
    }
    // Verify provider configuration exists. The canonical pattern in
    // assets/auth-service.ts.template is the AUTH_PROVIDERS array, including
    // single-provider sites. AuthProviderConfig is the interface
    // name and is also a valid marker (auth service must declare the type).
    if (!content.includes('AUTH_PROVIDERS') && !content.includes('AuthProviderConfig')) {
      errors.push('Auth service missing provider configuration — expected the AUTH_PROVIDERS array or AuthProviderConfig type. The canonical pattern is `export const AUTH_PROVIDERS: AuthProviderConfig[] = [...]` even when only one provider is configured.');
    }
  }

  // Check for authorization utilities — only if auth service references role-checking
  // (skip for "Login & Logout only" scope where authorization utils are not created)
  const authzUtils = findAuthorizationUtils(projectRoot);
  if (!authzUtils && authServiceExists) {
    const authContent = fs.readFileSync(authServiceExists, 'utf8');
    // Only flag missing authz utils if the auth service imports or references them
    if (authContent.includes('authorization') || authContent.includes('hasRole') || authContent.includes('getUserRoles')) {
      errors.push('Missing authorization utilities (src/utils/authorization.ts or equivalent)');
    }
  }

  // Check for auth UI component
  const authComponent = findAuthComponent(projectRoot);
  if (!authComponent) {
    errors.push('Missing auth UI component (AuthButton or equivalent)');
  }

  if (errors.length > 0) {
    block('Authentication setup validation failed:\n- ' + errors.join('\n- '));
  }

  approve();
}

function hasFinishingMarker(projectRoot) {
  // The skill writes `docs/auth-setup-report.html` at the end of Phase 8.3.5.
  // If the user already had a previous report there, the renderer date-suffixes
  // the new one (auth-setup-report-2026-05-27.html). Treat any matching file
  // in docs/ as evidence that the skill has completed at least one run.
  const docsDir = path.join(projectRoot, 'docs');
  if (!fs.existsSync(docsDir)) return false;
  try {
    return fs.readdirSync(docsDir).some((name) =>
      /^auth-setup-report.*\.html$/.test(name)
    );
  } catch {
    return false;
  }
}

function findAuthService(projectRoot) {
  const candidates = [
    path.join(projectRoot, 'src', 'services', 'authService.ts'),
    path.join(projectRoot, 'src', 'services', 'authService.js'),
    path.join(projectRoot, 'src', 'services', 'auth.service.ts'),
    path.join(projectRoot, 'src', 'services', 'auth.service.js'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

function findTypeDeclarations(projectRoot) {
  const candidates = [
    path.join(projectRoot, 'src', 'types', 'powerPages.d.ts'),
    path.join(projectRoot, 'src', 'types', 'powerPages.ts'),
    path.join(projectRoot, 'src', 'types', 'power-pages.d.ts'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return true;
  }

  return false;
}

function findAuthorizationUtils(projectRoot) {
  const candidates = [
    path.join(projectRoot, 'src', 'utils', 'authorization.ts'),
    path.join(projectRoot, 'src', 'utils', 'authorization.js'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

function findAuthComponent(projectRoot) {
  const searchDirs = [
    path.join(projectRoot, 'src', 'components'),
    path.join(projectRoot, 'src', 'app', 'components'),
  ];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const file of fs.readdirSync(dir, { recursive: true })) {
        const name = typeof file === 'string' ? file : file.toString();
        if (name.toLowerCase().includes('auth') && (name.endsWith('.tsx') || name.endsWith('.vue') || name.endsWith('.ts') || name.endsWith('.astro'))) {
          return path.join(dir, name);
        }
      }
    } catch {}
  }

  return null;
}
