const { createPowerAppsExpoConfig } = require('@microsoft/power-apps-native-host/config/expoConfig');
const fs = require('node:fs');
const path = require('node:path');

// CUSTOMER APP SETTINGS START - DO NOT REMOVE OR RENAME THE COMMENT
// App identity, package names, icon, and version defaults are customer-owned.
const APP_NAME = process.env.APP_DISPLAY_NAME || 'Power Apps Standalone App';
const APP_SLUG = process.env.APP_SLUG || 'powerapps-standalone-app';
const APP_SCHEME = process.env.APP_SCHEME || APP_SLUG;
const ANDROID_PACKAGE = process.env.ANDROID_PACKAGE || 'com.contoso.powerappsapp';
const IOS_BUNDLE_IDENTIFIER = process.env.IOS_BUNDLE_IDENTIFIER || 'com.contoso.powerappsapp';

function existingProjectFile(envName, defaultPath) {
  const configuredPath = process.env[envName] || defaultPath;
  if (path.isAbsolute(configuredPath)) return null;

  const projectRoot = fs.realpathSync(__dirname);
  const absolutePath = path.resolve(__dirname, configuredPath);
  if (!fs.existsSync(absolutePath)) return null;

  const file = fs.lstatSync(absolutePath);
  if (!file.isFile() || file.isSymbolicLink()) return null;

  // A lexical project-relative path can still escape through a symlinked parent
  // directory. Compare real paths so only files physically inside the app root
  // can activate native config plugins.
  const realFilePath = fs.realpathSync(absolutePath);
  const relativePath = path.relative(projectRoot, realFilePath);
  const isInsideProject =
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath);
  if (!isInsideProject) return null;

  const expoPath = path.relative(projectRoot, realFilePath).split(path.sep).join('/');
  return expoPath.startsWith('.') ? expoPath : `./${expoPath}`;
}

// Canonical committed Firebase client files work without per-machine environment
// configuration. Environment variables remain explicit project-relative overrides;
// an invalid or missing override never silently activates the canonical fallback.
const GOOGLE_SERVICES_JSON = existingProjectFile(
  'GOOGLE_SERVICES_JSON',
  './firebase/google-services.json',
);
const GOOGLE_SERVICE_INFO_PLIST = existingProjectFile(
  'GOOGLE_SERVICE_INFO_PLIST',
  './firebase/GoogleService-Info.plist',
);
const HAS_FIREBASE_CLIENT_CONFIG = GOOGLE_SERVICES_JSON || GOOGLE_SERVICE_INFO_PLIST;

// App icon — set APP_ICON_PATH to a 1024×1024 PNG before running expo prebuild.
// Expo uses this single image to generate all required icon sizes for both
// Android (adaptive icon foreground + legacy) and iOS (all @1x/@2x/@3x slots).
const APP_ICON_PATH = process.env.APP_ICON_PATH || null;

// Version — set by wrap.js from wrap.config.json; falls back to defaults for dev.
const APP_VERSION      = process.env.APP_VERSION      || '1.0.0';
const APP_VERSION_CODE = parseInt(process.env.APP_VERSION_CODE || '1', 10);
// CUSTOMER APP SETTINGS END - DO NOT REMOVE OR RENAME THE COMMENT

// CUSTOMIZATION START - DO NOT REMOVE OR RENAME THE COMMENT
// Add Expo config overrides in this function only.
function customizeExpoConfig(config) {
  const firebasePlugins = HAS_FIREBASE_CLIENT_CONFIG
    ? [
        '@react-native-firebase/app',
        '@react-native-firebase/messaging',
        [
          'expo-build-properties',
          {
            ios: {
              useFrameworks: 'static',
              forceStaticLinking: ['RNFBApp', 'RNFBMessaging'],
            },
          },
        ],
      ]
    : [];

  return {
    ...config,
    plugins: [
      ...(config.plugins || []),
      'expo-notifications',
      ...firebasePlugins,
    ],
    android: {
      ...config.android,
      ...(GOOGLE_SERVICES_JSON ? { googleServicesFile: GOOGLE_SERVICES_JSON } : {}),
    },
    ios: {
      ...config.ios,
      ...(GOOGLE_SERVICE_INFO_PLIST ? { googleServicesFile: GOOGLE_SERVICE_INFO_PLIST } : {}),
      entitlements: {
        ...config.ios?.entitlements,
        'aps-environment': process.env.APNS_ENVIRONMENT || 'development',
      },
      infoPlist: {
        ...config.ios?.infoPlist,
        UIBackgroundModes: Array.from(new Set([
          ...(config.ios?.infoPlist?.UIBackgroundModes || []),
          'remote-notification',
        ])),
      },
    },
  };
}
// CUSTOMIZATION END - DO NOT REMOVE OR RENAME THE COMMENT

module.exports = ({ config }) => createPowerAppsExpoConfig(config, {
  name: APP_NAME,
  slug: APP_SLUG,
  version: APP_VERSION,
  scheme: APP_SCHEME,
  androidPackage: ANDROID_PACKAGE,
  iosBundleIdentifier: IOS_BUNDLE_IDENTIFIER,
  versionCode: APP_VERSION_CODE,
  iconPath: APP_ICON_PATH,
  isDevClient: process.env.DEV_CLIENT === 'true',
}, customizeExpoConfig);
