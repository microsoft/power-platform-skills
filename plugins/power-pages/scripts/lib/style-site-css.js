'use strict';

const { cssTree } = require('../vendor/css-tools/css-tools.cjs');

const MAX_CSS_BYTES = 128 * 1024;
const T = cssTree.tokenTypes;
const own = (object, key) => Object.hasOwn(object, key);
const children = (node) => node?.children?.toArray() || [];
const decode = (name) => cssTree.ident.decode(name);
const canonical = (name) => {
  const value = decode(name);
  return value.startsWith('--') ? value : value.toLowerCase();
};
const plain = (value) => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const sourceOf = (node, text) => text.slice(node.loc.start.offset, node.loc.end.offset);
const isKeyframes = (name) => cssTree.keyword(name).basename === 'keyframes';

// CSS Tree 3.2's style-block parser recognizes nested rules beginning with '&',
// but treats other valid CSS nesting selectors ('.child', ':hover', '> h2') as
// malformed declarations. Extend only that dispatch using its token stream;
// declarations, rules, selectors, values, and at-rules still use CSS Tree.
// https://www.w3.org/TR/css-nesting-1/#nesting
const parser = cssTree.fork({
  node: {
    Block: {
      parse(isStyleBlock) {
        const start = this.tokenStart;
        const items = this.createList();
        this.eat(T.LeftCurlyBracket);
        while (!this.eof && this.tokenType !== T.RightCurlyBracket) {
          if ([T.WhiteSpace, T.Comment, T.Semicolon].includes(this.tokenType)) {
            this.next();
          } else if (this.tokenType === T.AtKeyword) {
            items.push(this.Atrule(isStyleBlock));
          } else if (isStyleBlock && !startsNestedRule(this)) {
            items.push(this.Declaration());
            if (this.tokenType === T.Semicolon) this.next();
          } else {
            items.push(this.Rule());
          }
        }
        this.eat(T.RightCurlyBracket);
        return { type: 'Block', loc: this.getLocation(start, this.tokenStart), children: items };
      },
    },
  },
});

function startsNestedRule(stream) {
  if (stream.tokenType === T.Ident && canonical(stream.substring(stream.tokenStart, stream.tokenEnd)).startsWith('--') &&
      stream.lookupNonWSType(1) === T.Colon) return false;
  let depth = 0;
  for (let offset = 0, type; (type = stream.lookupType(offset)); offset += 1) {
    if (!depth && type === T.LeftCurlyBracket) return true;
    if (!depth && [T.Semicolon, T.RightCurlyBracket].includes(type)) return false;
    if ([T.Function, T.LeftParenthesis, T.LeftSquareBracket].includes(type)) depth += 1;
    if ([T.RightParenthesis, T.RightSquareBracket].includes(type)) depth -= 1;
  }
  return false;
}

function fail(message) {
  throw new Error(`CSS validation: ${message}`);
}

function checkAuthoredText(text) {
  // Managed boundaries belong to the plan writer, not an authored fragment.
  // Keep this separate from destination parsing, which must accept real markers.
  if (text.toLowerCase().includes('power-pages:style-site:')) {
    fail('Authored CSS cannot contain the reserved power-pages:style-site: managed-block marker.');
  }
}

function checkText(text) {
  // CSS embedded in a page must not terminate its HTML raw-text element or become
  // executable Liquid. These are container boundaries, not a CSS feature catalog.
  // https://html.spec.whatwg.org/multipage/scripting.html#restrictions-for-contents-of-script-elements
  // Do not reject '}}' or '%}' alone: both legitimately terminate compact nested
  // CSS or a percentage declaration. Liquid execution needs an opening delimiter.
  if (/\{\{|\{%|<\s*\/\s*(?:style|script)\b/i.test(text)) {
    fail('HTML closing style/script sequences and Liquid/template delimiters are not allowed.');
  }
  if (text.includes('\0')) fail('NUL characters are not allowed; CSS tokenization would silently replace them.');
}

function escapedEnd(text, index) {
  let count = 0;
  while (index > 0 && text[--index] === '\\') count += 1;
  return count % 2 !== 0;
}

function tokensFor(text) {
  checkText(text);
  const tokens = [];
  const stack = [];
  // CSS parsers intentionally recover at EOF (e.g. url("/a" or an unfinished
  // comment). Approval cannot accept recovery that swallows later managed CSS.
  // Check the original token stream before constructing any AST.
  // https://www.w3.org/TR/css-syntax-3/#tokenization
  cssTree.tokenize(text, (type, start, end) => {
    const raw = text.slice(start, end);
    if (type === T.BadString || type === T.BadUrl ||
        // '/*/' is an EOF-recovered comment, not an overlapping open/close pair.
        (type === T.Comment && (raw.length < 4 || !raw.endsWith('*/'))) ||
        (type === T.String && (raw.length < 2 || raw.at(-1) !== raw[0] || escapedEnd(raw, raw.length - 1))) ||
        (type === T.Url && (raw.at(-1) !== ')' || escapedEnd(raw, raw.length - 1)))) {
      fail('Malformed or unterminated CSS string, URL, or comment.');
    }
    if (![T.String, T.Url, T.Comment].includes(type) && escapedEnd(raw, raw.length)) {
      fail('Dangling CSS escape would change tokenization when more CSS is appended.');
    }
    if (type === T.Function || type === T.LeftParenthesis) stack.push(T.RightParenthesis);
    if (type === T.LeftSquareBracket) stack.push(T.RightSquareBracket);
    if (type === T.LeftCurlyBracket) stack.push(T.RightCurlyBracket);
    if ([T.RightParenthesis, T.RightSquareBracket, T.RightCurlyBracket].includes(type) && stack.pop() !== type) {
      fail('Unbalanced CSS brackets, parentheses, or braces.');
    }
    tokens.push({ type, raw, start, end });
  });
  if (stack.length) fail('Unbalanced CSS brackets, parentheses, or braces.');
  return tokens;
}

function trimTokenWhitespace(text) {
  // Trimming raw characters would turn 'red\\ ' (an escaped space) into 'red\\',
  // escaping the emitted semicolon instead. Trim only standalone whitespace
  // tokens, preserving whitespace that belongs to an identifier or string.
  const tokens = tokensFor(text).filter((token) => token.type !== T.WhiteSpace);
  return tokens.length ? text.slice(tokens[0].start, tokens.at(-1).end) : '';
}

function parse(text, context = 'stylesheet') {
  const tokens = tokensFor(text);
  const meaningful = tokens.filter((token) => ![T.WhiteSpace, T.Comment].includes(token.type));
  if (context === 'selectorList' && meaningful.at(-1)?.type === T.Comma) {
    fail('Malformed selector list: trailing comma branch.');
  }
  try {
    const ast = parser.parse(text, {
      context,
      positions: true,
      // Parse DOM/keyframe selectors separately in their actual nesting context.
      // CSS Tree otherwise rejects valid leading relative nested selectors.
      parseRulePrelude: context !== 'stylesheet',
      // Values use CSS Syntax's balanced component-token structure, not the
      // bundled typed-value grammar, which can lag valid CSS features. Declaration
      // boundaries and priorities remain parsed; grammar matching is advisory.
      // https://www.w3.org/TR/css-syntax-3/#declaration-value
      parseValue: false,
      onParseError(error) { throw error; },
    });
    checkSelectorLists(ast, text);
    if (context === 'stylesheet') prepareRulePreludes(ast, text);
    return ast;
  } catch (error) {
    fail(`Malformed CSS (${error.message}). Parser recovery is not permitted.`);
  }
}

function propertyName(name) {
  if (typeof name !== 'string') fail('A declaration property must be a string.');
  const tokens = tokensFor(name);
  if (tokens.length !== 1 || tokens[0].type !== T.Ident || canonical(name) === '--') {
    fail(`Invalid declaration property ${JSON.stringify(name)}; use a single CSS identifier.`);
  }
  return canonical(name);
}

function readDeclarations(style) {
  if (!plain(style.declarations)) fail('declarations must be a plain property/value object.');
  const entries = Object.entries(style.declarations);
  if (!entries.length || entries.length > 100) fail('declarations must contain 1-100 properties.');
  const names = new Set();
  return entries.map(([name, value]) => {
    const property = propertyName(name);
    if (names.has(property)) fail(`Duplicate canonical declaration property ${property}.`);
    names.add(property);
    // Null is an explicit inline removal, not CSS and never a stylesheet value.
    // The owning inline editor performs removal against the exact original tag.
    if (value === null && style.location === 'inline' && style.owner !== 'studio') {
      return { property, value: null, node: null, text: '' };
    }
    if (typeof value !== 'string') fail('Declaration values must be strings (null removal is inline-only).');
    const text = `${name}: ${value}`;
    checkAuthoredText(text);
    const node = parse(text, 'declaration');
    if (canonical(node.property) !== property) fail('Declaration injection is not allowed.');
    if (!value.trim() && !property.startsWith('--')) fail(`Empty CSS declaration ${property}.`);
    return { property, value: trimTokenWhitespace(value), node, text };
  });
}

function checkInput(style) {
  if (!plain(style)) fail('A style must be a plain object.');
  if (own(style, 'declarations') === own(style, 'css')) {
    fail('Supply exactly one of declarations or css, never both.');
  }
  if (style.part !== undefined && typeof style.part !== 'string') fail('part must be a selector suffix string.');
  if (style.importantReason !== undefined &&
      (typeof style.importantReason !== 'string' || !style.importantReason.trim())) {
    fail('importantReason must be nonempty explanatory text.');
  }
  if (own(style, 'global') && (!own(style, 'css') || typeof style.global !== 'boolean')) {
    fail('global is a boolean available only with raw css.');
  }
  if (own(style, 'css')) {
    if (style.location === 'inline' || style.owner === 'studio' || own(style, 'part')) {
      fail('Raw css cannot be used for inline/Studio instructions or combined with part.');
    }
    if (typeof style.css !== 'string' || !style.css.trim() || Buffer.byteLength(style.css) > MAX_CSS_BYTES) {
      fail('css must be a nonempty stylesheet of at most 128 KB.');
    }
    checkAuthoredText(style.css);
  } else if (style.location === 'inline' && style.part) {
    fail('Inline declarations cannot have a selector part.');
  }
}

function literalUrl(value) {
  // URL resolution is local string processing only. Browsers normalize backslashes
  // and strip controls before resolving hosts, so reject those ambiguous spellings
  // rather than accidentally approving "/\\host" as a Web File.
  // https://url.spec.whatwg.org/#url-parsing
  if (!value || value !== value.trim() || /[\u0000-\u001f\u007f\\]/.test(value) ||
      value.includes('/*') || value.includes('*/') || value.startsWith('//')) {
    fail('URLs must be safe literal asset references, without controls, backslashes, or protocol-relative hosts.');
  }
  let parsed;
  try { parsed = new URL(value, 'https://power-pages.invalid/'); } catch { fail('Malformed literal CSS URL.'); }
  // A colon before any path/query/fragment delimiter denotes an absolute scheme.
  // Using the URL parser alone would confuse an absolute URL to our sentinel host
  // with a relative asset, and would normalize away exact consent spelling.
  const colon = value.indexOf(':');
  const boundary = [value.indexOf('/'), value.indexOf('?'), value.indexOf('#')].filter((index) => index >= 0);
  const absolute = colon >= 0 && (!boundary.length || colon < Math.min(...boundary));
  if (absolute) {
    if (parsed.protocol !== 'https:' || !/^https:\/\//i.test(value) || parsed.username || parsed.password) {
      fail('Absolute CSS URLs require literal HTTPS without credentials; use approved Web File assets instead of data:, file:, or executable payloads.');
    }
    return true;
  }
  if (parsed.origin !== 'https://power-pages.invalid') fail('CSS URL escapes the local asset origin.');
  return false;
}

function resourcesFor(style, warnings) {
  const consent = own(style, 'externalResources') ? style.externalResources : [];
  if (!Array.isArray(consent) || consent.some((url) => typeof url !== 'string')) {
    fail('externalResources must be an array of exact HTTPS URL strings.');
  }
  for (const url of consent) {
    if (!literalUrl(url)) fail('externalResources entries must be exact absolute HTTPS URL strings.');
  }
  const approved = new Set(consent);
  return (url) => {
    checkText(url);
    if (literalUrl(url)) {
      if (!approved.has(url)) fail(`External HTTPS resource ${JSON.stringify(url)} requires an EXACT match in externalResources.`);
      warnings.add(`External resource ${JSON.stringify(url)} may load in the browser; CSP, asset availability, privacy, and transitive resources remain unverified.`);
    }
  };
}

function blockedProperty(name) {
  const property = canonical(name);
  if (property.startsWith('--')) return false;
  // This is an executable-CSS denylist, not a list of supported styling features.
  const { basename } = cssTree.property(property);
  return basename === 'behavior' || basename === 'binding';
}

function inspectTokens(text, resource, warnings, stripped = false) {
  const tokens = tokensFor(text);
  const significant = tokens.filter((token) => ![T.Comment, T.WhiteSpace].includes(token.type));
  const functions = [];
  for (let index = 0; index < significant.length; index += 1) {
    const token = significant[index];
    const next = significant[index + 1];
    if (token.type === T.Ident && next?.type === T.Colon && blockedProperty(token.raw)) {
      fail('Legacy executable CSS behavior/binding properties are forbidden.');
    }
    if (token.type === T.Function) {
      const name = decode(token.raw.slice(0, -1)).toLowerCase();
      if (name === 'expression') fail('Legacy executable CSS expression() is forbidden.');
      // Escaped u\\72l("...") is a Function rather than a Url in some tokenizers.
      // Validate its arguments explicitly; var()/attr() cannot supply a reviewed
      // literal network destination. The same rule applies to modern src().
      if (name === 'url' || name === 'src') {
        if (next?.type !== T.String) {
          fail('url()/src() require one literal URL; dynamic resource construction is not permitted.');
        }
        resource(cssTree.string.decode(next.raw));
        if (significant[index + 2]?.type !== T.RightParenthesis) {
          warnings.add('URL modifiers use a literal reviewed destination, but their grammar, loading behavior, and browser support require review.');
        }
      }
      functions.push(name);
    } else if (token.type === T.LeftParenthesis) {
      functions.push(null);
    } else if (token.type === T.RightParenthesis) {
      functions.pop();
    } else if (token.type === T.Url) {
      resource(cssTree.url.decode(token.raw));
    } else if (token.type === T.String) {
      const value = cssTree.string.decode(token.raw);
      checkText(value);
      const parent = functions.at(-1);
      const previous = significant[index - 1];
      const atName = previous?.type === T.AtKeyword ? decode(previous.raw.slice(1)).toLowerCase() : '';
      if (['image-set', '-webkit-image-set', 'image'].includes(parent) ||
          ['import', 'namespace'].includes(atName)) {
        resource(value);
      } else if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/\\)/i.test(value)) {
        // Unknown functions/Raw grammar can use strings as future resource syntax.
        // Conservatively review URL-shaped strings too; never claim grammar gaps
        // imply that such strings cannot cause a request.
        resource(value);
      }
    }
  }
  if (!stripped && tokens.some((token) => token.type === T.Comment)) {
    // Legacy engines have treated comments as joins: exp/**/ression(...).
    // Rescan only actual comment tokens, never remove text inside strings/URLs
    // or alter the emitted author's CSS.
    inspectTokens(tokens.filter((token) => token.type !== T.Comment).map((token) => token.raw).join(''), resource, warnings, true);
  }
}

function grammarWarning(label, error, warnings) {
  if (!error) return;
  const kind = error.name === 'SyntaxReferenceError' ? 'does not recognize' : 'could not verify';
  warnings.add(`Bundled CSS grammar ${kind} ${label}. Correct a typo or establish actual browser support before approval; structural parsing is not semantic, Power Pages, or Studio verification.`);
}

function inspectDeclaration(node, text, style, resource, warnings, descriptor, inKeyframes = false) {
  const property = canonical(node.property);
  if (blockedProperty(property)) fail('Legacy executable CSS behavior/binding properties are forbidden.');
  const value = trimTokenWhitespace(sourceOf(node.value, text));
  if (!property.startsWith('--') &&
      !tokensFor(value).some((token) => ![T.WhiteSpace, T.Comment].includes(token.type))) {
    fail(`Empty CSS declaration ${property}.`);
  }
  inspectTokens(sourceOf(node, text), resource, warnings);
  if (node.important) {
    if (node.important !== true && decode(node.important).toLowerCase() !== 'important') {
      fail('Malformed CSS priority; only !important is a valid declaration priority.');
    }
    if (!style.importantReason?.trim()) fail('New !important requires a nonempty importantReason.');
    warnings.add(inKeyframes
      ? 'Declarations with !important inside @keyframes are ignored by CSS; remove that priority or revise the animation before approval.'
      : 'Authored !important changes cascade priority; review importantReason and verify the actual cascade before approval. Priority was not added automatically.');
  }
  if (property.startsWith('--')) {
    warnings.add('Custom-property tokens are structurally checked only; substituted values and the resulting cascade remain unverified.');
  } else {
    try {
      // Opportunistically model a value for semantic diagnostics. A failure here
      // is a grammar-knowledge gap (or a typo), not structural parse recovery.
      // Safety checks above always examine the original complete token stream,
      // including URLs/functions hidden in values that remain Raw.
      const grammarValue = cssTree.parse(value, {
        context: 'value',
        onParseError(error) { throw error; },
      });
      const result = descriptor
        ? cssTree.lexer.matchAtruleDescriptor(descriptor, property, grammarValue)
        : cssTree.lexer.matchProperty(property, grammarValue);
      grammarWarning(`${descriptor ? `@${descriptor} descriptor` : 'property/value'} ${JSON.stringify(property)}`, result.error, warnings);
    } catch (error) {
      grammarWarning(`property/value ${JSON.stringify(property)}`, error, warnings);
    }
  }
  // Keep source spelling/spacing in the value and priority; generating/minifying
  // the AST could change fallback/custom-property text. Separate objects preserve
  // duplicate declarations and differing priorities for conservative root checks.
  return { [cssTree.ident.encode(property)]: `${value}${node.important ? ' !important' : ''}` };
}

const nowhere = () => ({ contained: false, root: false, pseudo: false });

function selectorListInfo(list, context) {
  const branches = children(list).map((selector) => selectorInfo(selector, context));
  return {
    contained: branches.length > 0 && branches.every((branch) => branch.contained),
    root: branches.some((branch) => branch.root),
    pseudo: branches.length > 0 && branches.every((branch) => branch.pseudo),
  };
}

function selectorInfo(selector, context) {
  let state = nowhere();
  let subjectPseudo = false;
  const nodes = children(selector);
  const containsNesting = context.parent && tokensFor(cssTree.generate(selector))
    .some((token) => token.type === T.Delim && token.raw === '&');
  if (context.parent && !containsNesting && context.implicit !== false) {
    // CSS nesting without '&' implies an initial descendant, except leading
    // relative combinators (e.g. '+ .outside'), which still need a scope check.
    state = { ...context.parent };
    if (nodes[0]?.type !== 'Combinator') state.root = false;
  }
  for (const node of nodes) {
    if (node.type === 'Combinator') {
      if (node.name === ' ' || node.name === '>') {
        state.root = false;
      } else if (node.name === '+' || node.name === '~') {
        // A root's siblings escape. A strict descendant's siblings remain inside
        // its parent, which is already inside the component's subtree.
        state.contained = state.contained && !state.root;
        state.root = false;
      } else {
        state = nowhere();
      }
      subjectPseudo = false;
    } else if (node.type === 'ClassSelector' && decode(node.name) === context.className) {
      const alreadyDescendant = state.contained && !state.root;
      state.contained = true;
      state.root = !alreadyDescendant;
    } else if (node.type === 'NestingSelector' && context.parent) {
      const alreadyDescendant = state.contained && !state.root;
      state.contained ||= context.parent.contained;
      state.root = !alreadyDescendant && context.parent.root;
    } else if (node.type === 'PseudoElementSelector' ||
        (node.type === 'PseudoClassSelector' && ['before', 'after', 'first-line', 'first-letter'].includes(decode(node.name).toLowerCase()))) {
      subjectPseudo = true;
    } else if (node.type === 'PseudoClassSelector') {
      const name = decode(node.name).toLowerCase();
      if (name === 'scope' && context.scope) {
        state = { ...context.scope };
      } else if (name === 'is' || name === 'where') {
        const list = children(node).find((child) => child.type === 'SelectorList');
        if (list) {
          const choice = selectorListInfo(list, { ...context, parent: context.parent, implicit: false });
          if (choice.contained && !state.contained) state = choice;
        }
      }
      // :not(), :has(), and nth-* filters do not positively anchor their subject.
      // A selector inside their arguments may describe a different element.
    }
  }
  if (subjectPseudo) state.root = false;
  if (context.scope?.contained && !state.contained) {
    // @scope confines matched subjects, even when a selector doesn't spell its
    // scoping root. Such a selector might match the root itself: report it
    // conservatively rather than certifying an unknown tag/class cascade.
    state.contained = true;
    state.root = context.scope.root && !subjectPseudo;
  }
  return { ...state, pseudo: subjectPseudo };
}

function ruleSelectors(node, text, nested) {
  if (node.prelude?.type === 'SelectorList') return node.prelude;
  let selector = sourceOf(node.prelude, text);
  if (nested) {
    const insertions = [];
    let depth = 0;
    let branchStart = true;
    for (const token of tokensFor(selector)) {
      if ([T.Comment, T.WhiteSpace].includes(token.type)) continue;
      if (branchStart && token.type === T.Delim && ['>', '+', '~', '|'].includes(token.raw)) {
        insertions.push(token.start);
      }
      if (!depth) branchStart = token.type === T.Comma;
      if ([T.Function, T.LeftParenthesis, T.LeftSquareBracket].includes(token.type)) depth += 1;
      if ([T.RightParenthesis, T.RightSquareBracket].includes(token.type)) depth -= 1;
    }
    // This changes only the analysis AST, never emitted CSS. '& > h2' is the
    // explicit equivalent of a nested '> h2' relative selector.
    for (const offset of insertions.reverse()) selector = `${selector.slice(0, offset)}& ${selector.slice(offset)}`;
  }
  return parse(selector, 'selectorList');
}

function checkSelectorLists(ast, text) {
  cssTree.walk(ast, (node) => {
    if (node.type === 'SelectorList') {
      let depth = 0;
      let emptyBranch = true;
      for (const token of tokensFor(sourceOf(node, text))) {
        if ([T.Comment, T.WhiteSpace].includes(token.type)) continue;
        if (!depth && token.type === T.Comma) {
          if (emptyBranch) fail('Malformed selector list: empty comma branch.');
          emptyBranch = true;
        } else {
          emptyBranch = false;
        }
        if ([T.Function, T.LeftParenthesis, T.LeftSquareBracket].includes(token.type)) depth += 1;
        if ([T.RightParenthesis, T.RightSquareBracket].includes(token.type)) depth -= 1;
      }
      if (emptyBranch) fail('Malformed selector list: empty or trailing comma branch.');
    } else if (node.type === 'Selector') {
      const parts = children(node);
      if (parts.at(-1)?.type === 'Combinator' ||
          parts.some((part, index) => part.type === 'Combinator' && parts[index + 1]?.type === 'Combinator')) {
        fail('Malformed selector: a combinator requires a following subject.');
      }
    }
  });
}

function checkKeyframe(node, text) {
  const tokens = tokensFor(sourceOf(node.prelude, text)).filter((token) => ![T.WhiteSpace, T.Comment].includes(token.type));
  const groups = [[]];
  for (const token of tokens) {
    if (token.type === T.Comma) groups.push([]);
    else groups.at(-1).push(token);
  }
  // Named timeline ranges (e.g. 'entry 50%') are modern keyframe offsets too.
  // This is structural offset syntax, not a browser-support/animation catalog.
  if (groups.some((group) => !(
    (group.length === 1 && (group[0].type === T.Percentage ||
      (group[0].type === T.Ident && ['from', 'to'].includes(decode(group[0].raw).toLowerCase())))) ||
    (group.length === 2 && group[0].type === T.Ident && group[1].type === T.Percentage)
  ))) fail('Malformed keyframe selector; expected from, to, or percentage offsets (optionally in a named timeline range).');
  if (children(node.block).some((child) => child.type !== 'Declaration')) fail('A keyframe block must contain declarations only.');
}

function prepareRulePreludes(block, text, nested = false, keyframes = false) {
  for (const node of children(block)) {
    if (node.type === 'Rule') {
      if (keyframes) checkKeyframe(node, text);
      else node.prelude = ruleSelectors(node, text, nested);
      prepareRulePreludes(node.block, text, !keyframes, false);
    } else if (node.type === 'Atrule' && node.block) {
      const name = decode(node.name).toLowerCase();
      prepareRulePreludes(node.block, text, nested, isKeyframes(name));
    } else if (!['Declaration', 'Comment', 'Atrule'].includes(node.type)) {
      fail(`Unparsed ${node.type} cannot conceal a declaration or rule.`);
    }
  }
}

function scopedSelector(list, context, global, warnings) {
  if (list?.type !== 'SelectorList' || !children(list).length) fail('A style rule requires a parsed selector list.');
  const info = selectorListInfo(list, context);
  if (!global && !info.contained) {
    fail('Every selector branch must stay within the component class subtree; :not/:has references and preceding root siblings do not establish scope. Use explicit global:true for intentionally global rules.');
  }
  cssTree.walk(list, (node) => {
    if (node.type === 'Raw') {
      warnings.add('Selector arguments use grammar not understood by the bundled parser; positive outer anchors bound scope, but matching and browser support need review.');
    }
  });
  return info;
}

function isNamespaced(name) {
  return name.startsWith('pp-') || name.startsWith('--pp-');
}

function requireGlobal(style, warnings, description) {
  if (!style.global) fail(`${description} has stylesheet-wide effects; use a pp-/--pp- name where applicable or explicit global:true.`);
  warnings.add(`${description} has stylesheet-wide effects in the selected placement scope; review all matching elements and definition-name collisions.`);
}

function definitionPolicy(node, name, context, style, warnings) {
  const prelude = node.prelude;
  const names = [];
  if (name === 'font-face') {
    for (const declaration of children(node.block).filter((child) => child.type === 'Declaration' && canonical(child.property) === 'font-family')) {
      // Family-name scope needs explicit literal tokens even when the declaration
      // value is intentionally Raw. Do not depend on typed-value AST coverage.
      const values = tokensFor(sourceOf(declaration.value, context.text))
        .filter((token) => ![T.WhiteSpace, T.Comment].includes(token.type));
      if (values.length === 1 && values[0].type === T.String) names.push(cssTree.string.decode(values[0].raw));
      else if (values.length && values.every((value) => value.type === T.Ident)) names.push(values.map((value) => decode(value.raw)).join(' '));
      else names.push('');
    }
    if (!names.length) fail('@font-face requires an explicit font-family to review its global name.');
  } else if (name === 'layer') {
    cssTree.walk(prelude || { type: 'Raw', value: '' }, (child) => {
      if (child.type === 'Layer') names.push(decode(child.name));
    });
    // An anonymous layer has no reusable global identifier. A nested named
    // layer inherits its already-reviewed outer namespace.
    if (!names.length && prelude) requireGlobal(style, warnings, 'Unverified @layer names');
    if (context.layerNamespace) return { definition: false, layerNamespace: true };
  } else if (isKeyframes(name) || ['property', 'counter-style', 'font-palette-values', 'position-try', 'custom-media'].includes(name)) {
    const first = children(prelude)[0];
    if (first?.type === 'Identifier') names.push(decode(first.name));
    else if (first?.type === 'String') names.push(first.value);
    else names.push('');
  } else if (name === 'font-feature-values') {
    const groups = [[]];
    for (const value of children(prelude)) {
      if (value.type === 'Operator' && value.value === ',') groups.push([]);
      else groups.at(-1).push(value);
    }
    for (const values of groups) {
      if (values.length === 1 && values[0].type === 'String') names.push(values[0].value);
      else if (values.length && values.every((value) => value.type === 'Identifier')) names.push(values.map((value) => decode(value.name)).join(' '));
      else names.push('');
    }
  } else {
    return { definition: false };
  }
  if (names.some((value) => !isNamespaced(value))) requireGlobal(style, warnings, `Non-namespaced @${name} definition`);
  if (name !== 'layer') {
    warnings.add(`@${name} defines a stylesheet-wide name; namespacing reduces collisions but does not prove isolation or runtime support.`);
  }
  return { definition: name !== 'layer', layerNamespace: name === 'layer' && names.length > 0 && names.every(isNamespaced) };
}

function inspectSheet(ast, text, style, component, resource, warnings) {
  const properties = new Set();
  const rootDeclarations = [];
  const animatedProperties = new Set();
  const className = component?.className;
  const base = { className, text, parent: null, scope: null, descriptor: null, root: false, conditional: false, layerNamespace: false };

  function visit(block, context) {
    for (const node of children(block)) {
      if (node.type === 'Declaration') {
        if (!context.parent && !context.descriptor) {
          requireGlobal(style, warnings, 'Declarations outside an addressable style rule');
        }
        properties.add(canonical(node.property));
        const declaration = inspectDeclaration(node, text, style, resource, warnings, context.descriptor, context.keyframes);
        if (context.keyframes) {
          animatedProperties.add(canonical(node.property));
        } else if (context.root && className) rootDeclarations.push(declaration);
        continue;
      }
      if (node.type === 'Rule') {
        if (context.keyframes) {
          visit(node.block, { ...context, parent: nowhere(), descriptor: null });
          continue;
        }
        const info = scopedSelector(ruleSelectors(node, text, Boolean(context.parent)), context, style.global, warnings);
        const root = info.root || (style.global && !info.contained && !info.pseudo);
        if (root && (context.conditional || style.global)) {
          warnings.add('Root declaration checks are conservative for conditional/global selectors; they do not establish which rule wins or whether a condition matches.');
        }
        visit(node.block, { ...context, parent: info, root, descriptor: null });
        continue;
      }
      if (node.type === 'Atrule') {
        const name = decode(node.name).toLowerCase();
        if (name === 'layer') {
          // Layer precedence is considered before selector specificity.
          // https://www.w3.org/TR/css-cascade-5/#layer-order
          warnings.add('Normal declarations in @layer lose to unlayered Power Pages/default/theme rules at the same author origin, regardless of selector specificity; verify the real cascade before approval.');
        }
        const definition = definitionPolicy(node, name, context, style, warnings);
        grammarWarning(`at-rule @${name}`, cssTree.lexer.checkAtruleName(name), warnings);
        try { grammarWarning(`@${name} prelude`, cssTree.lexer.matchAtrulePrelude(name, node.prelude).error, warnings); }
        catch (error) { grammarWarning(`@${name} prelude`, error, warnings); }
        if (name === 'import') {
          requireGlobal(style, warnings, '@import (imported rules cannot be locally scope-checked)');
          warnings.add('Imported stylesheet contents and transitive resource URLs are not inspected; confirm their scope, trust, CSP, and availability before approval.');
        } else if (name === 'namespace') {
          requireGlobal(style, warnings, '@namespace selector interpretation');
        }
        if (!node.block) {
          if (!['charset', 'import', 'namespace', 'layer'].includes(name) && !definition.definition) {
            requireGlobal(style, warnings, `@${name} statement with unverified scope`);
          }
          continue;
        }
        const next = { ...context, layerNamespace: definition.layerNamespace || context.layerNamespace };
        if (isKeyframes(name)) {
          visit(node.block, { ...next, keyframes: true, parent: null, descriptor: null, root: false });
        } else if (name === 'scope') {
          const scope = children(node.prelude).find((child) => child.type === 'Scope');
          if (!scope && node.prelude) fail('@scope prelude cannot be safely interpreted by the structural parser.');
          next.scope = scope?.root
            ? selectorListInfo(scope.root, { ...context, parent: null })
            : context.parent || context.scope;
          next.conditional = true;
          visit(node.block, next);
        } else if (definition.definition) {
          visit(node.block, { ...next, descriptor: name, parent: null, root: false });
        } else if (context.descriptor) {
          visit(node.block, { ...next, descriptor: name, root: false });
        } else {
          const hasDescriptors = children(node.block).some((child) => child.type === 'Declaration');
          if (hasDescriptors && !context.parent) {
            requireGlobal(style, warnings, `@${name} declarations without an addressable component selector`);
            next.descriptor = name;
            next.root = Boolean(className);
          }
          next.conditional ||= name !== 'layer';
          visit(node.block, next);
        }
        continue;
      }
      if (node.type !== 'Comment') fail(`Unparsed ${node.type} cannot conceal a declaration or rule.`);
    }
  }
  visit(ast, base);
  if (animatedProperties.size) {
    // Animation-origin values outrank normal author declarations, including inline
    // styles. Projecting keyframes onto ordinary root rules invents conflicts and
    // also assumes an animation targets the root rather than a descendant.
    // https://www.w3.org/TR/css-cascade-5/#cascade-origin
    // https://www.w3.org/TR/css-animations-1/#keyframes
    warnings.add(`Keyframe declarations (${[...animatedProperties].join(', ')}) are not ordinary root stylesheet rules. Animation targets may be the root or descendants; active CSS animations outrank normal inline declarations, but !important declarations can override animations. Targeting, conditions, timing, and important conflicts require explicit cascade review.`);
  }
  if (style.global && !className) {
    warnings.add('Global CSS has no addressable component root: inline overrides and selector matching require separate source/cascade review, not a certified pass.');
  }
  return { properties: [...properties], rootDeclarations };
}

/**
 * Validate order on the complete destination, not merely a managed fragment.
 * A legal @layer statement may precede imports; a layer block or any other rule
 * closes the import band. A managed-block comment already prevents @charset
 * from being the stylesheet's byte-leading encoding declaration.
 * https://www.w3.org/TR/css-cascade-5/#at-import
 * https://www.w3.org/TR/css-syntax-3/#the-input-byte-stream
 */
function validateStylesheetOrder(css) {
  if (typeof css !== 'string') fail('The destination stylesheet must be text.');
  const ast = parse(css);
  let importBand = true;
  let charsetSeen = false;
  for (const node of children(ast)) {
    if (node.type === 'Comment') continue;
    const name = node.type === 'Atrule' ? decode(node.name).toLowerCase() : '';
    if (name === 'charset') {
      const leading = node.loc.start.offset === 0 || (node.loc.start.offset === 1 && css[0] === '\ufeff');
      if (charsetSeen || !leading || !/^@charset "[^"\r\n]+";$/.test(sourceOf(node, css))) {
        fail('@charset must be the single byte-leading @charset "encoding"; declaration, before managed comments or any other content.');
      }
      charsetSeen = true;
    } else if (name === 'import') {
      if (!importBand || node.block) fail('@import must precede style rules/blocks; only @charset and top-level @layer statements may precede imports.');
    } else if (name !== 'layer' || node.block) {
      importBand = false;
    }
  }
  cssTree.walk(ast, {
    visit: 'Atrule',
    enter(node) {
      const name = decode(node.name).toLowerCase();
      if (['charset', 'import'].includes(name) && !children(ast).includes(node)) {
        fail(`@${name} is only valid at the top level of the destination stylesheet.`);
      }
    },
  });
  return true;
}

function analyzeStyle(style, component = {}) {
  checkInput(style);
  const warnings = new Set();
  const resource = resourcesFor(style, warnings);
  const standalone = style.location === 'inline' || style.owner === 'studio';
  if (!standalone && !style.global) {
    const className = component?.className;
    const tokens = typeof className === 'string' ? tokensFor(className) : [];
    if (tokens.length !== 1 || tokens[0].type !== T.Ident ||
        !className.startsWith('pp-') || decode(className) !== className) {
      fail('Scoped styles require one stable pp-* component className.');
    }
  }
  if (own(style, 'css')) {
    const css = style.css.trim();
    const ast = parse(css);
    if (!children(ast).length) fail('css must contain a stylesheet rule or at-rule, not just comments.');
    inspectTokens(css, resource, warnings);
    validateStylesheetOrder(css);
    const result = inspectSheet(ast, css, style, component, resource, warnings);
    return { css, ...result, warnings: [...warnings] };
  }
  const entries = readDeclarations(style);
  let selector = '';
  let root = style.location === 'inline' && style.owner !== 'studio';
  if (!standalone || style.owner === 'studio') {
    // Studio parts describe an instructions-only target. A virtual class checks
    // suffix syntax/scope when no real source hook exists; it is never emitted.
    const className = component?.className || 'pp-studio-descriptor';
    selector = `.${cssTree.ident.encode(className)}${style.part || ''}`;
    checkAuthoredText(selector);
    const list = parse(selector, 'selectorList');
    const selection = scopedSelector(list, { className, text: selector }, false, warnings);
    root = style.owner !== 'studio' && selection.root;
  }
  const rootDeclarations = [];
  for (const entry of entries) {
    if (entry.node) {
      const declaration = inspectDeclaration(entry.node, entry.text, style, resource, warnings);
      if (root) rootDeclarations.push(declaration);
    }
  }
  // A decoded identifier can contain punctuation (e.g. '--a\\3b b' => '--a;b').
  // Re-encode just property identifiers when emitting, never values: otherwise
  // canonicalization itself could turn an escaped name into declaration syntax.
  const lines = entries.filter((entry) => entry.node).map(({ property, value }) => `  ${cssTree.ident.encode(property)}: ${value};`);
  const css = standalone ? lines.map((line) => line.trimStart()).join('\n') : `${selector} {\n${lines.join('\n')}\n}`;
  if (Buffer.byteLength(css) > MAX_CSS_BYTES) fail('Compiled declarations exceed 128 KB.');
  checkAuthoredText(css);
  return { css: style.owner === 'studio' ? '' : css, properties: entries.map((entry) => entry.property), warnings: [...warnings], rootDeclarations };
}

function styleProperties(style) {
  checkInput(style);
  if (own(style, 'declarations')) return readDeclarations(style).map((entry) => entry.property);
  const properties = new Set();
  cssTree.walk(parse(style.css), (node) => {
    if (node.type === 'Declaration') properties.add(canonical(node.property));
  });
  return [...properties];
}

module.exports = { analyzeStyle, styleProperties, validateStylesheetOrder };
