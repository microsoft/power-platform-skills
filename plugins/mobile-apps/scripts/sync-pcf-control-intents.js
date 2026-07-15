#!/usr/bin/env node
'use strict';

/**
 * Synchronize Gate 2b PCF approvals into the global control-intent ledger and
 * its per-screen builder shards. The PCF plan remains the audit/approval source
 * of truth; builders consume only the compact projection in their own shard.
 *
 * Usage:
 *   node scripts/sync-pcf-control-intents.js --dir <migration-package> [--check] [--json]
 */

const fs = require('node:fs');
const path = require('node:path');
const { pathContains } = require('./lib/modernizer-paths.js');
const {
  derivePcfStats,
  projectPcfControlIntents,
} = require('./lib/pcf-control-intent.js');

const MAX_FILE_BYTES = 64 * 1024 * 1024;

function parseArgs(argv) {
  const args = { dir: '', check: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') args.dir = argv[++i] || '';
    else if (argv[i] === '--check') args.check = true;
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      process.stdout.write('Usage: node scripts/sync-pcf-control-intents.js --dir <migration-package> [--check] [--json]\n');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.dir) throw new Error('Missing required --dir <migration-package>');
  return args;
}

function packageDirectory(value) {
  const absolute = path.resolve(value);
  if (!fs.existsSync(absolute)) throw new Error(`migration package does not exist: ${absolute}`);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`migration package must be a real directory: ${absolute}`);
  return fs.realpathSync(absolute);
}

function checkedFile(root, relative, label) {
  const file = path.resolve(root, relative);
  if (!pathContains(root, file)) throw new Error(`${label} escapes the migration package: ${relative}`);
  if (!fs.existsSync(file)) throw new Error(`${label} is missing: ${relative}`);
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file: ${relative}`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`${label} exceeds ${MAX_FILE_BYTES} bytes: ${relative}`);
  return file;
}

function readJsonFile(root, relative, label) {
  const file = checkedFile(root, relative, label);
  try {
    return { file, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function canonicalText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function validBehaviorShardPath(value) {
  if (typeof value !== 'string' || value.includes('\\')) return false;
  if (!value.startsWith('behavior-shards/') || path.posix.normalize(value) !== value) return false;
  const segments = value.split('/');
  return segments.length === 2 && segments[1].endsWith('.json') && segments[1] !== '.json';
}

function collectSynchronizedFiles(root) {
  const inputEntry = readJsonFile(root, 'mobile-plugin-input.json', 'mobile-plugin-input.json');
  const coverageEntry = readJsonFile(root, 'control-intent-coverage.json', 'control-intent-coverage.json');
  const planRelative = inputEntry.value.pcfPlan?.file || 'pcf-plan.json';
  const planEntry = readJsonFile(root, planRelative, 'PCF plan');
  const behaviorRelative = inputEntry.value.behaviorPlan?.file || 'behavior-contract.json';
  const behaviorEntry = readJsonFile(root, behaviorRelative, 'behavior contract');

  planEntry.value.stats = derivePcfStats(planEntry.value);
  const projectedCoverage = projectPcfControlIntents(coverageEntry.value, planEntry.value);
  inputEntry.value.pcfPlan = {
    ...(inputEntry.value.pcfPlan || {}),
    stats: JSON.parse(JSON.stringify(planEntry.value.stats)),
  };
  inputEntry.value.controlIntentCoverage = {
    ...(inputEntry.value.controlIntentCoverage || {}),
    stats: JSON.parse(JSON.stringify(projectedCoverage.stats)),
  };

  const rowsByScreen = new Map();
  for (const row of projectedCoverage.rows || []) {
    if (!rowsByScreen.has(row.screen)) rowsByScreen.set(row.screen, []);
    rowsByScreen.get(row.screen).push(row);
  }

  const outputs = new Map([
    [inputEntry.file, canonicalText(inputEntry.value)],
    [coverageEntry.file, canonicalText(projectedCoverage)],
    [planEntry.file, canonicalText(planEntry.value)],
  ]);
  const knownShardScreens = new Set();
  const knownShardFiles = new Set();
  for (const shardIndex of behaviorEntry.value.shards || []) {
    const relative = shardIndex && shardIndex.file;
    if (!validBehaviorShardPath(relative)) {
      throw new Error(`behavior contract contains an unsafe shard path: ${relative || 'missing'}`);
    }
    if (knownShardFiles.has(relative)) throw new Error(`behavior contract contains duplicate shard file: ${relative}`);
    knownShardFiles.add(relative);
    const shardEntry = readJsonFile(root, relative, `behavior shard ${relative}`);
    const screen = shardEntry.value.screen;
    if (screen !== shardIndex.screen) {
      throw new Error(`behavior shard screen mismatch: index=${shardIndex.screen || 'missing'}, file=${screen || 'missing'}`);
    }
    if (knownShardScreens.has(screen)) throw new Error(`behavior contract contains duplicate shard screen: ${screen}`);
    knownShardScreens.add(screen);
    shardEntry.value.controlIntents = rowsByScreen.get(screen) || [];
    shardEntry.value.stats = {
      ...(shardEntry.value.stats || {}),
      controlIntents: shardEntry.value.controlIntents.length,
    };
    outputs.set(shardEntry.file, canonicalText(shardEntry.value));
  }
  const shardRoot = path.join(root, 'behavior-shards');
  if (!fs.existsSync(shardRoot)
      || fs.lstatSync(shardRoot).isSymbolicLink()
      || !fs.lstatSync(shardRoot).isDirectory()) {
    throw new Error('behavior-shards must be a real directory');
  }
  for (const entry of fs.readdirSync(shardRoot, { withFileTypes: true })) {
    const relative = `behavior-shards/${entry.name}`;
    if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith('.json')) {
      throw new Error(`unexpected behavior shard entry: ${relative}`);
    }
    if (!knownShardFiles.has(relative)) throw new Error(`orphaned behavior shard is not indexed by the contract: ${relative}`);
  }
  for (const screen of rowsByScreen.keys()) {
    if (!knownShardScreens.has(screen)) throw new Error(`control-intent rows have no behavior shard for screen: ${screen}`);
  }

  const changed = [...outputs.entries()].filter(([file, text]) => fs.readFileSync(file, 'utf8') !== text);
  return {
    outputs,
    changed,
    pcfControls: planEntry.value.controls?.length || 0,
    approved: planEntry.value.stats.approved,
    pending: planEntry.value.stats.pendingApproval,
    blocked: planEntry.value.stats.blocked,
    shards: (behaviorEntry.value.shards || []).length,
  };
}

function writeTransaction(changed) {
  if (changed.length === 0) return;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const staged = [];
  const replaced = [];
  try {
    for (const [file, text] of changed) {
      const temp = `${file}.pcf-sync-${token}.tmp`;
      const backup = `${file}.pcf-sync-${token}.bak`;
      fs.writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx' });
      staged.push({ file, temp, backup });
    }
    // Renaming through same-directory backups keeps each replacement atomic on
    // Windows and POSIX. If a later file fails, restore every prior artifact so
    // approval, coverage, and shards can never disagree because of a partial run.
    for (const entry of staged) {
      fs.renameSync(entry.file, entry.backup);
      try {
        fs.renameSync(entry.temp, entry.file);
      } catch (error) {
        fs.renameSync(entry.backup, entry.file);
        throw error;
      }
      replaced.push(entry);
    }
  } catch (error) {
    for (const entry of [...replaced].reverse()) {
      fs.rmSync(entry.file, { force: true });
      if (fs.existsSync(entry.backup)) fs.renameSync(entry.backup, entry.file);
    }
    for (const entry of staged) {
      fs.rmSync(entry.temp, { force: true });
      if (fs.existsSync(entry.backup) && !fs.existsSync(entry.file)) fs.renameSync(entry.backup, entry.file);
      else fs.rmSync(entry.backup, { force: true });
    }
    throw error;
  }
  // The new set is fully committed once every replacement succeeds. Backup
  // cleanup is best-effort: throwing here after an earlier backup was removed
  // would make rollback impossible and could delete a committed file.
  for (const entry of replaced) {
    try { fs.rmSync(entry.backup, { force: true }); } catch (_error) { /* keep harmless backup for manual cleanup */ }
  }
}

function synchronizePcfControlIntentsInDirectory(directory, options = {}) {
  const root = packageDirectory(directory);
  const result = collectSynchronizedFiles(root);
  if (options.write !== false) writeTransaction(result.changed);
  return {
    packageDir: root,
    changedFiles: result.changed.map(([file]) => path.relative(root, file).replace(/\\/g, '/')),
    pcfControls: result.pcfControls,
    approved: result.approved,
    pending: result.pending,
    blocked: result.blocked,
    shards: result.shards,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = synchronizePcfControlIntentsInDirectory(args.dir, { write: !args.check });
  const output = {
    ok: !args.check || result.changedFiles.length === 0,
    mode: args.check ? 'check' : 'write',
    ...result,
  };
  if (args.json || args.check) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else {
    process.stdout.write(`Synchronized ${result.pcfControls} PCF control intent(s) across ${result.shards} shard(s); ${result.changedFiles.length} file(s) changed.\n`);
  }
  if (args.check && result.changedFiles.length > 0) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`PCF control-intent sync failed: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  collectSynchronizedFiles,
  synchronizePcfControlIntentsInDirectory,
  writeTransaction,
};
