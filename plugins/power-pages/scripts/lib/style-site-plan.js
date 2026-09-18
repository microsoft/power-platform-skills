'use strict';

const fs = require('node:fs');
const path = require('node:path');
const generateUuid = require('../generate-uuid');
const { studioSupport, requestWarnings } = require('./studio-style-capabilities');
const { editInlineDeclarations, inlineOverrides, canonicalProperty } = require('./inline-style-edits');
const { analyzeStyle, validateStylesheetOrder } = require('./style-site-css');
const { decodeHTMLAttribute, escapeAttribute } = require('../vendor/css-tools/css-tools.cjs');
const { sourceContext, resolveSourceTarget } = require('./style-site-source-target');
const {
  captureSite, assertSnapshot, snapshotText, safePath, readText, hash, DEFAULT_CSS, assertOutsideSite,
} = require('./classic-site-style-context');

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const CLASS = /^pp-[a-z][a-z0-9-]{0,60}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Power Pages priority guidance is not a numeric Web File metadata constraint.
// https://learn.microsoft.com/power-pages/configure/manage-css
const WEB_FILE_PRIORITY_GUIDANCE = 'Advisory CSS Web File priority: custom CSS has higher priority than theme.css and lower priority than portalbasictheme.css. ' +
  'This is guidance only, not a displayorder check or write prerequisite; ordering metadata is not changed.';

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
    if (component.className !== undefined) {
      if (typeof component.className !== 'string' || !CLASS.test(component.className) || classNames.has(component.className)) throw new Error('Components require distinct pp-* classes.');
      classNames.add(component.className);
    }
    requireString(component.kind, 'component kind', 120);
    requireString(component.label, 'component label');
    if (component.sourcePath !== undefined) requireString(component.sourcePath, 'sourcePath');
    componentIds.add(component.id);
  }
  const ids = new Set();
  for (const style of request.styles) {
    assertKeys(style, ['id', 'componentId', 'owner', 'scope', 'targetId', 'fileName', 'parentPageId', 'part', 'declarations', 'css', 'global', 'externalResources', 'importantReason', 'rationale', 'studioAction', 'handoffReason', 'studioComponent', 'studioFlex', 'location', 'inlineTarget', 'inlineContext'], 'style');
    if (!ID.test(style.id) || ids.has(style.id)) throw new Error('Style IDs must be unique kebab-case identifiers.');
    ids.add(style.id);
    if (!componentIds.has(style.componentId)) throw new Error(`Unknown component: ${style.componentId}`);
    if (!['custom', 'studio'].includes(style.owner)) throw new Error('Each style requires custom (local authoring) or explicitly requested studio handoff ownership.');
    if (!['page', 'site', 'section'].includes(style.scope)) throw new Error('Scope must be page, site, or section.');
    if (style.part !== undefined && typeof style.part !== 'string') throw new Error('Component part must be a CSS selector suffix.');
    requireString(style.rationale, 'styling ownership/placement rationale', 2000);
    if (style.owner === 'studio') {
      requireString(style.studioAction, 'Studio action', 2000);
      if (style.handoffReason !== 'user-requested') {
        throw new Error('Studio support does not require a handoff. Use local custom authoring; instructions-only requests require handoffReason: user-requested.');
      }
      if (style.location !== undefined || style.inlineTarget !== undefined || style.inlineContext !== undefined) throw new Error('Studio handoffs cannot request local placement.');
    } else {
      if (style.studioAction !== undefined || style.handoffReason !== undefined) throw new Error('Local styles must not include Studio handoff fields.');
      if (style.location !== undefined && !['stylesheet', 'inline'].includes(style.location)) throw new Error('Local location must be stylesheet or inline.');
      const component = request.components.find((entry) => entry.id === style.componentId);
      if (style.location === 'inline') {
        requireString(style.inlineTarget, 'inlineTarget', 8000);
        sourceContext(style.inlineContext, style.inlineTarget);
        requireString(component.sourcePath, 'inline component sourcePath');
        if (style.part || ['targetId', 'fileName', 'parentPageId'].some((key) => style[key] !== undefined)) {
          throw new Error('Inline styles target an exact component tag, not a part or stylesheet destination.');
        }
      } else {
        if (!component.className && style.global !== true) throw new Error('Scoped stylesheet components require a pp-* class hook; global themes require explicit global: true.');
        if (style.inlineTarget !== undefined || style.inlineContext !== undefined) throw new Error('inlineTarget/inlineContext require location: inline.');
      }
    }
    if (style.studioComponent !== undefined) requireString(style.studioComponent, 'Studio component', 120);
    if (style.studioFlex !== undefined && (!style.studioComponent || !['available', 'unavailable'].includes(style.studioFlex))) {
      throw new Error('studioFlex requires studioComponent and confirmed available/unavailable status.');
    }
    analyzeStyle(style, request.components.find((entry) => entry.id === style.componentId));
    if (style.owner === 'studio' && style.studioComponent &&
        studioSupport.assessStyle(style).properties.some((property) => property.status === 'unsupported')) {
      throw new Error('This component Design panel does not expose a requested property. Use custom CSS with its warning, or assess a different Studio surface separately.');
    }
    if (style.fileName !== undefined && (!/^[a-z][a-z0-9-]{0,60}\.css$/.test(style.fileName) || DEFAULT_CSS.test(style.fileName))) {
      throw new Error('New stylesheets need a unique, non-default kebab-case .css filename.');
    }
  }
  if (request.classEdits !== undefined && (!Array.isArray(request.classEdits) || request.classEdits.length > 60)) throw new Error('classEdits must contain at most 60 edits.');
  for (const edit of request.classEdits || []) {
    assertKeys(edit, ['path', 'match', 'className', 'context'], 'class edit');
    requireString(edit.path, 'class edit path');
    requireString(edit.match, 'class edit match', 8000);
    sourceContext(edit.context, edit.match);
    if (!classNames.has(edit.className)) throw new Error('Class edits must refer to a requested component class.');
  }
  return request;
}

function compileStyles(request) {
  validateRequest(request);
  return request.styles.filter((style) => style.owner === 'custom' && style.location !== 'inline').map((style) => {
    const component = request.components.find((entry) => entry.id === style.componentId);
    return { id: style.id, css: analyzeStyle(style, component).css };
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
  const block = `${start}${eol}${css.replace(/\r\n|\r|\n/g, eol)}${eol}${end}`;
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

function maskLiquidComments(source) {
  // These regions never become runtime DOM. Keep character offsets/newlines so
  // guarded edits and source-location reports still address the original text.
  return source.replace(/\{%-?\s*comment\b[\s\S]*?\{%-?\s*endcomment\s*-?%\}/gi,
    (comment) => comment.replace(/[^\r\n]/g, ' '));
}

function sourceTags(source) {
  source = maskLiquidComments(source);
  const tags = [];
  const boundary = /<|\{\{|\{%/g;
  let token;
  while ((token = boundary.exec(source))) {
    let index = token.index;
    if (token[0] !== '<') {
      // {% assign example = '<div class="col-md-4">' %} is Liquid code,
      // not a DOM target. Skip the whole expression, including quoted delimiters;
      // markup BETWEEN conditional/loop expressions remains eligible.
      const close = token[0] === '{{' ? '}}' : '%}';
      let quote = null;
      index += 2;
      for (; index < source.length; index += 1) {
        if (quote) {
          if (source[index] === '\\') index += 1;
          else if (source[index] === quote) quote = null;
        } else if (['"', "'"].includes(source[index])) quote = source[index];
        else if (source.startsWith(close, index)) { index += 2; break; }
      }
      boundary.lastIndex = index;
      continue;
    }
    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4);
      boundary.lastIndex = end < 0 ? source.length : end + 3;
      continue;
    }
    const tag = openingTag(source.slice(index));
    if (tag) {
      if (!['script', 'style', 'title'].includes(tag.name)) tags.push({ ...tag, start: index, end: index + tag.end });
      index += tag.end;
      // An iframe's outer element can be styled, but its fallback/raw text is
      // not a local DOM subtree. Never discover hooks or edit tag-shaped text
      // inside embedded browsing contexts or other HTML raw-text elements.
      // https://html.spec.whatwg.org/multipage/parsing.html#parsing-main-inbody
      if (['script', 'style', 'textarea', 'title', 'iframe', 'noembed', 'noframes', 'xmp'].includes(tag.name)) {
        const closing = new RegExp(`</${tag.name}\\s*>`, 'ig');
        closing.lastIndex = index;
        const end = closing.exec(source);
        index = end ? closing.lastIndex : source.length;
      }
    } else index += 1;
    boundary.lastIndex = index;
  }
  return tags;
}

function classHooks(source) {
  return sourceTags(source).flatMap((tag) => tag.attributes.filter((entry) => entry.name === 'class')
    .flatMap((attribute) => attribute.value.split(/\s+/).filter((value) => CLASS.test(value))));
}

function staticTag(match, operation) {
  const tag = openingTag(match);
  if (!tag || tag.end !== match.length || /^(?:script|style|head|title|meta|link|base|template|object|embed)$/.test(tag.name) ||
      /[{][{%]|[%}][}]|<!--/.test(match)) throw new Error(`${operation} needs one static opening tag, with no Liquid.`);
  return tag;
}

function classTag(match, className) {
  const tag = staticTag(match, 'Class edit');
  if (typeof className !== 'string' || !CLASS.test(className)) throw new Error('Class edits require a pp-* class name.');
  const classes = tag.attributes.filter((attribute) => attribute.name === 'class');
  if (classes.length > 1) throw new Error('Duplicate class attributes.');
  const attribute = classes[0];
  if (attribute && !attribute.quoted) throw new Error('Use an existing quoted static class attribute.');
  if (attribute) {
    const names = attribute.value.split(/\s+/);
    if (names.includes(className)) return match;
    return match.slice(0, attribute.start) + `${attribute.value} ${className}`.trim() + match.slice(attribute.end);
  }
  return match.replace(/(\s*\/?>)$/, ` class="${className}"$1`);
}

function addClass(before, edit) {
  const replacement = classTag(edit.match, edit.className);
  const tag = resolveSourceTarget(before, sourceTags(before), edit.match, edit.context, replacement, `Class edit in ${edit.path}`);
  return before.slice(0, tag.start) + replacement + before.slice(tag.end);
}

function inlineTag(match, declarations, components) {
  const tag = staticTag(match, 'Inline edit');
  const attributes = tag.attributes.filter((entry) => entry.name === 'style');
  const classes = tag.attributes.filter((entry) => entry.name === 'class');
  if (attributes.length > 1 || classes.length > 1) throw new Error('Duplicate style/class attributes are not safe inline targets.');
  if (components.some((component) => component.className && !classHooks(match).includes(component.className))) {
    throw new Error('inlineTarget must identify its component class hook; describe a child as a separate component.');
  }
  const attribute = attributes[0];
  if (attribute && !attribute.quoted) throw new Error('Inline styles require a quoted static style attribute.');
  // Page Copy is HTML, not a CSS file. Decode only this style attribute before
  // parsing; encode the replacement for its ORIGINAL quote delimiter. Never
  // interpolate font names, content strings or URLs into raw HTML attributes.
  // https://html.spec.whatwg.org/multipage/syntax.html#attributes-2
  const before = decodeHTMLAttribute(attribute?.value || '');
  const css = editInlineDeclarations(before, declarations);
  if (css === before) return match;
  let after = escapeAttribute(css);
  if (attribute && match[attribute.start - 1] === "'") after = after.replace(/'/g, '&#39;');
  return attribute
    ? match.slice(0, attribute.start) + after + match.slice(attribute.end)
    : match.replace(/(\s*\/?>)$/, ` style="${after}"$1`);
}

function applyMarkup(before, request, relative) {
  const groups = new Map();
  function group(match, context) {
    const guard = sourceContext(context, match);
    const key = JSON.stringify([match, guard]);
    if (!groups.has(key)) groups.set(key, { match, context: guard || undefined, classes: [], styles: [], properties: new Set() });
    return groups.get(key);
  }
  for (const edit of request.classEdits || []) {
    if (edit.path.split('\\').join('/') === relative) group(edit.match, edit.context).classes.push(edit);
  }
  for (const style of request.styles.filter((entry) => entry.owner === 'custom' && entry.location === 'inline')) {
    const component = request.components.find((entry) => entry.id === style.componentId);
    if (component.sourcePath.split('\\').join('/') !== relative) continue;
    const target = group(style.inlineTarget, style.inlineContext);
    for (const name of Object.keys(style.declarations)) {
      const property = canonicalProperty(name);
      if (target.properties.has(property)) throw new Error('Inline groups on one tag must not overlap properties.');
      target.properties.add(property);
    }
    target.styles.push({ style, component });
  }
  const tags = sourceTags(before);
  const replacements = new Map();
  for (const edits of groups.values()) {
    const { match, context } = edits;
    let after = match;
    for (const edit of edits.classes) after = classTag(after, edit.className);
    // Merge disjoint groups before the property edit so declaration ordering and
    // idempotency are independent of how the user split a component's styles.
    const declarations = Object.assign(Object.create(null), ...edits.styles.map(({ style }) => style.declarations));
    if (edits.styles.length) after = inlineTag(after, declarations, edits.styles.map(({ component }) => component));
    const tag = resolveSourceTarget(before, tags, match, context, after, `Markup edit in ${relative}`);
    if (replacements.has(tag.start)) throw new Error('Overlapping markup targets; use the same original tag/context to compose its changes.');
    replacements.set(tag.start, { ...tag, after });
  }
  let result = before;
  for (const edit of [...replacements.values()].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.after + result.slice(edit.end);
  }
  return result;
}

function reachableTemplates(context, page, readSource = (relative) => {
  const absolute = safePath(context.siteRoot, relative);
  return fs.existsSync(absolute) ? readText(absolute) : null;
}) {
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
    const source = readSource(relative);
    if (source === null) continue;
    const text = maskLiquidComments(source).replace(/<!--[\s\S]*?-->/g, '');
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

function applicableCss(context, pageId) {
  const ancestors = ancestry(context, pageId);
  // Stable inventory order only; neither displayorder nor ancestor distance
  // establishes stylesheet inclusion order or effective CSS priority.
  return context.webFiles.filter((file) => file.isCss && ancestors.includes(file.parentId))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function newWebFile(context, style, allocatedIds) {
  if (!style.fileName) throw new Error('Shared styles need targetId of an existing custom Web File or fileName for a new one.');
  const parentId = style.scope === 'site' ? context.homePageId : style.parentPageId;
  const parent = context.pages.find((entry) => entry.id === parentId && !entry.rootId);
  if (!parent) throw new Error('Choose the non-localized parent page for the CSS Web File.');
  if (context.webFiles.some((file) => file.partialUrl === style.fileName && file.parentId === parentId)) {
    throw new Error('CSS Web File already exists at that URL; use its targetId to reuse it.');
  }
  const relevant = applicableCss(context, parentId);
  const exemplar = relevant.find((file) => !file.isDefault) ||
    relevant.find((file) => /^theme(?:\.min)?\.css$/i.test(file.partialUrl || '')) ||
    relevant[0] || context.webFiles.find((file) => file.parentId === parentId) || context.webFiles[0];
  if (!exemplar) throw new Error('New CSS requires an existing local Web File metadata example to establish the export structure.');
  const nested = path.posix.basename(path.posix.dirname(exemplar.path)) === exemplar.filename;
  const base = nested ? path.posix.dirname(path.posix.dirname(exemplar.path)) : path.posix.dirname(exemplar.path);
  const folder = nested ? path.posix.join(base, style.fileName) : base;
  const ids = allocatedIds[style.id] || { id: generateUuid(), annotationId: generateUuid() };
  if (!GUID.test(ids.id) || !GUID.test(ids.annotationId) || !GUID.test(parent.id) || !GUID.test(exemplar.publishingStateId || '')) {
    throw new Error('New Web File requires valid resolved record/attachment/publication identifiers.');
  }
  allocatedIds[style.id] = ids;
  const prefix = exemplar.prefix;
  // Do not allocate displayorder slots or copy one from the exemplar. Styling
  // creates only the required resource metadata and leaves ordering untouched.
  const metadata = {
    [`${prefix}enabletracking`]: false,
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
    assetPath: path.posix.join(folder, style.fileName), text, parentId,
  };
}

function planHash(plan) {
  const { planHash: ignored, ...data } = plan;
  return hash(JSON.stringify(data));
}

function preparePlan(siteRoot, input, allocatedIds = {}) {
  return preparePlanFromSnapshot(captureSite(siteRoot), input, allocatedIds);
}

function preparePlanFromSnapshot(snapshot, input, allocatedIds = {}) {
  const request = validateRequest(JSON.parse(JSON.stringify(input)));
  const { context } = assertSnapshot(snapshot);
  if (!context.bootstrap.major) throw new Error(context.warnings.find((warning) => warning.startsWith('Bootstrap')));
  const page = context.pages.find((entry) => entry.id === request.pageId);
  if (!page) throw new Error('Select an existing pageId for the proposal.');
  const writes = new Map();
  const newFiles = new Map();
  function getWrite(relative, kind) {
    const normalized = relative.split('\\').join('/');
    if (!writes.has(normalized)) {
      const before = snapshotText(snapshot, normalized);
      writes.set(normalized, { path: normalized, kind, before, after: before || '', beforeHash: before === null ? null : hash(before) });
    }
    const write = writes.get(normalized);
    if (write.kind !== kind) throw new Error('Multiple incompatible operations target the same file.');
    return write;
  }
  const css = compileStyles(request);
  const placements = [];
  const webFilePaths = new Set();
  for (const style of request.styles) {
    if (style.owner === 'studio') {
      placements.push({ styleId: style.id, owner: 'studio', action: style.studioAction, scope: style.scope, handoffReason: style.handoffReason });
      continue;
    }
    if (style.location === 'inline') {
      const component = request.components.find((entry) => entry.id === style.componentId);
      const relative = component.sourcePath.split('\\').join('/');
      const template = /\.webtemplate\.source\.html$/i.test(relative);
      if (template ? style.scope !== 'site' : style.scope !== 'page') {
        throw new Error('Inline page edits require page scope; shared-template inline edits require explicit site scope.');
      }
      placements.push({
        styleId: style.id, owner: 'custom', location: 'inline', scope: style.scope, path: relative,
        affectedPageIds: template ? context.pages.map((entry) => entry.id) : [page.id],
        ...(template ? { scopeNote: 'Shared template: conservatively treat every page as potentially affected.' } : {}),
      });
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
        target = file.assetPath;
        parentId = file.parentId;
      } else {
        const key = `${style.scope}:${style.parentPageId || context.homePageId}:${style.fileName}`;
        let created = newFiles.get(key);
        if (!created) {
          created = newWebFile(context, style, allocatedIds);
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
      if (!affectedPageIds.includes(request.pageId)) throw new Error('The selected page is outside the CSS Web File scope.');
      webFilePaths.add(target);
    }
    const write = getWrite(target, 'css');
    // Validate before adding marker comments: their closing delimiters must not
    // accidentally repair an unfinished source comment and hide an ignored rule.
    validateStylesheetOrder(write.after);
    const sourceBase = target.replace(/\.css$/i, '');
    if (context.files.some((file) => [`${sourceBase}.scss`, `${sourceBase}.sass`, `${sourceBase}.less`].includes(file.path)) ||
        /sourceMappingURL\s*=|generated file|do not edit/i.test(write.before || '')) {
      throw new Error(`Stylesheet is generated or source-owned: ${target}. Edit its source through the existing build pipeline; do not overwrite compiled CSS.`);
    }
    write.after = replaceBlock(write.after, style.id, css.find((entry) => entry.id === style.id).css);
    if (Buffer.byteLength(write.after) > 1024 * 1024) throw new Error('Custom CSS exceeds the Studio 1 MB upload limit.');
    placements.push({ styleId: style.id, owner: 'custom', scope: style.scope, path: target, affectedPageIds,
      ...(style.global ? { scopeNote: 'Global stylesheet: all matching elements in the listed pages may be affected, including native components.' } : {}) });
  }
  for (const write of writes.values()) {
    if (write.kind === 'css') validateStylesheetOrder(write.after);
  }
  const allowedHtml = (relative) => /\.webpage\.copy\.html$|\.webtemplate\.source\.html$/i.test(relative) &&
    context.files.some((file) => file.path === relative);
  const markupPaths = new Map();
  for (const edit of request.classEdits || []) {
    const relative = edit.path.split('\\').join('/');
    if (!allowedHtml(relative)) throw new Error('Class edits must target an existing page copy or web-template source.');
    const component = request.components.find((entry) => entry.className === edit.className);
    if (!request.styles.some((style) => style.componentId === component.id && style.owner === 'custom' && style.location !== 'inline')) {
      throw new Error('Studio-only or inline-only proposals must not add unnecessary local markup classes.');
    }
    if (component.sourcePath?.split('\\').join('/') !== relative) throw new Error('Class edits must target their component sourcePath.');
    markupPaths.set(relative, 'class');
  }
  for (const placement of placements.filter((entry) => entry.location === 'inline')) {
    if (!allowedHtml(placement.path)) throw new Error('Inline edits require an existing page copy or web-template source.');
    markupPaths.set(placement.path, 'markup');
  }
  for (const [relative, kind] of markupPaths) {
    const write = getWrite(relative, kind);
    // An explicit leading output banner identifies source-owned markup; text in
    // page content or a nested script comment is not such a banner.
    const banner = /^\s*<!--[\s\S]*?-->/.exec(write.before)?.[0] || '';
    if (/generated file|do not edit/i.test(banner)) {
      throw new Error(`Markup is generated or source-owned: ${relative}. Edit its source through the existing pipeline.`);
    }
    write.after = applyMarkup(write.before, request, relative);
  }
  // Preserve asset-completeness checks without inferring priority from metadata.
  for (const file of applicableCss(context, request.pageId)) {
    if (!file.assetPresent) throw new Error(`Missing baseline CSS: ${file.assetPath}`);
  }
  const reachable = reachableTemplates(context, page, (relative) => snapshotText(snapshot, relative));
  for (const component of request.components) {
    const relative = component.sourcePath?.split('\\').join('/');
    if (relative && !allowedHtml(relative)) throw new Error('Component sourcePath must identify existing page copy or web-template source.');
    if (relative && /\.webpage\.copy\.html$/i.test(relative) && relative !== page.copyPath) {
      throw new Error('Page components must use the selected localized page source.');
    }
    const isTemplate = relative && /\.webtemplate\.source\.html$/i.test(relative);
    if (isTemplate && !reachable.has(relative)) {
      throw new Error('Component web template is not reachable from the selected page. Resolve its page-template/include relationship before applying styling.');
    }
    const before = relative ? snapshotText(snapshot, relative) : null;
    const after = relative ? writes.get(relative)?.after ?? before : null;
    if (after !== null && component.className && !classHooks(after).includes(component.className)) {
      throw new Error(`Add or resolve the scoped class ${component.className} in its source before applying styles.`);
    }
    // Paintbrush declarations often serialize inline and beat a normal stylesheet.
    // Check directly addressable roots/states instead of approving ineffective CSS.
    // Descendant/runtime-generated targets still need explicit source/cascade review.
    // https://learn.microsoft.com/power-pages/getting-started/customize-pages#edit-components
    for (const style of request.styles.filter((entry) => entry.componentId === component.id &&
      entry.owner === 'custom' && entry.location !== 'inline')) {
      const roots = analyzeStyle(style, component).rootDeclarations;
      if (!roots.length) continue;
      for (const tag of sourceTags(after || '').filter((entry) =>
        entry.attributes.some((attribute) => attribute.name === 'class' && attribute.value.split(/\s+/).includes(component.className)))) {
        const attributes = tag.attributes.filter((entry) => entry.name === 'style');
        if (attributes.length > 1 || tag.attributes.filter((entry) => entry.name === 'class').length > 1) {
          throw new Error('Duplicate style/class attributes make the local component cascade ambiguous.');
        }
        const conflicts = [...new Set(roots.flatMap((declarations) =>
          inlineOverrides(decodeHTMLAttribute(attributes[0]?.value || ''), declarations)))];
        if (conflicts.length) {
          throw new Error(`Inline ${conflicts.join(', ')} overrides stylesheet ${style.id}. Update the owning local declaration with a guarded inline edit; do not add ineffective CSS or blindly escalate priority.`);
        }
      }
    }
    if (!component.sourcePath && request.styles.some((style) => style.componentId === component.id && style.owner === 'custom' && !style.global)) {
      throw new Error('Scoped custom styling requires a real component sourcePath/class hook; source-free descriptors require an explicit global stylesheet or Studio handoff.');
    }
  }
  const plan = {
    schemaVersion: 2, siteRoot: context.siteRoot, siteId: context.siteId, title: request.title,
    request, allocatedIds, bootstrap: structuredClone(context.bootstrap), inputs: structuredClone(context.files), placements,
    warnings: [...context.warnings, ...[...webFilePaths].map((file) => `${file}: ${WEB_FILE_PRIORITY_GUIDANCE}`),
      ...requestWarnings(request), ...request.styles.flatMap((style) =>
      analyzeStyle(style, request.components.find((entry) => entry.id === style.componentId)).warnings.map((warning) => `${style.id}: ${warning}`))],
    writes: [...writes.values()].map((write) => ({ ...write, afterHash: hash(write.after) })),
  };
  plan.planHash = planHash(plan);
  return plan;
}

function validatePlan(plan) {
  if (plan?.schemaVersion === 1) throw new Error('Legacy preview proposals cannot authorize writes. Regenerate from the request with --operation prepare and approve the new hash.');
  if (!plan || plan.schemaVersion !== 2 || Object.hasOwn(plan, 'preview') || plan.planHash !== planHash(plan)) {
    throw new Error('Invalid or modified proposal; regenerate and approve the new revision.');
  }
  validateRequest(plan.request);
  if (![3, 5].includes(plan.bootstrap?.major) || !Array.isArray(plan.writes) || !Array.isArray(plan.inputs) ||
      !Array.isArray(plan.warnings) || plan.warnings.some((warning) => typeof warning !== 'string')) throw new Error('Invalid plan context.');
  const paths = new Set();
  const compiled = compileStyles(plan.request);
  for (const write of plan.writes) {
    safePath(plan.siteRoot, write.path);
    if (paths.has(write.path)) throw new Error('Duplicate write target.');
    paths.add(write.path);
    if (DEFAULT_CSS.test(path.posix.basename(write.path).replace(/\.webfile\.yml$/, ''))) throw new Error('Default stylesheets and metadata are protected.');
    if (!['css', 'class', 'markup', 'webfile'].includes(write.kind) || typeof write.after !== 'string' ||
        (write.before !== null && typeof write.before !== 'string') ||
        write.afterHash !== hash(write.after) || write.beforeHash !== (write.before === null ? null : hash(write.before))) {
      throw new Error('Invalid change content or hashes.');
    }
    if ((write.kind === 'css' && !/\.css$/.test(write.path)) ||
        (['class', 'markup'].includes(write.kind) && (!/\.webpage\.copy\.html$|\.webtemplate\.source\.html$/.test(write.path) || write.before === null)) ||
        (write.kind === 'webfile' && (!/\.webfile\.yml$/.test(write.path) || write.before !== null))) {
      throw new Error('Unsupported write target.');
    }
    if (write.kind === 'css') {
      let expected = write.before || '';
      for (const style of compiled) {
        if (plan.placements.some((placement) => placement.styleId === style.id && placement.path === write.path && placement.owner === 'custom')) {
          expected = replaceBlock(expected, style.id, style.css);
        }
      }
      if (expected !== write.after) throw new Error('CSS write contains changes outside its declared managed blocks.');
      validateStylesheetOrder(write.after);
    }
    if (['class', 'markup'].includes(write.kind)) {
      const expected = applyMarkup(write.before, plan.request, write.path);
      if (expected !== write.after) throw new Error('Markup write contains changes beyond the approved class/inline edits.');
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
  validateRequest, compileStyles, replaceBlock, addClass, applyMarkup, openingTag, sourceTags, classHooks,
  reachableTemplates, assertKeys,
  ancestry, applicableCss, preparePlan, preparePlanFromSnapshot, validatePlan, planHash, saveJson,
};
