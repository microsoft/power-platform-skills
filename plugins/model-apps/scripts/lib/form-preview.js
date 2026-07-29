'use strict';
// Form wireframe preview: render an App Spec form (the exact layout the builder will create,
// via formDef) as an ASCII wireframe — tabs, sections, fields with type-appropriate widget
// hints, the Notes/timeline block, and sub-grids — so the user can *see* a form during the
// interactive authoring turn before approving it. Pure (no I/O); the CLI is preview-form.js.
const { compileFormIntent } = require('./artifact-intent.js');
const { entityByLogical } = require('./_graph.js');

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
function labelFor(entity, fn) {
  if (!entity) return fn;
  if (entity.primaryAttribute && entity.primaryAttribute.schemaName.toLowerCase() === fn) return entity.primaryAttribute.displayName || 'Name';
  const c = (entity.columns || []).find((x) => x.schemaName.toLowerCase() === fn);
  return (c && (c.displayName || c.schemaName)) || fn;
}

// "Label * [widget]" for one field cell.
function fieldLabel(entity, cell) {
  const fn = cell.control.fieldName;
  const req = cell.control.isRequired ? ' *' : '';
  const widget = WIDGET[fieldType(entity, fn)] || WIDGET.Text;
  return `${cell.control.label || labelFor(entity, fn)}${req}  ${widget}`;
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
    if (tabLabels.length > 1) lines.push(row(`▾ ${tab.label || 'General'}`));
    // New topology inserts a FormColumn layer between tab and section.
    for (const col of tab.columns || []) {
      for (const sec of col.sections || []) {
        if (sec.name === 'section_notes') {
          lines.push(rule('▤ Notes / Timeline'));
          lines.push(row('   (activity timeline + notes — type to add a note)'));
          continue;
        }
        lines.push(rule(sec.label || 'Details'));
        for (const r of sec.rows || []) {
          // A bound field cell has control.fieldName; the notes control has none.
          const cells = (r.cells || []).filter((c) => c.control && c.control.fieldName);
          if (!cells.length) continue;
          const colW = Math.floor((INNER - 3) / Math.max(1, cells.length));
          const parts = cells.map((c) => vpad(clip(`  ${fieldLabel(entity, c)}`, colW), colW));
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
