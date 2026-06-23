#!/usr/bin/env node
/**
 * postinstall.js
 *
 * Patches the React Native Gradle plugin to avoid the Foojay toolchain
 * resolver, which crashes local Android builds when a valid JDK is already
 * installed.
 */
const fs = require('fs');
const path = require('path');

const reactNativeGradleSettingsPath = path.join(
  __dirname,
  'node_modules',
  '@react-native',
  'gradle-plugin',
  'settings.gradle.kts'
);

if (fs.existsSync(reactNativeGradleSettingsPath)) {
  const original = fs.readFileSync(reactNativeGradleSettingsPath, 'utf8');
  const patched = original.replace(
    'plugins { id("org.gradle.toolchains.foojay-resolver-convention").version("0.5.0") }',
    '// Disabled: use the locally configured JAVA_HOME instead of Foojay toolchain resolution.'
  );

  if (patched !== original) {
    fs.writeFileSync(reactNativeGradleSettingsPath, patched, 'utf8');
    console.log('[postinstall] Disabled Foojay resolver in @react-native/gradle-plugin/settings.gradle.kts');
  }
}
