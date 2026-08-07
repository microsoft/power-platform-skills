"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { detectSiteFramework } = require("../lib/detect-site-framework");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-fw-"));
}

// Builds a Power Pages code site on disk: the `powerpages.config.json` marker
// plus a package.json carrying `deps` as its dependencies.
function mkSite(root, deps, { config = true, pkg = true } = {}) {
  fs.mkdirSync(root, { recursive: true });
  if (config) {
    fs.writeFileSync(
      path.join(root, "powerpages.config.json"),
      JSON.stringify({ siteName: "Test Site", compiledPath: "dist" })
    );
  }
  if (pkg) {
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "test-site", private: true, dependencies: deps })
    );
  }
  return root;
}

test("detects each supported framework from its scaffold dependencies", () => {
  const cases = [
    ["react", { react: "^19.0.0", "react-dom": "^19.0.0", "react-router-dom": "^7.1.0" }],
    ["vue", { vue: "^3.5.0", "vue-router": "^4.5.0" }],
    ["angular", { "@angular/core": "^19.1.0", "@angular/router": "^19.1.0", rxjs: "~7.8.0" }],
    ["astro", { astro: "^7.1.0" }],
  ];
  for (const [expected, deps] of cases) {
    const root = mkSite(path.join(mkTmp(), "site"), deps);
    assert.equal(detectSiteFramework(root), expected, `expected ${expected}`);
  }
});

test("detects framework declared only in devDependencies", () => {
  const root = path.join(mkTmp(), "site");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "powerpages.config.json"), "{}");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ devDependencies: { vue: "^3.5.0" } })
  );
  assert.equal(detectSiteFramework(root), "vue");
});

test("finds a site in a CHILD of cwd — the recommended create-site layout", () => {
  // Regression guard for the dominant real-world case: create-site's recommended
  // "New folder in current directory" option puts powerpages.config.json one
  // level BELOW the host session cwd, and the skill's `cd <PROJECT_ROOT>` runs in
  // a Bash subshell that never moves that cwd. An upward-only root walk reports
  // null here and silently under-reports the metric for most users.
  const parent = mkTmp();
  mkSite(path.join(parent, "contoso-portal"), { react: "^19.0.0" });
  assert.equal(detectSiteFramework(parent), "react");
});

test("walks up from a nested directory inside the site", () => {
  const root = mkSite(path.join(mkTmp(), "site"), { astro: "^7.1.0" });
  const nested = path.join(root, "src", "pages", "deep");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(detectSiteFramework(nested), "astro");
});

test("prefers astro over a React integration dependency in the same site", () => {
  // An Astro site may declare @astrojs/react + react for island components; it is
  // still an Astro site. Marker order in detect-site-framework.js encodes this.
  const root = mkSite(path.join(mkTmp(), "site"), {
    astro: "^7.1.0",
    "@astrojs/react": "^4.0.0",
    react: "^19.0.0",
  });
  assert.equal(detectSiteFramework(root), "astro");
});

test("returns null for a project that is not a Power Pages code site", () => {
  // package.json present, powerpages.config.json absent — an unrelated repo the
  // user happens to be sitting in must not pollute the framework metric.
  const root = mkSite(path.join(mkTmp(), "not-a-site"), { react: "^19.0.0" }, { config: false });
  assert.equal(detectSiteFramework(root), null);
});

test("returns null for a declarative .powerpages-site/ project", () => {
  // findProjectRoot also matches .powerpages-site/ (design-studio sites via
  // `pac pages download`). Those have no SPA framework, so they must not fall
  // through to a package.json probe.
  const root = path.join(mkTmp(), "declarative");
  fs.mkdirSync(path.join(root, ".powerpages-site", ".portalconfig"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" } }));
  assert.equal(detectSiteFramework(root), null);
});

test("returns null when the site has no package.json", () => {
  const root = mkSite(path.join(mkTmp(), "site"), null, { pkg: false });
  assert.equal(detectSiteFramework(root), null);
});

test("returns null when package.json is malformed", () => {
  const root = path.join(mkTmp(), "site");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "powerpages.config.json"), "{}");
  fs.writeFileSync(path.join(root, "package.json"), "{ not valid json");
  assert.equal(detectSiteFramework(root), null);
});

test("returns null when no recognized framework dependency is present", () => {
  // Includes the AngularJS 1.x trap: `angular` is NOT the Angular marker.
  const root = mkSite(path.join(mkTmp(), "site"), { angular: "^1.8.0", lodash: "^4.0.0" });
  assert.equal(detectSiteFramework(root), null);
});

test("returns null instead of throwing for a nonexistent directory", () => {
  assert.equal(detectSiteFramework(path.join(mkTmp(), "does-not-exist")), null);
});
