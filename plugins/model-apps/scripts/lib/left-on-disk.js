'use strict';
// What a command says when the page backend could not remove a workspace it made.
//
// The page backend (lib/genpage-sdk.js) works in a throwaway folder that holds the source of every page it read or wrote, and `dispose()` answers `{ left }`: the folders it could not remove
// after its retries, which on Windows is a handle that a virus scanner or an indexer holds. A command that dropped that answer reported success with a page's source still in the temp directory
// and not a word about it. Every command that makes a backend reads the answer through this one function — the verify command, the upload, the build and its inline verify, the base-marker
// check, `apps.js` and `genpage.js` — so the wording is one, and a person who reads it knows what to do. It lives apart from the backend so that a test that stands in for the backend
// module does not have to stand in for this as well.
//   disposed   what `dispose()` answered, or anything else (a backend that answers nothing, a test's stand-in)
//   -> the warning, or null when no folder is left
function leftOnDiskWarning(disposed) {
  const left = disposed && Array.isArray(disposed.left) ? disposed.left.filter((folder) => typeof folder === 'string' && folder) : [];
  return left.length ? `the page workspace could not be removed, so page source may be left on disk: ${left.join(', ')} — delete the folder by hand` : null;
}

module.exports = { leftOnDiskWarning };
