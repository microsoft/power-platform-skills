'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createStartupScenario(root) {
  const files = {
    'package.json': {
      name: 'startup-scenario',
      packageManager: 'npm@10.0.0',
      engines: { node: '>=20' },
      scripts: { predev: 'node scripts/check-launch.cjs', dev: 'node scripts/dev.cjs' },
      dependencies: { 'sample-package': '1.0.0' },
    },
    'package-lock.json': {
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { 'sample-package': '1.0.0' } },
        'node_modules/sample-package': { version: '1.0.0' },
      },
    },
    'node_modules/sample-package/package.json': {
      name: 'sample-package', version: '1.0.0', exports: { './config': './config.js' },
    },
    'node_modules/sample-package/config.js': 'module.exports = {};\n',
    'launch-config.json': { entry: 'app/start.tsx' },
    'app/index.tsx': 'export default function Index() { return null; }\n',
    'scripts/check-launch.cjs': [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const root = path.resolve(__dirname, '..');",
      "const config = JSON.parse(fs.readFileSync(path.join(root, 'launch-config.json'), 'utf8'));",
      'if (!fs.existsSync(path.join(root, config.entry))) {',
      "  console.error('STARTUP_ENTRY_MISSING: ' + config.entry);",
      '  process.exitCode = 1;',
      '}',
      '',
    ].join('\n'),
    'scripts/dev.cjs': "console.log('Synthetic dev command completed; not a Metro server.');\n",
    'metro.config.js': 'module.exports = {};\n',
    'babel.config.js': 'module.exports = {};\n',
    'app.config.js': 'module.exports = {};\n',
    'power.config.json': {},
  };
  for (const [relative, value] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  }
}

module.exports = { createStartupScenario };
