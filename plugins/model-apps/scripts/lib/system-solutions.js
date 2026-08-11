'use strict';
// The built-in Dataverse system solutions. These are NOT real user solutions:
//   - "Active"  — the default solution container every unmanaged customization also belongs to.
//   - "Default" — the legacy "Default Solution" container.
//   - "Basic"   — the built-in base solution.
// Every app module is registered as a solutioncomponent of one or more of these AS WELL AS the real
// unmanaged solution it was created in, and Dataverse refuses to delete any of them
// ("Attempting to delete a restricted solution <name>", HTTP 400).
//
// This is the single source of truth for that fact, shared by two call sites that must agree:
//   - download-model-app.js  → EXCLUDE these when recovering an app's real solution (else the
//     downloaded spec's solution defaults to 'Default' and can never tear down the real solution).
//   - sdk-teardown.js        → SKIP these on teardown (attempting the delete always 400s).
// Compared case-insensitively because the uniquename casing that comes back from the platform and
// the value carried in a downloaded spec are not guaranteed to match.
// See: https://learn.microsoft.com/power-apps/maker/data-platform/solutions-overview
const RESTRICTED_SOLUTION_UNIQUENAMES = new Set(['active', 'default', 'basic']);

// True when `uniqueName` names a built-in system solution. Null/non-string safe so callers can pass
// a possibly-missing spec field or a possibly-absent OData property without a guard of their own.
function isRestrictedSolution(uniqueName) {
  if (typeof uniqueName !== 'string' || !uniqueName) return false;
  return RESTRICTED_SOLUTION_UNIQUENAMES.has(uniqueName.toLowerCase());
}

module.exports = { RESTRICTED_SOLUTION_UNIQUENAMES, isRestrictedSolution };
