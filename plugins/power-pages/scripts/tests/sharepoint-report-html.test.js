const test = require('node:test');
const assert = require('node:assert/strict');
const { renderReportHtml } = require('../lib/sharepoint-report-html');
const { validateArtifact } = require('../render-sharepoint-artifact');

function fixture() {
  return {
    version: 1, artifact: 'requirements', title: 'Portal brief',
    updatedAt: '2026-09-16T14:00:00Z', phase: 'Discovery blocked',
    summary: 'Build a read-only customer portal. Source access needs confirmation before discovery can continue.',
    links: ['requirements', 'discovery', 'plan', 'sharing', 'progress'].map(artifact => ({
      artifact, label: artifact, href: `${artifact}.html`,
    })),
    sections: [{
      id: 'next-action', title: 'What happens next',
      blocks: [{
        type: 'facts',
        items: [{ label: 'Needed from the maker', value: 'Sign in to the approved source tenant or choose a synthetic preview.' }],
      }],
    }],
  };
}

test('static rendering preserves encoded text, attributes, and local reference links', () => {
  const data = fixture();
  const unusual = '<strong>Literal & "quoted" text</strong>';
  data.sections[0].title = unusual;
  data.sections[0].blocks = [
    { type: 'facts', items: [{ label: unusual, value: unusual }] },
    { type: 'table', columns: [unusual], rows: [[unusual]] },
    { type: 'paragraph', content: [{ kind: 'link', text: unusual, href: 'plan.html#decisions' }] },
  ];
  const result = renderReportHtml(validateArtifact(data));
  assert.doesNotMatch(result.content, /<strong>Literal/);
  assert.match(result.content, /&lt;strong&gt;Literal &amp;/);
  assert.match(result.content, /data-label="&lt;strong&gt;Literal &amp; &quot;quoted&quot;/);
  assert.match(result.content, /href="plan.html#decisions"/);
  assert.doesNotMatch(result.content, /target="_blank"/);
});

test('supporting notes are disclosed together without cluttering the main contents list', () => {
  const data = fixture();
  data.metadata = 'Original recording context';
  data.sections.push({
    id: 'old-intake', title: 'Old intake', detail: true,
    blocks: [{ type: 'heading', text: 'An earlier question' }, { type: 'paragraph', content: 'Retained evidence.' }],
  });
  const result = renderReportHtml(validateArtifact(data));
  assert.match(result.toc, /What happens next/);
  assert.match(result.toc, /Detailed record and evidence/);
  assert.doesNotMatch(result.toc, /Old intake/);
  assert.match(result.content, /id="old-intake"/);
  assert.match(result.content, /<h4>An earlier question<\/h4>/);
  assert.match(result.content, /Original recording context/);
  assert.match(result.content, /Retained evidence/);
});

test('generated supporting-record ID does not collide with source section IDs', () => {
  const data = fixture();
  data.metadata = 'Context';
  data.sections[0].id = 'supporting-record';
  const result = renderReportHtml(validateArtifact(data));
  assert.match(result.content, /<details class="supporting-record" id="supporting-record-more">/);
  assert.match(result.toc, /href="#supporting-record-more"/);
});

test('sections cannot shadow renderer controls or generated heading IDs', () => {
  const control = fixture();
  control.sections[0].id = 'print-report';
  assert.throws(() => renderReportHtml(validateArtifact(control)), /conflicts with a generated element ID/);
  const heading = fixture();
  heading.sections.push({ id: 'heading-next-action', title: 'Conflicting anchor', blocks: [] });
  assert.throws(() => renderReportHtml(validateArtifact(heading)), /conflicts with a generated element ID/);
});

test('display timestamps preserve legacy timezone text and format ISO timestamps explicitly', () => {
  const data = fixture();
  assert.match(renderReportHtml(validateArtifact(data)).updated, /UTC/);
  data.updatedAt = '2026-09-16 20:12 IST';
  assert.equal(renderReportHtml(validateArtifact(data)).updated, data.updatedAt);
});
