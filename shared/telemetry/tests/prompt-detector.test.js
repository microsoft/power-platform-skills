"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { detectSlashCommand } = require("../lib/prompt-detector");

const TRACKED = { "add-seo": {}, "create-site": {}, "test-site": {} };
const OPTS = { pluginName: "power-pages", trackedSkills: TRACKED };

test("matches a bare slash command at start of prompt", () => {
  assert.equal(detectSlashCommand("/power-pages:add-seo", OPTS), "add-seo");
});

test("matches when followed by args", () => {
  assert.equal(
    detectSlashCommand("/power-pages:add-seo --foo bar", OPTS),
    "add-seo"
  );
});

test("matches when preceded by leading whitespace", () => {
  assert.equal(detectSlashCommand("  \n/power-pages:create-site", OPTS), "create-site");
});

test("matches when followed by newline", () => {
  assert.equal(detectSlashCommand("/power-pages:test-site\nmore text", OPTS), "test-site");
});

test("returns null for casual mid-sentence mention", () => {
  assert.equal(
    detectSlashCommand("I was thinking about /power-pages:add-seo earlier", OPTS),
    null
  );
});

test("returns null for unknown skill", () => {
  assert.equal(detectSlashCommand("/power-pages:not-a-real-skill", OPTS), null);
});

test("returns null for different plugin", () => {
  assert.equal(detectSlashCommand("/other-plugin:add-seo", OPTS), null);
});

test("returns null for substring skill name (add-seo-extra must not match add-seo)", () => {
  assert.equal(detectSlashCommand("/power-pages:add-seo-extra", OPTS), null);
});

test("returns null for empty string", () => {
  assert.equal(detectSlashCommand("", OPTS), null);
});

test("returns null for non-string prompt", () => {
  assert.equal(detectSlashCommand(null, OPTS), null);
  assert.equal(detectSlashCommand(undefined, OPTS), null);
  assert.equal(detectSlashCommand(42, OPTS), null);
});

test("case-sensitive: uppercase variants do not match", () => {
  assert.equal(detectSlashCommand("/Power-Pages:Add-SEO", OPTS), null);
});

test("respects trackedSkills parameter — 'add-seo' not tracked returns null", () => {
  const opts = { pluginName: "power-pages", trackedSkills: { "create-site": {} } };
  assert.equal(detectSlashCommand("/power-pages:add-seo", opts), null);
});
