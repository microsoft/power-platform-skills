'use strict';

// "Generated .tsx uses only column names verified from RuntimeTypes.ts — no guessed names" (references/rules.md,
// DataAPI Rules 2 and 4: "NEVER guess column names — always verify from the generated RuntimeTypes.ts schema";
// "Reference only columns that exist in the generated schema"). Graded against the RuntimeTypes.ts a run kept,
// the schema the type generator (`genpage.js types`) wrote from the live environment, e.g.
//   export interface TableRegistrations extends BaseTableRegistrations {
//       "cr_milestone": cr_milestone,
//   }
//   export type cr_milestone = TableRow<{
//       readonly cr_milestoneid: string,
//       _cr_project_value: `/cr_project(${string})`,
//       cr_name: string,
//   }>
// The columns a page names are read where a guessed name breaks the page at run time — the arguments of its
// dataApi calls — each table from the call's first argument:
//   queryTable('t', { select: [...], orderBy: 'c asc, d desc', filter: "c eq 1 and contains(d, 'x')" })
//   retrieveRow('t', { id, select: [...] })              createRow('t', { c: v })        updateRow('t', id, { c: v })
// and every `<column>@OData.Community.Display.V1.FormattedValue` annotation key the page reads.
// An options or select value written as a name (`queryTable('t', LIST_QUERY)`, `select: SELECT_COLUMNS`) is
// followed to its declaration one level; one that is built at run time cannot be read and is not graded.
//
// The type generator does not write the columns every user-owned table has — `createdon`, `modifiedon`, the
// created/modified-by and owner lookups, `versionnumber` (none of the committed RuntimeTypes.ts files lists
// them, though their pages sort by createdon) — so those are accepted without it: they are not guesses.
// See https://learn.microsoft.com/power-apps/developer/data-platform/reference/about-entity-reference
// (the common columns of a user-owned table). Write keys holding `@` (an `@odata.bind`) are another rule's.

const { sourceView, declarationSource, matchingClose, withoutComments } = require('./tsx-structure.js');

const SYSTEM_COLUMNS = new Set([
  'createdon', 'modifiedon', 'overriddencreatedon', 'versionnumber', 'importsequencenumber',
  '_createdby_value', '_modifiedby_value', '_createdonbehalfby_value', '_modifiedonbehalfby_value',
  '_ownerid_value', '_owninguser_value', '_owningteam_value', '_owningbusinessunit_value',
  'createdby', 'modifiedby', 'ownerid', 'owninguser', 'owningteam', 'owningbusinessunit',
]);
const CALLS = /\bdataApi\s*(?:\?\.|\.)\s*(queryTable|retrieveRow|createRow|updateRow)\s*\(/g;
const FORMATTED = /^([A-Za-z_][\w]*)@OData\.Community\.Display\.V1\.FormattedValue$/;

// RuntimeTypes.ts → Map(table logical name → Set(column logical names)).
function runtimeTables(source) {
  const text = String(source || '');
  const tables = new Map();
  const block = /interface\s+TableRegistrations\b[^{]*\{([^}]*)\}/.exec(text);
  for (const m of (block?.[1] || '').matchAll(/"([^"]+)"\s*:\s*([A-Za-z_$][\w$]*)/g)) {
    const body = new RegExp(`\\btype\\s+${m[2]}\\s*=\\s*TableRow<\\{([\\s\\S]*?)\\}>`).exec(text);
    const columns = new Set();
    for (const c of (body?.[1] || '').matchAll(/^\s*(?:readonly\s+)?["']?([A-Za-z_][\w]*)["']?\s*\??\s*:/gm)) columns.add(c[1].toLowerCase());
    tables.set(m[1].toLowerCase(), columns);
  }
  return tables;
}

// The top-level arguments of a call whose `(` is at `open` in the code view: [{ start, end }].
function callArguments(code, open) {
  const close = matchingClose(code, open);
  if (close < 0) return [];
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i += 1) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 0) { args.push({ start, end: i }); start = i + 1; }
  }
  if (code.slice(start, close).trim()) args.push({ start, end: close });
  return args;
}

// A string literal's content: `'account'`, `"statecode eq 0 and contains(name, 'x')"`, or a template with no
// `${…}` (one with an interpolation is built at run time and cannot be read).
function stringValue(text) {
  const m = /^\s*(['"`])((?:(?!\1)[\s\S])*)\1\s*$/.exec(String(text));
  if (!m || (m[1] === '`' && m[2].includes('${'))) return null;
  return m[2];
}

// An argument's source, or — when it is a bare name — the value of that name's declaration in the page,
// with its comments blanked like the rest of what is read here.
function resolved(content, text) {
  const name = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(text)?.[1];
  if (!name) return text;
  const declared = declarationSource(content, name);
  const value = declared && /=\s*([\s\S]*?);?\s*$/.exec(withoutComments(declared));
  return value ? value[1].replace(/\s+as\s+const\s*$/, '') : null;
}

// The properties of an object literal's OWN top level, Map(key → value source): `{ select: [...], expand:
// { x: { select: [...] } } }` has select and expand, never the select nested in expand (another table's).
// A shorthand property (`{ id }`) maps to its name, a spread to nothing.
function topLevelProperties(src) {
  const { code } = sourceView(src);
  const open = code.indexOf('{');
  const close = open < 0 ? -1 : matchingClose(code, open);
  const props = new Map();
  if (close < 0) return props;
  let i = open + 1;
  while (i < close) {
    while (i < close && /[\s,]/.test(code[i])) i += 1;
    if (i >= close) break;
    let key = null;
    if (code[i] === '\'' || code[i] === '"') {
      const end = code.indexOf(code[i], i + 1);
      key = src.slice(i + 1, end);
      i = end + 1;
    } else if (code.startsWith('...', i)) {
      i += 3;
    } else {
      const word = /^[A-Za-z_$][\w$]*/.exec(code.slice(i));
      if (!word) { i += 1; continue; }
      key = word[0];
      i += word[0].length;
    }
    while (i < close && /\s/.test(code[i])) i += 1;
    let value = key;
    if (code[i] === ':') {
      const start = i + 1;
      let depth = 0;
      for (i += 1; i < close; i += 1) {
        const c = code[i];
        if (c === '(' || c === '[' || c === '{') depth += 1;
        else if (c === ')' || c === ']' || c === '}') depth -= 1;
        else if (c === ',' && depth === 0) break;
      }
      value = src.slice(start, i).trim();
    } else {
      // A spread, a shorthand or a method: skip to the next top-level comma.
      let depth = 0;
      for (; i < close; i += 1) {
        const c = code[i];
        if (c === '(' || c === '[' || c === '{') depth += 1;
        else if (c === ')' || c === ']' || c === '}') depth -= 1;
        else if (c === ',' && depth === 0) break;
      }
    }
    if (key !== null) props.set(key, value);
  }
  return props;
}

// The contents of the string literals in a short, comment-free source (an array of column names, an
// object's values).
const strings = (src) => [...String(src || '').matchAll(/(['"`])([^'"`]*)\1/g)].map((m) => m[2]);

// The string literals of a whole page, found by the lexer (a quote in JSX text, "Don't", is no delimiter).
function pageStrings(content) {
  const { src, code } = sourceView(content);
  const out = [];
  for (let i = 0; i < code.length; i += 1) {
    const q = code[i];
    if ((q !== '\'' && q !== '"') || src[i] !== q) continue;
    const end = code.indexOf(q, i + 1);
    if (end < 0) break;
    out.push(src.slice(i + 1, end));
    i = end;
  }
  return out;
}

// The columns an OData $filter or orderBy expression names: `statecode eq 0 and contains(name, 'x')`,
// `name asc, createdon desc`. Quoted values are dropped first, so `name eq 'Open eq'` names only `name`.
// With `paths` (a scenario's verified lookup paths, see columnProblems), a typed navigation path is read whole first —
// `customerid_account/accountid ne null`, `contains(customerid_account/name,'x')` — as { via, column }, and taken out of the
// text, so its target column is never misread as a column of the queried table. Without it the text is read exactly as before.
function expressionColumns(text, paths) {
  let bare = String(text).replace(/'[^']*'/g, "''");
  const out = [];
  if (paths) {
    bare = bare.replace(/(?<![\w/])([A-Za-z_][\w]*)\/([A-Za-z_][\w]*)(?![\w/])/g, (whole, via, column) => {
      out.push({ via, column });
      return ' '.repeat(whole.length);
    });
  }
  for (const m of bare.matchAll(/\b([A-Za-z_][\w]*)\s+(?:eq|ne|gt|ge|lt|le|asc|desc)\b/gi)) out.push(m[1]);
  for (const m of bare.matchAll(/\b(?:contains|startswith|endswith)\s*\(\s*([A-Za-z_][\w]*)/gi)) out.push(m[1]);
  for (const part of bare.split(',')) {
    const only = /^\s*([A-Za-z_][\w]*)\s*$/.exec(part);
    if (only) out.push(only[1]);
  }
  return out.filter((name) => typeof name !== 'string' || !/^(?:and|or|not|null|true|false|eq|ne|gt|ge|lt|le|asc|desc)$/i.test(name));
}

// Every column a page names in its dataApi calls, as { table, column, where } — and, with `paths`, a typed navigation path
// as { table, column, via, where }. Arguments, and the declarations a bare name resolves to, are read from the source with its
// comments blanked, so `select: ['accountid', /* was 'old_name' */ 'name']` names accountid and name only.
function namedColumns(content, paths) {
  const { code } = sourceView(content);
  const src = withoutComments(content);
  const out = [];
  for (const m of code.matchAll(CALLS)) {
    const method = m[1];
    const args = callArguments(code, m.index + m[0].length - 1).map((a) => src.slice(a.start, a.end));
    const tableText = args[0] && (stringValue(args[0]) ?? stringValue(resolved(content, args[0]) || ''));
    if (!tableText) continue;
    const table = tableText.toLowerCase();
    const where = `${method}('${table}')`;
    if (method === 'createRow' || method === 'updateRow') {
      // `payload as unknown as WritableTableRow<account>` names the payload; a literal is read as written.
      const last = args.at(-1) || '';
      const payload = resolved(content, /^\s*\{/.test(last) ? last : last.replace(/\s+as\s+[\s\S]*$/, ''));
      for (const key of payload && /^\s*\{/.test(payload) ? topLevelProperties(payload).keys() : []) {
        if (!key.includes('@')) out.push({ table, column: key, where });
      }
      continue;
    }
    const options = args.slice(1).map((a) => resolved(content, a)).find((a) => a && /^\s*\{/.test(a));
    if (!options) continue;
    const props = topLevelProperties(options);
    const select = props.get('select');
    const list = select && (/^\s*\[/.test(select) ? select : resolved(content, select));
    for (const column of list ? strings(list) : []) out.push({ table, column, where: `${where} select` });
    for (const key of ['orderBy', 'filter']) {
      const text = props.has(key) ? stringValue(props.get(key)) : null;
      for (const column of text ? expressionColumns(text, paths) : []) {
        out.push(typeof column === 'string' ? { table, column, where: `${where} ${key}` } : { table, column: column.column, via: column.via, where: `${where} ${key}` });
      }
    }
  }
  return out;
}

// Returns null when RuntimeTypes.ts registers no table or the page names no column, else a list of problems.
// `context.lookupPaths` (optional) is a scenario's verified lookup metadata — the concrete paths of
// scripts/get-lookup-metadata.js, [{ table, navigationProperty, target, referencedKey }] — and `context.targetColumns` the target
// columns verified beside it ({ account: ['name'] }: a target's primary name column a search reads). With it, a typed
// navigation path in a filter or an orderBy is checked whole: the navigation property must be a verified concrete path of the
// queried table, and the column after it the target's key, a column RuntimeTypes.ts declares on the target, or one of its
// verified columns. Without it, nothing changes: a slash in an expression gets no exemption, and its parts are read as before.
function columnProblems(files, runtimeTypes, context) {
  const tables = runtimeTables(runtimeTypes);
  if (!tables.size) return null;
  const known = (columns, name) => columns.has(name.toLowerCase()) || SYSTEM_COLUMNS.has(name.toLowerCase());
  const paths = context && Array.isArray(context.lookupPaths) ? context.lookupPaths : null;
  const targetColumns = (context && context.targetColumns) || {};
  const problems = [];
  let named = 0;
  for (const file of files) {
    for (const { table, column, via, where } of namedColumns(file.content, paths)) {
      named += 1;
      const columns = tables.get(table);
      if (via !== undefined) {
        const path = paths.find((entry) => entry.table === table && entry.navigationProperty === via);
        const verified = path && (column.toLowerCase() === String(path.referencedKey).toLowerCase()
          || (tables.get(path.target) && known(tables.get(path.target), column))
          || (targetColumns[path.target] || []).some((name) => String(name).toLowerCase() === column.toLowerCase()));
        if (!path) problems.push(`${file.name}: ${where} names ${via}/${column}, which is not a verified navigation path of ${table}`);
        else if (!verified) problems.push(`${file.name}: ${where} names ${via}/${column}, which is not a verified column of ${path.target}`);
      } else if (!columns) problems.push(`${file.name}: ${where} reads table ${table}, which RuntimeTypes.ts does not register`);
      else if (!known(columns, column)) problems.push(`${file.name}: ${where} names ${column}, which RuntimeTypes.ts does not declare on ${table}`);
    }
    // A display name read through its annotation: the column before `@` must exist on some registered table.
    for (const text of pageStrings(file.content)) {
      const base = FORMATTED.exec(text)?.[1];
      if (!base) continue;
      named += 1;
      if (![...tables.values()].some((columns) => known(columns, base))) problems.push(`${file.name}: reads the FormattedValue of ${base}, which RuntimeTypes.ts does not declare`);
    }
  }
  return named ? problems : null;
}

module.exports = { columnProblems, runtimeTables, namedColumns, SYSTEM_COLUMNS };
