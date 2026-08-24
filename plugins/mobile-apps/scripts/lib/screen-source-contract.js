'use strict';

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function slug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function findTagEnd(source, start) {
  let quote = null;
  let escaped = false;
  let braceDepth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '{') braceDepth += 1;
    else if (char === '}') braceDepth = Math.max(0, braceDepth - 1);
    else if (char === '>' && braceDepth === 0) return index;
  }
  return -1;
}

/**
 * Small JSX structure reader for contract checks. It intentionally understands
 * only component tags and literal opening-tag attributes; TypeScript remains
 * the authority for syntax. This avoids pretending that regexes can render or
 * measure a native layout while still catching clear parent/child mistakes.
 */
function jsxElements(source) {
  const elements = [];
  const stack = [];
  const tagStart = /<\s*(\/?)\s*([A-Z][A-Za-z0-9_.]*)\b/g;
  let match;
  while ((match = tagStart.exec(source)) !== null) {
    const end = findTagEnd(source, tagStart.lastIndex);
    if (end < 0) break;
    const closing = match[1] === '/';
    const name = match[2];
    const tag = source.slice(match.index, end + 1);
    tagStart.lastIndex = end + 1;
    if (closing) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].name !== name) continue;
        const element = stack[index];
        stack.splice(index, 1);
        element.closeStart = match.index;
        element.end = end + 1;
        break;
      }
      continue;
    }
    const element = {
      name,
      start: match.index,
      openEnd: end + 1,
      openTag: tag,
      closeStart: end + 1,
      end: end + 1,
    };
    elements.push(element);
    if (!/\/\s*>$/.test(tag)) stack.push(element);
  }
  for (const element of stack) {
    element.closeStart = source.length;
    element.end = source.length;
  }
  return elements;
}

function literalTestId(openTag) {
  return openTag.match(/\btestID\s*=\s*["']([^"']+)["']/)?.[1] || null;
}

function elementContains(outer, inner) {
  return outer.start <= inner.start && inner.end <= outer.end;
}

function screenShellDisablesImplicitScroll(elements) {
  const shell = elements.find((element) => element.name === 'ScreenShell');
  return Boolean(shell && /\bscroll\s*=\s*\{\s*false\s*\}/.test(shell.openTag));
}

function actionMarkerCandidates(screen) {
  const actionSlug = slug(screen.primaryAction?.id);
  const declared = (screen.testIds || []).filter((testId) => {
    const marker = slug(testId);
    return marker === 'experience-primary-action'
      || marker.includes('primary-action')
      || (actionSlug.length >= 3 && marker.includes(actionSlug));
  });
  return [...new Set([
    ...declared,
    'experience-primary-action',
    actionSlug,
    actionSlug ? `${actionSlug}-button` : '',
  ].filter(Boolean))];
}

function regionMarkerCandidates(screen, region) {
  const regionSlug = slug(region.id);
  const matches = (screen.testIds || []).filter((testId) => {
    const marker = slug(testId);
    if (marker.includes('primary-action')) return false;
    return marker === regionSlug
      || marker === `experience-region-${regionSlug}`
      || (regionSlug.length >= 3 && marker.includes('region') && marker.endsWith(regionSlug));
  });
  if (screen.role === 'primary') {
    const canonical = `experience-region-${regionSlug}`;
    if (!matches.includes(canonical)) matches.unshift(canonical);
  }
  return [...new Set(matches)];
}

function hasMediaComponent(source) {
  return /<(?:EntityImage|Image|ExpoImage|[A-Z][A-Za-z0-9]*(?:Media|Image|Photo|Illustration|Gallery|Artwork)[A-Za-z0-9]*)\b/.test(source)
    || /<[A-Z][A-Za-z0-9]*\b[^>]*\b(?:media|image)(?:Records|Items|Sources?|Assets?)\s*=/.test(source);
}

function hasFixedMinimumHeight(source) {
  return /\b(?:minH|minHeight)\s*=/.test(source)
    || /\bminHeight\s*:/.test(source);
}

function hasFixedVerticalExtent(source) {
  return hasFixedMinimumHeight(source)
    || /\b(?:h|height)\s*=\s*(?:["']\s*\d+(?:\.\d+)?\s*["']|\{\s*\d+(?:\.\d+)?\s*\})/.test(source)
    || /\bheight\s*:\s*\d+(?:\.\d+)?\b/.test(source);
}

function hasResponsiveAspectRatio(source) {
  return /\b(?:aspectRatio|maxAspectRatio)\s*=/.test(source)
    || /\baspectRatio\s*:/.test(source)
    || /<AspectRatio\b/.test(source);
}

function hasViewportClamp(source) {
  return /\b(?:maxH|maxHeight|maxViewportShare|viewportShare)\s*=/.test(source)
    || /\bmaxHeight\s*:/.test(source)
    || /\b(?:Math\.min|clamp)\s*\(/.test(source);
}

function rangeContainsAction(source, range, screen, elements) {
  const markers = actionMarkerCandidates(screen);
  if (elements.some((element) => elementContains(range, element) && markers.includes(literalTestId(element.openTag)))) return true;
  const content = source.slice(range.start, range.end);
  const label = screen.primaryAction?.label;
  return typeof label === 'string' && label.length > 0 && new RegExp(escapeRegExp(label), 'i').test(content);
}

function validateVisiblePrimaryAction(source, screen, elements, issues) {
  if (!screen.primaryAction || screen.primaryAction.placement === 'sticky-bottom') return;
  const label = screen.route || screen.id || '<unknown>';
  const firstIds = new Set(screen.firstViewport?.regionIds || []);
  const firstRegions = (screen.regions || []).filter((region) => firstIds.has(region.id));
  const firstElements = firstRegions.flatMap((region) => {
    const candidates = regionMarkerCandidates(screen, region);
    return elements.filter((element) => candidates.includes(literalTestId(element.openTag)));
  });
  const markers = actionMarkerCandidates(screen);
  const hasMarker = elements.some((element) => markers.includes(literalTestId(element.openTag)));
  const hasLiteralLabel = typeof screen.primaryAction.label === 'string'
    && new RegExp(escapeRegExp(screen.primaryAction.label), 'i').test(source);
  if (!hasMarker && !hasLiteralLabel) {
    issues.push({
      rule: 'missing-visible-primary-action',
      message: `Screen ${label} contracts a visible ${screen.primaryAction.placement} primary action but its marker or label is absent from the rendered source.`,
    });
    return;
  }
  if (screen.primaryAction.placement === 'inline'
    && !firstElements.some((element) => rangeContainsAction(source, element, screen, elements))) {
    issues.push({
      rule: 'inline-action-below-first-viewport',
      message: `Screen ${label} contracts an inline primary action, but it is not inside a marked first-viewport region.`,
    });
  }
}

function hasHardCodedCurrencyExpression(source) {
  const amount = '(?:price|amount|total|cost|subtotal|unitPrice|lineTotal)';
  return new RegExp(`[€£¥₹]\\s*(?:\\$?\\{[^}\\n]*${amount}|[+][^\\n;]*${amount})`, 'i').test(source)
    || new RegExp(`${amount}[^\\n;]{0,80}[+].{0,12}[€£¥₹]`, 'i').test(source);
}

function derivedPredicateVariables(source, predicate) {
  const variables = new Set();
  const pattern = new RegExp(`\\b(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*!?\\s*${escapeRegExp(predicate)}\\s*\\(`, 'g');
  let match;
  while ((match = pattern.exec(source)) !== null) variables.add(match[1]);
  return variables;
}

function validateAvailabilityBinding(source, screen, elements, issues) {
  const binding = screen.data?.runtimeBindings?.availability;
  if (binding?.required !== true) return;
  const label = screen.route || screen.id || '<unknown>';
  const predicate = binding.predicate || 'isDomainRecordActionable';
  if (!new RegExp(`\\b${escapeRegExp(predicate)}\\s*\\(`).test(source)) {
    issues.push({ rule: 'availability-predicate-missing', message: `Screen ${label} must derive its primary-action availability from ${predicate} and the canonical domain record.` });
    return;
  }
  const variables = derivedPredicateVariables(source, predicate);
  const markers = actionMarkerCandidates(screen);
  const marked = elements.filter((element) => markers.includes(literalTestId(element.openTag)));
  const scopes = marked.length ? marked : elements.filter((element) => /Button|Pressable|Touchable/.test(element.name)
    && new RegExp(escapeRegExp(screen.primaryAction?.label || ''), 'i').test(source.slice(element.start, element.end)));
  const actionable = elements.filter((element) => /Button|Pressable|Touchable/.test(element.name)
    && (scopes.includes(element) || scopes.some((scope) => elementContains(scope, element))));
  const disabled = actionable.some((element) => {
    const expression = element.openTag.match(/\bdisabled\s*=\s*\{([^}]*)\}/)?.[1] || '';
    return new RegExp(`\\b${escapeRegExp(predicate)}\\s*\\(`).test(expression)
      || [...variables].some((variable) => new RegExp(`\\b${escapeRegExp(variable)}\\b`).test(expression));
  });
  if (!disabled) {
    issues.push({ rule: 'unavailable-primary-action-enabled', message: `Screen ${label} must bind disabled on primary action ${binding.disabledActionId || screen.primaryAction?.id} to ${predicate}.` });
  }
}

function validateRelatedMediaBinding(source, screen, issues) {
  const binding = screen.data?.runtimeBindings?.relatedMedia;
  if (binding?.required !== true) return;
  const label = screen.route || screen.id || '<unknown>';
  const relationUsed = /\bresolveDomainMedia\s*\(/.test(source)
    || /<[A-Z][A-Za-z0-9]*\b[^>]*\b(?:media|image)Records\s*=/.test(source);
  if (!relationUsed) {
    issues.push({ rule: 'dead-related-media-relationship', message: `Screen ${label} must render canonical domain media through ${binding.resolver || 'resolveDomainMedia'} or pass repository media records to its foundation primitive.` });
  }
}

function validateAggregateFreshness(source, screen, issues) {
  const binding = screen.data?.runtimeBindings?.aggregateFreshness;
  if (binding?.requiredWhenRendered !== true) return;
  const aggregateRendered = /<Badge\b|\b[A-Za-z_$][\w$]*(?:Badge|Count)\b|\b(?:cart|bag|basket|saved|selection|favorite|notification|message)[A-Za-z0-9_$]*\.length\b/i.test(source);
  if (!aggregateRendered) return;
  const focusRefresh = /\buseFocusEffect\s*\(/.test(source)
    || /\baddListener\s*\(\s*['\"]focus['\"]/.test(source);
  const reloadEvidence = /\b(?:load|reload|refresh|refetch|fetch|query|list)[A-Za-z0-9_$]*\b/.test(source);
  if (!focusRefresh || !reloadEvidence) {
    issues.push({ rule: 'aggregate-badge-stale-after-mutation', message: `Screen ${screen.route || screen.id || '<unknown>'} renders a mutation-backed aggregate badge and must revalidate it on route focus.` });
  }
}

function validateStickyAction(source, screen, elements, issues) {
  if (screen.primaryAction?.placement !== 'sticky-bottom') return;
  const label = screen.route || screen.id || '<unknown>';
  const bars = elements.filter((element) => element.name === 'BottomActionBar');
  if (!bars.length) {
    issues.push({
      rule: 'sticky-action-missing-bottom-bar',
      message: `Screen ${label} contracts a sticky-bottom primary action but does not render BottomActionBar.`,
    });
    return;
  }
  if (!screenShellDisablesImplicitScroll(elements)) {
    issues.push({
      rule: 'sticky-action-scroll-owner',
      message: `Screen ${label} must use ScreenShell scroll={false} so BottomActionBar is not placed inside the shell's scroll content.`,
    });
  }
  const scrollViews = elements.filter((element) => element.name === 'ScrollView');
  if (bars.every((bar) => scrollViews.some((scroll) => elementContains(scroll, bar)))) {
    issues.push({
      rule: 'sticky-action-inside-scroll',
      message: `Screen ${label} renders every BottomActionBar inside ScrollView; sticky-bottom must be a sibling of scrollable content.`,
    });
  }

  const markers = actionMarkerCandidates(screen);
  const actionElements = elements.filter((element) => markers.includes(literalTestId(element.openTag)));
  const actionInsideBar = actionElements.some((action) => bars.some((bar) => elementContains(bar, action)));
  const labelInsideBar = bars.some((bar) => {
    const content = source.slice(bar.start, bar.end);
    return typeof screen.primaryAction?.label === 'string'
      && new RegExp(escapeRegExp(screen.primaryAction.label), 'i').test(content);
  });
  if (!actionInsideBar && !labelInsideBar) {
    issues.push({
      rule: 'sticky-action-content-drift',
      message: `Screen ${label} has a BottomActionBar, but the contracted ${screen.primaryAction.label} action is not evidenced inside it.`,
    });
  }
}

function validateFirstViewportSource(source, screen, elements, issues) {
  const label = screen.route || screen.id || '<unknown>';
  const firstIds = new Set(screen.firstViewport?.regionIds || []);
  const firstRegions = (screen.regions || []).filter((region) => firstIds.has(region.id));
  for (const region of firstRegions) {
    const candidates = regionMarkerCandidates(screen, region);
    if (!candidates.length) continue;
    const regionElement = elements.find((element) => candidates.includes(literalTestId(element.openTag)));
    if (!regionElement) {
      issues.push({
        rule: 'missing-first-viewport-marker',
        message: `Screen ${label} does not render a literal runtime marker for first-viewport region ${region.id}.`,
      });
      continue;
    }
    if (!region.mediaRequired) continue;
    const regionSource = source.slice(regionElement.start, regionElement.end);
    const containsMedia = hasMediaComponent(regionSource);
    if (!containsMedia) {
      issues.push({
        rule: 'blank-required-media-region',
        message: `Screen ${label} first-viewport region ${region.id} requires media but contains no media component. A color block or icon-only surface is not sufficient.`,
      });
    }
    const mediaElements = elements.filter((element) => elementContains(regionElement, element)
      && /(?:Media|Image|Photo|Illustration|Gallery|Artwork)$/.test(element.name));
    const mediaLayoutSource = [regionElement.openTag, ...mediaElements.map((element) => element.openTag)].join('\n');
    const structurallyFixed = hasFixedMinimumHeight(regionElement.openTag)
      || mediaElements.some((element) => hasFixedMinimumHeight(element.openTag))
      || (!containsMedia && hasFixedMinimumHeight(regionSource));
    if (firstRegions.length > 1 && structurallyFixed) {
      issues.push({
        rule: 'minimum-height-first-viewport-media',
        message: `Screen ${label} fixes a minimum height inside media region ${region.id} while other regions must share the first viewport. Use a responsive aspect ratio and verify actual fit in native review.`,
      });
    }
    if (screen.media?.sizing === 'responsive-clamped') {
      if (hasFixedVerticalExtent(mediaLayoutSource)) {
        issues.push({
          rule: 'fixed-first-viewport-media-height',
          message: `Screen ${label} gives media region ${region.id} a fixed vertical extent even though the build pack requires responsive-clamped sizing.`,
        });
      }
      if (!hasResponsiveAspectRatio(mediaLayoutSource)) {
        issues.push({
          rule: 'missing-responsive-media-aspect',
          message: `Screen ${label} media region ${region.id} must preserve its contracted aspect ratio instead of relying on unconstrained height.`,
        });
      }
      if (!hasViewportClamp(mediaLayoutSource)) {
        issues.push({
          rule: 'missing-media-viewport-clamp',
          message: `Screen ${label} media region ${region.id} must expose a max-height or viewport-share clamp so later first-viewport regions remain visible.`,
        });
      }
    }
  }
}

function validateScreenSourceContract(source, screen) {
  const issues = [];
  if (typeof source !== 'string' || !screen) return issues;
  const elements = jsxElements(source);
  if (/\btoExperienceRecord\s*\(/.test(source)) issues.push({ rule: 'legacy-presentation-adapter', message: `Screen ${screen.route || screen.id || '<unknown>'} must use canonical domain records directly.` });
  validateStickyAction(source, screen, elements, issues);
  validateVisiblePrimaryAction(source, screen, elements, issues);
  validateFirstViewportSource(source, screen, elements, issues);
  validateAvailabilityBinding(source, screen, elements, issues);
  validateRelatedMediaBinding(source, screen, issues);
  validateAggregateFreshness(source, screen, issues);
  if (hasHardCodedCurrencyExpression(source)) {
    issues.push({
      rule: 'hard-coded-currency-symbol',
      message: `Screen ${screen.route || screen.id || '<unknown>'} hard-codes a currency symbol next to a price expression. Format the canonical amount with its data currency code through a shared currency formatter.`,
    });
  }
  return issues;
}

module.exports = {
  actionMarkerCandidates,
  jsxElements,
  regionMarkerCandidates,
  validateScreenSourceContract,
};
