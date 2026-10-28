'use strict';
// A workspace storage the SDK works through that can be CLOSED.
//
// The SDK keeps its workspace — the copy of every artifact it fetched, here the source of every page read — through a storage object
// (vendor `WorkspaceStorage`: readText, writeTextAtomic, deleteFile, deleteByPrefix, and optionally ensureContainer and exists), and a
// folder made for one run is removed when the run ends. Removing it is not enough while the SDK is still working: a write that was
// already under way finishes, one that comes after goes through `mkdir -p` and puts the folder back with the page's source in it,
// and nothing is left to remove it. This wraps a storage so that
//   - once it is closed, every call rejects: no work that is still running can write, or recreate, anything; and
//   - the calls that were already in flight can be waited for, so the folder is removed only after they have finished.
// The storage seam is the only way the SDK touches the disk (vendored src/workspace/NodeFileSystemStorage.ts is the one file that
// imports `fs`), so closing it is closing the workspace.
//
//   const guard = guardWorkspaceStorage(createNodeWorkspaceStorage(dir), () => new Error('closed'));
//   createMakerSdk({ workspaceStorage: guard.storage, … });
//   guard.close();                    // from now on every call rejects
//   guard.busy;                       // true while a call that began before close() has not settled
//   await guard.settled();            // resolves once those have settled (it never rejects)
const METHODS = ['readText', 'writeTextAtomic', 'deleteFile', 'deleteByPrefix', 'ensureContainer', 'exists'];

function guardWorkspaceStorage(inner, closedError) {
  const inFlight = new Set();
  let open = true;
  const storage = {};
  for (const method of METHODS) {
    // `ensureContainer` and `exists` are optional on the seam, and the SDK tests for their presence: a wrapper must not invent them.
    if (typeof inner[method] !== 'function') continue;
    storage[method] = (...args) => {
      if (!open) return Promise.reject(closedError());
      let call;
      try {
        call = Promise.resolve(inner[method](...args));
      } catch (error) {
        // A store that throws instead of rejecting (a synchronous one is valid on this seam) is still a failed call, not a thrown one.
        call = Promise.reject(error);
      }
      inFlight.add(call);
      const done = () => inFlight.delete(call);
      call.then(done, done);
      return call;
    };
  }
  return {
    storage,
    close() { open = false; },
    get busy() { return inFlight.size > 0; },
    settled() { return Promise.allSettled([...inFlight]).then(() => undefined); },
  };
}

module.exports = { guardWorkspaceStorage };
