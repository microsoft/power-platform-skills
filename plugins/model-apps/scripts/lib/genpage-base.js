'use strict';
// Base marker for /genpage divergence detection (#673).
//
// A page kept in source control and a page edited in the maker portal otherwise last-save-wins:
// an upload replaces whatever is deployed, and nothing in the upload says whether that was still
// the copy this file was generated or downloaded from.
//
// The marker is a sibling dotfile of the code file, `<dir>/.<basename>.genpage-base.json`. It
// stores hashes and ids only — never an environment URL — so a user may commit it with the page.
// `appId` is optional: a page created before any app held it (an upload with no --app-id) is recorded
// with the page alone, and the first update that names the app the page was then placed in — which
// proves its own membership first — goes ahead on that marker and records the app (compareWithMarker).
//
// `unfinished` is optional too: an upload that CREATED the page records what is left of it — `publish` (the page was written and its publish failed) or `place` (it was
// asked to place the page in an app, and that, with the publish, is not done) — until it is done. It says "this tool created this page, and its creation is not complete",
// which is what lets exactly that page be completed by an upload that names it (`--page-id`), without the proof an ordinary update makes of the page's place in the app's
// navigation: an unfinished page is not in the navigation yet, so that proof could never be made. It proves nothing else, and no other page. It is cleared when the page is
// finished, so that the proof of the page's place in an app is made again for every update after it.
const UNFINISHED = new Set(['publish', 'place']);
//
// A page an earlier release deployed through pac carries a UTF-8 BOM and a final CRLF that pac's
// download wrote (measured); the SDK stores a page's text exactly. A page uploaded as LF with no BOM
// must hash equal to either, or every edit-flow update would look diverged. Trailing whitespace-only
// lines are not content: that final CRLF is one of them. Whitespace inside a line, and blank lines
// between content, stay — those are the page.

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
  // Absent, or null, is a page recorded before any app held it; a value must be a usable id.
  const hasApp = parsed.appId !== undefined && parsed.appId !== null;
  if (hasApp && (typeof parsed.appId !== 'string' || !parsed.appId.trim())) return null;
  const deployedSha256 = String(parsed.deployedSha256 || '').toLowerCase();
  const localSha256 = String(parsed.localSha256 || '').toLowerCase();
  if (!SHA256_RE.test(deployedSha256) || !SHA256_RE.test(localSha256)) return null;
  if (!SOURCES.has(parsed.source)) return null;
  return {
    version: 1,
    pageId: parsed.pageId.toLowerCase(),
    ...(hasApp ? { appId: parsed.appId.toLowerCase() } : {}),
    deployedSha256,
    localSha256,
    recordedAt: parsed.recordedAt,
    source: parsed.source,
    // Only a state this module writes is one, so a hand-edited value can never be read as one.
    ...(UNFINISHED.has(parsed.unfinished) ? { unfinished: parsed.unfinished } : {}),
  };
}

function writeMarker(codeFile, marker) {
  const pageId = String(marker && marker.pageId || '').trim().toLowerCase();
  const appId = String(marker && marker.appId || '').trim().toLowerCase();
  const deployedSha256 = String(marker && marker.deployedSha256 || '').toLowerCase();
  const localSha256 = String(marker && marker.localSha256 || '').toLowerCase();
  const source = marker && marker.source;
  if (!pageId) {
    throw new Error('writeMarker: pageId is required');
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
    // No key at all for a page no app held yet, rather than an empty one a reader would have to tell from a bad value.
    ...(appId ? { appId } : {}),
    deployedSha256,
    localSha256,
    recordedAt: (marker && marker.recordedAt) || new Date().toISOString(),
    source,
    // Absent unless set: a finished page's marker is the one it always was.
    ...(marker && UNFINISHED.has(marker.unfinished) ? { unfinished: marker.unfinished } : {}),
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
  // A marker recorded with an app is for that page in that app. One recorded with none — the page was created before any app held it —
  // is for the page alone: the update that names an app proves the page is in that app's navigation before it asks about the marker, so
  // the app adds nothing to what the marker has to match, and the update then records it (genpage-upload.js).
  const samePage = marker.pageId === String(pageId || '').toLowerCase()
    && (marker.appId === undefined || marker.appId === String(appId || '').toLowerCase());
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
// as one added or removed, not as a full rewrite. Normalized the same way as the hash, so the
// BOM and final CRLF a page an earlier release deployed carries do not inflate a summary of a real
// content change.
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
  readPlainText,
};
