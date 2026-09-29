'use strict';

// PCF manifests and FormXML are trusted only as XML-shaped data, not as a language runtime. This
// scanner accepts the subset later /pcf tasks need, for example:
//   <?xml version="1.0" encoding="utf-8" ?>
//   <!DOCTYPE form [<!ENTITY x "ignored">]>
//   <manifest><control namespace="Contoso.Controls"><![CDATA[<raw>&amp;]]></control></manifest>
// It deliberately does not build or evaluate a DTD/entity table. That keeps external and declared
// entities inert, so an XXE payload can only surface as an unknown `&name;` parse error instead of
// causing file/network access or surprising text expansion.

class XmlError extends Error {
  constructor(message, text, offset) {
    const safeOffset = Math.max(0, Math.min(offset, text.length));
    const { line, column } = lineColumn(text, safeOffset);
    super(`${message} at ${line}:${column}`);
    this.name = 'XmlError';
    this.offset = safeOffset;
    this.line = line;
    this.column = column;
  }
}

const NAMED_ENTITIES = Object.freeze({
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: '\'',
});

function parseXml(text) {
  if (typeof text !== 'string') throw new TypeError('parseXml expects a string');

  let i = 0;
  let line = 1;
  let root = null;
  const stack = [];

  const fail = (message, offset = i) => { throw new XmlError(message, text, offset); };
  const current = () => stack[stack.length - 1] || null;
  const at = (value) => text.startsWith(value, i);
  const advance = (count) => {
    const end = i + count;
    while (i < end) {
      if (text.charCodeAt(i) === 10) line++;
      i++;
    }
  };

  while (i < text.length) {
    if (at('<!--')) {
      skipUntil('-->', 'Unclosed comment');
      continue;
    }
    if (at('<?')) {
      skipUntil('?>', 'Unclosed processing instruction');
      continue;
    }
    if (at('<![CDATA[')) {
      const start = i + 9;
      const end = text.indexOf(']]>', start);
      if (end === -1) fail('Unclosed CDATA section');
      const parent = current();
      if (!parent) {
        if (text.slice(start, end).trim()) fail(root ? 'Text after the root element' : 'Text before the root element', start);
      } else {
        parent.children.push({ type: 'text', value: text.slice(start, end) });
      }
      advance(end + 3 - i);
      continue;
    }
    if (/^<!DOCTYPE\b/i.test(text.slice(i, i + 10))) {
      skipDeclaration('Unclosed DOCTYPE declaration');
      continue;
    }
    if (at('<!')) {
      skipDeclaration('Unclosed declaration');
      continue;
    }
    if (at('</')) {
      readCloseTag();
      continue;
    }
    if (text.charCodeAt(i) === 60) {
      readOpenTag();
      continue;
    }
    readText();
  }

  if (stack.length) fail(`Unclosed tag <${stack[stack.length - 1].name}>`, text.length);
  if (!root) fail('No root element', text.length);
  return root;

  function skipUntil(marker, message) {
    const end = text.indexOf(marker, i + marker.length);
    if (end === -1) fail(message);
    advance(end + marker.length - i);
  }

  function skipDeclaration(message) {
    let quote = null;
    let bracketDepth = 0;
    while (i < text.length) {
      const ch = text[i];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === '\'') {
        quote = ch;
      } else if (ch === '[') {
        bracketDepth++;
      } else if (ch === ']') {
        bracketDepth = Math.max(0, bracketDepth - 1);
      } else if (ch === '>' && bracketDepth === 0) {
        advance(1);
        return;
      }
      advance(1);
    }
    fail(message, text.length);
  }

  function readOpenTag() {
    const tagOffset = i;
    const tagLine = line;
    advance(1);
    const name = readName('Expected element name');
    const attrs = {};
    let selfClosing = false;

    while (i < text.length) {
      skipWhitespace();
      if (at('/>')) {
        selfClosing = true;
        advance(2);
        break;
      }
      if (text.charCodeAt(i) === 62) {
        advance(1);
        break;
      }
      const attrName = readName('Expected attribute name');
      if (Object.prototype.hasOwnProperty.call(attrs, attrName)) fail(`Duplicate attribute "${attrName}"`);
      skipWhitespace();
      if (text.charCodeAt(i) !== 61) fail(`Expected "=" after attribute "${attrName}"`);
      advance(1);
      skipWhitespace();
      attrs[attrName] = readAttributeValue();
    }

    if (i > text.length) fail(`Unclosed tag <${name}>`, tagOffset);
    const element = { type: 'element', name, attrs, children: [], line: tagLine };
    const parent = current();
    if (!parent) {
      if (root) fail('Text after the root element', tagOffset);
      root = element;
    } else {
      parent.children.push(element);
    }
    if (!selfClosing) stack.push(element);
  }

  function readCloseTag() {
    const tagOffset = i;
    advance(2);
    const name = readName('Expected closing tag name');
    skipWhitespace();
    if (text.charCodeAt(i) !== 62) fail(`Expected ">" after closing tag </${name}>`);
    advance(1);
    const open = stack.pop();
    if (!open) fail(`Unexpected closing tag </${name}>`, tagOffset);
    if (open.name !== name) fail(`Mismatched closing tag </${name}> for <${open.name}>`, tagOffset);
  }

  function readText() {
    const start = i;
    const next = text.indexOf('<', i);
    const end = next === -1 ? text.length : next;
    advance(end - i);
    const raw = text.slice(start, end);
    if (!raw) return;
    const parent = current();
    if (!parent) {
      if (raw.trim()) fail(root ? 'Text after the root element' : 'Text before the root element', start);
      return;
    }
    parent.children.push({ type: 'text', value: decodeEntities(raw, start, fail) });
  }

  function readName(message) {
    const start = i;
    while (i < text.length && !isNameTerminator(text[i])) advance(1);
    if (i === start) fail(message, start);
    return text.slice(start, i);
  }

  function readAttributeValue() {
    const quote = text[i];
    if (quote !== '"' && quote !== '\'') fail('Expected quoted attribute value');
    advance(1);
    const valueStart = i;
    let segmentStart = i;
    let value = '';
    while (i < text.length && text[i] !== quote) {
      if (text.charCodeAt(i) === 60) fail('Unexpected "<" inside attribute value');
      if (text.charCodeAt(i) === 38) {
        const entityOffset = i;
        const semi = text.indexOf(';', i + 1);
        if (semi === -1) fail('Unterminated entity reference', entityOffset);
        value += text.slice(segmentStart, entityOffset);
        value += decodeOneEntity(text.slice(i + 1, semi), entityOffset, fail);
        advance(semi + 1 - i);
        segmentStart = i;
        continue;
      }
      advance(1);
    }
    if (i >= text.length) fail('Unclosed attribute value', valueStart - 1);
    value += text.slice(segmentStart, i);
    advance(1);
    return value;
  }

  function skipWhitespace() {
    while (i < text.length && /\s/.test(text[i])) advance(1);
  }
}

function childElements(el, name) {
  return el.children.filter((child) => child.type === 'element' && (name === undefined || child.name === name));
}

function findAll(el, pred) {
  const out = [];
  const visit = (node) => {
    if (pred(node)) out.push(node);
    for (const child of childElements(node)) {
      visit(child);
    }
  };
  visit(el);
  return out;
}

function findFirst(el, pred) {
  if (pred(el)) return el;
  for (const child of childElements(el)) {
    const found = findFirst(child, pred);
    if (found) return found;
  }
  return null;
}

function attr(el, name, { caseInsensitive = false } = {}) {
  if (!el) return undefined;
  if (!caseInsensitive) return el.attrs[name];
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(el.attrs)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function textOf(el) {
  if (!el) return '';
  let value = '';
  const visit = (node) => {
    for (const child of node.children) {
      if (child.type === 'text') value += child.value;
      else visit(child);
    }
  };
  visit(el);
  return value.trim();
}

function decodeEntities(value, baseOffset, fail) {
  let out = '';
  let start = 0;
  while (start < value.length) {
    const amp = value.indexOf('&', start);
    if (amp === -1) return out + value.slice(start);
    const semi = value.indexOf(';', amp + 1);
    if (semi === -1) fail('Unterminated entity reference', baseOffset + amp);
    out += value.slice(start, amp);
    out += decodeOneEntity(value.slice(amp + 1, semi), baseOffset + amp, fail);
    start = semi + 1;
  }
  return out;
}

function decodeOneEntity(body, offset, fail) {
  if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)) return NAMED_ENTITIES[body];
  if (body.startsWith('#')) {
    let codePoint = null;
    if (/^#[0-9]+$/.test(body)) codePoint = parseInt(body.slice(1), 10);
    else if (/^#x[0-9a-fA-F]+$/.test(body)) codePoint = parseInt(body.slice(2), 16);
    if (!isXmlCodePoint(codePoint)) fail(`Invalid numeric character reference &${body};`, offset);
    return String.fromCodePoint(codePoint);
  }
  fail(`Unknown entity reference &${body};`, offset);
}

function isXmlCodePoint(codePoint) {
  return Number.isInteger(codePoint) &&
    (codePoint === 0x9 || codePoint === 0xA || codePoint === 0xD ||
      (codePoint >= 0x20 && codePoint <= 0xD7FF) ||
      (codePoint >= 0xE000 && codePoint <= 0xFFFD) ||
      (codePoint >= 0x10000 && codePoint <= 0x10FFFF));
}

function isNameTerminator(ch) {
  return ch === undefined || /\s/.test(ch) || ch === '/' || ch === '>' || ch === '=';
}

function lineColumn(text, offset) {
  let line = 1;
  let lineStart = 0;
  for (let pos = 0; pos < offset; pos++) {
    if (text.charCodeAt(pos) === 10) {
      line++;
      lineStart = pos + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

module.exports = {
  XmlError,
  parseXml,
  childElements,
  findAll,
  findFirst,
  attr,
  textOf,
};
