'use strict';
// ORACLE test of the strict XML reader (lib/strict-xml.js, which every page of a teardown is proven by) against the parser the bundled SDK reads an app's sitemap with.
//
// A page is deleted when an element of the app's sitemap names it. Two readers see that document: the reader here (navigationGenPageIds, over strict-xml.js), whose answer decides what is recorded and deleted, and
// the SDK's own (`collectGenPageIds`, in the bundle's app delete: xmldom's DOMParser with an error handler, then every SubArea at any depth), which decides whether the app can be deleted at all. They must not disagree
// in the dangerous direction. Over a corpus that is generated (the same documents on every run, from a seed) and fixed (documents that a simpler reader once misread, and what the platform writes), each document is held to:
//
//   1. whenever the reader returns a membership, xmldom parses the document with no warning, error or fatalError, the SDK's reader accepts it (every GenPageId is a GUID), and the page ids of the SubArea elements directly
//      under SiteMap/Area/Group — the only ones the reader takes — are exactly the ones the reader returned, all of them among the pages the SDK retains (it takes a SubArea at any depth, which is wider, and the difference
//      only ever keeps a page) — a document the SDK reads differently is never one a page is deleted on;
//   2. whenever xmldom reports anything, or the SDK's reader refuses the document, the reader returns "unreadable" (and so keeps every page, and records nothing).
//
// And, because an oracle that accepts nothing proves nothing, the documents the generator knows the answer to are checked against that answer too: ids that are real entries are found, decoys that are text — in
// comments, CDATA sections, processing instructions, attribute values and markers that interleave — are not.
//
// The oracle is the bundle's own xmldom, not a copy: the SDK installs it as `globalThis.DOMParser` when its sitemap code runs (`installDomShim`), and Node has none of its own. Nothing in production code depends on that.
const test = require('node:test');
const assert = require('node:assert');
const { withThrowawaySdk } = require('../lib/throwaway-sdk.js');
const { navigationGenPageIds } = require('../lib/sitemap-pages.js');

const ORIGIN = 'https://contoso.crm.dynamics.com';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444'; // the page that only text names
const NAV = 'SiteMap/Area/Group';

// The documents of the generated corpus. 6,000 damaged ones take a few seconds; STRICT_XML_ORACLE_DOCS=300000 is a longer run for whoever changes the reader.
const GENERATED = Number(process.env.STRICT_XML_ORACLE_DOCS) || 6000;

let Parser;
test.before(async () => {
  assert.strictEqual(typeof globalThis.DOMParser, 'undefined', 'this test takes the bundle\'s xmldom from the DOMParser its sitemap code installs; something else defines one');
  await withThrowawaySdk({ env: ORIGIN, prefix: 'contoso-xmldom-oracle-', httpClient: { get: async () => ({ status: 404, body: {} }) } }, async (make) => {
    // The app adapter reads a sitemap: running it is what installs xmldom's DOMParser.
    make().requireRegistration('app').adapter.fromApiResponse({ $sitemap: { sitemapxml: '<SiteMap/>' } });
  });
  assert.strictEqual(typeof globalThis.DOMParser, 'function', 'the bundle no longer installs xmldom as globalThis.DOMParser when its sitemap code runs: take the oracle from where the bundle puts it now');
  Parser = globalThis.DOMParser;
});

// What normalizeGuid does in the bundle (the reader that its app delete takes the pages to retain with): a GUID, or one in braces, lower-cased; anything else throws.
function normalizeGuid(raw) {
  const text = String(raw);
  const id = text.length === 38 && text.startsWith('{') && text.endsWith('}') ? text.slice(1, -1) : text;
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)) throw new Error(`GenPageId '${raw}' is no GUID`);
  return id.toLowerCase();
}

// The SDK's reader of an app's sitemap, as the bundle's `collectGenPageIds` does it: xmldom with an error handler, refusing a document it reports anything about, and every SubArea at any depth. It answers the ids of
// the SubAreas directly under SiteMap/Area/Group (what the reader under test takes) and of all of them (what the SDK retains), or why it refuses.
function sdkReads(xml) {
  const problems = [];
  const report = (kind) => (message) => problems.push(`${kind}: ${String(message).split('\n')[0]}`);
  let root;
  try {
    root = new Parser({ errorHandler: { warning: report('warning'), error: report('error'), fatalError: report('fatalError') } }).parseFromString(xml, 'text/xml').documentElement;
  } catch (e) {
    return { ok: false, why: `xmldom threw: ${e.message}` };
  }
  if (!root) return { ok: false, why: 'no root element' };
  if (problems.length) return { ok: false, why: problems[0] };
  const navigation = new Set();
  const any = new Set();
  try {
    const walk = (node, path) => {
      if (node.nodeName === 'SubArea') {
        const raw = node.getAttribute('GenPageId');
        if (raw) {
          const id = normalizeGuid(raw);
          any.add(id);
          if (path === NAV) navigation.add(id);
        }
      }
      const below = path ? `${path}/${node.nodeName}` : node.nodeName;
      for (let i = 0; i < node.childNodes.length; i += 1) {
        const child = node.childNodes[i];
        if (child.nodeType === 1) walk(child, below);
      }
    };
    walk(root, '');
  } catch (e) {
    return { ok: false, why: e.message };
  }
  return { ok: true, ids: [...navigation].sort(), any: [...any].sort() };
}

const readable = (xml) => {
  const r = navigationGenPageIds(xml);
  return r.ok ? r.ids : null;
};

// ── The corpus ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// A small seeded generator (mulberry32): the corpus is the same on every run and every machine.
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const navigation = (...inside) => `<SiteMap><Area Id="a"><Group Id="g">${inside.join('')}</Group></Area></SiteMap>`;
const entry = (id, quote = '"') => `<SubArea Id="p_${id}" GenPageId=${quote}${id}${quote} Title="Page"/>`;

// Fixed documents: [name, document, answer], where the answer is the ids the reader must return, or null for "unreadable". The first are documents that a simpler reader once misread; then what the platform and the SDK write; then the
// ways a document stops being one document.
const FIXED = [
  // — delimiters of one kind of construct inside another kind (well-formed XML, which an independent parser reads the same way)
  ['a PI holding "<!--" and a CDATA section holding "-->" and "?>" around an entry for B', navigation(entry(A), `<?p <!-- ?><![CDATA[ --> ?> ${entry(B)} ]]>`), [A]],
  ['PIs holding the markers of a CDATA section around an entry', navigation('<?note <![CDATA[ ?>', entry(A), '<?note ]]> ?>', entry(B)), [A, B]],
  ['CDATA sections holding the markers of a comment around an entry', navigation('<![CDATA[ <!-- ]]>', entry(A), '<![CDATA[ --> ]]>', entry(B)), [A, B]],
  ['a comment holding the markers of a CDATA section and a PI', navigation(entry(A), `<!-- <![CDATA[ <? ]]> ${entry(D)} -->`), [A]],
  ['a PI holding "-->" and "]]>"', navigation(entry(A), `<?p --> ]]> ${entry(D)} ?>`), [A]],
  ['a CDATA section holding "<?" and "<!--"', navigation(entry(A), `<![CDATA[ <? <!-- ${entry(D)} ]]>`), [A]],
  ['a comment, a CDATA section and a PI that each hold an entry', navigation(entry(A), `<!-- ${entry(D)} --><![CDATA[${entry(D)}]]><?p ${entry(D)}?>`), [A]],
  ['an attribute value that holds every delimiter', navigation(`<SubArea Id="s" Title="--> ?> ]]> &lt;!-- &lt;![CDATA[ &lt;? &lt;SubArea GenPageId=&quot;${D}&quot;/&gt;" GenPageId="${A}"/>`), [A]],
  ['a single-quoted value that holds a double-quoted GenPageId, and the other way round', navigation(`<SubArea Id="s" Title='GenPageId="${D}"' GenPageId='${A}'/>`, `<SubArea Id="t" Title="GenPageId='${D}'" GenPageId="${B}"/>`), [A, B]],
  // — what the platform and the SDK write, and spellings an XML library may use
  ['two entries', navigation(entry(A), entry(B)), [A, B]],
  ['an XML declaration, a byte order mark and CRLF line ends', `\uFEFF<?xml version="1.0" encoding="utf-8"?>\r\n${navigation(entry(A), entry(B))}`, [A, B]],
  ['an XML declaration with standalone and single quotes', `<?xml version='1.0' encoding='UTF-8' standalone='yes'?>${navigation(entry(A))}`, [A]],
  ['spaces around "=", tabs and new lines inside tags, closing tags with a space', `<SiteMap >\n<Area Id = 'a'>\n<Group Id = 'g'><SubArea\r\n Title = 'A &amp; B &lt; C &gt; D &quot; E &apos; F'\tGenPageId = '${A}' Id = 'a'></SubArea>\n<SubArea GenPageId = "${B}" Id="b" /></Group ></Area ></SiteMap >`, [A, B]],
  ['namespace declarations', navigation(entry(A), entry(B)).replace('<SiteMap>', '<SiteMap xmlns="" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xml:space="preserve">'), [A, B]],
  ['a default namespace', navigation(entry(A), entry(B)).replace('<SiteMap>', '<SiteMap xmlns="urn:contoso:sitemap">'), [A, B]],
  ['prefixed ancestors', `<m:SiteMap xmlns:m="urn:contoso:sitemap"><m:Area><m:Group>${entry(A)}${entry(B)}</m:Group></m:Area></m:SiteMap>`, []],
  ['areas and groups with nothing in them, several of each', `<SiteMap><Area/><Area Id="a"><Titles><Title LCID="1033" Title="A"/></Titles><Group/><Group Id="g">${entry(A)}</Group><Group Id="h">${entry(B)}</Group></Area><Area Id="c"><Group/></Area></SiteMap>`, [A, B]],
  ['entries with children', navigation(`<SubArea Id="a" GenPageId="${A}" Client="Web" Sku="All" AvailableOffline="true"><Titles><Title LCID="1033" Title="Page"/></Titles><Descriptions><Description LCID="1033" Description="A &amp; B"/></Descriptions><Privilege Entity="account" Privilege="Read"/><IsVisible><Or><Privilege Entity="account" Privilege="Read"/></Or></IsVisible></SubArea>`, entry(B)), [A, B]],
  ['a ">" in a title', navigation(`<SubArea GenPageId="${A}" Title="A > B" Id="a"/>`, entry(B)), [A, B]],
  ['page ids spelled with character references', navigation(`<SubArea Id="a" GenPageId='&#49;${A.slice(1)}'/>`, `<SubArea Id="b" GenPageId="${B.replace('-', '&#x2d;')}"/>`), [A, B]],
  ['braced page ids', navigation(entry(`{${A}}`), entry(`{${B.toUpperCase()}}`, "'")), [A, B]],
  ['an entry with no page, one with an empty one, one that targets a table', navigation('<SubArea Id="x" Entity="account"/>', '<SubArea Id="y" GenPageId=""/>', entry(A)), [A]],
  ['comments, PIs and CDATA between the entries, and around the root', `<!-- before --><?before data?>${navigation(entry(A), '<?note data?> <!-- harmless --> <![CDATA[ignored]]>', entry(B))}<!-- after --><?after data?>\n`, [A, B]],
  ['an empty comment, a comment with a single "-", an empty CDATA section and PI', navigation('<!---->', '<!-- a-b -->', '<![CDATA[]]>', '<?p?>', entry(A)), [A]],
  ['a comment that starts with "->"', navigation('<!--->x-->', entry(A)), [A]],
  ['character data, references and CDATA between the entries', navigation('text &amp; &#38; &#x26; &lt;SubArea&gt; ]] > ', entry(A), '\n\t ', entry(B)), [A, B]],
  ['an element that is no entry, around entries that are not either', navigation(entry(A), `<Other>${entry(D)}</Other>`, `<SubAreaX GenPageId="${D}"/>`, `<subarea GenPageId="${D}"/>`, `<SubArea Id="z" genpageid="${D}"/>`, `<m:SubArea GenPageId="${D}"/>`), [A]],
  ['entries anywhere but under a Group', `<SiteMap><SubArea GenPageId="${D}"/><Area><SubArea GenPageId="${D}"/><Group>${entry(A)}<SubArea Id="o" Entity="x">${entry(D)}</SubArea></Group></Area></SiteMap>`, [A]],
  ['the root is not a sitemap', `<Other><Area><Group>${entry(D)}</Group></Area></Other>`, []],
  ['a root with nothing in it', '<SiteMap/>', []],
  // — documents that are not one document
  ['two document roots', navigation(entry(A)) + navigation(entry(B)), null],
  ['two roots with a comment between them', `${navigation(entry(A))}<!-- between -->${navigation(entry(B))}`, null],
  ['text after the root', `${navigation(entry(A), entry(B))} trailing`, null],
  ['text before the root', `leading ${navigation(entry(A), entry(B))}`, null],
  ['a CDATA section before the root', `<![CDATA[x]]>${navigation(entry(A))}`, null],
  ['a stray closing tag after the root', `${navigation(entry(A))}</SiteMap>`, null],
  ['an element that is never closed', `<SiteMap><Area><Group>${entry(A)}`, null],
  ['a document cut inside a tag', `<SiteMap><Area><Group><SubArea Id="s" GenPageId="${A}"`, null],
  ['a document cut inside an attribute value', `<SiteMap><Area><Group><SubArea Id="s" GenPageId="${A}`, null],
  ['a closing tag out of order', `<SiteMap><Area><Group>${entry(A)}</Area></Group></SiteMap>`, null],
  ['a closing tag that differs in case', `<SiteMap><Area><Group>${entry(A)}</group></Area></SiteMap>`, null],
  ['a closing tag with attributes', `<SiteMap><Area><Group>${entry(A)}${entry(B)}</Group bad="yes"></Area></SiteMap>`, null],
  ['a duplicate attribute', navigation(`<SubArea Id="s" GenPageId="${A}" GenPageId='${B}'/>`), null],
  ['a duplicate attribute on a container', `<SiteMap><Area Id="a" Id="b"><Group>${entry(A)}</Group></Area></SiteMap>`, null],
  ['an unquoted attribute value', navigation(`<SubArea Id=s GenPageId="${A}"/>`, entry(B)), null],
  ['an attribute with no value', navigation(`<SubArea Id GenPageId="${A}"/>`, entry(B)), null],
  ['no white space between attributes', navigation(`<SubArea Id="s"GenPageId="${A}"/>`, entry(B)), null],
  ['a "<" in an attribute value', navigation(`<SubArea Id="s" Title="a < b" GenPageId="${A}"/>`, entry(B)), null],
  ['an entity that is not declared', navigation(`<SubArea Id="s" Title="&unknown;" GenPageId="${A}"/>`, entry(B)), null],
  ['an HTML entity', navigation(`<SubArea Id="s" Title="&nbsp;" GenPageId="${A}"/>`, entry(B)), null],
  ['a bare ampersand in text and in a value', navigation('a & b', `<SubArea Id="s" Title="a & b" GenPageId="${A}"/>`), null],
  ['a character reference to a control character', navigation(`<SubArea Id="s" Title="&#0;" GenPageId="${A}"/>`), null],
  ['a malformed character reference', navigation(`<SubArea Id="s" Title="&#xZZ;" GenPageId="${A}"/>`), null],
  ['an upper-case X in a character reference', navigation(`<SubArea Id="s" Title="&#X41;" GenPageId="${A}"/>`), null],
  ['"]]>" in character data', navigation(entry(A), 'a ]]> b'), null],
  ['"--" in a comment', navigation(entry(A), '<!-- a -- b -->'), null],
  ['a comment that ends in "--->"', navigation(entry(A), '<!-- a --->'), null],
  ['a comment that never ends', navigation(entry(A), '<!-- a'), null],
  ['a CDATA section that never ends', navigation(entry(A), '<![CDATA[ a'), null],
  ['a PI that never ends', navigation(entry(A), '<?p a'), null],
  ['a PI with no target', navigation(entry(A), '<?>'), null],
  ['a PI named xml inside the root', navigation('<?xml version="1.0"?>', entry(A)), null],
  ['an XML declaration after white space', ` <?xml version="1.0"?>${navigation(entry(A))}`, null],
  ['an XML declaration after a comment', `<!-- c --><?xml version="1.0"?>${navigation(entry(A))}`, null],
  ['an XML declaration with version 1.1', `<?xml version="1.1"?>${navigation(entry(A))}`, null],
  ['a document type declaration', `<!DOCTYPE SiteMap>${navigation(entry(A), entry(B))}`, null],
  ['a document type declaration with an entity', `<!DOCTYPE SiteMap [<!ENTITY p "x">]>${navigation(entry(A))}`, null],
  ['a name with two colons', navigation(`<SubArea Id="s" a:b:c="1" GenPageId="${A}"/>`), null],
  ['a name that starts with a colon', navigation(`<:SubArea GenPageId="${A}"/>`), null],
  ['a name beyond U+FFFF', navigation(`<\u{10000}x GenPageId="${A}"/>`), null],
  ['a control character', navigation(entry(A), 'a \u0001 b'), null],
  ['a lone surrogate', navigation(entry(A), 'a \ud800 b'), null],
  ['U+FFFE', navigation(entry(A), 'a \ufffe b'), null],
  ['a page id that is no GUID on an entry', navigation(entry(A), entry('not-a-guid', "'")), null],
  ['a page id that is no GUID on an element that is no entry', `<SiteMap><Area><SubArea Id="s" GenPageId='not-a-guid'/><Group>${entry(A)}</Group></Area></SiteMap>`, null],
  ['no text', '', null],
  ['only white space', ' \n ', null],
  ['only a comment', '<!-- x -->', null],
  ['a slash that is not followed by ">"', navigation(`<SubArea Id="s" GenPageId="${A}"/ >`), null],
  // — what the SDK's parser misreads, or warns about, in a document that is well-formed XML (found by this test, each; see strict-xml.js)
  ['every end tag of a name written with white space before its ">"', navigation(`<SubArea Id="a" GenPageId="${A}"></SubArea >`, `<SubArea Id="b" GenPageId="${B}"></SubArea >`), [A, B]],
  ['end tags of one name that mix "</SubArea>" and "</SubArea >"', navigation(`<SubArea Id="a" GenPageId="${A}"></SubArea>`, `<SubArea Id="b" GenPageId="${B}"></SubArea >`), null],
  ['a "</SubArea>" in a comment between end tags written "</SubArea >"', navigation(`<SubArea Id="a" GenPageId="${A}"></SubArea >`, '<!-- </SubArea> -->', `<SubArea Id="b" GenPageId="${B}"></SubArea >`), null],
  ['the same comment after the last of them', navigation(`<SubArea Id="a" GenPageId="${A}"></SubArea >`, `<SubArea Id="b" GenPageId="${B}"></SubArea >`, '<!-- </SubArea> -->'), [A, B]],
  ['a "</SubArea>" in a CDATA section between end tags written "</SubArea >"', navigation(`<SubArea Id="a" GenPageId="${A}"></SubArea >`, '<![CDATA[ </SubArea> ]]>', `<SubArea Id="b" GenPageId="${B}"></SubArea >`), null],
  ['a "</SubArea>" in a PI between end tags written "</SubArea >"', navigation(`<SubArea Id="a" GenPageId="${A}"></SubArea >`, '<?p </SubArea> ?>', `<SubArea Id="b" GenPageId="${B}"></SubArea >`), null],
  ['an XHTML script element that holds a CDATA section with its own end tag', navigation(entry(A), '<script xmlns="http://www.w3.org/1999/xhtml"><![CDATA[ </script> ]]></script>', entry(B)), null],
  ['an XHTML script element, plain', navigation(entry(A), '<script xmlns="http://www.w3.org/1999/xhtml">x</script>', entry(B)), null],
  ['an XHTML default namespace on the root and no script element', navigation(entry(A), entry(B)).replace('<SiteMap>', '<SiteMap xmlns="http://www.w3.org/1999/xhtml">'), [A, B]],
  ['a script element in no namespace that holds a CDATA section with its own end tag', navigation(entry(A), '<script><![CDATA[ </script> ]]></script>', entry(B)), [A, B]],
  ['a name with U+FEFF in it', navigation(entry(A), `<Sub\uFEFFArea GenPageId="${D}"/>`), null],
  ['non-ASCII letters in names of elements that are no entries', navigation(entry(A), `<SubAreaÜ GenPageId="${D}"/>`, `<保存><SubArea GenPageId="${D}"/></保存>`, entry(B)), [A, B]],
  // — an attribute named like a member of Object.prototype: xmldom keeps a tag's attribute names in a plain object, so `hasOwnProperty` followed by another attribute is an error to it (and the SDK's app delete
  //   refuses the document after the pages were recorded); any such name, anywhere, is unreadable here
  ['hasOwnProperty before GenPageId on an entry', navigation(entry(A), `<SubArea hasOwnProperty="x" GenPageId="${B}"/>`), null],
  ['hasOwnProperty before Id on the Group', `<SiteMap><Area Id="a"><Group hasOwnProperty="x" Id="g">${entry(A)}${entry(B)}</Group></Area></SiteMap>`, null],
  ['hasOwnProperty as the last attribute of an entry', navigation(entry(A), `<SubArea GenPageId="${B}" hasOwnProperty="x"/>`), null],
  ['constructor on an entry', navigation(entry(A), `<SubArea constructor="x" GenPageId="${B}"/>`), null],
];

// What can be written between two entries without making a page of anything that is not one: each answers { text, ids } — the ids are those of the entries it holds, which are real. `inGroup` is false where an
// entry would not be navigation (directly under an Area): only text and other elements are written there.
function noise(rand, inGroup = true, close = '</SubArea>') {
  const decoy = entry(D);
  const real = () => {
    const id = [A, B, C][Math.floor(rand() * 3)];
    return { text: spelledEntry(rand, id, close), ids: [id] };
  };
  const nothing = { ids: [] };
  const options = [
    () => ({ text: ' ', ...nothing }),
    () => ({ text: '\r\n\t ', ...nothing }),
    () => ({ text: `<!-- ${decoy} -->`, ...nothing }),
    () => ({ text: `<![CDATA[${decoy}]]>`, ...nothing }),
    () => ({ text: `<?pi ${decoy}?>`, ...nothing }),
    () => ({ text: '<?p <!-- ?><![CDATA[ --> ?> ' + decoy + ' ]]>', ...nothing }),
    () => ({ text: `<?p --> ]]> ${decoy} ?>`, ...nothing }),
    () => ({ text: `<![CDATA[ <?pi <!-- ${decoy} ]]>`, ...nothing }),
    () => ({ text: `<!-- <![CDATA[ <?x ${decoy} ]]> -->`, ...nothing }),
    () => ({ text: '<!---->', ...nothing }),
    () => ({ text: '<![CDATA[]]>', ...nothing }),
    () => ({ text: '<?p?>', ...nothing }),
    () => ({ text: 'text &amp; &#38; &#x26; &lt;SubArea GenPageId=&quot;' + D + '&quot;/&gt; ]] > ', ...nothing }),
    () => ({ text: `<Other>${decoy}</Other>`, ...nothing }),
    () => ({ text: `<SubAreaX GenPageId="${D}"/><subarea GenPageId="${D}"/><SubArea Id="z" genpageid="${D}"/><m:SubArea GenPageId="${D}"/>`, ...nothing }),
    () => ({ text: `<Titles><Title LCID="1033" Title="${D}"/></Titles>`, ...nothing }),
    () => ({ text: `<SubArea Id="n" Entity="account" Title="--> ?> ]]> &lt;!-- &lt;![CDATA[ GenPageId=&quot;${D}&quot;"/>`, ...nothing }),
    () => {
      const inner = real();
      return { text: `<?note <![CDATA[ ?>${inner.text}<?note ]]> ?>`, ids: inner.ids };
    },
    () => {
      const inner = real();
      return { text: `<![CDATA[ <!-- ]]>${inner.text}<![CDATA[ --> ]]>`, ids: inner.ids };
    },
    () => {
      const inner = real();
      return { text: `<!-- a -->${inner.text}<?p b?>`, ids: inner.ids };
    },
    real,
    real,
    real,
  ];
  const usable = inGroup ? options : options.slice(0, options.length - 6);
  return usable[Math.floor(rand() * usable.length)]();
}

// An entry for `id`, spelled the way an XML writer might: attribute order, spacing, quotes, references in the id, a closing tag or a self-closing one. `close` is how its closing tag is written when it has one: the SDK's
// parser misreads a document that writes some closing tags of a name with white space before the ">" and others without (see strict-xml.js), so a document is one or the other.
function spelledEntry(rand, id, close = '</SubArea>') {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const quote = pick(['"', "'"]);
  const spelled = pick([id, id.toUpperCase(), `{${id}}`, id.replace(/^./, (c) => `&#${c.charCodeAt(0)};`), id.replace('-', '&#x2D;'), id.replace(/-/g, '&#45;')]);
  const space = pick([' ', '  ', '\t', '\n', '\r\n']);
  const eq = pick(['=', ' = ', '=\n']);
  const attrs = [`GenPageId${eq}${quote}${spelled}${quote}`, `Id="p_${id.slice(0, 8)}"`, `Title${eq}"${pick(['Page', 'A &amp; B', 'a > b', '--> ?>', ''])}"`];
  if (rand() < 0.5) attrs.reverse();
  if (rand() < 0.3) attrs.push(`Url${eq}'/x?a=1&amp;b=2'`);
  const open = `<SubArea${space}${attrs.join(space)}`;
  return pick([`${open}/>`, `${open} />`, `${open}>${close}`, `${open}><Titles><Title LCID="1033" Title="T"/></Titles>${close}`, `${open}> ${close}`]);
}

// A whole document the generator knows the answer to: its real entries are in the answer, everything else it wrote is text, another element, or not navigation.
function generated(rand) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const ids = new Set();
  const close = pick(['</SubArea>', '</SubArea>', '</SubArea >', '</SubArea\n>']);
  const piece = (inGroup = true) => {
    const n = noise(rand, inGroup, close);
    for (const id of n.ids) ids.add(id);
    return n.text;
  };
  const groups = [];
  for (let g = Math.floor(rand() * 3) + 1; g > 0; g -= 1) {
    const inside = [];
    for (let k = Math.floor(rand() * 5); k > 0; k -= 1) inside.push(piece());
    groups.push(`${piece(false)}<Group Id="g${g}">${inside.join('')}</Group>${piece(false)}`);
  }
  const areas = [`<Area Id="a1">${groups.join('')}</Area>`];
  if (rand() < 0.3) areas.push('<Area Id="a2"/>');
  if (rand() < 0.2) areas.push(`<Area Id="a3"><SubArea Id="stray" GenPageId="${D}"/><Group/></Area>`);
  const prolog = pick(['', '', '\uFEFF', '<?xml version="1.0"?>', '<?xml version="1.0" encoding="utf-8" standalone="no"?>\n', '<!-- c -->', '<?p <!-- ?>', '\n', '\uFEFF<?xml version="1.0" encoding="utf-16"?>\r\n<!-- c -->\r\n']);
  const epilog = pick(['', '', '\n', '<!-- x -->', '<?q --> ?>', ' <!-- end -->\r\n']);
  const root = pick(['<SiteMap>', '<SiteMap xmlns:m="urn:contoso:ext">', '<SiteMap IntroducedVersion="7.0.0.0">', "<SiteMap xml:space='preserve'>", '<SiteMap >']);
  return { xml: `${prolog}${root}${areas.join('')}</SiteMap${pick(['', ' ', '\n'])}>${epilog}`, ids: [...ids].sort() };
}

// The ways a document is damaged: a fragment inserted somewhere, a stretch removed or repeated, a character changed, the text cut short.
const FRAGMENTS = ['<', '>', '/', '=', '"', "'", '&', ';', '-', '--', '-->', '<!--', '<![CDATA[', ']]>', '<?', '?>', '&amp;', '&#x26;', '&bogus;', '&#0;', ' ', '\t', '\r\n', '\u00a0', '\ufeff', '\u0085', '\u2028', '\u0000', '\ud800', ':', 'xmlns="urn:x"', '<!DOCTYPE x>', '<?xml version="1.0"?>', '<SubArea GenPageId="' + B + '"/>', '</SubArea>', '</Group>', '<Group>', '<SiteMap>', '</SiteMap>', 'GenPageId="' + B + '"', ' x="1"', ' x=1', '<![CDATA[ --> ]]>', '<!-- <?x ?> -->', '<?x <!-- ?>', '<x:y/>', '<script xmlns="http://www.w3.org/1999/xhtml">'];
function damaged(rand, xml) {
  let text = xml;
  for (let count = Math.floor(rand() * 3) + 1; count > 0; count -= 1) {
    const at = Math.floor(rand() * (text.length + 1));
    const kind = Math.floor(rand() * 7);
    if (kind <= 2) text = text.slice(0, at) + FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)] + text.slice(at);
    else if (kind === 3) text = text.slice(0, at) + text.slice(at + Math.floor(rand() * 12) + 1);
    else if (kind === 4) text = text.slice(0, at) + text.slice(Math.max(0, at - Math.floor(rand() * 20)), at) + text.slice(at);
    else if (kind === 5) text = text.slice(0, at) + String.fromCharCode(Math.floor(rand() * 128)) + text.slice(at + 1);
    else text = text.slice(0, at + 1);
  }
  return text;
}

// Insertions at tag boundaries only (just before or after a "<" or a ">"), where the structure of a document is made — the places a decoy construct would be put.
function insertedAtBoundary(rand, xml) {
  const boundaries = [];
  for (let i = 0; i < xml.length; i += 1) if (xml[i] === '<') boundaries.push(i); else if (xml[i] === '>') boundaries.push(i + 1);
  let text = xml;
  for (let count = Math.floor(rand() * 2) + 1; count > 0 && boundaries.length; count -= 1) {
    const at = boundaries[Math.floor(rand() * boundaries.length)];
    text = text.slice(0, at) + FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)] + text.slice(at);
  }
  return text;
}

// Documents built from the things the SDK's parser misreads: end tags written with and without white space before the ">" and `</name>` text elsewhere (the parser looks for an element's end as TEXT), namespace declarations
// (an XHTML script or textarea is raw text to it), elements named like them, and references, line ends and odd white space in a page id.
function quirky(rand) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const XHTML = 'http://www.w3.org/1999/xhtml';
  const ends = (name) => pick([`</${name}>`, `</${name} >`, `</${name}\n>`, `</${name}\t>`, `</${name}\r\n>`]);
  const decoyEnd = () => pick(['', '', '<!-- </SubArea> -->', '<!-- </Group> -->', '<![CDATA[ </SubArea> ]]>', '<?p </Group> ?>', '<Titles Title="x"/>', '<Titles Title=\'</Area>\' ></Titles>', '</SubArea', 'text </SubArea>', '<!-- </Area> --><!-- </script> -->']);
  const namespace = () => pick(['', '', ` xmlns="${XHTML}"`, ' xmlns="urn:x"', ' xmlns=""', ` xmlns:h="${XHTML}"`, ' xmlns:m="urn:y"', ` xmlns='${XHTML}'`, ` xmlns="&#104;ttp://www.w3.org/1999/xhtml"`, ` xmlns="${XHTML}/"`]);
  const rawName = () => pick(['script', 'textarea', 'SCRIPT', 'Script', 'h:script', 'style', 'div', 'pre']);
  const rawBody = () => pick(['', 'text', '<![CDATA[ </script> ]]>', '<![CDATA[ </textarea> ]]>', '<!-- </script> -->', '&lt;b&gt;', '<b/>', `<SubArea GenPageId="${B}"/>`, `<![CDATA[ </script> ]]><SubArea GenPageId="${B}"/>`]);
  const raw = () => {
    const name = rawName();
    return pick([`<${name}${namespace()}>${rawBody()}${pick([`</${name}>`, `</${name} >`])}`, `<${name}${namespace()}/>`]);
  };
  const entryOf = (id) => {
    const quote = pick(['"', "'"]);
    const spelled = pick([id, id.toUpperCase(), `{${id}}`, id.replace('-', '&#45;'), `&#x31;${id.slice(1)}`, ` ${id}`, `${id}\n`, id.replace(/^./, '&#x0031;')]);
    const open = `<SubArea${pick([' ', '\n', '\t', '\r', '\r\n', '\u0085', '\u2028'])}GenPageId=${quote}${spelled}${quote}`;
    return pick([`${open}/>`, `${open}>${ends('SubArea')}`]);
  };
  const eol = pick(['\n', '\r\n', '\r']);
  const parts = [];
  for (let k = Math.floor(rand() * 4); k >= 0; k -= 1) parts.push(pick([() => entryOf(A), () => entryOf(B), raw, decoyEnd, () => `<Titles>${entryOf(B)}</Titles>`])());
  const xml = `${pick(['', '\uFEFF', `<?xml version="1.0"?>${eol}`])}<SiteMap${namespace()}>${eol}<Area${namespace()}><Group${namespace()}>${parts.join(pick(['', eol, ' ']))}${ends('Group')}${decoyEnd()}${ends('Area')}${ends('SiteMap')}${pick(['', eol, '<!-- e -->'])}`;
  return rand() < 0.3 ? damaged(rand, xml) : xml;
}

// ── The checks ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const show = (xml) => JSON.stringify(xml.length > 300 ? `${xml.slice(0, 300)}…` : xml);

// Holds one document to the two rules; returns what is wrong with it, or nothing. `sdk` is what the SDK's reader made of it (parsed once).
function judge(xml, sdk = sdkReads(xml)) {
  const mine = readable(xml);
  if (mine && !sdk.ok) return `read here as [${mine}] but the SDK's reader refuses it (${sdk.why}): ${show(xml)}`;
  if (mine && JSON.stringify(mine) !== JSON.stringify(sdk.ids)) return `read here as [${mine}] but the SDK's reader finds [${sdk.ids}] under SiteMap/Area/Group: ${show(xml)}`;
  if (mine && mine.some((id) => !sdk.any.includes(id))) return `read here as [${mine}], which is not among what the SDK retains [${sdk.any}]: ${show(xml)}`;
  return null;
}

function assertNone(problems, what) {
  assert.strictEqual(problems.length, 0, `${what}: ${problems.length} document(s) disagree. The first:\n${problems.slice(0, 5).join('\n')}`);
}

test('ORACLE: the fixed documents — ones that were once misread, what the platform writes, and the ways a document stops being one — read as the answer says, and agree with the SDK\'s reader', () => {
  const problems = [];
  const seen = { readable: 0, unreadable: 0 };
  for (const [name, xml, answer] of FIXED) {
    const ids = readable(xml);
    if (answer === null ? ids !== null : JSON.stringify(ids) !== JSON.stringify(answer)) problems.push(`${name}: expected ${answer === null ? 'unreadable' : `[${answer}]`}, got ${ids === null ? 'unreadable' : `[${ids}]`}: ${show(xml)}`);
    const wrong = judge(xml);
    if (wrong) problems.push(`${name}: ${wrong}`);
    seen[ids === null ? 'unreadable' : 'readable'] += 1;
  }
  assertNone(problems, 'the fixed corpus');
  assert.ok(seen.readable >= 33 && seen.unreadable >= 45, `the fixed corpus has both kinds of document: ${JSON.stringify(seen)}`);
});

test('ORACLE: generated documents whose answer is known — every real entry is found and every decoy (comments, CDATA, PIs, attribute values, other elements, interleaved markers) is not, and the SDK\'s reader agrees', () => {
  const rand = seeded(20260714);
  const problems = [];
  let withDecoys = 0;
  for (let i = 0; i < GENERATED / 4; i += 1) {
    const { xml, ids } = generated(rand);
    const got = readable(xml);
    if (JSON.stringify(got) !== JSON.stringify(ids)) problems.push(`expected [${ids}], got ${got === null ? 'unreadable' : `[${got}]`}: ${show(xml)}`);
    const wrong = judge(xml);
    if (wrong) problems.push(wrong);
    if (/<!--|<!\[CDATA\[|<\?pi/.test(xml)) withDecoys += 1;
  }
  assertNone(problems, 'generated documents with a known answer');
  assert.ok(withDecoys > GENERATED / 8, `most documents hold a comment, a CDATA section or a PI: ${withDecoys}`);
});

test('ORACLE: damaged documents — a fragment inserted anywhere, a stretch removed or repeated, a character changed, a text cut short — are read only where the SDK\'s reader reads them the same, and are unreadable wherever it refuses', () => {
  const rand = seeded(7);
  const problems = [];
  const seen = { readable: 0, unreadable: 0, sdkRefused: 0 };
  const bases = FIXED.filter(([, , answer]) => answer !== null).map(([, xml]) => xml);
  for (let i = 0; i < GENERATED; i += 1) {
    const base = i % 3 === 0 ? generated(rand).xml : bases[Math.floor(rand() * bases.length)];
    const xml = i % 2 === 0 ? damaged(rand, base) : insertedAtBoundary(rand, base);
    const sdk = sdkReads(xml);
    const wrong = judge(xml, sdk);
    if (wrong) problems.push(wrong);
    seen[readable(xml) === null ? 'unreadable' : 'readable'] += 1;
    if (!sdk.ok) seen.sdkRefused += 1;
  }
  assertNone(problems, 'damaged documents');
  // A corpus that damages nothing, or that damages everything, would hold the reader to nothing.
  assert.ok(seen.readable > GENERATED / 20, `many damaged documents are still readable: ${JSON.stringify(seen)}`);
  assert.ok(seen.unreadable > GENERATED / 3, `many are not: ${JSON.stringify(seen)}`);
  assert.ok(seen.sdkRefused > GENERATED / 10, `and the SDK's reader refuses many of them, each of which must be unreadable here: ${JSON.stringify(seen)}`);
});

test('ORACLE: documents built from what the SDK\'s parser misreads — end tags with and without white space and `</name>` text in comments, CDATA and PIs, namespace declarations, script and textarea elements, odd white space and references in a page id — agree with the SDK\'s reader', () => {
  const rand = seeded(99);
  const problems = [];
  const seen = { readable: 0, unreadable: 0, sdkRefused: 0 };
  for (let i = 0; i < GENERATED / 2; i += 1) {
    const xml = quirky(rand);
    const sdk = sdkReads(xml);
    const wrong = judge(xml, sdk);
    if (wrong) problems.push(wrong);
    seen[readable(xml) === null ? 'unreadable' : 'readable'] += 1;
    if (!sdk.ok) seen.sdkRefused += 1;
  }
  assertNone(problems, 'quirk documents');
  assert.ok(seen.readable > GENERATED / 40 && seen.unreadable > GENERATED / 40, `both kinds: ${JSON.stringify(seen)}`);
  assert.ok(seen.sdkRefused > GENERATED / 200, `the SDK's reader refuses some of them: ${JSON.stringify(seen)}`);
});

test('ORACLE: an attribute named like a member of Object.prototype, on any element and in any position, makes the document unreadable — and the documents xmldom cannot read are among them', () => {
  const names = Object.getOwnPropertyNames(Object.prototype);
  assert.ok(names.includes('hasOwnProperty') && names.includes('__proto__'), `the members this test is about: ${names.join(', ')}`);
  const problems = [];
  let sdkRefused = 0;
  let documents = 0;
  for (const name of names) {
    const odd = `${name}="x"`;
    for (const xml of [
      navigation(entry(A), `<SubArea ${odd} GenPageId="${B}"/>`),
      navigation(entry(A), `<SubArea GenPageId="${B}" ${odd}/>`),
      `<SiteMap><Area Id="a"><Group ${odd} Id="g">${entry(A)}${entry(B)}</Group></Area></SiteMap>`,
      `<SiteMap><Area Id="a"><Group Id="g" ${odd}>${entry(A)}${entry(B)}</Group></Area></SiteMap>`,
      `<SiteMap><Area ${odd} Id="a"><Group Id="g">${entry(A)}</Group></Area></SiteMap>`,
      `<SiteMap ${odd} Id="m"><Area Id="a"><Group Id="g">${entry(A)}</Group></Area></SiteMap>`,
      navigation(entry(A), `<Titles><Title ${odd} LCID="1033" Title="x"/></Titles>`),
    ]) {
      documents += 1;
      const ids = readable(xml);
      if (ids !== null) problems.push(`read as [${ids}] although it has an attribute named ${name}: ${show(xml)}`);
      const sdk = sdkReads(xml);
      if (!sdk.ok) sdkRefused += 1;
      const wrong = judge(xml, sdk);
      if (wrong) problems.push(wrong);
    }
  }
  assertNone(problems, 'documents with an Object.prototype attribute name');
  // hasOwnProperty followed by another attribute is what xmldom cannot read: the corpus holds such documents, so the rule above is held to them.
  assert.ok(sdkRefused >= 2, `the SDK's reader refuses some of these ${documents} documents: ${sdkRefused}`);
});
