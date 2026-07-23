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
function fieldCellIntent(logical, opts) {
  opts = opts || {};
  const control = { fieldName: String(logical).toLowerCase() };
  // isRequired is legitimate authored intent (the primary field and required=true columns
  // are required regardless of the Dataverse attribute's default requirement level).
  if (opts.isRequired) control.isRequired = true;
  // label override: rare; callers should normally let the adapter derive it from metadata.
  if (opts.label) control.label = opts.label;
  return { control };
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
              ['enabled', 'true'],
              ['parameters', ''],
              ['passExecutionContext', 'true']
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
        columns: [{
          sections: (t.sections || []).map(function (s, si) {
            const cells = (s.fields || []).map(function (fl) {
              const lg = String(fl).toLowerCase();
              return fieldCellIntent(lg, { isRequired: requiredFor(lg) });
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
    if (entity) {
      cells.push(fieldCellIntent(entity.primaryAttribute.schemaName.toLowerCase(), { isRequired: true }));
      for (let i = 0; i < (entity.columns || []).length; i++) {
        const c = entity.columns[i];
        if (!SDK_COLUMN_TYPE[c.type || 'Text']) continue;
        cells.push(fieldCellIntent(c.schemaName.toLowerCase(), { isRequired: c.required === true }));
      }
      // Parent lookups live on relationships[], not columns[]. Surface them so the parent
      // link is visible on the form; otherwise a first build shows no way to set the parent.
      const lookups = lookupColumnsFor(spec, entityLogical);
      for (let i = 0; i < lookups.length; i++) {
        cells.push(fieldCellIntent(lookups[i].logical, {}));
      }
    }
    // 2-column when field-heavy (> 6 cells), else 1; always capped by maxCols.
    const columns = Math.min(cells.length > 6 ? 2 : 1, maxCols);
    tabs = [{
      name: 'tab_general',
      label: 'General',
      expanded: true,
      visible: true,
      columns: [{
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
    status: 'Active',
    tabs: tabs,
    __explicitLayout: explicit,
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

// JsonPointer to the rows array of a specific tab/column/section by zero-based index.
function sectionRowsPointer(ti, ci, si) {
  return '/tabs/' + ti + '/columns/' + ci + '/sections/' + si + '/rows';
}

// JsonPointer to the cell hosting the BOUND field `logical`, or null if not present.
// Used by the engine's field-removal reconcile (removeElement(pointer) on the SDK). Non-field
// controls are skipped even if their fieldName matches, so a prune never targets a quick-view whose
// host lookup collides with a bound field name. Scans in declaration order — the first match wins.
function findFieldCellPointer(formJson, logical) {
  const lg = String(logical || '').toLowerCase();
  const tabs = formJson.tabs || [];
  for (let ti = 0; ti < tabs.length; ti++) {
    const cols = tabs[ti].columns || [];
    for (let ci = 0; ci < cols.length; ci++) {
      const sections = cols[ci].sections || [];
      for (let si = 0; si < sections.length; si++) {
        const rows = sections[si].rows || [];
        for (let ri = 0; ri < rows.length; ri++) {
          const cells = rows[ri].cells || [];
          for (let celli = 0; celli < cells.length; celli++) {
            const fn = cells[celli].control && cells[celli].control.fieldName;
            if (fn && String(fn).toLowerCase() === lg && !isNonFieldControl(cells[celli].control)) {
              return '/tabs/' + ti + '/columns/' + ci + '/sections/' + si + '/rows/' + ri + '/cells/' + celli;
            }
          }
        }
      }
    }
  }
  return null;
}

module.exports = {
  compileFormIntent,
  fieldCellIntent,
  notesCellIntent,
  notesSectionIntent,
  subgridCellIntent,
  quickViewCellIntent,
  formEventsRegionIntent,
  viewColumnsIntent,
  formFieldLogicals,
  firstSectionRowsPointer,
  sectionRowsPointer,
  findFieldCellPointer
};
