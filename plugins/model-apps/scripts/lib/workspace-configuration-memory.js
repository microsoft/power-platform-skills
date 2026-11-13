'use strict';
// The SDK workspace never holds sensitive configuration at rest (#846, #847).
//
// The SDK keeps a local copy of every artifact it creates, pushes or fetches: the artifact itself and a metadata file holding
// the snapshot it last synced, under keys like
//   ['environment-variables', '<id>.json']                          the artifact
//   ['.metadata', 'environment-variables', '<id>.meta.json']        { etag, snapshot: <the artifact as fetched>, … }
//   ['connection-references', '<id>.json']                          the artifact
//   ['.metadata', 'connection-references', '<id>.meta.json']        likewise
// For an environment variable that copy is its definition AND its value: `defaultValue`, `schema`, `currentValue.value`
// (for a secret variable, the Key Vault secret reference the build sends); for a connection reference it is `connectionId`.
// A file-backed storage wrote all of it to disk: into the build's throwaway configuration workspace while it lived (and for
// good if the process died before its cleanup), and into the app folder's `.maker-workspace` whenever `build --verify` read
// the items back. The SDK needs the copy within the run (a create writes it and then pushes it; a fetch writes the server's
// copy and the caller reads it back), so the copy is not withheld from the SDK — it is kept in memory instead.
//
// What this wrapper changes, and only for the keys of those two kinds (the artifact folder and its `.metadata` folder):
//   - writeTextAtomic stores the text in this wrapper's memory, never in the storage;
//   - readText / exists answer from that memory only;
//   - deleteFile / deleteByPrefix drop the memory entries too, and still reach the storage, exactly as the SDK asked (the SDK
//     deletes only its own artifact's exact keys, or a prefix it chose — as it did before this wrapper existed).
// Every other key (the manifest, the other kinds, entity metadata) is the storage's own, exactly as before. The manifest
// keeps one entry per artifact ({ type, id, name, entityLogicalName, isDirty }), which holds no value; an entry whose files
// are not read reads as an artifact with no local copy and no baseline — the SDK's diff answers no change for it — which is
// what a fresh run of the build used to find in its throwaway workspace anyway.
//
// Copies an earlier plugin version left on disk. This wrapper never deletes one on its own, and never hides one that may hold
// work: before the FIRST access (read, exists, write or delete) to an artifact's two keys, it reads that artifact's copy and
// metadata from the storage and lets the SDK go on without them only when they prove the copy is what the server last held —
// both files present, both JSON, and the copy structurally equal to the metadata's `snapshot`, which is the SDK's own test
// (VersionManager.isDirty: `!deepEqual(meta.snapshot, artifact)`; a copy with no metadata is a creation never sent). Anything
// else — a copy that differs from its snapshot, a copy with no snapshot, a snapshot with no copy (which the SDK's diff
// reports as a removal), a file that is not JSON, or a file that cannot be read at all (locked, denied) — is refused with
// LEGACY_COPY_CODE and a message that names the files and what to do, and quotes none of their content. The SDK used to
// report such a copy as an unsent change; hiding it would have made it read as clean. A refusal is not remembered: the next
// access checks again, so once the obstruction is gone (the file unlocked, or removed by the maker) the run goes on. Only a
// proven-clean (or absent) pair is remembered, for this wrapper.
// A clean copy left on disk is not read, so it changes no decision (an unchanged rebuild makes the same requests as before),
// but it still holds what it held: legacyCopyFolders names the folders holding such files, and lib/maker-sdk.js warns once per
// workspace folder per process so the maker can remove them (skills/app-builder/SKILL.md says how).
//
// The memory belongs to this one wrapper (one SDK instance): a second SDK over the same folder, or the next process, starts
// with none, as a new run of the build always did for its throwaway configuration workspace.

const fs = require('node:fs');

// The SDK's folder of each sensitive kind (vendor/cds-maker-sdk.cjs, WorkspaceManager's kind → folder map).
const SENSITIVE_FOLDERS = Object.freeze(['environment-variables', 'connection-references']);
const METADATA_FOLDER = '.metadata';
const LEGACY_COPY_CODE = 'WORKSPACE_LEGACY_CONFIGURATION_COPY';
const KIND_NAME = { 'environment-variables': 'environment variable', 'connection-references': 'connection reference' };
// The SDK's own deepEqual bound (vendor/cds-maker-sdk.cjs, `deepEqual exceeded the maximum supported depth of 512`).
const MAX_DEPTH = 512;

const sensitive = (key) => Array.isArray(key)
  && (SENSITIVE_FOLDERS.includes(key[0]) || (key[0] === METADATA_FOLDER && SENSITIVE_FOLDERS.includes(key[1])));
const memoryKey = (key) => key.join('/');
const underPrefix = (stored, prefix) => {
  const parts = stored.split('/');
  return prefix.length <= parts.length && prefix.every((part, i) => parts[i] === part);
};

// The artifact a sensitive key belongs to, as the SDK names its two files (WorkspaceManager artifactKey / metaKey):
//   ['environment-variables', '<id>.json']  and  ['.metadata', 'environment-variables', '<id>.meta.json']
// Any other sensitive key (a folder prefix) belongs to no single artifact.
function artifactOf(key) {
  if (key.length === 2 && SENSITIVE_FOLDERS.includes(key[0]) && /\.json$/i.test(key[1]) && !/\.meta\.json$/i.test(key[1])) {
    return { folder: key[0], id: key[1].slice(0, -'.json'.length) };
  }
  if (key.length === 3 && key[0] === METADATA_FOLDER && SENSITIVE_FOLDERS.includes(key[1]) && /\.meta\.json$/i.test(key[2])) {
    return { folder: key[1], id: key[2].slice(0, -'.meta.json'.length) };
  }
  return null;
}

// The SDK's structural equality of two parsed JSON documents (vendor/cds-maker-sdk.cjs `deepEqual`): same keys and equal
// values for objects, same length and equal items for arrays, `===` otherwise.
function sameJson(a, b, depth = 0) {
  if (a === b) return true;
  if (depth > MAX_DEPTH) throw new RangeError('too deep');
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameJson(a[k], b[k], depth + 1));
}

// Why the pair on disk is not provably what the server last held, or null when it is (or when neither file exists).
function unprovenReason(copyText, metaText) {
  if (copyText === null && metaText === null) return null;
  if (copyText === null) return 'its last-synced snapshot is there with no copy beside it (the SDK reports that as a local removal)';
  if (metaText === null) return 'the copy has no last-synced snapshot beside it (the SDK reports that as a creation never sent)';
  let copy;
  let meta;
  try {
    copy = JSON.parse(copyText);
    meta = JSON.parse(metaText);
  } catch {
    return 'one of its files is not valid JSON';
  }
  if (meta === null || typeof meta !== 'object' || !Object.prototype.hasOwnProperty.call(meta, 'snapshot')) return 'its metadata file holds no last-synced snapshot';
  try {
    return sameJson(meta.snapshot, copy) ? null : 'the copy differs from its last-synced snapshot (an edit that may never have been sent)';
  } catch {
    return 'the copy is too deeply nested to compare with its last-synced snapshot';
  }
}

/**
 * `storage` (an SDK WorkspaceStorage) with the sensitive configuration kinds kept in memory. Like output-redaction.js
 * guardWorkspaceStorage, every other member runs ON the storage (a storage may keep `#private` state) and the wrapper is a
 * Proxy over an empty child of it, so `pathFor`, `getRoot` and `instanceof` still hold. `prototype` names that parent
 * when `storage` is itself a wrapper (maker-sdk.js passes the caller's own storage under the token guard), so the
 * caller's storage stays the direct prototype of what the SDK is given. `refuse(code, message)` makes the error a legacy
 * copy is refused with (maker-sdk.js passes the SDK's SdkError, which the bundle rethrows as it is).
 * @template T
 * @param {T} storage
 * @param {{ prototype?: object, refuse?: (code: string, message: string) => Error }} [options]
 * @returns {T}
 */
function keepSensitiveConfigurationInMemory(storage, { prototype = storage, refuse = defaultRefuse } = {}) {
  if (storage === null || typeof storage !== 'object' || typeof storage.readText !== 'function' || typeof storage.writeTextAtomic !== 'function') return storage;
  const memory = new Map();
  const proven = new Set();
  const where = (key) => {
    try { return typeof storage.pathFor === 'function' ? storage.pathFor(key) : key.join('/'); } catch { return key.join('/'); }
  };
  // Before the first access to one artifact's keys: what an earlier version left at them is either proven clean (and from
  // then on not read) or refused. See the header.
  const checkLegacy = async (key) => {
    const at = artifactOf(key);
    if (!at) return;
    const name = `${at.folder}/${at.id}`;
    if (proven.has(name)) return;
    const copyKey = [at.folder, `${at.id}.json`];
    const metaKey = [METADATA_FOLDER, at.folder, `${at.id}.meta.json`];
    const files = `${where(copyKey)} and ${where(metaKey)}`;
    let reason;
    try {
      reason = unprovenReason(await storage.readText(copyKey), await storage.readText(metaKey));
    } catch (err) {
      reason = `its files could not be read (${(err && err.code) || 'unreadable'}: locked by another program, or access denied)`;
    }
    if (reason === null) {
      proven.add(name);
      return;
    }
    const kind = KIND_NAME[at.folder];
    throw refuse(LEGACY_COPY_CODE, `the workspace holds a copy of the ${kind} ${at.id} that an earlier plugin version wrote, and ${reason}: ${files}. `
      + 'This version keeps environment variables and connection references out of the workspace and reads no copy it cannot prove '
      + 'is what the environment last held, so it stops here rather than hide this one; the files were left as they are and nothing in them was sent. '
      + `If the copy holds a change you still want, make it in the App Spec or the deployment settings file (a build sends configuration from those, never from the workspace), or send it with the plugin version that wrote it. `
      + 'If the files are locked, close the program holding them. Then delete those two files (only them) and run again.');
  };
  const own = {
    async readText(key, ...rest) {
      if (!sensitive(key)) return storage.readText(key, ...rest);
      await checkLegacy(key);
      const k = memoryKey(key);
      return memory.has(k) ? memory.get(k) : null;
    },
    async writeTextAtomic(key, text, ...rest) {
      if (!sensitive(key)) return storage.writeTextAtomic(key, text, ...rest);
      await checkLegacy(key);
      memory.set(memoryKey(key), String(text));
      return undefined;
    },
    async deleteFile(key, ...rest) {
      if (!sensitive(key)) return storage.deleteFile(key, ...rest);
      await checkLegacy(key);
      memory.delete(memoryKey(key));
      // The SDK deletes its artifact's exact keys (deleteArtifact); a proven-clean copy an earlier version left there goes
      // with it, as it did before this wrapper. A failure is the storage's own and reaches the SDK unchanged.
      return storage.deleteFile(key, ...rest);
    },
    async deleteByPrefix(prefix, ...rest) {
      if (Array.isArray(prefix)) for (const k of [...memory.keys()]) if (underPrefix(k, prefix)) memory.delete(k);
      return storage.deleteByPrefix(prefix, ...rest);
    },
  };
  // `exists` is optional on a storage; the SDK falls back to readText when it is absent, so it is answered only when present.
  if (typeof storage.exists === 'function') {
    own.exists = async function exists(key, ...rest) {
      if (!sensitive(key)) return storage.exists(key, ...rest);
      await checkLegacy(key);
      return memory.has(memoryKey(key));
    };
  }
  const onStorage = new Map();
  return new Proxy(Object.create(prototype), {
    get(target, key) {
      if (Object.prototype.hasOwnProperty.call(own, key)) return own[key];
      const value = Reflect.get(storage, key, storage);
      if (typeof value !== 'function' || key === 'constructor') return value;
      if (!onStorage.has(value)) onStorage.set(value, function onTheStorage(...args) { return value.apply(storage, args); });
      return onStorage.get(value);
    },
    set(target, key, value) {
      return Reflect.set(storage, key, value, storage);
    },
  });
}

// Is `error` this wrapper's refusal of a copy an earlier version left? A caller that would read any failure of a diff as
// "changed" (lib/unsynced-edits.js fails open) rethrows this one, so the maker sees its own remedy.
const isLegacyCopyRefusal = (error) => Boolean(error) && error.code === LEGACY_COPY_CODE;

function defaultRefuse(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// The sensitive folders of a file-system storage that hold `.json` files (the SDK's artifact and metadata files), as paths
// relative to its root, e.g. ['environment-variables', '.metadata/environment-variables']. Only names are read, never content.
// A storage with no `pathFor` (not file-backed) or a folder that cannot be listed answers nothing.
function legacyCopyFolders(storage) {
  if (!storage || typeof storage.pathFor !== 'function') return [];
  const found = [];
  for (const folder of SENSITIVE_FOLDERS) {
    for (const key of [[folder], [METADATA_FOLDER, folder]]) {
      try {
        const entries = fs.readdirSync(storage.pathFor(key), { withFileTypes: true });
        if (entries.some((e) => e.isFile() && /\.json$/i.test(e.name))) found.push(key.join('/'));
      } catch { /* absent or unlistable: nothing to name */ }
    }
  }
  return found;
}

// The one warning about legacyCopyFolders, worded without any content of those files.
function legacyCopyWarning(root, folders) {
  return `the workspace ${root} still holds environment-variable or connection-reference copies an earlier plugin version wrote, `
    + `in ${folders.join(', ')}. They may hold values, defaults, Key Vault secret references or connection ids. This version never `
    + 'uses them as configuration, never writes them and does not delete them for you (it reads them only to check that none holds a '
    + 'change you never sent): when no build is running, delete the .json files in those folders '
    + '(a change in one that you never sent goes into the App Spec or the deployment settings file first). '
    + 'See "Sensitive configuration in the workspace" in the app-builder skill.';
}

module.exports = { keepSensitiveConfigurationInMemory, legacyCopyFolders, legacyCopyWarning, isLegacyCopyRefusal, SENSITIVE_FOLDERS, LEGACY_COPY_CODE };
