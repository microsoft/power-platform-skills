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

function matchingBraceEnd(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
    } else if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return source.length;
}

function actionHandlerSource(source, handlerName) {
  const name = escapeRegExp(handlerName);
  const functionMatch = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(source);
  const assignmentMatch = new RegExp(`\\b(?:const|let)\\s+${name}\\s*=`).exec(source);
  const match = functionMatch || assignmentMatch;
  if (!match) return null;
  let openBrace = -1;
  if (functionMatch) {
    openBrace = source.indexOf('{', match.index + match[0].length);
  } else {
    const arrow = source.indexOf('=>', match.index + match[0].length);
    if (arrow < 0) return null;
    openBrace = source.indexOf('{', arrow + 2);
    const expressionEnd = source.slice(arrow + 2).search(/[;\n]/);
    if (openBrace < 0 || (expressionEnd >= 0 && openBrace > arrow + 2 + expressionEnd)) {
      const end = expressionEnd < 0 ? source.length : arrow + 2 + expressionEnd;
      return source.slice(match.index, end);
    }
  }
  if (openBrace < 0) return null;
  return source.slice(match.index, matchingBraceEnd(source, openBrace));
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
  const aggregateRendered = typeof binding.testId === 'string'
    ? source.includes(`testID="${binding.testId}"`) || source.includes(`testID='${binding.testId}'`)
    : false;
  if (!aggregateRendered) return;
  const focusRefresh = /\buseFocusEffect\s*\(/.test(source)
    || /\baddListener\s*\(\s*['\"]focus['\"]/.test(source);
  const reloadEvidence = /\b(?:load|reload|refresh|refetch|fetch|query|list)[A-Za-z0-9_$]*\b/.test(source);
  if (!focusRefresh || !reloadEvidence) {
    issues.push({ rule: 'aggregate-badge-stale-after-mutation', message: `Screen ${screen.route || screen.id || '<unknown>'} renders a mutation-backed aggregate badge and must revalidate it on route focus.` });
  }
}

function validateStaticEngineeringRules(source, screen, elements, issues, options = {}) {
  const label = screen.route || screen.id || '<unknown>';
  const minimumControlSize = Number.isFinite(options.minimumControlSize) ? options.minimumControlSize : 44;
  if (/\b(?:QueryClientProvider|new\s+QueryClient\s*\()/.test(source)) {
    issues.push({ rule: 'duplicate-query-client', message: `Screen ${label} must use the Query Client owned by PowerAppsProvider.` });
  }
  if (screen.data?.adapter === 'local' && /\bcr[a-z0-9]*_[a-z][a-z0-9_]*\b/i.test(source)) {
    issues.push({ rule: 'provisional-dataverse-identifier', message: `Screen ${label} contains a provisional Dataverse publisher-prefixed identifier.` });
  }
  for (const entity of screen.data?.entities || []) {
    const variable = `${String(entity).replace(/[^A-Za-z0-9_$]/g, '')}s?`;
    if (new RegExp(`\\b(?:const|let)\\s+(?:mock|sample|local|fallback)?${variable}\\s*=\\s*\\[\\s*\\{`, 'i').test(source)) {
      issues.push({ rule: 'screen-local-record-array', message: `Screen ${label} declares replacement ${entity} records instead of using its approved @/data hook.` });
    }
  }
  if (/(?:\:\s*any\b|\bas\s+(?:any\b|unknown\s+as\b)|<any>)/.test(source)) {
    issues.push({ rule: 'unsafe-type-escape', message: `Screen ${label} uses any or a broad unsafe cast.` });
  }
  if (/(?:#[0-9a-f]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(|\$(?:blue|gray|grey|slate|purple|green|red|orange)\d*\b)/i.test(source)) {
    issues.push({ rule: 'raw-starter-color', message: `Screen ${label} uses a raw/starter color instead of an approved semantic token.` });
  }
  if (/\bfontSize\s*(?:=|:)\s*(?:\{\s*)?\d+(?:\.\d+)?/.test(source)) {
    issues.push({ rule: 'arbitrary-typography', message: `Screen ${label} uses an arbitrary font size outside the design recipe's semantic roles.` });
  }
  if (/<(?:Input|TextInput)\b/.test(source) && !/(?:KeyboardAvoidingView|KeyboardAware|useKeyboard|keyboardShouldPersistTaps)/.test(source)) {
    issues.push({ rule: 'keyboard-avoidance-missing', message: `Screen ${label} renders input without an explicit keyboard-avoidance strategy.` });
  }
  if (/\ballowFontScaling\s*=\s*\{\s*false\s*\}/.test(source)) {
    issues.push({ rule: 'dynamic-type-disabled', message: `Screen ${label} disables Dynamic Type on readable text.` });
  }
  if (/\bmaxFontSizeMultiplier\s*=\s*(?:\{\s*)?(?:0(?:\.\d+)?|1(?:\.[0-4]\d*)?)(?:\s*\})?/.test(source)) {
    issues.push({ rule: 'dynamic-type-restricted', message: `Screen ${label} restricts text scaling below the supported accessibility range.` });
  }
  const reducedMotionVariables = [...source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:useReducedMotion|isReduceMotionEnabled)\s*\(/g)]
    .map((match) => match[1]);
  const reducedMotionExpression = (expression, variable) => {
    const escaped = escapeRegExp(variable);
    const noMotion = '(?:undefined|null|false)';
    return new RegExp(`(?:!\\s*)?\\b${escaped}\\b\\s*\\?\\s*${noMotion}\\s*:\\s*[^:]+$|(?:!\\s*)?\\b${escaped}\\b\\s*\\?\\s*[^:]+\\s*:\\s*${noMotion}$`).test(expression.trim());
  };
  const guardedMotionVariables = new Set();
  for (const variable of reducedMotionVariables) {
    const escaped = escapeRegExp(variable);
    for (const match of source.matchAll(new RegExp(`\\bconst\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*([^;\\n]*\\b${escaped}\\b[^;\\n]*\\?[^;\\n]*:[^;\\n]*)`, 'g'))) {
      if (reducedMotionExpression(match[2], variable)) guardedMotionVariables.add(match[1]);
    }
  }
  const motionProps = [...source.matchAll(/\b(?:entering|exiting)\s*=\s*\{([^}]+)\}/g)].map((match) => match[1]);
  const motionCalls = [...source.matchAll(/\b(?:Animated\.timing|Animated\.spring|withTiming|withSpring)\s*\(/g)];
  const guardedProps = motionProps.every((expression) => (
    reducedMotionVariables.some((variable) => reducedMotionExpression(expression, variable))
    || [...guardedMotionVariables].some((variable) => new RegExp(`\\b${escapeRegExp(variable)}\\b`).test(expression))
  ));
  const guardedCalls = motionCalls.every((match) => {
    const prefix = source.slice(Math.max(0, match.index - 320), match.index);
    const callContext = source.slice(Math.max(0, match.index - 160), Math.min(source.length, match.index + 320));
    return reducedMotionVariables.some((variable) => {
      const escaped = escapeRegExp(variable);
      const directTernary = new RegExp(`(?:!\\s*)?\\b${escaped}\\b\\s*\\?\\s*(?:undefined|null|false)\\s*:\\s*(?:Animated\\.timing|Animated\\.spring|withTiming|withSpring)|(?:!\\s*)?\\b${escaped}\\b\\s*\\?\\s*(?:Animated\\.timing|Animated\\.spring|withTiming|withSpring)[\\s\\S]{0,180}?\\s*:\\s*(?:undefined|null|false)`).test(callContext);
      const enclosingBranch = new RegExp(`\\bif\\s*\\(\\s*!\\s*${escaped}\\b[^)]*\\)\\s*\\{[^{}]*$`).test(prefix);
      const earlyReturn = new RegExp(`\\bif\\s*\\(\\s*${escaped}\\b[^)]*\\)\\s*(?:\\{\\s*)?return\\b[^;]*;[^{}]*$`).test(prefix);
      const zeroDuration = new RegExp(`\\bduration\\s*:\\s*${escaped}\\b\\s*\\?\\s*0\\s*:`).test(callContext);
      return directTernary || enclosingBranch || earlyReturn || zeroDuration;
    });
  });
  if ((motionProps.length && !guardedProps) || (motionCalls.length && !guardedCalls)) {
    issues.push({ rule: 'reduced-motion-missing', message: `Screen ${label} uses motion without guarding each animation with the reduced-motion preference.` });
  }
  for (const input of elements.filter((candidate) => /^(?:Input|TextInput)$/.test(candidate.name))) {
    const usableLabelAttribute = (tag, attribute) => {
      const match = tag.match(new RegExp(`\\b${attribute}\\s*=\\s*(?:["']([^"']*)["']|\\{\\s*([^}]+?)\\s*\\})`));
      if (!match) return false;
      if (match[1] !== undefined) return match[1].trim().length > 0;
      const expression = match[2].trim();
      if (/^(?:undefined|null|false|['"]\s*['"])$/.test(expression)) return false;
      if (/^(?:true|false)\s*\?\s*['"]\s*['"]\s*:\s*['"]\s*['"]$/.test(expression)) return false;
      return true;
    };
    const directLabel = ['accessibilityLabel', 'aria-label', 'accessibilityLabelledBy']
      .some((attribute) => usableLabelAttribute(input.openTag, attribute));
    const labelledContainer = elements.some((candidate) => candidate.name === 'FormField'
      && elementContains(candidate, input)
      && usableLabelAttribute(candidate.openTag, 'label'));
    const inputId = input.openTag.match(/\b(?:id|nativeID)\s*=\s*["']([^"']+)["']/)?.[1];
    const matchingLabel = inputId
      && new RegExp(`<Label\\b[^>]*\\bhtmlFor\\s*=\\s*["']${escapeRegExp(inputId)}["'][^>]*>\\s*[^<{\\s][^<]*<\\/Label>`).test(source);
    if (!directLabel && !labelledContainer && !matchingLabel) {
      issues.push({ rule: 'input-label-missing', message: `Screen ${label} has an input without an accessible label or labelled FormField.` });
    }
  }
  for (const element of elements.filter((candidate) => /^(?:Pressable|Touchable)/.test(candidate.name))) {
    if (!/\baccessibilityRole\s*=/.test(element.openTag)) issues.push({ rule: 'custom-control-role-missing', message: `Screen ${label} has a custom touch control without accessibilityRole.` });
    const body = source.slice(element.openEnd, element.closeStart);
    if (!/\baccessibilityLabel\s*=/.test(element.openTag) && !/>\s*[^<{\s][^<{]*</.test(`>${body}<`)) issues.push({ rule: 'custom-control-label-missing', message: `Screen ${label} has an icon-only custom touch control without accessibilityLabel.` });
    if (/\b(?:disabled|selected)\s*=/.test(element.openTag) && !/\baccessibilityState\s*=/.test(element.openTag)) issues.push({ rule: 'custom-control-state-missing', message: `Screen ${label} must expose selected/disabled custom-control state through accessibilityState.` });
  }
  for (const element of elements.filter((candidate) => /(?:Button|Pressable|Touchable)$/.test(candidate.name))) {
    const explicitSizes = [...element.openTag.matchAll(/\b(?:width|height|minWidth|minHeight|minW|minH|w|h)\s*=\s*(?:["']\s*(\d+(?:\.\d+)?)\s*["']|\{\s*(\d+(?:\.\d+)?)\s*\})/g)]
      .map((match) => Number(match[1] || match[2]));
    if (explicitSizes.some((size) => size < minimumControlSize)) issues.push({ rule: 'undersized-touch-target', message: `Screen ${label} contains a control smaller than the ${minimumControlSize}-point design-recipe minimum.` });
  }
}

function validateContextRendering(source, screen, elements, issues) {
  const entries = screen.context?.entries || [];
  if (!entries.length) return;
  const label = screen.route || screen.id || '<unknown>';
  const firstIds = new Set(screen.firstViewport?.regionIds || []);
  const firstRegionElements = (screen.regions || [])
    .filter((region) => firstIds.has(region.id))
    .flatMap((region) => {
      const candidates = regionMarkerCandidates(screen, region);
      return elements.filter((element) => candidates.includes(literalTestId(element.openTag)));
    });
  for (const entry of entries) {
    const marker = entry.testId || `experience-context-${entry.id}`;
    const markerElement = elements.find((element) => literalTestId(element.openTag) === marker);
    if (!markerElement) {
      issues.push({ rule: 'context-entry-not-rendered', message: `Screen ${label} does not render literal marker ${marker}.` });
      continue;
    }
    if (entry.placementIntent === 'primary-screen-context-rail'
      && (!firstRegionElements.length || !firstRegionElements.some((region) => elementContains(region, markerElement)))) {
      issues.push({ rule: 'context-rail-outside-first-viewport', message: `Screen ${label} must render ${marker} inside a marked first-viewport region.` });
    }
    const escapedId = escapeRegExp(entry.id);
    const canonicalBinding = new RegExp(`PROTOTYPE_CONTEXT\\.entries\\s*\\[\\s*['"]${escapedId}['"]\\s*\\]`).test(source);
    if (!canonicalBinding && !source.includes(entry.sampleValue)) {
      issues.push({ rule: 'context-value-not-bound', message: `Screen ${label} must bind ${marker} to PROTOTYPE_CONTEXT or its exact approved sample value.` });
    }
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
  const clearance = screen.primaryAction.clearance;
  if (clearance?.safeArea !== true || bars.every((bar) => !/\bsafeArea(?:\s*=\s*\{\s*true\s*\})?\b/.test(bar.openTag))) {
    issues.push({
      rule: 'sticky-action-safe-area-clearance',
      message: `Screen ${label} must preserve safe-area clearance on BottomActionBar.`,
    });
  }
  if (clearance?.tabBar === 'above' && bars.every((bar) => !/\btabBarClearance\s*=\s*["']above["']/.test(bar.openTag))) {
    issues.push({
      rule: 'sticky-action-tab-bar-clearance',
      message: `Screen ${label} must keep BottomActionBar above the owning tab bar.`,
    });
  }
  const clearanceBinding = source.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*useBottomActionClearance\s*\(/)?.[1];
  if (!clearanceBinding) {
    issues.push({
      rule: 'sticky-content-clearance-missing',
      message: `Screen ${label} must derive scroll clearance with useBottomActionClearance (action + tabs + safe area + spacing).`,
    });
  } else {
    const binding = escapeRegExp(clearanceBinding);
    const contentPadding = new RegExp(`(?:paddingBottom\\s*:\\s*${binding}|pb\\s*=\\s*\\{\\s*${binding}\\s*\\})`).test(source);
    if (!contentPadding) {
      issues.push({
        rule: 'sticky-scroll-padding-missing',
        message: `Screen ${label} must apply ${clearanceBinding} to scroll content bottom padding so the final item clears action, tabs, and safe area.`,
      });
    }
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

function validateProfileAccess(source, screen, elements, issues, options) {
  const policy = options.navigationContract?.globalRoutePolicy;
  if (policy?.profileAccess !== 'header-action' || screen.navigation?.role !== 'durable-destination') return;
  const label = screen.route || screen.id || '<unknown>';
  const shell = elements.find((element) => element.name === 'ScreenShell');
  const hasRightAction = Boolean(shell && /\brightAction\s*=/.test(shell.openTag));
  const hasProfileRoute = source.includes(policy.profileRoute || '/(app)/profile');
  const hasAccessibleLabel = /(?:accessibilityLabel|aria-label)\s*=\s*["'][^"']*profile[^"']*["']/i.test(source)
    || />\s*Profile\s*</i.test(source);
  if (!hasRightAction || !hasProfileRoute || !hasAccessibleLabel) {
    issues.push({
      rule: 'profile-header-action-missing',
      message: `Durable root ${label} must expose a labeled ScreenShell rightAction to ${policy.profileRoute || '/(app)/profile'}.`,
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

function validateExecutableActions(source, screen, elements, issues) {
  const label = screen.route || screen.id || '<unknown>';
  const bindings = screen.actionBindings || [];
  const byId = new Map(bindings.map((binding) => [binding.id, binding]));
  for (const binding of bindings) {
    const actionElement = elements.find((element) => literalTestId(element.openTag) === binding.testId);
    if (!actionElement) {
      issues.push({ rule: 'action-control-missing', message: `Screen ${label} does not render ${binding.testId} for action ${binding.id}.` });
      continue;
    }
    const actionSource = source.slice(actionElement.start, actionElement.end);
    if (!new RegExp(`\\b${escapeRegExp(binding.handlerName)}\\b`).test(actionSource)) {
      issues.push({ rule: 'action-handler-not-wired', message: `Screen ${label} action ${binding.id} is not wired to ${binding.handlerName}.` });
    }
    const handlerSource = actionHandlerSource(source, binding.handlerName);
    if (!handlerSource) issues.push({ rule: 'action-handler-missing', message: `Screen ${label} does not declare ${binding.handlerName}.` });
    if ((binding.availability || []).length) {
      const availabilityDeclaration = new RegExp(`(?:const|let)\\s+${escapeRegExp(binding.availabilityName)}\\s*=`).test(source);
      if (!availabilityDeclaration) issues.push({ rule: 'action-availability-missing', message: `Screen ${label} does not declare ${binding.availabilityName}.` });
      const disabledExpression = actionElement.openTag.match(/\bdisabled\s*=\s*\{([^}]*)\}/)?.[1] || '';
      if (!new RegExp(`\\b${escapeRegExp(binding.availabilityName)}\\b`).test(disabledExpression)) issues.push({ rule: 'action-availability-not-wired', message: `Screen ${label} action ${binding.id} does not bind disabled to ${binding.availabilityName}.` });
      for (const condition of binding.availability) {
        if (condition.reason && !source.includes(condition.reason)) issues.push({ rule: 'action-disabled-reason-missing', message: `Screen ${label} action ${binding.id} does not render its disabled reason.` });
      }
    }
    const executor = binding.executor || {};
    const control = binding.controlHint || {};
    if (control.iconName && !actionSource.includes(control.iconName)) issues.push({ rule: 'action-icon-not-rendered', message: `Screen ${label} action ${binding.id} does not render compiled icon ${control.iconName}.` });
    if (control.labelMode === 'accessible-only' && !/\baccessibilityLabel\s*=\s*(?:["'][^"']+["']|\{[^}]+\})/.test(actionElement.openTag)) issues.push({ rule: 'action-accessible-label-missing', message: `Screen ${label} icon action ${binding.id} requires an accessibilityLabel.` });
    if (control.badge) {
      const valueName = control.badge.valueName;
      if (!valueName || !new RegExp(`(?:const|let)\\s+${escapeRegExp(valueName)}\\s*=`).test(source)) issues.push({ rule: 'action-badge-value-missing', message: `Screen ${label} action ${binding.id} does not declare ${valueName || '<missing badge value>'}.` });
      if (!valueName || !new RegExp(`\\b${escapeRegExp(valueName)}\\b`).test(actionSource)) issues.push({ rule: 'action-badge-not-rendered', message: `Screen ${label} action ${binding.id} does not render its compiled badge value.` });
    }
    if (executor.kind === 'route') {
      const routerCall = new RegExp(`\\brouter\\.${escapeRegExp(executor.intent)}\\s*\\(`).test(handlerSource || '');
      if (!routerCall || !(handlerSource || '').includes(executor.route)) issues.push({ rule: 'action-route-not-executed', message: `Screen ${label} action ${binding.id} does not execute ${executor.intent} to ${executor.route}.` });
    }
    if (['operation', 'connector'].includes(executor.kind)) {
      if (executor.provider === 'generated-service') {
        if (!executor.service || !executor.serviceMethod || !new RegExp(`\\b${escapeRegExp(executor.service)}\\.${escapeRegExp(executor.serviceMethod)}\\s*\\(`).test(handlerSource || '')) issues.push({ rule: 'action-service-not-executed', message: `Screen ${label} action ${binding.id} does not execute ${executor.service || '<missing service>'}.${executor.serviceMethod || '<missing method>'}.` });
      } else {
        if (!executor.hook || !new RegExp(`\\b${escapeRegExp(executor.hook)}\\s*\\(`).test(source)) issues.push({ rule: 'action-hook-missing', message: `Screen ${label} action ${binding.id} does not initialize ${executor.hook || '<missing hook>'}.` });
        const expectedCall = executor.mode === 'query' ? /\.refetch\s*\(/ : /\.mutate(?:Async)?\s*\(/;
        if (!expectedCall.test(handlerSource || '')) issues.push({ rule: 'action-operation-not-executed', message: `Screen ${label} action ${binding.id} does not execute its ${executor.mode || 'mutation'} hook.` });
      }
    }
    if (executor.kind === 'native' && !new RegExp(`\\b${escapeRegExp(executor.command)}\\s*\\(`).test(handlerSource || '')) issues.push({ rule: 'action-native-command-missing', message: `Screen ${label} action ${binding.id} does not call native command ${executor.command}.` });
    if (['local', 'host'].includes(executor.kind) && (!executor.commandName || !new RegExp(`\\b${escapeRegExp(executor.commandName)}\\s*\\(`).test(handlerSource || ''))) issues.push({ rule: 'action-command-not-executed', message: `Screen ${label} action ${binding.id} does not execute ${executor.commandName || '<missing command>'}.` });
    if (executor.kind === 'sequence') {
      for (const step of executor.steps || []) {
        const stepBinding = byId.get(step);
        if (!stepBinding) issues.push({ rule: 'action-sequence-step-unresolved', message: `Screen ${label} sequence ${binding.id} has no compiled same-screen binding for ${step}.` });
        else if (!new RegExp(`\\b${escapeRegExp(stepBinding.handlerName)}\\b`).test(handlerSource || '')) issues.push({ rule: 'action-sequence-step-missing', message: `Screen ${label} sequence ${binding.id} does not reference ${stepBinding.handlerName}.` });
      }
    }
  }
}

function validateScreenSourceContract(source, screen, options = {}) {
  const issues = [];
  if (typeof source !== 'string' || !screen) return issues;
  const elements = jsxElements(source);
  if (/\btoExperienceRecord\s*\(/.test(source)) issues.push({ rule: 'legacy-presentation-adapter', message: `Screen ${screen.route || screen.id || '<unknown>'} must use canonical domain records directly.` });
  validateStaticEngineeringRules(source, screen, elements, issues, options);
  validateContextRendering(source, screen, elements, issues);
  validateStickyAction(source, screen, elements, issues);
  validateProfileAccess(source, screen, elements, issues, options);
  validateVisiblePrimaryAction(source, screen, elements, issues);
  validateFirstViewportSource(source, screen, elements, issues);
  validateExecutableActions(source, screen, elements, issues);
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
  actionHandlerSource,
  actionMarkerCandidates,
  jsxElements,
  regionMarkerCandidates,
  validateProfileAccess,
  validateExecutableActions,
  validateStaticEngineeringRules,
  validateScreenSourceContract,
};
