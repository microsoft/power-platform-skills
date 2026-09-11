'use strict';

const fs = require('node:fs');
const path = require('node:path');
const generateUuid = require('../generate-uuid');
const {
  inspectSite, safePath, readText, hash, DEFAULT_CSS, assertOutsideSite,
} = require('./classic-site-style-context');

const KINDS = ['section', 'text', 'button', 'image', 'navigation', 'form', 'list', 'card'];
const PARTS = [
  '', ':hover', ':focus', ':focus-visible', ':active', ':disabled',
  ' .btn', ' .btn:hover', ' .btn:focus-visible', ' .btn:disabled',
  ' .form-control', ' .form-control:focus', ' .table', ' th', ' td', ' label', ' img',
];
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const CLASS = /^pp-[a-z][a-z0-9-]{0,60}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR = /^(?:#[0-9a-f]{3}(?:[0-9a-f]{3})?|transparent|currentColor|inherit|var\(--[a-zA-Z][a-zA-Z0-9_-]*\))$/i;
const LENGTH = /^(?:0|(?:\d{1,3}(?:\.\d{1,3})?)(?:px|rem|em|%))$/;
const SPACING = /^(?:0|\d{1,3}(?:\.\d{1,3})?(?:px|rem|em|%))(?: (?:0|\d{1,3}(?:\.\d{1,3})?(?:px|rem|em|%))){0,3}$/;
const VALUES = {
  color: COLOR, 'background-color': COLOR, 'border-color': COLOR, 'outline-color': COLOR,
  'border-radius': SPACING, 'border-width': SPACING, padding: SPACING, margin: SPACING,
  gap: LENGTH, width: /^(?:auto|100%|0|\d{1,3}(?:\.\d{1,3})?(?:px|rem|em|%))$/,
  'max-width': /^(?:none|100%|0|\d{1,3}(?:\.\d{1,3})?(?:px|rem|em|%))$/,
  'min-height': LENGTH, 'font-size': LENGTH, 'letter-spacing': LENGTH,
  'font-family': /^(?:inherit|serif|sans-serif|monospace|Georgia, serif)$/,
  'font-weight': /^(?:normal|bold|[1-9]00)$/, 'line-height': /^(?:normal|[1-3](?:\.\d{1,3})?)$/,
  'text-align': /^(?:start|end|left|right|center)$/, 'border-style': /^(?:none|solid|dashed|dotted)$/,
  'object-fit': /^(?:cover|contain)$/,
  'outline-width': LENGTH, 'outline-offset': LENGTH, 'outline-style': /^(?:solid|dashed|dotted)$/,
  opacity: /^(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/,
  // Small explicit choices avoid turning a preview input into arbitrary CSS
  // (url(), @import, !important and declaration injection are never values).
  'box-shadow': /^(?:none|0 2px 8px #0000001a|0 8px 24px #00000026|0 12px 32px #00000033)$/,
};

function requireString(value, label, max = 240) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} must be non-empty text (maximum ${max} characters).`);
}

function assertKeys(object, keys, label) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error(`${label} must be an object.`);
  for (const key of Object.keys(object)) if (!keys.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
}

function validateRequest(request) {
  assertKeys(request, ['title', 'pageId', 'components', 'styles', 'classEdits'], 'request');
  requireString(request.title, 'title');
  requireString(request.pageId, 'pageId');
  if (!Array.isArray(request.components) || !request.components.length || request.components.length > 30) throw new Error('Provide 1-30 requested components.');
  if (!Array.isArray(request.styles) || !request.styles.length || request.styles.length > 100) throw new Error('Provide 1-100 style groups.');
  const componentIds = new Set();
  const classNames = new Set();
  for (const component of request.components) {
    assertKeys(component, ['id', 'label', 'kind', 'className', 'sourcePath'], 'component');
    if (!ID.test(component.id) || componentIds.has(component.id)) throw new Error('Component IDs must be unique kebab-case identifiers.');
    if (!CLASS.test(component.className) || classNames.has(component.className)) throw new Error('Components require distinct pp-* classes.');
    if (!KINDS.includes(component.kind)) throw new Error(`Unsupported component kind: ${component.kind}`);
    requireString(component.label, 'component label');
    if (component.sourcePath !== undefined) requireString(component.sourcePath, 'sourcePath');
    componentIds.add(component.id);
    classNames.add(component.className);
  }
  const ids = new Set();
  for (const style of request.styles) {
    assertKeys(style, ['id', 'componentId', 'owner', 'scope', 'targetId', 'fileName', 'parentPageId', 'part', 'declarations', 'rationale', 'studioAction'], 'style');
    if (!ID.test(style.id) || ids.has(style.id)) throw new Error('Style IDs must be unique kebab-case identifiers.');
    ids.add(style.id);
    if (!componentIds.has(style.componentId)) throw new Error(`Unknown component: ${style.componentId}`);
    if (!['custom', 'studio'].includes(style.owner)) throw new Error('Each style requires custom or studio ownership.');
    if (!['page', 'site', 'section'].includes(style.scope)) throw new Error('Scope must be page, site, or section.');
    if (!PARTS.includes(style.part ?? '')) throw new Error('Unsupported component part; use a documented stable hook.');
    requireString(style.rationale, 'styling ownership/placement rationale', 2000);
    if (style.owner === 'studio') requireString(style.studioAction, 'Studio action', 2000);
    assertKeys(style.declarations, Object.keys(VALUES), 'declarations');
    if (!Object.keys(style.declarations).length) throw new Error('A style group needs at least one declaration.');
    for (const [property, value] of Object.entries(style.declarations)) {
      if (typeof value !== 'string' || !VALUES[property].test(value)) throw new Error(`Unsupported or unsafe ${property} value: ${value}`);
    }
    if (style.fileName !== undefined && (!/^[a-z][a-z0-9-]{0,60}\.css$/.test(style.fileName) || DEFAULT_CSS.test(style.fileName))) {
      throw new Error('New stylesheets need a unique, non-default kebab-case .css filename.');
    }
  }
  if (request.classEdits !== undefined && (!Array.isArray(request.classEdits) || request.classEdits.length > 60)) throw new Error('classEdits must contain at most 60 edits.');
  for (const edit of request.classEdits || []) {
    assertKeys(edit, ['path', 'match', 'className'], 'class edit');
    requireString(edit.path, 'class edit path');
    requireString(edit.match, 'class edit match', 8000);
    if (!classNames.has(edit.className)) throw new Error('Class edits must refer to a requested component class.');
  }
  return request;
}

function compileStyles(request, owner = 'custom') {
  validateRequest(request);
  return request.styles.filter((style) => style.owner === owner).map((style) => {
    const component = request.components.find((entry) => entry.id === style.componentId);
    const selector = `.${component.className}${style.part || ''}`;
    const declarations = Object.keys(style.declarations).sort()
      .map((property) => `  ${property}: ${style.declarations[property]};`).join('\n');
    return { id: style.id, css: `${selector} {\n${declarations}\n}` };
  });
}

function replaceBlock(before, id, css) {
  const start = `/* power-pages:style-site:${id}:start */`;
  const end = `/* power-pages:style-site:${id}:end */`;
  const starts = before.split(start).length - 1;
  const ends = before.split(end).length - 1;
  if (starts > 1 || ends > 1 || starts !== ends || (starts && before.indexOf(end) < before.indexOf(start))) {
    throw new Error(`Ambiguous managed CSS block: ${id}`);
  }
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const block = `${start}${eol}${css.replace(/\n/g, eol)}${eol}${end}`;
  if (starts) return before.slice(0, before.indexOf(start)) + block + before.slice(before.indexOf(end) + end.length);
  return before + (before && !before.endsWith('\n') ? eol : '') + block + eol;
}

function openingTag(text) {
  const start = /^<([a-z][a-z0-9:-]*)\b/i.exec(text);
  if (!start) return null;
  let index = start[0].length;
  const attributes = [];
  // A quoted title can contain `class="card"` or '>'. Tokenize attribute
  // boundaries instead of letting a regex mistake those strings for attributes.
  while (index < text.length) {
    while (/\s/.test(text[index] || '') && index < text.length) index += 1;
    if (text[index] === '>' || (text[index] === '/' && text[index + 1] === '>')) {
      return { name: start[1].toLowerCase(), attributes, end: index + (text[index] === '/' ? 2 : 1) };
    }
    const name = /^[^\s"'<>/=]+/.exec(text.slice(index));
    if (!name) return null;
    index += name[0].length;
    while (index < text.length && /\s/.test(text[index])) index += 1;
    const attribute = { name: name[0].toLowerCase(), value: '', quoted: false, start: index, end: index };
    if (text[index] === '=') {
      index += 1;
      while (index < text.length && /\s/.test(text[index])) index += 1;
      const quote = ['"', "'"].includes(text[index]) ? text[index++] : null;
      attribute.quoted = quote !== null;
      attribute.start = index;
      if (quote) {
        const end = text.indexOf(quote, index);
        if (end < 0) return null;
        index = end;
      } else {
        while (index < text.length && !/[\s>]/.test(text[index])) index += 1;
      }
      attribute.end = index;
      attribute.value = text.slice(attribute.start, index);
      if (quote) index += 1;
    }
    attributes.push(attribute);
  }
  return null;
}

function sourceTags(source) {
  const tags = [];
  let index = 0;
  while ((index = source.indexOf('<', index)) !== -1) {
    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4);
      index = end < 0 ? source.length : end + 3;
      continue;
    }
    const tag = openingTag(source.slice(index));
    if (tag) {
      if (!['script', 'style', 'title'].includes(tag.name)) tags.push({ ...tag, start: index, end: index + tag.end });
      index += tag.end;
      if (['script', 'style', 'textarea', 'title'].includes(tag.name)) {
        const closing = new RegExp(`</${tag.name}\\s*>`, 'ig');
        closing.lastIndex = index;
        const end = closing.exec(source);
        index = end ? closing.lastIndex : source.length;
      }
    } else index += 1;
  }
  return tags;
}

function classHooks(source) {
  return sourceTags(source).flatMap((tag) => tag.attributes.filter((entry) => entry.name === 'class')
    .flatMap((attribute) => attribute.value.split(/\s+/).filter((value) => CLASS.test(value))));
}

function addClass(before, edit) {
  // Only add a class to one exact opening tag. All other source bytes (including
  // Studio editing markers and Liquid elsewhere) stay untouched.
  const tag = openingTag(edit.match);
  if (!tag || tag.end !== edit.match.length || !/^(?:div|section|article|p|h[1-6]|a|button|img|nav|ul|table|span)$/.test(tag.name) ||
      /[{][{%]|[%}][}]|<!--|[\r\n]/.test(edit.match)) throw new Error('Class edit needs one static opening tag, with no Liquid.');
  const classes = tag.attributes.filter((attribute) => attribute.name === 'class');
  if (classes.length > 1) throw new Error('Duplicate class attributes.');
  const attribute = classes[0];
  if (attribute && !attribute.quoted) throw new Error('Use an existing quoted static class attribute.');
  const tags = sourceTags(before);
  const matches = tags.filter((entry) => before.slice(entry.start, entry.end) === edit.match);
  let replacement;
  if (attribute) {
    const names = attribute.value.split(/\s+/);
    if (names.includes(edit.className)) {
      if (matches.length !== 1) throw new Error(`Class edit must match exactly one opening tag in ${edit.path}.`);
      return before;
    }
    replacement = edit.match.slice(0, attribute.start) + `${attribute.value} ${edit.className}`.trim() + edit.match.slice(attribute.end);
  } else {
    replacement = edit.match.replace(/(\s*\/?>)$/, ` class="${edit.className}"$1`);
  }
  if (matches.length === 0 && tags.filter((entry) => before.slice(entry.start, entry.end) === replacement).length === 1) return before;
  if (matches.length !== 1) throw new Error(`Class edit must match exactly one opening tag in ${edit.path}.`);
  return before.slice(0, matches[0].start) + replacement + before.slice(matches[0].end);
}

function reachableTemplates(context, page) {
  const parentPage = page.rootId ? context.pages.find((entry) => entry.id === page.rootId) : page;
  const pageTemplate = context.pageTemplates.find((entry) => entry.id === (page.templateId || parentPage?.templateId));
  const queue = [page.copyPath];
  const templateIds = [pageTemplate?.webTemplateId];
  if (pageTemplate?.useHeaderFooter !== false) templateIds.push(context.headerTemplateId, context.footerTemplateId);
  for (const id of templateIds.filter(Boolean)) {
    const template = context.templates.find((entry) => entry.id === id);
    if (template) queue.push(template.sourcePath);
  }
  const visited = new Set();
  while (queue.length) {
    const relative = queue.shift();
    if (visited.has(relative)) continue;
    visited.add(relative);
    const absolute = safePath(context.siteRoot, relative);
    if (!fs.existsSync(absolute)) continue;
    const text = readText(absolute);
    for (const match of text.matchAll(/\{%-?\s*(?:include|extends)\s+(['"])(.*?)\1/gi)) {
      const candidates = context.templates.filter((entry) => entry.name === match[2]);
      if (candidates.length > 1) throw new Error(`Ambiguous included web template: ${match[2]}`);
      if (candidates.length === 1) queue.push(candidates[0].sourcePath);
    }
  }
  return visited;
}

function ancestry(context, pageId) {
  const result = [];
  const seen = new Set();
  let page = context.pages.find((entry) => entry.id === pageId);
  if (!page) throw new Error(`Unknown page: ${pageId}`);
  if (page.rootId) page = context.pages.find((entry) => entry.id === page.rootId);
  if (!page) throw new Error('Missing localized page root metadata.');
  while (page) {
    if (seen.has(page.id)) throw new Error('Cycle in page hierarchy.');
    seen.add(page.id);
    result.push(page.id);
    if (!page.parentId) break;
    page = context.pages.find((entry) => entry.id === page.parentId);
    if (!page) throw new Error('Missing ancestor page metadata.');
  }
  return result;
}

function orderedCss(context, pageId) {
  const ancestors = ancestry(context, pageId);
  return context.webFiles.filter((file) => file.isCss && ancestors.includes(file.parentId))
    .sort((a, b) => Number(a.order) - Number(b.order) ||
      ancestors.indexOf(b.parentId) - ancestors.indexOf(a.parentId) || a.path.localeCompare(b.path));
}

function customCssBand(context, pageId) {
  const relevant = orderedCss(context, pageId);
  const theme = relevant.find((file) => /^theme(?:\.min)?\.css$/i.test(file.partialUrl || ''));
  const basic = relevant.find((file) => /^portalbasictheme\.css$/i.test(file.partialUrl || ''));
  if (!theme || !basic || !Number.isInteger(theme.order) || !Number.isInteger(basic.order)) {
    throw new Error('Default CSS order is unavailable; configure the custom Web File in Studio first.');
  }
  return { relevant, theme, basic };
}

function newWebFile(context, style, allocatedIds, reservedOrders) {
  if (!style.fileName) throw new Error('Shared styles need targetId of an existing custom Web File or fileName for a new one.');
  const parentId = style.scope === 'site' ? context.homePageId : style.parentPageId;
  const parent = context.pages.find((entry) => entry.id === parentId && !entry.rootId);
  if (!parent) throw new Error('Choose the non-localized parent page for the CSS Web File.');
  if (context.webFiles.some((file) => file.partialUrl === style.fileName && file.parentId === parentId)) {
    throw new Error('CSS Web File already exists at that URL; use its targetId to reuse it.');
  }
  // Learn specifies the custom band between theme.css and portalbasictheme.css.
  // Preserve both default records; when no integer slot exists, require the maker
  // to configure a custom file instead of silently moving platform-owned files.
  // https://learn.microsoft.com/power-pages/configure/manage-css
  const { relevant, theme, basic } = customCssBand(context, parentId);
  const occupied = new Set([...relevant.map((file) => file.order), ...reservedOrders]);
  let order = theme.order + 1;
  while (occupied.has(order) && order < basic.order) order += 1;
  if (order >= basic.order) throw new Error('No supported custom display-order slot; configure custom ordering in Studio without moving defaults.');
  const exemplar = relevant.find((file) => !file.isDefault) || theme;
  const nested = path.posix.basename(path.posix.dirname(exemplar.path)) === exemplar.filename;
  const base = nested ? path.posix.dirname(path.posix.dirname(exemplar.path)) : path.posix.dirname(exemplar.path);
  const folder = nested ? path.posix.join(base, style.fileName) : base;
  const ids = allocatedIds[style.id] || { id: generateUuid(), annotationId: generateUuid() };
  if (!GUID.test(ids.id) || !GUID.test(ids.annotationId) || !GUID.test(parent.id) || !GUID.test(exemplar.publishingStateId || '')) {
    throw new Error('New Web File requires valid resolved record/attachment/publication identifiers.');
  }
  allocatedIds[style.id] = ids;
  const prefix = exemplar.prefix;
  const metadata = {
    [`${prefix}displayorder`]: order, [`${prefix}enabletracking`]: false,
    [`${prefix}excludefromsearch`]: true, [`${prefix}hiddenfromsitemap`]: true,
    [`${prefix}name`]: style.fileName, [`${prefix}parentpageid`]: parent.id,
    [`${prefix}partialurl`]: style.fileName, [`${prefix}publishingstateid`]: exemplar.publishingStateId,
    [prefix ? 'adx_webfileid' : 'id']: ids.id,
    annotationid: ids.annotationId, filename: style.fileName, isdocument: true,
    mimetype: 'text/css', objectid: ids.id, objecttypecode: 'adx_webfile',
  };
  const text = Object.keys(metadata).sort().map((key) => `${key}: ${metadata[key]}`).join('\n') + '\n';
  return {
    path: path.posix.join(folder, `${style.fileName}.webfile.yml`),
    assetPath: path.posix.join(folder, style.fileName), text, parentId, order,
  };
}

function planHash(plan) {
  const { planHash: ignored, ...data } = plan;
  return hash(JSON.stringify(data));
}

function preparePlan(siteRoot, input, allocatedIds = {}) {
  const request = validateRequest(JSON.parse(JSON.stringify(input)));
  const context = inspectSite(siteRoot);
  if (!context.bootstrap.major) throw new Error(context.warnings.find((warning) => warning.startsWith('Bootstrap')));
  const page = context.pages.find((entry) => entry.id === request.pageId);
  if (!page) throw new Error('Select an existing preview pageId.');
  const writes = new Map();
  const newFiles = new Map();
  function getWrite(relative, kind) {
    const normalized = relative.split('\\').join('/');
    if (!writes.has(normalized)) {
      const absolute = safePath(context.siteRoot, normalized);
      const before = fs.existsSync(absolute) ? readText(absolute) : null;
      writes.set(normalized, { path: normalized, kind, before, after: before || '', beforeHash: before === null ? null : hash(before) });
    }
    const write = writes.get(normalized);
    if (write.kind !== kind) throw new Error('Multiple incompatible operations target the same file.');
    return write;
  }
  const css = compileStyles(request);
  const placements = [];
  for (const style of request.styles) {
    if (style.owner === 'studio') {
      placements.push({ styleId: style.id, owner: 'studio', action: style.studioAction, scope: style.scope });
      continue;
    }
    let target;
    let affectedPageIds;
    if (style.scope === 'page') {
      const selected = context.pages.find((entry) => entry.id === (style.targetId || request.pageId));
      if (!selected || selected.id !== request.pageId) throw new Error('One proposal styles one explicit localized page; use separate proposals for other locales/pages.');
      if (!selected.rootId && context.pages.some((entry) => entry.rootId === selected.id)) throw new Error('Select the intended localized content page, not its root record.');
      target = selected.cssPath;
      affectedPageIds = [selected.id];
    } else {
      const file = context.webFiles.find((entry) => entry.id === style.targetId);
      let parentId;
      if (style.targetId) {
        if (!file || !file.isCss || file.isDefault || !file.assetPresent) throw new Error('Choose an existing custom CSS Web File with a local attachment.');
        const { theme, basic } = customCssBand(context, file.parentId);
        if (!Number.isInteger(file.order) || file.order <= theme.order || file.order >= basic.order) {
          throw new Error('Existing custom CSS is outside the supported display-order band. Choose/configure a custom file between theme.css and portalbasictheme.css without moving defaults.');
        }
        target = file.assetPath;
        parentId = file.parentId;
      } else {
        const key = `${style.scope}:${style.parentPageId || context.homePageId}:${style.fileName}`;
        let created = newFiles.get(key);
        if (!created) {
          created = newWebFile(context, style, allocatedIds, [...newFiles.values()].map((entry) => entry.order));
          if (writes.has(created.path) || writes.has(created.assetPath)) {
            throw new Error('New scoped stylesheets collide on one local path. Choose distinct CSS filenames for different scopes.');
          }
          newFiles.set(key, created);
          const metadata = getWrite(created.path, 'webfile');
          if (metadata.before !== null || fs.existsSync(safePath(context.siteRoot, created.assetPath))) throw new Error('New stylesheet would overwrite an existing artifact.');
          metadata.after = created.text;
        }
        target = created.assetPath;
        parentId = created.parentId;
      }
      if (style.scope === 'site' && parentId !== context.homePageId) throw new Error('Site-wide styles require a root-parented Web File.');
      if (style.scope === 'section' && (parentId === context.homePageId || (style.parentPageId && parentId !== style.parentPageId))) throw new Error('Section scope must match the selected non-root parent.');
      affectedPageIds = context.pages.filter((entry) => ancestry(context, entry.id).includes(parentId)).map((entry) => entry.id);
      if (!affectedPageIds.includes(request.pageId)) throw new Error('The selected preview page is outside the CSS Web File scope.');
    }
    const write = getWrite(target, 'css');
    const sourceBase = target.replace(/\.css$/i, '');
    if (context.files.some((file) => [`${sourceBase}.scss`, `${sourceBase}.sass`, `${sourceBase}.less`].includes(file.path)) ||
        /sourceMappingURL\s*=|generated file|do not edit/i.test(write.before || '')) {
      throw new Error(`Stylesheet is generated or source-owned: ${target}. Edit its source through the existing build pipeline; do not overwrite compiled CSS.`);
    }
    write.after = replaceBlock(write.after, style.id, css.find((entry) => entry.id === style.id).css);
    if (Buffer.byteLength(write.after) > 1024 * 1024) throw new Error('Custom CSS exceeds the Studio 1 MB upload limit.');
    placements.push({ styleId: style.id, owner: 'custom', scope: style.scope, path: target, affectedPageIds });
  }
  const allowedHtml = (relative) => /\.webpage\.copy\.html$|\.webtemplate\.source\.html$/i.test(relative) &&
    context.files.some((file) => file.path === relative);
  for (const edit of request.classEdits || []) {
    const relative = edit.path.split('\\').join('/');
    if (!allowedHtml(relative)) throw new Error('Class edits must target an existing page copy or web-template source.');
    const component = request.components.find((entry) => entry.className === edit.className);
    if (!request.styles.some((style) => style.componentId === component.id && style.owner === 'custom')) {
      throw new Error('Studio-only proposals must not add local markup classes.');
    }
    if (component.sourcePath?.split('\\').join('/') !== relative) throw new Error('Class edits must target their component sourcePath.');
    const write = getWrite(relative, 'class');
    write.after = addClass(write.after, edit);
  }
  const layers = orderedCss(context, request.pageId).map((file) => {
    if (!file.assetPresent) throw new Error(`Missing preview baseline CSS: ${file.assetPath}`);
    if (!Number.isInteger(file.order)) throw new Error(`CSS display order is unknown: ${file.path}. Resolve ordering before preparing the preview.`);
    return { path: file.assetPath, before: readText(safePath(context.siteRoot, file.assetPath)), parentId: file.parentId, order: file.order };
  });
  if (fs.existsSync(safePath(context.siteRoot, page.cssPath))) {
    layers.push({ path: page.cssPath, before: readText(safePath(context.siteRoot, page.cssPath)), pageOnly: true });
  }
  for (const created of newFiles.values()) {
    const index = layers.findIndex((layer) => layer.pageOnly || Number(layer.order) > created.order);
    layers.splice(index < 0 ? layers.length : index, 0, { path: created.assetPath, before: '', parentId: created.parentId, order: created.order });
  }
  if (writes.has(page.cssPath) && !layers.some((layer) => layer.path === page.cssPath)) layers.push({ path: page.cssPath, before: '', pageOnly: true });
  const reachable = reachableTemplates(context, page);
  const components = request.components.map((component) => {
    const relative = component.sourcePath?.split('\\').join('/');
    if (relative && !allowedHtml(relative)) throw new Error('Component sourcePath must identify existing page copy or web-template source.');
    if (relative && /\.webpage\.copy\.html$/i.test(relative) && relative !== page.copyPath) {
      throw new Error('Page components must use the selected localized preview page source.');
    }
    const isTemplate = relative && /\.webtemplate\.source\.html$/i.test(relative);
    if (isTemplate && !reachable.has(relative)) {
      throw new Error('Component web template is not reachable from the selected page. Resolve its page-template/include relationship before applying styling.');
    }
    const before = relative ? readText(safePath(context.siteRoot, relative)) : null;
    const after = relative ? writes.get(relative)?.after ?? before : null;
    if (after !== null && !classHooks(after).includes(component.className)) {
      throw new Error(`Add or resolve the scoped class ${component.className} in its source before applying styles.`);
    }
    return { ...component, before, after, simulation: before === null || Boolean(isTemplate) || /\{[{%]/.test(before) || ['form', 'list'].includes(component.kind) };
  });
  for (const style of request.styles.filter((entry) => entry.owner === 'custom')) {
    const component = components.find((entry) => entry.id === style.componentId);
    if (!component.sourcePath) throw new Error('Applied custom styling requires a real component sourcePath/class hook; sample-only components can preview Studio proposals.');
  }
  const plan = {
    schemaVersion: 1, siteRoot: context.siteRoot, siteId: context.siteId, title: request.title,
    request, allocatedIds, bootstrap: context.bootstrap, inputs: context.files, placements,
    warnings: context.warnings, writes: [...writes.values()].map((write) => ({ ...write, afterHash: hash(write.after) })),
    preview: {
      components,
      layers: layers.map((layer) => ({ ...layer, after: writes.get(layer.path)?.after ?? layer.before })),
      studioCss: compileStyles(request, 'studio').map((entry) => entry.css).join('\n'),
    },
  };
  plan.planHash = planHash(plan);
  return plan;
}

function validatePlan(plan) {
  if (!plan || plan.schemaVersion !== 1 || plan.planHash !== planHash(plan)) throw new Error('Invalid or modified proposal; regenerate and approve the new revision.');
  validateRequest(plan.request);
  if (![3, 5].includes(plan.bootstrap?.major) || !Array.isArray(plan.writes) || !Array.isArray(plan.inputs)) throw new Error('Invalid plan context.');
  const paths = new Set();
  for (const write of plan.writes) {
    safePath(plan.siteRoot, write.path);
    if (paths.has(write.path)) throw new Error('Duplicate write target.');
    paths.add(write.path);
    if (DEFAULT_CSS.test(path.posix.basename(write.path).replace(/\.webfile\.yml$/, ''))) throw new Error('Default stylesheets and metadata are protected.');
    if (!['css', 'class', 'webfile'].includes(write.kind) || typeof write.after !== 'string' ||
        (write.before !== null && typeof write.before !== 'string') ||
        write.afterHash !== hash(write.after) || write.beforeHash !== (write.before === null ? null : hash(write.before))) {
      throw new Error('Invalid change content or hashes.');
    }
    if ((write.kind === 'css' && !/\.css$/.test(write.path)) ||
        (write.kind === 'class' && !/\.webpage\.copy\.html$|\.webtemplate\.source\.html$/.test(write.path)) ||
        (write.kind === 'webfile' && (!/\.webfile\.yml$/.test(write.path) || write.before !== null))) {
      throw new Error('Unsupported write target.');
    }
    if (write.kind === 'css') {
      let expected = write.before || '';
      for (const style of compileStyles(plan.request)) {
        if (plan.placements.some((placement) => placement.styleId === style.id && placement.path === write.path && placement.owner === 'custom')) {
          expected = replaceBlock(expected, style.id, style.css);
        }
      }
      if (expected !== write.after) throw new Error('CSS write contains changes outside its declared managed blocks.');
    }
    if (write.kind === 'class') {
      let expected = write.before;
      for (const edit of plan.request.classEdits || []) if (edit.path.split('\\').join('/') === write.path) expected = addClass(expected, edit);
      if (expected !== write.after) throw new Error('Markup write contains changes beyond the approved class additions.');
    }
  }
  return plan;
}

function saveJson(output, data, siteRoot) {
  const absolute = assertOutsideSite(siteRoot, output);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
  return absolute;
}

module.exports = {
  KINDS, PARTS, VALUES, validateRequest, compileStyles, replaceBlock, addClass, openingTag, classHooks,
  ancestry, orderedCss, preparePlan, validatePlan, planHash, saveJson,
};
