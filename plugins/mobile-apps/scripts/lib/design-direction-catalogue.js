'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const CATALOGUE_PATH = path.join(PLUGIN_ROOT, 'skills', 'design-system', 'references', 'vibe', 'design-directions.md');
const DIRECTIONS_DIR = path.dirname(CATALOGUE_PATH);

function clean(value) {
  return String(value || '').trim().replace(/\\\|/g, '|').replace(/^`|`$/g, '');
}

function cells(line) {
  return line.trim().split(/(?<!\\)\|/).slice(1, -1).map(clean);
}

function parse(markdown) {
  const heading = '## Registered Catalogue';
  const start = markdown.indexOf(`${heading}\n`);
  if (start < 0) throw new Error(`${heading} is missing`);
  const body = markdown.slice(start + heading.length + 1).split(/^##\s/m)[0];
  const rows = body.split('\n').filter((line) => /^\s*\|/.test(line));
  if (rows.length < 3) throw new Error('registered catalogue table is missing');
  const headers = cells(rows[0]);
  return rows.slice(2).map(cells).filter((row) => row.some(Boolean)).map((row) => {
    const record = Object.fromEntries(headers.map((header, index) => [header, row[index] || '']));
    return {
      slug: record.Slug,
      source: record.Source,
      priority: Number(record.Priority),
      clauses: record['Route clauses'] === '-' ? [] : record['Route clauses'].split(';').map(clean).filter(Boolean),
      summary: record.Summary,
    };
  });
}

function validate(entries, directory = DIRECTIONS_DIR) {
  const errors = [];
  const slugs = new Set();
  const sources = new Set();
  for (const entry of entries) {
    if (!/^[a-z][a-z0-9-]*$/.test(entry.slug)) errors.push(`${entry.slug || '<empty>'}: invalid slug`);
    if (slugs.has(entry.slug)) errors.push(`${entry.slug}: duplicate slug`);
    slugs.add(entry.slug);
    if (entry.source !== `direction-${entry.slug}.md`) errors.push(`${entry.slug}: source must be direction-${entry.slug}.md`);
    if (sources.has(entry.source)) errors.push(`${entry.source}: duplicate source`);
    sources.add(entry.source);
    if (!Number.isFinite(entry.priority)) errors.push(`${entry.slug}: priority must be numeric`);
    if (!entry.summary) errors.push(`${entry.slug}: summary is required`);
    if (!fs.existsSync(path.join(directory, entry.source))) errors.push(`${entry.slug}: source file is missing`);
    for (const clause of entry.clauses) {
      if (clause.split('&').some((group) => group.split('|').every((term) => !term.trim()))) errors.push(`${entry.slug}: invalid route clause ${clause}`);
    }
  }
  const files = fs.readdirSync(directory).filter((name) => /^direction-.+\.md$/.test(name)).sort();
  for (const file of files) if (!sources.has(file)) errors.push(`${file}: direction file is not registered`);
  for (const source of sources) if (!files.includes(source)) errors.push(`${source}: registered source does not exist`);
  if (entries.filter((entry) => entry.clauses.length === 0).length !== 1) errors.push('catalogue must contain exactly one default direction');
  return errors;
}

function load() {
  const entries = parse(fs.readFileSync(CATALOGUE_PATH, 'utf8'));
  const errors = validate(entries);
  if (errors.length > 0) throw new Error(`invalid design direction catalogue:\n- ${errors.join('\n- ')}`);
  return entries;
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[\u2010-\u2015]/g, '-').replace(/\s+/g, ' ').trim();
}

function clauseMatches(text, clause) {
  return clause.split('&').every((group) => group.split('|').map(normalize).filter(Boolean).some((term) => text.includes(term)));
}

function route(input, options = {}) {
  const entries = options.entries || load();
  if (options.explicit) {
    const selected = entries.find((entry) => entry.slug === options.explicit);
    if (!selected) throw new Error(`unknown direction ${options.explicit}`);
    return { ...selected, reason: `explicit direction ${options.explicit}` };
  }
  const text = normalize(input);
  const matches = entries.filter((entry) => entry.clauses.some((clause) => clauseMatches(text, clause)))
    .sort((left, right) => right.priority - left.priority || left.slug.localeCompare(right.slug));
  const selected = matches[0] || entries.find((entry) => entry.clauses.length === 0);
  return { ...selected, reason: matches.length > 0 ? `matched ${selected.clauses.find((clause) => clauseMatches(text, clause))}` : 'catalogue default' };
}

module.exports = { CATALOGUE_PATH, DIRECTIONS_DIR, PLUGIN_ROOT, clauseMatches, load, normalize, parse, route, validate };
