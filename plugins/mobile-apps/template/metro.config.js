const fs = require('node:fs');
const path = require('node:path');
const { createPowerAppsMetroConfig } = require('@microsoft/power-apps-native-host/config/metroConfig');

// CUSTOMIZATION START - DO NOT REMOVE OR RENAME THE COMMENT
// Add Metro config changes in this function only.
function customizeMetroConfig(config) {
  const enhanceMiddleware = config.server.enhanceMiddleware;
  config.server = {
    ...config.server,
    enhanceMiddleware: middleware => {
      const enhanced = enhanceMiddleware(middleware);
      return (request, response, next) => {
        if (request.url !== '/__pawrap_verify') return enhanced(request, response, next);
        const appConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'app.json'), 'utf8'));
        const appInstanceId = appConfig.expo?.extra?.telemetry?.appInstanceId;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(appInstanceId || '')) {
          throw new Error('app.json is missing a valid generated app identity');
        }
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.end(JSON.stringify({
          type: 'pawrap-app',
          version: '1',
          appInstanceId,
          templateVersion: appConfig.expo.extra.powerappsNative.templateVersion,
          nativeRuntimeVersions: appConfig.expo.extra.powerappsNative.nativeRuntimeVersions,
        }));
      };
    },
  };
  return config;
}
// CUSTOMIZATION END - DO NOT REMOVE OR RENAME THE COMMENT

module.exports = createPowerAppsMetroConfig(__dirname, customizeMetroConfig);
