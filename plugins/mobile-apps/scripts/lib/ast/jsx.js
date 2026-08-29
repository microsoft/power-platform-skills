'use strict';

/**
 * JSX helpers shared by the semantic rules.
 *
 * Generated screens mix Tamagui primitives, React Native components, and
 * app-local wrappers, and they use every JSX form (self-closing, generic
 * `<List<Row> ... />`, member expressions like `<Button.Text>`). Centralising
 * the traversal here keeps each rule focused on its own contract.
 */

function createJsxHelpers(ts) {
  /** Normalised tag name: `Button`, `Button.Text`, `Ionicons`. */
  function tagNameOf(element) {
    const tagName = element.tagName;
    if (!tagName) return '';
    if (ts.isIdentifier(tagName)) return tagName.text;
    if (ts.isPropertyAccessExpression(tagName)) {
      return `${tagNameText(tagName.expression)}.${tagName.name.text}`;
    }
    if (ts.isJsxNamespacedName && ts.isJsxNamespacedName(tagName)) {
      return `${tagName.namespace.text}:${tagName.name.text}`;
    }
    return tagName.getText ? tagName.getText() : '';
  }

  function tagNameText(node) {
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isPropertyAccessExpression(node)) return `${tagNameText(node.expression)}.${node.name.text}`;
    return '';
  }

  /** Root identifier of a tag name, i.e. `Button` for `<Button.Text>`. */
  function tagIdentifier(element) {
    let node = element.tagName;
    while (node && ts.isPropertyAccessExpression(node)) node = node.expression;
    return node && ts.isIdentifier(node) ? node : null;
  }

  /**
   * Resolves renamed imports to their exported JSX name. Local components keep
   * their local name; only explicit import bindings are canonicalized.
   */
  function canonicalTagName(element, resolver) {
    const localName = tagNameOf(element);
    const identifier = tagIdentifier(element);
    if (!identifier || !resolver) return localName;
    const binding = resolver.importBindingFor(identifier);
    if (!binding) return localName;
    if (!/^(?:react-native(?:$|-|\/)|tamagui$|@tamagui\/|@shopify\/flash-list$|@expo\/vector-icons$|expo-router$)/.test(binding.moduleSpecifier)) {
      return localName;
    }
    if (binding.importedName === '*') {
      const suffix = localName.slice(identifier.text.length + 1);
      return suffix || localName;
    }
    if (binding.importedName === 'default') return localName;
    const suffix = localName.slice(identifier.text.length);
    return `${binding.importedName}${suffix}`;
  }

  function isOpeningLike(node) {
    return ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node);
  }

  /** Attribute lookup that ignores spread attributes (see `hasSpread`). */
  function attributeNamed(element, name) {
    if (!element.attributes) return null;
    for (const property of element.attributes.properties) {
      if (!ts.isJsxAttribute(property)) continue;
      const propertyName = property.name && property.name.text
        ? property.name.text
        : (property.name && property.name.getText ? property.name.getText() : '');
      if (propertyName === name) return property;
    }
    return null;
  }

  function hasAttribute(element, name) {
    return attributeNamed(element, name) !== null;
  }

  /** `{...props}` hides attributes from static inspection — rules downgrade to unknown. */
  function hasSpread(element) {
    if (!element.attributes) return false;
    return element.attributes.properties.some((property) => ts.isJsxSpreadAttribute(property));
  }

  function attributeNames(element) {
    const names = [];
    if (!element.attributes) return names;
    for (const property of element.attributes.properties) {
      if (!ts.isJsxAttribute(property)) continue;
      const name = property.name && property.name.text ? property.name.text : null;
      if (name) names.push(name);
    }
    return names;
  }

  /** The element that owns this opening/self-closing tag, for child inspection. */
  function elementOf(opening) {
    if (ts.isJsxSelfClosingElement(opening)) return opening;
    return opening.parent && ts.isJsxElement(opening.parent) ? opening.parent : opening;
  }

  function childrenOf(opening) {
    const element = elementOf(opening);
    return ts.isJsxElement(element) ? element.children : [];
  }

  /** True when the element renders any non-whitespace child content. */
  function hasRenderedChildren(opening) {
    for (const child of childrenOf(opening)) {
      if (ts.isJsxText(child)) {
        if (child.text.trim().length > 0) return true;
        continue;
      }
      if (ts.isJsxExpression(child) && !child.expression) continue;
      return true;
    }
    return false;
  }

  function forEachJsxElement(root, callback) {
    const visit = (node) => {
      if (!node) return;
      if (isOpeningLike(node)) callback(node);
      ts.forEachChild(node, visit);
    };
    visit(root);
  }

  return {
    attributeNamed,
    attributeNames,
    canonicalTagName,
    childrenOf,
    elementOf,
    forEachJsxElement,
    hasAttribute,
    hasRenderedChildren,
    hasSpread,
    isOpeningLike,
    tagIdentifier,
    tagNameOf,
  };
}

module.exports = { createJsxHelpers };
