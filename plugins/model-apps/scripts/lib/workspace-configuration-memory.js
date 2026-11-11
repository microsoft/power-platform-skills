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
//   - readText / exists answer from that memory only. A file an earlier plugin version left at that key is NOT read: the
//     build never relied on one across runs (its configuration items work in a throwaway workspace and re-read the server's
//     copy every run; verify fetches each item over its copy), and a stale copy with no snapshot beside it would only
//     ever be reported as an unsent local edit;
//   - deleteFile / deleteByPrefix drop the memory entries too, and still reach the storage.
// Every other key (the manifest, the other kinds, entity metadata) is the storage's own, exactly as before. The manifest
// keeps one entry per artifact ({ type, id, name, entityLogicalName, isDirty }), which holds no value; an entry whose files
// are gone reads as an artifact with no local copy and no baseline — the SDK's diff answers no change for it — which is
// what a fresh run of the build used to find in its throwaway workspace anyway.
//
// Copies an earlier version left on disk are removed once per wrapper, right before the FIRST write or delete the SDK makes
// through it (a dry run's read-only look at the app folder's workspace writes nothing and so removes nothing). That removal
// is best effort: a file that cannot be removed is never read either, and the run goes on.
//
// The memory belongs to this one wrapper (one SDK instance): a second SDK over the same folder, or the next process, starts
// with none, as a new run of the build always did for its throwaway configuration workspace.

// The SDK's folder of each sensitive kind (vendor/cds-maker-sdk.cjs, WorkspaceManager's kind → folder map).
const SENSITIVE_FOLDERS = Object.freeze(['environment-variables', 'connection-references']);
const METADATA_FOLDER = '.metadata';

const sensitive = (key) => Array.isArray(key)
  && (SENSITIVE_FOLDERS.includes(key[0]) || (key[0] === METADATA_FOLDER && SENSITIVE_FOLDERS.includes(key[1])));
const memoryKey = (key) => key.join('/');
const underPrefix = (stored, prefix) => {
  const parts = stored.split('/');
  return prefix.length <= parts.length && prefix.every((part, i) => parts[i] === part);
};

/**
 * `storage` (an SDK WorkspaceStorage) with the sensitive configuration kinds kept in memory. Like output-redaction.js
 * guardWorkspaceStorage, every other member runs ON the storage (a storage may keep `#private` state) and the wrapper is a
 * Proxy over an empty child of it, so `pathFor`, `getRoot` and `instanceof` still hold. `prototype` names that parent
 * when `storage` is itself a wrapper (maker-sdk.js passes the caller's own storage under the token guard), so the
 * caller's storage stays the direct prototype of what the SDK is given.
 * @template T
 * @param {T} storage
 * @param {{ prototype?: object }} [options]
 * @returns {T}
 */
function keepSensitiveConfigurationInMemory(storage, { prototype = storage } = {}) {
  if (storage === null || typeof storage !== 'object' || typeof storage.readText !== 'function' || typeof storage.writeTextAtomic !== 'function') return storage;
  const memory = new Map();
  let scrubbed = null;
  // Once, before the first mutation: what an earlier plugin version wrote at these keys leaves the storage.
  const scrubOnce = () => {
    if (!scrubbed) {
      scrubbed = (async () => {
        if (typeof storage.deleteByPrefix !== 'function') return;
        for (const folder of SENSITIVE_FOLDERS) {
          for (const prefix of [[folder], [METADATA_FOLDER, folder]]) {
            try {
              await storage.deleteByPrefix(prefix);
            } catch {
              // Best effort: a copy that cannot be removed is still never read (readText above answers from memory).
            }
          }
        }
      })();
    }
    return scrubbed;
  };
  const own = {
    async readText(key, ...rest) {
      if (!sensitive(key)) return storage.readText(key, ...rest);
      const k = memoryKey(key);
      return memory.has(k) ? memory.get(k) : null;
    },
    async writeTextAtomic(key, text, ...rest) {
      await scrubOnce();
      if (!sensitive(key)) return storage.writeTextAtomic(key, text, ...rest);
      memory.set(memoryKey(key), String(text));
      return undefined;
    },
    async deleteFile(key, ...rest) {
      await scrubOnce();
      if (!sensitive(key)) return storage.deleteFile(key, ...rest);
      memory.delete(memoryKey(key));
      // The disk copy at this key (none after the scrub, unless it could not be removed) goes too.
      return storage.deleteFile(key, ...rest);
    },
    async deleteByPrefix(prefix, ...rest) {
      await scrubOnce();
      if (Array.isArray(prefix)) for (const k of [...memory.keys()]) if (underPrefix(k, prefix)) memory.delete(k);
      return storage.deleteByPrefix(prefix, ...rest);
    },
  };
  // `exists` is optional on a storage; the SDK falls back to readText when it is absent, so it is answered only when present.
  if (typeof storage.exists === 'function') {
    own.exists = async function exists(key, ...rest) {
      if (!sensitive(key)) return storage.exists(key, ...rest);
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

module.exports = { keepSensitiveConfigurationInMemory, SENSITIVE_FOLDERS };
