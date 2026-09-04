const { createPowerAppsMetroConfig } = require('@microsoft/power-apps-native-host/config/metroConfig');

// CUSTOMIZATION START - DO NOT REMOVE OR RENAME THE COMMENT
// Add Metro config changes in this function only.
function customizeMetroConfig(config) {
  return config;
}
// CUSTOMIZATION END - DO NOT REMOVE OR RENAME THE COMMENT

module.exports = createPowerAppsMetroConfig(__dirname, customizeMetroConfig);
