'use strict';

// Rebuild the committed browser runtime used by no-CDN widgets.
// Run `npm ci && npm run build` from this directory after intentionally updating
// a pinned dependency, then review the bundle, provenance, and license notices.
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const root = __dirname;
const assetDir = path.resolve(root, '..', '..', 'assets', 'self-contained');
const outputPath = path.join(assetDir, 'mcp-app-runtime.min.js');
const provenancePath = path.join(assetDir, 'PROVENANCE.json');
const checkOnly = process.argv.includes('--check');

function packageRoot(packageName) {
  const installedRoot = path.join(root, 'node_modules', ...packageName.split('/'));
  if (fs.existsSync(path.join(installedRoot, 'package.json'))) return installedRoot;

  let directory = path.dirname(require.resolve(packageName));
  while (directory !== path.dirname(directory)) {
    const manifestPath = path.join(directory, 'package.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.name === packageName) return directory;
    }
    directory = path.dirname(directory);
  }
  throw new Error(`Could not locate package.json for ${packageName}.`);
}

function packageVersion(packageName) {
  return JSON.parse(fs.readFileSync(path.join(packageRoot(packageName), 'package.json'), 'utf8')).version;
}

const bundledLicensePackages = [
  '@modelcontextprotocol/ext-apps',
  '@modelcontextprotocol/sdk',
  '@fluentui/tokens',
  '@standard-schema/spec',
  '@swc/helpers',
  'zod',
];
const licenseFileNames = {
  '@fluentui/tokens': 'fluentui-tokens.txt',
  '@modelcontextprotocol/ext-apps': 'modelcontextprotocol-ext-apps.txt',
  '@modelcontextprotocol/sdk': 'modelcontextprotocol-sdk.txt',
  '@standard-schema/spec': 'standard-schema-spec.txt',
  '@swc/helpers': 'swc-helpers.txt',
  zod: 'zod.txt',
};

function packageLicense(packageName) {
  return fs.readFileSync(path.join(packageRoot(packageName), 'LICENSE'), 'utf8');
}

function licenseBanner() {
  const sections = bundledLicensePackages.map((packageName) => {
    const license = packageLicense(packageName)
      .trim()
      .replace(/[ \t]+$/gm, '')
      .replaceAll('*/', '* /');
    return `----- ${packageName} -----\n${license}`;
  });
  // Keep the license notices inside the runtime so the generated one-file HTML remains
  // redistributable without a companion notices file.
  return `/*!\nSelf-contained MCP Apps runtime third-party licenses\n\n${sections.join('\n\n')}\n*/`;
}

async function buildBundle() {
  const result = await esbuild.build({
    entryPoints: [path.join(root, 'entry.js')],
    bundle: true,
    format: 'iife',
    legalComments: 'none',
    minify: true,
    platform: 'browser',
    target: 'es2022',
    write: false,
    banner: {
      js: licenseBanner(),
    },
  });
  assert.strictEqual(result.outputFiles.length, 1, 'expected one JavaScript bundle');
  return result.outputFiles[0].text;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function expectedProvenance(bundle) {
  return {
    artifact: 'mcp-app-runtime.min.js',
    sha256: sha256(bundle),
    build: {
      entry: 'scripts/_vendor-build/entry.js',
      command: 'npm ci && npm run build',
      nodeTarget: 'es2022',
      esbuild: packageVersion('esbuild'),
    },
    packages: {
      '@fluentui/tokens': {
        version: packageVersion('@fluentui/tokens'),
        source: 'https://github.com/microsoft/fluentui',
      },
      '@modelcontextprotocol/ext-apps': {
        version: packageVersion('@modelcontextprotocol/ext-apps'),
        source: 'https://github.com/modelcontextprotocol/ext-apps',
      },
    },
    licenses: 'THIRD-PARTY-NOTICES.md',
    licensePackagesEmbeddedInArtifact: bundledLicensePackages,
  };
}

function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function main() {
  const bundle = await buildBundle();
  const provenance = formatJson(expectedProvenance(bundle));

  if (checkOnly) {
    assert.strictEqual(fs.readFileSync(outputPath, 'utf8'), bundle, 'runtime bundle is stale');
    assert.strictEqual(fs.readFileSync(provenancePath, 'utf8'), provenance, 'runtime provenance is stale');
    for (const packageName of bundledLicensePackages) {
      const committedPath = path.join(assetDir, 'licenses', licenseFileNames[packageName]);
      assert.strictEqual(
        fs.readFileSync(committedPath, 'utf8'),
        packageLicense(packageName),
        `${packageName} license copy is stale`,
      );
    }
    console.log('Self-contained MCP Apps runtime is current.');
    return;
  }

  fs.mkdirSync(assetDir, { recursive: true });
  fs.mkdirSync(path.join(assetDir, 'licenses'), { recursive: true });
  fs.writeFileSync(outputPath, bundle);
  fs.writeFileSync(provenancePath, provenance);
  for (const packageName of bundledLicensePackages) {
    fs.writeFileSync(
      path.join(assetDir, 'licenses', licenseFileNames[packageName]),
      packageLicense(packageName),
    );
  }
  console.log(`Wrote ${path.relative(process.cwd(), outputPath)} (${Buffer.byteLength(bundle)} bytes).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
