'use strict';
// Base marker for /genpage divergence detection (#673).
//
// A page kept in source control and a page edited in the maker portal otherwise last-save-wins:
// an upload replaces whatever is deployed, and nothing in the upload says whether that was still
// the copy this file was generated or downloaded from.
//
// The marker is a sibling dotfile of the code file, `<dir>/.<basename>.genpage-base.json`. It
// stores hashes and ids only — never an environment URL — so a user may commit it with the page.
//
// pac model genpage download writes page.tsx UTF-8 with a leading BOM and a final CRLF (measured).
// A page uploaded as LF with no BOM must hash equal to that download, or every edit-flow update
// would look diverged. Trailing whitespace-only lines are not content: pac's final CRLF is one of
// them. Whitespace inside a line, and blank lines between content, stay — those are the page.

const fs = require('node:fs');
const path = require('node:path');
const { sha256 } = require('./hash.js');
const { writeFileSafe, removeFileSafe } = require('./safe-fs.js');

const SOURCES = new Set(['download', 'upload', 'upload-unverified']);
const SHA256_RE = /^[0-9a-f]{64}$/;

function normalizePageText(text) {
  let s = String(text == null ? '' : text);
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = s.split('\n');
  while (lines.length && /^\s*$/.test(lines[lines.length - 1])) lines.pop();
  return lines.join('\n');
}

function pageHash(text) {
  return sha256(normalizePageText(text));
}

function markerPath(codeFile) {
  return path.join(path.dirname(codeFile), `.${path.basename(codeFile)}.genpage-base.json`);
}

function deployedCopyPath(codeFile) {
  return path.join(path.dirname(codeFile), `${path.basename(codeFile)}.deployed.tsx`);
}

// A marker that is not a regular file with one name is absent, not a base. A symlink would be
// read from outside the folder; a hard link shares its bytes with another name, so it is not a
// file this tool recorded. Missing, unreadable, and the wrong shape are the same answer: no base.
function readMarker(codeFile) {
  const p = markerPath(codeFile);
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return null;
  }
  if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1) return null;
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.version !== 1) return null;
  if (typeof parsed.pageId !== 'string' || !parsed.pageId.trim()) return null;
  if (typeof parsed.appId !== 'string' || !parsed.appId.trim()) return null;
  const deployedSha256 = String(parsed.deployedSha256 || '').toLowerCase();
  const localSha256 = String(parsed.localSha256 || '').toLowerCase();
  if (!SHA256_RE.test(deployedSha256) || !SHA256_RE.test(localSha256)) return null;
  if (!SOURCES.has(parsed.source)) return null;
  return {
    version: 1,
    pageId: parsed.pageId.toLowerCase(),
    appId: parsed.appId.toLowerCase(),
    deployedSha256,
    localSha256,
    recordedAt: parsed.recordedAt,
    source: parsed.source,
  };
}

function writeMarker(codeFile, marker) {
  const pageId = String(marker && marker.pageId || '').trim().toLowerCase();
  const appId = String(marker && marker.appId || '').trim().toLowerCase();
  const deployedSha256 = String(marker && marker.deployedSha256 || '').toLowerCase();
  const localSha256 = String(marker && marker.localSha256 || '').toLowerCase();
  const source = marker && marker.source;
  if (!pageId || !appId) {
    throw new Error('writeMarker: pageId and appId are required');
  }
  if (!SHA256_RE.test(deployedSha256) || !SHA256_RE.test(localSha256)) {
    throw new Error('writeMarker: deployedSha256 and localSha256 must be sha256 hex');
  }
  if (!SOURCES.has(source)) {
    throw new Error('writeMarker: source must be download, upload, or upload-unverified');
  }
  const body = {
    version: 1,
    pageId,
    appId,
    deployedSha256,
    localSha256,
    recordedAt: (marker && marker.recordedAt) || new Date().toISOString(),
    source,
  };
  // writeFileSafe refuses a link, a junction, a hard link, and a non-file at the marker name,
  // and replaces the directory entry rather than following one planted after the check.
  writeFileSafe(markerPath(codeFile), `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8' });
  return body;
}

function deleteMarker(codeFile) {
  removeFileSafe(markerPath(codeFile));
}

function compareWithMarker(marker, { pageId, appId, deployedText, localText } = {}) {
  if (!marker) return { marker: 'absent', deployed: 'unknown', local: 'no-base' };
  const samePage = marker.pageId === String(pageId || '').toLowerCase()
    && marker.appId === String(appId || '').toLowerCase();
  if (!samePage) return { marker: 'other-page', deployed: 'unknown', local: 'no-base' };
  const deployed = deployedText == null
    ? 'unknown'
    : (pageHash(deployedText) === marker.deployedSha256 ? 'unchanged' : 'changed');
  const local = localText == null
    ? 'no-base'
    : (pageHash(localText) === marker.localSha256 ? 'unchanged' : 'changed');
  return { marker: 'present', deployed, local };
}

// LCS-free multiset delta: a line that appears twice on one side and once on the other counts
// as one added or removed, not as a full rewrite. Normalized the same way as the hash, so pac's
// BOM and final CRLF do not inflate a summary of a real content change.
function lineDelta(a, b) {
  const count = (text) => {
    const normalized = normalizePageText(text);
    const lines = normalized === '' ? [] : normalized.split('\n');
    const map = new Map();
    for (const line of lines) map.set(line, (map.get(line) || 0) + 1);
    return map;
  };
  const left = count(a);
  const right = count(b);
  let added = 0;
  let removed = 0;
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const na = left.get(key) || 0;
    const nb = right.get(key) || 0;
    if (nb > na) added += nb - na;
    if (na > nb) removed += na - nb;
  }
  return { added, removed };
}

// pac names the downloaded directory with its own casing of the page id, which need not match
// the casing the caller typed. Joining the caller's spelling works on a case-insensitive
// filesystem and fails on Linux.
function findDownloadedPageDir(dir, pageId) {
  const want = String(pageId || '').toLowerCase();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const entry = names.find((d) => String(d).toLowerCase() === want);
  return entry ? path.join(dir, entry) : null;
}

// Read a code file only when it is a regular file with one name. Hashing through a symlink would
// record bytes from outside the folder the caller named.
function readPlainText(filePath) {
  let st;
  try {
    st = fs.lstatSync(filePath);
  } catch (e) {
    const err = new Error(`could not read ${filePath}: ${(e && e.message) || e}`);
    err.code = e && e.code;
    throw err;
  }
  if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1) {
    const err = new Error(`${filePath} is not a plain file`);
    err.code = 'UNSAFE_OUTPUT';
    throw err;
  }
  return fs.readFileSync(filePath, 'utf8');
}

module.exports = {
  normalizePageText,
  pageHash,
  markerPath,
  deployedCopyPath,
  readMarker,
  writeMarker,
  deleteMarker,
  compareWithMarker,
  lineDelta,
  findDownloadedPageDir,
  readPlainText,
};
