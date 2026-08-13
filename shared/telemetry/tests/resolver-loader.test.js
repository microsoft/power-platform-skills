"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadResolver } = require("../lib/resolver-loader");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-rl-"));
}

test("loads a resolver.js sitting next to ikey.json", () => {
  const dir = mkTmp();
  fs.writeFileSync(
    path.join(dir, "resolver.js"),
    "module.exports = { resolve: async () => ({ iKey: 'k', collectorUrl: 'u' }), isProvisioned: () => true };"
  );
  const r = loadResolver(dir);
  assert.equal(typeof r.resolve, "function");
  assert.equal(r.isProvisioned({}), true);
});

test("returns null when no resolver.js is present", () => {
  assert.equal(loadResolver(mkTmp()), null);
});

test("returns null when the module throws on load", () => {
  const dir = mkTmp();
  fs.writeFileSync(path.join(dir, "resolver.js"), "throw new Error('boom');");
  assert.equal(loadResolver(dir), null);
});

test("returns null for a falsy dir", () => {
  assert.equal(loadResolver(""), null);
});
