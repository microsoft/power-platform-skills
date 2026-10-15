#!/usr/bin/env node
'use strict';

function fail(message) {
  const error = new Error(message);
  error.code = 'MOBILE_RELEASE_BLOCKED';
  throw error;
}

function main(argv) {
  const {
    selectRelease, resolveProjectRelease, selectProjectRelease, summarizeRelease,
  } = require('./lib/mobile-release');
  const values = {};
  const flags = new Set(['--project-root', '--release', '--host-version', '--template-version', '--default', '--platform', '--base-version', '--base-fingerprint', '--base-runtime-version', '--requirements-only', '--diagnostic-artifacts']);
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
  if (values['--diagnostic-artifacts']) {
    if (['--release', '--host-version', '--template-version', '--default', '--platform', '--base-version', '--base-fingerprint', '--base-runtime-version', '--requirements-only'].some((flag) => values[flag])) {
      fail('Diagnostic artifacts cannot select a published release, requirements-only bypass, or deployment base. Tenant/store deployment is prohibited.');
    }
    const { loadDiagnosticArtifacts, resolveDiagnosticProject, summary } = require('./lib/mobile-diagnostic-artifacts');
    const selection = values['--project-root']
      ? resolveDiagnosticProject(values['--project-root'], values['--diagnostic-artifacts'])
      : loadDiagnosticArtifacts(values['--diagnostic-artifacts']);
    process.stdout.write(`${JSON.stringify(summary(selection), null, 2)}\n`);
    return;
  }
  if ([values['--release'], values['--host-version'], values['--default']].filter(Boolean).length > 1) {
    fail('Choose one host version selection, not multiple selectors.');
  }
  if (values['--template-version'] && (values['--release'] || values['--host-version'] || values['--default'])) {
    fail('Select the host or the template package, not both.');
  }
  if (!values['--project-root'] && !values['--release'] && !values['--host-version'] && !values['--template-version'] && !values['--default']) {
    fail('Use --project-root DIR, --host-version VERSION, --template-version VERSION, or --default.');
  }
  if (values['--platform'] && !['android', 'ios'].includes(values['--platform'])) fail('Deployment platform must be android or ios.');
  if ((values['--base-version'] || values['--base-fingerprint'] || values['--base-runtime-version']) && !values['--platform']) {
    fail('Checking a deployment base requires --platform android or ios.');
  }
  if (values['--platform'] && (!values['--base-version'] || !values['--base-fingerprint'])) {
    fail('Deployment checks require both --base-version and --base-fingerprint from the actual selected platform base. Version alone does not verify native compatibility.');
  }
  if (values['--platform'] && !values['--project-root']) {
    fail('Deployment-base validation requires --project-root to verify the app metadata, lock and installed native dependencies.');
  }
  if (values['--requirements-only']) {
    if (!values['--project-root']) fail('Read-only --requirements-only planning requires --project-root DIR.');
    if (['--release', '--host-version', '--template-version', '--default', '--platform', '--base-version', '--base-fingerprint', '--base-runtime-version'].some((flag) => values[flag])) {
      fail('Requirements-only planning cannot assert a selected release or check deployment targets. Use strict project resolution for admission and deployment.');
    }
  }

  let selected = null;
  if (values['--template-version']) {
    selected = require('./lib/mobile-published-packages').selectTemplateContract(values['--template-version']);
  } else if (values['--release'] || values['--host-version'] || values['--default']) {
    const version = values['--host-version'] || values['--release']
      || require('./lib/mobile-published-packages').createSource().defaultVersion();
    selected = selectRelease(version);
  }
  const current = values['--project-root']
    ? (values['--requirements-only'] ? selectProjectRelease : resolveProjectRelease)(values['--project-root']) : null;
  if (selected && current && selected.id !== current.id) fail('The project does not match the exact selected verified release.');
  const release = current || selected;
  if (values['--base-version'] && release.source !== 'npm'
    && release.platforms[values['--platform']].base.version !== values['--base-version']) {
    fail('The deployment base does not match the selected platform in the verified release.');
  }
  if (values['--base-fingerprint'] && release.platforms[values['--platform']].fingerprint !== values['--base-fingerprint']) {
    fail('The deployment base fingerprint does not match the selected platform in the verified release. Do not deploy with an unverified native base.');
  }
  const summary = summarizeRelease(release);
  if (values['--platform'] && release.source === 'npm') {
    const runtime = values['--base-runtime-version'];
    if (!/^[1-9]\d*$/.test(runtime || '') || !Number.isSafeInteger(Number(runtime))
      || Number(runtime) !== release.nativeRuntimeVersions[values['--platform']]) {
      fail('Published package admission also requires the actual selected base runtime version; it must match the host contract.');
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/.test(values['--base-version'])) fail('Invalid selected base version.');
    summary.deploymentBase = {
      platform: values['--platform'], version: values['--base-version'],
      nativeRuntimeVersion: Number(runtime), fingerprint: values['--base-fingerprint'],
    };
    summary.validationScope = 'app-and-base-native-contract; regional availability must be verified by Wrap';
  }
  if (values['--requirements-only']) summary.validationScope = 'requirements-only';
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  const message = error.code === 'MOBILE_RELEASE_BLOCKED'
    ? error.message : 'Unable to verify published package compatibility. Check registry access and the project installation.';
  process.stderr.write(`BLOCKED: ${message}\n`);
  process.exitCode = 2;
}
