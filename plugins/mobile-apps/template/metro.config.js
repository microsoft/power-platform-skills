const { getDefaultConfig } = require('expo/metro-config');

// CUSTOMIZATION START - DO NOT REMOVE OR RENAME THE COMMENT
// Add Metro config changes in this function only.
function customizeMetroConfig(config) {
  return config;
}
// CUSTOMIZATION END - DO NOT REMOVE OR RENAME THE COMMENT

const config = getDefaultConfig(__dirname);

config.resolver.sourceExts = [...config.resolver.sourceExts, 'mjs'];
config.server = {
  ...config.server,
  enhanceMiddleware: (middleware) => (req, res, next) => {
    if (req.url === '/__pawrap_verify') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.end(JSON.stringify({ type: 'pawrap-app', version: '1' }));
      return;
    }
    middleware(req, res, next);
  },
};

// Force a single copy of these regardless of where the importing module lives.
const _defaultResolver = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const isNodeRenderer = context.customResolverOptions?.environment === 'node';
  if (
    (!isNodeRenderer && (moduleName === 'react' || moduleName.startsWith('react/'))) ||
    (moduleName === 'react-native' && platform !== 'web') ||
    moduleName.startsWith('@babel/runtime')
  ) {
    return {
      filePath: require.resolve(moduleName, {
        paths: [require('path').resolve(__dirname, 'node_modules')],
      }),
      type: 'sourceFile',
    };
  }
  return _defaultResolver
    ? _defaultResolver(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = customizeMetroConfig(config);
