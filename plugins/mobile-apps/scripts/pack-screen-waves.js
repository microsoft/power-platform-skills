#!/usr/bin/env node
'use strict';

/**
 * Packs build screens into complexity-balanced waves with a hard concurrency
 * cap of five. Uses longest-processing-time scheduling across a fixed number of
 * waves so one heavy screen does not become the final straggler.
 *
 * Usage: node pack-screen-waves.js <project-dir> [--max-concurrency 5]
 */

const path = require('node:path');
const {
  hashFile,
  readJson,
  sha256,
  stableJson,
  writeJsonAtomic,
} = require('./lib/workflow-artifacts');

const ARCHETYPE_WEIGHT = {
  auth: 2,
  list: 5,
  detail: 6,
  form: 7,
  dashboard: 8,
  scanner: 9,
  map: 9,
  custom: 7,
};

function fail(message) {
  console.error(`screen-waves: ${message}`);
  process.exit(1);
}

function score(screen) {
  const archetype = String(screen.archetype || 'custom').toLowerCase();
  const base = ARCHETYPE_WEIGHT[archetype] || ARCHETYPE_WEIGHT.custom;
  const serviceCost = (screen.services || []).length * 2;
  const nativeCost = (screen.nativeCapabilities || []).length * 3;
  const routeCost = (String(screen.route || '').match(/\[[^\]]+\]/g) || []).length * 2;
  const statementCost = Math.min(6, Math.ceil(((screen.scaffold?.statements || []).length) / 3));
  const presentationCost = ['modal', 'formSheet'].includes(screen.presentation) ? 1 : 0;
  return base + serviceCost + nativeCost + routeCost + statementCost + presentationCost;
}

function main() {
  const projectArg = process.argv[2];
  if (!projectArg) fail('usage: node pack-screen-waves.js <project-dir> [--max-concurrency 5]');
  const maxIndex = process.argv.indexOf('--max-concurrency');
  const maxConcurrency = maxIndex >= 0 ? Number(process.argv[maxIndex + 1]) : 5;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 5) {
    fail('max concurrency must be an integer from 1 to 5');
  }
  const projectRoot = path.resolve(projectArg);
  const contractPath = path.join(projectRoot, '.tmp', 'screen-contract.json');
  const contract = readJson(contractPath, '.tmp/screen-contract.json');
  const screens = (contract.screens || [])
    .filter((screen) => screen.source !== 'keep')
    .map((screen) => ({
      id: screen.id,
      name: screen.name,
      file: screen.file,
      score: score(screen),
    }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const waveCount = Math.max(1, Math.ceil(screens.length / maxConcurrency));
  const waves = Array.from({ length: waveCount }, (_, index) => ({
    index: index + 1,
    totalScore: 0,
    screens: [],
  }));

  for (const screen of screens) {
    const candidates = waves
      .filter((wave) => wave.screens.length < maxConcurrency)
      .sort((left, right) => left.totalScore - right.totalScore || left.index - right.index);
    const target = candidates[0];
    target.screens.push(screen);
    target.totalScore += screen.score;
  }
  for (const wave of waves) wave.screens.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));

  const output = {
    schemaVersion: 1,
    screenContractSha256: hashFile(contractPath),
    maxConcurrency,
    algorithm: 'longest-processing-time-balanced',
    waves,
    wavesSha256: sha256(stableJson(waves)),
    generatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(projectRoot, '.tmp', 'screen-waves.json'), output);
  console.log(`screen-waves: packed ${screens.length} screens into ${waves.length} waves`);
}

main();
