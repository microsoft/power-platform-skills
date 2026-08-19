const path = require('node:path');

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.tsx']);
const TEXT_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);

function hasExtension(filePath, extensions) {
  return extensions.has(path.extname(filePath).toLowerCase());
}

const VALIDATORS = [
  { script: 'validate-write-safety.js', appliesTo: () => true },
  { script: 'validate-protected-paths.js', appliesTo: () => true },
  { script: 'validate-package-deps.js', appliesTo: (filePath) => path.basename(filePath) === 'package.json' },
  { script: 'validate-experience-contract.js', appliesTo: (filePath) => path.basename(filePath) === 'native-app-plan.md' },
  { script: 'validate-icon-imports.js', appliesTo: (filePath) => hasExtension(filePath, SOURCE_EXTENSIONS) },
  { script: 'validate-connector-first.js', appliesTo: (filePath) => hasExtension(filePath, SOURCE_EXTENSIONS) },
  { script: 'validate-dataverse-payload.js', appliesTo: (filePath) => hasExtension(filePath, TYPESCRIPT_EXTENSIONS) },
  { script: 'validate-dataverse-heavy-lists.js', appliesTo: (filePath) => hasExtension(filePath, TYPESCRIPT_EXTENSIONS) },
  { script: 'validate-navigation-idempotency.js', appliesTo: (filePath) => path.extname(filePath).toLowerCase() === '.tsx' },
  { script: 'validate-screen-quality.js', appliesTo: (filePath) => path.extname(filePath).toLowerCase() === '.tsx' },
  { script: 'validate-color-contrast.js', appliesTo: (filePath) => path.extname(filePath).toLowerCase() === '.tsx' },
  { script: 'validate-screen-composition.js', appliesTo: (filePath) => path.extname(filePath).toLowerCase() === '.tsx' },
];

function isTextFile(filePath) {
  return hasExtension(filePath, TEXT_EXTENSIONS);
}

module.exports = {
  VALIDATORS,
  isTextFile,
};