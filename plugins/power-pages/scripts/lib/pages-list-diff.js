'use strict';

const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function normalizeName(value) {
  return value
    .replace(/\s{2,}/g, ' ')
    .replace(/^\W+|\W+$/g, '')
    .trim();
}

function isInactiveState(state) {
  return /inactive|not\s+live|not\s+provisioned|unprovisioned/i.test(state || '') || normalizeName(state).toLowerCase() === 'no';
}

function normalizeComparableName(value) {
  return normalizeName(String(value || '')).toLowerCase();
}

function comparableNameAliases(value) {
  const normalized = normalizeComparableName(value);
  if (!normalized) return [];
  const aliases = new Set([normalized]);
  // Template family names can omit the SPA framework while the imported site row
  // includes it, e.g. `311 Portal` in solution metadata but `311 Portal React`
  // in `pac pages list -v`. Strip only known trailing framework tokens so the
  // fallback does not turn into arbitrary fuzzy matching across unrelated sites.
  const withoutFramework = normalized.replace(/\s+(react|vue|angular|astro)\s*$/i, '').trim();
  if (withoutFramework) aliases.add(withoutFramework);
  return [...aliases];
}

function siteNameMatchesExpected(siteName, expectedSiteName) {
  const siteAliases = comparableNameAliases(siteName);
  const expectedAliases = new Set(comparableNameAliases(expectedSiteName));
  return siteAliases.some((alias) => expectedAliases.has(alias));
}

function expectedSiteNamesFromOptions(options = {}) {
  const names = [];
  if (options.expectedSiteName) names.push(options.expectedSiteName);
  if (Array.isArray(options.expectedSiteNames)) names.push(...options.expectedSiteNames);
  return names.filter((name) => normalizeComparableName(name));
}

function parseIndexedGuidRow({ beforeName, afterGuid }) {
  const afterParts = afterGuid.split(/\s{2,}/).map(normalizeName).filter(Boolean);
  // Current PAC CLI verbose table shape:
  //   [1]  <Website Id>  N/A  Supplier Invoice Portal  N/A  N/A  Yes  No
  // Columns after Website Id are:
  //   Portal Id, Friendly Name, Portal Url, Data Model Version,
  //   Single Page Application, Is Site Active
  // Older output put Friendly Name immediately after Website Id, so only use this
  // positional parse when the trailing active flag is a boolean-like Yes/No value.
  if (/^\[?\d+\]?$/.test(beforeName) && afterParts.length >= 6 && /^(yes|no)$/i.test(afterParts[afterParts.length - 1])) {
    return { name: afterParts[1] || '', state: afterParts[afterParts.length - 1] };
  }
  const name = afterParts.shift() || '';
  return { name, state: normalizeName(afterParts.join(' ')) };
}

function parsePagesListVerbose(output) {
  // `pac pages list -v` is a human table whose exact columns vary by CLI
  // version/cloud. The stable token we need is the Website Record ID GUID.
  // Observed rows are table-like, for example:
  //   Website Name        Website Record ID
  //   Contoso Portal      11111111-1111-1111-1111-111111111111   Inactive
  // In verbose output additional columns can trail the GUID, so treat the text
  // before the first GUID as the display name and ignore trailing details.
  const rows = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(GUID_RE);
    if (!match) continue;
    const beforeGuid = line.slice(0, match.index);
    const afterGuid = line.slice(match.index + match[0].length);
    const beforeName = normalizeName(beforeGuid);
    // PAC tables have appeared in both name-before-GUID and indexed
    // GUID-before-name forms:
    //   Contoso Portal      11111111-1111-1111-1111-111111111111   Inactive
    //   1                   11111111-1111-1111-1111-111111111111   Contoso Portal   Inactive
    // If the text before the GUID is just an index, take the first verbose
    // column after the GUID as the site name and the remaining columns as state.
    const indexed = /^\[?\d+\]?$/.test(beforeName);
    const parsedIndexed = indexed ? parseIndexedGuidRow({ beforeName, afterGuid }) : null;
    const name = indexed ? parsedIndexed.name : beforeName;
    if (!name || /^[-\s|]+$/.test(name) || /website\s+record\s+id/i.test(name)) continue;
    const state = indexed ? parsedIndexed.state : normalizeName(afterGuid);
    rows.push({ siteName: name, websiteRecordId: match[0], state: state || null });
  }
  return rows;
}

function diffPagesListVerbose(beforeOutput, afterOutput, options = {}) {
  const before = parsePagesListVerbose(beforeOutput);
  const after = parsePagesListVerbose(afterOutput);
  const beforeIds = new Set(before.map((row) => row.websiteRecordId.toLowerCase()));
  const added = after.filter((row) => !beforeIds.has(row.websiteRecordId.toLowerCase()));
  if (added.length === 1) {
    return {
      status: 'found',
      siteName: added[0].siteName,
      websiteRecordId: added[0].websiteRecordId,
      state: added[0].state,
      inactive: isInactiveState(added[0].state),
      added,
    };
  }
  if (added.length === 0) {
    const expectedSiteNames = expectedSiteNamesFromOptions(options);
    if (expectedSiteNames.length) {
      const existing = after.filter((row) => expectedSiteNames.some((expectedSiteName) => siteNameMatchesExpected(row.siteName, expectedSiteName)));
      if (existing.length === 1) {
        return {
          status: 'existing',
          siteName: existing[0].siteName,
          websiteRecordId: existing[0].websiteRecordId,
          state: existing[0].state,
          inactive: isInactiveState(existing[0].state),
          added,
          warning: 'No new site appeared in pac pages list; matched an existing site by expected template site name.',
        };
      }
      if (existing.length > 1) {
        return { status: 'existing-multiple', added, existing };
      }
    }
    return { status: 'none', added };
  }
  return { status: 'multiple', added };
}

module.exports = { parsePagesListVerbose, diffPagesListVerbose, isInactiveState };
