#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { screenWorkOrder } = require('./compile-screen-build-pack');
const { screenInputFingerprint } = require('./validate-screen-artifact');
const { validateScreenBuildPack } = require('./validate-screen-build-pack');

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function nativeCanaryDispatch(pack, fingerprintForScreen) {
  if (!pack?.nativeCanary?.screenIds?.length) throw new Error('screen build pack is missing native canary authority');
  const targets = pack.nativeCanary.screenIds.map((screenId) => {
    const fingerprint = fingerprintForScreen(screenId);
    return {
      screenId,
      inputFileSha256: fingerprint.inputFileSha256,
      workOrder: screenWorkOrder(pack, screenId),
    };
  });
  return {
    schemaVersion: 1,
    kind: 'native-canary-dispatch',
    packRevision: pack.revision,
    primaryScreenId: pack.nativeCanary.primaryScreenId,
    keyFlowScreenIds: pack.nativeCanary.keyFlowScreenIds,
    outcome: pack.nativeCanary.outcome,
    targets,
  };
}

function prepareNativeCanary(projectRoot, packPath = '.tmp/screen-build-pack.json') {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const resolvedPackPath = path.resolve(root, packPath);
  const pack = readJson(resolvedPackPath, 'Screen build pack');
  const validation = validateScreenBuildPack(root, pack);
  if (validation.issues.length) throw new Error(`invalid screen build pack: ${validation.issues.map((issue) => issue.message).join('; ')}`);
  return nativeCanaryDispatch(pack, (screenId) => screenInputFingerprint(root, pack, screenId));
}

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--pack') args.pack = argv[++index];
  }
  if (!args.projectRoot) {
    process.stderr.write('Usage: node prepare-native-canary.js --project-root <dir> [--pack .tmp/screen-build-pack.json]\n');
    return 2;
  }
  try {
    process.stdout.write(`${JSON.stringify(prepareNativeCanary(args.projectRoot, args.pack), null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`prepare-native-canary: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { nativeCanaryDispatch, prepareNativeCanary };
