'use strict';

const { snapshotText } = require('./classic-site-style-context');
const { sourceTags, reachableTemplates, orderedCss } = require('./style-site-plan');
const { requestSupport } = require('./studio-style-capabilities');

const SUMMARY_BYTES = 4096;
const short = (value) => typeof value === 'string' && value.length > 160 ? `${value.slice(0, 157)}...` : value;

function compactSummary(data) {
  const result = structuredClone(data);
  result.truncated = Boolean(result.truncated);
  // Only summaries are shortened. Full review/evidence artifacts retain every
  // item; a truncated review must be read there before approving its hash.
  while (Buffer.byteLength(JSON.stringify(result, null, 2)) + 1 > SUMMARY_BYTES) {
    const arrays = [];
    function visit(value) {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value) && value.length) arrays.push(value);
      else for (const child of Object.values(value)) visit(child);
    }
    visit(result);
    arrays.sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length);
    if (!arrays.length) throw new Error('Summary headers exceed 4 KB; use shorter artifact paths.');
    arrays[0].splice(Math.floor(arrays[0].length / 2));
    result.truncated = true;
  }
  return result;
}

function selectContext(snapshot, { pageId, page: query, target } = {}) {
  const { context } = snapshot;
  if (pageId && query) throw new Error('Use --pageId or --page, not both.');
  const needle = query?.trim().toLowerCase();
  if (query !== undefined && !needle) throw new Error('--page must contain a page name or path.');
  const pages = context.pages.filter((page) => pageId ? page.id === pageId :
    !needle || [page.name, page.partialUrl, page.path].some((value) => String(value || '').toLowerCase().includes(needle)));
  if ((pageId || needle) && !pages.length) throw new Error('No matching local page; refine --page or select an inspection page ID.');
  const selected = (pageId || needle) && pages.length === 1 ? pages[0] : null;
  if (target && !selected) throw new Error('--target needs one resolved page; select its --pageId first.');
  if (target && !/^[.#]?[a-zA-Z_][a-zA-Z0-9_-]*$/.test(target)) throw new Error('--target must be one literal DOM ID, class or tag, not a CSS expression.');
  const candidates = [];
  if (selected) {
    const hashes = new Map(context.files.map((file) => [file.path, file.hash]));
    const sources = reachableTemplates(context, selected, (relative) => snapshotText(snapshot, relative));
    for (const sourcePath of sources) {
      const source = snapshotText(snapshot, sourcePath);
      if (source === null) continue;
      let line = 1;
      let position = 0;
      for (const tag of sourceTags(source)) {
        line += source.slice(position, tag.start).split('\n').length - 1;
        position = tag.start;
        const id = tag.attributes.find((attribute) => attribute.name === 'id')?.value || '';
        const classes = tag.attributes.filter((attribute) => attribute.name === 'class')
          .flatMap((attribute) => attribute.value.split(/\s+/)).filter((name) => /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name));
        const token = target?.replace(/^[.#]/, '');
        const matches = !target ? id || classes.length :
          target.startsWith('#') ? id === token : target.startsWith('.') ? classes.includes(token) :
            id === token || classes.includes(token) || tag.name === token;
        if (!matches) continue;
        candidates.push({
          tag: tag.name, id: short(id), classes, sourcePath,
          line, offset: tag.start, sourceHash: hashes.get(sourcePath),
        });
      }
    }
  }
  return { pages, selectedPageId: selected?.id ?? null, candidates };
}

function inspectionSummary(context, selection, artifact) {
  const selected = context.pages.find((page) => page.id === selection.selectedPageId);
  const runtime = context.runtime;
  return compactSummary({
    status: 'inspected', artifact: artifact || null, siteRoot: context.siteRoot,
    siteId: context.siteId, siteName: short(context.siteName), bootstrap: context.bootstrap,
    counts: { files: context.files.length, matchingPages: selection.pages.length, targets: selection.candidates.length },
    selectedPageId: selection.selectedPageId,
    pages: selection.pages.map(({ id, name, rootId, languageId, copyPath, cssPath }) =>
      ({ id, name: short(name), rootId, languageId, copyPath, cssPath })),
    targets: selection.candidates,
    css: selected ? orderedCss(context, selected.id).map(({ assetPath, parentId, order, isDefault }) => ({ path: assetPath, parentId, order, isDefault })) : [],
    warnings: context.warnings,
    next: !selected ? 'Select the intended page/locale with --pageId; use --page to narrow omitted pages.' :
      'Candidates are advisory. Confirm source hooks/ownership; use --target to narrow omitted targets.',
    ...(runtime ? { runtime: {
      pageId: runtime.pageId, pageUrl: runtime.pageUrl, capturedAt: runtime.capturedAt,
      rootSelector: runtime.rootSelector, candidateCount: runtime.candidateCount,
      mode: runtime.mode, properties: runtime.properties, omittedBoundaries: runtime.omittedBoundaries,
      truncated: runtime.truncated, candidates: runtime.candidates, warnings: runtime.warnings,
      advisory: 'Runtime matches never authorize a selector or local patch.',
    } } : {}),
  });
}

function classifyRoute(plan) {
  const reasons = [];
  if (plan.request.components.length > 3 || plan.request.styles.length > 10) reasons.push('More than three components or ten style groups.');
  if (plan.request.styles.some((style) => style.scope !== 'page')) reasons.push('Shared or subtree scope.');
  if (plan.request.styles.some((style) => style.css !== undefined)) reasons.push('Authored stylesheet rules require selector, condition and global-definition review.');
  if (plan.request.styles.some((style) => style.global)) reasons.push('Global selectors affect every matching element within the placement scope.');
  if (plan.request.styles.some((style) => style.importantReason)) reasons.push('Explicit CSS priority changes.');
  if (plan.request.styles.some((style) => style.externalResources?.length)) reasons.push('External stylesheet, font or image resources.');
  if (plan.request.components.some((component) => !/\.webpage\.copy\.html$/i.test(component.sourcePath || ''))) reasons.push('Template or source-free descriptor.');
  const css = plan.writes.filter((write) => write.kind === 'css');
  if (css.length > 1 || css.some((write) => write.before === null)) reasons.push('Allows at most one existing page stylesheet.');
  if (!plan.writes.length) reasons.push('Instructions-only handoff.');
  if (plan.writes.some((write) => write.kind === 'webfile')) reasons.push('New Web File metadata.');
  return { name: reasons.length ? 'expanded' : 'small-change', reasons };
}

function replacement(write) {
  const before = write.before ?? '';
  let start = 0;
  while (start < before.length && start < write.after.length && before[start] === write.after[start]) start += 1;
  let end = before.length;
  let afterEnd = write.after.length;
  while (end > start && afterEnd > start && before[end - 1] === write.after[afterEnd - 1]) { end -= 1; afterEnd -= 1; }
  // Exact UTF-16 replacement spans avoid echoing an entire minified page merely
  // to show one class addition. Replacing this span reconstructs the approved file.
  return {
    path: write.path, kind: write.kind, create: write.before === null,
    beforeHash: write.beforeHash, afterHash: write.afterHash, start, deleteCount: end - start,
    removed: before.slice(start, end), inserted: write.after.slice(start, afterEnd),
  };
}

function reviewPlan(plan) {
  return {
    status: 'ready-for-review', planHash: plan.planHash, pageId: plan.request.pageId,
    title: plan.title, bootstrap: plan.bootstrap, route: classifyRoute(plan),
    components: plan.request.components, styles: plan.request.styles, placements: plan.placements,
    ...(plan.request.classEdits?.length ? { classEdits: plan.request.classEdits } : {}),
    studioSupport: requestSupport(plan.request),
    warnings: plan.warnings, studioRuntime: 'pending-separate-live-verification',
    changes: plan.writes.filter((write) => write.before !== write.after).map(replacement),
    approval: 'Review the complete scope, Studio instructions/warnings and exact replacements before approving this planHash. No deployment.',
  };
}

module.exports = { SUMMARY_BYTES, compactSummary, selectContext, inspectionSummary, classifyRoute, reviewPlan };
