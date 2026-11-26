'use strict';

// Generates references/design-rubric-checks.md from references/design-rubric-catalog.json.
// Usage: node scripts/lib/design-grade/render-rubric.js [--check]

const fs = require('fs');
const path = require('path');
const { loadCatalog } = require('./catalog');

const OUT = path.join(__dirname, '..', '..', '..', 'references', 'design-rubric-checks.md');
const cell = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

function render() {
  const cat = loadCatalog();
  const lines = [
    '# Design Rubric — Check Catalog',
    '',
    `<!-- Generated from design-rubric-catalog.json v${cat.version} by scripts/lib/design-grade/render-rubric.js. Do not edit by hand. -->`,
    '',
    'Each row is one check. **Auto** checks are measured with fixed thresholds and become *candidates* the reviewer confirms or dismisses. **Judgment** checks are answered from screenshots using the pass/fail anchors. Severity is fixed per check unless an escalation rule is listed. See [design-rubric.md](design-rubric.md) for the method.',
    '',
    '## Severities',
    '',
    ...Object.entries(cat.severities).map(([k, v]) => `- **${k}** (load ${v.load}): ${v.definition}`),
    '',
    '## Critical gates',
    '',
    'A failing gate makes the verdict **Not ready**. Gate issues are always major.',
    '',
    '| Gate | Title | Definition | Checks |',
    '|---|---|---|---|',
    ...Object.entries(cat.gates).map(([g, v]) => `| ${g} | ${cell(v.title)} | ${cell(v.definition)} | ${cat.issues.filter((i) => i.gate === g).map((i) => i.id).join(', ')} |`),
    '',
  ];
  for (const c of cat.categories) {
    lines.push(`## ${c.name}`, '', `_${c.question}_`, '');
    for (const d of c.dimensions) {
      const dim = cat.dimensions[d];
      lines.push(`### ${d} — ${dim.name}`, '', `_${dim.question}_`, '', '| ID | Check | Detection | Severity | Gate | Effort | Trigger |', '|---|---|---|---|---|---|---|');
      for (const i of cat.issues.filter((x) => x.dimension === d)) {
        const sev = i.escalation ? `${i.severity} (${cell(i.escalation)})` : i.severity;
        lines.push(`| ${i.id} | ${cell(i.title)} | ${i.detection} | ${sev} | ${i.gate ? `${i.gate}: ${cell(i.gateWhen)}` : ''} | ${i.effort} | ${cell(i.trigger)}${i.applies ? ` Applies to: ${cell(i.applies)}` : ''}${i.pass_anchor ? ` PASS example: ${cell(i.pass_anchor)}` : ''}${i.fail_example ? ` FAIL example: ${cell(i.fail_example)}` : ''}${i.coveredBy ? ` Not counted on a page where ${i.coveredBy.join(', ')} is confirmed.` : ''} |`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

if (require.main === module) {
  const md = render();
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (cur !== md) { console.error('design-rubric-checks.md is stale. Run: node scripts/lib/design-grade/render-rubric.js'); process.exit(1); }
    console.log('design-rubric-checks.md is up to date.');
  } else {
    fs.writeFileSync(OUT, md);
    console.log(OUT);
  }
}

module.exports = { render, OUT };
