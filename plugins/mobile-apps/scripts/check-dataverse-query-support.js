#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const semver = require('./vendor/semver.cjs');
const {
  configuredDataSources,
  dataSourceEntries,
  verifyDataverseServices,
} = require('./verify-dataverse-services');

const SDK_VERSION = '1.6.0';
const CLI_VERSION = '1.4.1';
const FEATURES = ['expand', 'apply', 'saved-query'];

function supportsRelease(version, minimum) {
  const release = typeof version === 'string' ? semver.valid(version) : null;
  return Boolean(release && !semver.prerelease(release) && semver.gte(release, minimum));
}

function installedVersion(projectRoot, name) {
  const resolve = createRequire(path.join(projectRoot, 'package.json')).resolve;
  let entry;
  try {
    entry = resolve(name === '@microsoft/power-apps' ? `${name}/data` : `${name}/package.json`);
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
  for (let directory = path.dirname(entry); ; directory = path.dirname(directory)) {
    const manifest = path.join(directory, 'package.json');
    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (pkg.name === name) return pkg.version;
    }
    if (directory === path.dirname(directory)) break;
  }
  throw new Error(`Could not locate installed ${name} metadata`);
}

function generatedOptions(servicePath, source) {
  const generatedRoot = path.resolve(path.dirname(servicePath), '..');
  const options = {};
  // Both CLI generators import IGetOptions/IGetAllOptions from a local CommonModels
  // module. Follow those imports, not an unrelated service's newer options.
  for (const match of source.matchAll(/\bimport\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g)) {
    if (!match[2].startsWith('.')) continue;
    for (const name of ['IGetOptions', 'IGetAllOptions']) {
      if (!match[1].split(',').some((item) => item.trim() === name)) continue;
      const file = path.resolve(path.dirname(servicePath), match[2].replace(/\.js$/, '') + '.ts');
      const relative = path.relative(generatedRoot, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Generated options import leaves src/generated: ${match[2]}`);
      }
      const text = fs.readFileSync(file, 'utf8');
      options[name] = new RegExp(`\\binterface\\s+${name}\\s*\\{([^}]+)\\}`).exec(text)?.[1] || '';
    }
  }
  return options;
}

function inspectService(servicePath) {
  const source = fs.readFileSync(servicePath, 'utf8');
  const options = generatedOptions(servicePath, source);
  const genericGet = /\bstatic\s+(?:async\s+)?get\s*</.test(source);
  const genericGetAll = /\bstatic\s+(?:async\s+)?getAll\s*</.test(source);
  const expandOption = /\bexpand\?\s*:\s*string\[\]/;
  return {
    expand: genericGet && genericGetAll
      && expandOption.test(options.IGetOptions || '')
      && expandOption.test(options.IGetAllOptions || ''),
    apply: genericGetAll && /\bapply\?\s*:\s*string\b/.test(options.IGetAllOptions || ''),
    'saved-query': /\bstatic\s+(?:async\s+)?getSavedQuery\s*</.test(source)
      && /\bretrieveSavedQueryAsync\s*</.test(source),
  };
}

function checkQuerySupport(projectRoot, tables = []) {
  const root = path.resolve(projectRoot);
  const sdkVersion = installedVersion(root, '@microsoft/power-apps');
  const cliVersion = installedVersion(root, '@microsoft/power-apps-cli');
  const configPath = path.join(root, 'power.config.json');
  const dataSources = fs.existsSync(configPath)
    ? configuredDataSources(JSON.parse(fs.readFileSync(configPath, 'utf8')))
    : undefined;
  const entries = dataSourceEntries(dataSources);
  const required = tables.length ? tables : entries.map(({ value }) => value?.logicalName);
  const sdkSupported = supportsRelease(sdkVersion, SDK_VERSION);
  const services = verifyDataverseServices(root, required).map((service) => {
    const generated = inspectService(path.join(root, 'src', 'generated', 'services', service.serviceFile));
    const bindings = entries.filter(({ value }) => (
      typeof value?.logicalName === 'string' && value.logicalName.trim().toLowerCase() === service.logicalName
    ));
    return {
      ...service,
      // Legacy array indexes are not CLI registration names; never recommend "refresh --name 0".
      bindingName: !Array.isArray(dataSources) && bindings.length === 1 ? bindings[0].key : null,
      generated,
      supported: Object.fromEntries(FEATURES.map((feature) => [feature, sdkSupported && generated[feature]])),
    };
  });
  const messages = [];
  if (!sdkSupported) {
    messages.push(`Dataverse query features require Power Apps SDK ${SDK_VERSION} or newer. `
      + 'Keep existing queries unchanged; update compatible packages manually before using these features.');
  }
  if (services.some((service) => FEATURES.some((feature) => !service.generated[feature]))) {
    messages.push(`Generated query methods/options are missing. Manually refresh the retained data sources `
      + `with a query-capable CLI (verified with ${CLI_VERSION}), then regenerate schemas and type-check.`);
  }
  return {
    sdkVersion,
    cliVersion,
    sdkSupported,
    generatorSupported: supportsRelease(cliVersion, CLI_VERSION),
    testedVersions: { sdk: SDK_VERSION, cli: CLI_VERSION },
    scope: 'SDK and generated online Dataverse services; offline execution is not verified by this check',
    messages,
    services,
  };
}

function main(argv = process.argv.slice(2)) {
  try {
    let projectRoot;
    const tables = [];
    let required = [];
    for (let index = 0; index < argv.length; index += 1) {
      const flag = argv[index];
      if (!['--project-root', '--table', '--require'].includes(flag) || !argv[index + 1]
        || argv[index + 1].startsWith('--')) throw new Error(`Invalid argument: ${flag}`);
      const value = argv[++index];
      if (flag === '--project-root') projectRoot = value;
      if (flag === '--table') tables.push(value);
      if (flag === '--require') required = value.split(',');
    }
    if (!projectRoot) throw new Error('--project-root is required');
    if (required.some((feature) => !FEATURES.includes(feature))) {
      throw new Error(`--require accepts ${FEATURES.join(',')}`);
    }
    const report = checkQuerySupport(projectRoot, tables);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (required.length && (!report.services.length || report.services.some(
      (service) => required.some((feature) => !service.supported[feature]),
    ))) {
      throw new Error('Required Dataverse query support is unavailable. '
        + (report.messages.join(' ') || 'The requested generated Dataverse service is not available.')
        + ' No project files were changed; do not edit generated files or migrate existing queries.');
    }
    return 0;
  } catch (error) {
    process.stderr.write(`check-dataverse-query-support: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { SDK_VERSION, CLI_VERSION, checkQuerySupport, inspectService, main, supportsRelease };
