'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseSimpleYaml } = require('./powerpages-config');

const MAX_FILES = 10000;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const DEFAULT_CSS = /^(bootstrap(?:\.min)?|theme(?:\.min)?|portalbasictheme)\.css$/i;
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function safePath(root, relative) {
  // Proposals travel between Windows and POSIX: reject either platform's absolute
  // paths and traversal, not only paths recognized by the current OS.
  if (typeof relative !== 'string' || !relative || /[\0\r\n:]/.test(relative) ||
      path.win32.isAbsolute(relative) || path.posix.isAbsolute(relative)) {
    throw new Error(`Expected a site-relative path: ${relative}`);
  }
  const parts = relative.split(/[\\/]/);
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe relative path: ${relative}`);
  }
  const resolved = path.resolve(root, ...parts);
  if (!within(root, resolved)) throw new Error(`Path escapes site: ${relative}`);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) {
      throw new Error(`Symlinks are not supported in styling targets: ${relative}`);
    }
  }
  return resolved;
}

function readText(file) {
  if (fs.statSync(file).size > MAX_TEXT_BYTES) throw new Error(`Text artifact exceeds 4 MB: ${file}`);
  const bytes = fs.readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`Unsupported text encoding (expected UTF-8): ${file}`);
  return text;
}

function walk(root, directory, result = []) {
  if (!fs.existsSync(directory)) return result;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink in site content: ${file}`);
    if (entry.isDirectory()) walk(root, file, result);
    else if (/\.(?:yml|yaml|css|scss|sass|less|html)$/i.test(entry.name)) {
      result.push(path.relative(root, file).split(path.sep).join('/'));
      if (result.length > MAX_FILES) throw new Error('Site discovery exceeds 10000 text files; select a smaller export.');
    }
  }
  return result;
}

function field(record, name, idKind) {
  const keys = name === 'id' ? ['id', `adx_${idKind}id`] : [name, `adx_${name}`];
  const values = keys.filter((key) => record[key] !== undefined).map((key) => record[key]);
  if (values.length > 1 && values.some((value) => value !== values[0])) {
    throw new Error(`Conflicting metadata aliases for ${name} in ${record.filePath}`);
  }
  // parseSimpleYaml represents an empty "key:" as []; for these scalar metadata
  // fields it means an unset relationship, not a list of record IDs.
  const value = values[0];
  return (Array.isArray(value) && value.length === 0) ? null : value ?? null;
}

function parseRecord(text, file) {
  // PAC records are flat mappings, e.g. "adx_name: Site.css" or "name: Site.css".
  // Preserve source bytes for editing; this parser is only a discovery view.
  return parseSimpleYaml(text.replace(/^\uFEFF/, '').replace(/^\s*#.*$/gm, ''), file);
}

function parseSettings(text, file) {
  // Older PAC exports collect records as "- adx_name: ..." entries. Split only
  // top-level entries; indented block-literal content must stay with its record.
  if (!/^- /m.test(text)) return [parseRecord(text, file)];
  return text.split(/(?=^- )/m).filter((chunk) => chunk.trim() && !/^\s*#/.test(chunk))
    .map((chunk) => parseRecord(chunk.replace(/^- /, '').replace(/^ {2}/gm, ''), file));
}

function resolveSiteRoot(input) {
  if (!input) throw new Error('--siteRoot is required; select one local classic-site export.');
  const requested = path.resolve(input);
  if (!fs.existsSync(requested) || !fs.statSync(requested).isDirectory()) throw new Error('Site root must be an existing directory.');
  if (fs.lstatSync(requested).isSymbolicLink()) throw new Error('Select the actual site directory, not a symlink.');
  if (fs.existsSync(path.join(requested, 'powerpages.config.json')) ||
      (path.basename(requested) === '.powerpages-site' && fs.existsSync(path.join(requested, '..', 'powerpages.config.json')))) {
    throw new Error('Code/SPA sites are not supported by style-site.');
  }
  const root = fs.existsSync(path.join(requested, 'website.yml'))
    ? requested : path.join(requested, '.powerpages-site');
  if (!fs.existsSync(path.join(root, 'website.yml')) || !fs.existsSync(path.join(root, 'web-pages'))) {
    throw new Error('Select a classic export containing website.yml and web-pages (directly or in .powerpages-site).');
  }
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Site directory must not be a symlink.');
  return fs.realpathSync(root);
}

function inspectSite(input) {
  const siteRoot = resolveSiteRoot(input);
  const paths = ['website.yml'];
  for (const directory of ['web-pages', 'web-files', 'web-templates', 'page-templates', 'site-settings', 'basic-forms', 'lists']) {
    walk(siteRoot, path.join(siteRoot, directory), paths);
  }
  for (const name of ['sitesetting.yml', 'sitesettings.yml']) {
    if (fs.existsSync(path.join(siteRoot, name))) paths.push(name);
  }
  // The plugin records usage after the Verify phase. These known counters do not
  // affect styling; including them would invalidate every successful proposal
  // immediately after its own final tracking step.
  for (let index = paths.length - 1; index >= 0; index -= 1) {
    if (/^site-settings\/Site-AI-(?:Skills|Tools)-[^/]+\.sitesetting\.yml$/i.test(paths[index])) paths.splice(index, 1);
  }
  paths.sort();
  const files = paths.map((relative) => {
    const content = readText(safePath(siteRoot, relative));
    return { path: relative, hash: hash(content), content };
  });
  const byPath = new Map(files.map((file) => [file.path, file]));
  const website = parseRecord(byPath.get('website.yml').content, 'website.yml');
  const siteId = field(website, 'id', 'website');
  if (typeof siteId !== 'string' || !siteId) throw new Error('Website identity is missing or unsupported.');
  const pages = [];
  const webFiles = [];
  const templates = [];
  const pageTemplates = [];
  const settings = [];
  for (const file of files.filter((entry) => /\.ya?ml$/i.test(entry.path))) {
    if (/sitesettings?\.yml$|\.sitesetting\.ya?ml$/i.test(file.path)) {
      settings.push(...parseSettings(file.content, file.path));
      continue;
    }
    if (!/\.(webpage|webfile|webtemplate|pagetemplate)\.yml$/i.test(file.path)) continue;
    const record = parseRecord(file.content, file.path);
    const kind = /\.(webpage|webfile|webtemplate|pagetemplate)\.yml$/i.exec(file.path)[1].toLowerCase();
    const id = field(record, 'id', kind);
    if (typeof id !== 'string' || !id) throw new Error(`Missing ${kind} identity: ${file.path}`);
    if (kind === 'webtemplate') {
      templates.push({ id, name: field(record, 'name'), path: file.path, sourcePath: file.path.replace(/\.yml$/i, '.source.html') });
      continue;
    }
    if (kind === 'pagetemplate') {
      pageTemplates.push({ id, webTemplateId: field(record, 'webtemplateid'), useHeaderFooter: field(record, 'usewebsiteheaderandfooter') });
      continue;
    }
    const common = {
      id, path: file.path, name: field(record, 'name'), parentId: field(record, 'parentpageid'),
      partialUrl: field(record, 'partialurl'), publishingStateId: field(record, 'publishingstateid'),
      prefix: Object.hasOwn(record, `adx_${kind}id`) ? 'adx_' : '',
    };
    if (kind === 'webpage') {
      pages.push({
        ...common, rootId: field(record, 'rootwebpageid'), languageId: field(record, 'webpagelanguageid'),
        sharedConfiguration: field(record, 'sharedpageconfiguration'), templateId: field(record, 'pagetemplateid'),
        cssPath: file.path.replace(/\.yml$/i, '.custom_css.css'),
        copyPath: file.path.replace(/\.yml$/i, '.copy.html'),
      });
    } else {
      const filename = record.filename ?? common.partialUrl;
      if (typeof filename !== 'string' || /[\\/]/.test(filename)) throw new Error(`Unsupported attachment filename: ${file.path}`);
      const assetPath = path.posix.join(path.posix.dirname(file.path), filename);
      safePath(siteRoot, assetPath);
      webFiles.push({
        ...common, filename, assetPath, order: field(record, 'displayorder'),
        mimeType: record.mimetype, isDefault: DEFAULT_CSS.test(common.partialUrl || filename),
        isCss: /\.css$/i.test(common.partialUrl || ''), assetPresent: byPath.has(assetPath),
      });
    }
  }
  for (const records of [pages, webFiles, templates, pageTemplates]) {
    if (new Set(records.map((record) => record.id)).size !== records.length) throw new Error('Duplicate record identities in export.');
  }
  const homePages = pages.filter((page) => !page.rootId && !page.parentId && page.partialUrl === '/');
  if (homePages.length !== 1) throw new Error('Could not resolve exactly one site root page from relationships and partial URL.');
  const evidence = [];
  for (const file of webFiles.filter((entry) => /^bootstrap(?:\.min)?\.css$/i.test(entry.partialUrl || ''))) {
    const text = byPath.get(file.assetPath)?.content;
    const version = text?.match(/Bootstrap\s+v?(\d+\.\d+(?:\.\d+)?)/i)?.[1];
    if (version) evidence.push({ source: file.assetPath, version, major: Number(version.split('.')[0]), kind: 'asset' });
  }
  for (const record of settings) {
    if (field(record, 'name') !== 'Site/BootstrapV5Enabled') continue;
    const value = field(record, 'value');
    if (![true, false, 'true', 'false'].includes(value)) throw new Error('Invalid Site/BootstrapV5Enabled value.');
    evidence.push({ source: record.filePath, major: String(value) === 'true' ? 5 : 3, kind: 'setting' });
  }
  const majors = [...new Set(evidence.map((entry) => entry.major))];
  const assetEvidence = evidence.filter((entry) => entry.kind === 'asset');
  const versions = new Set(assetEvidence.map((entry) => entry.version));
  const major = majors.length === 1 && [3, 5].includes(majors[0]) && versions.size === 1 ? majors[0] : null;
  const warnings = [
    'Stylesheet order is inferred from exported metadata. Custom templates, runtime assets and Studio rendering require separate confirmation.',
  ];
  if (!major) warnings.push('Bootstrap is missing, conflicting or unsupported. Resolve the asset/configuration evidence before preparing styling.');
  for (const file of webFiles.filter((entry) => entry.isCss && !entry.assetPresent)) warnings.push(`Missing CSS attachment: ${file.assetPath}`);
  return {
    schemaVersion: 1, siteRoot, siteId, homePageId: homePages[0].id,
    siteName: field(website, 'name'), pages, webFiles, templates, pageTemplates,
    headerTemplateId: field(website, 'headerwebtemplateid'), footerTemplateId: field(website, 'footerwebtemplateid'),
    bootstrap: { major, evidence, version: assetEvidence.find((entry) => entry.major === major)?.version ?? null },
    files: files.map(({ path: filePath, hash: fileHash }) => ({ path: filePath, hash: fileHash })),
    warnings,
  };
}

function assertOutsideSite(siteRoot, output) {
  const absolute = path.resolve(output);
  // Resolve existing ancestors too: an apparently external output may traverse a
  // symlink/junction into the upload tree.
  let ancestor = absolute;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const resolved = path.join(fs.realpathSync(ancestor), path.relative(ancestor, absolute));
  if (within(siteRoot, resolved)) throw new Error('Preview, proposal and receipt files must be outside the uploadable site tree.');
  return absolute;
}

function parseArgs(argv, allowed) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--') || !allowed.includes(key.slice(2)) || Object.hasOwn(args, key.slice(2))) {
      throw new Error(`Unknown or duplicate argument: ${key}`);
    }
    const name = key.slice(2);
    if (name === 'apply') args[name] = true;
    else {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`Missing value for ${key}`);
      args[name] = argv[++index];
    }
  }
  return args;
}

module.exports = { inspectSite, resolveSiteRoot, safePath, readText, hash, within, assertOutsideSite, parseArgs, DEFAULT_CSS };
