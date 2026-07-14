# Power Fx Table Operations

Use this when a Canvas/MSAPP source formula includes table shaping that must survive the native port. Prefer server-side Dataverse query options for remote tables; use client-side array transforms only after the bounded result set is intentionally loaded.

| Power Fx | Native mapping | Notes |
|---|---|---|
| `Filter(Table, predicate)` | Generated service `getAll({ filter })` when remote; `.filter(...)` when local | Translate delegable predicates to OData. Keep non-delegable predicates client-side only on bounded data. |
| `Search(Table, text, col1, col2)` | Server search/filter when supported; otherwise `.filter(row => cols.some(...includes...))` | Preserve Power Fx case-insensitive substring behavior unless source used `exactin`/case-sensitive logic. |
| `Sort(Table, expr)` / `SortByColumns(Table, col, dir)` | `orderBy` for remote; `.toSorted(...)` for local | For `First(Sort(...))`, prefer `top: 1` + deterministic `orderBy`. Always include a unique tie-breaker for paged remote lists. |
| `LookUp(Table, predicate[, result])` | `get`/`getAll({ filter, top: 1 })` for remote; `.find(...)` for local | This is key-value lookup logic, not a navigation lookup label. Return `null` when missing and preserve fallback/blank handling. |
| `First(...)` / `Last(...)` | `[0] ?? null` / `.at(-1) ?? null` | If wrapped around sorted remote data, push ordering and `top` into the service call. |
| `FirstN(...)` / `LastN(...)` | `.slice(0, n)` / `.slice(-n)` | Remote `FirstN` should use `top: n`; remote `LastN` requires descending order or explicit sort before slicing. |
| `Distinct(Table, expr)` | `Array.from(new Map(rows.map(...)).values())` or `uniqBy` | Power Fx returns a single-column table with `Value`; preserve that shape if downstream formulas expect `.Value`. |
| `AddColumns(Table, name, expr)` | `.map(row => ({ ...row, [name]: expr(row) }))` | If expr reads another table via `LookUp`, prefer precomputed map or service-side denormalization to avoid N+1. |
| `DropColumns` / `ShowColumns` / `RenameColumns` | `.map(...)` projection | Preserve field names expected by downstream formulas/screens. |
| `GroupBy` / `Ungroup` | `Map`/`reduce` grouping; `.flatMap(...)` ungroup | Keep group row shape compatible with downstream `ForAll` / `AddColumns` use. |
| `ForAll(Table, expr)` | `.map` for pure transforms; `Promise.all` for independent async writes | Do not parallelize dependent writes such as create parent -> create child. |
| `Concat(Table, expr, separator)` | `rows.map(...).join(separator ?? '')` | Different from text `Concatenate(...)`; this aggregates rows into one string. |

Guardrails:
- Never count or aggregate over a capped first page unless the source was intentionally bounded.
- Prefer React Query/domain hooks for remote collections; do not store remote tables as global Canvas-style arrays.
- If a formula uses non-delegable logic over an unbounded table, return `DONE_WITH_CONCERNS` and surface the risk rather than silently fetching everything.
