'use strict';

const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function normalizeName(value) {
  return value
    .replace(/\s{2,}/g, ' ')
    .replace(/^\W+|\W+$/g, '')
    .trim();
}

function isInactiveState(state) {
  return /inactive|not\s+live|not\s+provisioned|unprovisioned/i.test(state || '');
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
    const afterParts = afterGuid.split(/\s{2,}/).map(normalizeName).filter(Boolean);
    const name = /^\d+$/.test(beforeName) ? (afterParts.shift() || '') : beforeName;
    if (!name || /^[-\s|]+$/.test(name) || /website\s+record\s+id/i.test(name)) continue;
    const state = /^\d+$/.test(beforeName) ? normalizeName(afterParts.join(' ')) : normalizeName(afterGuid);
    rows.push({ siteName: name, websiteRecordId: match[0], state: state || null });
  }
  return rows;
}

function diffPagesListVerbose(beforeOutput, afterOutput) {
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
    return { status: 'none', added };
  }
  return { status: 'multiple', added };
}

module.exports = { parsePagesListVerbose, diffPagesListVerbose, isInactiveState };
