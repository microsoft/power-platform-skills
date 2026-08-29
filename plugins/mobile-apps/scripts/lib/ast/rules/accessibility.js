'use strict';

/**
 * Rule: mobile accessibility and touch-target contracts.
 *
 * JSX shape decides these, so they belong in the AST layer even though they are
 * not data-flow rules: the regex version matched attribute text inside nested
 * children, mis-parsed generic components (`<Picker<Row> … />`), and could not
 * see that an "icon-only" button actually renders a label from a child
 * component. Spread props (`{...rest}`) hide attributes entirely, which is now
 * reported as `unknown` instead of a block.
 */

const TAPPABLE_TAGS = new Set([
  'Button',
  'Pressable',
  'Stack',
  'TouchableHighlight',
  'TouchableOpacity',
  'TouchableWithoutFeedback',
  'View',
  'XStack',
  'YStack',
  'ZStack',
]);

const CUSTOM_STACK_TAGS = new Set(['XStack', 'YStack', 'ZStack', 'Stack']);
const LABEL_ATTRIBUTES = ['aria-label', 'accessibilityLabel', 'title', 'label'];
const SMALL_SIZE_RE = /^\$[12]$/;

module.exports = {
  id: 'accessibility',

  appliesTo(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    if (!/\.(?:jsx|tsx)$/.test(normalized)) return false;
    if (normalized.includes('/shared/samples/')) return false;
    if (/\/_layout\.tsx$/.test(normalized)) return false;
    return normalized.includes('/app/') || normalized.includes('/src/components/');
  },

  run(context, sourceFile) {
    const { jsx } = context;

    jsx.forEachJsxElement(sourceFile, (element) => {
      checkFontScaling(context, sourceFile, element);
      checkIconOnlyButton(context, sourceFile, element);
      checkTouchTargetSize(context, sourceFile, element);
      checkCustomPressableRole(context, sourceFile, element);
      checkNestedTouchTargets(context, sourceFile, element);
    });
  },
};

function checkFontScaling(context, sourceFile, element) {
  const { ts, jsx } = context;
  const attribute = jsx.attributeNamed(element, 'allowFontScaling');
  if (!attribute || !attribute.initializer) return;
  const expression = ts.isJsxExpression(attribute.initializer)
    ? attribute.initializer.expression
    : attribute.initializer;
  if (!expression || expression.kind !== ts.SyntaxKind.FalseKeyword) return;
  context.report(sourceFile, element, {
    status: 'fail',
    rule: 'dynamic-type-disabled',
    message:
      'allowFontScaling={false} disables system text scaling. Let text scale and use numberOfLines, maxWidth, or responsive layout to keep controls from overlapping.',
  });
}

function hasLabel(context, element) {
  const { jsx } = context;
  return LABEL_ATTRIBUTES.some((name) => jsx.hasAttribute(element, name));
}

/**
 * "Icon only" means the control renders an icon and no readable content. Child
 * text, a child component that renders text, or a label attribute all count as
 * readable, which is what the regex version could not determine.
 */
function checkIconOnlyButton(context, sourceFile, element) {
  const { jsx, resolver } = context;
  const tag = jsx.canonicalTagName(element, resolver);
  if (tag !== 'Button' && tag !== 'Pressable') return;
  if (!jsx.hasAttribute(element, 'icon') && !rendersOnlyIconChild(context, element)) return;
  if (hasLabel(context, element)) return;
  if (jsx.hasRenderedChildren(element) && !rendersOnlyIconChild(context, element)) return;

  if (jsx.hasSpread(element)) {
    context.report(sourceFile, element, {
      status: 'unknown',
      rule: 'icon-only-control-missing-label',
      message:
        `<${tag}> spreads props, so the analyzer could not confirm an accessible label is present on this icon-only control.`,
    });
    return;
  }

  context.report(sourceFile, element, {
    status: 'fail',
    rule: 'icon-only-control-missing-label',
    message: `Icon-only <${tag}> has no aria-label/accessibilityLabel. Screen readers announce nothing for this control.`,
  });
}

/** True when every rendered child is an icon element (no readable text). */
function rendersOnlyIconChild(context, element) {
  const { ts, jsx, resolver } = context;
  const children = jsx.childrenOf(element).filter((child) => {
    if (ts.isJsxText(child)) return child.text.trim().length > 0;
    if (ts.isJsxExpression(child) && !child.expression) return false;
    return true;
  });
  if (children.length === 0) return false;
  return children.every((child) => {
    const opening = ts.isJsxElement(child) ? child.openingElement : child;
    if (!jsx.isOpeningLike(opening)) return false;
    return /^(Ionicons|Icon|.*Icon)$/.test(jsx.canonicalTagName(opening, resolver));
  });
}

function checkTouchTargetSize(context, sourceFile, element) {
  const { jsx, resolver } = context;
  if (jsx.canonicalTagName(element, resolver) !== 'Button') return;
  const size = jsx.attributeNamed(element, 'size');
  if (!size || !size.initializer) return;
  const evaluated = resolver.evaluateStrings(size.initializer);
  const isSmall = evaluated.values.some((value) => value.exact && SMALL_SIZE_RE.test(value.text));
  if (!isSmall) return;
  if (jsx.hasAttribute(element, 'hitSlop')) return;
  context.report(sourceFile, element, {
    status: 'fail',
    rule: 'small-touch-target-without-hitslop',
    message:
      'Buttons sized $1/$2 are below the 44x44pt mobile touch target. Use size="$3" or larger, or add hitSlop so the target stays reachable.',
  });
}

function checkCustomPressableRole(context, sourceFile, element) {
  const { jsx, resolver } = context;
  const tag = jsx.canonicalTagName(element, resolver);
  if (!CUSTOM_STACK_TAGS.has(tag)) return;
  if (!jsx.hasAttribute(element, 'onPress')) return;
  if (jsx.hasAttribute(element, 'role') || jsx.hasAttribute(element, 'accessibilityRole')) return;
  if (jsx.hasSpread(element)) {
    context.report(sourceFile, element, {
      status: 'unknown',
      rule: 'custom-pressable-missing-role',
      message: `<${tag}> spreads props, so the analyzer could not confirm an accessibility role is set on this tappable stack.`,
    });
    return;
  }
  context.report(sourceFile, element, {
    status: 'fail',
    rule: 'custom-pressable-missing-role',
    message: `Tappable <${tag}> has no role="button" (or matching accessibilityRole), so assistive tech does not announce it as a control.`,
  });
}

/**
 * A press handler nested inside another press handler steals the parent tap.
 * Only a *rendered descendant* counts, which removes the regex version's habit
 * of pairing a control with an unrelated sibling further down the file.
 */
function checkNestedTouchTargets(context, sourceFile, element) {
  const { ts, jsx, resolver } = context;
  const tag = jsx.canonicalTagName(element, resolver);
  if (!TAPPABLE_TAGS.has(tag)) return;
  if (!jsx.hasAttribute(element, 'onPress')) return;

  const container = jsx.elementOf(element);
  if (!ts.isJsxElement(container)) return;

  let nested = null;
  const visit = (node) => {
    if (nested || !node) return;
    if (jsx.isOpeningLike(node) && node !== element) {
      const childTag = jsx.canonicalTagName(node, resolver);
      const interactive = childTag === 'Link'
        || (TAPPABLE_TAGS.has(childTag) && jsx.hasAttribute(node, 'onPress'));
      if (interactive && !jsx.hasAttribute(node, 'pointerEvents')) nested = node;
    }
    ts.forEachChild(node, visit);
  };
  for (const child of container.children) visit(child);

  if (!nested) return;
  context.report(sourceFile, nested, {
    status: 'fail',
    rule: 'nested-touch-targets',
    message:
      `Tappable <${jsx.canonicalTagName(nested, resolver)}> is nested inside a tappable <${tag}>. Give the row a single press owner, move child actions to siblings, or set pointerEvents="none" on decorative overlays.`,
  });
}
