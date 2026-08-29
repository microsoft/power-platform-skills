'use strict';

/**
 * Rule: color usage that fails WCAG AA in generated screens.
 *
 * Split of responsibility with the lexical validator:
 *   - `validate-screen-quality.js` keeps the *literal* ban — a raw `#rrggbb`
 *     written directly as an attribute value, which is a purely lexical contract.
 *   - This rule owns everything that needs the program: a hex reached through a
 *     constant, a token, or a ternary; faint foreground tokens; low-alpha rgba
 *     text and borders; and white-on-yellow/orange status fills, which require
 *     pairing two attributes on the same element.
 *
 * Contrast thresholds follow the plugin's accessibility checklist (4.5:1 body
 * text, 3:1 large text and non-text UI).
 * See https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
 */

const COLOR_PROPS = new Set([
  'backgroundColor',
  'background',
  'bg',
  'borderBottomColor',
  'borderColor',
  'borderLeftColor',
  'borderRightColor',
  'borderTopColor',
  'col',
  'color',
  'placeholderTextColor',
  'tabBarInactiveTintColor',
  'tintColor',
  'underlineColorAndroid',
]);

const FOREGROUND_PROPS = new Set([
  'col',
  'color',
  'placeholderTextColor',
  'tabBarInactiveTintColor',
  'tintColor',
]);

const BACKGROUND_PROPS = new Set(['bg', 'background', 'backgroundColor']);

const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
const FAINT_TOKEN_RE = /^\$(?:color|gray)[1-8]$|^\$text3$/;
const RISKY_FILL_RE = /^\$(?:yellow|orange)(?:[6-9]|1[0-2])$/;
const WHITE_FOREGROUND_RE = /^(?:white|\$white|\$color1|#fff|#ffffff)$/i;
const RGBA_RE = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/i;

const TEXT_ALPHA_FLOOR = 0.85;
const BORDER_ALPHA_FLOOR = 0.65;

const TOKEN_HINT =
  'Use Tamagui semantic tokens ($color10, $color11, $color12, $blue11, brand aliases) so the value adapts across light/dark mode and keeps AA contrast.';

module.exports = {
  id: 'color-contrast',

  appliesTo(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    if (!/\.(?:jsx|tsx)$/.test(normalized)) return false;
    if (normalized.includes('/brand/')) return false;
    if (normalized.includes('/shared/samples/')) return false;
    return true;
  },

  run(context, sourceFile) {
    const { ts, jsx, resolver } = context;

    jsx.forEachJsxElement(sourceFile, (element) => {
      const values = new Map();

      for (const property of element.attributes ? element.attributes.properties : []) {
        if (!ts.isJsxAttribute(property)) continue;
        const name = property.name && property.name.text;
        if (!name || !COLOR_PROPS.has(name) || !property.initializer) continue;

        const isLiteralAttribute = ts.isStringLiteral(property.initializer);
        const evaluated = resolver.evaluateStrings(property.initializer);
        const exactValues = evaluated.values.filter((value) => value.exact).map((value) => value.text);
        if (exactValues.length > 0) values.set(name, exactValues);

        for (const value of exactValues) {
          checkValue(context, sourceFile, property, name, value, isLiteralAttribute);
        }
      }

      checkWhiteOnWarmFill(context, sourceFile, element, values);
    });

    // Style objects: `const styles = StyleSheet.create({ label: { color: FAINT } })`.
    const visitStyles = (node) => {
      if (ts.isPropertyAssignment(node)) {
        const name = resolver.propertyName(node);
        if (name && COLOR_PROPS.has(name)) {
          const isLiteral = ts.isStringLiteral(node.initializer);
          const evaluated = resolver.evaluateStrings(node.initializer);
          for (const value of evaluated.values) {
            if (!value.exact) continue;
            checkValue(context, sourceFile, node, name, value.text, isLiteral);
          }
        }
      }
      ts.forEachChild(node, visitStyles);
    };
    visitStyles(sourceFile);
  },
};

function checkValue(context, sourceFile, node, propertyName, value, isLiteralAttribute) {
  // `shadowColor="#000"` is the standard React Native elevation color and is not
  // perceived as content, so it is out of scope for contrast.
  if (propertyName === 'shadowColor') return;

  if (HEX_RE.test(value)) {
    // Direct string literals are owned by the lexical raw-hex rule; this rule
    // only adds the cases regex cannot see (constants, tokens, ternaries).
    if (!isLiteralAttribute) {
      context.report(sourceFile, node, {
        status: 'fail',
        rule: 'hex-on-color-prop',
        message: `\`${propertyName}\` resolves to raw hex "${value}". ${TOKEN_HINT}`,
      });
    }
    return;
  }

  const rgba = RGBA_RE.exec(value);
  if (rgba) {
    const alpha = Number(rgba[4]);
    if (FOREGROUND_PROPS.has(propertyName) && alpha < TEXT_ALPHA_FLOOR) {
      context.report(sourceFile, node, {
        status: 'fail',
        rule: 'low-alpha-text',
        message: `\`${propertyName}\` uses ${value} (alpha ${alpha}); readable text needs at least ${TEXT_ALPHA_FLOOR} alpha to hold AA contrast. ${TOKEN_HINT}`,
      });
    }
    if (/^border/.test(propertyName) && alpha < BORDER_ALPHA_FLOOR) {
      context.report(sourceFile, node, {
        status: 'fail',
        rule: 'low-alpha-border',
        message: `\`${propertyName}\` uses ${value} (alpha ${alpha}); non-text UI needs 3:1 contrast, so raise the alpha or border width.`,
      });
    }
    return;
  }

  if (FOREGROUND_PROPS.has(propertyName) && FAINT_TOKEN_RE.test(value)) {
    context.report(sourceFile, node, {
      status: 'fail',
      rule: 'low-contrast-foreground-token',
      message: `\`${propertyName}="${value}"\` is too faint for readable text, inactive tabs, metadata, or icon affordances. Use $color10 or stronger.`,
    });
  }
}

function checkWhiteOnWarmFill(context, sourceFile, element, values) {
  let fill = null;
  let foreground = null;
  for (const [name, list] of values) {
    if (BACKGROUND_PROPS.has(name)) {
      const match = list.find((value) => RISKY_FILL_RE.test(value));
      if (match) fill = match;
    }
    if (FOREGROUND_PROPS.has(name)) {
      const match = list.find((value) => WHITE_FOREGROUND_RE.test(value));
      if (match) foreground = match;
    }
  }
  if (!fill || !foreground) return;
  context.report(sourceFile, element, {
    status: 'fail',
    rule: 'white-on-warm-status-fill',
    message: `White foreground "${foreground}" on "${fill}" fails WCAG AA. Use a tint with a dark foreground, for example bg="$yellow3" color="$yellow11".`,
  });
}
