/**
 * Dynamic Expo config for the Power Apps standalone template.
 */

const IS_DEV_CLIENT = process.env.DEV_CLIENT === 'true';

const APP_NAME = process.env.APP_DISPLAY_NAME || 'Power Apps Standalone App';
const APP_SLUG = process.env.APP_SLUG || 'powerapps-standalone-app';
const APP_SCHEME = process.env.APP_SCHEME || APP_SLUG;
const ANDROID_PACKAGE = process.env.ANDROID_PACKAGE || 'com.contoso.powerappsapp';
const IOS_BUNDLE_IDENTIFIER = process.env.IOS_BUNDLE_IDENTIFIER || 'com.contoso.powerappsapp';


/** @type {import('expo/config').ExpoConfig} */
module.exports = ({ config }) => ({
  ...config,
  name: APP_NAME,
  slug: APP_SLUG,
  version: '1.0.0',
  scheme: APP_SCHEME,
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
        // app-specific variant to CFBundleURLTypes when needed, while the
        // generic msauthv2/v3 entries here cover SDK detection.
      ],
      // IntuneMAMSettings — read at runtime by the host auth bridge.
      // Downstream packaging can patch ADALClientId and ADALRedirectUri here
      // via `plutil -replace IntuneMAMSettings.*`.
      // Placeholder values are replaced during packaging; the app falls back to
      // auth.config.json values when a placeholder tag is still present.
      IntuneMAMSettings: {
        ADALClientId: 'ADAL_CLIENT_ID_TAG',
        ADALRedirectUri: 'ADAL_REDIRECT_URI_TAG',
        ADALTenantId: 'ADAL_TENANT_ID_TAG',
      },
    },
  },
});
