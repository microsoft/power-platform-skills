// plugins/model-apps/scripts/lib/spec-shape.js
// Shared structural normalization for an App Spec, used by BOTH validateAppSpec (app-spec.js) and
// lintAppSpec (spec-lint.js).
//
// WHY this exists: both gates run on WORK-IN-PROGRESS specs — lint is the gate an author hits before
// plan mode, and validate runs on every hand-edited or partially-generated spec. A half-typed
// collection (`entities: {}`, a `null` left behind after deleting a column, an `appShell.areas` still
// being reshaped) must produce a structured finding, not a raw TypeError that kills the authoring
// flow. Both files previously implemented the same coercion verbatim, which is exactly the
// duplication the plugin's AGENTS.md forbids — and being duplicated, it also drifted.
//
// TWO RULES, and the second one matters more than it looks:
//   1. ARRAY-NESS — a known collection that is present but not an array is REPORTED and treated as
//      empty, so `for (const x of value)` cannot throw "object is not iterable" and `value.map(...)`
//      cannot throw "map is not a function".
//   2. NULL ENTRIES ARE ERRORS, NOT REPAIRS — a null/undefined entry is reported AND replaced with
//      `{}`. The replacement exists only so the validator can finish and report every OTHER problem
//      in one pass; it must never make the spec "valid". Normalizing silently was an active hazard:
//      validateAppSpec checks its own normalized COPY while the caller keeps the ORIGINAL, so a
//      silently-repaired `appShell.areas: [null]` passed validation and then threw inside the build
//      — AFTER the solution and data model had already been written to Dataverse. Reporting it keeps
//      the failure at the gate, where nothing has been deployed yet.
//
// What is deliberately NOT coerced: entries that are strings. Several collections legitimately hold
// scalars — `views[].columns` (['new_name']), `columns[].options` (['Open','Closed'], which may ALSO
// be objects), `alternateKeys[].columns`, `pages[].dataSources`, and a privilege's `access`. Those
// are marked `scalar` below and only have their array-ness enforced. A string entry in an OBJECT
// collection is harmless anyway: property access on a string yields undefined rather than throwing,
// so the existing "missing <field>" checks already report it.
'use strict';

// Declarative map of every collection either gate traverses, and the collections nested inside them.
// A recursive descriptor (rather than the flat per-owner lists this started as) is the point: the
// flat version silently omitted `views[].filters`, `forms[].tabs`, `pages[].dataSources` and
// `commands[].buttons[].children`, each of which still crashed lint. Adding a path here is now the
// single edit required to cover it.
//   `scalar: true` → enforce array-ness only; entries are legitimately strings.
//   `children`     → collections nested on each entry of this collection.
const COLLECTIONS = {
  entities: { children: { columns: {}, alternateKeys: {}, statusReasons: {} } },
  relationships: {},
  globalChoices: {},
  webResources: {},
  views: { children: { filters: {}, columns: { scalar: true } } },
  charts: {},
  forms: { children: { subgrids: {}, events: {}, quickViews: {}, tabs: { children: { sections: {} } } } },
  commands: { children: { buttons: { children: { children: {} } } } },
  // Business rules and their nested collections. Omitted when `businessRules[]` was introduced, so
  // an object-valued `businessRules`, `conditions` or `actions` reached a raw `for...of` and threw a
  // TypeError instead of producing a validation error naming the field — the exact failure this map
  // exists to prevent.
  businessRules: { children: { conditions: {}, actions: {} } },
  // Business process flows, for exactly the reason recorded above — and this collection repeated the
  // mistake: an object-valued `businessProcessFlows`, `stages` or `steps` reached the phase's
  // `for...of` and threw `object is not iterable` instead of "must be an array". A flow is edited
  // stage-by-stage while a process is being designed, so a mid-edit object here is realistic.
  businessProcessFlows: { children: { stages: { children: { steps: {} } } } },
  dashboards: { children: { tiles: {} } },
  pages: { children: { navigatesTo: {}, dataSources: { scalar: true } } },
  personas: { children: { jobs: { children: { privileges: {} } }, additionalPrivileges: {} } },
};

// appShell is an OBJECT at the root (not a collection), so its areas→groups→subAreas chain is walked
// separately. It is reshaped constantly while navigation is being designed, which makes a non-array
// at any of its three levels a realistic mid-edit state rather than a pathological one.
const APP_SHELL_COLLECTIONS = { areas: { children: { groups: { children: { subAreas: {} } } } } };

const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Normalize the collections described by `descriptors` on `owner`. Returns `owner` unchanged (same
// reference) when nothing needed fixing, so a well-formed spec leaves object identity intact for
// anything downstream that compares references.
// `path` is the dotted location used in messages ('' at the root, so root-level wording stays the
// historical `entities must be an array` that other callers and tests already read).
function normalizeCollections(owner, descriptors, path, errors) {
  if (!isRecord(owner)) return owner;
  let out = owner;
  const edit = () => { if (out === owner) out = { ...owner }; return out; };

  for (const [key, descriptor] of Object.entries(descriptors)) {
    const value = owner[key];
    if (value === undefined) continue;
    const here = path ? `${path}.${key}` : key;

    if (!Array.isArray(value)) {
      errors.push(`${here} must be an array`);
      edit()[key] = [];
      continue;
    }
    if (descriptor.scalar) continue; // array-ness enforced; entries are legitimately strings

    let changed = false;
    const next = value.map((item, i) => {
      // A hole is a real defect (a deleted entry), so report it rather than quietly healing it.
      if (item === null || item === undefined) {
        errors.push(`${here}[${i}] must be an object`);
        changed = true;
        return {};
      }
      if (!descriptor.children) return item;
      const fixed = normalizeCollections(item, descriptor.children, `${here}[${i}]`, errors);
      if (fixed !== item) changed = true;
      return fixed;
    });
    if (changed) edit()[key] = next;
  }
  return out;
}

// Return `{ spec, errors }` where `spec` is safe to walk with plain `for...of` / `.map()` over any
// known collection. NEVER mutates the caller's spec — a validator that rewrote its input would
// corrupt the very document the author is still editing.
//
// ROOT collections are always materialized as arrays, including absent ones. That is deliberate and
// predates this module: the code both gates share was written against a spec whose top-level
// collections are guaranteed to exist, so quietly making that conditional would be a behaviour
// change dressed up as an optimization. NESTED collections are only touched when something is
// actually wrong, so an entity that never declared `columns` does not suddenly gain an empty one.
function normalizeSpecShape(spec) {
  const errors = [];
  if (!isRecord(spec)) return { spec, errors };

  const normalized = normalizeCollections(spec, COLLECTIONS, '', errors);
  const out = normalized === spec ? { ...spec } : normalized;
  for (const key of Object.keys(COLLECTIONS)) {
    if (!Array.isArray(out[key])) out[key] = [];
  }

  if (isRecord(spec.appShell)) {
    const shell = normalizeCollections(spec.appShell, APP_SHELL_COLLECTIONS, 'appShell', errors);
    if (shell !== spec.appShell) out.appShell = shell;
  }

  return { spec: out, errors };
}

module.exports = { normalizeSpecShape, COLLECTIONS };
