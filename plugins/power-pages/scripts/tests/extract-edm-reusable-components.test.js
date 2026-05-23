const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  extractReusableComponents,
  readAdxName,
  toComponentName,
  referencePatterns,
} = require('../extract-edm-reusable-components');

function makeEdmRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edm-reusable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

// readAdxName ---------------------------------------------------------------

test('readAdxName extracts a quoted YAML adx_name value', (t) => {
  const root = makeEdmRoot(t);
  write(root, 'content-snippets/Newsletter CTA.contentsnippet.yml', 'adx_name: "Newsletter CTA"\nadx_value: <p>Sign up</p>\n');
  assert.equal(
    readAdxName(path.join(root, 'content-snippets/Newsletter CTA.contentsnippet.yml')),
    'Newsletter CTA',
  );
});

test('readAdxName skips indented adx_name (e.g. nested under a child record)', (t) => {
  const root = makeEdmRoot(t);
  write(
    root,
    'content-snippets/Sample.contentsnippet.yml',
    [
      'adx_name: Top Level',
      'children:',
      '  - adx_name: Nested Should Be Ignored',
      '',
    ].join('\n'),
  );
  assert.equal(readAdxName(path.join(root, 'content-snippets/Sample.contentsnippet.yml')), 'Top Level');
});

test('readAdxName returns null when the YAML has no adx_name line', (t) => {
  const root = makeEdmRoot(t);
  write(root, 'content-snippets/Empty.contentsnippet.yml', 'adx_value: <p>Body</p>\n');
  assert.equal(readAdxName(path.join(root, 'content-snippets/Empty.contentsnippet.yml')), null);
});

// toComponentName -----------------------------------------------------------

test('toComponentName turns kebab-case into PascalCase', () => {
  assert.equal(toComponentName('header-nav'), 'HeaderNav');
});

test('toComponentName turns space-separated names into PascalCase', () => {
  assert.equal(toComponentName('Newsletter CTA'), 'NewsletterCta');
});

test('toComponentName strips a leading digit so the result is a valid JS identifier', () => {
  // "404 Page" must not produce "404Page" which is invalid JS. The leading non-letter
  // characters are dropped so the result starts with a letter.
  assert.equal(toComponentName('404 Page'), 'Page');
});

test('toComponentName returns null for empty input', () => {
  assert.equal(toComponentName(''), null);
  assert.equal(toComponentName(null), null);
});

test('toComponentName handles apostrophes and ampersands as separators', () => {
  // Real-world snippet names often contain &, ', etc. They become word boundaries,
  // not part of the identifier. The function title-cases every word uniformly — it
  // does not preserve acronym casing, which keeps the rule simple and predictable.
  // ("FAQ" → "Faq", same shape as "Newsletter CTA" → "NewsletterCta".)
  assert.equal(toComponentName("FAQ & Help"), 'FaqHelp');
  assert.equal(toComponentName("User's Profile"), 'UserSProfile');
});

// referencePatterns ---------------------------------------------------------

test('referencePatterns for content-snippet matches both Liquid forms', () => {
  const [p1, p2] = referencePatterns('content-snippet', 'Newsletter CTA');
  assert.ok(p1.test("{% snippet 'Newsletter CTA' %}"));
  assert.ok(p1.test('{% snippet "Newsletter CTA" %}'));
  assert.ok(p2.test('{{ snippets["Newsletter CTA"] }}'));
  assert.ok(!p1.test("{% snippet 'Other Snippet' %}"));
});

test('referencePatterns for content-snippet is case-insensitive on the Liquid keyword but case-sensitive on the name', () => {
  // The Liquid keyword `snippet` can be upper or lower case in templates; the name
  // itself must match exactly. Regex /i covers both; we verify the keyword side.
  const [p1] = referencePatterns('content-snippet', 'Newsletter CTA');
  assert.ok(p1.test("{% SNIPPET 'Newsletter CTA' %}"));
});

test('referencePatterns escapes regex metacharacters in the snippet name', () => {
  // "Header.Nav" must not match "HeaderXNav" — the period is treated as a literal,
  // not as the regex any-character wildcard.
  const [p1] = referencePatterns('content-snippet', 'Header.Nav');
  assert.ok(p1.test("{% snippet 'Header.Nav' %}"));
  assert.ok(!p1.test("{% snippet 'HeaderXNav' %}"));
});

// extractReusableComponents end-to-end --------------------------------------

test('extractReusableComponents counts a content-snippet referenced from 3 pages', (t) => {
  const root = makeEdmRoot(t);
  write(root, 'content-snippets/Newsletter CTA.contentsnippet.yml', 'adx_name: Newsletter CTA\n');
  write(root, 'web-pages/home/Home.webpage.copy.html', "<p>{% snippet 'Newsletter CTA' %}</p>");
  write(root, 'web-pages/about/About.webpage.copy.html', "<aside>{% snippet 'Newsletter CTA' %}</aside>");
  write(root, 'web-pages/faq/FAQ.webpage.copy.html', '<footer>{{ snippets["Newsletter CTA"] }}</footer>');
  write(root, 'web-pages/unrelated/Other.webpage.copy.html', '<p>No snippet here.</p>');

  const found = extractReusableComponents(root, { framework: 'react' });
  const cta = found.find((f) => f.sourceArtifact.endsWith('Newsletter CTA.contentsnippet.yml'));
  assert.ok(cta);
  assert.equal(cta.reuseCount, 3);
  assert.equal(cta.sourceKind, 'content-snippet');
  assert.equal(cta.spaTarget.componentName, 'NewsletterCta');
  assert.equal(cta.spaTarget.kind, 'content');
  assert.equal(cta.spaTarget.framework, 'react');
  // referencedBy should not include the unrelated page or the snippet's own sidecar
  assert.equal(cta.referencedBy.length, 3);
  assert.ok(!cta.referencedBy.some((p) => p.includes('Other.webpage')));
});

test('extractReusableComponents counts a web-template referenced from page-templates', (t) => {
  const root = makeEdmRoot(t);
  write(root, 'web-templates/Article Layout.webtemplate.yml', 'adx_name: Article Layout\n');
  write(root, 'web-templates/Article Layout.webtemplate.source.html', '<div>{{ entity.faq_articletitle }}</div>');
  // The Liquid `include` form
  write(root, 'web-pages/article/Article.webpage.copy.html', "{% include 'Article Layout' %}");
  // The page-template YAML form
  write(
    root,
    'page-templates/Article Page Template.pagetemplate.yml',
    [
      'adx_name: Article Page Template',
      'adx_webtemplateid:',
      '  adx_name: Article Layout',
      '',
    ].join('\n'),
  );

  const found = extractReusableComponents(root);
  const tpl = found.find((f) => f.sourceArtifact.endsWith('Article Layout.webtemplate.yml'));
  assert.ok(tpl);
  assert.equal(tpl.sourceKind, 'web-template');
  // Two references: the include + the page-template
  assert.equal(tpl.reuseCount, 2);
  assert.equal(tpl.spaTarget.componentName, 'ArticleLayout');
  assert.equal(tpl.spaTarget.kind, 'layout');
});

test('extractReusableComponents counts a weblink-set referenced from Liquid', (t) => {
  const root = makeEdmRoot(t);
  write(root, 'weblink-sets/Primary Navigation.weblinkset.yml', 'adx_name: Primary Navigation\n');
  write(
    root,
    'web-templates/Header.webtemplate.source.html',
    `{% include 'weblink_set' webLinks: weblinks["Primary Navigation"] %}`,
  );
  write(
    root,
    'web-templates/Footer.webtemplate.source.html',
    `{{ weblinks["Primary Navigation"] }}`,
  );

  const found = extractReusableComponents(root);
  const ws = found.find((f) => f.sourceArtifact.endsWith('Primary Navigation.weblinkset.yml'));
  assert.ok(ws);
  assert.equal(ws.sourceKind, 'weblink-set');
  assert.equal(ws.reuseCount, 2);
  assert.equal(ws.spaTarget.kind, 'navigation');
  assert.equal(ws.spaTarget.componentName, 'PrimaryNavigation');
});

test('extractReusableComponents excludes self-reference: a snippet does not reuse itself', (t) => {
  const root = makeEdmRoot(t);
  // The snippet's own sidecar file (same dir + same basename prefix) must be excluded
  // from referencedBy so a snippet authored alongside its body doesn't inflate the count.
  write(root, 'content-snippets/Hero.contentsnippet.yml', 'adx_name: Hero\n');
  write(root, 'content-snippets/Hero.contentsnippet.liquid', `{% snippet 'Hero' %}`);
  write(root, 'web-pages/home/Home.webpage.copy.html', `{% snippet 'Hero' %}`);

  const found = extractReusableComponents(root);
  const hero = found.find((f) => f.sourceArtifact.endsWith('Hero.contentsnippet.yml'));
  assert.ok(hero);
  // Exactly 1: the home page. The sidecar liquid file is dropped because it shares
  // the same dir + basename prefix as the source.
  assert.equal(hero.reuseCount, 1);
  assert.ok(hero.referencedBy[0].includes('Home.webpage'));
});

test('extractReusableComponents returns reuseCount=0 when a snippet is defined but never referenced', (t) => {
  const root = makeEdmRoot(t);
  write(root, 'content-snippets/Orphan.contentsnippet.yml', 'adx_name: Orphan\n');
  write(root, 'web-pages/home/Home.webpage.copy.html', '<p>Nothing here.</p>');

  const found = extractReusableComponents(root);
  const orphan = found.find((f) => f.sourceArtifact.endsWith('Orphan.contentsnippet.yml'));
  assert.ok(orphan);
  assert.equal(orphan.reuseCount, 0);
  assert.deepEqual(orphan.referencedBy, []);
  // The implementer's "if reuseCount >= 2, factor it into a component" rule keys off
  // this number — surface 0 explicitly rather than dropping the entry.
});

test('extractReusableComponents marks i18n when localized siblings exist', (t) => {
  const root = makeEdmRoot(t);
  write(root, 'content-snippets/Greeting.contentsnippet.yml', 'adx_name: Greeting\n');
  // Sibling localized variant — same dir, basename prefix matches.
  write(root, 'content-snippets/Greeting.en-US.contentsnippet.yml', 'adx_name: Greeting\n');
  write(root, 'web-pages/home/Home.webpage.copy.html', `{% snippet 'Greeting' %}`);

  const found = extractReusableComponents(root);
  const greeting = found.find(
    (f) => f.sourceArtifact === 'content-snippets/Greeting.contentsnippet.yml',
  );
  assert.ok(greeting);
  assert.equal(greeting.spaTarget.i18n, true);
});

test('extractReusableComponents output is sorted (kind, then desc reuseCount, then path) for diff-stable artifacts', (t) => {
  const root = makeEdmRoot(t);
  write(root, 'content-snippets/A.contentsnippet.yml', 'adx_name: A\n');
  write(root, 'content-snippets/B.contentsnippet.yml', 'adx_name: B\n');
  write(root, 'web-templates/Tpl.webtemplate.yml', 'adx_name: Tpl\n');
  // B is referenced more than A
  write(root, 'web-pages/p1/P1.webpage.copy.html', `{% snippet 'B' %}\n{% snippet 'B' %}`);
  // (the same regex matches once per page — duplicate matches within one file count as one)
  write(root, 'web-pages/p2/P2.webpage.copy.html', `{% snippet 'B' %}`);
  write(root, 'web-pages/p3/P3.webpage.copy.html', `{% snippet 'A' %}`);

  const found = extractReusableComponents(root);
  // Kind order: content-snippet before web-template. Within content-snippet, B (higher
  // reuse) before A. Within content-snippet at equal reuse, alphabetical by path.
  assert.equal(found[0].sourceArtifact, 'content-snippets/B.contentsnippet.yml');
  assert.equal(found[1].sourceArtifact, 'content-snippets/A.contentsnippet.yml');
  assert.equal(found[2].sourceArtifact, 'web-templates/Tpl.webtemplate.yml');
});

test('extractReusableComponents returns an empty list when none of the source folders exist', (t) => {
  const root = makeEdmRoot(t);
  write(root, 'web-pages/home/Home.webpage.copy.html', 'no reusables here');
  const found = extractReusableComponents(root);
  assert.deepEqual(found, []);
});
