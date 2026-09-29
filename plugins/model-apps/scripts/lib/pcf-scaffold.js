'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseManifest } = require('./pcf-manifest.js');
const { validateNamespace, validateControlName } = require('./pcf-names.js');
const { loadMatrix, dependencySet } = require('./pcf-matrix.js');

const DEFAULT_ROOT = path.join(__dirname, '..', '..');
const TEMPLATE_ROOT = path.join('pcf', 'templates');
const SHARED_ROOT = path.join('pcf', 'shared');
const RECIPES_ROOT = path.join('pcf', 'recipes');
const VERSION = '0.0.1';
const KNOWN_HOSTS = new Set(['model', 'pages']);
const CONTROL_TYPES = new Set(['standard', 'virtual']);
const TEMPLATE_KINDS = new Set(['field', 'dataset']);
const DEPENDENCY_SETS = new Set(['standard', 'virtual']);
const RECIPE_STATUS = new Set(['available', 'planned']);
const PROPERTY_USAGES = new Set(['bound', 'input', 'output']);

function readJson(file, deps = {}) {
  const fsDep = deps.fs || fs;
  return JSON.parse(fsDep.readFileSync(file, 'utf8'));
}

function safeReaddir(dir, deps = {}) {
  const fsDep = deps.fs || fs;
  try {
    return fsDep.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

function templateDir(root, id, pathDep = path) {
  return pathDep.join(root, TEMPLATE_ROOT, id);
}

function readTemplate(root, id, deps = {}) {
  const pathDep = deps.path || path;
  const file = pathDep.join(templateDir(root, id, pathDep), 'template.json');
  return validateTemplate(readJson(file, deps), file);
}

function validateTemplate(template, file) {
  const errors = [];
  const label = path.basename(file);
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    throw new Error(`${label} must be an object`);
  }
  if (typeof template.id !== 'string' || !template.id) errors.push('id must be a non-empty string');
  if (!CONTROL_TYPES.has(template.controlType)) errors.push('controlType must be standard or virtual');
  if (!TEMPLATE_KINDS.has(template.kind)) errors.push('kind must be field or dataset');
  if (!Array.isArray(template.hosts) || template.hosts.some((host) => !KNOWN_HOSTS.has(host))) {
    errors.push('hosts must be an array containing only model and pages');
  }
  if (template.dependencySet !== undefined && !DEPENDENCY_SETS.has(template.dependencySet)) {
    errors.push('dependencySet must be standard or virtual');
  }
  if (errors.length) throw new Error(`${label}: ${errors.join('; ')}`);
  return template;
}


function validateRecipe(recipe, file, deps = {}) {
  const errors = [];
  const label = path.basename(file);
  const expectedId = deps.expectedId || path.basename(path.dirname(file));
  const templates = deps.templates || listTemplates(deps);
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) {
    throw new Error(`${label} must be an object`);
  }

  const status = recipe.status === undefined ? 'available' : recipe.status;
  if (typeof recipe.id !== 'string' || !recipe.id) errors.push('id must be a non-empty string');
  else if (recipe.id !== expectedId) errors.push(`id must equal directory name '${expectedId}'`);
  if (typeof recipe.title !== 'string' || !recipe.title) errors.push('title must be a non-empty string');
  if (typeof recipe.summary !== 'string' || !recipe.summary) errors.push('summary must be a non-empty string');
  if (!RECIPE_STATUS.has(status)) errors.push('status must be available or planned');

  const template = templates.find((item) => item.id === recipe.template);
  if (!template) errors.push('template must be an existing template id');
  if (!Array.isArray(recipe.hosts) || recipe.hosts.length === 0 || recipe.hosts.some((host) => !KNOWN_HOSTS.has(host) || (template && !template.hosts.includes(host)))) {
    errors.push('hosts must be a non-empty array containing only template hosts');
  }
  if (typeof recipe.whyWanted !== 'string' || !recipe.whyWanted) errors.push('whyWanted must be a non-empty string');

  const certified = recipe.certified === undefined ? { model: {}, pages: {} } : recipe.certified;
  validateCertified(certified, errors);

  const overlayFiles = deps.recipeDir ? recipeOverlayFiles(deps.recipeDir, deps) : [];
  if (status === 'planned') {
    if (overlayFiles.length) errors.push('planned recipes must not have overlay files');
  } else if (typeof recipe.configuration !== 'string' || !recipe.configuration) {
    errors.push('configuration must be a non-empty string');
  }

  if (recipe.properties !== undefined) validatePropertyArray(recipe.properties, 'properties', errors);
  const dataSetNames = template && template.kind === 'dataset' ? templateDataSetNames(deps.root || DEFAULT_ROOT, template.id, deps) : new Set();
  if (recipe.propertySets !== undefined) {
    if (template && template.kind !== 'dataset') errors.push('propertySets are only allowed for dataset templates');
    validatePropertySetArray(recipe.propertySets, dataSetNames, errors);
  }
  if (recipe.features !== undefined) validateFeatures(recipe.features, errors);

  if (errors.length) throw new Error(`${label}: ${errors.join('; ')}`);
  return {
    ...recipe,
    status,
    certified: cloneCertified(certified),
    hosts: [...recipe.hosts],
    properties: recipe.properties ? recipe.properties.map((item) => ({ ...item })) : undefined,
    propertySets: recipe.propertySets ? recipe.propertySets.map((item) => ({ ...item })) : undefined,
    features: recipe.features ? recipe.features.map((item) => ({ ...item })) : undefined,
  };
}

function validateCertified(certified, errors) {
  if (!certified || typeof certified !== 'object' || Array.isArray(certified)) {
    errors.push('certified must be an object');
    return;
  }
  for (const host of ['model', 'pages']) {
    const value = certified[host];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`certified.${host} must be an object`);
      continue;
    }
    for (const [journey, date] of Object.entries(value)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) errors.push(`certified.${host}.${journey} must be YYYY-MM-DD`);
    }
  }
}

function validatePropertyArray(items, label, errors) {
  if (!Array.isArray(items)) {
    errors.push(`${label} must be an array`);
    return;
  }
  for (let i = 0; i < items.length; i++) validatePropertyLike(items[i], `${label}[${i}]`, errors);
}

function validatePropertySetArray(items, dataSetNames, errors) {
  if (!Array.isArray(items)) {
    errors.push('propertySets must be an array');
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    validatePropertyLike(item, `propertySets[${i}]`, errors);
    if (!item || typeof item.dataSet !== 'string' || !item.dataSet) errors.push(`propertySets[${i}].dataSet must be a non-empty string`);
    else if (dataSetNames.size > 0 && !dataSetNames.has(item.dataSet)) errors.push(`propertySets[${i}].dataSet must name an existing data-set`);
  }
}

function validatePropertyLike(item, label, errors) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    errors.push(`${label} must be an object`);
    return;
  }
  for (const field of ['name', 'displayNameKey', 'descriptionKey', 'ofType']) {
    if (typeof item[field] !== 'string' || !item[field]) errors.push(`${label}.${field} must be a non-empty string`);
  }
  if (!PROPERTY_USAGES.has(item.usage)) errors.push(`${label}.usage must be bound, input, or output`);
  if (typeof item.required !== 'boolean') errors.push(`${label}.required must be boolean`);
  if (item.defaultValue !== undefined && typeof item.defaultValue !== 'string') errors.push(`${label}.defaultValue must be a string`);
}

function validateFeatures(items, errors) {
  if (!Array.isArray(items)) {
    errors.push('features must be an array');
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`features[${i}] must be an object`);
      continue;
    }
    if (typeof item.name !== 'string' || !item.name) errors.push(`features[${i}].name must be a non-empty string`);
    if (typeof item.required !== 'boolean') errors.push(`features[${i}].required must be boolean`);
  }
}

function templateDataSetNames(root, templateId, deps = {}) {
  const pathDep = deps.path || path;
  const dir = templateDir(root, templateId, pathDep);
  const manifest = walkFiles(dir, deps).find((file) => pathDep.basename(file) === 'ControlManifest.Input.xml.tmpl');
  if (!manifest) return new Set();
  const parsed = parseManifest((deps.fs || fs).readFileSync(manifest, 'utf8'));
  return new Set(parsed.model.dataSets.map((dataSet) => dataSet.name).filter(Boolean));
}

function recipeOverlayFiles(dir, deps = {}) {
  const pathDep = deps.path || path;
  return walkFiles(dir, deps).filter((file) => {
    const rel = pathDep.relative(dir, file);
    return rel !== 'recipe.json' && rel !== 'README.md';
  });
}

function listTemplates(deps = {}) {
  const root = deps.root || DEFAULT_ROOT;
  const pathDep = deps.path || path;
  return safeReaddir(pathDep.join(root, TEMPLATE_ROOT), deps)
    .filter((entry) => entry.isDirectory())
    .map((entry) => readTemplate(root, entry.name, deps))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((item) => ({
      id: item.id,
      controlType: item.controlType,
      kind: item.kind,
      hosts: [...item.hosts],
    }));
}

function recipesRoot(root, deps = {}) {
  const pathDep = deps.path || path;
  return deps.recipesRoot || pathDep.join(root, RECIPES_ROOT);
}

function readRecipe(root, id, deps = {}) {
  const pathDep = deps.path || path;
  const base = recipesRoot(root, deps);
  const file = pathDep.join(base, id, 'recipe.json');
  const templates = listTemplates({ ...deps, root });
  return validateRecipe(readJson(file, deps), file, { ...deps, root, templates, recipeDir: pathDep.join(base, id), expectedId: id });
}

function listRecipes(deps = {}) {
  const root = deps.root || DEFAULT_ROOT;
  const pathDep = deps.path || path;
  const base = recipesRoot(root, deps);
  return safeReaddir(base, deps)
    .filter((entry) => entry.isDirectory())
    .map((entry) => readRecipe(root, entry.name, { ...deps, root, recipesRoot: base }))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((item) => ({
      id: item.id,
      title: item.title,
      template: item.template,
      hosts: [...item.hosts],
      status: item.status,
      certified: cloneCertified(item.certified),
    }));
}

function renderRecipesTable(deps = {}) {
  const rows = listRecipes(deps);
  const lines = [
    '<!-- pcf-recipes:begin -->',
    '| Recipe | Template | Designed for (hosts) | Certified | Status |',
    '| --- | --- | --- | --- | --- |',
  ];
  if (rows.length === 0) {
    lines.push('| _No recipes yet._ |  |  |  |  |');
  } else {
    for (const recipe of rows) {
      lines.push(`| ${recipe.title} (\`${recipe.id}\`) | \`${recipe.template}\` | ${recipe.hosts.join(', ')} | ${renderCertification(recipe)} | ${recipe.status} |`);
    }
  }
  lines.push('<!-- pcf-recipes:end -->', '');
  return lines.join('\n');
}

function renderCertification(recipe) {
  const parts = [];
  for (const host of recipe.hosts) {
    const journeys = recipe.certified && recipe.certified[host] && typeof recipe.certified[host] === 'object'
      ? Object.entries(recipe.certified[host]).sort(([a], [b]) => a.localeCompare(b))
      : [];
    if (journeys.length === 0) {
      parts.push(`${host}: not certified in this release`);
    } else {
      for (const [journey, date] of journeys) parts.push(`${host} ${journey}: ${date}`);
    }
  }
  return parts.join('; ');
}

function cloneCertified(certified) {
  return {
    model: { ...(certified && certified.model ? certified.model : {}) },
    pages: { ...(certified && certified.pages ? certified.pages : {}) },
  };
}

function walkFiles(dir, deps = {}) {
  const pathDep = deps.path || path;
  const files = [];
  const walk = (current) => {
    for (const entry of safeReaddir(current, deps)) {
      const full = pathDep.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        files.push(full);
      }
    }
  };
  walk(dir);
  return files;
}

function applyPlaceholders(value, replacements) {
  return String(value).replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (match, key) => {
    if (!Object.hasOwn(replacements, key)) return match;
    return replacements[key];
  });
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlAttr(value) {
  return escapeXml(value)
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function renderedTemplateFiles(dir, baseDir, replacements, deps = {}) {
  const fsDep = deps.fs || fs;
  const pathDep = deps.path || path;
  const out = [];
  for (const file of walkFiles(dir, deps)) {
    const rel = pathDep.relative(baseDir, file);
    if (rel === 'template.json' || rel === 'package.json.tmpl') continue;
    const renderedRel = applyPlaceholders(rel.replace(/\.tmpl$/, ''), replacements);
    const content = applyPlaceholders(fsDep.readFileSync(file, 'utf8'), replacements);
    out.push({ relPath: renderedRel, content });
  }
  return out;
}

function unsafeRelPathReason(relPath, outDir, pathDep = path) {
  const value = String(relPath || '');
  if (!value) return 'path is empty';
  if (pathDep.isAbsolute(value) || path.win32.isAbsolute(value) || /^[\\/]/.test(value)) {
    return 'path is absolute';
  }
  if (value.split(/[\\/]+/).includes('..')) return 'path contains ..';
  const root = pathDep.resolve(outDir);
  const target = pathDep.resolve(root, value);
  const rootWithSep = root.endsWith(pathDep.sep) ? root : `${root}${pathDep.sep}`;
  const comparableRoot = process.platform === 'win32' ? rootWithSep.toLowerCase() : rootWithSep;
  const comparableTarget = process.platform === 'win32' ? target.toLowerCase() : target;
  if (target !== root && !comparableTarget.startsWith(comparableRoot)) return 'path resolves outside the output directory';
  return null;
}

function assertSafeRelPath(relPath, outDir, deps = {}) {
  const pathDep = deps.path || path;
  const reason = unsafeRelPathReason(relPath, outDir, pathDep);
  if (reason) throw new Error(`unsafe scaffold path '${relPath}': ${reason}`);
}

function normalizeHosts(hosts) {
  const values = Array.isArray(hosts) ? hosts : String(hosts || 'model').split(',');
  const normalized = values.map((host) => String(host).trim()).filter(Boolean);
  for (const host of normalized) {
    if (!KNOWN_HOSTS.has(host)) throw new Error(`Unknown PCF host: ${host}`);
  }
  return normalized.length ? normalized : ['model'];
}

function packageName(name) {
  return String(name).toLowerCase();
}

function lockFiles(matrix, setName, name, deps = {}) {
  const fsDep = deps.fs || fs;
  const pathDep = deps.path || path;
  const set = dependencySet(matrix, setName, deps);
  const packageJson = JSON.parse(fsDep.readFileSync(pathDep.join(set.lockDir, 'package.json'), 'utf8'));
  packageJson.name = packageName(name);
  const lock = JSON.parse(fsDep.readFileSync(pathDep.join(set.lockDir, 'package-lock.json'), 'utf8'));
  lock.name = packageName(name);
  if (lock.packages && lock.packages['']) lock.packages[''].name = packageName(name);
  return [
    { relPath: 'package.json', content: `${JSON.stringify(packageJson, null, 2)}\n` },
    { relPath: 'package-lock.json', content: `${JSON.stringify(lock, null, 2)}\n` },
  ];
}

function validateRequest(request, templates) {
  const namespaceError = validateNamespace(request.namespace, request.name);
  if (namespaceError) throw new Error(namespaceError);
  const nameError = validateControlName(request.name, request.namespace);
  if (nameError) throw new Error(nameError);
  const hosts = normalizeHosts(request.hosts);

  const template = templates.find((item) => item.id === request.template);
  if (!template) {
    // Part A ships only field-standard. This still preserves the public contract that any virtual
    // template must fail before Pages scaffolding can proceed, even while those templates land later.
    if (hosts.includes('pages') && String(request.template).includes('virtual')) {
      throw new Error('Power Pages does not support virtual PCF controls.');
    }
    throw new Error(`Unknown PCF template: ${request.template}`);
  }
  if (hosts.includes('pages') && template.controlType === 'virtual') {
    throw new Error('Power Pages does not support virtual PCF controls.');
  }
  for (const host of hosts) {
    if (!template.hosts.includes(host)) throw new Error(`Template ${template.id} does not support host '${host}'.`);
  }
  return { template, hosts };
}

function planScaffold(request, deps = {}) {
  const root = deps.root || DEFAULT_ROOT;
  const pathDep = deps.path || path;
  const matrix = deps.matrix || loadMatrix({ ...deps, root });
  const templates = listTemplates({ ...deps, root });
  const { template, hosts } = validateRequest({ hosts: ['model'], ...request }, templates);
  const displayName = request.displayName || request.name;
  const description = request.description || `${displayName} PCF control.`;
  const replacements = {
    namespace: request.namespace,
    name: request.name,
    nameLower: packageName(request.name),
    cssClass: `${packageName(request.name)}-control`,
    cssInputClass: `${packageName(request.name)}-input`,
    cssMessageClass: `${packageName(request.name)}-message`,
    template: template.id,
    displayName,
    displayNameJson: JSON.stringify(displayName),
    displayNameXml: escapeXml(displayName),
    description,
    descriptionXml: escapeXml(description),
    version: VERSION,
    projectGuid: (deps.projectGuid || crypto.randomUUID)(),
    msbuildPcfVersion: matrix.toolchain.msbuildPcf.version,
    reactPlatformVersion: matrix.platformLibraries.React.recommendedBaseline.version,
    fluentPlatformVersion: matrix.platformLibraries.Fluent.recommendedBaseline.version,
  };

  const sharedDir = pathDep.join(root, SHARED_ROOT);
  const tDir = templateDir(root, template.id, pathDep);
  const files = [
    ...renderedTemplateFiles(sharedDir, sharedDir, replacements, deps),
    ...renderedTemplateFiles(tDir, tDir, replacements, deps),
    ...lockFiles(matrix, template.dependencySet || template.controlType, request.name, { ...deps, root }),
  ].sort((a, b) => a.relPath.localeCompare(b.relPath));

  const plan = { files, warnings: [] };
  return request.recipe ? applyRecipe(plan, request.recipe, { ...deps, root, template, hosts, recipesRoot: request.recipesRoot || deps.recipesRoot, replacements }) : plan;
}

function applyRecipe(plan, recipeId, deps = {}) {
  const root = deps.root || DEFAULT_ROOT;
  const pathDep = deps.path || path;
  const recipe = readRecipe(root, recipeId, deps);
  if (recipe.status === 'planned') throw new Error(`Recipe ${recipeId} is planned, not available in this release.`);
  if (deps.template && recipe.template !== deps.template.id) {
    throw new Error(`Recipe ${recipeId} requires template ${recipe.template}.`);
  }
  if (deps.hosts) {
    const incompatible = deps.hosts.filter((host) => !recipe.hosts.includes(host));
    if (incompatible.length) throw new Error(`Recipe ${recipeId} does not support host(s): ${incompatible.join(', ')}`);
  }

  const replacements = deps.replacements || {};
  const recipeDir = pathDep.join(recipesRoot(root, deps), recipeId);
  const overlaid = new Map(plan.files.map((file) => [file.relPath, { ...file }]));
  for (const file of recipeOverlayFiles(recipeDir, deps)) {
    const rel = pathDep.relative(recipeDir, file);
    const renderedRel = applyPlaceholders(rel.replace(/\.tmpl$/, ''), replacements);
    assertSafeRelPath(renderedRel, root, deps);
    overlaid.set(renderedRel, {
      relPath: renderedRel,
      content: applyPlaceholders((deps.fs || fs).readFileSync(file, 'utf8'), replacements),
    });
  }

  const manifestRel = pathDep.join(replacements.name || '', 'ControlManifest.Input.xml');
  const manifest = overlaid.get(manifestRel);
  if (!manifest) throw new Error(`Recipe ${recipeId} could not find rendered ControlManifest.Input.xml.`);
  manifest.content = applyRecipeManifest(manifest.content, recipe);
  overlaid.set(manifestRel, manifest);

  return {
    ...plan,
    recipe: { id: recipe.id, title: recipe.title, status: recipe.status },
    files: [...overlaid.values()].sort((a, b) => a.relPath.localeCompare(b.relPath)),
  };
}

// Recipe patches intentionally operate on the rendered manifest text rather than reserializing
// the XML tree. The contract is byte-preserving outside these overlay-owned elements, e.g. a
// template-owned `<property name="sampleProperty" ... />` is replaced by the recipe's complete
// `<property ... />` surface while comments, resource ordering, and whitespace elsewhere remain
// unchanged.
function applyRecipeManifest(xmlText, recipe) {
  let out = String(xmlText);
  if (recipe.properties !== undefined) out = replaceControlChildren(out, 'property', renderProperties(recipe.properties));
  if (recipe.propertySets !== undefined) {
    const byDataSet = new Map();
    for (const item of recipe.propertySets) {
      if (!byDataSet.has(item.dataSet)) byDataSet.set(item.dataSet, []);
      byDataSet.get(item.dataSet).push(item);
    }
    for (const [dataSetName, sets] of byDataSet) out = replaceDataSetPropertySets(out, dataSetName, renderPropertySets(sets));
  }
  if (recipe.features !== undefined) out = replaceFeatureUsage(out, recipe.features);
  return out;
}

// PCF manifest attributes are always quoted XML attributes, e.g.
//   before: <property name="sampleProperty" ... required="true" />
//   after:  <property name="rating" ... default-value="5" />
// Escape as attributes (including quotes/apostrophes), not text nodes, because display keys and
// defaults are emitted directly into tag attributes.
function renderProperties(properties) {
  return properties.map((prop) => {
    const attrs = [
      ['name', prop.name],
      ['display-name-key', prop.displayNameKey],
      ['description-key', prop.descriptionKey],
      ['of-type', prop.ofType],
      ['usage', prop.usage],
      ['required', String(prop.required)],
    ];
    if (prop.defaultValue !== undefined) attrs.push(['default-value', prop.defaultValue]);
    return `<property ${attrs.map(([key, value]) => `${key}="${escapeXmlAttr(value)}"`).join(' ')} />`;
  });
}

function renderPropertySets(propertySets) {
  return propertySets.map((prop) => `<property-set ${[
    ['name', prop.name],
    ['display-name-key', prop.displayNameKey],
    ['description-key', prop.descriptionKey],
    ['of-type', prop.ofType],
    ['usage', prop.usage],
    ['required', String(prop.required)],
  ].map(([key, value]) => `${key}="${escapeXmlAttr(value)}"`).join(' ')} />`);
}

function renderFeatureUsage(features, indent) {
  if (!features.length) return [];
  const childIndent = `${indent}  `;
  return [
    `${indent}<feature-usage>`,
    ...features.map((feature) => `${childIndent}<uses-feature name="${escapeXmlAttr(feature.name)}" required="${escapeXmlAttr(String(feature.required))}" />`),
    `${indent}</feature-usage>`,
  ];
}

function replaceControlChildren(xmlText, childName, renderedChildren) {
  const control = findElementSpan(xmlText, 'control');
  if (!control) throw new Error('Manifest does not contain a <control> element.');
  const ranges = immediateChildRanges(xmlText, control.innerStart, control.innerEnd, childName);
  const indent = ranges.length ? leadingWhitespace(xmlText, ranges[0].start) : childIndent(xmlText, control.innerStart, control.innerEnd);
  return replaceRangesOrInsert(xmlText, ranges, renderedChildren.map((line) => `${indent}${line}`), control.innerStart, control.innerEnd, indent);
}

// Dataset recipes route their property-set declarations through recipe.json's dataSet field:
//   <data-set name="sampleDataSet">
//     <property-set name="sampleProperty" ... />
//   </data-set>
// Only the matching data-set's direct property-set children are replaced, so other data-set
// declarations (and their formatting) remain template-owned.
function replaceDataSetPropertySets(xmlText, dataSetName, renderedChildren) {
  const control = findElementSpan(xmlText, 'control');
  if (!control) throw new Error('Manifest does not contain a <control> element.');
  const dataSet = immediateChildRanges(xmlText, control.innerStart, control.innerEnd, 'data-set')
    .map((range) => ({ ...range, attrs: attrsFromTag(xmlText.slice(range.start, range.openEnd)) }))
    .find((range) => range.attrs.name === dataSetName);
  if (!dataSet) throw new Error(`Recipe propertySets target unknown data-set '${dataSetName}'.`);
  const ranges = immediateChildRanges(xmlText, dataSet.innerStart, dataSet.innerEnd, 'property-set');
  const indent = ranges.length ? leadingWhitespace(xmlText, ranges[0].start) : childIndent(xmlText, dataSet.innerStart, dataSet.innerEnd);
  return replaceRangesOrInsert(xmlText, ranges, renderedChildren.map((line) => `${indent}${line}`), dataSet.innerStart, dataSet.innerEnd, indent);
}

// pcf-scripts rejects an empty <feature-usage> in production builds, so a recipe with no
// features removes any existing block instead of leaving:
//   <feature-usage>
//   </feature-usage>
// Feature-owning recipes get a concrete block of <uses-feature name="..." required="..." />
// entries inserted next to the template's feature marker comment.
function replaceFeatureUsage(xmlText, features) {
  const control = findElementSpan(xmlText, 'control');
  if (!control) throw new Error('Manifest does not contain a <control> element.');
  const ranges = immediateChildRanges(xmlText, control.innerStart, control.innerEnd, 'feature-usage');
  const indent = ranges.length ? leadingWhitespace(xmlText, ranges[0].start) : childIndent(xmlText, control.innerStart, control.innerEnd);
  const replacement = renderFeatureUsage(features, indent);
  if (ranges.length || replacement.length === 0) return replaceRangesOrInsert(xmlText, ranges, replacement, control.innerStart, control.innerEnd, indent);

  const marker = '<!-- Features are declared only when this control';
  const markerAt = xmlText.indexOf(marker, control.innerStart);
  if (markerAt !== -1 && markerAt < control.innerEnd) {
    const lineStart = xmlText.lastIndexOf('\n', markerAt) + 1;
    return `${xmlText.slice(0, lineStart)}${replacement.join('\n')}\n${xmlText.slice(lineStart)}`;
  }
  const insertAt = xmlText.lastIndexOf('\n', control.innerEnd) + 1;
  return `${xmlText.slice(0, insertAt)}${replacement.join('\n')}\n${xmlText.slice(insertAt)}`;
}

function replaceRangesOrInsert(xmlText, ranges, replacementLines, innerStart, innerEnd, indent) {
  const replacement = replacementLines.length ? `${replacementLines.join('\n')}\n` : '';
  if (ranges.length) {
    const adjusted = ranges.map((range) => lineRange(xmlText, range));
    let out = xmlText;
    for (let i = adjusted.length - 1; i >= 1; i--) out = out.slice(0, adjusted[i].start) + out.slice(adjusted[i].end);
    return out.slice(0, adjusted[0].start) + replacement + out.slice(adjusted[0].end);
  }
  if (!replacement) return xmlText;
  const insertAt = insertionPoint(xmlText, innerStart, innerEnd);
  const prefix = xmlText.slice(0, insertAt).endsWith('\n') ? '' : '\n';
  return `${xmlText.slice(0, insertAt)}${prefix}${replacement}${xmlText.slice(insertAt)}`;
}

function lineRange(xmlText, range) {
  const lineStart = xmlText.lastIndexOf('\n', range.start) + 1;
  const start = /^[ \t]*$/.test(xmlText.slice(lineStart, range.start)) ? lineStart : range.start;
  let end = range.end;
  if (xmlText.startsWith('\r\n', end)) end += 2;
  else if (xmlText[end] === '\n') end += 1;
  return { start, end };
}

function insertionPoint(xmlText, innerStart, innerEnd) {
  const resources = xmlText.indexOf('<resources', innerStart);
  if (resources !== -1 && resources < innerEnd) return xmlText.lastIndexOf('\n', resources) + 1;
  return xmlText.lastIndexOf('\n', innerEnd) + 1;
}

function childIndent(xmlText, innerStart, innerEnd) {
  const match = xmlText.slice(innerStart, innerEnd).match(/\n([ \t]+)<[^/!??]/);
  return match ? match[1] : '  ';
}

function leadingWhitespace(xmlText, offset) {
  const lineStart = xmlText.lastIndexOf('\n', offset) + 1;
  const raw = xmlText.slice(lineStart, offset);
  return /^[ \t]*$/.test(raw) ? raw : '';
}

function attrsFromTag(tagText) {
  const attrs = {};
  tagText.replace(/\s([A-Za-z_:][\w:.-]*)\s*=\s*(['"])(.*?)\2/g, (_m, key, _quote, value) => {
    attrs[key] = value;
    return _m;
  });
  return attrs;
}

function findElementSpan(xmlText, name, start = 0) {
  const tagRe = new RegExp(`<(/?)${escapeRegExp(name)}\\b[^>]*>`, 'g');
  tagRe.lastIndex = start;
  const first = tagRe.exec(xmlText);
  if (!first || first[1]) return null;
  let depth = selfClosingTag(first[0]) ? 0 : 1;
  if (depth === 0) return { start: first.index, openEnd: tagRe.lastIndex, innerStart: tagRe.lastIndex, innerEnd: tagRe.lastIndex, end: tagRe.lastIndex };
  let match;
  while ((match = tagRe.exec(xmlText))) {
    if (match[1]) depth--;
    else if (!selfClosingTag(match[0])) depth++;
    if (depth === 0) return { start: first.index, openEnd: first.index + first[0].length, innerStart: first.index + first[0].length, innerEnd: match.index, end: tagRe.lastIndex };
  }
  return null;
}

function immediateChildRanges(xmlText, innerStart, innerEnd, name) {
  const out = [];
  const tagRe = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(![^>]*|\/?[A-Za-z_:][\w:.-]*\b[^>]*)>/g;
  tagRe.lastIndex = innerStart;
  let depth = 0;
  let match;
  while ((match = tagRe.exec(xmlText)) && match.index < innerEnd) {
    const tag = match[0];
    const body = match[1] || '';
    if (tag.startsWith('<!--') || tag.startsWith('<?') || tag.startsWith('<!')) continue;
    const closing = body.startsWith('/');
    const tagName = body.replace(/^\//, '').split(/\s|\//, 1)[0];
    if (closing) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && tagName === name) {
      const span = findElementSpan(xmlText, name, match.index);
      if (span) {
        out.push(span);
        tagRe.lastIndex = span.end;
        continue;
      }
    }
    if (!selfClosingTag(tag)) depth++;
  }
  return out;
}

function selfClosingTag(tag) {
  return /\/\s*>$/.test(tag);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasProjectMarkers(dir, deps = {}) {
  const entries = safeReaddir(dir, deps);
  return entries.some((entry) => entry.name === 'package.json' || entry.name.endsWith('.pcfproj'));
}

function writeScaffold(plan, outDir, deps = {}) {
  const fsDep = deps.fs || fs;
  const pathDep = deps.path || path;
  for (const file of plan.files) {
    assertSafeRelPath(file.relPath, outDir, deps);
  }
  if (fsDep.existsSync(outDir)) {
    if (hasProjectMarkers(outDir, deps)) {
      throw new Error(`Output directory '${outDir}' already contains a PCF project.`);
    }
    if (safeReaddir(outDir, deps).length > 0) {
      throw new Error(`Output directory '${outDir}' exists and is not empty.`);
    }
  } else {
    fsDep.mkdirSync(outDir, { recursive: true });
  }

  const written = [];
  for (const file of plan.files) {
    const target = pathDep.join(outDir, file.relPath);
    fsDep.mkdirSync(pathDep.dirname(target), { recursive: true });
    fsDep.writeFileSync(target, file.content);
    written.push(target);
  }
  return { written };
}

module.exports = {
  listTemplates,
  listRecipes,
  planScaffold,
  writeScaffold,
  applyRecipe,
  applyRecipeManifest,
  renderRecipesTable,
};
