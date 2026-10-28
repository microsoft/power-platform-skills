'use strict';

const PRESETS = Object.freeze({
  'one-column': [12],
  'two-equal-columns': [6, 6],
  'three-equal-columns': [4, 4, 4],
  'one-third-left': [4, 8],
  'one-third-right': [8, 4],
});

function sectionLayout(section, label = 'section') {
  const columns = Array.isArray(section?.columns) ? section.columns : [];
  const preset = typeof section?.layout === 'string' && Object.hasOwn(PRESETS, section.layout)
    ? PRESETS[section.layout] : null;
  const explicit = columns.some((column) => column && Object.hasOwn(column, 'span'));
  if (!explicit) {
    return { source: preset?.length === columns.length ? 'preset' : 'unresolved',
      spans: preset?.length === columns.length ? [...preset] : null };
  }
  if (columns.some((column) => !column || !Number.isInteger(column.span) || column.span < 1 || column.span > 12)) {
    throw new Error(`${label}: every column needs an integer span from 1 to 12 when explicit spans are used.`);
  }
  const spans = columns.map((column) => column.span);
  if (preset && (preset.length !== spans.length || preset.some((span, index) => span !== spans[index]))) {
    throw new Error(`${label}: explicit spans conflict with the named layout. Use a descriptive non-preset layout name.`);
  }
  // A twelve-unit grid is a Bootstrap representation, not an allowed-pattern list.
  // Keep unused tracks and wrapping rather than stretching 3+3 to 50/50.
  let row = 1;
  let start = 1;
  const positions = spans.map((span) => {
    if (start + span > 13) { row += 1; start = 1; }
    const position = { row, start, span };
    start += span;
    return position;
  });
  return { source: 'explicit', spans, positions,
    warning: 'Studio editing compatibility unverified. Column geometry is specified; canvas controls and save/reopen behavior have not been established.' };
}

function compositionLayouts(operations) {
  return Object.fromEntries(operations.map((operation) => [
    operation.id,
    Array.isArray(operation.inputs?.sections)
      ? operation.inputs.sections.map((section, index) => sectionLayout(section, `${operation.id} section ${index + 1}`))
      : [],
  ]));
}

module.exports = { sectionLayout, compositionLayouts };
