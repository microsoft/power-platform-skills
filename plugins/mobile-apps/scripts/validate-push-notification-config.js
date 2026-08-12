#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_DEPS = [
  'expo-notifications',
  '@react-native-firebase/app',
  '@react-native-firebase/messaging',
  'expo-router',
];

function fail(message) {
  process.stderr.write(`BLOCKED: ${message}\n`);
  return 2;
}

function parseArgs(argv) {
  const index = argv.indexOf('--project-root');
  return index >= 0 ? argv[index + 1] : process.cwd();
}

function findForbiddenCredential(root) {
  const ignoredDirectories = new Set(['.git', 'node_modules', 'android', 'ios', 'dist', 'build']);
  const pending = [root];

  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          pending.push(path.join(directory, entry.name));
        }
        continue;
      }

      const lowerName = entry.name.toLowerCase();
      const isAdminJson =
        lowerName.endsWith('.json') &&
        (lowerName.includes('service-account') || lowerName.includes('firebase-adminsdk'));
      if (lowerName.endsWith('.p8') || isAdminJson) {
        return path.relative(root, path.join(directory, entry.name));
      }
    }
  }

  return null;
}

function main(argv) {
  const root = path.resolve(parseArgs(argv));
  const packagePath = path.join(root, 'package.json');
  const configPath = path.join(root, 'app.config.js');

  if (!fs.existsSync(packagePath) || !fs.existsSync(configPath)) {
    return fail('package.json and app.config.js are required.');
  }

  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const missing = REQUIRED_DEPS.filter((name) => !deps[name]);
  if (missing.length > 0) {
    return fail(`missing notification dependencies: ${missing.join(', ')}`);
  }
  if (pkg.scripts?.postinstall !== 'node scripts/patch-native-host-auth.js') {
    return fail('package.json must apply the version-guarded native host OID patch after install.');
  }

  const authPatchPath = path.join(root, 'scripts', 'patch-native-host-auth.js');
  if (!fs.existsSync(authPatchPath)) {
    return fail('scripts/patch-native-host-auth.js is required.');
  }

  const config = fs.readFileSync(configPath, 'utf8');
  const requiredConfig = [
    "require('node:fs')",
    "require('node:path')",
    "'expo-notifications'",
    "'@react-native-firebase/app'",
    "'@react-native-firebase/messaging'",
    "'./firebase/google-services.json'",
    "'./firebase/GoogleService-Info.plist'",
    'path.resolve(__dirname, configuredPath)',
    'HAS_FIREBASE_CLIENT_CONFIG',
    'googleServicesFile',
    "'aps-environment'",
  ];
  const missingConfig = requiredConfig.filter((needle) => !config.includes(needle));
  if (missingConfig.length > 0) {
    return fail(`app.config.js is missing: ${missingConfig.join(', ')}`);
  }

  const forbiddenCredential = findForbiddenCredential(root);
  if (forbiddenCredential) {
    return fail(
      `secret credential file must not be stored in the project: ${forbiddenCredential}`,
    );

    const hostTypesPath = path.join(
      root,
      'node_modules',
      '@microsoft',
      'power-apps-native-host',
      'lib',
      'typescript',
      'module',
      'auth',
      'AuthContext.d.ts',
    );
    if (fs.existsSync(hostTypesPath)) {
      const hostTypes = fs.readFileSync(hostTypesPath, 'utf8');
      if (!hostTypes.includes('    user: {') || !hostTypes.includes('        oid: string;')) {
        return fail('installed native host does not expose typed useAuth().user.oid; run npm install.');
      }
    }
  }

  process.stdout.write('Push notification configuration passed static validation.\n');
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { findForbiddenCredential, main, parseArgs };
