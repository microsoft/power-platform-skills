const { getDefaultConfig } = require('expo/metro-config');

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
  if (
    moduleName === 'react' ||
    moduleName === 'react-native' ||
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

module.exports = config;
