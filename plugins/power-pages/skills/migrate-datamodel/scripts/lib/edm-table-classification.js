'use strict';

// Microsoft EDM categories are intentionally kept separate from the local
// snapshot scanner names. Nonconfiguration data is not part of the SDM -> EDM
// metadata comparison, while virtual configuration such as poll placements is.
const NONCONFIGURATION_TABLES = [
  { category: 'ads', label: 'Ads', table: 'Ad' },
  { category: 'polls', label: 'Polls', table: 'Poll' },
  { category: 'pollSubmissions', label: 'Poll submissions', table: 'Poll Submission' },
  { category: 'externalIdentities', label: 'External identities', table: 'External Identity' },
  { category: 'portalComments', label: 'Portal comments', table: 'Portal comment' },
  { category: 'invitations', label: 'Invitations', table: 'Invitation' },
  { category: 'invitationRedemptions', label: 'Invitation redemptions', table: 'Invitation Redemption' },
  { category: 'settings', label: 'Settings', table: 'Setting' },
  { category: 'webFormSessions', label: 'Web form sessions', table: 'WebFormSession' },
];

const NONCONFIGURATION_CATEGORIES = new Set(NONCONFIGURATION_TABLES.map(({ category }) => category));

const SDM_ONLY_CATEGORIES = new Set([
  'tags',
  'websiteBindings',
]);

// These categories are retained in raw snapshots but are not shown in the
// metadata component comparison. websiteBindings is an expected SDM-only
// download difference; forums/blogs/ideas are reserved for future scanners.
const REPORT_EXCLUDED_CATEGORIES = new Set([
  ...NONCONFIGURATION_CATEGORIES,
  'forums',
  'blogs',
  'ideas',
  'websiteBindings',
]);

const CATEGORY_METADATA = {
  ads: {
    label: 'Ads',
    reason: 'Ads are nonconfiguration data and are removed from the enhanced data model.',
  },
  polls: {
    label: 'Polls',
    reason: 'Polls are nonconfiguration data and are removed from the enhanced data model.',
  },
  pollSubmissions: {
    label: 'Poll submissions',
    reason: 'Poll submissions are nonconfiguration runtime data and are not part of the metadata migration.',
  },
  externalIdentities: {
    label: 'External identities',
    reason: 'External identities are nonconfiguration runtime data and are not part of the metadata migration.',
  },
  portalComments: {
    label: 'Portal comments',
    reason: 'Portal comments are nonconfiguration runtime data and are not part of the metadata migration.',
  },
  invitations: {
    label: 'Invitations',
    reason: 'Invitations are nonconfiguration runtime data and are not part of the metadata migration.',
  },
  invitationRedemptions: {
    label: 'Invitation redemptions',
    reason: 'Invitation redemptions are nonconfiguration runtime data and are not part of the metadata migration.',
  },
  settings: {
    label: 'Settings',
    reason: 'Settings are listed as nonconfiguration data in the enhanced data model.',
  },
  webFormSessions: {
    label: 'Web form sessions',
    reason: 'Web form sessions are nonconfiguration runtime data and are not part of the metadata migration.',
  },
};

function isNonconfigurationCategory(category) {
  return NONCONFIGURATION_CATEGORIES.has(category);
}

function isSdmOnlyCategory(category) {
  return SDM_ONLY_CATEGORIES.has(category);
}

function isReportExcludedCategory(category) {
  return REPORT_EXCLUDED_CATEGORIES.has(category);
}

function getCategoryMetadata(category) {
  return CATEGORY_METADATA[category] || {
    label: category,
    reason: 'This category is outside the SDM to EDM metadata comparison scope.',
  };
}

module.exports = {
  NONCONFIGURATION_TABLES,
  NONCONFIGURATION_CATEGORIES,
  SDM_ONLY_CATEGORIES,
  REPORT_EXCLUDED_CATEGORIES,
  isNonconfigurationCategory,
  isSdmOnlyCategory,
  isReportExcludedCategory,
  getCategoryMetadata,
};
