#!/usr/bin/env node
'use strict';
// verify-harness.js — acceptance check for the mobile-apps plugin fix set.
// Usage: node verify-harness.js <plugin-dir> [--json]
//
// Every check is written so it FAILS on the unfixed plugin. A check that cannot
// fail is not a check (F10's own principle, applied to the verifier).

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(process.argv[2] || '.');
const JSON_OUT = process.argv.includes('--json');

const read = (rel) => {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const CONTRACTS = 'scripts/validate-screen-contracts.js';
const DESIGN = 'scripts/generate-prototype-design-system.js';
const MOCKS = 'skills/create-mobile-prototype/scripts/gen-mock-services.js';
const SKILL = 'skills/create-mobile-prototype/SKILL.md';
const RUNJS = 'skills/create-mobile-prototype/harness/run.js';
const CHECKS = 'skills/create-mobile-prototype/harness/checks';

const CHECKLIST = [
  ['F1', 'GFM pipe escapes in table parser', () => {
    const s = read(CONTRACTS);
    if (!s) return [false, `${CONTRACTS} not found`];
    const ok = /split\(\s*\/\(\?<!\\\\\)\\\|\//.test(s) || /\(\?<!\\\)\\\|/.test(s);
    return [ok, ok ? 'parser skips escaped pipes' : "parseLine still splits on every '|'"];
  }],
  ['F2', 'Heading regex accepts `#### Name`', () => {
    const s = read(CONTRACTS);
    if (!s) return [false, `${CONTRACTS} not found`];
    const strict = /\^#### Screen \(\\d\+\) - /.test(s);
    const loose = /\(\?:Screen \(\\d\+\)/.test(s);
    return [loose && !strict, loose ? 'optional `Screen N` group present' : 'still requires `#### Screen N - Name (`route`)`'];
  }],
  ['F3', 'Case-insensitive service-name compare', () => {
    const s = read(CONTRACTS);
    if (!s) return [false, `${CONTRACTS} not found`];
    const ok = /serviceKey|toLowerCase\(\)/.test(s);
    return [ok, ok ? 'normaliser present' : 'service names compared case-sensitively'];
  }],
  ['F4', 'One shared pool list, >=13 pools', () => {
    if (!exists('scripts/lib/seed-pools.js')) return [false, 'scripts/lib/seed-pools.js missing'];
    const pools = read('scripts/lib/seed-pools.js');
    const n = (pools.match(/^\s+\w+:\s*\[/gm) || []).length;
    const wired = /require\(['"]\.\/lib\/seed-pools['"]\)/.test(read('scripts/validate-seed-vocabulary.js') || '');
    return [n >= 13 && wired, `${n} pools, validator wired: ${wired}`];
  }],
  ['F5', 'Named direction, not a domain hash', () => {
    const s = read(DESIGN);
    if (!s) return [false, `${DESIGN} not found`];
    const hashGone = !/hashNumber\(domain\)/.test(s);   // hue AND font stack
    const mod = exists('scripts/lib/directions.js');
    const resolvable = mod && /RESOLVABLE/.test(read('scripts/lib/directions.js'));
    return [hashGone && mod && resolvable,
      `hash removed: ${hashGone}, directions.js: ${mod}, RESOLVABLE list: ${!!resolvable}`];
  }],
  ['F6', 'Contrast asserted on all three grounds', () => {
    const s = read(DESIGN);
    if (!s) return [false, `${DESIGN} not found`];
    const fn = /assertPaletteContrast/.test(s);
    const three = /surface0'?,\s*'surface1'?,\s*'surface2'/.test(s);
    return [fn && three, `assert fn: ${fn}, checks 3 grounds: ${three}`];
  }],
  ['F7', 'StatusToken emitted as hex-literal type', () => {
    const s = read(DESIGN);
    if (!s) return [false, `${DESIGN} not found`];
    const ok = s.includes('fg: `#${string}`');
    return [ok, ok ? 'template literal type emitted' : 'still emits `fg: string`'];
  }],
  ['F8', 'scroll-padding infers pinned from layout', () => {
    const s = read(`${CHECKS}/scroll-padding.js`);
    if (!s) return [false, 'check missing'];
    const ok = /position\)|'fixed'|'sticky'/.test(s);
    return [ok, ok ? 'position-based inference present' : 'still early-returns pass on testId alone'];
  }],
  ['F9', 'seed-hero checks the largest text only', () => {
    const s = read(`${CHECKS}/seed-hero.js`);
    if (!s) return [false, 'check missing'];
    const scansAll = /candidates\.find\(/.test(s);
    const largestOnly = /candidates\[0\]/.test(s);
    return [largestOnly && !scansAll, largestOnly && !scansAll ? 'checks candidates[0]' : 'still passes if ANY text is seed-backed'];
  }],
  ['F10', 'Every check has a failing fixture', () => {
    if (!exists(`${CHECKS}/fixtures.test.js`)) return [false, 'fixtures.test.js missing'];
    const dir = path.join(ROOT, CHECKS);
    const checks = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.includes('.test.'));
    const fx = path.join(dir, '__fixtures__');
    const have = fs.existsSync(fx) ? fs.readdirSync(fx).filter((f) => f.endsWith('.bad.json')).length : 0;
    return [have >= checks.length, `${have} fixtures for ${checks.length} checks`];
  }],
  ['F11', 'overflow / line-budget check exists', () => {
    const ok = exists(`${CHECKS}/overflow.js`);
    return [ok, ok ? 'harness/checks/overflow.js present' : 'no overflow check — wrapping and clipping are invisible'];
  }],
  ['F12', 'Icon shim loads the real font', () => {
    const s = read('skills/create-mobile-prototype/harness/shims/vector-icons.jsx');
    if (!s) return [false, 'shim missing'];
    const dot = s.includes('\\u25cf');
    const real = /glyphmaps|Ionicons\.ttf/.test(s);
    return [real && !dot, real ? 'glyph map wired' : 'every icon still renders as a dot'];
  }],
  ['F13', 'Entity-first pool routing', () => {
    const s = read(MOCKS);
    if (!s) return [false, `${MOCKS} not found`];
    const person = /primaryNamePool[\s\S]{0,600}?employee\|person\|contact/.test(s);
    const fallback = !/return pickPool\(vocabulary, 'title', index, seed\);\s*\n\}/.test(s);
    return [person && fallback, `person branch: ${person}, entity-shaped fallback: ${fallback}`];
  }],
  ['F14', 'Stored totals must equal components', () => {
    const ok = exists('scripts/validate-seed-consistency.js');
    return [ok, ok ? 'validate-seed-consistency.js present' : 'nothing checks qty x price == stored total'];
  }],
  ['F15', 'esbuild is a direct devDependency', () => {
    const pkg = read('template/package.json');
    if (!pkg) return [false, 'template/package.json not found'];
    const j = JSON.parse(pkg);
    const dev = !!(j.devDependencies && j.devDependencies.esbuild);
    return [dev, dev ? `devDependencies.esbuild = ${j.devDependencies.esbuild}` : 'esbuild only in overrides — all 14 checks die under pnpm'];
  }],
  ['F16', 'Brief capability echo, warn-only', () => {
    const s = read(SKILL);
    if (!s) return [false, `${SKILL} not found`];
    const echo = /capability check|Capability check/i.test(s);
    const warnOnly = !/Continue\? \[y\/N\]/.test(s);
    return [echo && warnOnly, `echo step: ${echo}, warn-only (never blocks): ${warnOnly}`];
  }],
  ['F17', 'Log findings grouped by kind', () => {
    const s = read(RUNJS);
    if (!s) return [false, `${RUNJS} not found`];
    const grouped = /groupBy|byKind|findingKind|kinds\b/.test(s);
    const dump = /findings\.json/.test(s);
    return [grouped && dump, `grouping: ${grouped}, full list written to file: ${dump}`];
  }],
  ['S1', 'Render once, run all checks', () => {
    const s = read(RUNJS);
    if (!s) return [false, `${RUNJS} not found`];
    const plural = /--checks/.test(s);
    const cached = /rendered\.push|const rendered\s*=/.test(s);
    return [plural && cached, `--checks flag: ${plural}, snapshot cache: ${cached}`];
  }],
  ['S2', 'type-check runs at most twice', () => {
    const s = read(SKILL);
    if (!s) return [false, `${SKILL} not found`];
    const n = (s.match(/run type-check/g) || []).length;
    return [n <= 2, `${n} invocations (target <= 2)`];
  }],
  ['S3', 'pnpm is the install path', () => {
    const s = read(SKILL);
    if (!s) return [false, `${SKILL} not found`];
    const ok = /pnpm install|pnpm --dir/.test(s);
    return [ok, ok ? 'pnpm referenced' : 'still npm — 30.0s vs 7.0s warm'];
  }],
  ['S4', 'Plan/manifest parse is memoised', () => {
    if (!exists('scripts/lib/plan-contract.js')) return [false, 'scripts/lib/plan-contract.js missing'];
    const s = read('scripts/lib/plan-contract.js');
    const memo = /mtime|cache|memo/i.test(s);
    return [memo, memo ? 'memoised by mtime' : 'module exists but re-parses every call'];
  }],
];

const results = CHECKLIST.map(([id, name, fn]) => {
  let pass = false; let detail = '';
  try { [pass, detail] = fn(); } catch (e) { pass = false; detail = `check threw: ${e.message}`; }
  return { id, name, pass, detail };
});

const passed = results.filter((r) => r.pass).length;

if (JSON_OUT) {
  console.log(JSON.stringify({ root: ROOT, passed, total: results.length, results }, null, 2));
} else {
  console.log(`\nverify-harness — ${ROOT}\n`);
  for (const r of results) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(4)} ${r.name.padEnd(42)} ${r.detail}`);
  }
  console.log(`\n  ${passed}/${results.length} present\n`);
}
process.exit(passed === results.length ? 0 : 1);
