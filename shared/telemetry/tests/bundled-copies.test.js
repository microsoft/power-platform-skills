"use strict";

// Every adopting plugin ships a physical copy of shared/telemetry/lib at
// plugins/<plugin>/scripts/lib/telemetry/lib, because a marketplace install copies only the
// plugin directory. Only some adopters guard their copy in their own suite, and those suites
// run only when the plugin itself changes, so an edit to the shared source that skipped a
// copy (or an edit to one copy alone) could merge green. The shared-telemetry-tests workflow
// runs on a change to either side, and this test compares every copy with the source there.
//
// Line endings are normalized: a Windows checkout may convert them, and that is not drift.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SOURCE = path.join(REPO_ROOT, "shared", "telemetry", "lib");
const COPY_PATH = ["scripts", "lib", "telemetry", "lib"];

function listFiles(dir, prefix = "") {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(path.join(dir, entry.name), rel) : [rel];
  }).sort();
}

const text = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

function copyProblems(source, copy) {
  const sourceFiles = listFiles(source);
  const copyFiles = listFiles(copy);
  const problems = [
    ...sourceFiles.filter((f) => !copyFiles.includes(f)).map((f) => `missing ${f}`),
    ...copyFiles.filter((f) => !sourceFiles.includes(f)).map((f) => `extra ${f}`),
  ];
  for (const f of sourceFiles) {
    if (copyFiles.includes(f) && text(path.join(source, f)) !== text(path.join(copy, f))) problems.push(`differs ${f}`);
  }
  return problems;
}

function adopterCopies() {
  const plugins = path.join(REPO_ROOT, "plugins");
  return fs.readdirSync(plugins, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(plugins, entry.name, ...COPY_PATH))
    .filter((dir) => fs.existsSync(dir));
}

test("every adopting plugin bundles an identical copy of shared/telemetry/lib", () => {
  const copies = adopterCopies();
  assert.ok(copies.length > 0, "found no plugins/*/scripts/lib/telemetry/lib copy; if the layout changed, update this test");
  const drift = copies.flatMap((copy) => copyProblems(SOURCE, copy)
    .map((problem) => `${path.relative(REPO_ROOT, copy).split(path.sep).join("/")}: ${problem}`));
  assert.deepEqual(drift, [], "re-copy shared/telemetry/lib into every adopting plugin");
});

test("the copy check reports missing, extra and changed files but not line endings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-copies-"));
  try {
    const source = path.join(root, "source");
    const copy = path.join(root, "copy");
    fs.mkdirSync(path.join(source, "nested"), { recursive: true });
    fs.writeFileSync(path.join(source, "a.js"), "one\ntwo\n");
    fs.writeFileSync(path.join(source, "nested", "b.js"), "b\n");
    fs.cpSync(source, copy, { recursive: true });
    assert.deepEqual(copyProblems(source, copy), []);
    fs.writeFileSync(path.join(copy, "a.js"), "one\r\ntwo\r\n");
    assert.deepEqual(copyProblems(source, copy), [], "CRLF alone is not drift");
    fs.writeFileSync(path.join(copy, "a.js"), "one\ntwo changed\n");
    fs.rmSync(path.join(copy, "nested", "b.js"));
    fs.writeFileSync(path.join(copy, "stray.js"), "x\n");
    assert.deepEqual(copyProblems(source, copy), ["missing nested/b.js", "extra stray.js", "differs a.js"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
