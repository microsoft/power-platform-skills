'use strict';

// Renders a grade into an HTML report placed next to its screenshots (referenced relatively).

const fs = require('fs');
const path = require('path');
const { loadCatalog, measuredAllowed, judgmentIds } = require('./catalog');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SEV_LABEL = { major: 'Major', minor: 'Minor' };
const VERDICT_CLASS = { 'Not ready': 'v-bad', 'Needs revision': 'v-warn', Incomplete: 'v-warn', Ready: 'v-good' };

function fmt(s) { return s == null ? '—' : s.toFixed(2); }
function scoreClass(s) { if (s == null) return ''; return s >= 4.5 ? 'good' : s >= 3.5 ? 'ok' : s >= 2.5 ? 'warn' : 'bad'; }

function issueCard(i) {
  const instances = i.instances.length
    ? `<details${i.gate ? ' open' : ''}><summary>Where (${i.instanceCount} instance${i.instanceCount === 1 ? '' : 's'}${i.instanceCount > i.instances.length ? `, showing ${i.instances.length}` : ''})</summary><table class="inst"><tbody>${i.instances.map((x) => `<tr><td class="route">${esc(x.route)}</td><td><code>${esc(x.selector)}</code></td><td>${esc(x.detail)}</td></tr>`).join('')}</tbody></table></details>`
    : '';
  const hints = i.sourceHints && i.sourceHints.length
    ? `<div class="hints"><strong>Likely source:</strong><ul>${i.sourceHints.map((h) => `<li><code>${esc(h.file)}:${h.line}</code> <span class="muted">${esc(h.reason)}</span><br><code class="snip">${esc(h.match)}</code></li>`).join('')}</ul></div>`
    : '';
  const shots = (i.screenshots || []).map((s) => `<a href="${esc(s.path)}" target="_blank" rel="noopener">screenshot (${esc(s.route)})</a>`).join(' · ');
  return `<article class="issue sev-${i.severity}${i.gate ? ' gate' : ''}" id="${esc(i.key)}">
  <header><span class="rank">#${i.rank}</span><span class="pill ${i.severity}">${SEV_LABEL[i.severity]}</span>${i.gate ? `<span class="pill gate" title="${esc(loadCatalog().gates[i.gate].definition)}">Gate ${esc(i.gate)}</span>` : ''}<span class="id">${esc(i.key)}</span><h3>${esc(i.title)}</h3>
  <span class="meta">${esc(loadCatalog().dimensions[i.dimension].name)} · effort ${esc(i.effort)}${i.quickWin ? ' · <b>quick win</b>' : ''}${i.uncatalogued ? ' · <i>uncatalogued</i>' : ''} · ${i.detection === 'auto' ? 'measured' : 'visual review'}</span></header>
  <p class="where">Pages: ${i.routes.map((r) => `<code>${esc(r)}</code>`).join(' ')}${i.viewports.length ? ` · Viewports: ${esc(i.viewports.join(', '))}` : ''}${i.aboveFold ? ' · above the fold' : ''}</p>
  <ul class="summ">${i.summaries.map((s) => `<li>${i.routes.length > 1 ? `<code>${esc(s.route)}</code> ` : ''}${esc(s.text)}</li>`).join('')}</ul>
  ${shots ? `<p>${shots}</p>` : ''}
  ${instances}
  <div class="fix"><strong>Path to fix</strong><ol>${(i.fix || []).map((f) => `<li>${esc(f)}</li>`).join('')}</ol></div>
  ${hints}
  ${i.refs && i.refs.length ? `<p class="muted">Refs: ${esc(i.refs.join(', '))}</p>` : ''}
</article>`;
}

function render(grade) {
  const cat = loadCatalog();
  const triggered = new Set(grade.issues.map((i) => i.id));
  const profile = grade.profile || 'full';
  const inProfile = (c) => (c.detection === 'auto' ? measuredAllowed(profile)(c.id) : grade.judgmentMode === 'full' && judgmentIds(profile).includes(c.id));
  const passed = cat.issues.filter((c) => !triggered.has(c.id) && inProfile(c));
  const top = grade.issues.filter((i) => i.severity === 'major').slice(0, 5);
  const pagesHtml = grade.pages.map((p) => {
    const s = p.screenshots || {};
    const shot = (vp) => (s[vp] ? `<figure><a href="${esc(s[vp].full)}" target="_blank" rel="noopener"><img src="${esc(s[vp].fold)}" alt="${esc(p.route)} ${vp} first viewport" loading="lazy"></a><figcaption>${vp}</figcaption></figure>` : '');
    const prof = grade.profiles[p.route];
    return `<div class="page"><h3><code>${esc(p.route)}</code> <span class="muted">${esc(p.url)}</span></h3>
      <div class="shots">${shot('desktop')}${shot('tablet')}${shot('mobile')}</div>
      ${prof ? `<p class="muted">Heading font <b>${esc(prof.headingFont)}</b> · body font <b>${esc(prof.bodyFont)}</b> · body ${esc(prof.bodySize)}px · h1 ${esc(prof.h1Size)}px · scale ratio ${esc(prof.typeRatio)}</p>` : ''}</div>`;
  }).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Design grade — ${esc(grade.baseUrl)}</title>
<style>
:root{--bg:#f6f5f2;--surface:#fff;--text:#1c1b19;--muted:#6b675f;--border:#e2ded6;--crit:#b42318;--major:#b54708;--minor:#475467;--good:#067647;--ok:#4e7d0f;--warn:#b54708;--bad:#b42318;font-family:"IBM Plex Sans",system-ui,sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);line-height:1.55}
main{max-width:1180px;margin:0 auto;padding:40px 24px 80px}
h1{font-size:2.2rem;margin:0 0 4px;letter-spacing:-.02em}h2{margin:48px 0 16px;font-size:1.35rem}h3{margin:0;font-size:1.05rem}
.muted{color:var(--muted);font-size:.9rem}code{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:.82em;background:#efece6;padding:1px 5px;border-radius:4px}
.hero{display:grid;grid-template-columns:1fr;gap:28px;align-items:center;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:28px;margin-top:20px}
.cat .score small{font-size:1rem;color:var(--muted);font-weight:500}.cat .q{margin:2px 0 6px}.gates{margin:10px 0 0;padding-left:18px}
.verdict{display:inline-block;font-weight:700;padding:4px 12px;border-radius:999px;margin-bottom:6px}.v-bad{background:#fee4e2;color:var(--bad)}.v-warn{background:#fef0c7;color:var(--warn)}.v-good{background:#dcfae6;color:var(--good)}
.counts span{margin-right:14px;font-weight:600}.c-critical{color:var(--crit)}.c-major{color:var(--major)}.c-minor{color:var(--minor)}
.cats{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin-top:16px}
.cat{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px}.cat .score{font-size:2rem;font-weight:800}
.score.good{color:var(--good)}.score.ok{color:var(--ok)}.score.warn{color:var(--warn)}.score.bad{color:var(--bad)}
.dims{list-style:none;padding:0;margin:10px 0 0;font-size:.9rem}.dims li{display:flex;justify-content:space-between;border-top:1px dashed var(--border);padding:4px 0}
.issue{background:var(--surface);border:1px solid var(--border);border-left:5px solid var(--minor);border-radius:10px;padding:16px 20px;margin:12px 0}
.issue.gate{border-left-color:var(--crit)}.issue.sev-major{border-left-color:var(--major)}
.issue header{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:baseline}.issue .meta{flex-basis:100%;color:var(--muted);font-size:.85rem}
.rank{font-weight:700;color:var(--muted)}.id{font-family:ui-monospace,monospace;font-size:.85rem;color:var(--muted)}
.pill{font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:2px 8px;border-radius:999px;color:#fff}.pill.gate{background:var(--crit)}.pill.major{background:var(--major)}.pill.minor{background:var(--minor)}
.where{margin:8px 0 4px;font-size:.9rem}.summ{margin:4px 0 8px;padding-left:18px}
.fix{background:#f3f8f4;border-radius:8px;padding:10px 14px;margin-top:10px}.fix ol{margin:6px 0 0;padding-left:20px}
.hints ul{margin:6px 0 0;padding-left:18px;font-size:.88rem}.snip{display:inline-block;margin-top:2px;white-space:pre-wrap}
table.inst{width:100%;border-collapse:collapse;font-size:.85rem;margin-top:6px}table.inst td{border-top:1px solid var(--border);padding:4px 6px;vertical-align:top}td.route{white-space:nowrap;color:var(--muted)}
details summary{cursor:pointer;font-size:.9rem;font-weight:600}
.top li{margin:6px 0}
.page{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;margin:12px 0}
.shots{display:flex;gap:12px;align-items:flex-start;margin-top:10px;overflow-x:auto}.shots figure{margin:0}.shots img{display:block;max-height:260px;border:1px solid var(--border);border-radius:6px}figcaption{font-size:.8rem;color:var(--muted)}
.passed{columns:2;font-size:.88rem}@media (max-width:720px){.hero{grid-template-columns:1fr}.passed{columns:1}}
</style></head><body><main>
<h1>${profile === 'first-impression' ? 'First-impression check' : 'Design review'}</h1>
<p class="muted">${esc(grade.baseUrl)} · ${grade.coverage.pagesGraded.length} page(s) · collected ${esc(grade.collectedAt)} · catalog v${esc(grade.catalogVersion)}${grade.judgmentMode === 'auto-only' ? ' · <b>automated checks only — visual review not performed</b>' : ''}</p>
<section class="hero">
  <div><span class="verdict ${VERDICT_CLASS[grade.verdict.verdict]}">${esc(grade.verdict.verdict)}</span><p style="margin:4px 0 8px">${esc(grade.verdict.meaning)}</p>
  <div class="counts"><span class="c-critical">${grade.counts.gates} gate${grade.counts.gates === 1 ? '' : 's'} failing</span><span class="c-major">${grade.counts.major} major</span><span class="c-minor">${grade.counts.minor} minor</span></div>
  ${grade.failingGates.length ? `<ul class="gates">${grade.failingGates.map((g) => `<li><b>${esc(g.id)} ${esc(g.title)}</b> — ${g.issues.map((k) => `<a href="#${esc(k)}">${esc(k)}</a>`).join(', ')}</li>`).join('')}</ul>` : ''}</div>
</section>
<div class="cats">${grade.categories.map((c) => `<div class="cat"><div class="muted">${esc(c.name)}</div><div class="score ${scoreClass(c.score)}">${fmt(c.score)}<small> / 5</small></div><div class="muted q">${esc(c.question)}</div>
<ul class="dims">${c.dimensions.map((d) => `<li><span>${esc(d.name)}</span><span>${d.counts.gates ? `<b class="c-critical">${d.counts.gates}G</b> ` : ''}${d.counts.major ? `<b class="c-major">${d.counts.major}M</b> ` : ''}${d.counts.minor ? `<span class="c-minor">${d.counts.minor}m</span>` : ''}${!d.counts.major && !d.counts.minor ? '<span class="muted">✓</span>' : ''}</span></li>`).join('')}</ul></div>`).join('')}</div>
<p class="muted">Score per category = 5 − 4 × tanh(0.2 × (majors + 0.25 × minors)). G = gate failing, M = major, m = minor.</p>
${grade.coverage.pagesFailed.length ? `<p class="c-critical">Could not grade: ${grade.coverage.pagesFailed.map((p) => `<code>${esc(p.route)}</code> (${esc(p.error)})`).join(', ')}</p>` : ''}
${(grade.coverage.notes || []).length ? `<p class="muted">Not measured: ${grade.coverage.notes.map((n) => `<code>${esc(n.route)}</code> ${esc(n.note)}`).join('; ')}</p>` : ''}
${(grade.coverage.gaps || []).length ? `<h2>Coverage gaps</h2><p class="muted">Some evidence could not be collected, so issues in these areas may be missing.</p><ul>${grade.coverage.gaps.map((g) => `<li><code>${esc(g.route)}</code> · ${esc(g.viewport)} · ${esc(g.step)}: ${esc(g.error)}</li>`).join('')}</ul>` : ''}
${top.length ? `<h2>Fix these first</h2><ol class="top">${top.map((i) => `<li><a href="#${esc(i.key)}"><b>${esc(i.title)}</b></a> — <span class="c-${i.severity}">${i.severity}</span>, effort ${i.effort}${i.quickWin ? ' (quick win)' : ''}: ${esc(i.fix[0] || '')}</li>`).join('')}</ol>` : ''}
<h2>All issues (${grade.issues.length})</h2>
${grade.issues.map(issueCard).join('\n') || '<p>No issues found.</p>'}
${(grade.dismissed || []).length ? `<h2>Dismissed by reviewer (${grade.dismissed.length})</h2><p class="muted">Measured candidates the reviewer judged to be false positives. They do not affect scores.</p><ul>${grade.dismissed.map((d) => `<li><span class="id">${esc(d.key)}</span> ${esc(d.title)} <span class="muted">(${esc(d.severity)}${d.gate ? `, gate ${esc(d.gate)}` : ''}; ${esc(d.routes.join(', '))})</span> — ${esc(d.reason)}</li>`).join('')}</ul>` : ''}
${(grade.merged || []).length ? `<h2>Counted once (${grade.merged.length})</h2><p class="muted">Reviewer findings that describe the same problem as a measured issue on the same page; they are shown here and not scored twice.</p><ul>${grade.merged.map((m) => `<li><span class="id">${esc(m.key)}</span> on <code>${esc(m.route)}</code> - same problem as <a href="#${esc(m.coveredBy)}">${esc(m.coveredBy)}</a>: ${esc(m.evidence)}</li>`).join('')}</ul>` : ''}
<h2>Pages</h2>${pagesHtml}
<h2>Checks passed (${passed.length})</h2>
<ul class="passed">${passed.map((c) => `<li><span class="id">${esc(c.id)}</span> ${esc(c.title)}</li>`).join('')}</ul>
</main></body></html>`;
}


module.exports = { render };
