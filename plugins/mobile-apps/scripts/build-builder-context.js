#!/usr/bin/env node
'use strict';

/**
 * Builds immutable, hash-bound context packets for screen-builder agents.
 *
 * Usage:
 *   node build-builder-context.js <project-dir> build
 *   node build-builder-context.js <project-dir> check <packet-path>
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  hashFile,
  readJson,
  sha256,
  stableJson,
  writeJsonAtomic,
} = require('./lib/workflow-artifacts');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

function fail(message) {
  console.error(`builder-context: ${message}`);
  process.exit(2);
}

function artifact(projectRoot, relativePath, required = true) {
  const filePath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(filePath)) {
    if (required) fail(`required artifact missing: ${relativePath}`);
    return null;
  }
  return { path: relativePath, sha256: hashFile(filePath) };
}

function checkArtifact(projectRoot, record, label) {
  if (!record || typeof record.path !== 'string' || typeof record.sha256 !== 'string') {
    fail(`packet ${label} artifact is invalid`);
  }
  const current = artifact(projectRoot, record.path, true);
  if (current.sha256 !== record.sha256) fail(`packet ${label} hash mismatch: ${record.path}`);
}

function packetPayload(packet) {
  const payload = { ...packet };
  delete payload.contextSha256;
  delete payload.generatedAt;
  return payload;
}

function references() {
  return [
    'shared/samples/src/components/index.tsx',
    'shared/references/screen-templates.md',
    'shared/references/accessibility-checklist.md',
    'agents/screen-builder.md',
  ].map((relativePath) => ({
    path: relativePath,
    sha256: hashFile(path.join(PLUGIN_ROOT, relativePath)),
  }));
}

function build(projectRoot) {
  const screenContract = readJson(path.join(projectRoot, '.tmp', 'screen-contract.json'));
  const serviceInventory = readJson(path.join(projectRoot, '.tmp', 'service-inventory.json'));
  const navigationContract = readJson(path.join(projectRoot, '.tmp', 'navigation-contract.json'));
  const designDecision = readJson(path.join(projectRoot, 'brand', 'design-decision.json'));
  const plan = artifact(projectRoot, 'native-app-plan.md');
  const screenContractArtifact = artifact(projectRoot, '.tmp/screen-contract.json');
  const serviceInventoryArtifact = artifact(projectRoot, '.tmp/service-inventory.json');
  const navigationContractArtifact = artifact(projectRoot, '.tmp/navigation-contract.json');
  const designDecisionArtifact = artifact(projectRoot, 'brand/design-decision.json');
  const referenceRecords = references();
  const outputRoot = path.join(projectRoot, '.tmp', 'builder-context');
  fs.mkdirSync(outputRoot, { recursive: true });
  const packets = [];

  for (const screen of screenContract.screens || []) {
    if (screen.source === 'keep') continue;
    const target = artifact(projectRoot, screen.file);
    const requestedServices = (screen.services || []).map((name) => {
      const service = (serviceInventory.services || []).find((candidate) => candidate.name === name);
      if (!service) fail(`screen ${screen.id} references missing service ${name}`);
      return service;
    });
    const route = (navigationContract.routes || []).find((candidate) => candidate.id === screen.id);
    if (!route) fail(`screen ${screen.id} is missing from navigation contract`);
    const packet = {
      schemaVersion: 1,
      screen: {
        id: screen.id,
        name: screen.name,
        route: screen.route,
        file: screen.file,
        archetype: screen.archetype,
        presentation: screen.presentation,
        nativeCapabilities: screen.nativeCapabilities || [],
        scaffold: screen.scaffold,
      },
      route,
      services: requestedServices,
      design: {
        direction: designDecision.finalSelection?.direction,
        confirmationStatus: designDecision.userConfirmation?.status,
      },
      artifacts: {
        plan,
        screenContract: screenContractArtifact,
        serviceInventory: serviceInventoryArtifact,
        navigationContract: navigationContractArtifact,
        designDecision: designDecisionArtifact,
        target,
        references: referenceRecords,
      },
    };
    packet.contextSha256 = sha256(stableJson(packetPayload(packet)));
    packet.generatedAt = new Date().toISOString();
    const relativePath = `.tmp/builder-context/${screen.id}.json`;
    writeJsonAtomic(path.join(projectRoot, relativePath), packet);
    packets.push({ screenId: screen.id, path: relativePath, contextSha256: packet.contextSha256 });
  }

  const index = {
    schemaVersion: 1,
    approvedPlanSha256: screenContract.approvedPlanSha256,
    packets,
    packetsSha256: sha256(stableJson(packets)),
    generatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(outputRoot, 'index.json'), index);
  console.log(`builder-context: generated ${packets.length} packets`);
}

function check(projectRoot, packetArg) {
  if (!packetArg) fail('check requires a packet path');
  const packetPath = path.resolve(projectRoot, packetArg);
  const contextRoot = path.join(projectRoot, '.tmp', 'builder-context');
  if (!packetPath.startsWith(`${contextRoot}${path.sep}`)) fail('packet must be under .tmp/builder-context');
  const packet = readJson(packetPath, 'builder context packet');
  if (packet.schemaVersion !== 1) fail('packet schemaVersion must be 1');
  if (packet.contextSha256 !== sha256(stableJson(packetPayload(packet)))) {
    fail('packet context hash mismatch');
  }
  for (const [label, record] of Object.entries(packet.artifacts || {})) {
    if (label === 'references') {
      for (const reference of record || []) {
        const filePath = path.join(PLUGIN_ROOT, reference.path);
        if (!fs.existsSync(filePath) || hashFile(filePath) !== reference.sha256) {
          fail(`packet reference hash mismatch: ${reference.path}`);
        }
      }
      continue;
    }
    checkArtifact(projectRoot, record, label);
  }
  console.log(`builder-context: valid (${packet.screen.id})`);
}

function main() {
  const projectArg = process.argv[2];
  const action = process.argv[3];
  if (!projectArg || !['build', 'check'].includes(action)) {
    fail('usage: node build-builder-context.js <project-dir> <build|check> [packet-path]');
  }
  const projectRoot = path.resolve(projectArg);
  if (action === 'build') build(projectRoot);
  else check(projectRoot, process.argv[4]);
}

main();
