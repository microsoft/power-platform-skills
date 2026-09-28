const { createPowerAppsBabelConfig } = require('@microsoft/power-apps-native-host/config/babelConfig');

// CUSTOMIZATION START - DO NOT REMOVE OR RENAME THE COMMENT
// Add Babel presets and plugins to these arrays only.
const customPresets = [];
const customPlugins = [];
// CUSTOMIZATION END - DO NOT REMOVE OR RENAME THE COMMENT

module.exports = function (api) {
  return createPowerAppsBabelConfig(api, {
    presets: customPresets,
    plugins: customPlugins,
  });
};
