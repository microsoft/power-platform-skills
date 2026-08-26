'use strict';

const ICON_NAMES = Object.freeze({
  home: 'home-outline',
  browse: 'storefront-outline',
  categories: 'pricetags-outline',
  bag: 'bag-handle-outline',
  profile: 'person-circle-outline',
  settings: 'settings-outline',
  shipments: 'cube-outline',
  drafts: 'document-text-outline',
  inspections: 'clipboard-outline',
  repairs: 'construct-outline',
  maintenance: 'calendar-outline',
  warranty: 'shield-checkmark-outline',
  scan: 'scan-outline',
  barcode: 'barcode-outline',
  camera: 'camera-outline',
  location: 'location-outline',
  signature: 'pencil-outline',
  print: 'print-outline',
  history: 'time-outline',
  alerts: 'notifications-outline',
  messages: 'chatbubbles-outline',
  search: 'search-outline',
  filter: 'funnel-outline',
  add: 'add-circle-outline',
  edit: 'create-outline',
  delete: 'trash-outline',
  retry: 'refresh-outline',
  list: 'list-outline',
});

const INTENT_PATTERNS = [
  ['home', /\b(?:home|today|overview)\b/i],
  ['categories', /\bcategor(?:y|ies)\b/i],
  ['bag', /\b(?:bag|cart|basket)\b/i],
  ['profile', /\b(?:profile|account|me|user)\b/i],
  ['settings', /\b(?:settings?|preferences?|config(?:uration)?)\b/i],
  ['shipments', /\b(?:shipments?|deliver(?:y|ies)|receiving)\b/i],
  ['drafts', /\b(?:drafts?|saved)\b/i],
  ['inspections', /\b(?:inspections?|audits?|checklists?)\b/i],
  ['repairs', /\b(?:repairs?|fixes|service work)\b/i],
  ['maintenance', /\b(?:maintenance|scheduled work|upcoming service)\b/i],
  ['warranty', /\b(?:warranty|warranties|coverage)\b/i],
  ['barcode', /\bbarcodes?\b/i],
  ['scan', /\b(?:scan|scanner|qr)\b/i],
  ['camera', /\b(?:camera|photos?|evidence)\b/i],
  ['location', /\b(?:location|gps|map|route)\b/i],
  ['signature', /\b(?:signature|sign[- ]?off|confirmation)\b/i],
  ['print', /\b(?:print|label)\b/i],
  ['history', /\b(?:history|activity|timeline)\b/i],
  ['alerts', /\b(?:alerts?|notifications?|attention)\b/i],
  ['messages', /\b(?:messages?|inbox|chat|conversations?)\b/i],
  ['search', /\b(?:search|find|lookup)\b/i],
  ['filter', /\bfilters?\b/i],
  ['add', /\b(?:add|new|create)\b/i],
  ['edit', /\b(?:edit|update)\b/i],
  ['delete', /\b(?:delete|remove|trash)\b/i],
  ['retry', /\b(?:retry|refresh|reload)\b/i],
  ['browse', /\b(?:browse|catalog|shop|library|explore|products?)\b/i],
  ['list', /\b(?:list|records?|items?|assets?|equipment|work)\b/i],
];

function inferIconIntent(value) {
  const label = String(value || '');
  return INTENT_PATTERNS.find(([, pattern]) => pattern.test(label))?.[0] || 'list';
}

function resolveIconName(intent) {
  return ICON_NAMES[intent] || ICON_NAMES.list;
}

function isKnownIconIntent(intent) {
  return Object.hasOwn(ICON_NAMES, intent);
}

module.exports = { ICON_NAMES, INTENT_PATTERNS, inferIconIntent, isKnownIconIntent, resolveIconName };
