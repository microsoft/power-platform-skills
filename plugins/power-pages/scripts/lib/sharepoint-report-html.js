'use strict';

const { escapeHtml, escapeHtmlAttribute } = require('./render-template');

// Receives the validated report model. Every source value is encoded for its
// output context before these code-owned fragments enter a RAW template slot.
function rich(value) {
  if (typeof value === 'string') return escapeHtml(value);
  const tags = { text: 'span', strong: 'strong', emphasis: 'em', code: 'code', badge: 'span', link: 'a' };
  return value.map((run) => {
    const tag = tags[run.kind];
    let attributes = '';
    if (run.kind === 'badge') attributes = ` class="badge tone-${escapeHtmlAttribute(run.tone)}"`;
    if (run.kind === 'link') {
      attributes = ` href="${escapeHtmlAttribute(run.href)}"`;
      if (run.href.startsWith('https://')) attributes += ' target="_blank" rel="noopener noreferrer"';
    }
    return `<${tag}${attributes}>${escapeHtml(run.text)}</${tag}>`;
  }).join('');
}

function renderBlocks(blocks, headingOffset = 0) {
  return blocks.map((block) => {
    switch (block.type) {
      case 'paragraph':
        return `<p class="rich">${rich(block.content)}</p>`;
      case 'heading': {
        const level = (block.level || 3) + headingOffset;
        return `<h${level}>${escapeHtml(block.text)}</h${level}>`;
      }
      case 'code':
        return `<pre><code>${escapeHtml(block.text)}</code></pre>`;
      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul';
        return `<${tag}>${block.items.map((item) => `<li class="rich">${rich(item)}</li>`).join('')}</${tag}>`;
      }
      case 'facts':
        return `<dl class="facts">${block.items.map((item) => (
          `<div class="fact-row"><dt>${escapeHtml(item.label)}</dt><dd class="rich">${rich(item.value)}</dd></div>`
        )).join('')}</dl>`;
      case 'table': {
        const head = block.columns.map((column) => `<th scope="col">${escapeHtml(column)}</th>`).join('');
        const rows = block.rows.length ? block.rows.map((row) => (
          `<tr>${row.map((cell, index) => `<td data-label="${escapeHtmlAttribute(block.columns[index])}"><div class="rich">${rich(cell)}</div></td>`).join('')}</tr>`
        )).join('') : `<tr class="empty-row"><td colspan="${block.columns.length}">${escapeHtml(block.emptyMessage || 'No entries recorded yet.')}</td></tr>`;
        return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
      }
      case 'callout':
        return `<div class="callout tone-${escapeHtmlAttribute(block.tone)}">${renderBlocks(block.blocks, headingOffset)}</div>`;
      default:
        throw new Error(`Unsupported validated report block: ${block.type}`);
    }
  }).join('\n');
}

function displayTime(value) {
  // Older records use display strings such as "2026-09-16 20:12 IST". Preserve
  // those rather than guessing their timezone; format canonical ISO dates only.
  const date = /^\d{4}-\d{2}-\d{2}T/.test(value) ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: 'UTC', timeZoneName: 'short',
  }).format(date);
}

function renderReportHtml(data) {
  // Logical section IDs are also native anchor targets. Reserve the template's
  // controls and generated headings so a section cannot shadow navigation/data.
  const domIds = new Set([
    'overview', 'report-title', 'report-content', 'record-nav', 'section-nav',
    'report-toc', 'records-label', 'print-report', 'sharepoint-report-data',
  ]);
  for (const section of data.sections) {
    for (const id of [section.id, `heading-${section.id}`]) {
      if (domIds.has(id)) throw new Error(`Report section "${section.id}" conflicts with a generated element ID.`);
      domIds.add(id);
    }
  }
  const current = data.links.find((entry) => entry.artifact === data.artifact);
  const navigation = data.links.map((entry) => (
    `<a class="nav-btn${entry.artifact === data.artifact ? ' active' : ''}" href="${escapeHtmlAttribute(entry.href)}"${entry.artifact === data.artifact ? ' aria-current="page"' : ''}>${escapeHtml(entry.label)}</a>`
  )).join('\n');
  const primary = data.sections.filter((section) => !section.detail);
  const supporting = data.sections.filter((section) => section.detail);
  let supportingId = 'supporting-record';
  while (data.sections.some((section) => section.id === supportingId)) supportingId += '-more';
  const hasSupporting = supporting.length > 0 || data.metadata !== undefined;
  const tocEntry = (id, title) => `<a class="nav-btn toc-link" href="#${escapeHtmlAttribute(id)}">${escapeHtml(title)}</a>`;
  const toc = [
    tocEntry('overview', 'Summary'),
    ...primary.map((section) => tocEntry(section.id, section.title)),
    ...(hasSupporting ? [tocEntry(supportingId, 'Detailed record and evidence')] : []),
  ].join('\n');
  const sectionHtml = (section, detail = false) => {
    const heading = detail ? 'h3' : 'h2';
    return `<section class="${detail ? 'audit-section' : 'reader-section'}" id="${escapeHtmlAttribute(section.id)}" aria-labelledby="heading-${escapeHtmlAttribute(section.id)}">
<${heading} id="heading-${escapeHtmlAttribute(section.id)}" tabindex="-1">${escapeHtml(section.title)}</${heading}>
${renderBlocks(section.blocks, detail ? 1 : 0)}
</section>`;
  };
  const supportingHtml = hasSupporting ? `<details class="supporting-record" id="${supportingId}">
<summary>Detailed record and evidence</summary>
<p class="detail-intro">Supporting notes and earlier snapshots are retained below. Use the brief above for the current position; historical wording may have been superseded by later recorded decisions.</p>
${data.metadata !== undefined ? `<div class="metadata rich">${rich(data.metadata)}</div>` : ''}
${supporting.map((section) => sectionHtml(section, true)).join('\n')}
</details>` : '';
  return {
    navigation,
    toc,
    label: current.label,
    updated: displayTime(data.updatedAt),
    content: `<section class="report-intro" id="overview" aria-labelledby="report-title">
<h1 id="report-title" tabindex="-1">${escapeHtml(data.title)}</h1>
<p class="lead rich">${rich(data.summary)}</p>
<p class="document-meta"><strong>Recorded position:</strong> ${escapeHtml(data.phase)}</p>
</section>
${primary.map((section) => sectionHtml(section)).join('\n')}
${supportingHtml}
<footer class="footer rich">${rich(data.footer === undefined ? 'Local working record. Kept out of Git, the SPA build, and deployment uploads.' : data.footer)}</footer>`,
  };
}

module.exports = { renderReportHtml };
