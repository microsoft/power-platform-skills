'use strict';

const { validateNamespace, validateControlName, validatePublisherPrefix } = require('./pcf-names.js');
const { listTemplates, listRecipes } = require('./pcf-scaffold.js');

const HOSTS = new Set(['model', 'pages']);
const CONNECTIVITY = new Set(['online']);
const PROPERTY_USAGES = new Set(['bound', 'input', 'output']);
const BINDING_KINDS = new Set(['field', 'dataset-subgrid', 'grid-customizer']);
const CLIENTS = new Set(['web', 'phone', 'tablet']);
const FORM_TYPES = new Set(['main', 'quick-create', 'card', 'other']);
const JOURNEYS = new Set(['form-field', 'list']);
const GRID_CUSTOMIZER_EVENT_PROPERTY = 'EventName';

function finding(code, severity, message, fix) {
  return { code, severity, message, fix };
}

function validateIntent(intent) {
  const errors = [];
  const root = asObject(intent, 'intent', errors);
  if (!root) return errors;

  if (root.schemaVersion !== 1) errors.push('schemaVersion must be 1.');
  validateControl(root.control, errors);
  validateStringArray(root.hosts, 'hosts', HOSTS, errors);
  if (!CONNECTIVITY.has(root.connectivity)) errors.push('connectivity must be online.');
  validateProperties(root.properties, errors);
  validateDeploy(root.deploy, errors);
  validateBindings(root.bindings, errors);
  validatePages(root.pages, errors);
  if (root.features !== undefined && !Array.isArray(root.features)) errors.push('features must be an array.');
  return errors;
}

function asObject(value, pathName, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${pathName} must be an object.`);
    return null;
  }
  return value;
}

function validateControl(control, errors) {
  const c = asObject(control, 'control', errors);
  if (!c) return;
  if (typeof c.namespace !== 'string' || !c.namespace) {
    errors.push('control.namespace is required.');
  } else {
    const err = validateNamespace(c.namespace, c.name);
    if (err) errors.push(`control.namespace is invalid: ${err}`);
  }
  if (typeof c.name !== 'string' || !c.name) {
    errors.push('control.name is required.');
  } else {
    const err = validateControlName(c.name, c.namespace);
    if (err) errors.push(`control.name is invalid: ${err}`);
  }
  for (const key of ['displayName', 'description']) {
    if (typeof c[key] !== 'string' || !c[key].trim()) errors.push(`control.${key} is required.`);
  }

  const templates = safeListTemplates();
  if (typeof c.template !== 'string' || !c.template) {
    errors.push('control.template is required.');
  } else if (!templates.some((item) => item.id === c.template)) {
    errors.push(`control.template '${c.template}' is unknown; choose one of: ${templates.map((item) => item.id).join(', ')}.`);
  }

  if (c.recipe !== undefined) {
    if (typeof c.recipe !== 'string' || !c.recipe) {
      errors.push('control.recipe must be a non-empty string when supplied.');
    } else {
      const recipes = safeListRecipes();
      if (recipes.length === 0) {
        errors.push('control.recipe is not supported: no recipes are available in this release; omit `recipe`.');
      } else if (!recipes.some((item) => item.id === c.recipe)) {
        errors.push(`control.recipe '${c.recipe}' is unknown; choose one of: ${recipes.map((item) => item.id).join(', ')}.`);
      }
    }
  }
}

function safeListTemplates() {
  try {
    return listTemplates();
  } catch {
    return [];
  }
}

function safeListRecipes() {
  try {
    return listRecipes();
  } catch {
    return [];
  }
}

function validateStringArray(value, pathName, allowed, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${pathName} must be a non-empty array.`);
    return;
  }
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || !allowed.has(item)) {
      errors.push(`${pathName}[${index}] must be one of: ${Array.from(allowed).join(', ')}.`);
    }
  }
}

function validateProperties(properties, errors) {
  if (!Array.isArray(properties) || properties.length === 0) {
    errors.push('properties must be a non-empty array.');
    return;
  }
  const seen = new Set();
  for (const [index, prop] of properties.entries()) {
    const p = asObject(prop, `properties[${index}]`, errors);
    if (!p) continue;
    if (typeof p.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(p.name)) {
      errors.push(`properties[${index}].name must start with a letter and contain only letters, digits, or underscore.`);
    } else if (seen.has(p.name)) {
      errors.push(`properties[${index}].name '${p.name}' is duplicated.`);
    } else {
      seen.add(p.name);
    }
    if (!PROPERTY_USAGES.has(p.usage)) errors.push(`properties[${index}].usage must be one of: ${Array.from(PROPERTY_USAGES).join(', ')}.`);
    if (typeof p.type !== 'string' || !p.type) errors.push(`properties[${index}].type is required.`);
    if (typeof p.required !== 'boolean') errors.push(`properties[${index}].required must be a boolean.`);
    if (p.default !== undefined && typeof p.default !== 'string') errors.push(`properties[${index}].default must be a string when supplied.`);
  }
}

function validateDeploy(deploy, errors) {
  const d = asObject(deploy, 'deploy', errors);
  if (!d) return;
  if (typeof d.solution !== 'string' || !d.solution.trim()) errors.push('deploy.solution is required.');
  if (d.publisherPrefix !== null && d.publisherPrefix !== undefined) {
    if (typeof d.publisherPrefix !== 'string' || !d.publisherPrefix) {
      errors.push('deploy.publisherPrefix must be null or a non-empty string.');
    } else {
      const err = validatePublisherPrefix(d.publisherPrefix);
      if (err) errors.push(`deploy.publisherPrefix is invalid: ${err}`);
    }
  }
  if (d.environment !== undefined && (typeof d.environment !== 'string' || !d.environment.trim())) {
    errors.push('deploy.environment must be a non-empty string when supplied.');
  }
}

function validateBindings(bindings, errors) {
  if (bindings === undefined) return;
  if (!Array.isArray(bindings)) {
    errors.push('bindings must be an array.');
    return;
  }
  for (const [index, binding] of bindings.entries()) {
    validateBinding(binding, index, errors);
  }
}

function validateBinding(binding, index, errors) {
  const b = asObject(binding, `bindings[${index}]`, errors);
  if (!b) return;
  if (b.kind === undefined) {
    errors.push(`bindings[${index}].kind is required and must be one of: ${Array.from(BINDING_KINDS).join(', ')}.`);
  } else if (!BINDING_KINDS.has(b.kind)) {
    errors.push(`bindings[${index}].kind must be one of: ${Array.from(BINDING_KINDS).join(', ')}.`);
  }
  for (const key of ['table', 'form']) {
    if (typeof b[key] !== 'string' || !b[key].trim()) errors.push(`bindings[${index}].${key} is required.`);
  }
  if (b.formType !== undefined && !FORM_TYPES.has(b.formType)) {
    errors.push(`bindings[${index}].formType must be one of: ${Array.from(FORM_TYPES).join(', ')}.`);
  }
  if (b.clients !== undefined) validateStringArray(b.clients, `bindings[${index}].clients`, CLIENTS, errors);
  const target = asObject(b.target, `bindings[${index}].target`, errors);
  if (target && !target.column && !target.controlId) {
    errors.push(`bindings[${index}].target must include column or controlId.`);
  }
  const params = asObject(b.parameters, `bindings[${index}].parameters`, errors);
  if (params) {
    for (const [name, param] of Object.entries(params)) validateParameter(param, `bindings[${index}].parameters.${name}`, errors);
  }
}

function validateParameter(param, pathName, errors) {
  const p = asObject(param, pathName, errors);
  if (!p) return;
  const hasColumn = Object.hasOwn(p, 'column');
  const hasStatic = Object.hasOwn(p, 'static');
  const hasDataset = Object.hasOwn(p, 'dataset');
  const count = Number(hasColumn) + Number(hasStatic) + Number(hasDataset);
  if (count !== 1) {
    errors.push(`${pathName} must include exactly one of column, static, or dataset.`);
    return;
  }
  if (hasColumn && (typeof p.column !== 'string' || !p.column)) errors.push(`${pathName}.column must be a non-empty string.`);
  if (hasStatic) {
    if (typeof p.static !== 'string') errors.push(`${pathName}.static must be a string.`);
    if (typeof p.type !== 'string' || !p.type) errors.push(`${pathName}.type is required for static parameters.`);
  }
  if (hasDataset) validateDatasetParameter(p.dataset, `${pathName}.dataset`, errors);
}

function validateDatasetParameter(dataset, pathName, errors) {
  const d = asObject(dataset, pathName, errors);
  if (!d) return;
  if (typeof d.name !== 'string' || !d.name) errors.push(`${pathName}.name is required.`);
  if (!Array.isArray(d.propertySets)) {
    errors.push(`${pathName}.propertySets must be an array.`);
    return;
  }
  for (const [index, set] of d.propertySets.entries()) {
    const s = asObject(set, `${pathName}.propertySets[${index}]`, errors);
    if (!s) continue;
    if (typeof s.name !== 'string' || !s.name) errors.push(`${pathName}.propertySets[${index}].name is required.`);
    if (typeof s.column !== 'string' || !s.column) errors.push(`${pathName}.propertySets[${index}].column is required.`);
  }
}

function validatePages(pages, errors) {
  if (pages === undefined) return;
  const p = asObject(pages, 'pages', errors);
  if (!p) return;
  if (p.journeys !== undefined) validateStringArray(p.journeys, 'pages.journeys', JOURNEYS, errors);
}

function lintBindingIntent(intent, options = {}) {
  const manifestModel = options.manifestModel || null;
  const findings = [];
  const hosts = Array.isArray(intent.hosts) ? intent.hosts : [];
  const targetsPages = hosts.includes('pages');
  const bindings = Array.isArray(intent.bindings) ? intent.bindings : [];
  const props = manifestProperties(intent, manifestModel);
  const propNames = new Set(props.map((prop) => prop.name));

  for (const [index, binding] of bindings.entries()) {
    const kind = binding.kind;
    const clients = clientsFor(binding);
    if (binding.formType === 'quick-create' && kind === 'dataset-subgrid') {
      findings.push(finding(
        'PCF_INTENT_QC_SUBGRID',
        'error',
        `Binding ${index + 1} targets a quick-create form with a dataset sub-grid, which the host does not support.`,
        'Move the dataset sub-grid binding to a main form or change the binding kind to a supported field binding.',
      ));
    }

    if (targetsPages) {
      if (distinctColumns(binding).size > 1) {
        findings.push(finding(
          'PCF_INTENT_PAGES_MULTI_FIELD',
          'error',
          `Binding ${index + 1} maps more than one distinct Dataverse column, but Power Pages supports only one bound field for this release.`,
          'Use one bound column for the Pages journey, or target model-driven apps only for this multi-field binding.',
        ));
      }
      if (!clients.includes('web')) {
        findings.push(finding(
          'PCF_INTENT_PAGES_NEEDS_WEB',
          'error',
          `Binding ${index + 1} targets Power Pages but its clients omit web.`,
          "Include 'web' in binding clients or remove 'pages' from hosts.",
        ));
      }
    }

    for (const name of Object.keys(binding.parameters || {})) {
      if (!propNames.has(name)) {
        findings.push(finding(
          'PCF_INTENT_PARAM_UNKNOWN',
          'error',
          `Binding ${index + 1} maps parameter '${name}', but the manifest has no matching property.`,
          `Remove '${name}' from the binding or add a '${name}' property to the manifest.`,
        ));
      }
    }

    for (const prop of props.filter((item) => item.usage === 'bound' && item.required)) {
      if (kind === 'grid-customizer' && prop.name === GRID_CUSTOMIZER_EVENT_PROPERTY) continue;
      if (!Object.hasOwn(binding.parameters || {}, prop.name)) {
        findings.push(finding(
          'PCF_INTENT_BOUND_NOT_MAPPED',
          'error',
          `Binding ${index + 1} does not map required bound property '${prop.name}'.`,
          `Map '${prop.name}' in the binding parameters or make the property optional/input-only.`,
        ));
      }
    }
  }

  if (targetsPages && isVirtualControlIntent(intent, manifestModel)) {
    findings.push(finding(
      'PCF_INTENT_PAGES_VIRTUAL',
      'error',
      'Power Pages does not support virtual PCF controls.',
      'Use a standard template for Pages or remove pages from hosts.',
    ));
  }

  if (targetsPages && intent.pages && Array.isArray(intent.pages.journeys) && intent.pages.journeys.includes('list')) {
    findings.push(finding(
      'PCF_INTENT_LIST_NEEDS_VIEW_CONFIG',
      'warning',
      'The Power Pages list journey needs a view/table-level configuration that this release guides but does not automate.',
      'Add the matching Power Pages list/view configuration during site setup and verify it before approval.',
    ));
  }

  return findings;
}

function isVirtualControlIntent(intent, manifestModel) {
  if (manifestModel && manifestModel.control && manifestModel.control.controlType === 'virtual') return true;
  const templateId = intent && intent.control && intent.control.template;
  if (!templateId) return false;
  return safeListTemplates().some((template) => template.id === templateId && template.controlType === 'virtual');
}

function manifestProperties(intent, manifestModel) {
  if (manifestModel && Array.isArray(manifestModel.properties)) return manifestModel.properties;
  return Array.isArray(intent.properties) ? intent.properties : [];
}

function clientsFor(binding) {
  return Array.isArray(binding.clients) && binding.clients.length ? binding.clients : ['web'];
}

function distinctColumns(binding) {
  const columns = new Set();
  if (binding.target && binding.target.column) columns.add(binding.target.column);
  for (const value of Object.values(binding.parameters || {})) {
    collectColumns(value, columns);
  }
  return columns;
}

function collectColumns(value, columns) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.column === 'string' && value.column) columns.add(value.column);
  if (value.dataset && Array.isArray(value.dataset.propertySets)) {
    for (const set of value.dataset.propertySets) {
      if (set && typeof set.column === 'string' && set.column) columns.add(set.column);
    }
  }
}

function renderPlanMarkdown(intent, { lint = [] } = {}) {
  const findings = Array.isArray(lint) ? lint : [];
  const lines = [];
  const control = intent.control || {};
  const bindings = Array.isArray(intent.bindings) ? intent.bindings : [];
  const deploy = intent.deploy || {};
  const hosts = Array.isArray(intent.hosts) ? intent.hosts : [];
  const pages = intent.pages || {};

  lines.push(`# ${markdownHeading(control.displayName || control.name || 'PCF control')} plan`, '');
  lines.push('## Summary', '');
  lines.push(`- **Control:** ${markdownInline(control.namespace || '(namespace missing)')}.${markdownInline(control.name || '(name missing)')}`);
  lines.push(`- **Description:** ${markdownInline(control.description || '(none)')}`);
  lines.push(`- **Template:** ${markdownInline(control.template || '(none)')}`);
  lines.push(`- **Recipe:** ${markdownInline(control.recipe || 'none')}`);
  lines.push(`- **Connectivity:** ${markdownInline(intent.connectivity || 'online')}`, '');

  lines.push('## Hosts', '');
  lines.push(hosts.length ? hosts.map((host) => `- ${host === 'model' ? 'Model-driven apps' : 'Power Pages'}`).join('\n') : '- (none)');
  lines.push('');

  lines.push('## Properties', '');
  lines.push('| Name | Usage | Type | Required | Default |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const prop of Array.isArray(intent.properties) ? intent.properties : []) {
    lines.push(`| ${markdownCell(prop.name || '')} | ${markdownCell(prop.usage || '')} | ${markdownCell(prop.type || '')} | ${prop.required ? 'yes' : 'no'} | ${markdownCell(prop.default || '')} |`);
  }
  if (!Array.isArray(intent.properties) || intent.properties.length === 0) lines.push('| _No properties declared._ |  |  |  |  |');
  lines.push('');

  lines.push('## Bindings', '');
  lines.push('| # | Kind | Table | Form | Target | Web | Phone | Tablet | Parameters |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  if (bindings.length === 0) {
    lines.push('| _No intended bindings._ |  |  |  |  |  |  |  |  |');
  } else {
    for (const [index, binding] of bindings.entries()) {
      const clients = clientsFor(binding);
      lines.push(`| ${index + 1} | ${markdownCell(binding.kind || '')} | ${markdownCell(binding.table || '')} | ${markdownCell(binding.form || '')} (${markdownCell(binding.formType || 'main')}) | ${markdownCell(renderTarget(binding.target))} | ${markClient(clients, 'web')} | ${markClient(clients, 'phone')} | ${markClient(clients, 'tablet')} | ${markdownCell(renderParameters(binding.parameters))} |`);
    }
  }
  lines.push('');

  lines.push('## Deploy target', '');
  lines.push(`- **Solution:** ${markdownInline(deploy.solution || '(none)')}`);
  lines.push(`- **Publisher prefix:** ${markdownInline(deploy.publisherPrefix || 'use solution publisher')}`);
  if (deploy.environment) lines.push(`- **Environment:** ${markdownInline(deploy.environment)}`);
  lines.push('- **Registration:** `pac pcf push --environment <environment>` after skill-level consent.');
  lines.push('');

  lines.push('## Power Pages steps', '');
  if (hosts.includes('pages')) {
    const journeys = Array.isArray(pages.journeys) && pages.journeys.length ? pages.journeys : ['form-field'];
    for (const journey of journeys) lines.push(`- ${renderJourney(journey)}`);
  } else {
    lines.push('- Not targeted.');
  }
  lines.push('');

  lines.push('## Findings', '');
  if (findings.length === 0) {
    lines.push('- No blocking or advisory findings.');
  } else {
    for (const item of findings) {
      lines.push(`- **${markdownInline(item.severity.toUpperCase())} ${markdownInline(item.code)}:** ${markdownInline(item.message)} **Fix:** ${markdownInline(item.fix)}`);
    }
  }
  lines.push('');

  lines.push('## What will be verified', '');
  lines.push('- The manifest properties match the intended parameters.');
  lines.push('- Each intended binding is present for every requested client.');
  lines.push('- Draft and published form XML agree after publication.');
  lines.push('- Power Pages journeys are manually configured where automation is not available.');
  lines.push('');

  return lines.join('\n');
}

function renderTarget(target) {
  if (!target || typeof target !== 'object') return '';
  const parts = [];
  if (target.column) parts.push(`column ${target.column}`);
  if (target.controlId) parts.push(`control ${target.controlId}`);
  if (target.table) parts.push(`dataset table ${target.table}`);
  if (target.view) parts.push(`view ${target.view}`);
  if (target.relationship) parts.push(`relationship ${target.relationship}`);
  return parts.join('; ');
}

function markdownHeading(value) {
  return escapeMarkdown(value).replace(/\s+/g, ' ').trim();
}

function markdownInline(value) {
  return escapeMarkdown(value).replace(/\r\n|\r|\n/g, '<br>');
}

function markdownCell(value) {
  return markdownInline(value);
}

function escapeMarkdown(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

function markClient(clients, client) {
  return clients.includes(client) ? 'yes' : 'no';
}

function renderParameters(parameters) {
  const entries = Object.entries(parameters || {});
  if (!entries.length) return '';
  return entries.map(([name, value]) => `${name}=${renderParameterValue(value)}`).join('<br>');
}

function renderParameterValue(value) {
  if (!value || typeof value !== 'object') return '';
  if (Object.hasOwn(value, 'column')) return `column:${value.column}`;
  if (Object.hasOwn(value, 'static')) return `static:${value.static} (${value.type})`;
  if (value.dataset) {
    const sets = Array.isArray(value.dataset.propertySets)
      ? value.dataset.propertySets.map((set) => `${set.name}:${set.column}`).join(', ')
      : '';
    return `dataset:${value.dataset.name || ''}${sets ? ` [${sets}]` : ''}`;
  }
  return '';
}

function renderJourney(journey) {
  if (journey === 'form-field') return 'Form field: add the PCF control to the matching Power Pages basic/advanced form field.';
  if (journey === 'list') return 'List: configure the site list/table view to use this control and verify the rendered dataset.';
  return journey;
}

module.exports = {
  validateIntent,
  lintBindingIntent,
  renderPlanMarkdown,
};
