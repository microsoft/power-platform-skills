// CUSTOMIZATION START - DO NOT REMOVE OR RENAME THE COMMENT
// Add Babel presets and plugins to these arrays only.
const customPresets = [];
const customPlugins = [];
// CUSTOMIZATION END - DO NOT REMOVE OR RENAME THE COMMENT

module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo', ...customPresets],
    plugins: [
      ...customPlugins,
      // Must be last
      'react-native-reanimated/plugin',
    ],
  };
};
