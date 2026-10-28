'use strict';
// A look of the maker's own wins over the default model-driven look (AB#6320143). The skills used to turn every request for a style — a screenshot to follow, a website
// to match, a description — into the default model-driven styling: the rules said "tokens", the plan's Styling line was free prose the page-builder read as a wish, and
// nothing said a maker's look replaces the defaults. These tests hold the chain to one contract: the planner writes the look as a `Styling:` line that starts with
// `Maker-requested:` and gives concrete values, the plan schema defines that line, the page-builder applies it before the defaults, the edit planner does the same for a
// restyle, and references/rules.md says how to apply it within what a page can do — and says plainly what it cannot match.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(PLUGIN, ...parts), 'utf8').replace(/\r\n/g, '\n');
const flat = (text) => text.replace(/\s+/g, ' ');
const RULES = read('references', 'rules.md');
const HEADING = '### Maker-requested styling';

function section(text, heading) {
  const at = text.indexOf(heading);
  assert.ok(at >= 0, `the text has ${heading}`);
  const rest = text.slice(at + heading.length);
  return rest.slice(0, rest.search(/\n#{2,3} /));
}

test('rules.md: a Maker-requested style wins over the default look, and Rule 7 and the design principles say tokens are only the default', () => {
  const styling = RULES.slice(RULES.indexOf('## Layout and Styling'), RULES.indexOf('## Accessibility'));
  assert.ok(styling.includes(HEADING), 'the subsection is in Layout and Styling');
  const text = flat(section(RULES, HEADING));
  assert.match(text, /When the maker asks for a look of their own, that style wins over the default model-driven look\./);
  assert.match(text, /a `Styling:` line that starts with `Maker-requested:` and gives concrete values\. Apply each value\. Do not fall back to the default tokens for a value that the style sets:/);
  assert.match(text, /\*\*Colors\.\*\* Build a theme from the stated colors over `webLightTheme`/);
  assert.match(text, /Apply it with the `themeToVars` two-div wrapper/);
  assert.match(text, /\*\*Typography\.\*\* Set `fontFamily` on the page root to the stated font, with fallbacks/);
  assert.match(text, /\*\*What the style does not set\*\* keeps the default tokens/);
  assert.match(text, /\*\*No style asked for:\*\* keep the model-driven defaults/);
  const rule7 = /\n7\. \*\*Styling\*\*: ([^\n]+)/.exec(RULES)[1];
  assert.match(rule7, /Tokens give the default model-driven look\. When the plan's `## Design Preferences` → `Styling:` starts with `Maker-requested:`, apply that style instead/);
  assert.match(RULES, /- Use theme tokens \(e\.g\., `tokens\.spacingVerticalXL`, `tokens\.colorNeutralBackground1`\) — the default look when the maker asked for no style of their own/);
});

test('rules.md says plainly what a page cannot match', () => {
  const text = flat(section(RULES, HEADING));
  assert.match(text, /\*\*What cannot be matched\.\*\* Tell the maker when the request needs one of these:/);
  assert.match(text, /It cannot load a stylesheet, a CSS file, a web font, an image or a script from another site, and it cannot use another component library\./);
  assert.match(text, /A font that is not installed on the user's device shows its fallback\./);
  assert.match(text, /Only the page's own area gets the style\. The app header, the navigation and the command bar around the page keep the look of the app\./);
  assert.match(text, /A screenshot is matched by eye\./);
  assert.match(text, /Contrast stays at WCAG AA\./);
});

test('the example in rules.md keeps to the page rules: a theme over webLightTheme through themeToVars, with no FluentProvider, createTheme or external asset', () => {
  const block = /```typescript\n([\s\S]*?)```/.exec(section(RULES, HEADING));
  assert.ok(block, 'the subsection has an example');
  const code = block[1];
  assert.match(code, /import \{ webLightTheme \} from "@fluentui\/react-components";/);
  assert.match(code, /\.\.\.webLightTheme,/);
  assert.match(code, /themeToVars\(brandTheme\)/);
  assert.doesNotMatch(code, /FluentProvider|createTheme|mergeThemes|useTheme|@import|https?:\/\/|url\(/);
});

test('the plan schema defines the Maker-requested Styling line, and the defaults when no look is asked for', () => {
  const schema = flat(read('references', 'plan-schema.md'));
  assert.match(schema, /- Styling: \[EITHER `Maker-requested: <the look as concrete values — each color as a hex value with its role \(primary, accent, background, text\)/);
  assert.match(schema, /OR the model-driven defaults \(`Fluent UI V9 defaults`, plus any preference that does not replace that look\) when they did not\]/);
  assert.match(schema, /\| `## Design Preferences` \| Page-builder \| Prose, free-form; a `Styling:` line that starts with `Maker-requested:` wins over the default look/);
});

test('the planner turns a requested look into concrete values, the page-builder applies it before the defaults, and the edit planner does the same for a restyle', () => {
  const planner = flat(read('agents', 'genpage-planner.md'));
  assert.match(planner, /\*\*A look of the maker's own wins over the default model-driven look\.\*\*/);
  assert.match(planner, /write them in the plan's `## Design Preferences` as a `Styling:` line that starts with `Maker-requested:`\. Give each color as a hex value with its role/);
  assert.match(planner, /If you cannot open a website, ask the maker for a screenshot or for its colors and fonts\. Do not assume them\./);
  const builder = flat(read('agents', 'genpage-page-builder.md'));
  assert.match(builder, /A `Styling:` line that starts with `Maker-requested:` is the maker's own look, and it wins over the default model-driven styling\. Apply every value it gives/);
  assert.match(builder, /\*\*makeStyles with tokens\*\* — no inline styles for static values\. Tokens are the default look: a `Maker-requested:` style in the plan's Design Preferences replaces them for the values it sets/);
  const editPlanner = flat(read('agents', 'genpage-edit-planner.md'));
  assert.match(editPlanner, /When the maker asks to restyle the page — a screenshot, a website to match, a description — write the style as a line that starts with `Maker-requested:`/);
});
