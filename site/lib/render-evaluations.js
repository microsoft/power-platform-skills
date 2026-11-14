'use strict';

const { escapeHtml: esc, layout } = require('./render.js');

function rate(stats) {
  if (!stats.expected) return '<span class="muted">Not tested</span>';
  return `<strong>${stats.passed}/${stats.expected}</strong> passed <span class="muted">(${Math.round(stats.passed / stats.expected * 100)}%)</span>
    <small>${stats.tasks} distinct task${stats.tasks === 1 ? '' : 's'}; ${stats.allRunsPassed}/${stats.tasks} passed every repeat.
    ${stats.errors} errors${stats.missing ? `; ${stats.missing} missing records` : ''}.</small>`;
}

function cases(evidence) {
  return evidence.cases.map((item) => `<details class="case">
    <summary>${esc(item.name)} <span class="muted">${item.kind === 'dormancy' ? 'Routing / dormancy' : 'Capability'}</span></summary>
    <div class="table-scroll" role="region" aria-label="${esc(item.name)} trial results" tabindex="0"><table>
      <caption>${esc(item.name)}: recorded trials</caption>
      <thead><tr><th scope="col">Variant</th><th scope="col">Repeat</th><th scope="col">Outcome</th><th scope="col">Checks</th><th scope="col">Score</th><th scope="col">Tokens / time</th></tr></thead>
      <tbody>${[...item.results].sort((a, b) => a.variant.localeCompare(b.variant) || a.trial - b.trial).map((result) => `<tr>
        <td>${result.variant === 'skilled' ? 'With skill' : 'Baseline'}</td><td>${result.trial + 1}</td>
        <td>${esc(result.status)}${result.error ? `<small>${esc(result.error)}</small>` : ''}</td>
        <td>${result.checks.map((check) => `${esc(check.name)}: ${check.passed ? 'pass' : 'fail'}`).join('<br>') || 'No checks'}</td>
        <td>${result.score === null ? 'Not reported' : result.score.toFixed(3)}</td>
        <td>${result.tokens === null ? 'Unknown tokens' : `${result.tokens} tokens`}<small>${result.durationMs === null ? 'Unknown duration' : `${(result.durationMs / 1000).toFixed(1)} s`}</small></td>
      </tr>`).join('')}</tbody></table></div>
    ${!evidence.complete ? '<p class="notice">This suite is incomplete. Missing baseline or skill trials prevent a complete comparison.</p>' : ''}
  </details>`).join('');
}

function renderEvidence(evidence) {
  const freshness = evidence.runtimeChanged ? 'Source mismatch - evaluation runtime changed' : evidence.changed ? 'Source mismatch - rerun needed' : evidence.fresh ? 'Current source' : 'Older than 30 days - rerun needed';
  return `<article class="model-result" data-evidence-model="${esc(evidence.model)}" data-current="${evidence.fresh && evidence.complete}" data-attention="${!evidence.fresh || !evidence.complete || evidence.category === 'Mixed results'}">
    <div class="result-heading"><h4>${esc(evidence.model)} (${esc(evidence.reasoningEffort ?? 'unreported')} effort)</h4><span class="badge">${esc(evidence.category)}</span></div>
    <p class="provenance">${esc(freshness)}${evidence.complete ? '' : ' / Incomplete evidence'}.
      <time datetime="${esc(evidence.generatedAt)}">${esc(evidence.generatedAt.slice(0, 10))}</time>
      <span>Commit <code>${esc(evidence.commit.slice(0, 12))}</code></span>
      ${evidence.runUrl ? `<a href="${esc(evidence.runUrl)}">View run</a>` : '<span>No public run link</span>'}</p>
    <p class="muted">Judge: ${esc(evidence.judgeModel)} (${esc(evidence.judgeReasoningEffort ?? 'unreported')} effort). ${evidence.runs} repeat${evidence.runs === 1 ? '' : 's'} per task and variant.</p>
    <div class="result-grid">
      <section><h5>Capability with skill</h5><p>${rate(evidence.capability)}</p></section>
      <section><h5>Without skill</h5><p>${rate(evidence.baseline)}</p><p class="delta">${evidence.delta === null ? 'Delta unavailable' : `${evidence.delta > 0 ? '+' : ''}${Math.round(evidence.delta * 100)} percentage points with skill`}</p></section>
      <section><h5>Routing / dormancy with skill</h5><p>${rate(evidence.dormancy)}</p><p class="muted">Baseline: ${evidence.routingBaseline.passed}/${evidence.routingBaseline.expected} passed${evidence.routingBaseline.missing ? `; ${evidence.routingBaseline.missing} missing` : ''}.</p></section>
    </div>
    <details class="case-list"><summary>Inspect tasks and grader checks (${evidence.cases.length})</summary>${cases(evidence)}</details>
  </article>`;
}

function renderSkill(skill) {
  const evaluated = skill.evidence.length > 0;
  const current = skill.evidence.some((item) => item.fresh && item.complete);
  const attention = skill.evidence.some((item) => !item.fresh || !item.complete || item.category === 'Mixed results');
  const label = !evaluated ? 'Not evaluated' : skill.evidence.length === 1 ? skill.evidence[0].category : `${skill.evidence.length} model / judge / effort combinations`;
  return `<details class="skill" data-skill data-search="${esc(skill.name.toLowerCase())}" data-evaluated="${evaluated}" data-current="${current}" data-attention="${attention}">
    <summary><span class="skill-name">${esc(skill.name)}</span><span class="badge${!evaluated ? ' quiet' : ''}">${esc(label)}</span><span class="expand-label">Details</span></summary>
    <div class="skill-body">${evaluated ? skill.evidence.map(renderEvidence).join('') : '<p class="muted">No offline evaluation has been published for this skill. No rating is assigned.</p>'}</div>
  </details>`;
}

function count(value) {
  return value.toLocaleString('en-US');
}

function metricValue(metric) {
  if (!metric.reported) return 'Not reported';
  return `${metric.minimum || metric.reported < metric.expected ? 'At least ' : ''}${count(metric.total)}`;
}

function judgeValue(judge, field) {
  if (!judge.reportedCalls && (judge.calls || judge.legacyTrials || !judge.trackedTrials)) return 'Not reported';
  if (!judge.calls) return '0';
  return `At least ${count(field ? judge[field] : judge.input + judge.output)}`;
}

function totalValue(usage) {
  const agent = usage.agent.total;
  const judge = usage.judge;
  if (!agent.reported && !judge.reportedCalls) return 'Not reported';
  const minimum = agent.minimum || agent.reported < agent.expected || judge.calls > 0 ||
    judge.legacyTrials > 0 || usage.recordedTrials < usage.expectedTrials;
  return `${minimum ? 'At least ' : ''}${count(agent.total + judge.input + judge.output)}`;
}

function usageCard(title, value, note) {
  return `<section class="usage-card"><h3>${title}</h3><strong>${value}</strong><small>${note}</small></section>`;
}

function usageRows(rows, heading, firstColumn) {
  return `<div class="table-scroll" role="region" aria-label="${heading}" tabindex="0"><table>
    <caption>${heading}</caption>
    <thead><tr><th scope="col">${firstColumn}</th><th scope="col">Agent tokens</th><th scope="col">Judge tokens</th><th scope="col">Recorded trials</th></tr></thead>
    <tbody>${rows.map((row) => `<tr><th scope="row">${esc(row.label)}</th><td>${metricValue(row.usage.agent.total)}</td><td>${judgeValue(row.usage.judge)}</td><td>${count(row.usage.recordedTrials)} / ${count(row.usage.expectedTrials)}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

function renderUsage(usage) {
  const { total, days, plugins } = usage;
  if (!total.summaries) return `<section id="usage" class="usage" aria-labelledby="usage-heading">
    <div class="section-heading"><h2 id="usage-heading">Token usage</h2></div>
    <div class="empty-state"><h3>No token usage published yet</h3><p>Usage appears after an evaluation run publishes a summary.</p></div>
  </section>`;
  const agent = total.agent;
  const judge = total.judge;
  const metrics = [
    usageCard('Reported total', totalValue(total), `${agent.total.reported} of ${agent.total.expected} trials and ${judge.reportedCalls} of ${judge.calls} judge calls reported usage`),
    usageCard('Agent tokens', metricValue(agent.total), `${agent.total.reported} of ${agent.total.expected} recorded trials reported totals`),
    usageCard('Judge tokens', judgeValue(judge), `${judge.reportedCalls} of ${judge.calls} judge calls reported usage${judge.legacyTrials ? `; ${judge.legacyTrials} older trials have no judge data` : ''}`),
    usageCard('Agent input', metricValue(agent.input), `${agent.input.reported} of ${agent.input.expected} recorded trials reported input`),
    usageCard('Agent output', metricValue(agent.output), `${agent.output.reported} of ${agent.output.expected} recorded trials reported output`),
    usageCard('Judge input', judgeValue(judge, 'input'), `${judge.reportedCalls} of ${judge.calls} judge calls reported usage`),
    usageCard('Judge output', judgeValue(judge, 'output'), `${judge.reportedCalls} of ${judge.calls} judge calls reported usage`),
    usageCard('Agent cache read', metricValue(agent.cacheRead), `${agent.cacheRead.reported} of ${agent.cacheRead.expected} recorded trials reported cache reads`),
    usageCard('Agent cache write', metricValue(agent.cacheWrite), `${agent.cacheWrite.reported} of ${agent.cacheWrite.expected} recorded trials reported cache writes`),
  ].join('');
  const daily = days.map(({ date, usage: day }) => ({
    date, usage: day, agent: day.agent.total.reported ? day.agent.total.total : 0,
    judge: day.judge.reportedCalls ? day.judge.input + day.judge.output : 0,
  }));
  const maximum = Math.max(1, ...daily.map((day) => day.agent + day.judge));
  const chart = daily.map((day) => {
    const agentWidth = Math.round(day.agent / maximum * 1000);
    const judgeWidth = Math.round(day.judge / maximum * 1000);
    const hasCounts = day.usage.agent.total.reported > 0 || day.usage.judge.reportedCalls > 0;
    return `<div class="usage-bar-row"><time datetime="${day.date}">${day.date}</time>
      <svg viewBox="0 0 1000 16" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect class="agent-bar" x="0" y="1" width="${agentWidth}" height="14"></rect><rect class="judge-bar" x="${agentWidth}" y="1" width="${judgeWidth}" height="14"></rect></svg>
      <span>${hasCounts ? `${count(day.agent + day.judge)} reported` : 'Not reported'}</span></div>`;
  }).join('');
  return `<section id="usage" class="usage" aria-labelledby="usage-heading">
    <div class="section-heading"><h2 id="usage-heading">Token usage</h2><p class="muted">${count(total.runs.size)} linked Actions run${total.runs.size === 1 ? '' : 's'} / ${count(total.summaries)} summar${total.summaries === 1 ? 'y' : 'ies'}</p></div>
    <p class="muted">Reported counts are not billing totals. Agent counts exclude missing usage; totals from older summaries are minimums. Judge counts are minimums because the grading library can replace missing provider fields with zero. Cache counts may overlap input; judge cache details are unavailable.</p>
    <div class="usage-metrics">${metrics}</div>
    <p class="usage-scope">History covers completed default-branch manual runs among the latest 20 workflow runs, while their artifacts remain available (up to 90 days). Usage includes all models; skill filters do not change these totals. PR validation does not run models.${total.expectedTrials > total.recordedTrials ? ` ${count(total.expectedTrials - total.recordedTrials)} expected trial records are missing.` : ''}</p>
    <figure class="usage-trend"><figcaption><h3>Usage by evaluation start date</h3><p class="muted">UTC. Tokens are grouped by the start date of each skill evaluation, not the exact time of each model call. Bars show reported counts only.</p></figcaption>
      <div class="usage-legend" aria-hidden="true"><span><i class="agent-key"></i>Agent</span><span><i class="judge-key"></i>Judge</span></div>
      <div class="usage-bars" aria-hidden="true">${chart}</div>
    </figure>
    ${usageRows(days.map((day) => ({ label: day.date, usage: day.usage })), 'Usage by start date (UTC)', 'Start date')}
    ${usageRows(plugins.map((plugin) => ({ label: plugin.title, usage: plugin.usage })), 'Usage by plugin', 'Plugin')}
  </section>`;
}

function renderEvaluations(data) {
  const allSkills = data.plugins.flatMap((plugin) => plugin.skills);
  const evaluated = allSkills.filter((skill) => skill.evidence.length > 0).length;
  const current = allSkills.filter((skill) => skill.evidence.some((item) => item.fresh && item.complete)).length;
  const models = [...new Set(allSkills.flatMap((skill) => skill.evidence.map((item) => item.model)))].sort();
  const body = `<div class="wrap eval-page">
  <div class="intro"><div><p class="section-label">Evaluation evidence</p><h1>What have we tested?</h1><p class="lede">See how each skill performed on repeatable tasks, with and without the skill installed.</p><a href="#methodology">How to read these results</a></div></div>
  <nav class="eval-jump" aria-label="Evaluation sections"><a href="#results">Skill results</a><a href="#usage">Token usage</a></nav>
  <section class="coverage" aria-label="Published coverage"><div><strong>${data.plugins.length}</strong><span>marketplace plugins</span></div><div><strong>${allSkills.length}</strong><span>locally discovered skills</span></div><div><strong>${evaluated}<span> / ${allSkills.length}</span></strong><span>skills with published evidence</span></div><div><strong>${current}</strong><span>with current, complete evidence</span></div></section>
  ${evaluated === 0 ? '<div class="empty-state"><h2>No evaluation results published yet</h2><p>The inventory below is real. Skills stay marked "Not evaluated" until a validated run is included in the site build.</p></div>' : ''}
  <section id="results" aria-labelledby="results-heading" class="results">
    <div class="section-heading"><h2 id="results-heading">Plugin and skill results</h2><p class="muted">Expand a skill to inspect evidence.</p></div>
    <form class="filters" role="search" data-filters hidden>
      <label class="search-label">Search skills or plugins<input type="search" id="search" placeholder="Search by name" autocomplete="off"></label>
      <label>Plugin<select id="plugin"><option value="">All plugins</option>${data.plugins.map((plugin) => `<option value="${esc(plugin.name)}">${esc(plugin.title)}</option>`).join('')}</select></label>
      <label>Model<select id="model"><option value="">All models</option>${models.map((model) => `<option>${esc(model)}</option>`).join('')}</select></label>
      <label>Evidence<select id="evidence"><option value="">All evidence</option><option value="not-evaluated">Not evaluated</option><option value="evaluated">Published evidence</option><option value="current">Current and complete</option><option value="attention">Mixed, stale or incomplete</option></select></label>
      <button type="reset">Reset</button>
    </form>
    <p id="result-count" class="muted" role="status" aria-live="polite">${allSkills.length} skills across ${data.plugins.length} plugins</p>
    <div id="no-results" class="empty-state" hidden><h3>No matching results</h3><p>Try a different name or reset the filters.</p></div>
    ${data.plugins.map((plugin) => `<section class="plugin" data-plugin="${esc(plugin.name)}" data-plugin-search="${esc(`${plugin.name} ${plugin.title}`.toLowerCase())}">
      <div class="plugin-heading"><div><h3><a href="../plugins/${esc(plugin.name)}/">${esc(plugin.title)}</a></h3><p class="muted">${plugin.external ? 'External skill inventory' : `${plugin.skills.length} discovered skill${plugin.skills.length === 1 ? '' : 's'}`}</p></div><span class="plugin-state">${plugin.external ? 'Not evaluated' : `${plugin.skills.filter((skill) => skill.evidence.length > 0).length}/${plugin.skills.length} evaluated`}</span></div>
      ${plugin.external ? `<p class="external-note">Not evaluated. This plugin lives in another repository; its skill inventory is unavailable in this checkout. Featured catalog entries are not treated as a complete inventory. <a href="${esc(plugin.docsUrl)}">Browse its source</a>.</p>` : plugin.skills.length ? plugin.skills.map(renderSkill).join('') : '<p class="external-note">No skills discovered in this plugin.</p>'}
    </section>`).join('')}
  </section>
  ${renderUsage(data.usage)}
  <section id="methodology" class="methodology" aria-labelledby="methodology-heading"><h2 id="methodology-heading">How to read the evidence</h2>
    <div class="method-grid"><section><h3>Observed results, not confidence</h3><p>A pass rate is passed trials divided by expected trials, including errors and missing trials in the denominator. Repeats test stability on the same task; they are not extra independent tasks. The task count and all-repeats-pass count show that distinction.</p><p>Capability checks assess the requested artifact. Routing / dormancy checks assess whether the skill stays inactive on unrelated tasks. They are reported separately.</p></section>
    <section><h3>A fair comparison</h3><p>Baseline trials run without the skill. The delta compares pass rates on the same capability tasks and repeat count. It is unavailable if any baseline or skill trial is missing. Scores come from each suite's graders and are not calibrated confidence.</p><p>Models, judges and source versions are never pooled. Each skill shows its newest supplied run for each model / judge combination, with that run's own date and commit. Missing trials are never filled from another run.</p></section>
    <section><h3>Evidence categories</h3><dl><dt>Not evaluated</dt><dd>No published run for this skill.</dd><dt>Limited evidence</dt><dd>Published evidence does not meet the repeat, breadth, completeness or freshness rules below.</dd><dt>Mixed results</dt><dd>At least one with-skill trial failed or errored. Baseline failures remain visible in the comparison.</dd><dt>Consistent offline evidence</dt><dd>Every expected baseline and skill trial is present, all with-skill trials pass, and the source is current. At least two capability tasks, one dormancy task and two repeats provide a minimum check of breadth, routing and repeatability. This is a descriptive label, not a statistical guarantee.</dd></dl></section>
    <section><h3>Source and scope matter</h3><p>Evidence becomes stale after ${data.maxAgeDays} days, or when the plugin tree, SKILL.md, suite directory or evaluation runtime hash changes. Suite hashes include fixtures and hidden checks. Stale and incomplete runs remain inspectable but cannot receive the consistent-evidence label.</p><p>Power Pages evaluations run offline. Documentation, HTML and ER diagrams can be graded for semantic correctness and artifact quality without creating sites or calling a tenant. A passing artifact check does not prove a deployed site works.</p><p>Only summary metadata and named grader outcomes are published. Raw model responses, prompts and generated artifacts are not included here. A run link identifies provenance; it does not certify the evaluation design.</p></section></div>
  </section>
</div>`;
  return layout({
    title: 'Skill evaluations',
    description: 'Offline evaluation evidence for Power Platform plugins and skills, with baseline comparisons and coverage limits.',
    root: '../',
    body,
    activePage: 'evaluations',
    styles: ['assets/evaluations.css'],
    scripts: ['assets/evaluations.js'],
  });
}

module.exports = { renderEvaluations };
