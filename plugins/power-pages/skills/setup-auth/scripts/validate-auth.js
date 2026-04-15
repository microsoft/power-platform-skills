#!/usr/bin/env node

// Validates that authentication and authorization code was created for a Power Pages code site.
// Runs as a Stop hook to verify the setup-auth skill produced output.

const fs = require('fs');
const path = require('path');
const { approve, block, runValidation, findProjectRoot } = require('../../../scripts/lib/validation-helpers');

runValidation((cwd) => {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) approve(); // Not a Power Pages project, skip

  // Check if any auth files exist — if none, this wasn't an auth session
  const authServiceExists = findAuthService(projectRoot);
  const typeDeclarationsExist = findTypeDeclarations(projectRoot);

  if (!authServiceExists && !typeDeclarationsExist) approve();

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
    // Verify provider configuration exists (supports all provider types)
    if (!content.includes('AUTH_PROVIDER') && !content.includes('AuthProviderConfig')) {
      errors.push('Auth service missing provider configuration (AUTH_PROVIDER or AuthProviderConfig)');
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
});

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
