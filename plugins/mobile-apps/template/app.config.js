/**
 * Dynamic Expo config for the Power Apps standalone template.
 *
 * This template is the canonical source for base packages fed into the
 * PowerApps shrinkwrap / wrap pipeline. The dev-player no longer produces
 * these artifacts.
 *
 * Two build modes, controlled by environment variables:
 *
 *   DEV_CLIENT=true   → dev client build (expo-dev-client included, no MAM)
 *                        Used for: Play Store Internal Testing / TestFlight dev distribution
 *
 *   DEV_CLIENT=false  → production base build (MAM + ShrinkWrap flavor)
 *   (default)           Used for: input to the wrap pipeline
 *
 *                        Android: npm run prebuild:android && npm run production:android
 *                          Output: android/app/build/outputs/bundle/ShrinkWrapRelease/app-ShrinkWrap-release.aab
 *
 *                        iOS:     npm run prebuild:ios && npm run pod-install && npm run production:ios
 *                          Output: /tmp/pawrap-base.ipa
 */

const IS_DEV_CLIENT = process.env.DEV_CLIENT === 'true';
const { readSupportedRuntime } = require('@microsoft/power-apps-native-host/runtime-metadata');

const supportedRuntime = readSupportedRuntime(__dirname);

/** @type {import('expo/config').ExpoConfig} */
module.exports = ({ config }) => ({
  ...config,
  name: 'Power Apps Dev Player',
  slug: 'powerapps-dev-player',
  version: '1.0.0',
  scheme: 'powerapps-dev-player',
  runtimeVersion: { policy: 'fingerprint' },
  web: {
    bundler: 'metro',
    output: 'static',
  },
  platforms: ['ios', 'android', 'web'],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    ...config.extra,
    powerAppsNativeRuntime: supportedRuntime,
  },
  plugins: [
    // expo-dev-client is only included in the dev client build.
    // The release base build omits it so the Expo launcher screen is never
    // present in production rewrapped APKs/IPAs.
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
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#ffffff',
    },
    package: 'com.test.wrap',
  },
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.microsoft.PreviewApp',
    infoPlist: {
      // Required so the MAM SDK and MSAL can detect Company Portal /
      // Microsoft Authenticator. Baked into the binary — present in both
      // dev client and release base builds.
      LSApplicationQueriesSchemes: [
        'intunemam',
        'ms-acompli',
        'msauthv2',
        'msauthv3',
        // msauth.<bundleId> for broker — the wrap pipeline adds the
        // customer-specific variant to CFBundleURLTypes at rewrap time,
        // but the generic msauthv2/v3 entries here cover the SDK detection.
      ],
      // IntuneMAMSettings — read at runtime by the host auth bridge.
      // The production iOS wrap pipeline patches ADALClientId and ADALRedirectUri
      // here via `plutil -replace IntuneMAMSettings.*`.
      // Placeholder values are replaced by the pipeline; the app falls back to
      // auth.config.json values when the placeholder tag is still present (i.e.
      // base build before wrapping, or dev client).
      IntuneMAMSettings: {
        ADALClientId: 'ADAL_CLIENT_ID_TAG',
        ADALRedirectUri: 'ADAL_REDIRECT_URI_TAG',
        ADALTenantId: 'ADAL_TENANT_ID_TAG',
      },
    },
  },
});
