'use strict';

const { cssTree, propertyData } = require('../vendor/css-tools/css-tools.cjs');

function canonicalProperty(name) {
  const decoded = cssTree.ident.decode(name);
  return decoded.startsWith('--') ? decoded : decoded.toLowerCase();
}

function trimCssWhitespace(text) {
  let first = text.length;
  let last = 0;
  cssTree.tokenize(text, (type, start, end) => {
    if (type !== cssTree.tokenTypes.WhiteSpace) {
      first = Math.min(first, start);
      last = end;
    }
  });
  return text.slice(first, last);
}

function declarationsIn(text) {
  try {
    // CSS tokenization respects quoted URLs ("a;b.png"), escaped identifiers and
    // comments. Reject EOF recovery: otherwise a new declaration could disappear
    // inside an existing unfinished string/comment instead of taking effect.
    // https://www.w3.org/TR/css-syntax-3/#tokenization
    const types = cssTree.tokenTypes;
    const stack = [];
    cssTree.tokenize(text, (type, start, end) => {
      const raw = text.slice(start, end);
      if (type === types.BadString || type === types.BadUrl ||
          (type === types.Comment && (raw.length < 4 || !raw.endsWith('*/')))) throw new Error('Unterminated CSS token.');
      if (type !== types.Comment && /\\+$/.test(raw) && /\\+$/.exec(raw)[0].length % 2) {
        throw new Error('Dangling CSS escape.');
      }
      if (type === types.String) {
        const escapes = /\\*$/.exec(raw.slice(0, -1))[0].length;
        if (raw.length < 2 || raw.at(-1) !== raw[0] || escapes % 2) throw new Error('Unterminated CSS string.');
      }
      if (type === types.Url && (!raw.endsWith(')') || /\\*$/.exec(raw.slice(0, -1))[0].length % 2)) {
        throw new Error('Unterminated CSS URL.');
      }
      if (type === types.Function || type === types.LeftParenthesis) stack.push(types.RightParenthesis);
      if (type === types.LeftSquareBracket) stack.push(types.RightSquareBracket);
      if (type === types.LeftCurlyBracket) stack.push(types.RightCurlyBracket);
      if ([types.RightParenthesis, types.RightSquareBracket, types.RightCurlyBracket].includes(type) && stack.pop() !== type) {
        throw new Error('Unbalanced CSS value.');
      }
    });
    if (stack.length) throw new Error('Unbalanced CSS value.');
    // The editor needs declaration boundaries, not a frozen property-value
    // grammar. Modern functions may contain syntax the value AST does not know.
    const ast = cssTree.parse(text, { context: 'declarationList', parseValue: false, positions: true, onParseError(error) { throw error; } });
    let previousEnd = 0;
    return ast.children.toArray().map((node) => {
      if (node.type !== 'Declaration') throw new Error('Expected a declaration, not a rule.');
      const property = canonicalProperty(node.property);
      const value = trimCssWhitespace(node.value.type === 'Raw' ? node.value.value :
        text.slice(node.value.loc.start.offset, node.value.loc.end.offset));
      if (!value && !property.startsWith('--')) throw new Error('Empty CSS declaration.');
      let depth = 0;
      cssTree.tokenize(value, (type, start) => {
        if ([types.Function, types.LeftParenthesis, types.LeftSquareBracket, types.LeftCurlyBracket].includes(type)) depth += 1;
        if ([types.RightParenthesis, types.RightSquareBracket, types.RightCurlyBracket].includes(type)) depth -= 1;
        if (!depth && type === types.Delim && value[start] === '!') throw new Error('Ambiguous CSS priority.');
      });
      let start = node.loc.start.offset;
      if (/^\s*$/.test(text.slice(previousEnd, start))) start = previousEnd;
      let end = node.loc.end.offset;
      if (text[end] === ';') end += 1;
      previousEnd = end;
      return { property, value, important: Boolean(node.important), start, end };
    });
  } catch (error) {
    throw new Error(`Malformed inline CSS: ${error.message}. Resolve the local declaration before editing.`);
  }
}

function propertyEffects(property, seen = new Set()) {
  // Compare affected longhands, not just name prefixes: border-width does not
  // override border-color, and border does not reset border-radius.
  // https://www.w3.org/TR/css-cascade-5/#shorthand
  const sides = ['top', 'right', 'bottom', 'left'];
  if (property === 'border-radius' || /^border-(start|end)-(start|end)-radius$/.test(property)) {
    return ['top-left', 'top-right', 'bottom-left', 'bottom-right'].map((corner) => `border-${corner}-radius`);
  }
  if (property === 'border') {
    // `border` also resets border-image, although MDN's computed list only
    // names width/style/color. It does not reset border-radius.
    // https://www.w3.org/TR/css-backgrounds-3/#border-shorthands
    return [...sides.flatMap((side) => ['width', 'style', 'color'].map((part) => `border-${side}-${part}`)),
      ...['source', 'slice', 'width', 'outset', 'repeat'].map((part) => `border-image-${part}`)];
  }
  const logicalBorder = /^border-(?:inline|block)(?:-(?:start|end))?(?:-(width|style|color))?$/.exec(property);
  if (logicalBorder) return sides.flatMap((side) => (logicalBorder[1] ? [logicalBorder[1]] : ['width', 'style', 'color'])
    .map((part) => `border-${side}-${part}`));
  if (/^border-(width|style|color)$/.test(property)) return sides.map((side) => `border-${side}-${property.slice(7)}`);
  if (/^border-(top|right|bottom|left)$/.test(property)) return ['width', 'style', 'color'].map((part) => `${property}-${part}`);
  if (/^(margin|padding)(?:-(?:inline|block)(?:-(?:start|end))?)?$/.test(property)) {
    // Logical sides depend on writing mode; conservatively consider all physical sides.
    return sides.map((side) => `${property.split('-')[0]}-${side}`);
  }
  // MDN's computed/initial property references cover shorthands beyond the old
  // hand-maintained decoration list (animation, grid, mask, inset, etc.).
  // Keep logical-side expansion above conservative when writing mode is unknown.
  // https://github.com/mdn/data/tree/main/css
  if (seen.has(property)) return [property];
  const data = Object.hasOwn(propertyData, property) ? propertyData[property] : null;
  const children = [...new Set([data?.computed, data?.initial].filter(Array.isArray).flat())]
    .filter((name) => name !== property && Object.hasOwn(propertyData, name));
  return children.length ? children.flatMap((child) => propertyEffects(child, new Set([...seen, property]))) : [property];
}

function overlaps(left, right) {
  // `all` does not reset custom properties, direction or unicode-bidi.
  // https://www.w3.org/TR/css-cascade-5/#all-shorthand
  const resettable = (name) => !name.startsWith('--') && !['direction', 'unicode-bidi'].includes(name);
  return (left === 'all' && resettable(right)) || (right === 'all' && resettable(left)) ||
    propertyEffects(left).some((property) => propertyEffects(right).includes(property));
}

function requestedEntries(requested) {
  const names = Object.keys(requested);
  const entries = declarationsIn(names.map((name) => `${name}: ${requested[name]};`).join('\n'));
  if (entries.length !== names.length || entries.some((entry, index) => entry.property !== canonicalProperty(names[index])) ||
      new Set(entries.map((entry) => entry.property)).size !== entries.length) {
    throw new Error('Malformed or duplicate requested inline CSS declarations.');
  }
  return entries;
}

function editInlineDeclarations(text, requested) {
  // Authoring/resource/priority policy is checked by the shared CSS validator.
  // Here retain declaration order: alphabetizing shorthands changes their effect.
  const entries = declarationsIn(text);
  const removals = Object.keys(requested).filter((name) => requested[name] === null).map(canonicalProperty);
  const additions = requestedEntries(Object.fromEntries(Object.entries(requested).filter(([, value]) => value !== null)));
  const properties = [...additions.map((entry) => entry.property), ...removals];
  if (new Set(properties).size !== properties.length) throw new Error('Duplicate requested inline CSS properties.');
  const priority = new Map();
  for (const { property, important } of additions) {
    // Never add !important to beat a different shorthand/longhand. Updating an
    // existing exact property's value may retain its existing priority.
    // https://www.w3.org/TR/css-cascade-5/#importance
    const conflict = entries.find((entry) => entry.important && entry.property !== property &&
      !properties.includes(entry.property) &&
      overlaps(entry.property, property));
    if (conflict) throw new Error(`Existing !important ${conflict.property} conflicts with ${property}; resolve that local declaration instead of writing ineffective CSS.`);
    priority.set(property, important || entries.some((entry) => entry.property === property && entry.important));
  }
  const tail = additions.length ? entries.slice(-additions.length) : [];
  if (!entries.some((entry) => removals.includes(entry.property)) && tail.length === additions.length && tail.every((entry, index) =>
    entry.property === additions[index].property && entry.value === additions[index].value &&
    entry.important === priority.get(entry.property))) return text;

  // Move only requested properties after ordinary shorthand/longhand overrides.
  // Preserve every unrelated declaration byte, including URLs and quoted values.
  let remaining = text;
  for (const entry of entries.filter((entry) => properties.includes(entry.property)).reverse()) {
    remaining = remaining.slice(0, entry.start) + remaining.slice(entry.end);
  }
  if (!additions.length) return remaining;
  if (remaining.trim() && !remaining.trimEnd().endsWith(';')) remaining += ';';
  if (remaining && !/\s$/.test(remaining)) remaining += ' ';
  return remaining + additions.map(({ property, value }) =>
    `${cssTree.ident.encode(property)}: ${value}${priority.get(property) ? ' !important' : ''};`).join(' ');
}

function inlineOverrides(text, requested) {
  const incoming = requestedEntries(requested);
  return declarationsIn(text).filter((entry) => incoming.some((candidate) =>
    !(candidate.property === entry.property && candidate.value === entry.value) &&
    // An explicitly reviewed important stylesheet beats normal inline CSS, but
    // important inline declarations still own the same cascade origin.
    (entry.important || !candidate.important) && overlaps(entry.property, candidate.property)))
    .map((entry) => entry.property);
}

module.exports = { editInlineDeclarations, inlineOverrides, canonicalProperty };
