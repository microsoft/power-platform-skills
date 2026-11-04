'use strict';
// The /app-builder authoring flow OFFERS its optional capabilities (branding, configuration items, declared rules and flows,
// declared form and dashboard layouts) and never turns one on by default. No offline harness records a conversation, so the
// behaviour is pinned here as the instruction the flow gives the model: what is offered, when, and what happens on a yes, a
// "no" and an explicit request.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FLOW = path.join(__dirname, '..', '..', 'references', 'authoring-flow.md');
const SKILL = path.join(__dirname, '..', '..', 'skills', 'app-builder', 'SKILL.md');
// Line breaks and indentation are layout, not wording: compare each text with whitespace collapsed.
const squash = (text) => text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ');
const flow = fs.readFileSync(FLOW, 'utf8').replace(/\r\n/g, '\n');

// A level runs from its "### " heading to the next one; the "#### " subsections inside it do not end it.
function level(heading) {
  const start = flow.indexOf(`\n${heading}`);
  assert.notEqual(start, -1, `authoring-flow.md has no '${heading}' section`);
  const end = flow.indexOf('\n### ', start + 1);
  return squash(flow.slice(start, end < 0 ? undefined : end));
}

test('Level (a0) offers branding to every new app, and configuration items, duplicate detection, Custom APIs, rules and flows when the app needs them - none of it by default', () => {
  const a0 = level('### Level (a0)');
  assert.match(a0, /Offer each optional capability that applies — once, as a question, never as a default\./);
  assert.match(a0, /Ask even when the maker has not mentioned it/);
  assert.match(a0, /\*\*Branding\*\* — for every new app, ask whether it should be branded[^.]*\. If yes, add `app\.theme`/);
  assert.match(a0, /when the app calls an outside service or a value differs per environment[^.]*\), offer configuration items: environment variables and connection references/);
  assert.match(a0, /when the jobs include a validation or a guided process[^.]*\), offer a declared business rule or business process flow/);
  assert.match(a0, /Each one stays off unless the maker says yes or asks for it; a "no" or silence adds nothing to the spec/);
});

test('Level (a0): duplicate-detection rules and Custom APIs have their own triggers, not the outside-service one', () => {
  const a0 = level('### Level (a0)');
  // A self-contained intake app whose jobs identify duplicates, and an internal operation, call for these with no outside service
  // and no per-environment value.
  assert.match(a0, /\*\*Duplicate records\*\* — when the jobs identify duplicate records[^.]*\), offer a duplicate-detection rule on that table, even when the app uses no outside service/);
  assert.match(a0, /\*\*A reusable server-side operation\*\* — when the app needs an operation that several surfaces, flows or pages call, or that must run on the server[^.]*\), offer a Custom API, even when nothing outside Dataverse is involved/);
  const outside = a0.slice(a0.indexOf('**Outside services and per-environment values**'), a0.indexOf('**Duplicate records**'));
  assert.doesNotMatch(outside, /Custom API|duplicate-detection/);
});

test('Level (a0): the offers are not held back until the maker hints at them', () => {
  // An offer made only when the jobs or the maker's words already point to a capability never reaches a maker who does not know it exists.
  const a0 = level('### Level (a0)');
  assert.doesNotMatch(a0, /Ask only when the jobs or the maker's words point to it/);
  assert.doesNotMatch(a0, /Offer the optional capabilities the jobs point to/);
});

test('Level (b) offers declared layouts whenever forms or dashboards are proposed; a yes or an explicit request writes them and a "no" writes nothing declared', () => {
  const b = level('### Level (b)');
  assert.match(b, /Offer declared layouts, once, as a question — never as a default\./);
  assert.match(b, /Whenever you propose forms or dashboards, ask whether the maker wants the layout of any of them to stay as the spec says on every rebuild; if yes, write `reconcile: "declared"`/);
  // The declined path.
  assert.match(b, /Without a yes and without an explicit request, write nothing declared; forms stay `layout: "auto"`/);
  // The explicit-request path: it is the yes, so it is authored, and it must not be listed among the reasons to write nothing.
  assert.match(b, /A maker who already asked for a fixed layout is not asked again: their request is the yes/);
  assert.doesNotMatch(b, /Without a yes \(or when the maker already asked\), write nothing declared/);
  // Existing adoption approvals still apply.
  assert.match(b, /binding one that already exists needs an `--authorize adopt:` approval/);
});

test('Level (a0): an explicit request for a capability is acceptance, so it is not asked again', () => {
  const a0 = level('### Level (a0)');
  assert.match(a0, /skip an offer only for a capability the maker already asked for: an explicit request counts as acceptance/);
});

test('the skill names the offer as a way to a yes for each capability, and still adds none by default', () => {
  const skill = squash(fs.readFileSync(SKILL, 'utf8'));
  assert.match(skill, /says yes to the branding question you ask of every new app at the personas step/);
  assert.match(skill, /an ordinary app gets \*\*no\*\* `app\.theme` without one of those/);
  assert.match(skill, /or said yes when you offered it at Level \(b\)/);
  assert.match(skill, /Declared business rules[^]*?the offer at the personas step, or their own ask/);
  assert.match(skill, /Declared business process flows[^]*?the offer at the personas step, or their own ask/);
  assert.match(skill, /accepts your offer at the personas step/);
});
