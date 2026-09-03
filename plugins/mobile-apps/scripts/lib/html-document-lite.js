'use strict';

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);
const RAW_TEXT_ELEMENTS = new Set(['script', 'style']);

function decodeEntity(entity) {
  if (entity[0] === '#') {
    const hexadecimal = entity[1]?.toLowerCase() === 'x';
    const value = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    return Number.isFinite(value) ? String.fromCodePoint(value) : `&${entity};`;
  }
  return {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
  }[entity] || `&${entity};`;
}

function decodeHtml(value) {
  return String(value).replace(/&(#(?:x[0-9a-f]+|\d+)|amp|apos|gt|lt|nbsp|quot);/gi, (_, entity) => (
    decodeEntity(entity)
  ));
}

function tagEnd(source, start) {
  let quote = null;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function parseStartTag(raw, errors) {
  let index = 0;
  const skipSpace = () => {
    while (/\s/.test(raw[index] || '')) index += 1;
  };
  const readName = () => {
    const start = index;
    while (/[A-Za-z0-9:_-]/.test(raw[index] || '')) index += 1;
    return raw.slice(start, index);
  };

  skipSpace();
  const tag = readName().toLowerCase();
  if (!tag) return null;
  const attrs = {};
  let selfClosing = false;
  while (index < raw.length) {
    skipSpace();
    if (raw[index] === '/') {
      selfClosing = true;
      index += 1;
      skipSpace();
      break;
    }
    if (index >= raw.length) break;
    const name = readName().toLowerCase();
    if (!name) {
      errors.push(`invalid attribute syntax in <${tag}>`);
      break;
    }
    skipSpace();
    let value = '';
    if (raw[index] === '=') {
      index += 1;
      skipSpace();
      const quote = raw[index] === '"' || raw[index] === "'" ? raw[index++] : null;
      const start = index;
      if (quote) {
        while (index < raw.length && raw[index] !== quote) index += 1;
        value = raw.slice(start, index);
        if (raw[index] !== quote) errors.push(`unterminated ${name} attribute in <${tag}>`);
        else index += 1;
      } else {
        while (index < raw.length && !/[\s/]/.test(raw[index])) index += 1;
        value = raw.slice(start, index);
      }
    }
    if (Object.prototype.hasOwnProperty.call(attrs, name)) {
      errors.push(`duplicate ${name} attribute in <${tag}>`);
    }
    attrs[name] = decodeHtml(value);
  }
  return { attrs, selfClosing, tag };
}

// The final preview contract controls the HTML shape, so a small strict tokenizer is enough:
// it recognizes quoted attributes and treats script/style bodies as raw text. This avoids both
// a runtime npm dependency and regex-based guesses over arbitrary React Native source.
function parseHtmlDocument(source) {
  const document = { tag: '#document', attrs: {}, children: [], text: '', hidden: false };
  const stack = [document];
  const elements = [];
  const errors = [];
  const lower = source.toLowerCase();
  let hasDoctype = false;
  let index = 0;

  while (index < source.length) {
    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4);
      if (end === -1) {
        errors.push('unterminated HTML comment');
        break;
      }
      index = end + 3;
      continue;
    }
    if (lower.startsWith('<!doctype', index)) {
      const end = tagEnd(source, index + 2);
      if (end === -1) {
        errors.push('unterminated doctype');
        break;
      }
      hasDoctype = true;
      index = end + 1;
      continue;
    }
    if (source[index] !== '<') {
      const end = source.indexOf('<', index);
      const text = decodeHtml(source.slice(index, end === -1 ? source.length : end));
      stack[stack.length - 1].text += text;
      index = end === -1 ? source.length : end;
      continue;
    }
    if (source.startsWith('</', index)) {
      const end = tagEnd(source, index + 2);
      if (end === -1) {
        errors.push('unterminated closing tag');
        break;
      }
      const tag = source.slice(index + 2, end).trim().toLowerCase();
      const current = stack[stack.length - 1];
      if (current.tag !== tag) errors.push(`closing </${tag}> does not match <${current.tag}>`);
      else stack.pop();
      index = end + 1;
      continue;
    }
    if (source.startsWith('<!', index) || source.startsWith('<?', index)) {
      const end = tagEnd(source, index + 2);
      if (end === -1) {
        errors.push('unterminated declaration');
        break;
      }
      index = end + 1;
      continue;
    }

    const end = tagEnd(source, index + 1);
    if (end === -1) {
      errors.push('unterminated start tag');
      break;
    }
    const parsed = parseStartTag(source.slice(index + 1, end), errors);
    if (!parsed) {
      errors.push('invalid start tag');
      break;
    }
    const parent = stack[stack.length - 1];
    const style = parsed.attrs.style?.toLowerCase() || '';
    const node = {
      tag: parsed.tag,
      attrs: parsed.attrs,
      children: [],
      text: '',
      hidden: parent.hidden
        || Object.prototype.hasOwnProperty.call(parsed.attrs, 'hidden')
        || parsed.attrs['aria-hidden'] === 'true'
        || style.includes('display:none')
        || style.includes('visibility:hidden'),
    };
    Object.defineProperty(node, 'parent', { value: parent });
    parent.children.push(node);
    elements.push(node);
    index = end + 1;

    if (RAW_TEXT_ELEMENTS.has(node.tag)) {
      const closeStart = lower.indexOf(`</${node.tag}`, index);
      if (closeStart === -1) {
        errors.push(`missing </${node.tag}>`);
        break;
      }
      const closeEnd = tagEnd(source, closeStart + 2);
      if (closeEnd === -1) {
        errors.push(`unterminated </${node.tag}>`);
        break;
      }
      node.text = source.slice(index, closeStart);
      index = closeEnd + 1;
    } else if (!parsed.selfClosing && !VOID_ELEMENTS.has(node.tag)) {
      stack.push(node);
    }
  }

  if (stack.length > 1) {
    errors.push(`unclosed element <${stack[stack.length - 1].tag}>`);
  }
  return { document, elements, errors, hasDoctype };
}

function normalizedText(node) {
  if (RAW_TEXT_ELEMENTS.has(node.tag)) return '';
  return [node.text, ...node.children.map(normalizedText)]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isDescendant(node, ancestor) {
  let current = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

module.exports = {
  isDescendant,
  normalizedText,
  parseHtmlDocument,
};