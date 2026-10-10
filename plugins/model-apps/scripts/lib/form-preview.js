'use strict';
// Form wireframe preview: render an App Spec form (the exact layout the builder will create,
// via formDef) as an ASCII wireframe — tabs, sections, fields with type-appropriate widget
// hints, the Notes/timeline block, and sub-grids — so the user can *see* a form during the
// interactive authoring turn before approving it. Pure (no I/O); the CLI is preview-form.js.
const { compileFormIntent } = require('./artifact-intent.js');
const { entityByLogical } = require('./_graph.js');
const { labelText } = require('./app-spec.js');

const INNER = 63; // content width inside the box borders

// Widget hint per App Spec column type. ASCII/width-1 glyphs only, so the box aligns in any
// terminal (emoji render 1 or 2 columns inconsistently across terminals).
const WIDGET = {
  Text: '[____]', Memo: '[text area]', Choice: '[▼ select]', MultiChoice: '[▼ multi-select]',
  Boolean: '[◯ yes/no]', Money: '[$ amount]', DateTime: '[date/time]', Integer: '[# number]',
  BigInt: '[# number]', Decimal: '[# number]', Double: '[# number]', File: '[file]',
  Image: '[image]', AutoNumber: '[# auto]', Customer: '[lookup]', Lookup: '[lookup]',
};

// Resolve the column type for a form field's logical name (primary, scalar column, or lookup).
function fieldType(entity, fieldName) {
  if (!entity) return 'Lookup';
  if (entity.primaryAttribute && entity.primaryAttribute.schemaName.toLowerCase() === fieldName) {
    return entity.primaryAttribute.autoNumberFormat ? 'AutoNumber' : 'Text';
  }
  const c = (entity.columns || []).find((x) => x.schemaName.toLowerCase() === fieldName);
  return c ? c.type || 'Text' : 'Lookup'; // unknown scalar -> a relationship lookup field
}

// Visual width: emoji render two columns; variation selectors render zero. Counting code
// points (not UTF-16 units) keeps the box border aligned regardless of glyph width.
function vwidth(s) {
  let w = 0;
  for (const ch of s) {
    if (ch.codePointAt(0) === 0xfe0f) continue; // variation selector — zero width
    w += /\p{Extended_Pictographic}/u.test(ch) ? 2 : 1;
  }
  return w;
}
function clip(s, w) {
  if (vwidth(s) <= w) return s;
  let out = '';
  for (const ch of s) { if (vwidth(out) + vwidth(ch) > w - 1) break; out += ch; }
  return out + '…';
}
const vpad = (s, w) => s + ' '.repeat(Math.max(0, w - vwidth(s)));
// One bordered row, padded to the inner visual width.
function row(content) {
  const s = clip(content, INNER);
  return `│ ${s}${' '.repeat(Math.max(0, INNER - vwidth(s)))} │`;
}
function rule(label) {
  const tag = label ? ` ${label} ` : '';
  const dashes = '┄'.repeat(Math.max(0, INNER - vwidth(tag)));
  return row(`${tag}${dashes}`);
}
function topBorder(title) {
  const tag = `─ ${title} `;
  return `┌${tag}${'─'.repeat(Math.max(0, INNER + 2 - vwidth(tag)))}┐`;
}
const BOTTOM = `└${'─'.repeat(INNER + 2)}┘`;

// Display label for a field logical name. compileFormIntent emits push-ready cells that OMIT the
// label (the SDK adapter derives it from attribute metadata at push, per T4), so the preview
// resolves the display name itself from the spec entity (falling back to the logical name).
function labelFor(entity, fn, lang) {
  if (!entity) return fn;
  if (entity.primaryAttribute && entity.primaryAttribute.schemaName.toLowerCase() === fn) return labelText(entity.primaryAttribute.displayName, lang) || 'Name';
  const c = (entity.columns || []).find((x) => x.schemaName.toLowerCase() === fn);
  return (c && (labelText(c.displayName, lang) || c.schemaName)) || fn;
}

// The authored, non-default state of one cell, as the suffix that is appended to its label.
// `compileFormIntent` writes only the NON-default state (see artifact-intent.js): a hidden cell gets
// `cell.visible = false` and a read-only one `control.isReadOnly = true`; the visible/editable
// defaults are never emitted. So presence of the flag is the signal, and `isReadOnly: false` never
// appears to be mistaken for an authored read-write intent.
//
// Shared with the row renderer, which needs the tag's WIDTH to decide whether a row must be stacked
// — deriving it twice is how the two would drift apart.
function stateTag(cell) {
  const state = [];
  if (cell.visible === false) state.push('hidden');
  if (cell.control && cell.control.isReadOnly) state.push('read-only');
  return state.length ? ` (${state.join(', ')})` : '';
}

// "Label * (state)  [widget]" for one field cell.
//
// State is placed BEFORE the widget deliberately, and `avail` (the cell's rendered width) lets this
// protect the state further. Cells are clipped to the column width and `clip()` truncates the END,
// so an annotation appended after the widget is exactly what gets cut. Ordering alone is still not
// enough: with a long display name the annotation itself is what gets cut, producing "(read-o…" — a
// half-printed state flag, which is the silent-state failure this annotation exists to prevent. A
// truncated LABEL stays recognisable; a truncated state does not. So the decorative widget hint is
// surrendered first, the name is truncated after that, and the state is never truncated.
//
// When even that is not enough — the tag alone is wider than the column — the ROW renderer stacks
// the cells at full width instead of calling this with an impossible `avail`.
function fieldLabel(entity, cell, lang, avail) {
  const fn = cell.control.fieldName;
  const req = cell.control.isRequired ? ' *' : '';
  const widget = WIDGET[fieldType(entity, fn)] || WIDGET.Text;
  const tag = stateTag(cell);
  const name = cell.control.label || labelFor(entity, fn, lang);
  const full = `${name}${req}${tag}  ${widget}`;
  if (!tag || !avail || vwidth(full) <= avail) return full;
  const noWidget = `${name}${req}${tag}`;
  if (vwidth(noWidget) <= avail) return noWidget;
  return `${clip(name, Math.max(1, avail - vwidth(`${req}${tag}`)))}${req}${tag}`;
}

// Render one form to an ASCII wireframe string.
function renderFormWireframe(spec, f) {
  const entity = entityByLogical(spec, f.entity || '');
  // compileFormIntent is the single source of form topology (new SDK shape
  // tabs[].columns[].sections[]). notesClassId is irrelevant to the preview (it keys the notes
  // section by name, not classId), so a placeholder is fine.
  const def = compileFormIntent(spec, f, {});
  const lines = [];
  const typeTag = def.formType && def.formType !== 'Main' ? ` [${def.formType}]` : '';
  lines.push(topBorder(`${def.name || f.entity}${typeTag}`));

  const tabLabels = def.tabs.map((t) => t.label || 'General');
  if (tabLabels.length > 1) {
    lines.push(row(`Tabs:  ${tabLabels.map((t, i) => (i === 0 ? `‹${t}›` : t)).join('   ')}`));
    lines.push(row(''));
  }

  for (const tab of def.tabs) {
    // The banner carries the tab's authored STATE, so it must render whenever that state is not the
    // default — not only when there are several tabs to tell apart. A single tab that is collapsed or
    // hidden would otherwise preview as an ordinary open tab, and the wireframe IS the approval gate:
    // silently dropping "(collapsed)" or "(hidden)" has the maker approve a different form.
    const annotated = tab.expanded === false || tab.visible === false;
    if (tabLabels.length > 1 || annotated) lines.push(row(`${tab.expanded === false ? '▸' : '▾'} ${tab.label || 'General'}${tab.visible === false ? '   (hidden)' : ''}${tab.expanded === false ? '   (collapsed)' : ''}`));
    // New topology inserts a FormColumn layer between tab and section.
    const cols = tab.columns || [];
    for (let ci = 0; ci < cols.length; ci++) {
      const col = cols[ci];
      // Name the form-column when a tab has more than one, so a two-column tab is visibly two
      // columns rather than sections stacked in sequence. Rendering them truly side by side would
      // need column-aware wrapping of every section; naming the split keeps the preview honest
      // about the structure without pretending to be a pixel layout.
      if (cols.length > 1) lines.push(row(`  ╷ column ${ci + 1} of ${cols.length}${col.width ? `  (${col.width})` : ''}`));
      for (const sec of col.sections || []) {
        if (sec.name === 'section_notes') {
          lines.push(rule('▤ Notes / Timeline'));
          lines.push(row('   (activity timeline + notes — type to add a note)'));
          continue;
        }
        // `showLabel: false` means Dataverse renders NO section heading, so showing one here would
        // have the approval preview promise a heading the deployed form does not have.
        lines.push(rule(`${sec.showLabel === false ? '(no heading)' : (sec.label || 'Details')}${sec.visible === false ? '  (hidden)' : ''}`));
        for (const r of sec.rows || []) {
          // A bound field cell has control.fieldName; the notes control has none.
          const cells = (r.cells || []).filter((c) => c.control && c.control.fieldName);
          if (!cells.length) continue;
          const colW = Math.floor((INNER - 3) / Math.max(1, cells.length));
          // STACK rather than truncate a state tag. Adversarial review caught the width-priority
          // ordering in fieldLabel() being necessary but not sufficient: once the tag ALONE is wider
          // than the column, reserving "at least one name character" still leaves the tag itself to
          // be eaten by clip(). ` (hidden, read-only)` needs 20 columns; a three-column row gives 18
          // and a four-column row 13, so the approval gate went back to showing `(hidden, read-o…`.
          //
          // When that happens the row is rendered one cell per line at full width, which keeps the
          // state intact at the cost of the side-by-side depiction. The wireframe exists to report
          // what will deploy, so a less pretty row beats a row that misreports state.
          const needed = (c) => vwidth(`  ${stateTag(c)}`) + 1; // + 1 char of name
          const mustStack = cells.length > 1 && cells.some((c) => stateTag(c) && needed(c) > colW);
          if (mustStack) {
            for (const c of cells) {
              lines.push(row(clip(`  ${fieldLabel(entity, c, spec && spec.languageCode, INNER - 2)}`, INNER)));
            }
            continue;
          }
          // `colW - 2` is the room left after the two-space cell indent below, and is what
          // fieldLabel needs in order to protect the state annotation from being clipped.
          const parts = cells.map((c) => vpad(clip(`  ${fieldLabel(entity, c, spec && spec.languageCode, colW - 2)}`, colW), colW));
          lines.push(row(parts.join('')));
        }
      }
    }
  }

  const subgrids = f.subgrids || [];
  if (subgrids.length) {
    lines.push(rule('▦ Sub-grids'));
    for (const sg of subgrids) lines.push(row(`   • ${sg.label || sg.childEntity}  →  ${sg.childEntity}`));
  }
  const events = f.events || [];
  if (events.length) {
    lines.push(rule('» Form JS'));
    for (const ev of events) lines.push(row(`   • ${ev.event}${ev.attribute ? `(${ev.attribute})` : ''}  →  ${ev.function}`));
  }

  lines.push(BOTTOM);
  return lines.join('\n');
}

// Render every form in the spec (or just the ones for `entityFilter`).
function renderForms(spec, entityFilter) {
  const forms = (spec.forms || []).filter((f) => !entityFilter || f.entity.toLowerCase() === String(entityFilter).toLowerCase());
  if (!forms.length) return '(no forms in spec' + (entityFilter ? ` for '${entityFilter}'` : '') + ')';
  return forms.map((f) => renderFormWireframe(spec, f)).join('\n\n');
}

module.exports = { renderFormWireframe, renderForms, WIDGET };
