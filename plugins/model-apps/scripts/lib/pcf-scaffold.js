'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
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

function listRecipes(deps = {}) {
  const root = deps.root || DEFAULT_ROOT;
  const pathDep = deps.path || path;
  return safeReaddir(pathDep.join(root, RECIPES_ROOT), deps)
    .filter((entry) => entry.isDirectory())
    .map((entry) => readJson(pathDep.join(root, RECIPES_ROOT, entry.name, 'recipe.json'), deps))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((item) => ({
      id: item.id,
      title: item.title,
      template: item.template,
      hosts: [...item.hosts],
    }));
}

function renderRecipesTable(deps = {}) {
  const rows = listRecipes(deps);
  const lines = [
    '<!-- pcf-recipes:begin -->',
    '| Recipe | Template | Hosts |',
    '| --- | --- | --- |',
  ];
  if (rows.length === 0) {
    lines.push('| _No recipes yet._ |  |  |');
  } else {
    for (const recipe of rows) {
      lines.push(`| ${recipe.title} (\`${recipe.id}\`) | \`${recipe.template}\` | ${recipe.hosts.join(', ')} |`);
    }
  }
  lines.push('<!-- pcf-recipes:end -->', '');
  return lines.join('\n');
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
    displayName,
    displayNameJson: JSON.stringify(displayName),
    displayNameXml: escapeXml(displayName),
    description,
    descriptionXml: escapeXml(description),
    version: VERSION,
    projectGuid: (deps.projectGuid || crypto.randomUUID)(),
    msbuildPcfVersion: matrix.toolchain.msbuildPcf.version,
  };

  const sharedDir = pathDep.join(root, SHARED_ROOT);
  const tDir = templateDir(root, template.id, pathDep);
  const files = [
    ...renderedTemplateFiles(sharedDir, sharedDir, replacements, deps),
    ...renderedTemplateFiles(tDir, tDir, replacements, deps),
    ...lockFiles(matrix, template.dependencySet || template.controlType, request.name, { ...deps, root }),
  ].sort((a, b) => a.relPath.localeCompare(b.relPath));

  const plan = { files, warnings: [] };
  return request.recipe ? applyRecipeManifest(plan, request.recipe, { ...deps, root, template, hosts }) : plan;
}

function applyRecipeManifest(plan, recipeId, deps = {}) {
  const recipe = listRecipes(deps).find((item) => item.id === recipeId);
  if (!recipe) throw new Error(`Unknown PCF recipe: ${recipeId}`);
  if (deps.template && recipe.template !== deps.template.id) {
    throw new Error(`Recipe ${recipeId} requires template ${recipe.template}.`);
  }
  if (deps.hosts) {
    const incompatible = deps.hosts.filter((host) => !recipe.hosts.includes(host));
    if (incompatible.length) throw new Error(`Recipe ${recipeId} does not support host(s): ${incompatible.join(', ')}`);
  }
  return plan;
}

function hasProjectMarkers(dir, deps = {}) {
  const entries = safeReaddir(dir, deps);
  return entries.some((entry) => entry.name === 'package.json' || entry.name.endsWith('.pcfproj'));
}

function writeScaffold(plan, outDir, deps = {}) {
  const fsDep = deps.fs || fs;
  const pathDep = deps.path || path;
  if (fsDep.existsSync(outDir)) {
    if (safeReaddir(outDir, deps).length > 0) {
      throw new Error(`Output directory '${outDir}' exists and is not empty.`);
    }
    if (hasProjectMarkers(outDir, deps)) {
      throw new Error(`Output directory '${outDir}' already contains a PCF project.`);
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
  applyRecipeManifest,
  renderRecipesTable,
};
