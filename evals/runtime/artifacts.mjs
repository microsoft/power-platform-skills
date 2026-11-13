import { parse as parseHtml, serialize } from 'parse5';
import { parse as parseJs } from 'acorn';
import { parseDocument } from 'yaml';
import { lstat, readFile } from 'node:fs/promises';
import { assertKeys, assertObject, confinedPath, relativePath } from './paths.mjs';
import { inspectDocument, inspectSite } from './browser-checks.mjs';
import { buildSite } from './site-build.mjs';

const textFields = ['requiredText', 'forbiddenText', 'requiredPatterns', 'forbiddenPatterns', 'minTextLength'];
const fileFields = ['path', 'type', ...textFields, 'headings', 'requiredKeys', 'requiredValues', 'diagram', 'responsive'];

function strings(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${label} must contain nonempty strings`);
  }
}
function validateText(spec) {
  for (const key of textFields.filter(key => key !== 'minTextLength')) {
    if (spec[key] !== undefined) strings(spec[key], key);
  }
  for (const key of ['requiredPatterns', 'forbiddenPatterns']) {
    for (const pattern of spec[key] ?? []) new RegExp(pattern, 'iu');
  }
  if (spec.minTextLength !== undefined &&
      (!Number.isInteger(spec.minTextLength) || spec.minTextLength < 1)) {
    throw new Error('minTextLength must be a positive integer');
  }
}
export function validateContract(contract) {
  assertKeys(contract, ['files', 'site', 'output', 'unchanged', 'absent'], 'contract');
  if (!Object.values(contract).some(value =>
    Array.isArray(value) ? value.length : value && Object.keys(value).length)) {
    throw new Error('A contract must assert an outcome');
  }
  for (const key of ['files', 'unchanged', 'absent']) {
    if (contract[key] !== undefined && !Array.isArray(contract[key])) throw new Error(`${key} must be an array`);
  }
  const seen = new Set();
  for (const file of contract.files ?? []) {
    assertKeys(file, fileFields, 'file');
    relativePath(file.path);
    if (seen.has(file.path)) throw new Error(`Duplicate artifact: ${file.path}`);
    seen.add(file.path);
    if (!['html', 'json', 'text', 'yaml'].includes(file.type)) throw new Error('Unknown artifact type');
    if (file.responsive !== undefined && (file.type !== 'html' || typeof file.responsive !== 'boolean')) {
      throw new Error('responsive must be a boolean on an HTML artifact');
    }
    validateText(file);
    for (const key of ['headings', 'requiredKeys']) if (file[key] !== undefined) strings(file[key], key);
    if (file.requiredValues !== undefined) {
      if (file.type !== 'json') throw new Error('requiredValues requires a JSON artifact');
      assertObject(file.requiredValues, 'requiredValues');
      if (!Object.keys(file.requiredValues).length || Object.values(file.requiredValues).some(value =>
        value !== null && !['string', 'number', 'boolean'].includes(typeof value))) {
        throw new Error('requiredValues must contain scalar top-level values');
      }
    }
    if (file.diagram !== undefined) {
      assertKeys(file.diagram, ['entities', 'relationships'], 'diagram');
      if (file.type !== 'html') throw new Error('ER diagram checks require an HTML artifact');
      if (!Array.isArray(file.diagram.entities) || file.diagram.entities.length === 0) {
        throw new Error('ER diagram checks require expected entities');
      }
      for (const entity of file.diagram.entities) {
        assertKeys(entity, ['name', 'attributes'], 'entity');
        strings([entity.name], 'entity name');
        if (entity.attributes !== undefined) strings(entity.attributes, 'attributes');
      }
      if (file.diagram.relationships !== undefined && !Array.isArray(file.diagram.relationships)) {
        throw new Error('relationships must be an array');
      }
      for (const relation of file.diagram.relationships ?? []) {
        assertKeys(relation, ['from', 'to', 'cardinality'], 'relationship');
        strings([relation.from, relation.to, relation.cardinality], 'relationship');
        if (!/^(?:\|\||o\||\|o|\}o|\}\||o\{|\|\{)(?:--|\.\.)(?:\|\||o\||\|o|\}o|\}\||o\{|\|\{)$/.test(relation.cardinality)) {
          throw new Error(`Invalid ER cardinality: ${relation.cardinality}`);
        }
      }
    }
    if (!textFields.some(key => file[key] !== undefined) &&
        !file.headings?.length && !file.requiredKeys?.length && !file.requiredValues && !file.diagram) {
      throw new Error(`Artifact ${file.path} needs more than an existence check`);
    }
  }
  if (contract.site !== undefined) {
    assertKeys(contract.site, ['root', 'routes'], 'site');
    relativePath(contract.site.root);
    if (!Array.isArray(contract.site.routes) || contract.site.routes.length === 0) {
      throw new Error('A site check requires routes');
    }
    const routes = new Set();
    for (const route of contract.site.routes) {
      assertKeys(route, ['path', ...textFields], 'site route');
      if (typeof route.path !== 'string' || !/^\/[\w\-/]*$/.test(route.path)) throw new Error('Site routes must be absolute paths');
      if (routes.has(route.path)) throw new Error(`Duplicate site route: ${route.path}`);
      routes.add(route.path);
      validateText(route);
    }
  }
  if (contract.output !== undefined) {
    assertKeys(contract.output, textFields, 'output');
    validateText(contract.output);
    if (!Object.keys(contract.output).length) throw new Error('Output check must assert an outcome');
  }
  for (const item of contract.unchanged ?? []) {
    assertKeys(item, ['path', 'source'], 'unchanged');
    relativePath(item.path); relativePath(item.source);
  }
  for (const name of contract.absent ?? []) relativePath(name);
  return contract;
}

function nodes(root) {
  const found = [root];
  for (const child of root.childNodes ?? []) found.push(...nodes(child));
  if (root.content) found.push(...nodes(root.content));
  return found;
}
export const nodeText = node => node.nodeName === '#text' ? node.value :
  (node.childNodes ?? []).map(nodeText).join(' ');
const attr = (node, name) => node.attrs?.find(item => item.name === name)?.value;
const normalize = text => text.replace(/\s+/g, ' ').trim();

function literal(node) {
  if (node.type === 'Literal' && typeof node.value !== 'object') return node.value;
  if (node.type === 'Literal' && node.value === null) return null;
  if (node.type === 'ArrayExpression') return node.elements.map(element => literal(element));
  if (node.type === 'ObjectExpression') return Object.fromEntries(node.properties.map(property => {
    if (property.type !== 'Property' || property.computed || property.kind !== 'init') throw new Error('Not JSON');
    return [property.key.name ?? property.key.value, literal(property.value)];
  }));
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'Literal' &&
      typeof node.argument.value === 'number') return -node.argument.value;
  throw new Error('Not JSON');
}

export function inspectHtml(source) {
  const errors = [];
  const tree = parseHtml(source, { onParseError: error => errors.push(error.code) });
  const all = nodes(tree);
  const visible = all.filter(node => !['script', 'style', 'template', 'noscript'].includes(node.tagName));
  const body = all.find(node => node.tagName === 'body');
  function visibleText(node) {
    if (['script', 'style', 'template', 'noscript'].includes(node.tagName)) return '';
    return node.nodeName === '#text' ? node.value : (node.childNodes ?? []).map(visibleText).join(' ');
  }
  const embedded = {};
  const scriptErrors = [];
  for (const script of all.filter(node => node.tagName === 'script' && !attr(node, 'src'))) {
    if (attr(script, 'type') === 'application/json' || attr(script, 'type') === 'application/ld+json') {
      try { embedded[attr(script, 'id') ?? `json-${Object.keys(embedded).length}`] = JSON.parse(nodeText(script)); }
      catch { scriptErrors.push('Invalid embedded JSON'); }
      continue;
    }
    // Renderer data is serialized as e.g. const ER_DIAGRAM = "erDiagram\\n...";
    // An AST, not eval or a semicolon regex, preserves escaped quotes, newlines,
    // semicolons inside strings, nested arrays, and objects without running code.
    let ast;
    try { ast = parseJs(nodeText(script), { ecmaVersion: 'latest', sourceType: 'module' }); }
    catch { scriptErrors.push('Invalid inline JavaScript'); continue; }
    for (const statement of ast.body.filter(item => item.type === 'VariableDeclaration')) {
      for (const declaration of statement.declarations) {
        if (declaration.id.type !== 'Identifier' || !declaration.init) continue;
        try { embedded[declaration.id.name] = literal(declaration.init); }
        catch { /* Runtime expressions are not serialized document evidence. */ }
      }
    }
  }
  const diagrams = visible.filter(node =>
    ['pre', 'code', 'div'].includes(node.tagName) &&
    (attr(node, 'class') ?? '').split(/\s+/).includes('mermaid'))
    .map(node => nodeText(node).trim()).filter(text => /^erDiagram\b/.test(text));
  if (typeof embedded.ER_DIAGRAM === 'string') diagrams.push(embedded.ER_DIAGRAM);
  const text = normalize(visibleText(body ?? tree));
  return {
    source, tree, text, embedded, diagrams: [...new Set(diagrams)], errors, scriptErrors,
    title: normalize(nodeText(all.find(node => node.tagName === 'title') ?? {})),
    lang: attr(all.find(node => node.tagName === 'html') ?? {}, 'lang'),
    doctype: all.some(node => node.nodeName === '#documentType' && node.name === 'html'),
    headings: all.filter(node => /^h[1-6]$/.test(node.tagName ?? '')).map(node => normalize(nodeText(node))),
  };
}

function textChecks(text, spec, add, prefix) {
  const normalized = normalize(text).toLocaleLowerCase('en-US');
  for (const value of spec.requiredText ?? []) add(`${prefix}: contains ${value}`, normalized.includes(normalize(value).toLocaleLowerCase('en-US')));
  for (const value of spec.forbiddenText ?? []) add(`${prefix}: excludes ${value}`, !normalized.includes(normalize(value).toLocaleLowerCase('en-US')));
  for (const value of spec.requiredPatterns ?? []) add(`${prefix}: matches ${value}`, new RegExp(value, 'iu').test(text));
  for (const value of spec.forbiddenPatterns ?? []) add(`${prefix}: rejects ${value}`, !new RegExp(value, 'iu').test(text));
  if (spec.minTextLength !== undefined) add(`${prefix}: substantive content`, normalize(text).length >= spec.minTextLength);
}

export async function gradeArtifacts({ contract, workDir, suiteDir, output = '', evidenceDir, signal, browser = true }) {
  validateContract(contract);
  const checks = [];
  const add = (name, passed) => checks.push({ name, passed: Boolean(passed) });
  for (const spec of contract.files ?? []) {
    signal?.throwIfAborted();
    let source;
    try { source = await readFile(await confinedPath(workDir, spec.path), 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      add(`${spec.path}: exists`, false);
      continue;
    }
    add(`${spec.path}: exists`, true);
    if (Buffer.byteLength(source) > 512_000) {
      add(`${spec.path}: within evidence limit`, false);
      continue;
    }
    let data;
    if (spec.type === 'json' || spec.type === 'yaml') {
      try {
        if (spec.type === 'json') data = JSON.parse(source);
        else {
          const parsed = parseDocument(source, { uniqueKeys: true });
          if (parsed.errors.length) throw parsed.errors[0];
          data = parsed.toJS({ maxAliasCount: 0 });
        }
        add(`${spec.path}: parses`, true);
      } catch {
        add(`${spec.path}: parses`, false);
        continue;
      }
      for (const key of spec.requiredKeys ?? []) {
        let current = data;
        for (const part of key.split('.')) current = current && Object.hasOwn(current, part) ? current[part] : undefined;
        add(`${spec.path}: has ${key}`, current !== undefined);
      }
      for (const [key, expected] of Object.entries(spec.requiredValues ?? {})) {
        add(`${spec.path}: ${key} equals ${JSON.stringify(expected)}`,
          data !== null && typeof data === 'object' && !Array.isArray(data) &&
          Object.hasOwn(data, key) && data[key] === expected);
      }
    }
    if (spec.type !== 'html') {
      textChecks(source, spec, add, spec.path);
      continue;
    }
    const html = inspectHtml(source);
    add(`${spec.path}: HTML5 document`, html.doctype && html.errors.length === 0);
    add(`${spec.path}: title and language`, html.title.length > 0 && Boolean(html.lang));
    add(`${spec.path}: inline data parses`, html.scriptErrors.length === 0);
    add(`${spec.path}: no unfilled template tokens`, !/__(?:(?:HTML|ATTR|JSON|RAW)_)?[A-Z][A-Z0-9_]*__|\{\{[A-Z][A-Z0-9_]*\}\}|lorem ipsum/i.test(source));
    // Browser-visible text is authoritative for HTML content. A phrase hidden in
    // a comment, script, metadata, or unrendered JSON cannot satisfy a requirement.
    if (!browser) throw new Error('HTML grading requires the offline Chromium checks');
    const inspected = await inspectDocument({
      html, workDir, relativeFile: spec.path, diagram: spec.diagram, responsive: spec.responsive,
      evidenceDir, signal,
    });
    add(`${spec.path}: heading structure`, inspected.headings.length > 0);
    for (const heading of spec.headings ?? []) {
      add(`${spec.path}: heading ${heading}`, inspected.headings.some(value =>
        normalize(value).toLowerCase().includes(normalize(heading).toLowerCase())));
    }
    textChecks(inspected.text, spec, add, spec.path);
    for (const check of inspected.checks) add(`${spec.path}: ${check.name}`, check.passed);
  }
  if (contract.site) {
    signal?.throwIfAborted();
    const { root, routes } = contract.site;
    if (!browser) throw new Error('Site grading requires the offline Chromium checks');
    let built;
    try { built = await buildSite({ workDir, root, signal }); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      built = { ok: false, error: `${root} does not exist` };
    }
    add(`${root}: builds offline`, built.ok);
    if (!built.ok) checks.at(-1).evidence = built.error;
    else {
      try {
        const inspected = await inspectSite({ distDir: built.distDir, routes, evidenceDir, signal });
        for (const check of inspected.checks) add(`${root} ${check.name}`, check.passed);
        for (const route of routes) textChecks(inspected.texts[route.path] ?? '', route, add, `${root} route ${route.path}`);
      } finally {
        await built.cleanup();
      }
    }
  }
  if (contract.output) textChecks(output, contract.output, add, 'response');
  for (const item of contract.unchanged ?? []) {
    let actual;
    try { actual = await readFile(await confinedPath(workDir, item.path)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      add(`${item.path}: unchanged`, false);
      continue;
    }
    const expected = await readFile(await confinedPath(suiteDir, item.source));
    add(`${item.path}: unchanged`, actual.equals(expected));
  }
  for (const name of contract.absent ?? []) {
    try {
      await lstat(await confinedPath(workDir, name));
      add(`${name}: absent`, false);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      add(`${name}: absent`, true);
    }
  }
  return {
    name: 'power-pages-artifacts', kind: 'code', status: 'success',
    passed: checks.length > 0 && checks.every(check => check.passed),
    score: checks.length ? checks.filter(check => check.passed).length / checks.length : 0,
    evidence: checks.filter(check => !check.passed).map(check => check.evidence ? `${check.name}: ${check.evidence}` : check.name).join('\n') || 'All artifact checks passed',
    details: checks.map(check => ({ ...check, kind: 'code', score: Number(check.passed), evidence: check.evidence ?? check.name })),
  };
}

export function registerArtifactGrader(registry) {
  registry.register({
    metadata: {
      name: 'power-pages-artifacts', description: 'Offline document, source and ER outcome checks',
      behavior: { requiresWorkspace: true }, determinism: 'complex-static',
      reference: 'reference-based', temporalScope: 'point-in-time', costProfile: 'free',
    },
    grade: async input => {
      assertObject(input.config, 'artifact grader config');
      return gradeArtifacts({
        contract: JSON.parse(await readFile(input.config.contract, 'utf8')),
        suiteDir: input.config.suiteDir, workDir: input.trajectory.workDir,
        output: input.trajectory.output, evidenceDir: input.config.evidenceDir, signal: input.signal,
      });
    },
  });
}

export function stripExternalSources(html, relativeFile) {
  for (const node of nodes(html.tree)) {
    let remoteScript = false;
    if (node.tagName === 'script' && attr(node, 'src')) {
      try {
        remoteScript = new URL(attr(node, 'src'), `https://eval.invalid/${relativeFile}`).origin !== 'https://eval.invalid';
      } catch {
        remoteScript = true;
      }
    }
    if (node.tagName === 'base' || remoteScript ||
        (node.tagName === 'meta' && /content-security-policy|refresh/i.test(attr(node, 'http-equiv') ?? ''))) {
      if (node.parentNode) node.parentNode.childNodes = node.parentNode.childNodes.filter(child => child !== node);
    }
  }
  return serialize(html.tree);
}
