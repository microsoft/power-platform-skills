"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { scrub } = require("../lib/scrubber");

test("scrub returns its input unchanged for strings", () => {
  assert.equal(scrub("hello world"), "hello world");
});

test("scrub returns its input unchanged for non-strings", () => {
  assert.equal(scrub(42), 42);
  assert.equal(scrub(null), null);
  assert.equal(scrub(undefined), undefined);
});

test("scrub never throws", () => {
  scrub({ nested: "obj" });
  scrub([]);
});
