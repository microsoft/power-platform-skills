const fs = require('node:fs');
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const POWER_NATIVE_LOG_DIR = path.join(__dirname, '.powernative', 'metro-logs');
const POWER_NATIVE_LOG_STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const SENSITIVE_LINE_PATTERN = /\b(?:authorization|bearer|client[_-]?secret|password|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|accountkey|sharedaccesskey)\b|[?&](?:sig|se|sp|sv|token|access_token|code|client_secret)=|\b(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{20,})\b/i;
let powerNativePort = 'unknown';
let powerNativeLogPath = path.join(POWER_NATIVE_LOG_DIR, `metro-${POWER_NATIVE_LOG_STAMP}-pid-${process.pid}-port-${powerNativePort}.log`);

function stripAnsi(value) {
  return String(value).replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '');
}

function redactMetroLog(value) {
  return stripAnsi(value).replace(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g, (line) => {
    if (!SENSITIVE_LINE_PATTERN.test(line)) return line;
    const ending = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : line.endsWith('\r') ? '\r' : '';
    return `[powernative] [REDACTED_SENSITIVE_LINE]${ending}`;
  });
}

function appendMetroLog(value) {
  try {
    fs.mkdirSync(POWER_NATIVE_LOG_DIR, { recursive: true });
    fs.appendFileSync(powerNativeLogPath, redactMetroLog(value));
  } catch {
    // Logging must never break Metro startup.
  }
}

function setPowerNativePort(port) {
  if (!Number.isInteger(port) || port <= 0 || String(port) === powerNativePort) return;
  const previousPath = powerNativeLogPath;
  powerNativePort = String(port);
  powerNativeLogPath = path.join(POWER_NATIVE_LOG_DIR, `metro-${POWER_NATIVE_LOG_STAMP}-pid-${process.pid}-port-${powerNativePort}.log`);
  try {
    fs.mkdirSync(POWER_NATIVE_LOG_DIR, { recursive: true });
    if (fs.existsSync(previousPath) && previousPath !== powerNativeLogPath) {
      fs.renameSync(previousPath, powerNativeLogPath);
    }
  } catch {
    // Keep writing to the current path if rename fails.
    powerNativeLogPath = previousPath;
  }
}

function extractMetroPort(value) {
  const match = String(value).match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})/);
  const port = match ? Number(match[1]) : null;
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function teeStream(stream, write) {
  return function patchedWrite(chunk, encoding, callback) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    appendMetroLog(text);
    setPowerNativePort(extractMetroPort(text));
    return write.call(stream, chunk, encoding, callback);
  };
}

process.stdout.write = teeStream(process.stdout, process.stdout.write);
process.stderr.write = teeStream(process.stderr, process.stderr.write);
appendMetroLog(`[powernative] Metro log started pid=${process.pid}\n`);

function withPowerNativeLogging(middleware) {
  return (req, res, next) => {
    setPowerNativePort(Number(req.socket && req.socket.localPort));
    const chunks = [];
    const write = res.write.bind(res);
    const end = res.end.bind(res);

    res.write = (chunk, encoding, callback) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding));
      return write(chunk, encoding, callback);
    };

    res.end = (chunk, encoding, callback) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding));
      if (res.statusCode >= 400) {
        const body = Buffer.concat(chunks).toString('utf8');
        appendMetroLog(`\n[powernative] HTTP ${req.method} ${req.url} -> ${res.statusCode}\n${body.slice(0, 262144)}\n`);
      }
      return end(chunk, encoding, callback);
    };

    return middleware(req, res, next);
  };
}

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
  enhanceMiddleware: (middleware) => withPowerNativeLogging((req, res, next) => {
    if (req.url === '/__pawrap_verify') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.end(JSON.stringify({ type: 'pawrap-app', version: '1' }));
      return;
    }
    middleware(req, res, next);
  }),
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
