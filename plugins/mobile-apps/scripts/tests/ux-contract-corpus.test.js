'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SKIPPED_DIRECTORIES = new Set(['.ux-snapshot-2026-08-19', 'node_modules', '.git', 'dist', 'build']);
const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.md', '.ts', '.tsx', '.yaml', '.yml']);

function activeFiles(directory = ROOT) {
  const files = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const target = path.join(current, entry.name);
      if (target.startsWith(path.join(ROOT, 'scripts', 'tests'))) continue;
      if (entry.isDirectory()) walk(target);
      else if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(target);
    }
  }
  walk(directory);
  return files;
}

function nonzeroLetterSpacing(file, content) {
  const issues = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const map = /letterSpacing\s*:\s*\{([^}]*)\}/.exec(line);
    if (map) {
      for (const pair of map[1].split(',')) {
        const value = /^\s*[^:]+:\s*(-?\d+(?:\.\d+)?)/.exec(pair);
        if (value && Math.abs(Number(value[1])) > 1e-9) issues.push(`${file}:${index + 1}: ${pair.trim()}`);
      }
      continue;
    }
    for (const expression of [
      /letterSpacing\s*[:=]\s*(?:\{\s*)?(-?\d+(?:\.\d+)?)/g,
      /letter-spacing\s*:\s*(-?\d+(?:\.\d+)?)/g,
      /\btracking\s*:\s*(-?\d+(?:\.\d+)?)/g,
    ]) {
      let match;
      while ((match = expression.exec(line))) {
        if (Math.abs(Number(match[1])) > 1e-9) issues.push(`${file}:${index + 1}: ${match[0]}`);
      }
    }
  }
  return issues;
}

test('active UX corpus contains no retired architecture phrases', () => {
  const retired = [
    'Home is a dashboard by default',
    'Home should usually be a dashboard',
    'industry-inferred',
    'Gate 4a',
    'Gate 4b',
    'List + Form + Detail',
    'screen-templates.md',
    'home-compositions.md',
    'mobile-design-philosophy.md',
    'product-archetypes.md',
    'typography-and-tone.md',
    'universal-patterns.md',
    'visual-personalities.md',
    'design-bundle-schema.md',
    'color-palette-architecture.md',
    'references/vibe/',
    'asset-command',
    'media-command',
    'object-command',
    'relationship-command',
    'data-command',
    'scan-command',
    'queue-first',
    'timeline-first',
    'narrative-home',
    'personalized-feed',
    'operational-dashboard',
    'status-stripe-card',
    'avatar-row',
    'stat-card',
    'media-tile',
    'sentence-row',
    'timeline-row',
    'checklist-row',
    'status-header-band',
    'stat-grid',
    'image-hero',
    'identity-block',
    'summary-card',
    'timeline-header',
    'minimal-header',
    'assignment-dashboard',
    'walkaround-stepper',
    'wizard-progress-stepper',
    'floating-action-menu',
    'scan-geofence-gate',
    'severity-filtered-queue',
    'dispatch-signoff-queue',
    'audit-timeline',
  ];
  const issues = [];
  for (const file of activeFiles()) {
    const content = fs.readFileSync(file, 'utf8');
    for (const phrase of retired) if (content.includes(phrase)) issues.push(`${path.relative(ROOT, file)}: ${phrase}`);
  }
  assert.deepStrictEqual(issues, []);
});

test('all active generated/mobile letter-spacing examples are zero', () => {
  const issues = [];
  for (const file of activeFiles()) issues.push(...nonzeroLetterSpacing(path.relative(ROOT, file), fs.readFileSync(file, 'utf8')));
  assert.deepStrictEqual(issues, []);
});

test('Product Experience reports and canonical references have valid local links', () => {
  const files = [
    'shared/references/product-experience-contract.md',
    'shared/references/mobile-ux-boundaries.md',
    'shared/references/design-planning.md',
    'shared/references/reference-fidelity.md',
  ];
  const issues = [];
  for (const relativeFile of files) {
    const file = path.join(ROOT, relativeFile);
    const content = fs.readFileSync(file, 'utf8');
    for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = decodeURIComponent(match[1].split('#')[0]);
      if (!target || /^(?:https?:|mailto:|#|\$\{|\{\{)/.test(target)) continue;
      const resolved = path.resolve(path.dirname(file), target);
      if (!fs.existsSync(resolved)) issues.push(`${relativeFile} -> ${target}`);
    }
  }
  assert.deepStrictEqual(issues, []);
});

test('plugin metadata, provenance, MCP, and visual-QA skill are aligned', () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, '.plugin', 'plugin.json'), 'utf8'));
  const legacy = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const marker = JSON.parse(fs.readFileSync(path.join(ROOT, 'template', '.powerapps-native', 'version.json'), 'utf8'));
  const mcp = JSON.parse(fs.readFileSync(path.join(ROOT, '.mcp.json'), 'utf8'));
  assert.strictEqual(plugin.version, '0.3.0');
  assert.strictEqual(legacy.version, '0.3.0');
  assert.strictEqual(marker.schemaVersion, 2);
  assert.strictEqual(marker.templateOwner, 'power-platform-skills/mobile-app');
  assert.strictEqual(marker.pluginVersion, '0.3.0');
  assert.strictEqual(marker.minimumPluginVersion, '0.3.0');
  assert.strictEqual(marker.experienceContractVersion, 1);
  assert.ok(mcp.mcpServers.expo);
  assert.ok(mcp.mcpServers['microsoft-learn']);
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'visual-qa', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: visual-qa\ndescription: .+/);
  assert.match(skill, /BLOCKED: no native visual evidence/);
});
