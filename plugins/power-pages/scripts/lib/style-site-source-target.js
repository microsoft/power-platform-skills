'use strict';

function sourceContext(context, match) {
  if (context === undefined) return null;
  if (!context || typeof context !== 'object' || Array.isArray(context) ||
      Object.keys(context).some((key) => !['before', 'after'].includes(key))) {
    throw new Error('Source context must be an object containing only before/after text.');
  }
  const before = context.before === undefined ? '' : context.before;
  const after = context.after === undefined ? '' : context.after;
  if (typeof before !== 'string' || typeof after !== 'string' || (!before.length && !after.length) ||
      before.length + match.length + after.length > 16000) {
    throw new Error('Source context needs adjacent before/after text and a window of at most 16000 characters including the tag.');
  }
  return { before, after };
}

function resolveSourceTarget(source, tags, match, context, replacement, label) {
  const guard = sourceContext(context, match);
  if (!guard) {
    const original = tags.filter((tag) => source.slice(tag.start, tag.end) === match);
    const matches = original.length ? original : tags.filter((tag) => source.slice(tag.start, tag.end) === replacement);
    if (matches.length !== 1) throw new Error(`${label} must match exactly one opening tag; add exact source context for repeated tags.`);
    return matches[0];
  }
  // E.g. {after: '\n<h3>Support</h3>'} distinguishes otherwise identical column
  // tags. These are adjacent ORIGINAL source bytes, not selectors or ordinals.
  // A tag-shaped string inside an attribute/comment/script is not an edit target.
  for (const candidate of [...new Set([match, replacement])]) {
    const window = guard.before + candidate + guard.after;
    const start = source.indexOf(window);
    if (start < 0) continue;
    if (source.indexOf(window, start + 1) >= 0) throw new Error(`${label} context is ambiguous; choose a unique source window.`);
    const offset = start + guard.before.length;
    const tag = tags.find((entry) => entry.start === offset && source.slice(entry.start, entry.end) === candidate);
    if (!tag) throw new Error(`${label} context does not identify a real opening tag.`);
    return tag;
  }
  throw new Error(`${label} context no longer matches; refresh the local source and regenerate the proposal.`);
}

module.exports = { sourceContext, resolveSourceTarget };
