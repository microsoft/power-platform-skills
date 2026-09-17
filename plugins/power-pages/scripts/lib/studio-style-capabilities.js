'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { styleProperties } = require('./style-site-css');

const referencePath = path.resolve(__dirname, '../../skills/style-site/references/studio-component-capabilities.md');
const block = fs.readFileSync(referencePath, 'utf8').match(/^```json\r?\n([\s\S]*?)\r?\n```/m);
if (!block) throw new Error('Studio capability reference is missing its canonical JSON map.');
const capabilityMap = JSON.parse(block[1]);

function createStudioSupport(map) {
  if (map.schemaVersion !== 1 || map.availability?.flexTab !== 'conditional' ||
      map.availability?.transitionTab !== 'unavailable' || !map.propertySets || !map.componentFamilies) {
    throw new Error('Unsupported Studio capability map.');
  }
  const names = new Map();
  const properties = new Map();
  for (const [tab, entries] of Object.entries(map.propertySets)) {
    if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === 'string')) throw new Error('Invalid Studio property set.');
    for (const property of entries) properties.set(property.toLowerCase(), { property, tab });
  }
  for (const [family, entry] of Object.entries(map.componentFamilies)) {
    if (!Array.isArray(entry.includes) || !Array.isArray(entry.tabs) || !entry.editable) throw new Error('Invalid Studio component family.');
    for (const name of [family, ...entry.includes]) {
      const key = name.trim().toLowerCase();
      if (names.has(key) && names.get(key) !== family) throw new Error('Ambiguous Studio component name.');
      names.set(key, family);
    }
    for (const [tab, values] of Object.entries(entry.editable)) {
      const allowed = map.propertySets[tab.toLowerCase()];
      if (!entry.tabs.includes(tab) || !allowed ||
          (values !== 'all' && (!Array.isArray(values) || values.some((value) => !allowed.includes(value))))) {
        throw new Error('Invalid Studio component/tab property mapping.');
      }
    }
  }
  function normalizeProperty(raw) {
    const property = raw.trim().toLowerCase();
    // The supplied reference explicitly expands physical sides/corners and
    // border details. Literal outline, logical inset/margin, and arbitrary
    // transforms are NOT aliases of those controls.
    if (/^(margin|padding)-(top|right|bottom|left)$/.test(property)) return property.split('-')[0];
    if (/^border-(top-left|top-right|bottom-left|bottom-right)-radius$/.test(property)) return 'border-radius';
    if (/^border-(width|style|color)$/.test(property)) return 'border';
    return properties.get(property)?.property || property;
  }
  function lookup(component, rawProperty, flex = 'unknown') {
    if (component !== undefined && (typeof component !== 'string' || !component.trim() || component.length > 120)) {
      throw new Error('Studio component must be non-empty text up to 120 characters.');
    }
    if (typeof rawProperty !== 'string' || !rawProperty.trim()) throw new Error('Invalid Studio property name.');
    if (!['available', 'unavailable', 'unknown'].includes(flex)) throw new Error('Flex availability must be available, unavailable or unknown.');
    const family = names.get(component?.trim().toLowerCase());
    const property = normalizeProperty(rawProperty);
    const base = { property: rawProperty, canonicalProperty: property, componentFamily: family || null, tab: null };
    if (!family) return { ...base, status: 'unknown', reason: 'Component Design-panel capabilities are not established by this map.' };
    const entry = map.componentFamilies[family];
    const tab = Object.keys(entry.editable).find((name) => {
      const values = entry.editable[name] === 'all' ? map.propertySets[name.toLowerCase()] : entry.editable[name];
      return values.includes(property);
    });
    if (!tab) return { ...base, status: 'unsupported', reason: 'Not listed for this component Design panel.' };
    if (tab === 'Flex' && flex !== 'available') {
      return {
        ...base, tab, status: flex === 'unavailable' ? 'unsupported' : 'conditional',
        reason: flex === 'unavailable' ? 'The Flex tab is unavailable in the selected environment.' : 'Confirm Flex-tab availability in the selected environment.',
      };
    }
    return { ...base, tab, status: 'supported', reason: 'Property listed; verify its value, units and range in the current control.' };
  }
  function assessStyle(style) {
    if (!style) throw new Error('Capability assessment requires style declarations or CSS.');
    const requestedProperties = styleProperties(style);
    if (style.css === undefined && (!requestedProperties.length || requestedProperties.length > 100)) {
      throw new Error('Capability assessment requires 1-100 properties.');
    }
    const results = requestedProperties.map((property) => {
      const result = lookup(style.studioComponent, property, style.studioFlex);
      return (style.css !== undefined || style.part?.includes(':')) && ['supported', 'conditional'].includes(result.status)
        ? { ...result, status: 'unknown', reason: 'The map does not establish rule-, descendant- or state-specific Design-panel editing.' } : result;
    });
    const warnings = [];
    if (style.css !== undefined) warnings.push('Authored stylesheet rules, conditions and global definitions are maintained in VS Code; the component Design-panel map does not establish their editability.');
    for (const status of ['unsupported', 'unknown', 'conditional']) {
      const affected = results.filter((entry) => entry.status === status).map((entry) => entry.property);
      if (!affected.length || (!style.studioComponent && style.owner === 'studio')) continue;
      const target = style.studioComponent || 'this component';
      const reason = status === 'unsupported'
        ? `Not editable through ${target}'s Studio Design panel`
        : status === 'conditional' ? `Flex-tab support is unconfirmed for ${target}` : `Studio Design-panel editability is unverified for ${target}`;
      warnings.push(`${reason}: ${affected.join(', ')}. ${style.owner === 'studio'
        ? 'Verify the current control before completing this handoff.'
        : 'Local styles are maintained in VS Code; rendering in Studio does not imply an editing control.'}`);
    }
    return { styleId: style.id, component: style.studioComponent || null, properties: results, warnings };
  }
  return { lookup, assessStyle };
}

const studioSupport = createStudioSupport(capabilityMap);
function requestSupport(request) {
  return request.styles.map((style) => studioSupport.assessStyle(style));
}
function requestWarnings(request) {
  return requestSupport(request).flatMap((entry) => entry.warnings.map((warning) => `${entry.styleId}: ${warning}`));
}

module.exports = { referencePath, capabilityMap, createStudioSupport, studioSupport, requestSupport, requestWarnings };
