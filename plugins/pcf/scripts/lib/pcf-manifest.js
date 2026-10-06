'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseXml, findAll, findFirst, attr, childElements, textOf } = require('./xml-lite.js');
const { loadMatrix, platformLibraryFindings, hostPolicy, compareVersions } = require('./pcf-matrix.js');
const { validateVersion } = require('./pcf-names.js');

const MANIFEST_REFERENCE = 'https://learn.microsoft.com/power-apps/developer/component-framework/manifest-schema-reference/';
const SKIP_DIRS = new Set(['node_modules', 'out', 'obj', 'bin', 'generated']);
const PROPERTY_USAGES = new Set(['bound', 'input', 'output']);

function finding(code, severity, message, fix) {
  return { code, severity, message, fix };
}

function parseManifest(xmlText) {
  const errors = [];
  let root;
  try {
    root = parseXml(xmlText);
  } catch (err) {
    return {
      model: emptyModel(),
      errors: [finding('PCF_NO_CONTROL', 'error', `The manifest XML could not be parsed: ${err.message}.`, 'Fix the XML so it contains one valid <control> element.')],
    };
  }

  const control = findFirst(root, (node) => node.name === 'control');
  if (!control) {
    return {
      model: emptyModel(),
      errors: [finding('PCF_NO_CONTROL', 'error', 'The manifest does not contain a <control> element.', 'Add exactly one <control> element under <manifest>.')],
    };
  }

  return {
    model: {
      control: {
        namespace: attr(control, 'namespace'),
        constructor: attr(control, 'constructor'),
        version: attr(control, 'version'),
        displayNameKey: attr(control, 'display-name-key'),
        descriptionKey: attr(control, 'description-key'),
        controlType: attr(control, 'control-type') || 'standard',
      },
      properties: childElements(control, 'property').map(readProperty),
      typeGroups: readTypeGroups(control),
      dataSets: childElements(control, 'data-set').map(readDataSet),
      resources: readResources(control),
      features: readFeatures(control),
      externalServiceUsage: readExternalServiceUsage(control),
      events: childElements(control, 'event').map((event) => ({ name: attr(event, 'name') })),
    },
    errors,
  };
}

function emptyModel() {
  return {
    control: {},
    properties: [],
    typeGroups: {},
    dataSets: [],
    resources: { code: [], css: [], resx: [], img: [], platformLibraries: [], dependencies: [] },
    features: [],
    externalServiceUsage: null,
    events: [],
  };
}

function readProperty(el) {
  return {
    name: attr(el, 'name'),
    displayNameKey: attr(el, 'display-name-key'),
    usage: attr(el, 'usage'),
    ofType: attr(el, 'of-type'),
    ofTypeGroup: attr(el, 'of-type-group'),
    required: attr(el, 'required') === 'true',
    defaultValue: attr(el, 'default-value'),
  };
}

function readTypeGroups(control) {
  const groups = {};
  for (const group of childElements(control, 'type-group')) {
    const name = attr(group, 'name');
    if (name) groups[name] = childElements(group, 'type').map(textOf).filter(Boolean);
  }
  return groups;
}

function readDataSet(el) {
  return {
    name: attr(el, 'name'),
    cdsDataSetOptions: attr(el, 'cds-data-set-options'),
    propertySets: childElements(el, 'property-set').map((set) => ({
      name: attr(set, 'name'),
      usage: attr(set, 'usage'),
      ofType: attr(set, 'of-type'),
      ofTypeGroup: attr(set, 'of-type-group'),
      required: attr(set, 'required') === 'true',
    })),
  };
}

function readResources(control) {
  const resources = { code: [], css: [], resx: [], img: [], platformLibraries: [], dependencies: [] };
  const root = childElements(control, 'resources')[0];
  if (!root) return resources;

  for (const code of childElements(root, 'code')) resources.code.push({ path: attr(code, 'path') });
  for (const css of childElements(root, 'css')) resources.css.push({ path: attr(css, 'path') });
  for (const resx of childElements(root, 'resx')) resources.resx.push({ path: attr(resx, 'path') });
  for (const img of childElements(root, 'img')) resources.img.push({ path: attr(img, 'path') });
  for (const lib of childElements(root, 'platform-library')) {
    resources.platformLibraries.push({ name: attr(lib, 'name'), version: attr(lib, 'version') });
  }
  for (const dep of childElements(root, 'dependency')) {
    resources.dependencies.push({ type: attr(dep, 'type'), name: attr(dep, 'name') });
  }
  return resources;
}

function readFeatures(control) {
  const usage = childElements(control, 'feature-usage')[0];
  if (!usage) return [];
  return childElements(usage, 'uses-feature').map((feature) => ({
    name: attr(feature, 'name'),
    required: attr(feature, 'required') === 'true',
  }));
}

function readExternalServiceUsage(control) {
  const usage = childElements(control, 'external-service-usage')[0];
  if (!usage) return null;
  return {
    enabled: attr(usage, 'enabled') === 'true',
    domains: childElements(usage, 'domain').map(textOf).filter(Boolean),
  };
}

function lintManifest(model, { hosts = ['model'], matrix = loadMatrix() } = {}) {
  const errors = [];
  const warnings = [];
  const add = (item) => (item.severity === 'warning' ? warnings : errors).push(completeFinding(item));

  lintControl(model, add);
  lintResources(model, matrix, hosts, add);
  lintProperties(model, matrix, hosts, add);
  lintDataSets(model, matrix, hosts, add);
  lintFeatures(model, hosts, matrix, add);
  lintPages(model, hosts, matrix, add);
  lintExternalServices(model, add);

  return { ok: errors.length === 0, errors, warnings };
}

function completeFinding(item) {
  if (item.fix) return item;
  return {
    ...item,
    fix: defaultFix(item.code),
  };
}

function defaultFix(code) {
  return `Fix the ${code} condition in the PCF manifest. See ${MANIFEST_REFERENCE}`;
}

function lintControl(model, add) {
  const required = [
    ['namespace', 'namespace'],
    ['constructor', 'constructor'],
    ['version', 'version'],
    ['displayNameKey', 'display-name-key'],
    ['descriptionKey', 'description-key'],
  ];
  for (const [field, attrName] of required) {
    if (!model.control[field]) {
      add(finding('PCF_ATTR_MISSING', 'error', `The control is missing required attribute '${attrName}'.`, `Add '${attrName}' to the <control> element. See ${MANIFEST_REFERENCE}`));
    }
  }

  if (model.control.version) {
    const versionError = validateVersion(model.control.version);
    if (versionError) {
      add(finding('PCF_VERSION_FORMAT', 'error', `The control version '${model.control.version}' is invalid: ${versionError}`, 'Use a three-part numeric version such as 1.0.0.'));
    }
  }

  for (const [field, attrName] of [['displayNameKey', 'display-name-key'], ['descriptionKey', 'description-key']]) {
    if (String(model.control[field] || '').includes("'")) {
      add(finding('PCF_KEY_APOSTROPHE', 'warning', `The ${attrName} value contains an apostrophe that can break resource-key lookup.`, `Rename ${attrName} to a resource key without apostrophes.`));
    }
  }
}

function lintResources(model, matrix, hosts, add) {
  if (model.resources.code.length !== 1) {
    add(finding('PCF_CODE_RESOURCE', 'error', `The manifest declares ${model.resources.code.length} <code> resources.`, 'Declare exactly one <code path="index.ts" /> resource.'));
  }

  if (model.control.controlType === 'virtual' && !model.resources.platformLibraries.some((lib) => lib.name === 'React')) {
    add(finding('PCF_VIRTUAL_NO_REACT', 'warning', 'The control is virtual but does not declare the React platform library.', 'Add a React platform-library declaration or change control-type to standard.'));
  }

  for (const item of platformLibraryFindings(matrix, model.resources.platformLibraries, hosts)) add(item);
}

function lintProperties(model, matrix, hosts, add) {
  const seen = new Set();
  for (const prop of model.properties) {
    if (prop.name) {
      if (seen.has(prop.name)) {
        add(finding('PCF_PROPERTY_DUPLICATE', 'error', `Property '${prop.name}' is declared more than once.`, `Remove or rename duplicate property '${prop.name}'.`));
      }
      seen.add(prop.name);
    }
    lintPropertyLike(prop, model, matrix, add, 'property');
    if (prop.usage === 'bound' && prop.defaultValue !== undefined) {
      add(finding('PCF_DEFAULT_ON_BOUND', 'error', `Bound property '${prop.name}' declares default-value.`, 'Remove default-value from bound properties; defaults only belong on input properties.'));
    }
  }

  if (hosts.includes('pages')) {
    const policy = hostPolicy(matrix, 'pages');
    for (const prop of model.properties.filter((item) => item.usage === 'bound')) {
      const types = propertyTypes(prop, model);
      if (types.some((type) => !policy.fieldTypes.includes(type))) {
        add(finding('PCF_PAGES_FIELD_TYPE', 'error', `Power Pages does not document bound field property type '${types.join(', ')}'.`, `Use a Power Pages-supported field type such as ${policy.fieldTypes.slice(0, 3).join(', ')}.`));
      }
    }
  }
}

function lintPropertyLike(prop, model, matrix, add, label) {
  const codePrefix = label === 'property-set' ? 'PCF_PROPERTYSET' : 'PCF_PROPERTY';
  if (!PROPERTY_USAGES.has(prop.usage)) {
    add(finding(`${codePrefix}_USAGE`, 'error', `The ${label} '${prop.name || '(unnamed)'}' has invalid usage '${prop.usage}'.`, `Set usage to one of ${[...PROPERTY_USAGES].join(', ')}.`));
  }
  if (!prop.ofType && !prop.ofTypeGroup) {
    add(finding('PCF_PROPERTY_TYPE_MISSING', 'error', `The ${label} '${prop.name || '(unnamed)'}' has no of-type or of-type-group.`, 'Declare exactly one property type with of-type or reference a declared type-group.'));
  }
  if (prop.ofTypeGroup && !Object.hasOwn(model.typeGroups, prop.ofTypeGroup)) {
    add(finding('PCF_TYPE_GROUP_UNKNOWN', 'error', `The ${label} '${prop.name || '(unnamed)'}' references unknown type-group '${prop.ofTypeGroup}'.`, `Add a <type-group name="${prop.ofTypeGroup}"> declaration or change the property to a known group.`));
  }
  for (const type of propertyTypes(prop, model)) {
    if ((matrix.unsupportedPropertyTypes || []).includes(type)) {
      add(finding('PCF_TYPE_UNSUPPORTED', 'error', `The ${label} '${prop.name || '(unnamed)'}' uses unsupported type '${type}'.`, `Use a supported manifest type instead of '${type}'.`));
    }
    if (type === 'Object' && prop.usage !== 'output') {
      add(finding('PCF_OBJECT_NOT_OUTPUT', 'error', `Object ${label} '${prop.name || '(unnamed)'}' is not output-only.`, 'Set usage="output" for Object properties or use a concrete input/bound type.'));
    }
  }
}

function propertyTypes(prop, model) {
  if (prop.ofType) return [prop.ofType];
  if (prop.ofTypeGroup && Object.hasOwn(model.typeGroups, prop.ofTypeGroup)) return model.typeGroups[prop.ofTypeGroup];
  return [];
}

function lintDataSets(model, matrix, hosts, add) {
  for (const dataSet of model.dataSets) {
    if (dataSet.propertySets.length === 0) {
      add(finding('PCF_DATASET_NO_PROPERTYSET', 'warning', `Dataset '${dataSet.name || '(unnamed)'}' has no property-set declarations.`, 'Add at least one property-set when dataset columns are required by the control.'));
    }
    for (const propertySet of dataSet.propertySets) {
      lintPropertyLike(propertySet, model, matrix, add, 'property-set');
    }
  }

  if (hosts.includes('pages') && model.dataSets.some((dataSet) => dataSet.propertySets.length > 0)) {
    add(finding('PCF_PAGES_DATASET_TYPES', 'warning', 'Power Pages dataset column type behavior is not fully documented.', 'Guard dataset column assumptions and verify the component in the target Power Pages site.'));
  }
}

function lintFeatures(model, hosts, matrix, add) {
  const seen = new Set();
  for (const feature of model.features) {
    if (!feature.name) continue;
    if (seen.has(feature.name)) {
      add(finding('PCF_FEATURE_DUPLICATE', 'error', `Feature '${feature.name}' is declared more than once.`, `Remove the duplicate '${feature.name}' uses-feature declaration.`));
    }
    seen.add(feature.name);
  }

  if (!hosts.includes('pages')) return;
  const policy = hostPolicy(matrix, 'pages');
  for (const feature of model.features) {
    if (feature.required) {
      add(finding('PCF_PAGES_REQUIRED_FEATURE', 'error', `Power Pages does not support required feature '${feature.name}'.`, 'Remove required="true" for Power Pages targets and guard feature use at runtime.'));
    } else if (policy.unsupportedFeatures.includes(feature.name)) {
      add(finding('PCF_PAGES_FEATURE_OPTIONAL', 'warning', `Power Pages may not provide optional feature '${feature.name}'.`, `Guard calls to '${feature.name}' and provide a fallback when targeting Power Pages.`));
    }
  }
}

function lintPages(model, hosts, matrix, add) {
  if (!hosts.includes('pages')) return;
  const policy = hostPolicy(matrix, 'pages');
  if (!policy.controlTypes.includes(model.control.controlType)) {
    add(finding('PCF_PAGES_VIRTUAL', 'error', `Power Pages does not support '${model.control.controlType}' PCF controls.`, 'Use control-type="standard" for Power Pages or target model-driven apps only.'));
  }
  if (model.events.length > 0) {
    add(finding('PCF_PAGES_EVENTS', 'warning', 'Power Pages event support for PCF manifest events is limited.', 'Verify each event in Power Pages and guard behavior when the event is not raised.'));
  }
}

function lintExternalServices(model, add) {
  if (model.externalServiceUsage && model.externalServiceUsage.enabled) {
    add(finding('PCF_EXTERNAL_SERVICE', 'warning', 'The control declares external service usage and may be treated as premium.', 'Remove unnecessary domains or document the external-service usage for makers.'));
  }
}

function diffManifests(before, after) {
  const breaking = [];
  const compatible = [];

  if (before.control.namespace !== after.control.namespace || before.control.constructor !== after.control.constructor) {
    breaking.push(finding('PCF_DIFF_IDENTITY_CHANGED', 'error', 'The control namespace or constructor changed.', 'Keep the same namespace and constructor for upgrades, or ship a new control identity.'));
  }
  if (before.control.controlType !== after.control.controlType) {
    breaking.push(finding('PCF_DIFF_CONTROL_TYPE_CHANGED', 'error', 'The control type changed.', 'Keep the existing control-type for compatible upgrades.'));
  }

  diffPropertyContracts(before.properties, after.properties, before, after, breaking);
  const afterDataSets = new Map(after.dataSets.map((dataSet) => [dataSet.name, dataSet]));
  // Bindings name both <data-set name="rows"> and its <property-set name="column">. Scope column
  // identities to that dataset and reuse the property type/usage/required checks rather than compare
  // only the top-level properties. See: https://learn.microsoft.com/en-us/power-apps/developer/component-framework/manifest-schema-reference/property-set
  for (const beforeDataSet of before.dataSets) {
    const name = beforeDataSet.name;
    const afterDataSet = afterDataSets.get(name);
    if (!afterDataSet) {
      breaking.push(finding('PCF_DIFF_PROPERTY_REMOVED', 'error', `Dataset '${name}' was removed.`, `Keep dataset '${name}' or release a new major control identity.`));
      continue;
    }
    diffPropertyContracts(beforeDataSet.propertySets, afterDataSet.propertySets, before, after, breaking, {
      label: 'Property-set', scope: name, addedRequired: true,
    });
  }

  const versionComparison = compareVersions(after.control.version || '0.0.0', before.control.version || '0.0.0');
  if ((hasMeaningfulChange(before, after) && versionComparison <= 0) || versionComparison < 0) {
    compatible.push(finding('PCF_DIFF_VERSION_NOT_BUMPED', 'warning', 'The manifest changed but the version did not increase.', 'Increase the control version when changing the manifest.'));
  }

  return { breaking, compatible };
}

function diffPropertyContracts(beforeProperties, afterProperties, before, after, breaking, { label = 'Property', scope = '', addedRequired = false } = {}) {
  const beforeByName = new Map(beforeProperties.map((prop) => [prop.name, prop]));
  const afterByName = new Map(afterProperties.map((prop) => [prop.name, prop]));
  const displayName = (name) => scope ? `${scope}.${name}` : name;
  for (const [name, beforeProp] of beforeByName) {
    const qualifiedName = displayName(name);
    const contract = `${label} '${qualifiedName}'`;
    const afterProp = afterByName.get(name);
    if (!afterProp) {
      breaking.push(finding('PCF_DIFF_PROPERTY_REMOVED', 'error', `${contract} was removed.`, `Keep '${qualifiedName}' or release a new major control identity.`));
      continue;
    }
    const removedTypes = removedPropertyTypes(beforeProp, before, afterProp, after);
    if (removedTypes.length > 0) {
      breaking.push(finding('PCF_DIFF_TYPE_CHANGED', 'error', `${contract} removed previously supported type(s): ${removedTypes.join(', ')}.`, `Keep '${qualifiedName}' compatible with ${propertyTypes(beforeProp, before).join(', ')} or add a new property.`));
    }
    if (beforeProp.usage !== afterProp.usage) {
      breaking.push(finding('PCF_DIFF_USAGE_CHANGED', 'error', `${contract} changed usage from '${beforeProp.usage}' to '${afterProp.usage}'.`, `Keep ${label.toLowerCase()} usage stable for existing controls.`));
    }
    if (!beforeProp.required && afterProp.required) {
      breaking.push(finding('PCF_DIFF_REQUIRED_ADDED', 'error', `${contract} became required.`, `Keep '${qualifiedName}' optional or add a new optional property.`));
    }
  }
  if (addedRequired) {
    for (const [name, prop] of afterByName) {
      if (!beforeByName.has(name) && prop.required) {
        breaking.push(finding('PCF_DIFF_REQUIRED_ADDED', 'error', `${label} '${displayName(name)}' was added as required.`, 'Add new property-sets as optional so existing dataset bindings remain valid.'));
      }
    }
  }
}

function typeKey(prop) {
  return prop.ofType || `group:${prop.ofTypeGroup || ''}`;
}

function removedPropertyTypes(beforeProp, beforeModel, afterProp, afterModel) {
  const beforeTypes = new Set(propertyTypes(beforeProp, beforeModel));
  const afterTypes = new Set(propertyTypes(afterProp, afterModel));
  return [...beforeTypes].filter((type) => !afterTypes.has(type));
}

function hasMeaningfulChange(before, after) {
  const normalize = (model) => JSON.stringify({
    control: { ...model.control, version: undefined },
    properties: model.properties,
    typeGroups: model.typeGroups,
    dataSets: model.dataSets,
    resources: model.resources,
    features: model.features,
    externalServiceUsage: model.externalServiceUsage,
    events: model.events,
  });
  return normalize(before) !== normalize(after);
}

function findManifests(projectDir, deps = {}) {
  const readFs = deps.fs || fs;
  const pathApi = deps.path || path;
  const out = [];

  const walk = (dir) => {
    for (const entry of readFs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(pathApi.join(dir, entry.name));
      } else if (entry.isFile() && entry.name === 'ControlManifest.Input.xml') {
        out.push(pathApi.join(dir, entry.name));
      }
    }
  };

  walk(projectDir);
  return out.sort();
}

module.exports = {
  parseManifest,
  lintManifest,
  diffManifests,
  findManifests,
};
