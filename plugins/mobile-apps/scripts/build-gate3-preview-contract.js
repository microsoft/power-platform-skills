#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  getSection,
  getSubsection,
  parseBulletFields,
  parseTableFields,
  parseYamlFields,
  validateExperienceContract,
} = require('./validate-experience-contract');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--validate') args.validate = argv[++index];
    else if (arg.startsWith('--') && argv[index + 1]) args[arg.slice(2)] = argv[++index];
  }
  return args;
}

function stripMarkup(value) {
  return String(value || '')
    .replace(/<!--.*?-->/g, '')
    .replace(/^\s*`|`\s*$/g, '')
    .replace(/^\s*\*\*|\*\*\s*$/g, '')
    .trim();
}

function normalizeKey(value) {
  return stripMarkup(value).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function isConcrete(value) {
  const text = stripMarkup(value);
  return Boolean(text) && !/^<.*>$/.test(text) && !/\{\{.*\}\}/.test(text) && !/^tbd$/i.test(text);
}

function numberFrom(value) {
  const match = /-?\d+(?:\.\d+)?/.exec(String(value || ''));
  return match ? Number(match[0]) : Number.NaN;
}

function parseMarkdownTable(markdown) {
  const lines = String(markdown || '').split(/\r?\n/).filter((line) => /^\s*\|/.test(line));
  if (lines.length < 2) return [];
  const cells = (line) => line.split('|').slice(1, -1).map((cell) => stripMarkup(cell));
  const headers = cells(lines[0]).map(normalizeKey);
  return lines.slice(2).map((line) => {
    const values = cells(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
  }).filter((row) => Object.values(row).some(Boolean));
}

function parseSpecFields(markdown) {
  const fields = new Map();
  let current = null;
  for (const line of String(markdown || '').split(/\r?\n/)) {
    const match = /^\s*-\s+\*\*([^*]+):\*\*\s*(.*)$/.exec(line);
    if (match) {
      current = normalizeKey(match[1]);
      fields.set(current, stripMarkup(match[2]));
      continue;
    }
    if (!current || !line.trim() || /^#{2,4}\s+/.test(line)) continue;
    if (/^\s*-\s+\*\*/.test(line)) {
      current = null;
      continue;
    }
    const previous = fields.get(current) || '';
    fields.set(current, `${previous} ${stripMarkup(line.replace(/^\s*[-*]\s+/, ''))}`.trim());
  }
  return fields;
}

function parsePerScreenSpecs(screensSection) {
  const lines = String(screensSection || '').split(/\r?\n/);
  const marker = lines.findIndex((line) => /^### Per-Screen Specs\s*$/i.test(line.trim()));
  if (marker < 0) return [];
  const specs = [];
  for (let index = marker + 1; index < lines.length; index += 1) {
    const heading = /^(#{3,4})\s+(.+?)(?:\s+\(`([^`]+)`\))?\s*$/.exec(lines[index]);
    if (!heading || /^Open Questions/i.test(heading[2])) continue;
    const level = heading[1].length;
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = /^(#+)\s+/.exec(lines[cursor]);
      if (next && next[1].length <= level) {
        end = cursor;
        break;
      }
    }
    const body = lines.slice(index + 1, end).join('\n');
    specs.push({
      name: stripMarkup(heading[2]),
      route: stripMarkup(heading[3]),
      body,
      fields: parseSpecFields(body),
    });
    index = end - 1;
  }
  return specs;
}

function field(fields, ...names) {
  for (const name of names) {
    const value = fields.get(normalizeKey(name));
    if (isConcrete(value)) return stripMarkup(value);
  }
  return '';
}

function parseSilhouettes(screensSection) {
  const lines = String(screensSection || '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^\*\*Tab-root silhouettes\*\*\s*$/i.test(line.trim()));
  if (start < 0) return [];
  const silhouettes = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    if (/^\*\*.+\*\*/.test(line) || /^#{2,4}\s+/.test(line)) break;
    const match = /^-\s+([^:]+):\s*(.+)$/.exec(line);
    if (match) silhouettes.push({ screen: stripMarkup(match[1]), description: stripMarkup(match[2]) });
  }
  return silhouettes;
}

function screenScore(screen) {
  if (screen.isHome) return 100;
  if (screen.isBaseline || /profile|settings/i.test(screen.name)) return -10;
  let score = 0;
  if (screen.workflow) score += 6;
  if (screen.action) score += 4;
  if (/form|workflow|review|queue|capture/i.test(screen.archetype + screen.purpose)) score += 3;
  if (/detail/i.test(screen.archetype)) score += 1;
  return score;
}

function semanticColor(markdown, names) {
  for (const name of names) {
    const expression = new RegExp(`${name}[^#\\n]{0,80}(#[0-9a-fA-F]{6})`, 'i');
    const match = expression.exec(markdown);
    if (match) return match[1];
  }
  return '';
}

function buildGate3PreviewContract(markdown, options = {}) {
  const productSection = getSection(markdown, 'Product Experience');
  const productFields = parseBulletFields(productSection.split(/^### First Viewport Contract\s*$/m)[0]);
  const viewport = parseTableFields(getSubsection(productSection, 'First Viewport Contract'));
  const reference = parseBulletFields(getSubsection(productSection, 'Reference Contract'));
  const designDirection = parseYamlFields(getSection(markdown, 'Design Direction'));
  const designSection = getSection(markdown, 'Design');
  const design = parseBulletFields(designSection);
  const screensSection = getSection(markdown, 'Screens');
  const screenMap = parseMarkdownTable(getSubsection(screensSection, 'Screen Map'));
  const specs = parsePerScreenSpecs(screensSection);

  const screens = screenMap.map((row) => {
    const spec = specs.find((candidate) => candidate.route && candidate.route === row.route)
      || specs.find((candidate) => normalizeKey(candidate.name).includes(normalizeKey(row.screen)));
    const fields = spec?.fields || new Map();
    const route = stripMarkup(row.route || spec?.route);
    const name = stripMarkup(row.screen || spec?.name);
    const file = stripMarkup(row.file);
    const purpose = field(fields, 'purpose') || stripMarkup(row.purpose);
    const archetype = field(fields, 'archetype');
    const dominant = field(fields, 'domain layout decisions', 'dominant region override', 'visual emphasis')
      || purpose;
    const layout = field(fields, 'layout delta') || dominant;
    const workflow = field(fields, 'workflow arrangement', 'calendar behavior', 'specialized controls');
    const action = field(fields, 'ux contract', 'first viewport materialization', 'key user actions', 'action placement');
    const states = field(fields, 'state delta');
    const isHome = route === '/(app)/home' || /\/home(?:\.tsx)?$/.test(file) || /^home$/i.test(name);
    const isBaseline = /template\s*\(keep\)|baseline|auth-aware redirect|msal sign-in|oauth/i.test(`${row.source} ${purpose}`);
    return {
      name,
      route,
      file,
      purpose,
      archetype,
      isHome,
      isBaseline,
      dominant,
      layout,
      workflow,
      action,
      states,
      homeComposition: isHome ? field(fields, 'home composition') || productFields.get('home composition') : '',
    };
  });

  const representativeScreens = screens
    .filter((screen) => !screen.isBaseline)
    .sort((left, right) => screenScore(right) - screenScore(left))
    .slice(0, 3)
    .map((screen) => screen.route);

  const sourcePlan = options.planPath
    ? path.relative(options.projectRoot || path.dirname(options.planPath), options.planPath) || path.basename(options.planPath)
    : 'native-app-plan.md';
  const accent = semanticColor(designSection, ['accent', 'primary', 'brand']) || '#0f766e';
  const background = semanticColor(designSection, ['background', 'surface', 'bg']) || '#f7f8f6';
  const text = semanticColor(designSection, ['text', 'foreground', 'ink']) || '#17201d';

  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt || new Date().toISOString(),
    sourcePlan,
    product: {
      structure: stripMarkup(productFields.get('product archetype')),
      workflows: stripMarkup(productFields.get('workflow capabilities')),
      operatingContext: stripMarkup(productFields.get('operating context')),
      visualCharacter: stripMarkup(productFields.get('visual personality')),
      visualAmbition: stripMarkup(productFields.get('visual ambition')),
      contentEmphasis: stripMarkup(productFields.get('content emphasis')),
      homeComposition: stripMarkup(productFields.get('home composition')),
      navigationMood: stripMarkup(productFields.get('navigation mood')),
      navigationSilhouette: stripMarkup(productFields.get('navigation silhouette')),
      density: stripMarkup(productFields.get('density')),
    },
    firstViewport: {
      signatureComponent: stripMarkup(viewport.get('signature component')),
      viewportShare: numberFrom(viewport.get('viewport share')),
      minimumHeight: numberFrom(viewport.get('minimum height')),
      media: stripMarkup(viewport.get('media')),
      headlineMinimum: numberFrom(viewport.get('headline minimum')),
      supportingMetricsMaximum: numberFrom(viewport.get('supporting metrics maximum')),
      primaryAction: stripMarkup(viewport.get('primary action')),
      nextSectionVisible: stripMarkup(viewport.get('next section visible')),
      duplicateActionWithTab: stripMarkup(viewport.get('duplicate action with tab')),
    },
    media: {
      strategy: stripMarkup(productFields.get('media strategy')),
      source: stripMarkup(productFields.get('media source')),
      fallback: stripMarkup(productFields.get('media fallback')),
    },
    reference: {
      fidelity: stripMarkup(productFields.get('reference fidelity')),
      source: stripMarkup(reference.get('source')),
      hierarchy: stripMarkup(reference.get('required hierarchy')),
      motifs: stripMarkup(reference.get('required repeated motifs')),
      forbiddenDrift: stripMarkup(reference.get('forbidden drift')),
      nonGoals: stripMarkup(reference.get('explicit non goals')),
    },
    design: {
      rationale: field(design, 'aesthetic rationale', 'aesthetic'),
      palette: field(design, 'palette'),
      typography: field(design, 'typography', 'font'),
      surface: field(design, 'surface treatment') || stripMarkup(designDirection.get('surface')),
      motion: field(design, 'motion policy') || stripMarkup(designDirection.get('motion')),
      memorable: field(design, 'one memorable thing'),
      colors: { accent, background, text, inferredFallback: !/#/.test(designSection) },
    },
    navigation: {
      pattern: stripMarkup(getSubsection(screensSection, 'Navigation Pattern').split(/\r?\n/).find(Boolean)),
      silhouettes: parseSilhouettes(screensSection),
    },
    representativeScreens,
    screens,
  };
}

function validateGate3PreviewContract(contract) {
  const issues = [];
  const requiredProduct = ['structure', 'workflows', 'operatingContext', 'visualCharacter', 'homeComposition', 'navigationSilhouette', 'density'];
  if (contract?.schemaVersion !== 1) issues.push({ rule: 'schema-version', message: 'schemaVersion must be 1.' });
  for (const key of requiredProduct) {
    if (!isConcrete(contract?.product?.[key])) issues.push({ rule: 'missing-product-field', field: key, message: `Product preview field ${key} must be concrete.` });
  }
  const screens = Array.isArray(contract?.screens) ? contract.screens : [];
  if (screens.length === 0) issues.push({ rule: 'missing-screens', message: 'Preview contract has no screens.' });
  const routes = screens.map((screen) => screen.route).filter(Boolean);
  if (new Set(routes).size !== routes.length) issues.push({ rule: 'duplicate-route', message: 'Preview contract contains duplicate routes.' });
  const home = screens.find((screen) => screen.isHome);
  if (!home) issues.push({ rule: 'missing-home', message: 'Preview contract has no Home screen.' });
  else {
    for (const key of ['purpose', 'dominant', 'layout', 'action', 'homeComposition']) {
      if (!isConcrete(home[key])) issues.push({ rule: 'incomplete-home-preview', field: key, message: `Home preview is missing ${key}.` });
    }
  }
  const viewport = contract?.firstViewport || {};
  if (!Number.isFinite(viewport.viewportShare) || viewport.viewportShare < 0.2 || viewport.viewportShare > 0.65) issues.push({ rule: 'invalid-viewport-share', message: 'viewportShare must be between 0.20 and 0.65.' });
  if (!Number.isInteger(viewport.minimumHeight) || viewport.minimumHeight < 120) issues.push({ rule: 'invalid-minimum-height', message: 'minimumHeight must be an integer of at least 120dp.' });
  if (!Number.isInteger(viewport.headlineMinimum) || viewport.headlineMinimum < 20) issues.push({ rule: 'invalid-headline-minimum', message: 'headlineMinimum must be at least 20sp.' });
  if (!Number.isInteger(viewport.supportingMetricsMaximum) || viewport.supportingMetricsMaximum < 0 || viewport.supportingMetricsMaximum > 4) issues.push({ rule: 'invalid-metric-maximum', message: 'supportingMetricsMaximum must be 0-4.' });
  if (String(viewport.media).toLowerCase() === 'required' && !isConcrete(contract?.media?.source)) issues.push({ rule: 'missing-media-source', message: 'Required media needs a concrete source.' });
  const representative = Array.isArray(contract?.representativeScreens) ? contract.representativeScreens : [];
  if (representative.length === 0 || representative.length > 3) issues.push({ rule: 'representative-screen-count', message: 'Select one to three representative screens.' });
  for (const route of representative) {
    if (!routes.includes(route)) issues.push({ rule: 'unknown-representative-screen', value: route, message: `Representative route ${route} is not in Screen Map.` });
  }
  if (/tabs/i.test(contract?.navigation?.pattern || '') && (contract?.navigation?.silhouettes || []).length < 2) {
    issues.push({ rule: 'missing-tab-silhouettes', message: 'Tabbed previews need at least two tab-root silhouettes.' });
  }
  const fidelity = String(contract?.reference?.fidelity || '').toLowerCase();
  if (fidelity && fidelity !== 'none') {
    for (const key of ['source', 'hierarchy', 'motifs', 'forbiddenDrift']) {
      if (!isConcrete(contract.reference[key])) issues.push({ rule: 'incomplete-reference-preview', field: key, message: `Referenced preview is missing ${key}.` });
    }
  }
  return issues;
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.validate) {
    const contractPath = path.resolve(args.validate);
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    const issues = validateGate3PreviewContract(contract);
    console.log(JSON.stringify({ status: issues.length ? 'blocked' : 'ok', contract: contractPath, issues }, null, 2));
    return issues.length ? 2 : 0;
  }
  if (!args.plan || !args.output) {
    process.stderr.write('Usage: node build-gate3-preview-contract.js --plan <native-app-plan.md> --output <contract.json> [--project-root <path>]\n       node build-gate3-preview-contract.js --validate <contract.json>\n');
    return 1;
  }
  const planPath = path.resolve(args.plan);
  const projectRoot = path.resolve(args['project-root'] || path.dirname(planPath));
  const markdown = fs.readFileSync(planPath, 'utf8');
  const contract = buildGate3PreviewContract(markdown, { planPath, projectRoot });
  const planIssues = validateExperienceContract(markdown, { projectRoot });
  const issues = [
    ...planIssues.map((issue) => ({ ...issue, source: 'experience-contract' })),
    ...validateGate3PreviewContract(contract).map((issue) => ({ ...issue, source: 'gate3-preview-contract' })),
  ];
  if (issues.length) {
    process.stderr.write(`${JSON.stringify({ status: 'blocked', plan: planPath, issues }, null, 2)}\n`);
    return 2;
  }
  const output = path.resolve(args.output);
  writeJsonAtomic(output, contract);
  console.log(JSON.stringify({ status: 'ok', output, representativeScreens: contract.representativeScreens }, null, 2));
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  buildGate3PreviewContract,
  parseMarkdownTable,
  parsePerScreenSpecs,
  validateGate3PreviewContract,
};