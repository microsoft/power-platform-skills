'use strict';

const catalogue = require('./design-direction-catalogue');

const HEADING = '## Design Direction';
const REQUIRED_KEYS = [
  'direction',
  'surface',
  'background',
  'palette',
  'typography',
  'heading_font',
  'body_font',
  'body_size',
  'heading_letter_spacing',
  'list_style',
  'density',
  'motion',
  'status_saturation',
  'empty_state',
  'primary_action_shape',
  'primary_action_position',
  'accent_color',
  'tone',
];
const METADATA = ['Picked', 'Reference apps', 'Picked at'];

function section(markdown) {
  const pattern = /^## Design Direction\s*$/m;
  const match = pattern.exec(markdown);
  if (!match) return null;
  const bodyStart = match.index + match[0].length;
  const remainder = markdown.slice(bodyStart);
  const next = remainder.search(/^##\s+/m);
  return {
    start: match.index,
    end: next < 0 ? markdown.length : bodyStart + next,
    body: next < 0 ? remainder : remainder.slice(0, next),
  };
}

function valueWithoutComment(value) {
  return String(value || '').replace(/\s+#\s+.*$/, '').trim();
}

function parseBody(body) {
  const metadata = {};
  const bundle = {};
  const duplicates = [];
  for (const line of String(body || '').split('\n')) {
    const metadataMatch = line.match(/^\*\*([^*]+):\*\*\s*(.+?)\s*$/);
    if (metadataMatch) {
      const key = metadataMatch[1].trim();
      if (Object.hasOwn(metadata, key)) duplicates.push(key);
      metadata[key] = metadataMatch[2].trim();
      continue;
    }
    const keyValue = line.match(/^([a-z][a-z0-9_]*):\s*(.*?)\s*$/);
    if (!keyValue) continue;
    const key = keyValue[1];
    if (Object.hasOwn(bundle, key)) duplicates.push(key);
    bundle[key] = valueWithoutComment(keyValue[2]);
  }
  return { metadata, bundle, duplicates };
}

function validIsoTimestamp(value) {
  const timestamp = String(value || '').replace(/\s+\(via\s+[^)]+\)\s*$/i, '').trim();
  const match = timestamp.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/);
  if (!match || !Number.isFinite(Date.parse(timestamp))) return false;
  const [, year, month, day, hour, minute, second, , offsetHour = '00', offsetMinute = '00'] = match;
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const daysInMonth = monthNumber >= 1 && monthNumber <= 12 ? new Date(Date.UTC(yearNumber, monthNumber, 0)).getUTCDate() : 0;
  return dayNumber >= 1 && dayNumber <= daysInMonth
    && Number(hour) <= 23
    && Number(minute) <= 59
    && Number(second) <= 59
    && Number(offsetHour) <= 23
    && Number(offsetMinute) <= 59;
}

function referenceApps(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function validAccentColor(value) {
  const normalized = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(normalized)
    || /^.+\(#[0-9a-f]{6}\)$/i.test(normalized);
}

function placementError(markdown, block) {
  const headingIndex = (heading) => new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').exec(markdown)?.index ?? -1;
  const connectors = headingIndex('## Connectors');
  const nativeCapabilities = headingIndex('## Native Capabilities');
  const predecessor = connectors >= 0 ? connectors : nativeCapabilities;
  const design = headingIndex('## Design');
  const screens = headingIndex('## Screens');
  const successor = design >= 0 ? design : screens;
  if (predecessor < 0 || block.start <= predecessor) return `${HEADING} must follow ## Connectors or ## Native Capabilities`;
  if (successor < 0 || block.end > successor) return `${HEADING} must precede ## Design or ## Screens`;
  return null;
}

function inspect(markdown, options = {}) {
  const block = section(markdown);
  if (!block) return { present: false, valid: true, effective: 'fallback', errors: [], metadata: null, bundle: null };
  const parsed = parseBody(block.body);
  const errors = [];
  if ((markdown.match(/^## Design Direction\s*$/gm) || []).length !== 1) errors.push('plan must contain exactly one Design Direction block');
  for (const key of METADATA) if (!String(parsed.metadata[key] || '').trim()) errors.push(`missing metadata ${key}`);
  for (const key of REQUIRED_KEYS) if (!String(parsed.bundle[key] || '').trim()) errors.push(`missing bundle key ${key}`);
  if (parsed.duplicates.length > 0) errors.push(`duplicate keys: ${[...new Set(parsed.duplicates)].join(', ')}`);
  const registered = new Set((options.catalogue || catalogue.load()).map((entry) => entry.slug));
  if (parsed.bundle.direction && parsed.bundle.direction !== 'hybrid' && !registered.has(parsed.bundle.direction)) {
    errors.push(`direction ${parsed.bundle.direction} is not registered`);
  }
  if (parsed.bundle.direction === 'hybrid' && !/^Hybrid\s*\(.+\)$/i.test(parsed.metadata.Picked || '')) {
    errors.push('hybrid Picked metadata must document its composition');
  }
  if (parsed.metadata['Reference apps'] && referenceApps(parsed.metadata['Reference apps']).length < 2) {
    errors.push('Reference apps must contain at least 2 entries');
  }
  if (parsed.metadata['Picked at'] && !validIsoTimestamp(parsed.metadata['Picked at'])) errors.push('Picked at must be ISO 8601');
  if (parsed.bundle.accent_color && !validAccentColor(parsed.bundle.accent_color)) {
    errors.push('accent_color must be #RRGGBB or a name followed by (#RRGGBB)');
  }
  const placement = placementError(markdown, block);
  if (placement) errors.push(placement);
  return {
    present: true,
    valid: errors.length === 0,
    effective: errors.length === 0 ? 'bundle' : 'fallback',
    errors,
    metadata: parsed.metadata,
    bundle: errors.length === 0 ? parsed.bundle : null,
    range: { start: block.start, end: block.end },
  };
}

function replace(markdown, blockMarkdown) {
  const normalized = `${String(blockMarkdown || '').trim()}\n\n`;
  if (!normalized.startsWith(`${HEADING}\n`)) throw new Error(`replacement must start with ${HEADING}`);
  const existing = section(markdown);
  if (existing) return `${markdown.slice(0, existing.start)}${normalized}${markdown.slice(existing.end).replace(/^\s*/, '')}`;
  const anchors = ['## Design', '## Screens'];
  const index = anchors.map((heading) => markdown.indexOf(heading)).filter((candidate) => candidate >= 0).sort((left, right) => left - right)[0];
  if (index === undefined) throw new Error('plan has no ## Design or ## Screens insertion anchor');
  return `${markdown.slice(0, index)}${normalized}${markdown.slice(index)}`;
}

module.exports = {
  HEADING,
  METADATA,
  REQUIRED_KEYS,
  inspect,
  parseBody,
  placementError,
  referenceApps,
  replace,
  section,
  validAccentColor,
  validIsoTimestamp,
  valueWithoutComment,
};