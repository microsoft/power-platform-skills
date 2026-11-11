'use strict';
// Does a generated page establish its own scroll context? (AB#6793599) — lib/page-scroll.js, which check-griffel-styles.js runs on every page.
//
// The host shows a page in a container of fixed height and never scrolls it, so a page in which nothing both has a bounded height and
// scrolls is cut off below the fold, silently. Measured on the host for each root shape: a root with `height: "100%"` and `overflowY: "auto"`
// scrolls (P2, P3); the same root in an `overflow: "hidden"` wrapper scrolls (P7); a fixed header over a `flex: 1`, `minHeight: 0`,
// `overflowY: "auto"` body scrolls (P6); a bare root (P1), `height` alone (P4), `overflowY` alone (P5), a wrapper round a bare root (P8) and
// `minHeight: "100%"` (P9) clip; and a box that fills its container with vertical padding in the content-box model overhangs it by the
// padding, so its end stays cut off, until `boxSizing: "border-box"` (P10, P11). The P-numbers below are those shapes.
// The CLI's output contract is pinned in griffel-styles.test.js; that the flows run it in each mode, in genpage-dispatch-contract.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { analyzePageScroll, pageScrollProblems, REMEDY_KEYS } = require('../lib/page-scroll.js');
const { loadVendoredTypeScript } = require('../lib/typescript-compiler.js');
const { griffelStyleProblems } = require('../lib/griffel-styles.js');

const ts = loadVendoredTypeScript();
const PLUGIN = path.join(__dirname, '..', '..');
const REPO = path.join(PLUGIN, '..', '..');

const HEAD = "import * as React from 'react';\nimport { makeStyles, mergeClasses, shorthands, tokens, Spinner, MessageBar, Card, Text } from '@fluentui/react-components';\n";

// A page: `slots` is the body of its one makeStyles object, `body` the statements of its default export (which binds `styles`).
const page = (slots, body, extra = '') => `${HEAD}const useStyles = makeStyles({\n${slots}\n});\n${extra}export default function Page(props: any) {\n  const styles = useStyles();\n${body}\n}\n`;
// The same, returning one element with className={styles.root} and three rows.
const rooted = (rootKeys, otherSlots = '', attrs = '') => page(`  root: { ${rootKeys} },\n  row: { padding: '8px' },\n${otherSlots}`, `  return (\n    <div className={styles.root}${attrs}>\n      {[1, 2, 3].map((n) => <div key={n} className={styles.row}><Text>Row {n}</Text></div>)}\n    </div>\n  );`);

// One word for a result: pass, fail, unproven:<reason>, padding, or not judged.
function verdict(source) {
  const r = analyzePageScroll(source);
  if (!r.judged) return `not judged: ${r.why}`;
  const codes = new Set(r.problems.map((p) => p.code));
  if (codes.has('no-scroll-context')) return 'fail';
  const unproven = r.problems.find((p) => p.code === 'scroll-context-unproven');
  if (unproven) return `unproven:${unproven.reason}`;
  if (codes.has('scroll-context-padding')) return 'padding';
  return 'pass';
}

const SCROLLS = "height: '100%', overflowY: 'auto', boxSizing: 'border-box'";
const FLEX_COLUMN = "display: 'flex', flexDirection: 'column'";
// Content taller than any host.
const TALL = '<div style={{ height: 2000 }}><Text>end</Text></div>';

// [name, source, verdict]. Every case that is not a pass is also a case of the remedy invariant below.
const CASES = [
  // The measured shapes.
  ['P1 a bare root', rooted(FLEX_COLUMN), 'fail'],
  ['P2 height 100%, overflowY auto and vertical padding, content-box', rooted("height: '100%', overflowY: 'auto', padding: '16px'"), 'padding'],
  ['P2b the same with boxSizing border-box', rooted("height: '100%', overflowY: 'auto', padding: '16px', boxSizing: 'border-box'"), 'pass'],
  ['P3 the overflow shorthand', rooted("height: '100%', overflow: 'auto'"), 'pass'],
  ['P4 height alone', rooted("height: '100%'"), 'fail'],
  ['P5 overflowY alone', rooted("overflowY: 'auto'"), 'fail'],
  ['P6 a fixed header over a flex body that scrolls', page(`  root: { height: '100%', overflow: 'hidden', ${FLEX_COLUMN} },\n  header: { flexShrink: 0 },\n  body: { flex: 1, minHeight: 0, overflowY: 'auto' },`, '  return (\n    <div className={styles.root}>\n      <div className={styles.header}><Text>Title</Text></div>\n      <div className={styles.body}>{props.rows}</div>\n    </div>\n  );'), 'pass'],
  ['P6 with vertical padding on the root around the body', page(`  root: { height: '100%', overflow: 'hidden', padding: tokens.spacingVerticalL, ${FLEX_COLUMN} },\n  body: { flex: 1, minHeight: 0, overflowY: 'auto' },`, '  return (\n    <div className={styles.root}>\n      <Text>Title</Text>\n      <div className={styles.body}>{props.rows}</div>\n    </div>\n  );'), 'padding'],
  ['P6 a body that scrolls needs no minHeight 0 (a scroll container\'s automatic minimum is 0)', page(`  root: { height: '100%', ${FLEX_COLUMN} },\n  body: { flexGrow: 1, overflowY: 'auto' },`, '  return (\n    <div className={styles.root}>\n      <Text>Title</Text>\n      <div className={styles.body}>{props.rows}</div>\n    </div>\n  );'), 'pass'],
  ['P6 a flex body that does not scroll and holds nothing that does', page(`  root: { height: '100%', overflow: 'hidden', ${FLEX_COLUMN} },\n  body: { flex: 1, minHeight: 0 },`, '  return (\n    <div className={styles.root}>\n      <div className={styles.body}><Text>Rows</Text></div>\n    </div>\n  );'), 'fail'],
  ['P7 the two-div wrapper round a root that scrolls', page(`  root: { ${SCROLLS} },`, "  return (\n    <div style={{ height: '100%', overflow: 'hidden' }}>\n      <div className={styles.root}><Text>Rows</Text></div>\n    </div>\n  );"), 'pass'],
  ['P7 the wrapper round a padded content-box root', page("  root: { height: '100%', overflowY: 'auto', ...shorthands.padding('16px') },", "  return (\n    <div style={{ height: '100%', overflow: 'hidden' }}>\n      <div className={styles.root}><Text>Rows</Text></div>\n    </div>\n  );"), 'padding'],
  ['P8 the wrapper round a bare root (the reported failure)', page(`  root: { ${FLEX_COLUMN} },`, "  return (\n    <div style={{ height: '100%', overflow: 'hidden' }}>\n      <div className={styles.root}><Text>Rows</Text></div>\n    </div>\n  );"), 'fail'],
  ['P9 minHeight 100%', rooted("minHeight: '100%', overflowY: 'auto'"), 'fail'],
  ['a viewport height is taller than the host\'s container', rooted("height: '100vh', overflowY: 'auto'"), 'fail'],
  ['a maxHeight region under a bounded root', page(`  root: { height: '100%', ${FLEX_COLUMN} },\n  region: { maxHeight: 'calc(100% - 100px)', overflow: 'auto' },`, '  return (\n    <div className={styles.root}>\n      <Text>Title</Text>\n      <div className={styles.region}>{props.rows}</div>\n    </div>\n  );'), 'pass'],
  ['a maxHeight region under a root that grows', page(`  root: { ${FLEX_COLUMN} },\n  region: { maxHeight: '400px', overflow: 'auto' },`, '  return (\n    <div className={styles.root}>\n      <Text>Title</Text>\n      <div className={styles.region}>{props.rows}</div>\n    </div>\n  );'), 'fail'],
  // Padding: only a box that fills its container, and only vertical padding that is not zero.
  ['horizontal padding only', rooted("height: '100%', overflowY: 'auto', padding: '0 16px'"), 'pass'],
  ['paddingTop 0', rooted("height: '100%', overflowY: 'auto', paddingTop: 0"), 'pass'],
  ['shorthands.padding with a vertical 0', rooted("height: '100%', overflowY: 'auto', ...shorthands.padding('0', '16px')"), 'pass'],
  ['paddingBlock given a token', rooted("height: '100%', overflowY: 'auto', paddingBlock: tokens.spacingVerticalM"), 'padding'],
  ['a region of fixed height with padding', page(`  root: { height: '100%', ${FLEX_COLUMN} },\n  region: { maxHeight: '300px', overflowY: 'auto', padding: '16px' },`, '  return (\n    <div className={styles.root}>\n      <div className={styles.region}>{props.rows}</div>\n    </div>\n  );'), 'pass'],
  ['boxSizing set inline', rooted("height: '100%', overflowY: 'auto', padding: '16px'", '', " style={{ boxSizing: 'border-box' }}"), 'pass'],
  // Reading styles.
  ['overflowX auto makes overflow-y compute to auto', rooted("height: '100%', overflowX: 'auto'"), 'pass'],
  ['shorthands.overflow(x, y)', rooted("height: '100%', ...shorthands.overflow('hidden', 'auto')"), 'pass'],
  ['shorthands.flex(1) on a body', page(`  root: { height: '100%', ${FLEX_COLUMN} },\n  body: { ...shorthands.flex(1), minHeight: 0, overflowY: 'auto' },`, '  return (\n    <div className={styles.root}>\n      <div className={styles.body}>{props.rows}</div>\n    </div>\n  );'), 'pass'],
  ['mergeClasses: the later class wins', page("  base: { height: '100%' },\n  scroll: { overflowY: 'auto' },\n  clip: { overflowY: 'hidden' },", '  return <div className={mergeClasses(styles.base, styles.scroll, styles.clip)}><Text>Rows</Text></div>;'), 'fail'],
  ['mergeClasses: classes add up', page("  base: { height: '100%' },\n  scroll: { overflowY: 'auto' },", '  return <div className={mergeClasses(styles.base, styles.scroll)}><Text>Rows</Text></div>;'), 'pass'],
  ['a destructured slot', page(`  root: { ${SCROLLS} },`, '  return <div className={styles.root}><Text>Rows</Text></div>;').replace('const styles = useStyles();\n  return <div className={styles.root}>', 'const { root } = useStyles();\n  return <div className={root}>'), 'pass'],
  ['the inline style wins over the class', rooted(SCROLLS, '', " style={{ overflowY: 'visible' }}"), 'fail'],
  ['an inline longhand after its shorthand wins', page('', "  return <div style={{ height: '100%', overflow: 'hidden', overflowY: 'auto' }}><Text>Rows</Text></div>;"), 'pass'],
  ['an inline shorthand after its longhand wins', page('', "  return <div style={{ height: '100%', overflowY: 'auto', overflow: 'hidden' }}><Text>Rows</Text></div>;"), 'fail'],
  ['keys written after a spread are read', page('', "  return <div style={{ ...props.extra, height: '100%', overflowY: 'auto', boxSizing: 'border-box', minHeight: 0 }}><Text>Rows</Text></div>;"), 'pass'],
  // A spread before the keys may carry a minHeight, and a minimum wins over a height.
  ['a spread before the keys may carry a minHeight', page('', "  return <div style={{ ...props.extra, height: '100%', overflowY: 'auto', boxSizing: 'border-box' }}><Text>Rows</Text></div>;"), 'unproven:unread-spread'],
  ['a spread before the keys may carry padding', page('', "  return <div style={{ ...props.extra, height: '100%', overflowY: 'auto', minHeight: 0 }}><Text>Rows</Text></div>;"), 'padding'],
  ['a spread after the keys may replace them', page('', "  return <div style={{ height: '100%', overflowY: 'auto', ...props.extra }}><Text>Rows</Text></div>;"), 'unproven:unread-spread'],
  ['a spread of attributes after className', rooted(SCROLLS, '', ' {...props.attrs}'), 'unproven:spread-attributes'],
  ['a conditional class that sets overflow', rooted(SCROLLS, "  dense: { overflowY: 'hidden' },", '').replace('className={styles.root}', 'className={mergeClasses(styles.root, props.dense && styles.dense)}'), 'unproven:conditional-class'],
  ['a conditional class that sets only a colour', rooted(SCROLLS, '  dense: { color: tokens.colorNeutralForeground2 },', '').replace('className={styles.root}', 'className={mergeClasses(styles.root, props.dense && styles.dense)}'), 'pass'],
  ['a template-string className', rooted(SCROLLS).replace('className={styles.root}', 'className={`${styles.root} page`}'), 'unproven:string-class'],
  ['a string className', page('', '  return <div className="page-root"><Text>Rows</Text></div>;'), 'unproven:string-class'],
  ['a slot the hook does not have', rooted(SCROLLS).replace('className={styles.root}', 'className={styles.missing}'), 'unproven:unknown-slot'],
  ['a height given a token', rooted("height: tokens.spacingVerticalXXXL, overflowY: 'auto'"), 'unproven:unread-value'],
  ['a shorthand and its longhand on classes, to different effect', rooted("height: '100%', overflow: 'hidden', overflowY: 'auto'"), 'unproven:conflicting-keys'],
  ['an inline style computed by code', rooted(SCROLLS, '', ' style={props.style}'), 'unproven:style-expression'],
  // Following the page.
  ['an early return of a spinner is not judged', page(`  root: { ${SCROLLS} },`, "  if (props.loading) return <div><Spinner /></div>;\n  return <div className={styles.root}><Text>Rows</Text></div>;"), 'pass'],
  ['when the final return is a library state view, the earlier returns are judged', page(`  root: { ${SCROLLS} },`, '  if (props.data) return <div className={styles.root}><Text>Rows</Text></div>;\n  return <Spinner />;'), 'pass'],
  ['a library arm beside an element is a state view', page(`  root: { ${SCROLLS} },`, '  return props.error ? <MessageBar>{props.error}</MessageBar> : <div className={styles.root}><Text>Rows</Text></div>;'), 'pass'],
  ['both arms of a condition are judged', page(`  root: { ${SCROLLS} },\n  other: { ${FLEX_COLUMN} },`, '  return props.wide ? <div className={styles.root}><Text>A</Text></div> : <div className={styles.other}><Text>B</Text></div>;'), 'fail'],
  ['transparent components pass through', page(`  root: { ${SCROLLS} },`, '  return <React.StrictMode><React.Suspense fallback={null}><Ctx.Provider value={1}><div className={styles.root}><Text>Rows</Text></div></Ctx.Provider></React.Suspense></React.StrictMode>;', 'const Ctx = React.createContext(0);\n'), 'pass'],
  ['a fragment with one element is that element', page(`  root: { ${SCROLLS} },`, '  return <><div className={styles.root}><Text>Rows</Text></div></>;'), 'pass'],
  ['a fragment of several elements side by side', page(`  root: { ${SCROLLS} },`, '  return <><Text>Title</Text><div className={styles.root}><Text>Rows</Text></div></>;'), 'unproven:fragment-top'],
  ['a portal at the top', page('', '  return ReactDOM.createPortal(<div />, document.body);', "import * as ReactDOM from 'react-dom';\n"), 'unproven:portal'],
  ['a component imported from elsewhere at the top', page('', '  return <Shell />;', "import { Shell } from './shell';\n"), 'unproven:library-top'],
  ['a library component at the top that scrolls', page(`  root: { ${SCROLLS} },`, '  return <Card className={styles.root}><Text>Rows</Text></Card>;'), 'pass'],
  ['a return computed by a call', page('', '  return renderBody();', 'declare function renderBody(): any;\n'), 'unproven:unresolved-return'],
  ['content computed by a call inside a root that does not scroll', page(`  root: { height: '100%', ${FLEX_COLUMN} },`, '  return <div className={styles.root}>{renderRows()}</div>;', 'declare function renderRows(): any;\n'), 'unproven:unresolved-children'],
  ['components that render each other', page('', '  return <A />;', 'function A(): any { return <B />; }\nfunction B(): any { return <A />; }\n'), 'unproven:recursive'],
  ['a component that returns children it is never given', page('', '  return props.children;'), 'unproven:children-top'],
  // Alternatives: only one of a condition's alternatives is on screen at a time, so each one that renders content must scroll.
  ['only one alternative of a condition scrolls', page('', `  return (<div style={{ height: '100%', overflow: 'hidden' }}>{props.mode ? <div style={{ ${SCROLLS} }}>${TALL}</div> : <div>${TALL}</div>}</div>);`), 'unproven:partial-alternatives'],
  ['every alternative of a condition scrolls', page('', `  return (<div style={{ height: '100%', overflow: 'hidden' }}>{props.mode ? <div style={{ ${SCROLLS} }}>${TALL}</div> : <div style={{ ${SCROLLS} }}>${TALL}</div>}</div>);`), 'pass'],
  ['a nested condition with one alternative that does not scroll', page('', `  return (<div style={{ height: '100%', overflow: 'hidden' }}>{props.a ? <div style={{ ${SCROLLS} }}>${TALL}</div> : props.b ? <div style={{ ${SCROLLS} }}>${TALL}</div> : <div>${TALL}</div>}</div>);`), 'unproven:partial-alternatives'],
  ['a nested condition in which every alternative scrolls', page('', `  return (<div style={{ height: '100%', overflow: 'hidden' }}>{props.a ? <div style={{ ${SCROLLS} }}>${TALL}</div> : props.b ? <div style={{ ${SCROLLS} }}>${TALL}</div> : null}</div>);`), 'pass'],
  ['a local component whose alternatives do not all scroll', page('', "  return (<div style={{ height: '100%', overflow: 'hidden' }}><Body mode={props.mode} /></div>);", `function Body(props: any) {\n  return props.mode ? <div style={{ ${SCROLLS} }}>${TALL}</div> : <div>${TALL}</div>;\n}\n`), 'unproven:partial-alternatives'],
  ['a loading alternative of a library component', page('', `  return (<div style={{ height: '100%', overflow: 'hidden' }}>{props.loading ? <Spinner /> : <div style={{ ${SCROLLS} }}>${TALL}</div>}</div>);`), 'pass'],
  ['a busy indicator beside a body that scrolls is a sibling', page('', `  return (<div style={{ height: '100%', overflow: 'hidden' }}>{props.busy && <Spinner />}<div style={{ ${SCROLLS} }}>${TALL}</div></div>);`), 'pass'],
  ['an alternative that renders nothing', page('', `  return (<div style={{ height: '100%', overflow: 'hidden' }}>{props.ready && <div style={{ ${SCROLLS} }}>${TALL}</div>}</div>);`), 'pass'],
  // Only a recognised state view (a Spinner, a MessageBar, a line of Text, …) is passed over; any other library component is content.
  ['an error alternative of a MessageBar with a body and an action', page('', `  return (<div style={{ height: '100%', overflow: 'hidden' }}>{props.mode ? <div style={{ ${SCROLLS} }}>${TALL}</div> : <MessageBar intent="error"><MessageBarBody>{props.error} <b>Retry</b></MessageBarBody></MessageBar>}</div>);`), 'pass'],
  ['an empty alternative of a line of Text', page('', `  return (<div style={{ height: '100%', overflow: 'hidden' }}>{props.mode ? <div style={{ ${SCROLLS} }}>${TALL}</div> : <Text>No accounts found.</Text>}</div>);`), 'pass'],
  ['an alternative of a Card that holds the rows', page('', `  return (<div style={{ height: '100%', overflow: 'hidden' }}>{props.mode ? <div style={{ ${SCROLLS} }}>${TALL}</div> : <Card>${TALL}</Card>}</div>);`), 'unproven:partial-alternatives'],
  ['an alternative of a Card that holds a value', page('', `  return (<div style={{ height: '100%', overflow: 'hidden' }}>{props.mode ? <div style={{ ${SCROLLS} }}>${TALL}</div> : <Card>{props.rows}</Card>}</div>);`), 'unproven:partial-alternatives'],
  ['an alternative of an imported component', page('', `  return (<div style={{ height: '100%', overflow: 'hidden' }}>{props.mode ? <div style={{ ${SCROLLS} }}>${TALL}</div> : <Rows />}</div>);`, "import { Rows } from './rows';\n"), 'unproven:partial-alternatives'],
  ['an alternative of a MessageBar that holds rows', page('', `  return (<div style={{ height: '100%', overflow: 'hidden' }}>{props.mode ? <div style={{ ${SCROLLS} }}>${TALL}</div> : <MessageBar>${TALL}</MessageBar>}</div>);`), 'unproven:partial-alternatives'],
  // A known limit: an early return is an exit (loading, error, empty), and only the final return is judged when it renders an element.
  ['an early return of a Card beside a final return that scrolls', page('', `  if (props.mode) return <Card>${TALL}</Card>;\n  return <div style={{ ${SCROLLS} }}>${TALL}</div>;`), 'pass'],
  ['an early return of a Spinner beside a root that scrolls', page('', `  if (props.loading) return <Spinner />;\n  return <div style={{ ${SCROLLS} }}>${TALL}</div>;`), 'pass'],
  // A known false rejection: a loading alternative wrapped in an element of the page's own is judged like content.
  ['a loading alternative inside a box of the page\'s own', page('', `  return (<div style={{ height: '100%', overflow: 'hidden' }}>{props.loading ? <div><Spinner /></div> : <div style={{ ${SCROLLS} }}>${TALL}</div>}</div>);`), 'unproven:partial-alternatives'],
  ['the remedy on the top element of a loading alternative inside a box of the page\'s own', page('', `  return (<div style={{ height: '100%', overflowY: 'auto', boxSizing: 'border-box', minHeight: 0 }}>{props.loading ? <div><Spinner /></div> : <div style={{ ${SCROLLS} }}>${TALL}</div>}</div>);`), 'pass'],
  ['the remedy on the top element of a column whose body has a minHeight of its own', page('', `  return (<div style={{ height: '100%', overflowY: 'auto', boxSizing: 'border-box', minHeight: 0, ${FLEX_COLUMN} }}><div style={{ flexShrink: 0, height: 48 }}>Title</div><div style={{ flex: 1, minHeight: 200, overflowY: 'auto' }}>${TALL}</div></div>);`), 'pass'],
  // Definite height: a percentage resolves only against a parent of definite height, not one bounded by maxHeight alone.
  ['height 100% under a parent bounded only by maxHeight', page('', `  return (<div style={{ maxHeight: '100%', overflow: 'hidden' }}><div style={{ ${SCROLLS} }}>${TALL}</div></div>);`), 'fail'],
  ['height 100% under a parent of definite height', page('', `  return (<div style={{ height: '100%', overflow: 'hidden' }}><div style={{ ${SCROLLS} }}>${TALL}</div></div>);`), 'pass'],
  ['a maxHeight 100% region under a parent bounded only by maxHeight', page('', `  return (<div style={{ maxHeight: '100%', overflow: 'hidden' }}><div style={{ maxHeight: '100%', overflowY: 'auto' }}>${TALL}</div></div>);`), 'fail'],
  ['a flex body in a column bounded only by maxHeight', page('', `  return (<div style={{ maxHeight: '100%', overflow: 'hidden', ${FLEX_COLUMN} }}><Text>Title</Text><div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>${TALL}</div></div>);`), 'pass'],
  ['height 100% inside a flex body that grows in a definite column', page('', `  return (<div style={{ height: '100%', overflow: 'hidden', ${FLEX_COLUMN} }}><Text>Title</Text><div style={{ flex: 1, minHeight: 0 }}><div style={{ ${SCROLLS} }}>${TALL}</div></div></div>);`), 'pass'],
  // minHeight: a minimum wins over a height, so one that may be larger than the bound defeats it.
  ['a minHeight in px under height 100%', page('', `  return (<div style={{ height: '100%', minHeight: 2000, overflowY: 'auto' }}>${TALL}</div>);`), 'unproven:min-height'],
  ['a minHeight larger than a fixed height', page('', `  return (<div style={{ height: 480, minHeight: 2000, overflowY: 'auto' }}>${TALL}</div>);`), 'fail'],
  ['a minHeight not larger than a fixed height', page('', `  return (<div style={{ height: '480px', minHeight: 300, overflowY: 'auto' }}>${TALL}</div>);`), 'pass'],
  ['minHeight 100% under height 100%', rooted(`${SCROLLS}, minHeight: '100%'`), 'pass'],
  ['minHeight 0 under height 100%', rooted(`${SCROLLS}, minHeight: 0`), 'pass'],
  // The same value, or the same unit and not larger, fits; units are never converted.
  ['a minHeight in rem equal to the height', page('', `  return (<div style={{ height: '30rem', minHeight: '30rem', overflowY: 'auto' }}>${TALL}</div>);`), 'pass'],
  ['a minHeight in rem smaller than the height', page('', `  return (<div style={{ height: '30rem', minHeight: '10rem', overflowY: 'auto' }}>${TALL}</div>);`), 'pass'],
  ['a minHeight in rem larger than the height', page('', `  return (<div style={{ height: '30rem', minHeight: '40rem', overflowY: 'auto' }}>${TALL}</div>);`), 'fail'],
  ['a minHeight that is the same calc() as the height', page('', `  return (<div style={{ height: 'calc(100% - 64px)', minHeight: 'calc(100%  -  64px)', overflowY: 'auto' }}>${TALL}</div>);`), 'pass'],
  ['a minHeight in % smaller than the height', page('', `  return (<div style={{ height: '50%', minHeight: '25%', overflowY: 'auto' }}>${TALL}</div>);`), 'pass'],
  ['a minHeight in rem under a height in px', page('', `  return (<div style={{ height: '480px', minHeight: '10rem', overflowY: 'auto' }}>${TALL}</div>);`), 'unproven:min-height'],
  ['a minHeight given a token', rooted(`${SCROLLS}, minHeight: tokens.spacingVerticalXXXL`), 'unproven:unread-value'],
  ['a flex body with a minHeight of its own', page(`  root: { height: '100%', overflow: 'hidden', ${FLEX_COLUMN} },\n  body: { flex: 1, minHeight: '200px', overflowY: 'auto' },`, '  return (\n    <div className={styles.root}>\n      <Text>Title</Text>\n      <div className={styles.body}>{props.rows}</div>\n    </div>\n  );'), 'unproven:min-height'],
  // Padding is refused only where the box provably fills its container.
  ['height 50% with padding', page('', `  return (<div style={{ height: '50%', overflowY: 'auto', padding: 16 }}>${TALL}</div>);`), 'pass'],
  ['calc(100% - 64px) with 16px padding', page('', `  return (<div style={{ height: 'calc(100% - 64px)', overflowY: 'auto', padding: 16 }}>${TALL}</div>);`), 'pass'],
  ['calc(100% - 8px) with 16px padding', page('', `  return (<div style={{ height: 'calc(100% - 8px)', overflowY: 'auto', padding: '16px' }}>${TALL}</div>);`), 'padding'],
  ['calc(100% - 64px) with a token padding', page('', `  return (<div style={{ height: 'calc(100% - 64px)', overflowY: 'auto', padding: tokens.spacingVerticalL }}>${TALL}</div>);`), 'pass'],
  ['height 100% with 16px padding', page('', `  return (<div style={{ height: '100%', overflowY: 'auto', padding: 16 }}>${TALL}</div>);`), 'padding'],
  ['height 100% capped by maxHeight calc(100% - 64px) with 16px padding', page('', `  return (<div style={{ height: '100%', maxHeight: 'calc(100% - 64px)', overflowY: 'auto', padding: 16 }}>${TALL}</div>);`), 'pass'],
  ['height 100% and maxHeight 100% with 16px padding', page('', `  return (<div style={{ height: '100%', maxHeight: '100%', overflowY: 'auto', padding: 16 }}>${TALL}</div>);`), 'padding'],
  // The used height is max(minHeight, min(height, maxHeight)): a looser maximum, or a minimum that wins over the maximum, leaves it full.
  ['height 100% under a looser maxHeight 150% with 16px padding', page('', `  return (<div style={{ height: '100%', maxHeight: '150%', overflowY: 'auto', padding: 16 }}>${TALL}</div>);`), 'padding'],
  ['height 100% with minHeight 100% over maxHeight calc(100% - 64px) and 16px padding', page('', `  return (<div style={{ height: '100%', minHeight: '100%', maxHeight: 'calc(100% - 64px)', overflowY: 'auto', padding: 16 }}>${TALL}</div>);`), 'padding'],
  ['height 100% with minHeight 0 under maxHeight calc(100% - 64px) and 16px padding', page('', `  return (<div style={{ height: '100%', minHeight: 0, maxHeight: 'calc(100% - 64px)', overflowY: 'auto', padding: 16 }}>${TALL}</div>);`), 'pass'],
  ['height 100% under a fixed maxHeight 400px with 16px padding (not comparable to the host)', page('', `  return (<div style={{ height: '100%', maxHeight: '400px', overflowY: 'auto', padding: 16 }}>${TALL}</div>);`), 'padding'],
  ['height 100% under a looser maxHeight 150% with 16px padding and border-box', page('', `  return (<div style={{ height: '100%', maxHeight: '150%', overflowY: 'auto', padding: 16, boxSizing: 'border-box' }}>${TALL}</div>);`), 'pass'],
  ['maxHeight 100% alone with 16px padding', page('', `  return (<div style={{ maxHeight: '100%', overflowY: 'auto', padding: 16 }}>${TALL}</div>);`), 'padding'],
  // A default export named before the function it names (function declarations are hoisted).
  ['export default of a function declared below it', `${HEAD}export default Page;\nfunction Page() {\n  return <div style={{ ${SCROLLS} }}>${TALL}</div>;\n}\n`, 'pass'],
  ['export default of a function declared below it, with a bare root', `${HEAD}export default Page;\nfunction Page() {\n  return <div>${TALL}</div>;\n}\n`, 'fail'],
];

for (const [name, source, expected] of CASES) {
  test(`page-scroll: ${name} → ${expected}`, () => {
    assert.equal(verdict(source), expected);
  });
}

test('page-scroll: the work item\'s dashboard — default export → error boundary class → body component → a flex column root — has no scroll context', () => {
  const source = `${HEAD}const useStyles = makeStyles({\n  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, padding: tokens.spacingHorizontalL },\n  card: { padding: '8px' },\n});\nclass PageErrorBoundary extends React.Component<{ children: React.ReactNode }> {\n  render() { return this.props.children; }\n}\nfunction PageBody() {\n  const styles = useStyles();\n  return (\n    <div className={styles.root}>\n      {[1, 2].map((n) => <Card key={n} className={styles.card}><Text>{n}</Text></Card>)}\n    </div>\n  );\n}\nexport default function GeneratedComponent() {\n  return <PageErrorBoundary><PageBody /></PageErrorBoundary>;\n}\n`;
  const problems = pageScrollProblems(source);
  assert.deepEqual(problems.map(({ code, line, column, element, fix }) => ({ code, line, column, element, fix })), [
    { code: 'no-scroll-context', line: 13, column: 5, element: 'div', fix: { kind: 'class', hook: 'useStyles', slot: 'root', flexColumn: true } },
  ]);
  assert.equal(problems[0].message, 'the page has no scroll context: nothing from its top <div> at line 13 down both has a bounded height and scrolls. The host shows a page in a container of fixed height and does not scroll it, so whatever does not fit is cut off with no scrollbar. Add height: "100%", overflowY: "auto", boxSizing: "border-box" to the "root" slot of useStyles (the class of the page\'s top <div> at line 13), and delete any overflow key or shorthands.overflow(…) from that slot (references/rules.md, "Page Layout"). That element is a flex column, which shrinks its items to fit once its height is bounded: give flexShrink: 0 to each of its items that clips its own content (a Card, or a box with an overflow key), or they are squeezed and cut off inside.');
});

test('page-scroll: a component that renders its children inside a box of its own passes them the bounded height', () => {
  const layout = 'function Layout({ children }: { children: React.ReactNode }) {\n  const styles = useStyles();\n  return <div className={styles.shell}>{children}</div>;\n}\n';
  const slots = `  shell: { height: '100%', overflow: 'hidden', ${FLEX_COLUMN} },\n  body: { flex: 1, minHeight: 0, overflowY: 'auto' },`;
  assert.equal(verdict(page(slots, '  return <Layout><div className={styles.body}>{props.rows}</div></Layout>;', layout)), 'pass');
  assert.equal(verdict(page(slots, '  return <Layout><div>{props.rows}</div></Layout>;', layout)), 'fail');
});

test('page-scroll: every way to name the default export is read — memo, forwardRef, an alias, `export { X as default }`, a class', () => {
  const body = `const useStyles = makeStyles({ root: { ${FLEX_COLUMN} } });\nfunction Page() {\n  const styles = useStyles();\n  return <div className={styles.root} />;\n}\n`;
  for (const tail of ['export default React.memo(Page);', 'export default React.forwardRef(Page);', 'const Alias = Page;\nexport default Alias;', 'export { Page as default };']) {
    assert.equal(verdict(`${HEAD}${body}${tail}\n`), 'fail', tail);
  }
  // A className the check cannot read may carry a minHeight, which the inline style must then also set.
  assert.equal(verdict(`${HEAD}const useStyles = makeStyles({ root: { ${SCROLLS} } });\nexport default class Page extends React.Component {\n  render() { return <div className="x" style={{ height: '100%', overflowY: 'auto', boxSizing: 'border-box', minHeight: 0 }} />; }\n}\n`), 'pass');
  // makeStyles and mergeClasses under another name or through a namespace.
  assert.equal(verdict(`import * as React from 'react';\nimport * as F from '@fluentui/react-components';\nconst useStyles = F.makeStyles({ root: { ${SCROLLS} } });\nexport default function Page() {\n  const s = useStyles();\n  return <div className={F.mergeClasses(s.root)} />;\n}\n`), 'pass');
  assert.equal(verdict(`import * as React from 'react';\nimport { makeStyles as ms } from '@griffel/react';\nconst useStyles = ms({ root: { ${SCROLLS} } });\nexport default function Page() {\n  return <div className={useStyles().root} />;\n}\n`), 'unproven:computed-class');
});

test('page-scroll: what is not a page is not judged, so its result is what it was before this check — a fragment, a parse error, a page that renders nothing', () => {
  assert.equal(verdict(`${HEAD}export function Part() { return <div />; }\n`), 'not judged: no default export');
  assert.equal(verdict(`${HEAD}export default function Page() { return <div className= />; }\n`), 'not judged: parse error');
  assert.equal(verdict(`${HEAD}export default function Page() { return null; }\n`), 'not judged: renders nothing');
  assert.equal(verdict(''), 'not judged: no default export');
  // The pre-filter is a cheap regex, so a default export written in a comment only gets the parser to say "no default export".
  assert.equal(verdict(`${HEAD}// export default\nexport const x = 1;\n`), 'not judged: no default export');
});

test('page-scroll: one problem for each top element that fails, and one for each padded box on the path, in source order', () => {
  // The line and column an editor shows for the n-th `needle` in `source`.
  const at = (source, needle, n = 0) => {
    let i = -1;
    for (let k = 0; k <= n; k += 1) i = source.indexOf(needle, i + 1);
    const before = source.slice(0, i).split('\n');
    return `${before.length}:${before[before.length - 1].length + 1}`;
  };
  const source = page(`  a: { ${FLEX_COLUMN} },\n  b: { height: '100%' },`, '  return props.wide ? <div className={styles.a} /> : <div className={styles.b} />;');
  assert.deepEqual(pageScrollProblems(source).map((p) => `${p.code}@${p.line}:${p.column}`), [`no-scroll-context@${at(source, '<div')}`, `no-scroll-context@${at(source, '<div', 1)}`]);
  const padded = page("  wrap: { height: '100%', overflow: 'hidden', padding: '8px' },\n  root: { height: '100%', overflowY: 'auto', padding: '16px' },", '  return <div className={styles.wrap}><div className={styles.root} /></div>;');
  assert.deepEqual(pageScrollProblems(padded).map((p) => `${p.code}@${p.line}:${p.column}:${p.fix.kind}`), [`scroll-context-padding@${at(padded, '<div')}:class`, `scroll-context-padding@${at(padded, '<div', 1)}:class`]);
  assert.match(pageScrollProblems(padded)[0].message, /^the page scrolls, but its <div> at line \d+ fills its container .* Add boxSizing: "border-box" to the "wrap" slot of useStyles/);
});

// ─── The remedy invariant: the edit each problem gives is one the check then accepts ────────────────────────────────────────────────────

// Applies each problem's `fix` the way its message tells an agent to, with the TypeScript parser (not a regex), and returns the new source.
function applyFixes(source, problems) {
  const sf = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [];
  const offset = (line, column) => sf.getPositionOfLineAndCharacter(line - 1, column - 1);
  const find = (pred) => {
    let hit = null;
    const visit = (n) => {
      if (!hit && pred(n)) hit = n;
      if (!hit) ts.forEachChild(n, visit);
    };
    visit(sf);
    return hit;
  };
  for (const p of problems) {
    const keys = p.code === 'scroll-context-padding' ? 'boxSizing: "border-box"' : p.fix.minHeight ? `${REMEDY_KEYS}, minHeight: 0` : REMEDY_KEYS;
    const at = offset(p.line, p.column);
    if (p.fix.kind === 'class') {
      const hook = find((n) => ts.isVariableDeclaration(n) && n.name.getText(sf) === p.fix.hook);
      const slot = hook.initializer.arguments[0].properties.find((x) => x.name && x.name.getText(sf).replace(/['"]/g, '') === p.fix.slot).initializer;
      // "… and delete any overflow key or shorthands.overflow(…) from that slot"
      const kept = slot.properties.map((x) => x.getText(sf)).filter((text) => p.code === 'scroll-context-padding' || !/^(?:['"]?overflow['"]?\s*:|\.\.\.shorthands\.overflow\()/.test(text));
      edits.push({ start: slot.getStart(sf), end: slot.getEnd(), text: `{ ${[...kept, keys].join(', ')} }` });
    } else if (p.fix.kind === 'style') {
      const element = find((n) => (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && n.getStart(sf) === at);
      const open = ts.isJsxElement(element) ? element.openingElement : element;
      const style = open.attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.getText(sf) === 'style');
      let inner = '';
      if (style) {
        const e = style.initializer.expression;
        inner = ts.isObjectLiteralExpression(e) ? e.properties.map((x) => x.getText(sf)).join(', ') : `...(${e.getText(sf)})`;
        edits.push({ start: style.getFullStart(), end: style.getEnd(), text: '' });
      }
      // "make style its last attribute"
      edits.push({ start: open.attributes.getEnd(), end: open.attributes.getEnd(), text: ` style={{ ${inner ? `${inner}, ` : ''}${keys} }}` });
    } else {
      // The outermost expression that starts where the problem points (a pre-order walk meets it first): what the component returns.
      const outer = find((n) => ts.isExpression(n) && n.getStart(sf) === at);
      const jsx = ts.isJsxElement(outer) || ts.isJsxSelfClosingElement(outer) || ts.isJsxFragment(outer);
      edits.push({ start: outer.getStart(sf), end: outer.getEnd(), text: `<div style={{ ${REMEDY_KEYS} }}>${jsx ? outer.getText(sf) : `{${outer.getText(sf)}}`}</div>` });
    }
  }
  let out = source;
  for (const e of edits.sort((a, b) => b.start - a.start || b.end - a.end)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

test('page-scroll: the remedy each problem gives is accepted — on the class, as the last inline style, or as a wrapper — for every shape the check does not pass', () => {
  let fixed = 0;
  const kinds = new Set();
  for (const [name, source, expected] of CASES) {
    if (expected === 'pass') continue;
    const problems = pageScrollProblems(source);
    assert.ok(problems.length, name);
    for (const p of problems) kinds.add(`${p.code}/${p.fix.kind}`);
    const after = applyFixes(source, problems);
    assert.equal(verdict(after), 'pass', `${name}\n${after}`);
    // The remedy must not trade a scroll problem for a Griffel one.
    assert.deepEqual(griffelStyleProblems(after).problems, [], name);
    fixed += 1;
  }
  assert.ok(fixed >= 30, `${fixed} shapes fixed`);
  for (const kind of ['no-scroll-context/class', 'no-scroll-context/style', 'scroll-context-unproven/class', 'scroll-context-unproven/style', 'scroll-context-unproven/wrap', 'scroll-context-padding/class']) {
    assert.ok(kinds.has(kind), `${kind} is exercised (${[...kinds].join(', ')})`);
  }
});

test('page-scroll: the remedy works where the className cannot be read — a template string, a spread of attributes after it, a class that is not this page\'s', () => {
  for (const [source, reason] of [
    [rooted(FLEX_COLUMN).replace('className={styles.root}', 'className={`${styles.root} page`}'), 'string-class'],
    [rooted(FLEX_COLUMN, '', ' {...props.attrs}'), 'spread-attributes'],
    [rooted(FLEX_COLUMN, '', ' {...props.attrs} style={props.style}'), 'style-expression'],
    [rooted(FLEX_COLUMN).replace('className={styles.root}', 'className={props.cls}'), 'computed-class'],
    [rooted(FLEX_COLUMN).replace('className={styles.root}', 'className={mergeClasses(...props.classes)}'), 'computed-class'],
    [page('', "  return <div className=\"page\" style={{ height: '100%', overflow: 'hidden', padding: '16px' }}><Text>Rows</Text></div>;"), null],
  ]) {
    const problems = pageScrollProblems(source);
    // An inline style is read even on an element whose classes are not: an inline overflow of hidden is known not to scroll.
    assert.deepEqual(problems.map((p) => [p.code, p.reason, p.fix.kind]), [[reason ? 'scroll-context-unproven' : 'no-scroll-context', reason || undefined, 'style']], source);
    assert.ok(problems[0].message.includes('make style its last attribute: an inline style wins over every class'), problems[0].message);
    assert.equal(verdict(applyFixes(source, problems)), 'pass', applyFixes(source, problems));
  }
});

test('page-scroll: the remedy also writes minHeight: 0 where a minHeight may be larger than the container, and only there', () => {
  for (const source of [rooted(`${FLEX_COLUMN}, minHeight: 2000`), page('', `  return (<div style={{ height: '100%', minHeight: 2000, overflowY: 'auto' }}>${TALL}</div>);`)]) {
    const problems = pageScrollProblems(source);
    assert.equal(problems.length, 1, source);
    assert.equal(problems[0].fix.minHeight, true);
    assert.ok(problems[0].message.includes(`${REMEDY_KEYS}, minHeight: 0`), problems[0].message);
    assert.equal(verdict(applyFixes(source, problems)), 'pass');
  }
  const plain = pageScrollProblems(rooted(`${FLEX_COLUMN}, minHeight: '100%'`));
  assert.equal(plain[0].fix.minHeight, undefined);
  assert.ok(!plain[0].message.includes('minHeight: 0'), plain[0].message);
});

test('page-scroll: the class is the fix only when the slot provably wins — another class with an overflow key, or an inline key the remedy writes, moves it inline', () => {
  const fixOf = (source) => pageScrollProblems(source).map((p) => p.fix.kind).join();
  assert.equal(fixOf(rooted(FLEX_COLUMN)), 'class');
  assert.equal(fixOf(page(`  base: { overflowY: 'hidden' },\n  root: { ${FLEX_COLUMN} },`, '  return <div className={mergeClasses(styles.base, styles.root)} />;')), 'style');
  assert.equal(fixOf(rooted(FLEX_COLUMN, '', " style={{ height: 'auto' }}")), 'style');
  assert.equal(fixOf(rooted(FLEX_COLUMN, '', " style={{ boxSizing: 'content-box' }}")), 'style');
  assert.equal(fixOf(rooted(FLEX_COLUMN, "  on: { display: 'block' },").replace('className={styles.root}', 'className={mergeClasses(styles.root, props.on && styles.on)}')), 'style');
  assert.equal(fixOf(rooted(FLEX_COLUMN, '  on: { color: tokens.colorBrandForeground1 },').replace('className={styles.root}', 'className={mergeClasses(styles.root, props.on && styles.on)}')), 'class');
});

// ─── The committed pages ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

function committedPages(t) {
  try {
    // Through `git ls-files`, not a directory walk: capture-fixture.test.js creates and deletes transient fixture folders while the suite runs.
    return execFileSync('git', ['ls-files', '-z', '*.tsx'], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean);
  } catch {
    t.skip('not a git checkout');
    return null;
  }
}

test('page-scroll: every sample the page builder learns from establishes a scroll context with no padding overhang', (t) => {
  const pages = committedPages(t);
  if (!pages) return;
  const samples = pages.filter((p) => p.startsWith('plugins/model-apps/samples/'));
  assert.ok(samples.length >= 13, `${samples.length} samples`);
  for (const sample of samples) assert.equal(verdict(fs.readFileSync(path.join(REPO, sample), 'utf8')), 'pass', sample);
});

test('page-scroll: the captured eval pages keep the verdicts they were measured with — a parser change that flips one shows here', (t) => {
  const pages = committedPages(t);
  if (!pages) return;
  const { CAPTURED_BEFORE_THE_RULE } = require('../../../../evals/model-apps/genpage/lib/scroll-context.js');
  const captured = pages.filter((p) => p.startsWith('evals/model-apps/genpage/fixtures/'));
  const seen = {};
  for (const p of captured) seen[p.slice('evals/model-apps/genpage/fixtures/'.length)] = verdict(fs.readFileSync(path.join(REPO, p), 'utf8'));
  for (const [file, expected] of Object.entries(CAPTURED_BEFORE_THE_RULE)) assert.equal(seen[file], expected, file);
  // A captured page not in the list is graded by the eval, so it must pass.
  for (const [file, v] of Object.entries(seen)) if (!(file in CAPTURED_BEFORE_THE_RULE)) assert.equal(v, 'pass', `${file} is graded by the eval and must pass`);
});

test('page-scroll: every code sample in the plugin\'s instructions that is a whole page establishes a scroll context, but for the excerpts listed', () => {
  // A fenced block with a default export is a page the builder may copy; one without is a fragment and is not judged. The blocks that
  // do not pass are excerpts about something other than layout, each listed with why it is left as it is.
  const EXCERPTS = [
    // The page error wrapper as a three-line excerpt: PageErrorBoundary and PageBody are defined in rules.md, not in the block.
    'agents/genpage-page-builder.md unproven:library-top',
    'agents/genpage-page-builder.md unproven:library-top',
    'references/dataverse-operations.md unproven:library-top',
    'references/rules.md unproven:library-top',
    // The canonical page error block of "Missing Error Handling": its PageBody shows the error bar, not a page layout, and the
    // block is executed as written by page-error-reference.test.js and the eval's page-error teaching test.
    'references/rules.md fail',
  ];
  const seen = [];
  for (const dir of ['references', 'skills', 'agents']) {
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.md')) {
          const lines = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n').split('\n');
          for (let i = 0; i < lines.length; i += 1) {
            const open = /^\s*(`{3,}|~{3,})(?:tsx|typescript|ts)\s*$/.exec(lines[i]);
            if (!open) continue;
            let end = i + 1;
            while (end < lines.length && !lines[end].trimStart().startsWith(open[1])) end += 1;
            const body = lines.slice(i + 1, end).join('\n');
            if (analyzePageScroll(body).judged) seen.push(`${path.relative(PLUGIN, full).replace(/\\/g, '/')} ${verdict(body)}`);
            i = end;
          }
        }
      }
    };
    walk(path.join(PLUGIN, dir));
  }
  assert.deepEqual(seen.filter((s) => !s.endsWith(' pass')).sort(), [...EXCERPTS].sort());
});
