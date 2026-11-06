'use strict';

// The site's large binary files, the explainer video and its poster, are not committed on main.
// Marketplace installs clone main: every byte there is downloaded by everyone who adds the
// marketplace, and every new version of a file is downloaded again on each update. Claude Code
// and GitHub Copilot CLI both clone only the default branch (shallow, single-branch), so these
// files live on the site-media branch instead, which no assistant ever fetches.
//
// site/media.json on main pins each file by SHA-256, so a build can only publish the exact bytes
// main was reviewed with. The branch keeps every version under a content-hashed name, so a new
// render can be pushed there before the pull request that switches main to it, and main keeps
// deploying the old one until then.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MEDIA_BRANCH = 'site-media';
// Paths are lowercase words joined by "/". Every segment starts with a letter or digit, so no
// segment can be "." or "..", and neither a published path nor a branch path can leave its folder.
const SAFE_PATH = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// site/media.json looks like:
//   { "branch": "site-media",
//     "files": [{ "path": "assets/video/plugins-and-skills.mp4",          <- where the site serves it
//                 "source": "video/plugins-and-skills-1a2b3c4d5e6f.mp4",   <- where it is on the branch
//                 "sha256": "<64 hex>", "bytes": 3187458 }] }
function loadMediaManifest(file) {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const fail = (message) => {
    throw new Error(`${file}: ${message}`);
  };
  if (manifest.branch !== MEDIA_BRANCH) fail(`branch must be "${MEDIA_BRANCH}"`);
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail('files must list at least one file');
  const seen = new Set();
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || !SAFE_PATH.test(entry.path) || !entry.path.startsWith('assets/')) {
      fail(`${JSON.stringify(entry.path)} is not a path under assets/`);
    }
    if (typeof entry.source !== 'string' || !SAFE_PATH.test(entry.source)) fail(`${JSON.stringify(entry.source)} is not a safe branch path`);
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) fail(`${entry.path} needs a lowercase hex sha256`);
    if (!Number.isInteger(entry.bytes) || entry.bytes <= 0) fail(`${entry.path} needs its size in bytes`);
    if (seen.has(entry.path)) fail(`${entry.path} is listed twice`);
    seen.add(entry.path);
  }
  return manifest;
}

function checkPinned(entry, data, where) {
  if (data.length !== entry.bytes || sha256(data) !== entry.sha256) {
    throw new Error(`${where} is not the version site/media.json pins for ${entry.path}. Run node site/fetch-media.js to fetch it.`);
  }
}

// Copies each pinned file from a local copy of the branch into the built site.
// A missing file is reported rather than thrown, so a contributor can build and preview the
// rest of the site without the video; the deploy passes --require-media to make it an error.
// A file that is present but different always throws, because publishing it would be wrong.
function copyMedia({ manifest, mediaDir, outDir }) {
  const written = [];
  const missing = [];
  for (const entry of manifest.files) {
    const from = mediaDir ? path.join(mediaDir, entry.source) : null;
    if (!from || !fs.existsSync(from)) {
      missing.push(entry.source);
      continue;
    }
    const data = fs.readFileSync(from);
    checkPinned(entry, data, from);
    const to = path.join(outDir, entry.path);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, data);
    written.push(entry.path);
  }
  return { written, missing };
}

function git(args, cwd) {
  try {
    // Buffers, not strings: cat-file returns the binary files themselves.
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024 });
  } catch (error) {
    const detail = error.stderr ? error.stderr.toString().trim() : error.message;
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
}

// Turns --from into something a fresh repository can fetch from: a URL as is, a remote name of
// the repository in cwd as its URL, and a folder as the path of its Git directory. git fetch
// accepts a remote name only in the repository that defines it, and a folder only at the top of
// a repository, not a subfolder. A relative folder is relative to pathBase, the directory the
// command was run from, as a user expects; remote names still belong to the site's repository.
function resolveSource(from, cwd, pathBase = cwd) {
  // "https://host/owner/repo.git", "ssh://...", or scp-like "git@host:owner/repo.git".
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(from) || /^[^/\\:]+@[^/\\:]+:/.test(from)) return from;
  try {
    return git(['remote', 'get-url', from], cwd).toString().trim();
  } catch {
    // Not a remote name; try it as a folder.
  }
  const folder = path.resolve(pathBase, from);
  if (fs.existsSync(folder)) {
    try {
      return path.resolve(folder, git(['rev-parse', '--git-common-dir'], folder).toString().trim());
    } catch {
      // Not in a repository; fall through to the error.
    }
  }
  throw new Error(`--from ${from} is not a URL, a Git remote, or a folder in a Git repository.`);
}

// Fetches the pinned files from the site-media branch into mediaDir, keeping their branch paths.
// Files already present with the right hash are left alone, and if every file is, nothing is
// fetched at all.
//
// The fetch runs in a private, temporary bare repository, never in the contributor's own clone.
// A --depth fetch records the fetched commit in the repository's shared "shallow" file, which
// would turn a full clone (and every worktree of it) into a shallow one, and would also drop
// local history of site-media. A throwaway repository keeps all of that out of their clone.
function fetchMedia({ manifest, mediaDir, from, cwd, pathBase = cwd }) {
  const needed = manifest.files.filter((entry) => {
    const file = path.join(mediaDir, entry.source);
    if (!fs.existsSync(file)) return true;
    const data = fs.readFileSync(file);
    return data.length !== entry.bytes || sha256(data) !== entry.sha256;
  });
  if (needed.length === 0) return { fetched: [] };

  const source = resolveSource(from, cwd, pathBase);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pps-site-media-'));
  try {
    const repo = (args) => git([`--git-dir=${scratch}`, ...args]);
    git(['init', '--quiet', '--bare', scratch]);
    try {
      // Only the tip of the branch, into FETCH_HEAD: no refs, tags, or older versions.
      repo(['fetch', '--quiet', '--depth', '1', '--no-tags', source, `refs/heads/${manifest.branch}`]);
    } catch (error) {
      // git reports a branch that does not exist as: "fatal: couldn't find remote ref refs/heads/site-media"
      const hint = /couldn't find remote ref/.test(error.message) ? ` The ${manifest.branch} branch is not on ${from}; push it first, or pass --from.` : '';
      throw new Error(`${error.message}${hint}`);
    }
    const commit = repo(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']).toString().trim();
    for (const entry of needed) {
      let data;
      try {
        data = repo(['cat-file', 'blob', `${commit}:${entry.source}`]);
      } catch {
        throw new Error(`The ${manifest.branch} branch has no ${entry.source}. Push it there before merging the change to site/media.json.`);
      }
      checkPinned(entry, data, `${manifest.branch}:${entry.source}`);
      const to = path.join(mediaDir, entry.source);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, data);
    }
  } finally {
    // Git marks object files read-only; fs.rmSync clears that on Windows before deleting.
    // A cleanup failure only leaves a temporary folder behind, so it must not fail the fetch.
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {
      // Ignored: see above.
    }
  }
  return { fetched: needed.map((entry) => entry.source) };
}

module.exports = { MEDIA_BRANCH, copyMedia, fetchMedia, loadMediaManifest, sha256 };
