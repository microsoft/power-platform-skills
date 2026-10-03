#!/usr/bin/env node
'use strict';
// Record or check the base marker an upload compares against (#673).
//
//   node scripts/genpage-base.js record --app-id <id> --page-id <id> --file <page.tsx>
//        [--deployed-sha256 <hash>]
//   node scripts/genpage-base.js check --env <url> --app-id <id> --page-id <id> --file <local.tsx>
//
// `record` without `--deployed-sha256` is the post-download case: the file IS the deployed page,
// so both hashes are the file's. `--deployed-sha256` binds a chosen local file to the hash `check`
// observed, which is not the local file's hash when the user picked a different base.
//
// `check` downloads the deployed page into a temp directory, compares, and — only when the
// normalized texts differ — writes `<basename>.deployed.tsx` next to the local file for review.
// The temp directory is removed before the result is emitted: the real emitter calls
// `process.exit`, so a cleanup after `emit` would never run.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs, validateFlags, emitResult } = require('./lib/dataverse-auth.js');
const { makeGenpageCli } = require('./lib/genpage-cli.js');
const { writeFileSafe } = require('./lib/safe-fs.js');
const {
  pageHash,
  readMarker,
  writeMarker,
  compareWithMarker,
  lineDelta,
  deployedCopyPath,
  findDownloadedPageDir,
  readPlainText,
  markerPath,
} = require('./lib/genpage-base.js');

const USAGE = 'Usage: node scripts/genpage-base.js record --app-id <id> --page-id <id> --file <page.tsx> [--deployed-sha256 <hash>]\n'
  + '       node scripts/genpage-base.js check --env <url> --app-id <id> --page-id <id> --file <local.tsx>';

const RECORD_FLAGS = ['app-id', 'page-id', 'file', 'deployed-sha256'];
const CHECK_FLAGS = ['env', 'app-id', 'page-id', 'file'];
const SHA256_RE = /^[0-9a-fA-F]{64}$/;

function required(flags, names, emit) {
  for (const name of names) {
    if (typeof flags[name] !== 'string' || !flags[name].trim()) {
      return emit(false, { error: `--${name} is required\n${USAGE}` });
    }
  }
  return null;
}

function record(flags, emit) {
  const missing = required(flags, ['app-id', 'page-id', 'file'], emit);
  if (missing) return missing;
  let text;
  try {
    text = readPlainText(path.resolve(flags.file));
  } catch (e) {
    return emit(false, { error: e.message });
  }
  const localSha256 = pageHash(text);
  let deployedSha256 = localSha256;
  if (typeof flags['deployed-sha256'] === 'string') {
    if (!SHA256_RE.test(flags['deployed-sha256'])) {
      return emit(false, { error: '--deployed-sha256 must be a sha256 hex hash from genpage-base.js check' });
    }
    deployedSha256 = flags['deployed-sha256'].toLowerCase();
  }
  try {
    const body = writeMarker(flags.file, {
      version: 1,
      pageId: flags['page-id'],
      appId: flags['app-id'],
      deployedSha256,
      localSha256,
      source: 'download',
    });
    return emit(true, {
      ok: true,
      marker: markerPath(flags.file),
      pageId: body.pageId,
      appId: body.appId,
      deployedSha256: body.deployedSha256,
      localSha256: body.localSha256,
      source: body.source,
      recordedAt: body.recordedAt,
    });
  } catch (e) {
    return emit(false, { error: e.message });
  }
}

async function check(flags, emit, deps) {
  const missing = required(flags, ['env', 'app-id', 'page-id', 'file'], emit);
  if (missing) return missing;
  let localText;
  try {
    localText = readPlainText(path.resolve(flags.file));
  } catch (e) {
    return emit(false, { error: e.message });
  }
  const cliFactory = deps.makeGenpageCli || makeGenpageCli;
  const mkdtemp = deps.mkdtempSync || fs.mkdtempSync;
  const rm = deps.rmSync || fs.rmSync;
  const probe = mkdtemp(path.join(os.tmpdir(), 'genpage-base-'));
  let deployedText = null;
  let downloadError = null;
  try {
    const cli = cliFactory(flags.env);
    if (!cli || typeof cli.download !== 'function') {
      throw new Error('this pac wrapper exposes no page download');
    }
    await cli.download({ appId: flags['app-id'], outputDir: probe, pageIds: [flags['page-id']] });
    const pageDir = findDownloadedPageDir(probe, flags['page-id']);
    if (!pageDir) throw new Error('pac wrote no directory for this page');
    deployedText = fs.readFileSync(path.join(pageDir, 'page.tsx'), 'utf8');
  } catch (e) {
    downloadError = (e && e.message) || String(e);
  } finally {
    // Before any emit. emitResult calls process.exit, so a cleanup placed after it never runs
    // and the downloaded page source stays on disk.
    try { rm(probe, { recursive: true, force: true }); } catch { /* leave the temp dir */ }
  }

  const comparison = compareWithMarker(readMarker(flags.file), {
    pageId: flags['page-id'],
    appId: flags['app-id'],
    deployedText,
    localText,
  });
  const localSha256 = pageHash(localText);
  const deployedSha256 = deployedText == null ? null : pageHash(deployedText);
  const lines = deployedText == null ? null : lineDelta(localText, deployedText);
  const contentSame = deployedSha256 != null && deployedSha256 === localSha256;
  let deployedCopy;
  let copyError;
  if (deployedText != null && !contentSame) {
    try {
      // Raw bytes, not the normalized form: the copy is what pac wrote, for the user to diff.
      deployedCopy = writeFileSafe(deployedCopyPath(flags.file), deployedText, { encoding: 'utf8' });
    } catch (e) {
      copyError = e.message;
    }
  }
  const payload = {
    ...comparison,
    deployedSha256,
    localSha256,
    contentSame,
    ...(lines ? { lines } : {}),
    ...(deployedCopy ? { deployedCopy } : {}),
    ...(copyError ? { copyError } : {}),
  };
  if (downloadError) {
    return emit(false, {
      ok: false,
      code: 'deployed-unreadable',
      error: `cannot read the deployed page ${flags['page-id']} (${downloadError})`,
      ...payload,
    });
  }
  return emit(true, { ok: true, ...payload });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const emit = deps.emit || emitResult;
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];
  if (command !== 'record' && command !== 'check') {
    return emit(false, { error: `expected 'record' or 'check'\n${USAGE}` });
  }
  if (positional.length > 1) {
    return emit(false, { error: `unexpected argument '${positional[1]}'\n${USAGE}` });
  }
  const known = command === 'record' ? RECORD_FLAGS : CHECK_FLAGS;
  const flagError = validateFlags(argv, { known, needValue: known });
  if (flagError) return emit(false, { error: `${flagError}\n${USAGE}` });
  if (command === 'record') return record(flags, emit);
  return check(flags, emit, deps);
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`${e && e.message ? e.message : e}\n`);
    process.exit(1);
  });
}

module.exports = { main };
