'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');

const { createTempProject, writeProjectFile } = require('./test-utils');

const VALIDATOR_PATH = path.join(
  __dirname,
  '..',
  '..',
  'skills',
  'setup-auth',
  'scripts',
  'validate-auth.js'
);

function runValidator(projectRoot) {
  return spawnSync(process.execPath, [VALIDATOR_PATH], {
    input: JSON.stringify({ cwd: projectRoot }),
    encoding: 'utf8',
  });
}

const TYPE_DECLARATIONS = `
export interface PowerPagesUser {
  userName: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  contactId?: string;
  userRoles?: string[];
}
`;

const COMPLETE_AUTH_SERVICE = `
import type { PowerPagesUser } from '../types/powerPages';

export interface AuthProviderConfig {
  type: 'entra-id' | 'oidc' | 'saml2' | 'ws-federation' | 'local' | 'social';
  displayName: string;
}

export const AUTH_PROVIDERS: AuthProviderConfig[] = [
  { type: 'entra-id', displayName: 'Sign In' },
];

export async function fetchAntiForgeryToken(): Promise<string> {
  const r = await fetch('/_layout/tokenhtml');
  return (await r.text()).match(/value="([^"]+)"/)![1];
}

export function login() { /* ... */ }
export function logout() { /* ... */ }
export function getCurrentUser() { return undefined; }
`;

const AUTH_BUTTON = `
import { useAuth } from '../hooks/useAuth';
export default function AuthButton() { return null; }
`;

// The skill writes docs/auth-setup-report.html at the end of Phase 8.3.5.
// The validator gates its real work on this file existing — without it, the
// skill is considered in-progress and the validator silent-approves to avoid
// blocking the run before it has had a chance to finish.
const FINISHING_MARKER = '<html>fake auth report for testing</html>';
function withMarker(projectRoot) {
  writeProjectFile(projectRoot, 'docs/auth-setup-report.html', FINISHING_MARKER);
  return projectRoot;
}

// --- Skip path: no auth files at all ---

test('approves when the project has no auth artifacts (not a setup-auth session)', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  withMarker(projectRoot);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('approves when the cwd is outside any Power Pages project', (t) => {
  // Use a temp dir that does NOT contain powerpages.config.json
  const projectRoot = createTempProject(t);
  // Don't write powerpages.config.json — findProjectRoot returns null → approve

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

// --- In-progress path: auth artifacts exist but the finishing marker doesn't ---
//
// Without this gate, re-running setup-auth on a project that has stale auth
// files from a previous failed attempt would block the new run before it
// could overwrite them. With the marker gate, the validator silent-approves
// until Phase 8.3.5 writes docs/auth-setup-report.html.

test('silent-approves when auth artifacts exist but the finishing report has not been written yet', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  // Deliberately do NOT call withMarker — the report doesn't exist.
  // Write an INCOMPLETE auth service: missing the login function and
  // missing AUTH_PROVIDERS/AuthProviderConfig. With the marker present this
  // would block (two errors); without it, the validator must silent-approve
  // so the in-progress skill can finish.
  writeProjectFile(projectRoot, 'src/services/authService.ts', '// half-written file\nexport function logout() {}\n');
  writeProjectFile(projectRoot, 'src/types/powerPages.d.ts', TYPE_DECLARATIONS);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('also silent-approves when a date-suffixed report is the only marker on disk', (t) => {
  // The skill renames the report on subsequent runs (auth-setup-report-2026-05-28.html).
  // The validator should treat any matching file in docs/ as a valid marker.
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'docs/auth-setup-report-2026-05-28.html', '<html></html>');
  writeProjectFile(projectRoot, 'src/services/authService.ts', COMPLETE_AUTH_SERVICE);
  writeProjectFile(projectRoot, 'src/types/powerPages.d.ts', TYPE_DECLARATIONS);
  writeProjectFile(projectRoot, 'src/components/AuthButton.tsx', AUTH_BUTTON);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

// --- Happy path: complete auth setup ---

test('approves a complete auth setup with AUTH_PROVIDERS array', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  withMarker(projectRoot);
  writeProjectFile(projectRoot, 'src/services/authService.ts', COMPLETE_AUTH_SERVICE);
  writeProjectFile(projectRoot, 'src/types/powerPages.d.ts', TYPE_DECLARATIONS);
  writeProjectFile(projectRoot, 'src/components/AuthButton.tsx', AUTH_BUTTON);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('also accepts AuthProviderConfig as a fallback marker when AUTH_PROVIDERS is absent', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  withMarker(projectRoot);
  // Auth service declares AuthProviderConfig interface but no AUTH_PROVIDERS array.
  // The validator should still pass — AuthProviderConfig is the type and is a
  // valid signal that the provider configuration is set up.
  const svc = COMPLETE_AUTH_SERVICE.replace(/AUTH_PROVIDERS/g, 'NOT_THE_ARRAY');
  writeProjectFile(projectRoot, 'src/services/authService.ts', svc);
  writeProjectFile(projectRoot, 'src/types/powerPages.d.ts', TYPE_DECLARATIONS);
  writeProjectFile(projectRoot, 'src/components/AuthButton.tsx', AUTH_BUTTON);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

// --- Failure paths: trigger each individual error message ---

test('blocks when authService exists but type declarations are missing', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  withMarker(projectRoot);
  writeProjectFile(projectRoot, 'src/services/authService.ts', COMPLETE_AUTH_SERVICE);
  // No types file
  writeProjectFile(projectRoot, 'src/components/AuthButton.tsx', AUTH_BUTTON);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Missing Power Pages type declarations/);
});

test('blocks when type declarations exist but authService is missing', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  withMarker(projectRoot);
  writeProjectFile(projectRoot, 'src/types/powerPages.d.ts', TYPE_DECLARATIONS);
  writeProjectFile(projectRoot, 'src/components/AuthButton.tsx', AUTH_BUTTON);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Missing auth service/);
});

test('blocks when authService is missing the login function', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  withMarker(projectRoot);
  writeProjectFile(projectRoot, 'src/types/powerPages.d.ts', TYPE_DECLARATIONS);
  writeProjectFile(
    projectRoot,
    'src/services/authService.ts',
    COMPLETE_AUTH_SERVICE.replace(/export function login\(\) [^\n]+\n/, '')
  );
  writeProjectFile(projectRoot, 'src/components/AuthButton.tsx', AUTH_BUTTON);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Auth service missing login function/);
});

test('blocks when authService has no anti-forgery token handling', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  withMarker(projectRoot);
  writeProjectFile(projectRoot, 'src/types/powerPages.d.ts', TYPE_DECLARATIONS);
  // Strip the anti-forgery references
  const svc = COMPLETE_AUTH_SERVICE
    .replace(/\/_layout\/tokenhtml/g, '/some/other/url')
    .replace(/fetchAntiForgeryToken/g, 'somethingElse');
  writeProjectFile(projectRoot, 'src/services/authService.ts', svc);
  writeProjectFile(projectRoot, 'src/components/AuthButton.tsx', AUTH_BUTTON);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing anti-forgery token handling/);
});

test('blocks when authService has neither AUTH_PROVIDERS nor AuthProviderConfig (the canonical markers)', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  withMarker(projectRoot);
  writeProjectFile(projectRoot, 'src/types/powerPages.d.ts', TYPE_DECLARATIONS);
  // Strip BOTH AUTH_PROVIDERS and AuthProviderConfig to simulate an auth service
  // that doesn't follow the canonical pattern.
  const svc = COMPLETE_AUTH_SERVICE
    .replace(/AUTH_PROVIDERS/g, 'PROVIDERS_NOT_CANONICAL')
    .replace(/AuthProviderConfig/g, 'ProviderInterface');
  writeProjectFile(projectRoot, 'src/services/authService.ts', svc);
  writeProjectFile(projectRoot, 'src/components/AuthButton.tsx', AUTH_BUTTON);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  // The error message names the canonical shape so the implementer knows
  // what to write — guards against regressions to the singular `AUTH_PROVIDER`
  // pattern that the C7 review comment flagged.
  assert.match(result.stderr, /AUTH_PROVIDERS array or AuthProviderConfig type/);
  assert.match(result.stderr, /export const AUTH_PROVIDERS/);
});

test('blocks when the auth UI component is missing', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  withMarker(projectRoot);
  writeProjectFile(projectRoot, 'src/types/powerPages.d.ts', TYPE_DECLARATIONS);
  writeProjectFile(projectRoot, 'src/services/authService.ts', COMPLETE_AUTH_SERVICE);
  // No AuthButton component

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Missing auth UI component/);
});

test('accepts auth components in src/app/components/ (Angular convention)', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  withMarker(projectRoot);
  writeProjectFile(projectRoot, 'src/types/powerPages.d.ts', TYPE_DECLARATIONS);
  writeProjectFile(projectRoot, 'src/services/authService.ts', COMPLETE_AUTH_SERVICE);
  // Angular convention — component lives under app/components/
  writeProjectFile(projectRoot, 'src/app/components/auth-button.component.ts', AUTH_BUTTON);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('blocks when authService references hasRole but authorization utils are missing', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  withMarker(projectRoot);
  writeProjectFile(projectRoot, 'src/types/powerPages.d.ts', TYPE_DECLARATIONS);
  // Auth service references hasRole, signalling that authorization is in scope
  const svc = COMPLETE_AUTH_SERVICE + '\nexport function hasRole(role: string) { return false; }\n';
  writeProjectFile(projectRoot, 'src/services/authService.ts', svc);
  writeProjectFile(projectRoot, 'src/components/AuthButton.tsx', AUTH_BUTTON);
  // No authorization utility file

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Missing authorization utilities/);
});

test('approves when authorization utils exist and authService uses them', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  withMarker(projectRoot);
  writeProjectFile(projectRoot, 'src/types/powerPages.d.ts', TYPE_DECLARATIONS);
  const svc = COMPLETE_AUTH_SERVICE + '\nexport function hasRole(role: string) { return false; }\n';
  writeProjectFile(projectRoot, 'src/services/authService.ts', svc);
  writeProjectFile(projectRoot, 'src/utils/authorization.ts', 'export function hasRole() {}');
  writeProjectFile(projectRoot, 'src/components/AuthButton.tsx', AUTH_BUTTON);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});
