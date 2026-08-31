/**
 * Dynamic Expo config for the Power Apps standalone template.
 */

const IS_DEV_CLIENT = process.env.DEV_CLIENT === 'true';

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

/** @type {import('expo/config').ExpoConfig} */
module.exports = ({ config }) => customizeExpoConfig({
  ...config,
  name: APP_NAME,
  slug: APP_SLUG,
  version: APP_VERSION,
  scheme: APP_SCHEME,
  userInterfaceStyle: 'automatic',
  // Icon — only set when APP_ICON_PATH is provided (production builds via wrap.js).
  // Expo generates all required sizes from this single 1024×1024 PNG.
  ...(APP_ICON_PATH ? { icon: APP_ICON_PATH } : {}),
  web: {
    bundler: 'metro',
    output: 'static',
  },
  platforms: ['ios', 'android', 'web'],
  experiments: {
    typedRoutes: true,
  },
  plugins: [
    // expo-dev-client is only included in development builds.
    // Release builds omit it so the Expo launcher screen is not included.
    ...(IS_DEV_CLIENT ? ['expo-dev-client'] : []),
    'expo-router',
    'expo-secure-store',
    // power-apps-native-host config plugin: injects the Intune MAM Gradle plugin
    // into android/build.gradle and android/app/build.gradle at prebuild time.
    // Skipped automatically when DEV_CLIENT=true.
    // The host package delegates to its pinned auth/MAM plugin internally.
    '@microsoft/power-apps-native-host',
    // @microsoft/power-apps-native-offline: injects the RNDataverseOffline pod (iOS)
    // and DataverseOfflinePackage (Android), and sets newArchEnabled=false
    // (Podfile.properties.json / gradle.properties) — the offline native module
    // requires the legacy architecture. Self-deactivates (complete no-op) when no
    // valid offline-profile.json exists. Activated by offline-profile.json, NOT power.config.json.
    '@microsoft/power-apps-native-offline',
    '@react-native-community/datetimepicker'],
  android: {
    package: ANDROID_PACKAGE,
    versionCode: APP_VERSION_CODE,
    // Adaptive icon — uses the same source image with a white background.
    // Override adaptiveIcon.backgroundColor in app.config.js if your icon
    // needs a different background (e.g. a branded colour).
    ...(APP_ICON_PATH ? {
      adaptiveIcon: {
        foregroundImage: APP_ICON_PATH,
        backgroundColor: '#ffffff',
      },
    } : {}),
  },
  ios: {
    supportsTablet: true,
    bundleIdentifier: IOS_BUNDLE_IDENTIFIER,
    infoPlist: {
      // Required so the MAM SDK and MSAL can detect Company Portal /
      // Microsoft Authenticator. Baked into the binary — present in both
      // dev client and release base builds.
      LSApplicationQueriesSchemes: [
        'intunemam',
        'ms-acompli',
        'msauthv2',
        'msauthv3',
        // msauth.<bundleId> for broker - downstream packaging can add an
        // bundle-specific variant to CFBundleURLTypes when needed, while the
        // generic msauthv2/v3 entries here cover SDK detection.
      ],
    },
  },
});
