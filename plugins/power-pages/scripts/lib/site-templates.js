// Create Website API identifiers used for request validation. Presentation and
// selection metadata comes from the release-pinned power-pages-samples catalog.
// Keep documented legacy identifiers valid for direct API callers without
// presenting them as current catalog choices.
// See: https://learn.microsoft.com/rest/api/power-platform/powerpages/websites/create-website

const LEGACY_DOCUMENTED_TEMPLATE_NAMES = Object.freeze([
  'DefaultPortalTemplate',
  'PowerPortals_ProgramRegistration',
  'PowerPortals_BookMeeting',
]);

const BOOTSTRAP_5_DOCUMENTATION_URL =
  'https://learn.microsoft.com/en-us/power-pages/configure/bootstrap-version-5';

// New Bootstrap 5 sites require Enhanced and a documented template family. Match
// exact catalog/API identifiers, not display-name guesses. Include the documented
// Program Registration/Meetings API aliases without adding new catalog choices.
// Event Portal is not in the documented Bootstrap 5 creation list.
// See: https://learn.microsoft.com/en-us/power-pages/configure/bootstrap-version-5
const BOOTSTRAP_5_TEMPLATE_NAMES = Object.freeze([
  'StarterLayout1',
  'StarterLayout2',
  'StarterLayout3',
  'StarterLayout4',
  'StarterLayout5',
  'BlankPage',
  'ProgramRegistration',
  'PowerPortals_ProgramRegistration',
  'BookMeetings',
  'PowerPortals_BookMeeting',
]);

const CREATE_WEBSITE_TEMPLATE_NAMES = new Set([
  'StarterLayout1',
  'StarterLayout2',
  'StarterLayout3',
  'StarterLayout4',
  'StarterLayout5',
  'BlankPage',
  'ProgramRegistration',
  'EventPortal',
  'BookMeetings',
  ...LEGACY_DOCUMENTED_TEMPLATE_NAMES,
]);

function normalizeBootstrapVersion(value) {
  if (value === 3 || value === 5) return value;
  if (typeof value === 'string' && /^(?:3|5)$/.test(value.trim())) {
    return Number(value.trim());
  }
  throw new Error('--bootstrapVersion must be 3 or 5');
}

function parseBootstrapVersionArgs(argv) {
  let selected;
  for (let index = 0; index < argv.length; index += 1) {
    // Accept "--bootstrapVersion 5" and "--bootstrapVersion=5" (and kebab case),
    // but never let an empty value or duplicate option become an omitted check.
    const match = /^--(?:bootstrapVersion|bootstrap-version)(?:=(.*))?$/.exec(argv[index]);
    if (!match) continue;
    if (selected !== undefined) throw new Error('--bootstrapVersion must be specified only once');
    const value = match[1] === undefined ? argv[++index] : match[1];
    selected = normalizeBootstrapVersion(value);
  }
  return selected;
}

function normalizeNonSpaModelVersion(value) {
  if (typeof value !== 'string') {
    throw new Error('--modelVersion must be Enhanced or Standard');
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'enhanced') return 'Enhanced';
  if (normalized === 'standard') return 'Standard';
  throw new Error('--modelVersion must be Enhanced or Standard');
}

module.exports = {
  LEGACY_DOCUMENTED_TEMPLATE_NAMES,
  BOOTSTRAP_5_DOCUMENTATION_URL,
  BOOTSTRAP_5_TEMPLATE_NAMES,
  CREATE_WEBSITE_TEMPLATE_NAMES,
  normalizeBootstrapVersion,
  parseBootstrapVersionArgs,
  normalizeNonSpaModelVersion,
};
