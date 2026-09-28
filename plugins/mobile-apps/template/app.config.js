const { createPowerAppsExpoConfig } = require('@microsoft/power-apps-native-host/config/expoConfig');

// CUSTOMER APP SETTINGS START - DO NOT REMOVE OR RENAME THE COMMENT
// App identity, package names, icon, and version defaults are customer-owned.
const APP_NAME = process.env.APP_DISPLAY_NAME || 'Power Apps Standalone App';
const APP_SLUG = process.env.APP_SLUG || 'powerapps-standalone-app';
const APP_SCHEME = process.env.APP_SCHEME || APP_SLUG;
const ANDROID_PACKAGE = process.env.ANDROID_PACKAGE || 'com.contoso.powerappsapp';
const IOS_BUNDLE_IDENTIFIER = process.env.IOS_BUNDLE_IDENTIFIER || 'com.contoso.powerappsapp';

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
  return config;
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
