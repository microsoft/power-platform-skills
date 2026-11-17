'use strict';
// What a queryRecords() answer proves, for a caller that claims "exactly one", "none" or "all of them".
//
// The bundled SDK's queryRecords() returns a plain array of rows with a NON-ENUMERABLE `hasMore` (types/schema.ts,
// RecordQueryResult): `true` when Dataverse named an `@odata.nextLink` (or a FetchXML page claimed `morerecords`), so
// the array is not every matching row; `false` when the server said nothing more exists or the read paginated to the
// end. Being non-enumerable, it does not survive a copy: `[...rows]`, `rows.slice()`, `Array.from(rows)`, `rows.filter()`
// and `JSON.parse(JSON.stringify(rows))` all drop it. So it is read here, from the array the SDK returned, before any
// copy.
//
// Measured on the bundle (tests/query-completeness.test.js):
//   - `top: 1` against a server that names a next link answers one row and `hasMore: true`; a `top` that fits answers
//     `hasMore: false`.
//   - `paginate: true` concatenates pages as they come: a row the server repeats on a later page is in the array twice.
//     A count of matches must count distinct ids, or one row read twice reads as "ambiguous".
//   - A page without a `value` array is an error (CONNECTION_ERROR), never an empty answer, so "no rows" is never a
//     malformed page in disguise.
//
// `hasMore` absent (an older bundle, or a test's hand-made SDK that returns a plain array) means the answer did not say;
// the judgement then rests on the count alone, as it did before the SDK reported it, and says `reported: false`.

/** `true` / `false` as the SDK reported it, `undefined` when the answer carries no report. */
function hasMoreOf(rows) {
  return rows && typeof rows.hasMore === 'boolean' ? rows.hasMore : undefined;
}

/**
 * The distinct rows of an answer by `idField` (first occurrence kept, order kept), with what the answer said about
 * completeness. A row with no id is kept apart (`withoutId`): it can be neither matched nor told apart from another.
 * @param {Array<object>} rows - the array queryRecords() returned (not a copy)
 * @param {string} idField
 */
function distinctRows(rows, idField) {
  const hasMore = hasMoreOf(rows);
  const seen = new Set();
  const distinct = [];
  const duplicates = [];
  let withoutId = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = row && row[idField] != null ? String(row[idField]).toLowerCase() : '';
    if (!id) { withoutId += 1; continue; }
    if (seen.has(id)) { duplicates.push(id); continue; }
    seen.add(id);
    distinct.push(row);
  }
  return { rows: distinct, duplicates, withoutId, hasMore, reported: hasMore !== undefined };
}

/**
 * Judges an "exactly one" lookup. Ask for at least two rows (`top: 2`) or paginate, so a second match can show.
 *   one         one distinct row, and the answer did not say more exist
 *   none        no row, and the answer did not say more exist
 *   ambiguous   two or more distinct rows (more may exist)
 *   incomplete  the answer said more rows exist than it carries, or held a row without an id, so neither "one" nor
 *               "none" is proven
 * @returns {{ outcome: 'one'|'none'|'ambiguous'|'incomplete', row?: object, count: number, reported: boolean, duplicates: string[] }}
 */
function exactOne(rows, idField) {
  const d = distinctRows(rows, idField);
  const base = { count: d.rows.length, reported: d.reported, duplicates: d.duplicates };
  if (d.rows.length > 1) return { outcome: 'ambiguous', ...base };
  if (d.hasMore === true || d.withoutId > 0) return { outcome: 'incomplete', ...base };
  if (d.rows.length === 1) return { outcome: 'one', row: d.rows[0], ...base };
  return { outcome: 'none', ...base };
}

/**
 * For a caller that claims it read every matching row: throws QUERY_INCOMPLETE when the answer said more exist.
 * Returns the distinct rows otherwise.
 */
function requireComplete(rows, idField, what = 'the query') {
  const d = distinctRows(rows, idField);
  if (d.hasMore === true) {
    const err = new Error(`${what} answered ${d.rows.length} row(s) and said more exist; read it with paginate: true (and no top) before relying on the whole set`);
    err.code = 'QUERY_INCOMPLETE';
    throw err;
  }
  return d.rows;
}

module.exports = { hasMoreOf, distinctRows, exactOne, requireComplete };
