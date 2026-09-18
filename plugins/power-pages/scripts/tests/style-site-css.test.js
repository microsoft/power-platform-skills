'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeStyle, styleProperties, validateStylesheetOrder } = require('../lib/style-site-css');
const { cssTree } = require('../vendor/css-tools/css-tools.cjs');

const component = { className: 'pp-card' };
const analyze = (style, target = component) => analyzeStyle(style, target);
const sheet = (css, options = {}) => analyze({ css, ...options });
const rootProperties = (result) => result.rootDeclarations.flatMap(Object.keys);

test('uses the pinned offline bundle and compiles general declarations in author order', () => {
  assert.equal(cssTree.version, '3.2.1');
  const declarations = {
    margin: '2rem',
    'margin-inline-start': 'calc(-1 * 2vw)',
    '--Brand': '#123456',
    '--brand': '#654321',
    'font-family': '"Contoso Sans", "Maker\'s Sans", system-ui, sans-serif',
    'box-shadow': 'inset 0 1px 2px #0002, 0 9px 31px rgb(0 0 0 / 23%)',
    display: 'grid',
    'grid-template-columns': 'repeat(auto-fit, minmax(min(100%, 18rem), 1fr))',
    gap: 'clamp(.5rem, 2vw, 2rem)',
    'min-block-size': '50dvh',
    'max-inline-size': 'calc(100svw - 2rem)',
    'padding-block': '.25rem 1.125rem',
    'aspect-ratio': '3 / 2',
    'flex-flow': 'row wrap',
    'flex-basis': 'min(30ch, 100%)',
    'place-content': 'space-between center',
    'object-fit': 'cover',
    'object-position': '40% 20%',
    'scroll-margin-block-start': '5rem',
    'overscroll-behavior': 'contain',
    'scroll-behavior': 'smooth',
    'writing-mode': 'vertical-rl',
    transform: 'translateY(-.5rem) rotate(2deg) scale(.95)',
    transition: 'transform 240ms ease, opacity 200ms linear',
    'text-wrap': 'balance',
    color: 'oklch(35% .15 250)',
    'border-color': 'color-mix(in oklch, var(--Brand, #345), white 20%)',
    'background-color': 'light-dark(rgb(250 250 250), color(display-p3 .1 .2 .3))',
    'background-image': 'repeating-conic-gradient(from 45deg, #123 0deg 20deg, #456 20deg 40deg)',
    background: 'url("/tiles.svg?x=1&y=2") left top / 2rem 2rem repeat, linear-gradient(45deg, #123, #456) center / cover no-repeat #fff',
    '-webkit-line-clamp': '3',
    '-vendor-future-property': 'future-layout(10cqw, 2lvh)',
  };
  const result = analyze({ declarations });
  assert.equal(result.css, `.pp-card {\n${Object.entries(declarations).map(([name, value]) => `  ${name}: ${value};`).join('\n')}\n}`);
  assert.deepEqual(result.properties, Object.keys(declarations));
  assert.deepEqual(rootProperties(result), Object.keys(declarations));
  assert.match(result.warnings.join('\n'), /browser support before approval/);
  assert.doesNotMatch(result.warnings.join('\n'), /not supported by Power Pages|not allowed in Studio/);
});

test('ordinary properties are canonicalized while custom-property case and token text survive', () => {
  const declarations = {
    COLOR: 'r\\65 d',
    '--Brand': '  { color: red; spacing: [1rem 2rem]; }  ',
    '--brand': '',
    '--fallback': 'var(--Unknown, "quoted; fallback", rgb(1 2 3 / .5))',
    content: '"A & B; it\\\'s CSS" /* keep this comment */',
  };
  const result = analyze({ declarations });
  assert.deepEqual(result.properties, ['color', '--Brand', '--brand', '--fallback', 'content']);
  assert.ok(result.css.includes('color: r\\65 d;'));
  assert.ok(result.css.includes('--Brand: { color: red; spacing: [1rem 2rem]; };'));
  assert.ok(result.css.includes('--brand: ;'));
  assert.ok(result.css.includes(declarations.content));
  assert.throws(() => analyze({ declarations: { COLOR: 'red', color: 'blue' } }), /Duplicate canonical/);
});

test('canonical property names cannot inject delimiters back into emitted CSS', () => {
  const result = analyze({ declarations: { '--Token\\3b Part': 'red', 'c\\6f lor': 'blue' } });
  assert.deepEqual(result.properties, ['--Token;Part', 'color']);
  assert.equal(cssTree.parse(result.css).children.toArray()[0].block.children.size, 2);
  assert.ok(result.css.includes('--Token\\;Part: red;'));
  assert.deepEqual(result.rootDeclarations, [{ '--Token\\;Part': 'red' }, { color: 'blue' }]);
});

test('value formatting preserves escaped trailing whitespace instead of escaping emitted delimiters', () => {
  const result = analyze({ declarations: { '--Token': 'red\\ ', color: 'blue' } });
  assert.ok(result.css.includes('--Token: red\\ ;\n  color: blue;'));
  assert.deepEqual(result.rootDeclarations, [{ '--Token': 'red\\ ' }, { color: 'blue' }]);
  const block = cssTree.parse(result.css).children.toArray()[0].block.children.toArray();
  assert.deepEqual(block.map((node) => node.property), ['--Token', 'color']);
  assert.equal(cssTree.ident.decode(cssTree.parse('red\\ ', { context: 'value' }).children.toArray()[0].name), 'red ');
});

test('inline and Studio declarations do not need a class or depend on Studio property membership', () => {
  const declarations = { display: 'grid', 'box-shadow': '0 1px 2px #1234', '--Brand': 'red' };
  for (const mode of [{ location: 'inline' }, { owner: 'studio' }]) {
    const result = analyze({ declarations, ...mode }, {});
    assert.deepEqual(result.properties, Object.keys(declarations));
    if (mode.owner === 'studio') assert.equal(result.css, '');
    else assert.ok(result.css.includes('display: grid;'));
  }
  assert.deepEqual(analyze({ location: 'inline', declarations: { opacity: null } }, {}).properties, ['opacity']);
  assert.deepEqual(analyze({ location: 'inline', declarations: { opacity: null } }, {}).rootDeclarations, []);
  assert.throws(() => analyze({ declarations: { opacity: null } }), /inline-only/);
  assert.throws(() => analyze({ owner: 'studio', declarations: { opacity: null } }), /inline-only/);
});

test('Studio descriptor parts validate scoped syntax without requiring a source hook or producing local CSS', () => {
  for (const target of [{}, component]) {
    for (const part of [' .btn', ' h2', ' > .btn:is(:hover, :focus-visible)', ':focus-within']) {
      const style = { owner: 'studio', part, declarations: { color: 'red', 'box-shadow': '0 1px 2px #1234' } };
      const result = analyze(style, target);
      assert.deepEqual(result.properties, ['color', 'box-shadow']);
      assert.deepEqual(styleProperties(style), result.properties);
      assert.equal(result.css, '');
      assert.deepEqual(result.rootDeclarations, []);
    }
  }
  for (const part of [' .btn, body', ' + body', ' h2 { color:red; }']) {
    assert.throws(() => analyze({ owner: 'studio', part, declarations: { color: 'red' } }, {}), /CSS validation/);
  }
  assert.throws(() => analyze({ location: 'inline', part: ' .btn', declarations: { color: 'red' } }, {}), /Inline declarations cannot/);
});

test('inline null removals retain validated property names but never become CSS literal values', () => {
  const removeOnly = { location: 'inline', declarations: { COLOR: null, '--Brand': null } };
  const removed = analyze(removeOnly, {});
  assert.deepEqual(removed.properties, ['color', '--Brand']);
  assert.deepEqual(styleProperties(removeOnly), removed.properties);
  assert.equal(removed.css, '');
  assert.deepEqual(removed.rootDeclarations, []);

  const mixed = { location: 'inline', declarations: { color: null, '--literal': 'null', opacity: '.8' } };
  assert.deepEqual(analyze(mixed, {}).properties, ['color', '--literal', 'opacity']);
  assert.deepEqual(styleProperties(mixed), ['color', '--literal', 'opacity']);
  assert.equal(analyze(mixed, {}).css, '--literal: null;\nopacity: .8;');
  assert.throws(() => analyze({ location: 'inline', declarations: { 'color;display': null } }, {}), /Invalid declaration property/);
  assert.throws(() => styleProperties({ location: 'inline', declarations: { COLOR: null, color: 'red' } }), /Duplicate canonical/);
  for (const style of [
    { declarations: { color: null } },
    { location: 'stylesheet', declarations: { color: null } },
    { owner: 'studio', declarations: { color: null } },
    { owner: 'studio', location: 'inline', declarations: { color: null } },
  ]) {
    assert.throws(() => analyze(style), /inline-only/);
    assert.throws(() => styleProperties(style), /inline-only/);
  }
});

test('enforces the style input contract and bounded plain declaration objects', () => {
  const invalid = [
    {}, { declarations: {}, css: '.pp-card{}' }, { declarations: [] },
    { declarations: {} }, { declarations: new Date() },
    { declarations: { color: 12 } }, { declarations: { color: '' } },
    { declarations: { 'color;display': 'red' } }, { declarations: { '--': 'red' } },
    { declarations: { color: 'red' }, global: false },
    { declarations: { color: 'red' }, part: 12 },
    { location: 'inline', declarations: { color: 'red' }, part: ':hover' },
    { css: '' }, { css: ' /* comment only */ ' }, { css: '.pp-card{}', part: '' },
    { css: '.pp-card{}', location: 'inline' }, { css: '.pp-card{}', owner: 'studio' },
    { css: '.pp-card{}', global: 'true' }, { css: '.pp-card{}', global: null },
    { declarations: { color: 'red' }, importantReason: '' },
    { css: `.pp-card { content: "${'a'.repeat(128 * 1024)}"; }` },
    { declarations: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`--prop${index}`, '1'])) },
  ];
  for (const style of invalid) assert.throws(() => analyze(style), /CSS validation/);
  assert.doesNotThrow(() => analyze({ declarations: Object.assign(Object.create(null), { color: 'red' }) }));
  assert.throws(() => analyze({ declarations: {} }), /1-100 properties/);
  assert.throws(() => analyze({ declarations: { color: 'red' } }, {}), /className/);
  assert.throws(() => analyze({ declarations: { color: 'red' } }, { className: 'pp-card,body' }), /identifier|className/);
});

test('preserves raw stylesheet bytes apart from outer trim, including compact nested braces', () => {
  const css = '\r\n/* author comment */\r\n@media (width >= 48rem){.pp-card{padding:3%;--Brand:oklch(40% .2 200)}}\r\n';
  const result = sheet(css);
  assert.equal(result.css, css.trim());
  assert.deepEqual(result.properties, ['padding', '--Brand']);
  assert.deepEqual(rootProperties(result), ['padding', '--Brand']);
  assert.match(result.warnings.join('\n'), /conditional/);
});

test('accepts positively scoped descendant, state, ancestor and pseudo-element selectors', () => {
  const selectors = [
    '.pp-card',
    'main[data-mode="compact"] .pp-card:hover',
    '.pp-card > h2 + p',
    '.pp-card .child ~ .following',
    '.pp-card > .btn:is(:hover, :focus-visible)',
    '.pp-card:where([aria-expanded="true"], :focus-within)',
    ':is(.pp-card, .pp-card > h2)',
    ':where(main .pp-card, .pp-card:focus) > .btn::before',
    '.pp-card:not(.disabled):has(> h2)',
    '.pp-card > :nth-child(2n of .item)',
    '.pp-card::after',
    '.pp-card:before',
    '.pp\\2d card .child',
    ':is(.pp-card > h2, .pp-card > p) + .other',
  ];
  for (const selector of selectors) {
    assert.doesNotThrow(() => sheet(`${selector} { color: red; }`), selector);
  }
  assert.doesNotThrow(() => analyze({ part: ' > .btn:focus-visible::before', declarations: { content: '"Next"' } }));
  for (const part of [' .btn, body', ' + body', ' ~ .other', ');body{color:red}']) {
    assert.throws(() => analyze({ part, declarations: { color: 'red' } }), /CSS validation/);
  }
});

test('rejects scope escapes in every selector-list and positive-function branch', () => {
  const selectors = [
    'body', '.pp-cardish', '[class="pp-card"]',
    '.pp-card, body', '.pp-card > h2, .outside',
    ':not(.pp-card)', ':not(:not(.pp-card))', ':has(.pp-card)',
    '.outside:has(> .pp-card)', 'body:has(.pp-card) h1',
    ':is(.pp-card, body)', ':where(.pp-card, .outside)',
    ':is(.pp-card, :not(.pp-card))',
    '.pp-card + body', '.pp-card ~ .other .child', '.pp-card:hover + *',
    ':is(.pp-card + .outside, .pp-card)',
    ':where(.pp-card, .pp-card .child) ~ .outside',
    '.pp-card || td',
  ];
  for (const selector of selectors) {
    assert.throws(() => sheet(`${selector} { color:red; }`), /CSS validation/, selector);
  }
});

test('extracts only direct root/root-state declarations, never ordinary descendants or pseudo-elements', () => {
  const result = sheet(`
    .pp-card { color: red; }
    body .pp-card:hover { opacity: .9; }
    .pp-card > h2 { font-size: 2rem; }
    .pp-card .child { padding: 1rem; }
    .pp-card::before { content: "Before"; }
    .pp-card:after { margin: 1rem; }
    :is(.pp-card:focus, .pp-card > .child) { outline: 2px solid; }
    :where(.pp-card > h2, .pp-card > p) { line-height: 1.5; }
    @supports (display: grid) { .pp-card { display: grid; } }
  `);
  assert.deepEqual(rootProperties(result), ['color', 'opacity', 'outline', 'display']);
  assert.ok(result.properties.includes('font-size'));
  assert.ok(result.properties.includes('content'));
  assert.match(result.warnings.join('\n'), /not establish which rule wins/);
});

test('retains duplicate root declarations and their priorities for conservative cascade checks', () => {
  const result = sheet('.pp-card{color:red !important;color:blue;opacity:.9}', { importantReason: 'Approved cascade correction.' });
  assert.deepEqual(result.rootDeclarations, [{ color: 'red !important' }, { color: 'blue' }, { opacity: '.9' }]);
});

test('supports CSS nesting without allowing sibling or positive-function escape', () => {
  const css = `.pp-card {
    color: red;
    &:hover { opacity: .9; }
    .child, > .other { padding: 1rem; }
    :is(&, &:focus) { outline: 1px solid; }
    @media (width >= 48rem) { display: grid; }
    & .child { & + .following { gap: 1rem; } }
  }`;
  const result = sheet(css);
  assert.equal(result.css, css);
  assert.deepEqual(rootProperties(result), ['color', 'opacity', 'outline', 'display']);
  for (const child of ['& + body', '+ body', '& ~ .outside', ':is(&, body)', ':where(& + body)', '.child, + body']) {
    assert.throws(() => sheet(`.pp-card { ${child} { color:red; } }`), /CSS validation/, child);
  }
});

test('@scope can establish a real subtree boundary, with conservative implicit root matching', () => {
  const result = sheet('@scope (.pp-card) to (.boundary) { :scope { color:red } :scope > h2 {font-size:2rem} h3 {opacity:.8} }');
  assert.deepEqual(rootProperties(result), ['color', 'opacity']);
  assert.match(result.warnings.join('\n'), /conservative/);
  assert.doesNotThrow(() => sheet('@scope (.theme) { .pp-card { color:red; } }'));
  assert.throws(() => sheet('@scope (.theme) { body { color:red; } }'), /subtree/);
  assert.throws(() => sheet('@scope (:not(.pp-card)) { h2 { color:red; } }'), /subtree/);
});

test('supports responsive rules, layers, registrations, local fonts and reduced-motion keyframes', () => {
  const css = `
    @font-face { font-family: "pp-brand"; src: url(/brand.woff2) format("woff2"); font-display: swap; }
    @property --pp-angle { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
    @layer pp-components {
      @layer responsive {
        .pp-card { animation: pp-enter 180ms ease both; container-type: inline-size; }
        @media (width >= 48rem) { .pp-card { display: grid; } }
        @supports (color: oklch(50% .2 250)) { .pp-card > h2 { color: oklch(35% .15 250); } }
        @container pp-side (min-width: 30rem) { .pp-card > h2 { max-inline-size: 25ch; } }
      }
    }
    @keyframes pp-enter {
      from { opacity: 0; transform: translateY(1rem); }
      to { opacity: 1; transform: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .pp-card { animation: none; }
      .pp-card > .btn { transition: none; }
    }
  `;
  const result = sheet(css);
  assert.equal(result.css, css.trim());
  assert.ok(result.properties.includes('src'));
  assert.ok(result.properties.includes('initial-value'));
  assert.ok(result.properties.includes('max-inline-size'));
  assert.ok(result.properties.includes('opacity'));
  assert.ok(result.properties.includes('transform'));
  assert.ok(!rootProperties(result).includes('opacity'));
  assert.ok(!rootProperties(result).includes('transform'));
  assert.ok(!rootProperties(result).includes('font-family'));
  assert.ok(!rootProperties(result).includes('initial-value'));
  assert.match(result.warnings.join('\n'), /Keyframe declarations .* are not ordinary root stylesheet rules/);
  assert.doesNotThrow(() => sheet('@keyframes pp-scroll {entry 0% {opacity:0} entry 100% {opacity:1}}'));
  assert.doesNotThrow(() => sheet('@layer { .pp-card {color:red} }'));
});

test('layers remain authorable while warning about unlayered Power Pages cascade precedence', () => {
  for (const css of [
    '@layer pp-components;',
    '@layer pp-components { .pp-card.pp-card:hover {color:red} }',
    '@layer { .pp-card {color:red} }',
  ]) {
    const result = sheet(css);
    assert.equal(result.css, css);
    assert.match(result.warnings.join('\n'), /Normal declarations in @layer lose to unlayered Power Pages\/default\/theme rules.*regardless of selector specificity/);
  }
});

test('keyframes do not invent ordinary root conflicts with normal inline styles or descendant animations', () => {
  const keyframes = '@keyframes pp-enter { from { opacity:0; transform:translateY(1rem); } to { opacity:1; transform:none; } }';
  for (const selector of ['.pp-card', '.pp-card > .child']) {
    const result = sheet(`${keyframes} ${selector} { animation:pp-enter 180ms ease both; } .pp-card:hover { opacity:.8; }`);
    assert.deepEqual(result.rootDeclarations, [
      ...(selector === '.pp-card' ? [{ animation: 'pp-enter 180ms ease both' }] : []),
      { opacity: '.8' },
    ]);
    assert.ok(result.properties.includes('transform'));
    assert.match(result.warnings.join('\n'), /animations outrank normal inline declarations/);
    assert.match(result.warnings.join('\n'), /!important declarations can override animations/);
    assert.match(result.warnings.join('\n'), /targets may be the root or descendants/);
  }
  assert.deepEqual(sheet(keyframes).rootDeclarations, []);
  const priority = sheet('@keyframes pp-enter {from {opacity:0 !important} to {opacity:1}}', {
    importantReason: 'Review the authored priority rather than treating it as an effective root rule.',
  });
  assert.deepEqual(priority.rootDeclarations, []);
  assert.match(priority.warnings.join('\n'), /!important inside @keyframes are ignored/);
  assert.doesNotMatch(priority.warnings.join('\n'), /Authored !important changes cascade priority/);
});

test('global definitions require namespaced names or explicit global review', () => {
  const definitions = [
    '@keyframes entrance {from {opacity:0} to {opacity:1}}',
    '@font-face {font-family:"Contoso Sans";src:url(/font.woff2)}',
    '@property --brand {syntax:"<color>";inherits:true;initial-value:red}',
    '@layer site-theme {.pp-card {color:red}}',
    '@layer first, pp-second;',
    '@counter-style list-marker {system:cyclic;symbols:"*";suffix:" "}',
    '@position-try --fallback {position-area:top}',
  ];
  for (const css of definitions) {
    assert.throws(() => sheet(css), /global:true/);
    const result = sheet(css, { global: true });
    assert.match(result.warnings.join('\n'), /stylesheet-wide effects/);
  }
  assert.doesNotThrow(() => sheet('@counter-style pp-list {system:cyclic;symbols:"*";suffix:" "}'));
  assert.doesNotThrow(() => sheet('@position-try --pp-fallback {position-area:top}'));
  assert.doesNotThrow(() => sheet('@font-feature-values pp-font, "pp-second" {@styleset {custom-style:1}}'));
  assert.throws(() => sheet('@font-feature-values pp-font, "Other Font" {@styleset {custom-style:1}}'), /global:true/);
});

test('intentional global themes need no fictional component hook and do not certify inline ownership', () => {
  const css = ':root { --pp-brand:#123456; color-scheme:light; } body {font-family:"Contoso Sans",sans-serif} h1,h2 {color:var(--pp-brand)}';
  const result = analyze({ css, global: true }, {});
  assert.equal(result.css, css);
  assert.deepEqual(result.rootDeclarations, []);
  assert.match(result.warnings.join('\n'), /no addressable component root/);
  assert.deepEqual(rootProperties(sheet('body .other {color:red} .pp-card > h2 {font-size:2rem}', { global: true })), ['color']);
});

test('unknown and mismatched grammar warn, not masquerade as an authoring permission gate', () => {
  const result = sheet(`
    @future-group feature-name { .pp-card { future-layout: new-layout(10cqw); color: definitively-not-a-color; } }
    .pp-card:future-state(.something) { text-box: trim-both cap alphabetic; width: var(--w, 20rem); }
  `);
  assert.ok(result.properties.includes('future-layout'));
  assert.match(result.warnings.join('\n'), /does not recognize/);
  assert.match(result.warnings.join('\n'), /could not verify/);
  assert.match(result.warnings.join('\n'), /Correct a typo or establish actual browser support/);
  assert.match(result.warnings.join('\n'), /Selector arguments/);
  assert.doesNotThrow(() => sheet('@starting-style {.pp-card{opacity:0}}'));
  assert.match(sheet('@media {.pp-card{color:red}}').warnings.join('\n'), /@media prelude/);
  assert.throws(() => sheet('@future-group x {body{color:red}}'), /subtree/);
  assert.throws(() => sheet('@future-definition x {size:1rem}'), /global:true/);
  assert.doesNotThrow(() => sheet('@future-definition x {size:1rem}', { global: true }));
});

test('structural value parsing accepts conditional and unfamiliar function grammars without feature exceptions', () => {
  const conditional = 'if(style(--scheme: dark): white; else: black)';
  const result = analyzeStyle({ owner: 'custom', declarations: { color: conditional } }, { className: 'pp-check' });
  assert.equal(result.css, `.pp-check {\n  color: ${conditional};\n}`);
  assert.deepEqual(result.rootDeclarations, [{ color: conditional }]);
  assert.deepEqual(result.properties, ['color']);
  assert.match(result.warnings.join('\n'), /Bundled CSS grammar could not verify property\/value "color"/);
  assert.doesNotMatch(result.warnings.join('\n'), /Malformed CSS/);

  const unfamiliar = 'future-paint(mode: dark; payload: {tone: white;}; fallback: black)';
  for (const value of [conditional, unfamiliar]) {
    const inline = { location: 'inline', declarations: { color: value } };
    assert.equal(analyze(inline, {}).css, `color: ${value};`);
    assert.deepEqual(styleProperties(inline), ['color']);
    assert.match(analyze(inline, {}).warnings.join('\n'), /could not verify/);
  }
  assert.throws(() => analyze({ declarations: { color: `${conditional} !important` } }), /importantReason/);
  const priority = analyze({ declarations: { color: `${conditional} !important` }, importantReason: 'Explicitly reviewed conditional priority.' });
  assert.deepEqual(priority.rootDeclarations, [{ color: `${conditional} !important` }]);
  assert.match(priority.warnings.join('\n'), /Authored !important/);
});

test('raw stylesheet conditional values preserve text, scope and literal local URL branches', () => {
  const conditional = 'if(style(--scheme: dark): white; else: black)';
  const image = 'if(style(--scheme: dark): url("/dark.svg"); else: url("../assets/light.svg"))';
  const css = `.pp-card { color: ${conditional}; background-image: ${image}; }
    @media (width > 40rem) { .pp-card:hover { opacity: if(style(--active: true): .8; else: 1); } }
    .pp-card > h2 { text-decoration-color: ${conditional}; }`;
  const result = sheet(css);
  assert.equal(result.css, css);
  assert.deepEqual(result.properties, ['color', 'background-image', 'opacity', 'text-decoration-color']);
  assert.deepEqual(styleProperties({ css }), result.properties);
  assert.deepEqual(rootProperties(result), ['color', 'background-image', 'opacity']);
  assert.match(result.warnings.join('\n'), /could not verify/);
  assert.doesNotMatch(result.warnings.join('\n'), /External resource/);
  assert.equal(validateStylesheetOrder(css), true);
  const inlineImage = analyze({ location: 'inline', declarations: { 'background-image': image } }, {});
  assert.equal(inlineImage.css, `background-image: ${image};`);
  assert.throws(() => sheet(`.pp-card, body { color: ${conditional}; }`), /subtree/);
});

test('all external URL branches of unmodeled values require exact consent and loading warnings', () => {
  const url = 'https://assets.example.com/conditional.svg';
  const branches = [
    `url("${url}")`,
    'u\\72l("h\\74 tps://assets.example.com/conditional.svg")',
    `image-set("${url}" 1x)`,
    `future-image("${url}")`,
  ];
  for (const branch of branches) {
    const value = `if(style(--scheme: dark): url(/local.svg); else: ${branch})`;
    const styles = [{ declarations: { 'background-image': value } }, { css: `.pp-card { background-image: ${value}; }` }];
    for (const style of styles) {
      assert.throws(() => analyze(style), /EXACT match/);
      assert.throws(() => analyze({ ...style, externalResources: [`${url}?different=1`] }), /EXACT match/);
      const result = analyze({ ...style, externalResources: [url] });
      assert.match(result.warnings.join('\n'), /could not verify/);
      assert.match(result.warnings.join('\n'), /may load in the browser/);
      assert.ok(result.warnings.some((warning) => warning.includes(url)));
    }
  }
});

test('Raw value grammar cannot hide executable functions, property tokens or unsafe resource branches', () => {
  for (const branch of [
    'expression(1)',
    'e\\78pression(1)',
    'exp/**/ression(1)',
    'future(style(be\\68 avior: url(/legacy.htc)): red; else: blue)',
    'future({-moz-\\62 inding: url(/legacy.xml);})',
    'url(javascript:blocked)',
    'u\\72l("java\\73 cript:blocked")',
    'url("vbscript:blocked")',
    'url("file:///blocked.svg")',
    'url("data:image/svg+xml,blocked")',
    'url(//assets.example.com/blocked.svg)',
    'u\\72l(var(--asset))',
    'future-image("data:image/svg+xml,blocked")',
  ]) {
    const value = `if(style(--scheme: dark): ${branch}; else: none)`;
    assert.throws(() => analyze({ declarations: { 'background-image': value } }), /CSS validation/);
    assert.throws(() => sheet(`.pp-card { background-image: ${value}; }`), /CSS validation/);
  }
});

test('Raw values retain strict delimiter termination and standalone declaration boundaries', () => {
  const conditional = 'if(style(--scheme: dark): white; else: black)';
  for (const value of [
    `${conditional}; display:none`,
    `${conditional};} body {display:none`,
    `${conditional} !important; color:red`,
    'if(style(--scheme: dark): white; else: black',
    'if(style(--scheme: dark): [white); else: black)',
    'if(style(--scheme: dark): url("unterminated); else: none)',
    `${conditional} /*/`,
    `${conditional}\\`,
  ]) assert.throws(() => analyze({ declarations: { color: value } }), /CSS validation/);
  for (const value of [
    'if(style(--scheme: dark): white; else: black',
    'if(style(--scheme: dark): [white); else: black)',
    'if(style(--scheme: dark): "unfinished; else: black)',
  ]) assert.throws(() => sheet(`.pp-card { color: ${value}; }`), /CSS validation/);
  assert.throws(() => analyze({ declarations: { color: '/* no value */' } }), /Empty CSS declaration/);
});

test('grammar-only mismatches warn while remaining one structurally bounded declaration', () => {
  // A colon inside a value is not a declaration boundary in CSS Syntax. The
  // missing-semicolon-looking value is invalid for color, but rejecting it as
  // structurally malformed would also reject future grammars using these tokens.
  for (const style of [
    { declarations: { color: 'red background:blue' } },
    { css: '.pp-card { color:red background:blue; }' },
  ]) {
    const result = analyze(style);
    assert.deepEqual(result.properties, ['color']);
    assert.deepEqual(result.rootDeclarations, [{ color: 'red background:blue' }]);
    assert.match(result.warnings.join('\n'), /could not verify property\/value "color"/);
  }
});

test('styleProperties handles rules, keyframes, definitions, variables and inline removal without a Studio import', () => {
  assert.deepEqual(styleProperties({ declarations: { COLOR: 'red', '--Brand': 'red' } }), ['color', '--Brand']);
  assert.deepEqual(styleProperties({ location: 'inline', declarations: { opacity: null } }), ['opacity']);
  const raw = {
    css: '@font-face{font-family:pp-brand;src:url(/f.woff2)} @media(width>2px){.pp-card{--Brand:red;color:var(--Brand)}} @keyframes pp-a{from{opacity:0}to{opacity:1}}',
  };
  assert.deepEqual(styleProperties(raw), ['font-family', 'src', '--Brand', 'color', 'opacity']);
  assert.throws(() => styleProperties({ css: '.pp-card{color:red' }), /Unbalanced/);
});

test('permits literal relative, root-relative and fragment assets without fetching', () => {
  for (const url of ['hero.svg', '../assets/hero.svg', '/hero.svg?width=2&height=4', '#pp-icon', '/font file.woff2', '?asset=1']) {
    assert.doesNotThrow(() => analyze({ declarations: { background: `url("${url}")` } }));
  }
  assert.doesNotThrow(() => sheet('.pp-card{background:image-set("/small.avif" 1x,url(/large.avif) 2x)}'));
  assert.doesNotThrow(() => sheet('.pp-card{mask:url(\\23 pp-mask)}'));
});

test('external resource consent compares exact decoded strings and discloses browser loading', () => {
  const url = 'https://assets.example.com/hero.svg?size=2&theme=dark';
  assert.throws(() => analyze({ declarations: { background: `url("${url}")` } }), /EXACT match/);
  const result = analyze({ declarations: { background: `url("${url}")` }, externalResources: [url] });
  assert.match(result.warnings.join('\n'), /may load in the browser/);
  assert.match(result.warnings.join('\n'), /CSP, asset availability/);
  assert.ok(result.warnings.some((warning) => warning.includes(url)));
  for (const consent of ['https://assets.example.com/', url.toUpperCase(), `${url}#approved`]) {
    assert.throws(() => analyze({ declarations: { background: `url("${url}")` }, externalResources: [consent] }), /EXACT match/);
  }
  const escaped = 'h\\74 tps://assets.example.com/hero.svg';
  assert.throws(() => sheet(`.pp-card{background:u\\72l("${escaped}")}`), /EXACT match/);
  assert.doesNotThrow(() => sheet(`.pp-card{background:u\\72l("${escaped}")}`, { externalResources: ['https://assets.example.com/hero.svg'] }));
  assert.throws(() => sheet('.pp-card{background:image-set("https://assets.example.com/a.avif" 1x)}'), /EXACT match/);
  assert.throws(() => sheet('.pp-card{--future:future-image("https://assets.example.com/a.avif")}'), /EXACT match/);
  for (const externalResources of [null, 'https://assets.example.com/a', [12], ['/a'], ['data:text/plain,x'], ['https://user:password@assets.example.com/a']]) {
    assert.throws(() => analyze({ declarations: { color: 'red' }, externalResources }), /CSS validation/);
  }
});

test('rejects URL normalization tricks, executable schemes and dynamic resource construction', () => {
  const urls = [
    '//assets.example.com/a.svg',
    'javascript:blocked',
    'vbscript:blocked',
    'file:///a.svg',
    'data:image/svg+xml,blocked',
    'http://assets.example.com/a.svg',
    'https:assets.example.com/a.svg',
    ' https://assets.example.com/a.svg',
    'https://assets.example.com/a.svg ',
    'java\\73 cript:blocked',
    '\\2f\\2f assets.example.com/a.svg',
    '/\\5c assets.example.com/a.svg',
    'https://assets.example.com/\\a x.svg',
  ];
  for (const url of urls) assert.throws(() => analyze({ declarations: { background: `url("${url}")` } }), /CSS validation/);
  for (const value of ['url(var(--asset))', 'src(attr(data-asset))', 'u\\72l(var(--asset))', 'url(java/**/script:blocked)']) {
    assert.throws(() => analyze({ declarations: { background: value } }), /CSS validation/);
  }
});

test('inspects escaped/comment-obfuscated executable CSS even inside custom/unknown syntax', () => {
  for (const declarations of [
    { width: 'expression(1)' },
    { width: 'e\\78pression(1)' },
    { width: 'exp/**/ression(1)' },
    { '--arbitrary': 'ex\\70 ression(1)' },
    { behavior: 'url(/legacy.htc)' },
    { 'be\\68 avior': 'url(/legacy.htc)' },
    { '-moz-binding': 'url(/legacy.xml)' },
    { '-moz-\\62 inding': 'url(/legacy.xml)' },
    { '-ms-behavior': 'url(/legacy.htc)' },
  ]) assert.throws(() => analyze({ declarations }), /executable CSS/);
  assert.throws(() => sheet('.pp-card{be/**/havior:url(/legacy.htc)}'), /CSS validation/);
  assert.throws(() => sheet('@future-definition pp-a {payload:expression(1)}', { global: true }), /executable CSS/);
  assert.throws(() => sheet('.pp-card:future(url(javascript:blocked)){color:red}'), /CSS validation/);
  assert.doesNotThrow(() => analyze({ declarations: { '--behavior': 'plain-text', content: '"expression(1) is text"' } }));
});

test('rejects unbalanced/recovered tokens, malformed declarations and injected rules', () => {
  const values = [
    'red; display:none',
    'red;}body{display:none',
    'red !important; --tail:red',
    'calc(100% - 1rem',
    '"unfinished',
    '"bad\nstring"',
    'url(/unfinished',
    'url("unfinished)',
    'red /* unfinished',
    'rgb(1 2 3]]',
  ];
  for (const value of values) assert.throws(() => analyze({ declarations: { color: value } }), /CSS validation/);
  for (const css of [
    '.pp-card {color:red',
    '.pp-card {color:red}}',
    '.pp-card {color red;}',
    '.pp-card, {color:red}',
    '.pp-card:is(.pp-card,) {color:red}',
    '.pp-card > {color:red}',
    '.pp-card[attr=] {color:red}',
    '@media (width > 1px) {.pp-card {color:red}',
    '@keyframes pp-a {body {opacity:1}}',
    '@keyframes pp-a {from {.outside {color:red}}}',
    '.pp-card {--x: { a:b; }; --y: "bad\nstring";}',
  ]) assert.throws(() => sheet(css), /CSS validation/);
});

test('EOF token recovery cannot swallow a following authored declaration or managed block', () => {
  for (const value of ['red /*', 'red /*/', '"unfinished', '"escaped final quote\\"', 'red\\']) {
    assert.throws(() => analyze({ declarations: { '--Token': value, color: 'blue' } }), /CSS validation/);
    assert.throws(() => analyze({ location: 'inline', declarations: { '--Token': value, color: 'blue' } }, {}), /CSS validation/);
  }
  for (const before of ['.pp-card{color:red}/*', '.pp-card{color:red}/*/', '.pp-card{--Token:"unfinished']) {
    assert.throws(() => validateStylesheetOrder(before), /CSS validation/);
  }
  assert.doesNotThrow(() => analyze({ declarations: { '--Token': 'red /**/', color: 'blue' } }));
});

test('reserved managed markers are forbidden in authored content but legal in destination stylesheets', () => {
  const marker = 'power-pages:style-site:card:start';
  for (const css of [`/* ${marker} */ .pp-card{color:red}`, `.pp-card{content:"${marker}"}`, `/* ${marker.toUpperCase()} */ .pp-card{color:red}`]) {
    assert.throws(() => sheet(css), /reserved.*managed-block marker/);
    assert.throws(() => styleProperties({ css }), /reserved.*managed-block marker/);
  }
  assert.throws(() => analyze({ declarations: { color: `red /* ${marker} */` } }), /reserved.*managed-block marker/);
  assert.throws(() => analyze({ declarations: { color: 'red' }, part: `/* ${marker} */` }), /reserved.*managed-block marker/);
  assert.equal(validateStylesheetOrder(`/* ${marker} */\n.pp-card{color:red}\n/* power-pages:style-site:card:end */`), true);
});

test('rejects HTML raw-text boundaries and Liquid starts without rejecting legitimate CSS braces', () => {
  for (const value of ['"</style>"', '"</ScRiPt >"', '"{{ brand }}"', '"{% assign x = 1 %}"']) {
    assert.throws(() => analyze({ declarations: { content: value } }), /HTML closing|Liquid/);
  }
  assert.throws(() => sheet('.pp-card{color:{{brand}}}'), /Liquid/);
  assert.doesNotThrow(() => sheet('@media(width>1px){.pp-card{width:50%}}'));
  assert.doesNotThrow(() => analyze({ declarations: { content: '"A & B; \\"quoted\\""', '--tokens': '{ a:1; }' } }));
});

test('new important priority requires a nonempty reason and is never silently added', () => {
  assert.throws(() => analyze({ declarations: { color: 'red !important' } }), /importantReason/);
  assert.throws(() => sheet('.pp-card{color:red!important}'), /importantReason/);
  const result = analyze({ declarations: { color: 'red !important' }, importantReason: 'Reviewed cascade requirement.' });
  assert.ok(result.css.includes('color: red !important;'));
  assert.deepEqual(result.rootDeclarations, [{ color: 'red !important' }]);
  assert.match(result.warnings.join('\n'), /Authored !important/);
  assert.doesNotMatch(analyze({ declarations: { color: 'red' } }).css, /important/);
  assert.doesNotThrow(() => analyze({ declarations: { content: '"!important is text"' } }));
  assert.throws(() => analyze({ declarations: { color: 'red !\\69mportant' } }), /importantReason/);
  assert.throws(() => analyze({ declarations: { color: 'red !not-important' }, importantReason: 'A reason cannot make an invalid priority valid.' }), /Malformed CSS priority/);
});

test('imports need intentional global scope and resource consent even in escaped forms', () => {
  assert.throws(() => sheet('@import "/local.css";'), /global:true/);
  assert.doesNotThrow(() => sheet('@import "/local.css"; .pp-card{color:red}', { global: true }));
  const url = 'https://assets.example.com/theme.css';
  assert.throws(() => sheet(`@import "${url}";`, { global: true }), /EXACT match/);
  const result = sheet(`@import "${url}" layer(pp-imports); .pp-card{color:red}`, { global: true, externalResources: [url] });
  assert.match(result.warnings.join('\n'), /transitive resource URLs are not inspected/);
  assert.throws(() => sheet(`@im\\70ort "${url}";`, { global: true }), /EXACT match/);
  assert.throws(() => sheet('.pp-card{color:red} @import "/local.css";', { global: true }), /@import must precede/);
});

test('destination import/charset order accounts for existing rules, managed comments and layer statements', () => {
  for (const css of [
    '',
    '/* existing */ @layer pp-base, pp-overrides; @import "/a.css"; .pp-card{color:red}',
    '@charset "UTF-8"; @layer pp-base; @import "/a.css"; @import url(/b.css);',
    '@import "/a.css"; @layer pp-base; @import "/b.css";',
    '@layer pp-components {.pp-card{color:red}}',
  ]) assert.equal(validateStylesheetOrder(css), true);
  for (const css of [
    '.existing{color:red} /* managed start */ @import "/a.css";',
    '@layer pp-base {.pp-card{color:red}} @import "/a.css";',
    '@namespace svg url(/ns); @import "/a.css";',
    '@media(width>1px){@import "/a.css";}',
    '.pp-card{@import "/a.css";}',
    '/* managed start */ @charset "UTF-8";',
    ' @charset "UTF-8";',
    '@charset "UTF-8"; @charset "UTF-8";',
    '@media(width>1px){@charset "UTF-8";}',
    '@charset UTF-8;',
    '.pp-card{color:red',
    '.pp-card{color red}',
    '.pp-card[,] {color:red}',
  ]) assert.throws(() => validateStylesheetOrder(css), /CSS validation/);
});
