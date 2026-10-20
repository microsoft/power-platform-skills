'use strict';
// The OData `$filter` grammar the plugin and the bundled SDK send to Dataverse, parsed and evaluated against one row — for the
// stateful fakes, so a query is answered by what it SAYS rather than by a regex that happens to fit today's wording of it.
//
// Accepted (anything else throws, naming the text, so a new query shape fails loudly in the test that first sends it):
//   comparisons      name eq 'Contoso' · statecode ne 1 · isdefault eq true · _parentid_value eq 11111111-2222-3333-4444-555555555555
//                    · description eq null · versionnumber gt 5 (eq ne gt ge lt le)
//   functions        contains(name,'x') · startswith(name,'x') · endswith(name,'x') · tolower(name) eq 'x'
//   the CRM query function   Microsoft.Dynamics.CRM.In(PropertyName='name',PropertyValues=['a','b'])
//   logic            and · or · not · parentheses
//   lambdas          appmoduleroles_association/any(x:x/roleid eq <guid>) · …/all(…), over a collection-valued navigation the caller
//                    resolves (`options.navigate(row, name)` -> the related rows)
//   literals         'text' (a quote is doubled: 'O''Neil') · integers and decimals · true · false · null · bare GUIDs
//
// Text compares IGNORING CASE, as Dataverse does: its SQL collation is case-insensitive, so `uniquename eq 'contososd'` finds
// `ContosoSD`. A GUID compares ignoring case and braces. A column the row does not hold is `null` here: whether the column EXISTS is
// the caller's question, which a fake answers from its own schema before it evaluates a single row (describeFilter).
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query/filter-rows
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if ('(),[]=:'.includes(ch)) { tokens.push({ kind: ch }); i += 1; continue; }
    if (ch === "'") {
      let value = '';
      i += 1;
      for (;;) {
        if (i >= text.length) throw new Error(`odata-filter: unterminated text in ${JSON.stringify(text)}`);
        if (text[i] === "'") {
          if (text[i + 1] === "'") { value += "'"; i += 2; continue; }
          i += 1;
          break;
        }
        value += text[i];
        i += 1;
      }
      tokens.push({ kind: 'literal', value });
      continue;
    }
    const guid = GUID.exec(text.slice(i));
    if (guid && !/[\w-]/.test(text[i + guid[0].length] || '')) {
      tokens.push({ kind: 'literal', value: guid[0].toLowerCase(), guid: true });
      i += guid[0].length;
      continue;
    }
    const number = /^-?\d+(\.\d+)?/.exec(text.slice(i));
    if (number && !/[A-Za-z_]/.test(text[i + number[0].length] || '')) {
      tokens.push({ kind: 'literal', value: Number(number[0]) });
      i += number[0].length;
      continue;
    }
    const word = /^[A-Za-z_@$][\w.@/$]*/.exec(text.slice(i));
    if (word) {
      const w = word[0];
      if (w === 'true' || w === 'false') tokens.push({ kind: 'literal', value: w === 'true' });
      else if (w === 'null') tokens.push({ kind: 'literal', value: null });
      else tokens.push({ kind: 'word', value: w });
      i += w.length;
      continue;
    }
    throw new Error(`odata-filter: cannot read ${JSON.stringify(text.slice(i, i + 20))} in ${JSON.stringify(text)}`);
  }
  return tokens;
}

const COMPARE = new Set(['eq', 'ne', 'gt', 'ge', 'lt', 'le']);

function parseFilter(text) {
  const tokens = tokenize(String(text));
  let at = 0;
  const peek = () => tokens[at];
  const next = () => tokens[at++];
  const expect = (kind) => {
    const t = next();
    if (!t || t.kind !== kind) throw new Error(`odata-filter: expected '${kind}' in ${JSON.stringify(text)}`);
    return t;
  };
  const isWord = (t, value) => t && t.kind === 'word' && t.value.toLowerCase() === value;

  function operand() {
    const t = next();
    if (!t) throw new Error(`odata-filter: unexpected end of ${JSON.stringify(text)}`);
    if (t.kind === 'literal') return { kind: 'literal', value: t.value, guid: !!t.guid };
    if (t.kind === 'word') {
      // A lambda over a collection-valued navigation: `<navigation>/any(<variable>:<expression>)`.
      // See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query/filter-rows#lambda-expressions
      const lambda = /^(.+)\/(any|all)$/i.exec(t.value);
      if (lambda && peek() && peek().kind === '(') {
        expect('(');
        const variable = expect('word').value;
        expect(':');
        const body = orExpr();
        expect(')');
        return { kind: 'lambda', nav: lambda[1], op: lambda[2].toLowerCase(), variable, body };
      }
      if (peek() && peek().kind === '(') return call(t.value);
      return { kind: 'field', name: t.value };
    }
    if (t.kind === '(') {
      const inner = orExpr();
      expect(')');
      return inner;
    }
    throw new Error(`odata-filter: unexpected '${t.kind}' in ${JSON.stringify(text)}`);
  }

  function call(name) {
    expect('(');
    if (name === 'Microsoft.Dynamics.CRM.In') {
      // Microsoft.Dynamics.CRM.In(PropertyName='name',PropertyValues=['a','b'])
      const args = {};
      for (;;) {
        const key = expect('word').value;
        expect('=');
        if (peek() && peek().kind === '[') {
          next();
          const values = [];
          while (peek() && peek().kind !== ']') {
            values.push(expect('literal').value);
            if (peek() && peek().kind === ',') next();
          }
          expect(']');
          args[key] = values;
        } else {
          args[key] = expect('literal').value;
        }
        if (peek() && peek().kind === ',') { next(); continue; }
        break;
      }
      expect(')');
      return { kind: 'in', field: args.PropertyName, values: args.PropertyValues || [] };
    }
    const args = [];
    while (peek() && peek().kind !== ')') {
      args.push(orExpr());
      if (peek() && peek().kind === ',') next();
    }
    expect(')');
    const fn = name.toLowerCase();
    if (!['contains', 'startswith', 'endswith', 'tolower', 'toupper'].includes(fn)) throw new Error(`odata-filter: function ${name} is not modelled (${JSON.stringify(text)})`);
    return { kind: 'call', fn, args };
  }

  function comparison() {
    if (isWord(peek(), 'not')) {
      next();
      return { kind: 'not', expr: comparison() };
    }
    const left = operand();
    const t = peek();
    if (t && t.kind === 'word' && COMPARE.has(t.value.toLowerCase())) {
      next();
      return { kind: 'compare', op: t.value.toLowerCase(), left, right: operand() };
    }
    return left;
  }

  function andExpr() {
    let left = comparison();
    while (isWord(peek(), 'and')) {
      next();
      left = { kind: 'and', left, right: comparison() };
    }
    return left;
  }

  function orExpr() {
    let left = andExpr();
    while (isWord(peek(), 'or')) {
      next();
      left = { kind: 'or', left, right: andExpr() };
    }
    return left;
  }

  const ast = orExpr();
  if (at !== tokens.length) throw new Error(`odata-filter: unread text after position ${at} in ${JSON.stringify(text)}`);
  return ast;
}

const norm = (value) => {
  if (typeof value === 'string') {
    const bare = value.replace(/^\{|\}$/g, '');
    return GUID.test(bare) && bare.length === 36 ? bare.toLowerCase() : value.toLowerCase();
  }
  return value;
};

// `ctx.vars` holds the rows a lambda's variable stands for (`x` in `…/any(x:x/roleid eq …)`); `ctx.navigate(row, name)` answers a
// collection-valued navigation of a row.
function valueOf(node, row, ctx) {
  if (node.kind === 'literal') return node.value;
  if (node.kind === 'field') {
    const slash = node.name.split('/');
    if (slash.length === 2) {
      // `x/roleid` inside a lambda reads the related row the variable stands for.
      if (ctx.vars && Object.prototype.hasOwnProperty.call(ctx.vars, slash[0])) {
        const related = ctx.vars[slash[0]];
        return related[slash[1]] === undefined ? null : related[slash[1]];
      }
      // A navigation path (`parentrootroleid/roleid`) is read as the lookup's `_x_value`.
      const lookup = row[`_${slash[0]}_value`];
      return lookup === undefined ? null : lookup;
    }
    return row[node.name] === undefined ? null : row[node.name];
  }
  if (node.kind === 'call') {
    const args = node.args.map((a) => valueOf(a, row, ctx));
    if (node.fn === 'tolower') return args[0] == null ? null : String(args[0]).toLowerCase();
    if (node.fn === 'toupper') return args[0] == null ? null : String(args[0]).toUpperCase();
    const [hay, needle] = args.map((a) => (a == null ? '' : String(a).toLowerCase()));
    if (node.fn === 'contains') return hay.includes(needle);
    if (node.fn === 'startswith') return hay.startsWith(needle);
    if (node.fn === 'endswith') return hay.endsWith(needle);
  }
  return evaluate(node, row, ctx);
}

function compare(op, a, b) {
  const x = norm(a);
  const y = norm(b);
  if (op === 'eq') return x === y || (x == null && y == null);
  if (op === 'ne') return !(x === y || (x == null && y == null));
  if (x == null || y == null) return false;
  if (op === 'gt') return x > y;
  if (op === 'ge') return x >= y;
  if (op === 'lt') return x < y;
  if (op === 'le') return x <= y;
  throw new Error(`odata-filter: operator ${op}`);
}

function evaluate(node, row, ctx = {}) {
  switch (node.kind) {
    case 'and': return evaluate(node.left, row, ctx) && evaluate(node.right, row, ctx);
    case 'or': return evaluate(node.left, row, ctx) || evaluate(node.right, row, ctx);
    case 'not': return !evaluate(node.expr, row, ctx);
    case 'compare': return compare(node.op, valueOf(node.left, row, ctx), valueOf(node.right, row, ctx));
    case 'in': {
      const actual = norm(row[node.field]);
      return node.values.some((v) => norm(v) === actual);
    }
    case 'lambda': {
      if (typeof ctx.navigate !== 'function') throw new Error(`odata-filter: the navigation ${node.nav} cannot be followed here`);
      const related = ctx.navigate(row, node.nav);
      const holds = (r) => evaluate(node.body, row, { ...ctx, vars: { ...(ctx.vars || {}), [node.variable]: r } });
      return node.op === 'any' ? related.some(holds) : related.every(holds);
    }
    case 'call': return !!valueOf(node, row, ctx);
    case 'literal': return !!node.value;
    case 'field': return !!valueOf(node, row, ctx);
    default: throw new Error(`odata-filter: cannot evaluate ${node.kind}`);
  }
}

// The fields a filter reads, so a fake can refuse one it does not hold rather than answer "no rows" for a column it never modelled.
function fieldsOf(node, into = new Set()) {
  if (!node || typeof node !== 'object') return into;
  if (node.kind === 'field') into.add(node.name);
  if (node.kind === 'in') into.add(node.field);
  for (const key of ['left', 'right', 'expr', 'body']) if (node[key]) fieldsOf(node[key], into);
  for (const arg of node.args || []) fieldsOf(arg, into);
  return into;
}

// What a parsed filter reads, by where it reads it — what a fake validates against its schema BEFORE it looks at a single row, so a
// filter over an empty collection is checked exactly as one over a full one:
//   fields    the columns of the row itself (`name`, `_parentid_value`)
//   paths     a single-valued navigation followed to the key of the row it points at (`parentrootroleid/roleid`), as
//             `{ navigation, field }`
//   lambdas   a collection-valued navigation and the columns its variable reads of the related rows
//             (`appmoduleroles_association/any(x:x/roleid eq …)` -> `{ navigation: 'appmoduleroles_association', fields: ['roleid'] }`)
function describeFilter(ast) {
  const out = { fields: new Set(), paths: [], lambdas: [] };
  const visit = (node, scope) => {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'field') {
      const parts = node.name.split('/');
      if (parts.length === 1) out.fields.add(node.name);
      else if (parts.length === 2 && scope.has(parts[0])) scope.get(parts[0]).fields.add(parts[1]);
      else if (parts.length === 2) out.paths.push({ navigation: parts[0], field: parts[1] });
      else throw new Error(`odata-filter: the path ${node.name} is not modelled`);
    }
    if (node.kind === 'in') out.fields.add(node.field);
    if (node.kind === 'lambda') {
      const lambda = { navigation: node.nav, op: node.op, fields: new Set() };
      out.lambdas.push(lambda);
      visit(node.body, new Map([...scope, [node.variable, lambda]]));
      return;
    }
    for (const key of ['left', 'right', 'expr', 'body']) if (node[key]) visit(node[key], scope);
    for (const arg of node.args || []) visit(arg, scope);
  };
  visit(ast, new Map());
  return { fields: [...out.fields], paths: out.paths, lambdas: out.lambdas.map((l) => ({ ...l, fields: [...l.fields] })) };
}

// A filter's text is parsed once and kept: the fakes parse it before they enumerate (so an empty collection still refuses a filter it
// cannot answer), then evaluate the same tree against each row.
const compiled = new Map();
function compileFilter(text) {
  const key = String(text);
  if (!compiled.has(key)) compiled.set(key, parseFilter(key));
  return compiled.get(key);
}

function matchesFilter(text, row, ctx) {
  if (!text) return true;
  return evaluate(compileFilter(text), row, ctx || {});
}

module.exports = { parseFilter, compileFilter, describeFilter, matchesFilter, evaluateFilter: evaluate, filterFields: fieldsOf };
