#!/usr/bin/env node

// Checks an app's own Firebase client files for push notifications: the google-services.json
// (Android) and GoogleService-Info.plist (iOS) downloaded from the Firebase console, which replace
// the template's placeholder files in firebase/. /deploy publishes them with the app, and the
// Power Apps wrap injects them.
//
// Usage:
//   node firebase-client-files.js validate <bundle-id> <file>... [--project-root <path>]
//     For /add-native push-notifications, before a file is copied into firebase/: each file must
//     hold a Firebase app for <bundle-id> (the ID the app is wrapped with) with complete,
//     non-placeholder values. Prints an `OK:` line per valid file, and one `INVALID:` line naming
//     every problem.
//   node firebase-client-files.js report-packaged [--project-root <path>]
//     For /deploy, after the native bundles are built: reports whether each platform's own Firebase
//     client file was packaged in its asset package for the wrap. It only warns.
//
//   --project-root  The app's root (default: the current directory); expo/config and @expo/plist
//                   load from the app's dependencies.
//
// Exit codes: 0 = valid, or any report; 1 = an invalid file; 2 = usage error.

'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

// The template's placeholder files carry this app ID until the app's own files replace them.
const PLACEHOLDER_APP_ID = 'google_app_id_tag';
const DEFAULT_CONFIG_FILES = { android: 'firebase/google-services.json', ios: 'firebase/GoogleService-Info.plist' };
const USAGE =
  'Usage: node firebase-client-files.js validate <bundle-id> <file>... [--project-root <path>]\n' +
  '       node firebase-client-files.js report-packaged [--project-root <path>]';

// Every placeholder value in the template's files ends in `_tag`.
const isValue = (value) => typeof value === 'string' && value.trim() !== '' && !value.endsWith('_tag');

function requireFromApp(projectRoot, id) {
  return createRequire(path.join(projectRoot, 'package.json'))(id);
}

function checkAndroid(config, bundleId, name) {
  const client = (config.client ?? []).find((c) => c.client_info?.android_client_info?.package_name === bundleId);
  if (!client) return { problem: `${name} has no Android app for package ${bundleId}` };
  const values = [
    config.project_info?.project_id,
    config.project_info?.project_number,
    client.client_info?.mobilesdk_app_id,
    client.api_key?.[0]?.current_key,
  ];
  if (!values.every(isValue)) return { problem: `${name} is incomplete or holds placeholder values` };
  return { ok: `OK: ${name} (Android) for ${bundleId}, Firebase project ${config.project_info.project_id}` };
}

function checkIos(config, bundleId, name) {
  if (config.BUNDLE_ID !== bundleId) return { problem: `${name} is for bundle ID ${config.BUNDLE_ID}, not ${bundleId}` };
  if (![config.GOOGLE_APP_ID, config.API_KEY, config.GCM_SENDER_ID, config.PROJECT_ID].every(isValue)) {
    return { problem: `${name} is incomplete or holds placeholder values` };
  }
  return { ok: `OK: ${name} (iOS) for ${bundleId}, Firebase project ${config.PROJECT_ID}` };
}

/** Checks each file (a path relative to the current directory, or absolute) for `bundleId`. */
function validateFiles(projectRoot, bundleId, files) {
  const ok = [];
  const problems = [];
  for (const file of files) {
    const name = path.basename(file);
    try {
      let result;
      if (file.endsWith('.json')) {
        result = checkAndroid(JSON.parse(fs.readFileSync(file, 'utf8')), bundleId, name);
      } else if (file.endsWith('.plist')) {
        const plist = requireFromApp(projectRoot, '@expo/plist');
        result = checkIos((plist.default ?? plist).parse(fs.readFileSync(file, 'utf8')), bundleId, name);
      } else {
        result = { problem: `${name} is neither a google-services.json nor a GoogleService-Info.plist` };
      }
      if (result.ok) ok.push(result.ok);
      else problems.push(result.problem);
    } catch (error) {
      problems.push(`${name} could not be read: ${error.message}`);
    }
  }
  return { ok, problems };
}

/** For each platform with its own Firebase client file, whether its asset package carries it. */
function reportPackaged(projectRoot) {
  const { getConfig } = requireFromApp(projectRoot, 'expo/config');
  const { exp } = getConfig(projectRoot, { skipSDKVersionRequirement: true });
  const lines = [];
  for (const [platform, defaultFile] of Object.entries(DEFAULT_CONFIG_FILES)) {
    const file = exp[platform]?.googleServicesFile ?? defaultFile;
    const filePath = path.resolve(projectRoot, file);
    if (!fs.existsSync(filePath) || fs.readFileSync(filePath, 'utf8').includes(PLACEHOLDER_APP_ID)) continue;
    const manifestPath = path.join(projectRoot, 'dist', `powerapps-customer-assets-${platform}`, 'manifest.json');
    const { pushNotificationsConfig } = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    lines.push(
      pushNotificationsConfig
        ? { level: 'log', message: `✓ ${platform} Firebase client file packaged for push notifications (${pushNotificationsConfig.path})` }
        : {
            level: 'warn',
            message: `⚠ ${file} was not packaged for ${platform}: push notifications need @microsoft/power-apps-native-host 0.6.0 or later (then rerun npm run bundle:${platform}), or the file uploaded in the wrap wizard.`,
          },
    );
  }
  return lines;
}

function parseArgs(argv) {
  const out = { projectRoot: process.cwd(), positional: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--project-root') {
      out.positional.push(argv[i]);
    } else if (argv[i + 1]) {
      out.projectRoot = path.resolve(argv[++i]);
    } else {
      return null;
    }
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  const [command, ...rest] = args?.positional ?? [];
  if (command === 'validate' && rest.length >= 2) {
    const [bundleId, ...files] = rest;
    const { ok, problems } = validateFiles(args.projectRoot, bundleId, files);
    for (const line of ok) console.log(line);
    if (problems.length === 0) return 0;
    console.error(`INVALID: ${problems.join('; ')}`);
    return 1;
  }
  if (command === 'report-packaged' && rest.length === 0) {
    // A report never stops the deploy.
    try {
      for (const { level, message } of reportPackaged(args.projectRoot)) console[level](message);
    } catch (error) {
      console.warn(`⚠ Could not check the packaged Firebase client files: ${error.message}`);
    }
    return 0;
  }
  console.error(USAGE);
  return 2;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { PLACEHOLDER_APP_ID, validateFiles, reportPackaged, main };
