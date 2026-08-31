'use strict';
// Pure compiler: App Spec → SDK canonical desired-state "intent" JSON for the NEW
// form topology (tabs[] → columns[] → sections[] → rows[] → cells[]).
//
// This module is PURE: no I/O, no Date.now, no randomness, no global state. It
// imports NO SDK/vendor bundle — the engine (sdk-build.js) owns SDK calls.
//
// Why a separate module? The new SDK version removed its per-artifact mutators and
// changed the form topology (a 'column' container layer was inserted between tab and
// section). This compiler isolates the intent translation so the build engine calls
// the SDK's generic mutation surface without hardcoding form-model logic everywhere.

const { entityByLogical } = require('./_graph.js');
const { lookupColumnsFor } = require('./app-spec.js');
const { SDK_COLUMN_TYPE } = require('./entity-provision.js');

// Arrange field cells into `columns` cells-per-row.
// Mirrors rowsFromCells in sdk-build.js but lives here so this module is
// self-contained — the build engine should call compileFormIntent, not rowsFromCells.
function rowsFromCells(cells, columns) {
  const cols = Math.max(1, Math.min(4, columns || 1));
  const rows = [];
  for (let i = 0; i < cells.length; i += cols) {
    rows.push({ cells: cells.slice(i, i + cols) });
  }
  return rows;
}

// Minimal push-ready bound-field cell.
//
// SDK T4 tenet: mutations express intent; the adapter applies defaults. The SDK
// adapter derives classId from the Dataverse attribute type and label from the
// attribute's display name. Precomputing classId or label here would drift from the
// adapter's metadata-derived values and mis-render on foreign or renamed attributes.
// Therefore classId, type, id, visible, colspan, rowspan, showLabel, and parameters
// are ALL intentionally omitted — only fieldName (canonical identity) and isRequired
// (explicit authored intent) are written. Shape proven by the SDK's form.workflow.test.ts.
//
// opts.label is accepted as an escape hatch for the rare case where a caller needs to
// supply an explicit label override (e.g. a renamed lookup whose display name in
// Dataverse differs from what the App Spec wants to show). Do not pass it for ordinary
// fields — the adapter handles them.
//
// opts.readOnly / opts.hidden are the two per-control attributes the SDK's FormXml serializer
// actually reads (measured against the vendored bundle, not inferred from its types):
//   <cell    id="…" showlabel="…" visible="${cell.visible}" colspan="…" rowspan="…">
//   <control id="…" classid="…" datafieldname="…" disabled="${control.isReadOnly}" isrequired="…">
// So visibility lives on the CELL and read-only lives on the CONTROL — they are not siblings, and
// writing either to the wrong object is silently dropped at serialize time.
function fieldCellIntent(logical, opts) {
  opts = opts || {};
  const control = { fieldName: String(logical).toLowerCase() };
  // isRequired is legitimate authored intent (the primary field and required=true columns
  // are required regardless of the Dataverse attribute's default requirement level).
  if (opts.isRequired) control.isRequired = true;
  // label override: rare; callers should normally let the adapter derive it from metadata.
  if (opts.label) control.label = opts.label;
  // Only the ENABLED state is ever written, never the disabled one. Emitting `isReadOnly: false`
  // for every ordinary field would look harmless but is destructive on a rebuild: it would
  // overwrite a lock a maker applied by hand in the designer, on a form the spec never claimed to
  // own that attribute of. Omitting the key leaves the adapter's default (editable) in place.
  if (opts.readOnly) control.isReadOnly = true;
  const cell = { control };
  // Same asymmetry, same reason: only `visible: false` is written. An explicit `true` would
  // un-hide a control someone deliberately hid outside the spec.
  if (opts.hidden) cell.visible = false;
  return cell;
}

// Column types that have NO Unified Interface form control.
//
// A Big Integer column placed on a form renders the literal text "Error loading control" on every
// record — UCI has no editor registered for the type, so the control host fails at bind time. The
// column itself is perfectly valid and stays readable/writable through the API; it simply cannot be
// shown. Auto layout therefore skips these types rather than producing a visibly broken form out of
// the box (ADO 6651696). An EXPLICIT layout still honours the author — they may be targeting a
// custom control — but validateAppSpec emits a warning so the choice is deliberate rather than accidental.
const NON_FORM_RENDERABLE_TYPES = new Set(['BigInt']);

// Normalize one entry of `tabs[].sections[].fields[]`.
//
// An entry is either a bare logical name (the original and still most common shape) or an object
// carrying per-control options:
//   "co_duedate"
//   { "name": "co_ticketnumber",   "readOnly": true }
//   { "name": "co_storypoints",    "hidden": true }
//   { "name": "co_daysremaining",  "after": "co_duedate" }
// Returns a canonical { name, readOnly, hidden, after } with `name`/`after` lower-cased, because
// every downstream comparison (form field logicals, cell pointers, Dataverse attribute logical
// names) is lower-case.
function normalizeFieldEntry(entry) {
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    return {
      name: String(entry.name || '').toLowerCase(),
      readOnly: entry.readOnly === true,
      hidden: entry.hidden === true,
      after: entry.after ? String(entry.after).toLowerCase() : undefined,
    };
  }
  return { name: String(entry || '').toLowerCase(), readOnly: false, hidden: false, after: undefined };
}

// Form-level per-field control options, keyed by column logical name:
//   "fieldOptions": { "co_ticketnumber": { "readOnly": true }, "co_daysremaining": { "after": "co_duedate" } }
//
// This is the ONLY way to reach these attributes under an AUTO layout, which has no field list to
// hang an inline object off. Under an EXPLICIT layout both work and the inline entry wins, because
// the more specific declaration should not be silently overridden by a form-wide default.
function fieldOptionsMap(formSpec) {
  const map = {};
  const fo = formSpec && formSpec.fieldOptions;
  if (!fo || typeof fo !== 'object' || Array.isArray(fo)) return map;
  for (const key of Object.keys(fo)) {
    const v = fo[key];
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    map[String(key).toLowerCase()] = {
      name: String(key).toLowerCase(),
      readOnly: v.readOnly === true,
      hidden: v.hidden === true,
      after: v.after ? String(v.after).toLowerCase() : undefined,
    };
  }
  return map;
}

// Cell for the Notes/activity-timeline control.
//
// The classId IS the intent for non-field controls (it identifies which PCF/built-in
// control to embed). It is passed in as an SDK constant — never hardcoded here, because
// the GUID lives in the SDK bundle's constants, not in the plugin. Hardcoding it would
// break when the bundle is re-vendored with a changed GUID.
// Shape proven by the SDK's form.workflow.test.ts.
function notesCellIntent(notesClassId) {
  return {
    control: {
      classId: String(notesClassId),
      fieldName: null,
      label: 'Notes',
      showLabel: false,
      parameters: {}
    }
  };
}

// The whole Notes SectionIntent — a pre-built section holding only the timeline cell.
// Appended to the first tab's single FormColumn when the form/entity opts in.
function notesSectionIntent(notesClassId) {
  return {
    name: 'section_notes',
    label: 'Notes',
    visible: true,
    showLabel: true,
    columns: 1,
    rows: [{ cells: [notesCellIntent(notesClassId)] }]
  };
}

// #5 (2026-07-15 review): a full-width (1-column) SectionIntent that hosts ONLY a sub-grid control.
// Each authored/auto sub-grid gets its own section so it SPANS the form, instead of being spliced as
// a single cell into an existing 2-column field section (which rendered the grid half-width with an
// empty column beside it). `label` is the grid's title — the engine passes the child's plural/display
// name, so the section header reads "Tickets", not the raw logical name "new_ticket". showLabel:true
// surfaces that title. sectionName defaults to a stable, relationship-derived name so a rebuild's
// idempotency scan (by RelationshipName) never double-adds it.
function subgridSectionIntent({ subgridClassId, targetEntity, relationshipName, viewId, label, sectionName }) {
  return {
    name: sectionName || ('section_grid_' + String(relationshipName || targetEntity || 'related').toLowerCase().replace(/[^a-z0-9_]/g, '_')),
    label: label,
    visible: true,
    showLabel: true,
    columns: 1,
    rows: [{ cells: [subgridCellIntent({ subgridClassId, targetEntity, relationshipName, viewId, label })] }]
  };
}

// Cell for a sub-grid (related-records list) control.
//
// subgridClassId is an SDK constant (identifies the sub-grid PCF); it is passed in —
// never hardcoded here. Shape (parameter names, casing, string-typed flags) proven by
// the SDK's form.workflow.test.ts.
function subgridCellIntent({ subgridClassId, targetEntity, relationshipName, viewId, label }) {
  return {
    control: {
      classId: String(subgridClassId),
      label,
      parameters: {
        TargetEntityType: targetEntity,
        ViewId: viewId,
        IsUserView: 'false',
        RelationshipName: relationshipName,
        ChartGridMode: 'Grid',
        RecordsPerPage: '10'
      }
    }
  };
}

// Cell for a quick-view (read-only card) control that shows related record fields.
//
// quickViewClassId is an SDK constant (identifies the quick-view PCF); it is passed in.
// The QuickForms XML includes entityname exactly as the SDK's form.workflow.test.ts
// specifies — the SDK serializer consumes this raw XML fragment unchanged.
// Shape proven by the SDK's form.workflow.test.ts.
function quickViewCellIntent({ quickViewClassId, lookupFieldName, targetEntity, quickViewFormId, label }) {
  return {
    control: {
      classId: String(quickViewClassId),
      fieldName: String(lookupFieldName).toLowerCase(),
      label,
      parameters: {
        // entityname attribute must be lowercase logical name — that is what the SDK
        // serializer writes, and what form.workflow.test.ts verifies.
        QuickForms: '<QuickFormIds><QuickFormId entityname="' + targetEntity + '">' + quickViewFormId + '</QuickFormId></QuickFormIds>',
        ControlMode: 'Edit'
      }
    }
  };
}

// Root-bag `<events>` region node for the form's /bag/c pointer.
//
// events: [{ event: 'onload'|'onsave'|'onchange', library, function, attribute? }]
// Returns the region node. The engine supplies the `i` index when it calls
// addElement('/bag/c', node) — do NOT wrap in { node }. handlerUniqueId is intentionally
// omitted: the SDK adapter mints it at serialize time so GUIDs don't collide on re-push.
// Shape (attribute inclusion, parameter order, enabled/passExecutionContext values) proven
// by the SDK's form.workflow.test.ts.
function formEventsRegionIntent(events) {
  return {
    n: 'events',
    a: [],
    c: (events || []).map(function (ev) {
      const attrs = [
        ['name', ev.event],
        ['application', 'false'],
        ['active', 'false']
      ];
      // 'attribute' is only present on onchange events; including it on onload/onsave would
      // produce invalid form XML (Dataverse only sets it when a field triggers the handler).
      if (ev.attribute) attrs.push(['attribute', ev.attribute]);
      // FormXML attribute values are strings, so the booleans are rendered rather than passed
      // through. `enabled` and `passExecutionContext` default to true because that is what an author
      // wiring a handler almost always wants — and it is what the App Spec contract documents; these
      // three were previously HARDCODED here and the authored values silently discarded, so
      // `"enabled": false` produced a handler that ran anyway.
      const flag = (v) => (v === false ? 'false' : 'true');
      return {
        n: 'event',
        a: attrs,
        c: [{
          n: 'Handlers',
          a: [],
          c: [{
            n: 'Handler',
            a: [
              ['functionName', ev.function],
              ['libraryName', ev.library],
              ['enabled', flag(ev.enabled)],
              // Dataverse expects a comma-separated argument list; an absent value is the empty
              // string, NOT a missing attribute (the platform writes `parameters=""` itself).
              ['parameters', ev.parameters === undefined || ev.parameters === null ? '' : String(ev.parameters)],
              ['passExecutionContext', flag(ev.passExecutionContext)]
            ],
            c: []
          }]
        }]
      };
    })
  };
}

// Normalize App Spec view columns to the format expected by updateElement('view', id, '/columns', …).
// Pure normalization — no merge; the engine unions with existing saved-query columns.
function viewColumnsIntent(cols) {
  return (cols || []).map(function (c, i) {
    return {
      name: String(c.name).toLowerCase(),
      width: c.width || 100,
      order: i
    };
  });
}

// Reorder a flat auto-layout cell list in place so each anchored field immediately follows its
// anchor. `positions` is { <logical>: <anchorLogical> }.
//
// Anchors are resolved against the CURRENT arrangement one at a time, in declaration order, so
// chains behave the way an author would read them: given `b after a` then `c after b`, c lands
// after the already-moved b. An anchor that is absent (or that resolves to the field itself) is
// skipped rather than treated as an error — the anchor may name a column that is not on this form.
//
// Cycles cannot hang this: each field is moved at most once, and a move only ever relocates the
// moved element, so the loop is bounded by positions.length regardless of how the anchors point.
function reorderCellsByAnchors(cells, positions) {
  const indexOfField = function (logical) {
    return cells.findIndex(function (c) {
      return c.control && String(c.control.fieldName || '').toLowerCase() === logical;
    });
  };
  for (const logical of Object.keys(positions || {})) {
    const anchor = positions[logical];
    const from = indexOfField(logical);
    const at = indexOfField(anchor);
    if (from < 0 || at < 0 || from === at) continue;
    const [moved] = cells.splice(from, 1);
    // Recompute the anchor AFTER the removal: splicing out an earlier element shifts the anchor
    // down by one, and inserting at the stale index would land the field one slot too far right.
    const anchorNow = indexOfField(anchor);
    cells.splice(anchorNow + 1, 0, moved);
  }
  return cells;
}

// Compile an App Spec form entry into the SDK's canonical desired-state intent.
//
// NEW topology: tabs[] → columns[] → sections[] → rows[] → cells[].
// The OLD topology was tabs[].sections[] (no FormColumn layer). Each tab compiles to
// exactly ONE FormColumn object ({sections:[…]}) that holds all the tab's sections.
//
// Two layout modes (ported faithfully from sdk-build.js formDef):
//   explicit — Array.isArray(formSpec.tabs) || formSpec.layout === 'explicit'
//              Authors tabs/sections/columns verbatim from the spec.
//   auto     — primary attribute + every scalar column (SDK_COLUMN_TYPE truthy) +
//              1:N parent lookups; laid into one "General" section.
//
// @param {object} spec     Full App Spec (entities[], relationships[], …)
// @param {object} formSpec One entry from spec.forms[] (entity, name, formType, …)
// @param {object} [opts]   { notesClassId: string } — the SDK constant for the timeline
//                          control. Passed at call time by the engine. If undefined at
//                          compile time, notesCellIntent(undefined) is still emitted so
//                          the notes section is present in the intent tree; the engine
//                          patches the real classId when it drives the SDK's notes factory.
function compileFormIntent(spec, formSpec, opts) {
  opts = opts || {};
  const notesClassId = opts.notesClassId;
  const entityLogical = String(formSpec.entity || '').toLowerCase();
  const entity = entityByLogical(spec, entityLogical);
  const formType = formSpec.formType || 'Main';

  // Quick Create forms must use single-column sections. Dataverse rejects multi-column
  // (columns="11"/"111") quick-create sections with "Columns in a section must be set
  // to '1'". This cap also blocks notes — quick-create forms don't host the timeline.
  const maxCols = formType === 'QuickCreate' ? 1 : 4;
  const explicit = Array.isArray(formSpec.tabs) || formSpec.layout === 'explicit';

  // Compute per-field required flag. isRequired is explicit authored intent (the primary
  // field and required===true columns are required regardless of Dataverse defaults).
  // classId and label are NOT computed here — the SDK adapter derives them from Dataverse
  // attribute metadata (SDK T4). Computing them here would drift from adapter-derived values.
  const requiredFor = function (logical) {
    if (entity && logical === entity.primaryAttribute.schemaName.toLowerCase()) return true;
    const c = entity && (entity.columns || []).find(function (x) { return x.schemaName.toLowerCase() === logical; });
    return !!(c && c.required === true);
  };

  // Per-field control options come from two places; the inline entry wins (see fieldOptionsMap).
  const formOptions = fieldOptionsMap(formSpec);
  // Ordering anchors are collected here rather than written onto the cells. A cell object is pushed
  // verbatim to the SDK via addElement, and `after` is NOT part of the SDK's cell model — it would
  // either be rejected by the structural validator or silently serialized into the FormXml. The
  // engine-only `__`-prefixed keys on the returned def are never sent (createFormShell hand-picks
  // the fields it passes to createArtifact), so that is where positioning intent belongs.
  const positions = {};
  const recordPosition = function (opt) {
    if (opt && opt.after && opt.name && opt.after !== opt.name) positions[opt.name] = opt.after;
  };
  // Merge a form-level default with an inline override for one field.
  const optionsFor = function (logical, inline) {
    const base = formOptions[logical];
    if (!base) return inline || { name: logical, readOnly: false, hidden: false, after: undefined };
    if (!inline) return base;
    return {
      name: logical,
      readOnly: inline.readOnly || base.readOnly,
      hidden: inline.hidden || base.hidden,
      after: inline.after !== undefined ? inline.after : base.after,
    };
  };

  let tabs;

  if (explicit && Array.isArray(formSpec.tabs)) {
    // Honor the authored layout verbatim. Wrap each tab's sections in a single FormColumn
    // (the new topology requires it; old tabs had sections directly without a column layer).
    tabs = formSpec.tabs.map(function (t, ti) {
      return {
        name: t.name || ('tab_' + ti),
        label: t.label || 'General',
        expanded: true,
        visible: true,
        // Each tab is one FormColumn. width is set explicitly ('100%') for exact control; as of
        // hardening-3 the SDK's normalizeColumn ALSO defaults a synthesized column's width to '100%'
        // (a belt-and-suspenders safety net), but we keep setting it here so the value is never left to
        // an implicit default and older bundles that don't default it still produce valid formxml
        // (columnToRaw omits an undefined width, which makes Dataverse reject the push).
        columns: [{
          width: '100%',
          sections: (t.sections || []).map(function (s, si) {
            const cells = (s.fields || []).map(function (fl) {
              const inline = normalizeFieldEntry(fl);
              const opt = optionsFor(inline.name, inline);
              recordPosition(opt);
              return fieldCellIntent(inline.name, { isRequired: requiredFor(inline.name), readOnly: opt.readOnly, hidden: opt.hidden });
            });
            const secCols = Math.min(s.columns || 1, maxCols);
            return {
              name: s.name || ('section_' + ti + '_' + si),
              label: s.label || 'Details',
              visible: true,
              showLabel: s.showLabel !== false,
              columns: secCols,
              rows: rowsFromCells(cells, secCols)
            };
          })
        }]
      };
    });
  } else {
    // Auto layout: primary attribute + every scalar column + 1:N parent lookups.
    // SDK_COLUMN_TYPE is truthy for scalar App Spec types (Text, Choice, Money, …).
    // Falsy (undefined) means non-scalar (Lookup, Customer, …) — skip them; they
    // come from relationships[], not columns[], and are added via lookupColumnsFor.
    const cells = [];
    const autoCell = function (logical, extra) {
      const opt = optionsFor(logical, null);
      recordPosition(opt);
      return fieldCellIntent(logical, Object.assign({ readOnly: opt.readOnly, hidden: opt.hidden }, extra || {}));
    };
    if (entity) {
      cells.push(autoCell(entity.primaryAttribute.schemaName.toLowerCase(), { isRequired: true }));
      for (let i = 0; i < (entity.columns || []).length; i++) {
        const c = entity.columns[i];
        if (!SDK_COLUMN_TYPE[c.type || 'Text']) continue;
        // Skip types UCI cannot render. Auto layout is the DEFAULT, so including one of these
        // would ship a form with a broken control to every author who never asked for the column
        // to be on a form in the first place (ADO 6651696). The column is still created and still
        // reachable through the API — only the form placement is withheld.
        if (NON_FORM_RENDERABLE_TYPES.has(c.type)) continue;
        cells.push(autoCell(c.schemaName.toLowerCase(), { isRequired: c.required === true }));
      }
      // Parent lookups live on relationships[], not columns[]. Surface them so the parent
      // link is visible on the form; otherwise a first build shows no way to set the parent.
      const lookups = lookupColumnsFor(spec, entityLogical);
      for (let i = 0; i < lookups.length; i++) {
        cells.push(autoCell(lookups[i].logical));
      }
    }
    // Apply `after` anchors to the CREATE order as well, not just the reconcile. Auto layout has no
    // authored order, so without this a fresh build would place the field by column order and the
    // first rebuild would immediately move it — the same spec producing two different forms
    // depending on whether the form already existed.
    reorderCellsByAnchors(cells, positions);
    // 2-column when field-heavy (> 6 cells), else 1; always capped by maxCols.
    const columns = Math.min(cells.length > 6 ? 2 : 1, maxCols);
    tabs = [{
      name: 'tab_general',
      label: 'General',
      expanded: true,
      visible: true,
      // width '100%' is set explicitly for exact control; hardening-3's SDK normalizeColumn also
      // defaults a synthesized column's width to '100%' as a safety net, but keeping it explicit works
      // on every bundle (an undefined width is omitted by columnToRaw and Dataverse would reject it).
      columns: [{
        width: '100%',
        sections: [{
          name: 'section_general',
          label: 'General',
          visible: true,
          showLabel: false,
          columns: columns,
          rows: rowsFromCells(cells, columns)
        }]
      }]
    }];
  }

  // Every form-level anchor is recorded, not just those for fields THIS layout places. The reconcile
  // resolves anchors against the DEPLOYED form, and positioning a control an explicit layout does not
  // re-declare is precisely the `prune: false` case the anchor exists to serve — recording only
  // placed fields made that documented (and validation-permitted) combination silently do nothing.
  // Harmless for the compile-time reorder: an unplaced field is simply not found in the cell list.
  for (const key of Object.keys(formOptions)) recordPosition(formOptions[key]);

  // Notes section (opt-in: formSpec.notes or entity.hasNotes) — Main forms only.
  // Quick-create / quick-view forms don't host the activity timeline.
  // Appended to the first tab's single FormColumn so it renders below the field sections.
  const wantNotes = formType === 'Main' && (formSpec.notes === true || (entity && entity.hasNotes === true));
  if (wantNotes) {
    // notesClassId is an SDK constant supplied by the engine at call time. If not yet
    // provided, notesCellIntent(undefined) is still emitted (the section must exist in the
    // intent tree even before the engine resolves the real classId).
    tabs[0].columns[0].sections.push(notesSectionIntent(notesClassId));
  }

  return {
    entityLogicalName: entityLogical,
    name: formSpec.name || (formSpec.entity + ' form'),
    formType: formType,
    // Optional author-pinned target id: when a table has two forms of the SAME (entity, type, name) — the
    // residual case type-scoped resolution can't disambiguate — the author sets forms[].formId to reconcile
    // that exact form. Carried verbatim (validated as a GUID at resolve time). Undefined for most forms.
    formId: formSpec.formId,
    // The maker-facing "what is this form for". Carried through to createArtifact, and omitted when
    // absent so an edit never blanks a description someone added in the maker.
    description: formSpec.description,
    status: 'Active',
    tabs: tabs,
    __explicitLayout: explicit,
    // Ordering anchors: { <logical>: <anchorLogical> }. Consumed by the engine's reconcile, which
    // MOVES an existing control to sit immediately after its anchor. Kept off the cells because a
    // cell is pushed verbatim to the SDK and `after` is not part of its model (see `positions`).
    __fieldPositions: positions,
    // Whether an EXPLICIT layout may prune deployed fields it does not list. Defaults to true (the
    // long-standing behaviour: an explicit layout is the complete desired state). `prune: false`
    // lets an author reorder or restyle a SUBSET of the fields without having to re-declare the
    // whole form just to keep the rest — the destructive coupling reported in ADO 6651439.
    __prune: formSpec.prune !== false,
    __primaryField: entity ? entity.primaryAttribute.schemaName.toLowerCase() : undefined
  };
}

// Dataverse control class ids for NON-field controls that nonetheless occupy a field cell — the
// quick-view control even carries a bound `fieldName` (its host lookup). The field-set walk below must
// NOT count these as bound form fields: otherwise the reconcile prune would resolve a quick-view's
// lookup (absent from the authored field list) to the quick-view CONTROL and delete it on every
// rebuild. These are stable platform ids (SDK ControlClassIds); a fetched BOUND field's classId is
// attribute-derived and never matches this set (Notes/subgrid already have no fieldName, but excluding
// them here too keeps findFieldCellPointer from ever targeting a non-field control).
const NON_FIELD_CONTROL_CLASS_IDS = new Set([
  '5C5600E0-1D6E-4205-A272-BE80DA87FD42', // QuickView
  'E7A81278-8635-4D9E-8D4D-59480B391C5B', // Subgrid / Grid
  '06375649-C143-495E-A496-C962E5B4488E', // Notes / Timeline
]);
function isNonFieldControl(control) {
  return !!(control && control.classId && NON_FIELD_CONTROL_CLASS_IDS.has(String(control.classId).replace(/[{}]/g, '').toUpperCase()));
}

// Ordered, de-duped, lowercased list of bound-field logical names across all
// tabs → columns → sections → rows → cells in a form intent/artifact with the NEW topology.
// Excludes controls with no fieldName (notes, subgrid) AND non-field controls that DO carry a
// fieldName (a quick-view binds a lookup — see NON_FIELD_CONTROL_CLASS_IDS).
// Ported from sdk-build.js formFieldLogicals but walks the inserted columns layer.
// Used by the engine's field-set reconcile: the add/prune accounting needs the ordered list.
function formFieldLogicals(formJson) {
  const seen = new Set();
  const out = [];
  for (const t of (formJson.tabs || [])) {
    for (const col of (t.columns || [])) {
      for (const s of (col.sections || [])) {
        for (const r of (s.rows || [])) {
          for (const c of (r.cells || [])) {
            const fn = c.control && c.control.fieldName;
            if (!fn) continue;
            // A quick-view control carries the host lookup as fieldName — it is NOT a form field.
            if (isNonFieldControl(c.control)) continue;
            const logical = String(fn).toLowerCase();
            if (seen.has(logical)) continue;
            seen.add(logical);
            out.push(logical);
          }
        }
      }
    }
  }
  return out;
}

// JsonPointer to the first existing section's `rows` array in the NEW topology.
// Scans tabs → columns until a column with ≥1 section is found. Returns '' if none.
// Mirrors the SDK workflow test's firstSectionRowsPointer helper — the engine passes this
// pointer to addElement when appending a field to the form's first section.
function firstSectionRowsPointer(formJson) {
  const tabs = formJson.tabs || [];
  for (let ti = 0; ti < tabs.length; ti++) {
    const cols = tabs[ti].columns || [];
    for (let ci = 0; ci < cols.length; ci++) {
      if ((cols[ci].sections || []).length > 0) {
        return '/tabs/' + ti + '/columns/' + ci + '/sections/0/rows';
      }
    }
  }
  return '';
}

// JsonPointer to the first tab's first FormColumn `sections` ARRAY — the container a whole sub-grid
// section is appended to (#5). Unlike firstSectionRowsPointer this targets a column even when it has
// zero sections yet (we are adding one), so it returns the first column whose `sections` is an array.
// Returns '' only when the form has no tab/column with a sections array at all.
function firstColumnSectionsPointer(formJson) {
  const tabs = formJson.tabs || [];
  for (let ti = 0; ti < tabs.length; ti++) {
    const cols = tabs[ti].columns || [];
    for (let ci = 0; ci < cols.length; ci++) {
      if (Array.isArray(cols[ci].sections)) {
        return '/tabs/' + ti + '/columns/' + ci + '/sections';
      }
    }
  }
  return '';
}

// JsonPointer to the rows array of a specific tab/column/section by zero-based index.
function sectionRowsPointer(ti, ci, si) {
  return '/tabs/' + ti + '/columns/' + ci + '/sections/' + si + '/rows';
}

// Full structural location of the cell hosting the BOUND field `logical`, or null if absent.
//
// findFieldCellPointer answers "where is it" for a remove; a MOVE additionally needs the containing
// arrays and the indices within them, and deriving those by string-splitting the pointer is both
// fragile and unreadable. Same scan and same non-field-control exclusions as findFieldCellPointer —
// that function is kept as the thin wrapper so existing callers are untouched.
function findFieldCellLocation(formJson, logical) {
  const lg = String(logical || '').toLowerCase();
  const tabs = formJson.tabs || [];
  for (let ti = 0; ti < tabs.length; ti++) {
    const cols = tabs[ti].columns || [];
    for (let ci = 0; ci < cols.length; ci++) {
      const sections = cols[ci].sections || [];
      for (let si = 0; si < sections.length; si++) {
        const rows = sections[si].rows || [];
        // Row-major ordinal of each cell WITHIN the section. A section renders as a grid, so the
        // reading order that matters is flat — in a 2-column section `[a|b] [c|d]` reads a, b, c, d,
        // and "c immediately after b" is true even though they are in different rows. Row-local
        // adjacency is therefore the wrong test for "already in place": it reports a correctly
        // positioned field as misplaced and moves it on every rebuild.
        let flat = 0;
        for (let ri = 0; ri < rows.length; ri++) {
          const cells = rows[ri].cells || [];
          for (let celli = 0; celli < cells.length; celli++, flat++) {
            const fn = cells[celli].control && cells[celli].control.fieldName;
            if (!fn || String(fn).toLowerCase() !== lg || isNonFieldControl(cells[celli].control)) continue;
            const sectionPointer = '/tabs/' + ti + '/columns/' + ci + '/sections/' + si;
            const rowsPointer = sectionPointer + '/rows';
            const rowPointer = rowsPointer + '/' + ri;
            return {
              sectionPointer,
              rowsPointer,
              rowPointer,
              cellsPointer: rowPointer + '/cells',
              cellPointer: rowPointer + '/cells/' + celli,
              rowIndex: ri,
              cellIndex: celli,
              flatIndex: flat,
              rowCellCount: cells.length,
            };
          }
        }
      }
    }
  }
  return null;
}

// JsonPointer to the cell hosting the BOUND field `logical`, or null if not present.
// Used by the engine's field-removal reconcile (removeElement(pointer) on the SDK). Non-field
// controls are skipped even if their fieldName matches, so a prune never targets a quick-view whose
// host lookup collides with a bound field name. Scans in declaration order — the first match wins.
function findFieldCellPointer(formJson, logical) {
  const loc = findFieldCellLocation(formJson, logical);
  return loc ? loc.cellPointer : null;
}

module.exports = {
  compileFormIntent,
  fieldCellIntent,
  notesCellIntent,
  notesSectionIntent,
  subgridCellIntent,
  subgridSectionIntent,
  quickViewCellIntent,
  formEventsRegionIntent,
  viewColumnsIntent,
  formFieldLogicals,
  firstSectionRowsPointer,
  firstColumnSectionsPointer,
  sectionRowsPointer,
  findFieldCellPointer,
  findFieldCellLocation,
  normalizeFieldEntry,
  fieldOptionsMap,
  NON_FORM_RENDERABLE_TYPES
};
