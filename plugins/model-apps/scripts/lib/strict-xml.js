'use strict';
// ONE strict reader of ONE XML document, in ONE pass, for the decision in this plugin that must not be wrong in the dangerous direction: which
// elements a document holds, when a generative page is DELETED because an element of an app's sitemap names it (sitemap-pages.js, navigationGenPageIds).
//
// WHY NOT REGULAR EXPRESSIONS. The navigation used to be read by three passes over the text, each taking one kind of construct out of it (comments, then
// CDATA sections, then processing instructions) before the elements were matched. XML has no such order: a delimiter is data wherever the construct that
// is open at that point says it is, so a pass that does not know which construct it is inside reads a delimiter that is data as the end or the start of
// something else, and what is left is not the document. In this well-formed document
//
//   <SubArea GenPageId="…A"/>
//   <?p <!-- ?>
//   <![CDATA[ --> ?> <SubArea GenPageId="…B"/> ]]>
//
// the comment pass starts inside the processing instruction and ends inside the CDATA section, and what remains makes B — which is text — an element
// (and, with other documents, takes a real element away). A character-by-character reader keeps exactly one lexical context at a time: what ends a
// comment is looked for only inside a comment, and so on, so nothing a construct holds can open another.
//
// WHAT IT ACCEPTS: one XML 1.0 document (https://www.w3.org/TR/xml/#sec-well-formed) and nothing else —
//   - an optional byte order mark, an optional XML declaration at the very start (`<?xml version="1.0" encoding="utf-8" standalone="yes"?>`),
//   - comments, processing instructions and white space around the root element (the prolog and the epilog),
//   - exactly ONE root element, whose content is elements, character data, character and predefined entity references, comments, processing
//     instructions and CDATA sections,
//   - attributes in either quote style with white space around the "=", a "<" never in a value (https://www.w3.org/TR/xml/#CleanAttrVals), each attribute
//     once per tag (https://www.w3.org/TR/xml/#uniqattspec), white space between attributes, a closing tag that is the name and nothing else, and every
//     closing tag matching the element it closes (https://www.w3.org/TR/xml/#GIMatch),
//   - the five predefined entities and `&#N;` / `&#xH;` references to a character XML allows (https://www.w3.org/TR/xml/#wf-Legalchar), in attribute
//     values and in character data, and nowhere else an "&".
//
// WHAT IT REFUSES, all of it as "not readable" — the answer to any doubt: a document type declaration (its entities could expand into elements, and none is
// read here), text outside the root element, a second root element, an unclosed or mismatched element, a duplicate attribute, an unquoted value, a "<" in a
// value, "]]>" in character data, "--" in a comment, an entity that is not predefined, a character reference to a character XML does not allow (the control
// characters, a surrogate, U+FFFE and U+FFFF, https://www.w3.org/TR/xml/#NT-Char), a processing instruction named "xml" anywhere but the declaration, and
// anything this reader does not understand. It is stricter than XML 1.0 in four places, on purpose, because a document this reader accepts must be one the
// SDK's parser accepts too, and reads the same way (the oracle test, tests/strict-xml-oracle.test.js, holds the two to each other over a generated corpus):
//   - a name is a QName of letters, digits, marks and "_-." that the SDK's parser and every edition of XML 1.0 accept (at most one colon; no symbol or special character such as
//     U+FEFF, which XML 1.0's fifth edition and the SDK's parser take and older readers refuse; none beyond U+FFFF), and the declaration's version is 1.0;
//   - the SDK's parser (xmldom) decides that an element is "unclosed" by looking for the TEXT `</name>` in the whole document, once per name, at its last
//     occurrence — one in a comment, a CDATA section or a processing instruction counts — and it WARNS when that is before the start tag of an element that is in fact closed
//     (a document that mixes `</SubArea>` and `</SubArea >` does). The SDK's app delete refuses a document it warns about, so this reader refuses it too (see `endTagHint`);
//   - an unprefixed `script` or `textarea` element in the XHTML namespace is raw text to that parser up to the first `</script>` it finds, CDATA or not, which
//     is not where the element ends in XML, so a document with one is not read;
//   - a sitemap has a handful of kinds of element: more than MAX_ELEMENT_NAMES of them are not read, which bounds the work of the search above.
//
// WHAT IT DOES NOT DO: validate against a schema, resolve namespaces (a prefix is part of a name: `m:SubArea` is not `SubArea`), or build a tree. It
// answers with the attributes of the elements the caller asks for, and answers with NOTHING when any part of the document is not readable — never the
// elements read before the fault, because the caller acts on an element only when it knows the whole document is one.
//
// Linear in the length of the text, in time and memory: no backtracking pattern runs over the document, only over one name or one declaration at a time, and the search for an
// element's end tag (see `endTagHint`) costs one more look at the text for each KIND of element, of which a document may have MAX_ELEMENT_NAMES. A nesting depth costs one array
// slot, and nothing recurses. A refusal is the only way out of a document that does not read: no text makes it throw (a non-string is refused too).

// The predefined entities (https://www.w3.org/TR/xml/#sec-predefined-ent), the only ones a document with no document type declaration can use.
const XML_PREDEFINED = Object.freeze({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" });
const PREDEFINED_NAMES = Object.keys(XML_PREDEFINED);

// A name is `Name` or `prefix:Name`, and what may be in one is what BOTH the SDK's own parser (xmldom's tagNamePattern, which it reads the sitemap with) and every edition of XML 1.0
// (https://www.w3.org/TR/xml/#NT-Name, and Appendix B of the earlier editions) accept: a start character that is a letter or "_" — no colon — then letters, digits, combining marks, "-", "." and the middle dot,
// and at most one colon, no character beyond U+FFFF. The fifth edition, and xmldom, also take symbols, specials and format characters there (U+FEFF, U+FFFD, the arrows and the fullwidth punctuation, which
// the earlier editions refuse): a document that uses them is not one every reader reads the same way, so it is not read here.
const XMLDOM_NAME_START = /[A-Z_a-z\xC0-\xD6\xD8-\xF6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]/.source.slice(1, -1);
const XMLDOM_NAME_CHAR = `\\-.0-9${XMLDOM_NAME_START}\\u00B7\\u0300-\\u036F\\u203F-\\u2040`;
const NAME_START = `(?=[${XMLDOM_NAME_START}])[_\\p{L}\\p{Nl}]`;
const NAME_CHAR = `(?=[${XMLDOM_NAME_CHAR}])[-._\\u00B7\\p{L}\\p{Nl}\\p{Nd}\\p{Mn}\\p{Mc}]`;
// Sticky, so each one matches AT an index and never scans ahead.
const NAME = new RegExp(`${NAME_START}(?:${NAME_CHAR})*(?::${NAME_START}(?:${NAME_CHAR})*)?`, 'yu');
const NCNAME = new RegExp(`${NAME_START}(?:${NAME_CHAR})*`, 'yu');

// Every character of an XML document is a Char (https://www.w3.org/TR/xml/#NT-Char): tab, line feed, carriage return, and from U+0020 up, except the
// surrogates (a lone one in a JavaScript string is one; a pair is one character, which the `u` flag reads as one) and U+FFFE / U+FFFF. This is the one other look at
// the text, and it only refuses: it rewrites nothing, so it cannot move the boundary of a construct, and it holds in every context alike.
const ILLEGAL_CHAR = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;

// The namespace the SDK's parser treats as HTML (see the header), and the elements of it whose content it reads as raw text.
const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const RAW_TEXT_ELEMENT = /^(?:script|textarea)$/i;
// The most kinds of element a document may have. A real sitemap has about ten; each kind costs one search of the text (`endTagHint`), and this keeps the whole at a few passes.
const MAX_ELEMENT_NAMES = 256;

// `<?xml version="1.0" encoding="utf-8" standalone="yes"?>`, the part after "<?xml": the version, which must be 1.0 (1.1 reads characters differently), then
// optionally the encoding and the standalone flag, in that order (https://www.w3.org/TR/xml/#NT-XMLDecl). It is one short token, so a pattern may read it.
const XML_DECLARATION = /^[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(?:"1\.0"|'1\.0')(?:[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(?:"[A-Za-z][A-Za-z0-9._-]*"|'[A-Za-z][A-Za-z0-9._-]*'))?(?:[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(?:"(?:yes|no)"|'(?:yes|no)'))?[ \t\r\n]*$/;

const TAB = 0x09;
const LF = 0x0A;
const CR = 0x0D;
const SPACE = 0x20;
const DQUOTE = 0x22;
const HASH = 0x23;
const AMP = 0x26;
const SQUOTE = 0x27;
const SLASH = 0x2F;
const SEMICOLON = 0x3B;
const LT = 0x3C;
const EQUALS = 0x3D;
const GT = 0x3E;
const QUESTION = 0x3F;
const BANG = 0x21;
const RBRACKET = 0x5D;
const BOM = 0xFEFF;

// Where the reader is in the document: before the root element, inside it, or after it.
const PROLOG = 0;
const CONTENT = 1;
const EPILOG = 2;

const isSpace = (c) => c === SPACE || c === TAB || c === LF || c === CR;
const isXmlChar = (cp) => cp === 0x9 || cp === 0xA || cp === 0xD || (cp >= 0x20 && cp <= 0xD7FF) || (cp >= 0xE000 && cp <= 0xFFFD) || (cp >= 0x10000 && cp <= 0x10FFFF);

// A refusal carries where it happened, and is how every helper below says "this is not a document I read": the reader's one way out.
class Refusal extends Error {
  constructor(at, message) {
    super(message);
    this.at = at;
  }
}

// "line 3, column 14", counting a line end as XML does (https://www.w3.org/TR/xml/#sec-line-ends): CR LF, a lone CR and a lone LF each end one line.
function position(xml, at) {
  let line = 1;
  let column = 1;
  for (let i = 0; i < at && i < xml.length; i += 1) {
    const c = xml.charCodeAt(i);
    if (c === LF || (c === CR && xml.charCodeAt(i + 1) !== LF)) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return `line ${line}, column ${column}`;
}

/**
 * Reads `xml` as one XML document and answers with the elements whose names `wanted` accepts — all of them, or none.
 *
 *   readXmlElements('<SiteMap><Area><Group><SubArea GenPageId="…"/></Group></Area></SiteMap>', (name) => name === 'SubArea')
 *     → { ok: true, elements: [ { name: 'SubArea', path: 'SiteMap/Area/Group', attrs: { GenPageId: '…' } } ] }
 *   readXmlElements('<SiteMap/><SiteMap/>', () => true)
 *     → { ok: false, detail: 'a second root element (a document has exactly one), at line 1, column 11' }
 *
 * `path` is the names of the element's ancestors, outermost first, joined with "/" ('' for the root element); no name has a "/", so it says where the element
 * is without ambiguity. `attrs` has no prototype and holds each attribute's value as an XML parser gives it: references decoded, and a tab, a line end or a
 * carriage return in the text of the value (not one written as `&#9;`) a space (https://www.w3.org/TR/xml/#AVNormalize). Names are exact — XML is case-sensitive —
 * and a namespace prefix is part of the name.
 *
 * @param {*} xml the text of the document; anything that is not a string is refused
 * @param {(name: string) => boolean} wanted decides which elements are answered, by their names as written
 * @returns {{ ok: true, elements: { name: string, path: string, attrs: Object<string, string> }[] } | { ok: false, detail: string }}
 */
function readXmlElements(xml, wanted) {
  try {
    return { ok: true, elements: scan(xml, wanted) };
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    return { ok: false, detail: e.at === undefined ? e.message : `${e.message}, at ${position(xml, e.at)}` };
  }
}

function scan(xml, wanted) {
  if (typeof xml !== 'string') throw new Refusal(undefined, 'the XML is not text');
  const illegal = ILLEGAL_CHAR.exec(xml);
  if (illegal) throw new Refusal(illegal.index, 'a character that XML does not allow');

  const n = xml.length;
  const elements = [];
  // The names of the elements that are open, outermost first, and the default namespace each is in (a `xmlns="…"` attribute sets it, and an element inherits it).
  const open = [];
  const defaultNamespace = [];
  // For each kind of element, where the SDK's parser looks for the end of an element of that kind: the last place the text `</name>` is, or `</name` if there is none after the first start tag.
  const endTagHint = new Map();
  // The first thing the SDK's parser would misread (noteWhatTheSdkParserMisreads), refused once the document has been read to its end.
  let misread;
  let state = PROLOG;
  let at = xml.charCodeAt(0) === BOM ? 1 : 0;

  const skipSpace = (p) => {
    let q = p;
    while (isSpace(xml.charCodeAt(q))) q += 1;
    return q;
  };

  // The "&" at `p`: a predefined entity or a character reference to a character XML allows. Answers where it ends and what it stands for.
  function reference(p) {
    if (xml.charCodeAt(p + 1) === HASH) {
      // `&#38;` or `&#x26;` — a lower-case "x" only, and at least one digit.
      const hex = xml.charCodeAt(p + 2) === 0x78;
      const first = p + (hex ? 3 : 2);
      let q = first;
      for (; q < n; q += 1) {
        const c = xml.charCodeAt(q);
        const digit = (c >= 0x30 && c <= 0x39) || (hex && ((c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)));
        if (!digit) break;
      }
      if (q === first || xml.charCodeAt(q) !== SEMICOLON) throw new Refusal(p, 'a character reference that is neither &#digits; nor &#xhexdigits;');
      const code = parseInt(xml.slice(first, q), hex ? 16 : 10);
      if (!isXmlChar(code)) throw new Refusal(p, 'a character reference to a character that XML does not allow');
      return { end: q + 1, text: String.fromCodePoint(code) };
    }
    for (const name of PREDEFINED_NAMES) {
      if (xml.startsWith(`${name};`, p + 1)) return { end: p + 2 + name.length, text: XML_PREDEFINED[name] };
    }
    throw new Refusal(p, 'an "&" that is not one of the predefined entities or a character reference');
  }

  // The value of the attribute whose opening quote is at `start - 1`. The text a parser hands over: references decoded, and each tab, line end and carriage
  // return that is written in the value a single space — CR LF counts as one line end. A character reference is decoded after that, so `&#10;` stays a line feed.
  function attributeValue(start, quote) {
    let text = '';
    let run = start;
    for (let p = start; ; p += 1) {
      if (p >= n) throw new Refusal(start - 1, 'an attribute value that is never closed');
      const c = xml.charCodeAt(p);
      if (c === quote) return { end: p + 1, text: text + xml.slice(run, p) };
      if (c === LT) throw new Refusal(p, 'a "<" inside an attribute value');
      if (c === AMP) {
        const ref = reference(p);
        text += xml.slice(run, p) + ref.text;
        p = ref.end - 1;
        run = ref.end;
      } else if (c === TAB || c === LF || c === CR) {
        text += `${xml.slice(run, p)} `;
        if (c === CR && xml.charCodeAt(p + 1) === LF) p += 1;
        run = p + 1;
      }
    }
  }

  // The start tag at `from` (a "<"), up to its ">" or "/>". Answers where the tag ends.
  function startTag(from) {
    NAME.lastIndex = from + 1;
    const found = NAME.exec(xml);
    if (!found) throw new Refusal(from, 'a "<" that starts no element, comment, processing instruction or CDATA section');
    if (state === EPILOG) throw new Refusal(from, 'a second root element (a document has exactly one)');
    const name = found[0];
    const attrs = Object.create(null);
    let p = from + 1 + name.length;
    let selfClosing = false;
    for (;;) {
      const next = skipSpace(p);
      const c = xml.charCodeAt(next);
      if (c === GT) {
        p = next + 1;
        break;
      }
      if (c === SLASH) {
        if (xml.charCodeAt(next + 1) !== GT) throw new Refusal(next, 'a "/" in a tag that is not followed by ">"');
        selfClosing = true;
        p = next + 2;
        break;
      }
      if (next >= n) throw new Refusal(from, 'a tag that is never closed');
      // White space is what separates the name of the element from its first attribute, and each attribute from the next.
      if (next === p) throw new Refusal(next, 'attributes (or the end of the tag) not separated by white space');
      NAME.lastIndex = next;
      const attr = NAME.exec(xml);
      if (!attr) throw new Refusal(next, 'something in a tag that is not an attribute');
      p = skipSpace(next + attr[0].length);
      if (xml.charCodeAt(p) !== EQUALS) throw new Refusal(p, `attribute ${attr[0]} has no value (an attribute is name="value")`);
      p = skipSpace(p + 1);
      const quote = xml.charCodeAt(p);
      if (quote !== DQUOTE && quote !== SQUOTE) throw new Refusal(p, `the value of attribute ${attr[0]} is not in quotes`);
      const value = attributeValue(p + 1, quote);
      if (attr[0] in attrs) throw new Refusal(next, `attribute ${attr[0]} twice in one tag`);
      attrs[attr[0]] = value.text;
      p = value.end;
    }
    if (wanted(name)) elements.push({ name, path: open.join('/'), attrs });
    if (selfClosing) {
      if (open.length === 0) state = EPILOG;
    } else {
      noteWhatTheSdkParserMisreads(from, p - 1, name, attrs);
      open.push(name);
      state = CONTENT;
    }
    return p;
  }

  // Two things the SDK's parser (xmldom) does with the start tag of an element that is not self-closing, which make it read a document differently from XML or warn about one that is well-formed. `gt` is where the tag's
  // ">" is. Neither can happen in a sitemap the platform or the SDK writes, and a document with either is not read here, because it is one the SDK will not delete an app by:
  //   - it decides that the element is not closed when the last `</name>` in the text — once, at the first start tag of that name — comes before this tag's ">", and then warns and treats the element as closed
  //     at once. That text is anywhere: in a comment, a CDATA section or a processing instruction, or an end tag with white space before its ">" (`</Group >`) that is not the last of its name. A document that
  //     mixes `</Group>` and `</Group >` is one the SDK's app delete refuses after the pages are recorded;
  //   - an element named script or textarea in the XHTML namespace is raw text up to the first `</script>` (`</textarea>`) in the text, a CDATA section that holds one included.
  // The refusal is held until the whole document has been read, so that a document that is not well-formed is refused for that, which says more than this does.
  function noteWhatTheSdkParserMisreads(from, gt, name, attrs) {
    if (!endTagHint.has(name)) {
      if (endTagHint.size >= MAX_ELEMENT_NAMES) throw new Refusal(from, `more than ${MAX_ELEMENT_NAMES} different element names`);
      let last = xml.lastIndexOf(`</${name}>`);
      if (last < gt) last = xml.lastIndexOf(`</${name}`);
      endTagHint.set(name, last);
    }
    const inherited = defaultNamespace.length ? defaultNamespace[defaultNamespace.length - 1] : '';
    const namespace = attrs.xmlns !== undefined ? attrs.xmlns : inherited;
    defaultNamespace.push(namespace);
    if (misread) return;
    if (endTagHint.get(name) < gt) misread = new Refusal(from, `the end of <${name}> cannot be found by the SDK's parser, which looks for the text </${name}> and finds none after this tag`);
    else if (namespace === XHTML_NAMESPACE && RAW_TEXT_ELEMENT.test(name)) misread = new Refusal(from, `an XHTML <${name}> element, whose content the SDK's parser reads as raw text`);
  }

  // The closing tag at `from` ("</"): the name of the element that is open, white space allowed before the ">", and nothing else.
  function endTag(from) {
    NAME.lastIndex = from + 2;
    const found = NAME.exec(xml);
    if (!found) throw new Refusal(from, 'a closing tag with no element name');
    const p = skipSpace(from + 2 + found[0].length);
    if (xml.charCodeAt(p) !== GT) throw new Refusal(p, 'a closing tag that holds more than the element name');
    if (open.length === 0) throw new Refusal(from, `a closing tag </${found[0]}> with no element open`);
    const expected = open[open.length - 1];
    if (found[0] !== expected) throw new Refusal(from, `closing tag </${found[0]}> where </${expected}> is expected`);
    open.pop();
    defaultNamespace.pop();
    if (open.length === 0) state = EPILOG;
    return p + 1;
  }

  // Character data from `from` up to the next "<": references must be well-formed, and the sequence "]]>" is only ever the end of a CDATA section.
  function characterData(from) {
    let end = xml.indexOf('<', from);
    if (end < 0) end = n;
    for (let p = from; p < end; p += 1) {
      const c = xml.charCodeAt(p);
      if (c === AMP) {
        p = reference(p).end - 1;
      } else if (c === GT && p - from >= 2 && xml.charCodeAt(p - 1) === RBRACKET && xml.charCodeAt(p - 2) === RBRACKET) {
        throw new Refusal(p - 2, ']]> in character data (it is only the end of a CDATA section)');
      }
    }
    return end;
  }

  // `<!-- … -->`: the content has no "--" in it (so it cannot end in a "-" either: "--->" is refused), which is why the first "--" has to be the end.
  function comment(from) {
    const dashes = xml.indexOf('--', from + 4);
    if (dashes < 0) throw new Refusal(from, 'a comment that is never closed');
    if (xml.charCodeAt(dashes + 2) !== GT) throw new Refusal(dashes, "'--' inside a comment");
    return dashes + 3;
  }

  // `<?target data?>`: a target that is a name with no colon and is not "xml", then either "?>" at once or white space and data up to the first "?>".
  function processingInstruction(from) {
    NCNAME.lastIndex = from + 2;
    const target = NCNAME.exec(xml);
    if (!target) throw new Refusal(from, 'a processing instruction with no target');
    if (/^xml$/i.test(target[0])) throw new Refusal(from, 'a processing instruction named "xml" (only the XML declaration at the very start of the document may be)');
    const p = from + 2 + target[0].length;
    if (xml.startsWith('?>', p)) return p + 2;
    if (!isSpace(xml.charCodeAt(p))) throw new Refusal(p, 'a processing instruction whose target is not followed by white space or "?>"');
    const end = xml.indexOf('?>', p);
    if (end < 0) throw new Refusal(from, 'a processing instruction that is never closed');
    return end + 2;
  }

  // "<!": a comment, or a CDATA section (inside the root element only). Anything else — a document type declaration above all — is not read.
  function markupDeclaration(from) {
    if (xml.startsWith('<!--', from)) return comment(from);
    if (xml.startsWith('<![CDATA[', from)) {
      if (state !== CONTENT) throw new Refusal(from, 'a CDATA section outside the root element');
      const end = xml.indexOf(']]>', from + 9);
      if (end < 0) throw new Refusal(from, 'a CDATA section that is never closed');
      return end + 3;
    }
    throw new Refusal(from, xml.startsWith('<!DOCTYPE', from)
      ? 'a document type declaration (it is not read: its entities could expand into elements)'
      : 'markup that is neither a comment nor a CDATA section');
  }

  // The declaration is the first thing in the document, after a byte order mark, or it is not one.
  if (xml.startsWith('<?xml', at) && isSpace(xml.charCodeAt(at + 5))) {
    const end = xml.indexOf('?>', at);
    if (end < 0) throw new Refusal(at, 'an XML declaration that is never closed');
    if (!XML_DECLARATION.test(xml.slice(at + 5, end))) throw new Refusal(at, 'an XML declaration that is not <?xml version="1.0" encoding="…" standalone="yes|no"?> (the encoding and standalone parts are optional)');
    at = end + 2;
  }

  while (at < n) {
    if (xml.charCodeAt(at) !== LT) {
      if (state === CONTENT) at = characterData(at);
      else if (isSpace(xml.charCodeAt(at))) at += 1;
      else throw new Refusal(at, state === PROLOG ? 'text before the root element' : 'text after the root element');
      continue;
    }
    const next = xml.charCodeAt(at + 1);
    if (next === SLASH) at = endTag(at);
    else if (next === QUESTION) at = processingInstruction(at);
    else if (next === BANG) at = markupDeclaration(at);
    else at = startTag(at);
  }
  if (state === PROLOG) throw new Refusal(n, 'there is no root element');
  if (state === CONTENT) throw new Refusal(n, `the element <${open[open.length - 1]}> is never closed`);
  if (misread) throw misread;
  return elements;
}

module.exports = { readXmlElements, XML_PREDEFINED };
