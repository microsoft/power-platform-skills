#!/usr/bin/env node
'use strict';

function fail(message) {
  const error = new Error(message);
  error.code = 'MOBILE_RELEASE_BLOCKED';
  throw error;
}

function main(argv) {
  const {
    readCatalog, selectRelease, resolveProjectRelease, selectProjectRelease, summarizeRelease,
  } = require('./lib/mobile-release');
  const values = {};
  const flags = new Set(['--project-root', '--release', '--default', '--platform', '--base-version', '--base-fingerprint', '--requirements-only']);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flags.has(flag) || Object.hasOwn(values, flag)) fail('Unknown or duplicate release resolver argument.');
    if (flag === '--default' || flag === '--requirements-only') {
      values[flag] = true;
    } else {
      const value = argv[++index];
      if (!value || value.startsWith('--')) fail('A release resolver argument is missing its value.');
      values[flag] = value;
    }
  }
  if (values['--release'] && values['--default']) fail('Choose --release or --default, not both.');
  if (!values['--project-root'] && !values['--release'] && !values['--default']) {
    fail('Use --project-root DIR, --release ID, or --default.');
  }
  if (values['--platform'] && !['android', 'ios'].includes(values['--platform'])) fail('Deployment platform must be android or ios.');
  if ((values['--base-version'] || values['--base-fingerprint']) && !values['--platform']) {
    fail('Checking a deployment base requires --platform android or ios.');
  }
  if (values['--platform'] && (!values['--base-version'] || !values['--base-fingerprint'])) {
    fail('Deployment checks require both --base-version and --base-fingerprint from the actual selected platform base. Version alone does not verify native compatibility.');
  }
  if (values['--requirements-only']) {
    if (!values['--project-root']) fail('Read-only --requirements-only planning requires --project-root DIR.');
    if (['--release', '--default', '--platform', '--base-version', '--base-fingerprint'].some((flag) => values[flag])) {
      fail('Requirements-only planning cannot assert a selected release or check deployment targets. Use strict project resolution for admission and deployment.');
    }
  }

  const catalog = readCatalog();
  const selected = values['--release'] || values['--default']
    ? selectRelease(values['--release'], catalog) : null;
  const current = values['--project-root']
    ? (values['--requirements-only'] ? selectProjectRelease : resolveProjectRelease)(values['--project-root'], catalog) : null;
  if (selected && current && selected.id !== current.id) fail('The project does not match the exact selected verified release.');
  const release = current || selected;
  if (values['--base-version'] && release.platforms[values['--platform']].base.version !== values['--base-version']) {
    fail('The deployment base does not match the selected platform in the verified release.');
  }
  if (values['--base-fingerprint'] && release.platforms[values['--platform']].fingerprint !== values['--base-fingerprint']) {
    fail('The deployment base fingerprint does not match the selected platform in the verified release. Do not deploy with an unverified native base.');
  }
  const summary = summarizeRelease(release);
  if (values['--requirements-only']) summary.validationScope = 'requirements-only';
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  const message = error.code === 'MOBILE_RELEASE_BLOCKED'
    ? error.message : 'Unable to verify the mobile release. Restore the policy and project installation.';
  process.stderr.write(`BLOCKED: ${message}\n`);
  process.exitCode = 2;
}
