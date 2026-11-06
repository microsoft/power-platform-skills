'use strict';
// What an agent routes on is the `description:` of each skill and agent, and the live routing eval measures
// that with a model. These offline tests pin what the descriptions must keep doing together, so an edit
// to one thing cannot quietly break the other:
//   1. they rule out what is not theirs — a generic or standalone React or web app, the other Power
//      Platform products, and a request that rules out Power Platform, Dataverse and model-driven apps
//      altogether — in words a request can be matched against;
//   2. they keep every phrase a positive case routes on, and the sentence that sends a request to the
//      other skill.
// Whether a model reads them the way they are meant is what `run-routing.js` is for.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { frontmatterDescription } = require('../run-routing.js');

const PLUGIN_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'plugins', 'model-apps');
const skillDescription = (name) => frontmatterDescription(fs.readFileSync(path.join(PLUGIN_DIR, 'skills', name, 'SKILL.md'), 'utf8'));
const AGENT_FILES = fs.readdirSync(path.join(PLUGIN_DIR, 'agents')).filter((f) => f.endsWith('.md')).sort();
const agentDescription = (file) => frontmatterDescription(fs.readFileSync(path.join(PLUGIN_DIR, 'agents', file), 'utf8'));

// The rule-out is worded around the request a user actually types ("No Power Platform, Dataverse or
// model-driven app"), and is not "when the user says not": a positive request can carry a "not" about the
// other skill ("do not create another app") or about the schema ("do not change its Dataverse schema").
const RULED_OUT = /rules out Power Platform, Dataverse, or model-driven apps \(for example "no Power Platform"\)/;
const NOT_GENERIC = /Do not use it for a generic(?: or standalone)? (?:React or web|web or React) app/;
const NOT_OTHER_PRODUCTS = /Power Pages, canvas apps, or Power Automate/;

test('the authoring skills rule out a generic web or React app and the other Power Platform products', () => {
  for (const skill of ['genpage', 'app-builder']) {
    const description = skillDescription(skill);
    assert.match(description, NOT_GENERIC, `${skill}: a generic or standalone React or web app`);
    assert.match(description, NOT_OTHER_PRODUCTS, `${skill}: Power Pages, canvas apps and Power Automate`);
    assert.match(description, RULED_OUT, `${skill}: a request that rules out Power Platform, Dataverse and model-driven apps`);
  }
});

test('/genpage says why it cannot take a standalone project, and where a Power Apps code app belongs', () => {
  const description = skillDescription('genpage');
  assert.match(description, /\(including a Power Apps code app\)/);
  assert.match(description, /A generative page only runs inside a model-driven app, and this skill cannot scaffold a standalone project/);
});

test('every agent description is scoped to generative pages of a model-driven app', () => {
  assert.ok(AGENT_FILES.length >= 6, `expected the plugin agents, found ${AGENT_FILES.join(', ')}`);
  for (const file of AGENT_FILES) {
    const description = agentDescription(file);
    assert.match(description, /Works only on generative pages in a Power Apps model-driven app\. Never use it for a generic React or web app/, file);
    assert.match(description, RULED_OUT, file);
  }
});

// Each phrase is one a committed positive case routes on; the second column says which kind of request
// loses its match if the phrase goes.
const KEPT = {
  genpage: [
    ['Creates, updates, and deploys Power Apps generative pages for model-driven apps', 'what the skill is'],
    ['build, retrieve, or update a page in an existing Microsoft Power Apps model-driven app', 'a page added to, or edited in, an app that already exists'],
    ['"generative page"', 'a request that names generative pages'],
    ['"page in a model-driven"', 'a request for a page in a model-driven app'],
    ['"genux"', 'a request that says genux'],
    ['use /app-builder instead', 'a whole app, which is not this skill'],
  ],
  'app-builder': [
    ['Builds and edits a model-driven Power Apps app from a natural-language intent', 'what the skill is'],
    ['tables, columns, relationships, adaptive forms with sub-grids, views, Choice-column charts, business rules, business process flows', 'a data-model or form edit, and a business process flow'],
    ['generative page intents for overview/dashboard surfaces', 'a whole app that also has a dashboard page'],
    ['an app module + sitemap', 'navigation of a new app'],
    ['can download a deployed app back into an editable spec to change it', 'a change to an app that is already deployed'],
    ['"build an app for X"', 'a request to build an app'],
    ['"create a model-driven app"', 'a request that names a model-driven app'],
    ['"make me an app to manage Y"', 'a request that does not name the platform'],
    ['"add a business process flow"', 'a business process flow added to an existing app'],
    ['"edit/add to my app"', 'an edit to an app'],
    ['use /genpage instead', 'a standalone page in an existing app, which is not this skill'],
  ],
};

for (const [skill, phrases] of Object.entries(KEPT)) {
  test(`/${skill} keeps every phrase a positive case routes on`, () => {
    const description = skillDescription(skill);
    for (const [phrase, why] of phrases) assert.ok(description.includes(phrase), `${skill}: "${phrase}" is gone — ${why}`);
  });
}

test('each skill still names the other in its boundary sentence, so the pair keeps pointing at each other', () => {
  assert.match(skillDescription('genpage'), /This skill stands alone and does not require \/app-builder/);
  assert.match(skillDescription('app-builder'), /This skill stands alone and does not require \/genpage/);
});

// ---------- the committed cases that guard those sentences ----------

const CASES = require('../evals.json').evals;
const NEGATIVES = CASES.filter((c) => c.expect === null);
const POSITIVES = CASES.filter((c) => c.expect !== null);
const RULES_OUT_THE_PLATFORM = /\b(?:no|not|nothing to do with)\b[^.]*\b(?:Power Platform|Power Apps|Dataverse|model-driven app)\b/i;
const NOT_ABOUT_THE_PLATFORM = /\b(?:Do not|not just|not a standalone)\b/;

test('the cases include a generic React request that rules out Power Platform, as a negative', () => {
  const generic = NEGATIVES.filter((c) => /generic React/i.test(c.prompt) && /\bNo Power Platform\b/.test(c.prompt));
  assert.equal(generic.length, 1, 'the request the rule-out sentences exist for');
  assert.ok(generic[0].trap, 'a negative says which mis-route it guards against');
});

test('the cases include several negatives that rule out the platform in words, and a stack the descriptions are written in', () => {
  const ruledOut = NEGATIVES.filter((c) => RULES_OUT_THE_PLATFORM.test(c.prompt));
  assert.ok(ruledOut.length >= 5, `expected at least 5 negatives that rule out Power Platform, Power Apps, Dataverse or a model-driven app, found ${ruledOut.length}`);
  assert.ok(NEGATIVES.some((c) => /Fluent UI/.test(c.prompt) && /React/.test(c.prompt)), 'a plain web app in the stack /genpage is described with');
  assert.ok(NEGATIVES.some((c) => /code app/i.test(c.prompt)), 'a Power Apps code app, which the /genpage description names as not its own');
  assert.ok(NEGATIVES.some((c) => /React/.test(c.prompt) && /app to manage/.test(c.prompt)), 'a generic "app to manage Y", which is the /app-builder trigger phrase');
});

test('the rule-out example the descriptions quote is in negatives only, and positives that carry a "not" about something else stay', () => {
  assert.deepEqual(POSITIVES.filter((c) => /\bno Power Platform\b/i.test(c.prompt)).map((c) => c.id), []);
  // A positive request can say "do not create another app" or "do not change its Dataverse schema". The
  // rule-out sentence must not be read widely enough to take those away.
  const withNot = POSITIVES.filter((c) => NOT_ABOUT_THE_PLATFORM.test(c.prompt));
  assert.ok(withNot.length >= 4, `expected at least 4 positives with a "not" about another skill or the schema, found ${withNot.length}`);
  assert.ok(withNot.some((c) => c.expect === 'genpage') && withNot.some((c) => c.expect === 'app-builder'), 'from both sides of the boundary');
  assert.ok(withNot.some((c) => /Dataverse/.test(c.prompt)), 'one that says "not" next to Dataverse');
});
