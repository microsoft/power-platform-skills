'use strict';

const { serializeJson } = require('./render-template');
const { safePath, readText } = require('./classic-site-style-context');
const { KINDS, assertKeys, sourceTags, reachableTemplates } = require('./style-site-plan');

const STYLE_PROPERTIES = [
  'display', 'color', 'background-color', 'font-family', 'font-size',
  'font-weight', 'padding', 'margin', 'border-radius', 'box-shadow',
];

function normalizeRuntimeUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Provide an explicit portal page URL.');
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('Use an HTTPS portal URL without embedded credentials (HTTP is allowed only for loopback fixtures).');
  }
  url.hash = '';
  return url.href;
}

function runtimeOptions(options) {
  if (!options || Object.keys(options).some((key) => !['url', 'selector', 'maxCandidates'].includes(key))) {
    throw new Error('Unsupported runtime inspection options.');
  }
  const url = normalizeRuntimeUrl(options.url);
  const selector = options.selector ?? 'body';
  const maxCandidates = Number(options.maxCandidates ?? 60);
  if (typeof selector !== 'string' || !selector.trim() || selector.length > 500 ||
      !Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 100) {
    throw new Error('Use a nonempty root selector (maximum 500 characters) and 1-100 candidates.');
  }
  return { url, selector, maxCandidates };
}

function inspectRuntimeDom(input) {
  const options = runtimeOptions(input);
  if (normalizeRuntimeUrl(location.href) !== options.url) {
    throw new Error('The browser is on a different URL or a login redirect. Confirm the page before inspecting.');
  }
  if (document.readyState === 'loading') throw new Error('Wait for the approved page to load before inspecting.');
  const roots = document.querySelectorAll(options.selector);
  if (roots.length !== 1) throw new Error('The inspection root must match exactly one element. Narrow the selector.');
  const root = roots[0];
  const candidates = [];
  let scannedElements = 0;
  let omittedBoundaries = 0;
  let truncated = false;
  const candidateTags = new Set(['section', 'article', 'nav', 'header', 'footer', 'form', 'table',
    'button', 'a', 'img', 'input', 'select', 'textarea', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p']);
  const classToken = /^[a-zA-Z_][a-zA-Z0-9_-]{0,119}$/;
  const boundary = (node) => ['iframe', 'object', 'embed', 'script', 'style', 'template', 'noscript', 'svg'].includes(node.localName) ||
    node.localName.includes('-') || Boolean(node.shadowRoot);
  if (boundary(root)) throw new Error('Select a native page wrapper, not an embedded/custom component boundary.');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (boundary(node)) {
        if (++omittedBoundaries > 5000) throw new Error('Too many embedded boundaries. Narrow the inspection root.');
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  function locatorFor(node) {
    const parts = [];
    while (node && node.nodeType === 1 && parts.length < 40) {
      const tag = node.localName;
      if (!/^[a-z][a-z0-9]*$/.test(tag)) return null;
      let index = 1;
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.localName === tag) index += 1;
      }
      parts.unshift(`${tag}:nth-of-type(${index})`);
      node = node.parentElement;
    }
    return node ? null : parts.join(' > ');
  }
  function kindFor(tag, classes) {
    if (tag === 'table' || classes.some((name) => /^(entitylist|entity-grid)$/.test(name))) return 'list';
    if (tag === 'form' || classes.some((name) => /^(entity-form|crmEntityFormView)$/.test(name))) return 'form';
    if (tag === 'button' || (tag === 'a' && classes.includes('btn'))) return 'button';
    if (tag === 'img') return 'image';
    if (['nav', 'header', 'footer'].includes(tag)) return 'navigation';
    if (tag === 'article' || classes.some((name) => /^(card|panel)$/.test(name))) return 'card';
    return /^(h[1-6]|p|span|label|a|input|select|textarea)$/.test(tag) ? 'text' : 'section';
  }
  for (let node = root; node; node = walker.nextNode()) {
    if (++scannedElements > 5000) { scannedElements = 5000; truncated = true; break; }
    if (node.localName === 'input' && ['hidden', 'password', 'file'].includes(node.getAttribute('type')?.toLowerCase())) continue;
    const allClasses = Array.from(node.classList);
    const domId = node.getAttribute('id');
    if (!candidateTags.has(node.localName) && !allClasses.length && !domId) continue;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || node.getClientRects().length === 0) continue;
    if (candidates.length === options.maxCandidates) { truncated = true; break; }
    const classes = allClasses.filter((name) => classToken.test(name)).slice(0, 30);
    // Only structural styling metadata is collected. Never read inner/outerHTML,
    // text, form values, href/src, arbitrary data-* attributes, cookies or storage.
    // DOM IDs can be generated; they are evidence, not persistent CSS selectors.
    candidates.push({
      id: `runtime-${candidates.length + 1}`, kind: kindFor(node.localName, classes), tag: node.localName,
      domId: domId && domId.length <= 200 ? domId : null,
      classes, attributesOmitted: classes.length !== allClasses.length || Boolean(domId && domId.length > 200),
      locator: locatorFor(node),
      computedStyles: Object.fromEntries(STYLE_PROPERTIES.map((property) => [property, style.getPropertyValue(property).slice(0, 250)])),
    });
  }
  const url = new URL(options.url);
  return {
    schemaVersion: 1, source: 'runtime-dom', pageUrl: url.origin + url.pathname,
    queryOmitted: Boolean(url.search), capturedAt: new Date().toISOString(),
    rootSelector: options.selector, scannedElements, truncated, omittedBoundaries, candidates,
  };
}

function buildRuntimeInspection(input) {
  const options = runtimeOptions(input);
  // Feed this code-owned function to the host browser's evaluate tool. The Node
  // command itself never opens a browser, authenticates or makes network calls.
  return `() => {\nconst STYLE_PROPERTIES = ${serializeJson(STYLE_PROPERTIES)};\n` +
    `${normalizeRuntimeUrl.toString()}\n${runtimeOptions.toString()}\n` +
    `return (${inspectRuntimeDom.toString()})(${serializeJson(options)});\n}`;
}

function validateRuntimeSnapshot(snapshot) {
  assertKeys(snapshot, ['schemaVersion', 'source', 'pageUrl', 'queryOmitted', 'capturedAt', 'rootSelector',
    'scannedElements', 'truncated', 'omittedBoundaries', 'candidates'], 'runtime snapshot');
  const shortText = (value, max) => typeof value === 'string' && value.length <= max;
  const url = new URL(normalizeRuntimeUrl(snapshot.pageUrl));
  if (snapshot.schemaVersion !== 1 || snapshot.source !== 'runtime-dom' || snapshot.pageUrl !== url.origin + url.pathname ||
      typeof snapshot.queryOmitted !== 'boolean' || !shortText(snapshot.capturedAt, 30) ||
      !Number.isFinite(Date.parse(snapshot.capturedAt)) || !shortText(snapshot.rootSelector, 500) ||
      !snapshot.rootSelector.trim() || typeof snapshot.truncated !== 'boolean' ||
      !Number.isInteger(snapshot.scannedElements) || snapshot.scannedElements < 0 || snapshot.scannedElements > 5000 ||
      !Number.isInteger(snapshot.omittedBoundaries) || snapshot.omittedBoundaries < 0 || snapshot.omittedBoundaries > 5000 ||
      !Array.isArray(snapshot.candidates) || snapshot.candidates.length > 100) {
    throw new Error('Invalid runtime DOM snapshot. Capture it again using the bundled collector.');
  }
  const ids = new Set();
  for (const candidate of snapshot.candidates) {
    assertKeys(candidate, ['id', 'kind', 'tag', 'domId', 'classes', 'attributesOmitted', 'locator', 'computedStyles'], 'runtime candidate');
    if (!/^runtime-[1-9]\d{0,2}$/.test(candidate.id) || ids.has(candidate.id) || !KINDS.includes(candidate.kind) ||
        !/^[a-z][a-z0-9]{0,30}$/.test(candidate.tag) || !(candidate.domId === null || shortText(candidate.domId, 200)) ||
        !Array.isArray(candidate.classes) || candidate.classes.length > 30 || new Set(candidate.classes).size !== candidate.classes.length ||
        candidate.classes.some((name) => typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_-]{0,119}$/.test(name)) ||
        typeof candidate.attributesOmitted !== 'boolean' || !(candidate.locator === null || shortText(candidate.locator, 2000))) {
      throw new Error('Invalid runtime component metadata.');
    }
    ids.add(candidate.id);
    assertKeys(candidate.computedStyles, STYLE_PROPERTIES, 'computed styles');
    if (Object.keys(candidate.computedStyles).length !== STYLE_PROPERTIES.length ||
        Object.values(candidate.computedStyles).some((value) => !shortText(value, 250))) throw new Error('Invalid computed styles.');
  }
  return snapshot;
}

function attachRuntimeEvidence(context, pageId, input) {
  const snapshot = validateRuntimeSnapshot(input);
  const page = context.pages.find((entry) => entry.id === pageId);
  if (!page) throw new Error('--pageId must select the local page corresponding to the approved runtime URL and language.');
  const reachable = reachableTemplates(context, page);
  const sources = context.files.filter((file) => reachable.has(file.path) &&
    /\.webpage\.copy\.html$|\.webtemplate\.source\.html$/i.test(file.path));
  if (sources.length > 100) throw new Error('Runtime source matching exceeds 100 templates; inspect the component source separately.');
  let tagCount = 0;
  const tags = sources.flatMap((file) => {
    const text = readText(safePath(context.siteRoot, file.path));
    let line = 1;
    let previousOffset = 0;
    return sourceTags(text).map((tag) => {
      if (++tagCount > 10000) throw new Error('Runtime source matching exceeds 10000 tags; inspect the component source separately.');
      line += (text.slice(previousOffset, tag.start).match(/\n/g) || []).length;
      previousOffset = tag.start;
      return {
        path: file.path, hash: file.hash, tag: tag.name, line, offset: tag.start,
        domId: tag.attributes.find((attribute) => attribute.name === 'id')?.value,
        classes: (tag.attributes.find((attribute) => attribute.name === 'class')?.value || '').split(/\s+/),
      };
    });
  });
  return {
    ...snapshot, pageId,
    candidates: snapshot.candidates.map((candidate) => {
      const matches = [];
      for (const tag of tags) {
        if (tag.tag !== candidate.tag) continue;
        const sameId = Boolean(candidate.domId && candidate.domId === tag.domId);
        const classes = candidate.classes.filter((name) => tag.classes.includes(name));
        if (!sameId && !classes.length) continue;
        matches.push({ path: tag.path, sourceHash: tag.hash, line: tag.line, offset: tag.offset, matchedBy: sameId ? 'dom-id' : 'classes', classes });
      }
      return {
        ...candidate, sourceStatus: matches.length === 1 ? 'candidate-match' : matches.length ? 'ambiguous' : 'unresolved',
        sourceMatches: matches.slice(0, 20), additionalSourceMatches: Math.max(0, matches.length - 20),
      };
    }),
    warnings: [
      'Runtime evidence is advisory and may describe a different deployment, language, role or data state. Confirm the URL-to-local-page mapping.',
      'Generated DOM IDs and positional locators are inspection-only. Confirm a stable local class/wrapper; runtime matches do not authorize source edits.',
      'Computed values are not the winning rule source. Inspect the relevant local CSS and native Studio settings before deciding ownership or precedence.',
      ...(snapshot.truncated ? ['The DOM inventory is truncated. Narrow the root selector and capture again before selecting missing targets.'] : []),
    ],
  };
}

module.exports = { STYLE_PROPERTIES, normalizeRuntimeUrl, buildRuntimeInspection, inspectRuntimeDom, validateRuntimeSnapshot, attachRuntimeEvidence };
