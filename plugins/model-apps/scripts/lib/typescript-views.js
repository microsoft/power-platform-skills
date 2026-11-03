'use strict';
// The two views of a page that the lexer gives (source-literals.js: blankLiterals and blankNonCodePreservingTemplateExpressions), built from TypeScript's own parse of
// the page — so that a reading the lexer had to guess at can be checked against the parser's (pageref-resolver.js, lexNavigation).
//
// WHY. The lexer has no parser, so some of what it decides is a guess (a `/` after a `}`, a `<` that opens an element or type parameters, …), and it says where
// (`onAmbiguity`). Where a guess was wrong, its view of the page — which characters are code, which are a string's, a comment's, a regex's or JSX text — is wrong
// from there on, so the navigation oracle trusts nothing at or after the first guess. A parser settles every one of those guesses, and the plugin ships one: the
// TypeScript compiler the pages are compiled with (typescript-compiler.js, 5.8, the version the maker portal compiles with). It is loaded lazily, and only for a
// page on which the lexer guessed — pages that do are rare, so the cost (~200 ms and ~20 MB once per process, a few milliseconds a page) is paid by those alone.
//
// WHAT IT BUILDS. The same two views the lexer builds, character for character, from the tokens of TypeScript's parse (every token of the tree, read with the
// compiler's `getChildren`, and the comments in the trivia before each one):
//   - a string's body is blanked between its quotes (a JSX attribute's too); a template's text and its `${` and `}` are blanked, and its substitutions are code in
//     the executable view (`keep`), where the `}` that closes one becomes `;`, and blank in the literal view; a regex's body is blanked between its slashes, its
//     flags kept; JSX text is blanked; a comment, and a hashbang at offset 0, are blanked;
//   - blanking writes a space for every character but a line terminator, which stays.
// Where TypeScript reports any parse diagnostic, or its parse cannot be read (an exception), there is no view: the page is not one the parser vouches for.
//
// WHERE TYPESCRIPT IS NOT THE ONLY READER. Other tools read a page too — Babel's parser and esbuild compile TSX — and TypeScript's parser is more lenient than the
// language, and than theirs, in a few places. There the parse vouches for nothing either, and the lexer's reading (its frontier) stands, for every consumer alike —
// told from the parse itself, not from the lexer, whose earlier misread can hide what comes after it:
//   - a JSX attribute string after trivia (`x= '…'`) that holds a backslash: TypeScript scans it as a JavaScript string, with escapes — it scans a JSX string, with none,
//     only where the quote follows the `=` at once (scanJsxAttributeValue) — and Babel and esbuild as a JSX string, so the two end it at different quotes and read
//     different code after it: `<C x= '\'/>;//' />; navigateTo(…)` holds a call to TypeScript, and a comment to Babel;
//   - grammar the parser takes and leaves to the checker, which Babel's parser refuses: a word that strict code reserves used as a name (`await`, `yield`, `let`,
//     `static`, … — a module is strict code; https://tc39.es/ecma262/#sec-keywords-and-reserved-words) or a reserved word used as one (`type X = if`), outside the
//     places a keyword may name something (a property, a member, a JSX tag: isIdentifierName); a JSDoc type (`?T`, `T!`, `*`); a type predicate outside a return
//     type (`asserts x`); `readonly` before a type that is no array or tuple; and an empty list of type arguments or type parameters (`A<>`).
const { loadVendoredTypeScript } = require('./typescript-compiler.js');
const { blankNonCodePreservingTemplateExpressions, isLineTerminator } = require('./source-literals.js');
const { isStackOverflow } = require('./page-nesting.js');

// The views of the last sources asked about: the oracle lexes one source several times per call (resolve, stray, residual), and each would parse it again.
const CACHE_LIMIT = 8;
const cache = new Map();

// The tests that hold the LEXER to its own rules — what it reads for certain, what it reports as a guess, and what a guess costs a page when nothing else can
// settle it — read pages with the lexer alone: they turn the parser off for their process (`setParserCheck(false)`), or for a script they run, with
// MODEL_APPS_LEXER_ALONE=1 in its environment. Everything else runs with it on. Off, the gates only refuse more: the lexer's guesses stand, as they did.
let parserCheck = process.env.MODEL_APPS_LEXER_ALONE !== '1';
function setParserCheck(enabled) {
  parserCheck = Boolean(enabled);
}

/**
 * The lexer's two views of `src`, built from TypeScript's parse of it as a `.tsx` file, or null where TypeScript reports a parse diagnostic or cannot be loaded.
 * @param {string} src
 * @param {{ ts?: object }} [options] `ts`: a TypeScript namespace to parse with (a test seam; the vendored compiler otherwise)
 * @returns {null | { literal: string, keep: string, comments: Array<{ start: number, end: number, text: string }>, regexEnds: Set<number>, jsxTagEnds: Set<number> }}
 */
function typescriptViews(src, options) {
  return parseViews(src, options).views;
}

// typescriptViews, and whether the parse work failed for want of stack (`tooDeep`) — the one failure told apart from the others, because it is the page's fault and the
// maker can fix it (page-nesting.js). The caller that has no use for the difference reads `views`, which is null for it as for every other failure.
function parseViews(src, { ts = null } = {}) {
  if (!ts && !parserCheck) return NO_VIEWS;
  const text = String(src == null ? '' : src);
  if (!ts && cache.has(text)) return cache.get(text);
  let result;
  try {
    result = { views: buildViews(ts || loadVendoredTypeScript(), text), tooDeep: false };
  } catch (error) {
    // Fail closed: a compiler that cannot be loaded (its provenance check failed) or a parse that cannot be walked vouches for nothing, and the lexer's guesses stand.
    // A stack overflow in the parse or in the walk over it (one level of recursion per nested element) is the same failure, but is kept apart: it says the page nests
    // too deeply, not that it is cut off. It is recognised by what was thrown, not by a depth, as the compile's is (page-nesting.js).
    result = { views: null, tooDeep: isStackOverflow(error) };
  }
  if (!ts) {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(text, result);
  }
  return result;
}
const NO_VIEWS = Object.freeze({ views: null, tooDeep: false });

function buildViews(ts, src) {
  const sf = ts.createSourceFile('page.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (sf.parseDiagnostics.length > 0) return null;
  const literal = src.split('');
  const keep = src.split('');
  // What the lexer reports besides its views, for the structure gate (page-structure.js): every comment (commentRanges), the closing `/` of every regex and the `>` of
  // every JSX tag (endsMidStatement: a file may end on one of those, and on no other `/` or `>`).
  const comments = [];
  const regexEnds = new Set();
  const jsxTagEnds = new Set();
  const blank = (from, to, views) => {
    for (let k = from; k < to; k += 1) {
      if (isLineTerminator(src[k])) continue;
      for (const view of views) view[k] = ' ';
    }
  };
  const both = [literal, keep];
  // A comment can stand in the trivia of more than one leaf of the tree (an empty list of type arguments starts where the next token's trivia does), so each is
  // taken once.
  const seen = new Set();
  const comment = (from, to) => {
    if (seen.has(from)) return;
    seen.add(from);
    blank(from, to, both);
    comments.push({ start: from, end: to, text: src.slice(from, to) });
  };
  // A hashbang is trivia to TypeScript's scanner to the end of its line, and the comment ranges below begin after it.
  if (src.startsWith('#!')) {
    let end = 2;
    while (end < src.length && !isLineTerminator(src[end])) end += 1;
    comment(0, end);
  }
  const JSX_TAGS = new Set([ts.SyntaxKind.JsxOpeningElement, ts.SyntaxKind.JsxClosingElement, ts.SyntaxKind.JsxSelfClosingElement, ts.SyntaxKind.JsxOpeningFragment,
    ts.SyntaxKind.JsxClosingFragment]);
  // Set where the parse holds what another reader reads differently or refuses (WHERE TYPESCRIPT IS NOT THE ONLY READER, above): the parse then vouches for nothing.
  let otherReaders = false;
  const visit = (node) => {
    // JSDoc is held as a child of the node it documents and is also the leading trivia of its first token, where it is blanked as the comment it is.
    if (otherReaders || ts.isJSDoc(node)) return;
    if (readAnotherWay(ts, src, sf, node)) {
      otherReaders = true;
      return;
    }
    const children = node.getChildren(sf);
    if (children.length > 0 && !ts.isToken(node)) {
      for (const child of children) visit(child);
      return;
    }
    token(node);
  };
  const token = (node) => {
    const start = node.getStart(sf);
    // The comments in the trivia before the token: those on the line of the token before it (TypeScript's "trailing" ranges) and those after a line break (its
    // "leading" ones) — getLeadingCommentRanges alone starts collecting only at a line break. A JSX text token has no trivia: its own text, a `//` in it included,
    // is text.
    if (node.pos < start && node.kind !== ts.SyntaxKind.JsxText && node.kind !== ts.SyntaxKind.JsxTextAllWhiteSpaces) {
      for (const range of [...(ts.getTrailingCommentRanges(src, node.pos) || []), ...(ts.getLeadingCommentRanges(src, node.pos) || [])]) {
        if (range.end <= start) comment(range.pos, range.end);
      }
    }
    const end = node.end;
    if (node.kind === ts.SyntaxKind.GreaterThanToken && node.parent && JSX_TAGS.has(node.parent.kind)) jsxTagEnds.add(start);
    switch (node.kind) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
        blank(start + 1, end - 1, both);
        break;
      case ts.SyntaxKind.TemplateHead:
        // `text${`: the text and the `${` are blank in both views; the substitution after it is code in `keep`.
        blank(start + 1, end, both);
        break;
      case ts.SyntaxKind.TemplateMiddle:
      case ts.SyntaxKind.TemplateTail: {
        // `}text${` or `}text\``: the `}` that closes a substitution is `;` in `keep` (so two substitutions with only text between them cannot read as one call).
        literal[start] = ' ';
        keep[start] = ';';
        blank(start + 1, node.kind === ts.SyntaxKind.TemplateTail ? end - 1 : end, both);
        break;
      }
      case ts.SyntaxKind.RegularExpressionLiteral: {
        const close = src.lastIndexOf('/', end - 1);
        blank(start + 1, close, both);
        regexEnds.add(close);
        break;
      }
      case ts.SyntaxKind.JsxText:
      case ts.SyntaxKind.JsxTextAllWhiteSpaces:
        blank(start, end, both);
        break;
      default:
        break;
    }
  };
  visit(sf);
  if (otherReaders) return null;
  // A template's substitutions are code only in `keep`: in the literal view the whole of a template between its back-ticks is blank.
  const templates = (node) => {
    if (node.kind === ts.SyntaxKind.TemplateExpression || node.kind === ts.SyntaxKind.TemplateLiteralType) {
      blank(node.getStart(sf) + 1, node.end - 1, [literal]);
      return;
    }
    ts.forEachChild(node, templates);
  };
  templates(sf);
  comments.sort((a, b) => a.start - b.start);
  return { literal: literal.join(''), keep: keep.join(''), comments, regexEnds, jsxTagEnds };
}

// Whether `node` of the parse of `src` is read another way, or refused, by another reader (WHERE TYPESCRIPT IS NOT THE ONLY READER, above).
function readAnotherWay(ts, src, sf, node) {
  const kind = node.kind;
  const SK = ts.SyntaxKind;
  if (kind === SK.StringLiteral && node.parent && node.parent.kind === SK.JsxAttribute && node.parent.initializer === node) {
    // `x='…'` (the quote right after the `=`) is a JSX string to every reader; a comment cannot end in `=`, so a `=` right before the quote is the attribute's.
    const start = node.getStart(sf);
    return src[start - 1] !== '=' && src.slice(start, node.end).includes('\\');
  }
  if (kind === SK.Identifier) {
    // identifierToKeywordKind: the keyword the name spells, written with an escape or not (`\u0061wait` is `await`).
    const keyword = ts.identifierToKeywordKind(node);
    if (keyword === undefined || ts.isIdentifierName(node)) return false;
    return (keyword >= SK.FirstReservedWord && keyword <= SK.LastReservedWord) || (keyword >= SK.FirstFutureReservedWord && keyword <= SK.LastFutureReservedWord)
      || keyword === SK.AwaitKeyword;
  }
  // A JSDoc type outside a JSDoc comment (visit does not enter those): JSDocAllType, JSDocNullableType and the rest, which only TypeScript parses in a .tsx file.
  if (kind >= SK.FirstJSDocNode && kind <= SK.LastJSDocNode) return true;
  if (kind === SK.TypePredicate) return !(node.parent && ts.isFunctionLike(node.parent) && node.parent.type === node);
  if (kind === SK.TypeOperator && node.operator === SK.ReadonlyKeyword) return !ts.isArrayTypeNode(node.type) && !ts.isTupleTypeNode(node.type);
  return (node.typeArguments !== undefined && node.typeArguments !== null && node.typeArguments.length === 0)
    || (node.typeParameters !== undefined && node.typeParameters !== null && node.typeParameters.length === 0);
}

/**
 * The lexer's executable view of `src` and its first guess (`onAmbiguity`: { at, kind }, or null), and — where it guessed — the parser's views of the page
 * (typescriptViews), which settle the guess: null where the lexer did not guess, where it guessed a JSX attribute string after trivia (no parser settles that one), and
 * where typescriptViews has none. The one place the navigation oracle (pageref-resolver.js) and the structure gate (page-structure.js) decide which reading stands,
 * so the two never decide it differently. `tooDeep` is true where that parse ran out of stack space (page-nesting.js): the page is valid, and the lexer's view of it,
 * which stands, is the wrong one — the gates say the page nests too deeply, not that it is cut off.
 * @param {string} src
 * @returns {{ keep: string, frontier: null | { at: number, kind: string }, views: null | object, tooDeep: boolean }}
 */
function guessedPageViews(src) {
  let frontier = null;
  let jsxAttribute = false;
  const keep = blankNonCodePreservingTemplateExpressions(src, {
    onAmbiguity: (at, kind) => {
      if (kind === 'jsx-attribute') jsxAttribute = true;
      if (!frontier || at < frontier.at) frontier = { at, kind };
    },
  });
  const parsed = frontier !== null && !jsxAttribute ? parseViews(src) : NO_VIEWS;
  return { keep, frontier, views: parsed.views, tooDeep: parsed.tooDeep };
}

module.exports = { typescriptViews, parseViews, guessedPageViews, setParserCheck };
