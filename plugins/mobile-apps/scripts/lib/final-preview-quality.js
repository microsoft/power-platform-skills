'use strict';

const {
  isDescendant,
  normalizedText,
  parseHtmlDocument,
} = require('./html-document-lite');
const { finding } = require('./product-experience-contracts');

const MAX_FRAME_EVIDENCE_COUNT = 8;
const MAX_FRAME_EVIDENCE_TEXT = 640;
const MAX_FRAME_VISIBLE_TEXT = 1800;
const COMPONENT_PRESENTATION_PROPERTIES = ['display', 'padding', 'gap', 'background', 'border'];
const CONTRACT_COPY = /\b(?:durable-destination|nested-detail|bounded-flow-step|modal-or-immersive-utility|pack revision|requirement id|scenario evidence)\b/i;
const INVENTED_OFFLINE_UI = /\b(?:offline|pending sync|syncing|retry synchronization|connection lost|queued changes)\b/i;

function hasAttribute(node, name, value = null) {
  return Object.prototype.hasOwnProperty.call(node.attrs, name)
    && (value === null || node.attrs[name] === value);
}

function elementsWith(elements, name, value = null) {
  return elements.filter((node) => hasAttribute(node, name, value));
}

function descendants(elements, ancestor, predicate = () => true) {
  return elements.filter((node) => node !== ancestor
    && isDescendant(node, ancestor)
    && predicate(node));
}

function authoredCss(parsed) {
  return parsed.elements
    .filter((node) => node.tag === 'style' && node.attrs.id !== 'product-experience-token-contract')
    .map((node) => node.text)
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

function cssRules(source) {
  const rules = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const declarations = {};
    for (const raw of match[2].split(';')) {
      const separator = raw.indexOf(':');
      if (separator < 1) continue;
      declarations[raw.slice(0, separator).trim().toLowerCase()] = raw
        .slice(separator + 1)
        .trim()
        .toLowerCase();
    }
    for (const selector of match[1].split(',')) {
      if (selector.trim() && !selector.trim().startsWith('@')) {
        rules.push({ selector: selector.trim(), declarations });
      }
    }
  }
  return rules;
}

function cssTargetCompound(selector) {
  return selector.trim().split(/\s+|>|\+|~/).filter(Boolean).at(-1) || '';
}

function compoundMatchesNode(compound, node) {
  const withoutPseudos = compound.replace(/:{1,2}[a-z-]+(?:\([^)]*\))?/gi, '');
  const tag = withoutPseudos.match(/^[a-z][a-z0-9-]*/i)?.[0]?.toLowerCase();
  if (tag && node.tag !== tag) return false;
  const id = withoutPseudos.match(/#([a-z0-9_-]+)/i)?.[1];
  if (id && node.attrs.id !== id) return false;
  const classes = [...withoutPseudos.matchAll(/\.([a-z0-9_-]+)/gi)].map((match) => match[1]);
  const nodeClasses = new Set(String(node.attrs.class || '').split(/\s+/).filter(Boolean));
  if (classes.some((className) => !nodeClasses.has(className))) return false;
  const attributes = [...withoutPseudos.matchAll(
    /\[([a-z0-9:_-]+)(?:\s*=\s*["']?([^\]"']+)["']?)?\]/gi,
  )];
  for (const [, name, value] of attributes) {
    if (!hasAttribute(node, name.toLowerCase())) return false;
    if (value !== undefined && node.attrs[name.toLowerCase()] !== value.trim()) return false;
  }
  return tag !== undefined || id !== undefined || classes.length > 0
    || attributes.length > 0 || withoutPseudos === '*';
}

function declarationsForNode(rules, node) {
  if (!node) return {};
  return rules
    .filter((rule) => compoundMatchesNode(cssTargetCompound(rule.selector), node))
    .reduce((result, rule) => ({ ...result, ...rule.declarations }), {});
}

function declaresAny(declarations, properties) {
  return properties.some((property) => Object.prototype.hasOwnProperty.call(
    declarations,
    property,
  ));
}

function componentHasPresentation(rules, elements, component) {
  const ownedNodes = descendants(elements, component, (node) => {
    if (hasAttribute(node, 'data-product-component')) return false;
    let current = node.parent;
    while (current && current !== component) {
      if (hasAttribute(current, 'data-product-component')) return false;
      current = current.parent;
    }
    return true;
  });
  return [component, ...ownedNodes].some((node) => declaresAny(
    declarationsForNode(rules, node),
    COMPONENT_PRESENTATION_PROPERTIES,
  ));
}

function structureFingerprint(frame, elements) {
  const nodes = descendants(elements, frame, (node) => (
    hasAttribute(node, 'data-product-component')
    || hasAttribute(node, 'data-viewport-region')
  ));
  return JSON.stringify(nodes.map((node) => {
    let depth = 0;
    let current = node.parent;
    while (current && current !== frame) {
      depth += 1;
      current = current.parent;
    }
    return [
      node.tag,
      depth,
      hasAttribute(node, 'data-product-component'),
      node.attrs['data-viewport-region'] || null,
      hasAttribute(node, 'data-product-component') ? node.children.length : null,
    ];
  }));
}

function validatePageStructure(parsed, expected, errors) {
  const css = authoredCss(parsed);
  const rules = cssRules(css);
  const bodyNode = parsed.elements.find((node) => node.tag === 'body');
  const storyboardNode = parsed.elements.find(
    (node) => node.attrs.id === expected.landmarks.storyboard,
  );
  const frameNodes = elementsWith(parsed.elements, 'data-mobile-frame');
  const componentNodes = elementsWith(parsed.elements, 'data-product-component');
  const navigationNode = parsed.elements.find(
    (node) => node.attrs.id === expected.landmarks.navigation,
  );
  const destinationNodes = elementsWith(parsed.elements, 'data-navigation-destination');
  const body = declarationsForNode(rules, bodyNode);
  const storyboard = declarationsForNode(rules, storyboardNode);

  if (css.trim().length < 160 || rules.length < 4) {
    errors.push(finding('preview-authored-styles-missing',
      'add a substantive authored stylesheet in addition to the generated token contract'));
  }
  if (!/var\(--color-[a-z0-9-]+\)/i.test(css)
    || !/var\(--font-[a-z0-9-]+\)/i.test(css)) {
    errors.push(finding('preview-token-styles-unused',
      'authored CSS must use generated color and typography variables'));
  }
  if (!/@media\s*\(/i.test(css)) {
    errors.push(finding('preview-responsive-style-missing',
      'add an explicit responsive composition rule'));
  }
  if (!declaresAny(body, ['background', 'background-color'])
    || !declaresAny(body, ['font', 'font-family'])
    || !['grid', 'flex'].includes(storyboard.display)
    || !declaresAny(storyboard, ['gap', 'column-gap', 'row-gap'])) {
    errors.push(finding('preview-stylesheet-ineffective',
      'authored CSS must affect page background, typography, and storyboard layout'));
  }
  if (frameNodes.length === 0 || frameNodes.some((node) => {
    const declarations = declarationsForNode(rules, node);
    return !declaresAny(declarations, ['width', 'max-width'])
      || !declaresAny(declarations, ['height', 'min-height', 'aspect-ratio'])
      || !declaresAny(declarations, ['overflow', 'overflow-x', 'overflow-y'])
      || !declaresAny(declarations, ['padding', 'padding-inline', 'padding-block'])
      || !declaresAny(declarations, ['background', 'background-color'])
      || !declaresAny(declarations, ['border', 'box-shadow', 'border-radius']);
  })) {
    errors.push(finding('preview-mobile-frame-style-missing',
      'mobile frames need bounded dimensions, overflow, spacing, surface, and edge treatment'));
  }
  if (componentNodes.length === 0
    || componentNodes.some((node) => !componentHasPresentation(rules, parsed.elements, node))) {
    errors.push(finding('preview-product-components-unstyled',
      'style product component regions rather than exposing raw contract text'));
  }
  const navigation = declarationsForNode(rules, navigationNode);
  if (!['grid', 'flex'].includes(navigation.display)
    || !declaresAny(navigation, ['gap', 'column-gap', 'row-gap', 'justify-content'])
    || destinationNodes.length === 0
    || destinationNodes.some((node) => !declaresAny(
      declarationsForNode(rules, node),
      ['padding', 'background', 'border', 'border-radius', 'color'],
    ))) {
    errors.push(finding('preview-navigation-unstyled',
      'preview navigation and destinations need authored layout and visual treatment'));
  }
  const allScreens = parsed.elements.find(
    (node) => node.attrs.id === expected.landmarks.allScreens,
  );
  const reviews = allScreens
    ? descendants(parsed.elements, allScreens, (node) => node.tag === 'details')
    : [];
  const review = reviews.length === 1
    && !hasAttribute(reviews[0], 'open')
    && descendants(parsed.elements, reviews[0], (node) => node.tag === 'summary').length === 1
    ? reviews[0]
    : null;
  if (!review) {
    errors.push(finding('preview-review-not-collapsed',
      'put complete graph and supporting evidence in one collapsed details review'));
  }
  const indexes = review
    ? descendants(parsed.elements, review, (node) => hasAttribute(node, 'data-screen-index'))
    : [];
  if (indexes.length !== 1) {
    errors.push(finding('preview-screen-index-missing',
      'add one data-screen-index region inside the collapsed review'));
  } else if (!declaresAny(
    declarationsForNode(rules, indexes[0]),
    ['display', 'padding', 'gap', 'border', 'background'],
  )) {
    errors.push(finding('preview-screen-index-unstyled',
      'the complete screen index needs a compact authored treatment'));
  } else if (elementsWith(parsed.elements, 'data-all-screen-id').some(
    (node) => !isDescendant(node, indexes[0]),
  )) {
    errors.push(finding('preview-screen-index-placement-invalid',
      'put every complete-graph screen marker inside data-screen-index'));
  }
  return review;
}

function validateScreenStructure(parsed, expected, review, errors) {
  const metrics = [];
  for (const screen of expected.screens) {
    const screenNode = elementsWith(parsed.elements, 'data-preview-screen-id', screen.screenId)
      .find((node) => !node.hidden);
    if (!screenNode) continue;
    const frames = [screenNode, ...descendants(parsed.elements, screenNode)]
      .filter((node) => hasAttribute(node, 'data-mobile-frame', screen.screenId) && !node.hidden);
    if (frames.length !== 1) {
      errors.push(finding('preview-mobile-frame-missing',
        `${screen.screenId} needs exactly one bounded data-mobile-frame`));
      continue;
    }
    const frame = frames[0];
    const viewports = descendants(parsed.elements, frame, (node) => (
      hasAttribute(node, 'data-first-viewport', screen.screenId) && !node.hidden
    ));
    if (viewports.length !== 1) {
      errors.push(finding('preview-first-viewport-missing',
        `${screen.screenId} needs one data-first-viewport`));
      continue;
    }
    const viewport = viewports[0];
    const expectedRegions = screen.firstViewport?.regionOrder || [];
    const regions = expectedRegions.map((name) => descendants(
      parsed.elements,
      viewport,
      (node) => hasAttribute(node, 'data-viewport-region', name) && !node.hidden,
    ));
    const regionNodes = regions.map((matches) => matches[0]);
    if (regions.some((matches) => matches.length !== 1)
      || regionNodes.some((node, index) => index > 0
        && parsed.elements.indexOf(node) <= parsed.elements.indexOf(regionNodes[index - 1]))) {
      errors.push(finding('preview-first-viewport-hierarchy-invalid',
        `${screen.screenId} must render regions once and in order: ${expectedRegions.join(', ')}`));
    }
    const focalRegion = regionNodes[expectedRegions.indexOf('focal-content')];
    const focal = descendants(parsed.elements, viewport, (node) => (
      hasAttribute(node, 'data-focal-point', screen.screenId) && !node.hidden
    ));
    if (focal.length !== 1 || normalizedText(focal[0]).length < 3
      || (focalRegion && !isDescendant(focal[0], focalRegion))) {
      errors.push(finding('preview-focal-point-invalid',
        `${screen.screenId} needs one meaningful focal point in focal-content`));
    }
    const actionRegion = regionNodes[expectedRegions.indexOf('primary-action')];
    for (const action of screen.primaryActions) {
      const actions = elementsWith(parsed.elements, 'data-primary-action', action.markerId)
        .filter((node) => !node.hidden && isDescendant(node, frame));
      if (actions.length !== 1 || !actionRegion || !isDescendant(actions[0], actionRegion)) {
        errors.push(finding('preview-primary-action-hierarchy-invalid',
          `${screen.screenId} action ${action.label} must be in its first-viewport action region`));
      }
    }
      const emphasizedActions = descendants(parsed.elements, frame, (node) => (
        hasAttribute(node, 'data-primary-emphasis') && !node.hidden
      ));
      if (emphasizedActions.length !== 1
        || emphasizedActions[0].attrs['data-primary-emphasis'] !== screen.primaryActions[0]?.markerId
        || !actionRegion
        || !isDescendant(emphasizedActions[0], actionRegion)) {
        errors.push(finding('preview-primary-action-emphasis-invalid',
          `${screen.screenId} must visibly emphasize exactly its first primary action`));
      }
    const components = descendants(parsed.elements, frame, (node) => (
      hasAttribute(node, 'data-product-component') && !node.hidden
    ));
    if (components.length < 2 || components.some(
      (node) => !String(node.attrs['data-product-component']).trim(),
    )) {
      errors.push(finding('preview-product-components-missing',
        `${screen.screenId} needs at least two named product component regions`));
    }
    if (descendants(parsed.elements, frame, (node) => (
      hasAttribute(node, 'data-signature-component', screen.screenId) && !node.hidden
    )).length !== 1) {
      errors.push(finding('preview-signature-component-missing',
        `${screen.screenId} must realize its signature interaction in the phone frame`));
    }

    const evidence = elementsWith(parsed.elements, 'data-scenario-evidence-id')
      .filter((node) => !node.hidden && isDescendant(node, frame));
    const evidenceText = evidence.reduce((total, node) => total + normalizedText(node).length, 0);
    const frameText = normalizedText(frame).length;
    if ((screen.scenarioEvidence.length > 0 && evidence.length === 0)
      || evidence.length > MAX_FRAME_EVIDENCE_COUNT
      || evidenceText > MAX_FRAME_EVIDENCE_TEXT) {
      errors.push(finding('preview-visible-evidence-excessive',
        `${screen.screenId} phone frame needs 1-${MAX_FRAME_EVIDENCE_COUNT} decision-relevant evidence values and at most ${MAX_FRAME_EVIDENCE_TEXT} evidence characters`));
    }
    if (frameText > MAX_FRAME_VISIBLE_TEXT) {
      errors.push(finding('preview-visible-frame-text-excessive',
        `${screen.screenId} phone frame exceeds ${MAX_FRAME_VISIBLE_TEXT} visible characters; move supporting detail to the collapsed review`));
    }
    for (const item of screen.scenarioEvidence) {
      const markers = elementsWith(parsed.elements, 'data-scenario-evidence-id', item.id)
        .filter((node) => !node.hidden);
      if (markers.length !== 1 || (!isDescendant(markers[0], frame)
        && (!review || !isDescendant(markers[0], review)))) {
        errors.push(finding('preview-evidence-placement-invalid',
          `${screen.screenId} evidence ${item.id} must appear once in its frame or collapsed review`));
      }
    }
    const signatureIntent = elementsWith(
      parsed.elements,
      'data-signature-intent',
      screen.screenId,
    ).filter((node) => !node.hidden);
    const stateEvidence = screen.states.map((state) => elementsWith(
      parsed.elements,
      'data-preview-state',
      `${screen.screenId}:${state.name}`,
    ).filter((node) => !node.hidden));
    if (!review || signatureIntent.length !== 1
      || !isDescendant(signatureIntent[0], review)
      || stateEvidence.some((markers) => (
        markers.length !== 1 || !isDescendant(markers[0], review)
      ))) {
      errors.push(finding('preview-supporting-evidence-not-collapsed',
        `${screen.screenId} signature rationale and every state must appear exactly once in the collapsed review`));
    }
    if (CONTRACT_COPY.test(normalizedText(frame))) {
      errors.push(finding('preview-contract-dump-visible',
        `${screen.screenId} exposes implementation-contract vocabulary in its phone frame`));
    }
    if (INVENTED_OFFLINE_UI.test(normalizedText(frame))) {
      errors.push(finding('preview-invented-offline-ui',
        `${screen.screenId} invents offline runtime UI outside the approved product contracts`));
    }
    metrics.push({
      screenId: screen.screenId,
      evidenceCount: evidence.length,
      evidenceTextLength: evidenceText,
      visibleTextLength: frameText,
      componentCount: components.length,
      structure: structureFingerprint(frame, parsed.elements),
    });
  }
  if (metrics.length > 1 && new Set(metrics.map((item) => item.structure)).size === 1) {
    errors.push(finding('preview-repeated-screen-shell',
      'selected screens repeat one structural shell instead of responding to each screen job'));
  }
  return metrics;
}

function validateStructuralQuality(html, expected, parsedInput = null) {
  const parsed = parsedInput || parseHtmlDocument(html);
  const errors = [];
  const review = validatePageStructure(parsed, expected, errors);
  const frames = validateScreenStructure(parsed, expected, review, errors);
  if (elementsWith(parsed.elements, 'data-requirement-id').some(
    (node) => !review || !isDescendant(node, review),
  )) {
    errors.push(finding('preview-requirements-not-collapsed',
      'exact requirement statements belong in the collapsed review'));
  }
  return {
    errors,
    metrics: {
      selectedScreenCount: expected.screens.length,
      mobileFrameCount: frames.length,
      collapsedReview: Boolean(review),
      frameEvidence: frames.map(({ structure, ...item }) => item),
    },
    parsed,
  };
}

module.exports = {
  MAX_FRAME_EVIDENCE_COUNT,
  MAX_FRAME_EVIDENCE_TEXT,
  MAX_FRAME_VISIBLE_TEXT,
  validateStructuralQuality,
};