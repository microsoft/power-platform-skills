"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { detectSiteFramework } = require("../lib/detect-site-framework");
const PLUGIN_ROOT = path.resolve(__dirname, "..", "..");

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
    ["react", { react: "^19.0.0", "@vitejs/plugin-react": "^4.3.0" }],
    ["vue", { vue: "^3.5.0", "@vitejs/plugin-vue": "^5.2.0" }],
    ["angular", { "@angular/core": "^19.1.0", "@angular/router": "^19.1.0", rxjs: "~7.8.0" }],
    ["astro", { astro: "^7.1.0" }],
  ];
  for (const [expected, deps] of cases) {
    const root = mkSite(path.join(mkTmp(), "site"), deps);
    assert.equal(detectSiteFramework(root), expected, `expected ${expected}`);
  }
});

test("detects every shipped create-site scaffold manifest", () => {
  for (const expected of ["react", "vue", "angular", "astro"]) {
    const root = path.join(mkTmp(), "site");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "powerpages.config.json"), "{}");
    fs.copyFileSync(
      path.join(
        PLUGIN_ROOT,
        "skills",
        "create-site",
        "assets",
        expected,
        "package.json"
      ),
      path.join(root, "package.json")
    );
    assert.equal(detectSiteFramework(root), expected, `expected ${expected}`);
  }
});

test("detects framework declared only in devDependencies", () => {
  const root = path.join(mkTmp(), "site");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "powerpages.config.json"), "{}");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ devDependencies: { "@vitejs/plugin-vue": "^5.2.0" } })
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
  mkSite(path.join(parent, "contoso-portal"), {
    react: "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
  });
  assert.equal(detectSiteFramework(parent), "react");
});

test("returns null when cwd contains multiple child sites", () => {
  // Hook payloads identify only cwd, not which child a skill will target. The
  // filesystem's first directory entry is not a safe attribution signal.
  const parent = mkTmp();
  mkSite(path.join(parent, "react-portal"), { react: "^19.0.0" });
  mkSite(path.join(parent, "vue-portal"), { "@vitejs/plugin-vue": "^5.2.0" });
  assert.equal(detectSiteFramework(parent), null);
});

test("returns null when child workspace mixes code and declarative sites", () => {
  const parent = mkTmp();
  mkSite(path.join(parent, "react-portal"), {
    react: "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
  });
  fs.mkdirSync(
    path.join(parent, "declarative-portal", ".powerpages-site", ".portalconfig"),
    { recursive: true }
  );
  assert.equal(detectSiteFramework(parent), null);
});

test("returns null inside a declarative site nested under a code site", () => {
  const codeRoot = mkSite(path.join(mkTmp(), "code-site"), {
    react: "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
  });
  const declarativeRoot = path.join(codeRoot, "declarative-site");
  const nested = path.join(declarativeRoot, ".powerpages-site", ".portalconfig");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(detectSiteFramework(nested), null);
});

test("detects a code child that also contains a declarative marker", () => {
  const parent = mkTmp();
  const site = mkSite(path.join(parent, "react-portal"), {
    react: "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
  });
  fs.mkdirSync(path.join(site, ".powerpages-site"), { recursive: true });
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
    "@vitejs/plugin-react": "^4.3.0",
  });
  assert.equal(detectSiteFramework(root), "astro");
});

test("uses scaffold tooling when a React site also consumes Vue", () => {
  const root = mkSite(path.join(mkTmp(), "site"), {
    react: "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    vue: "^3.5.0",
  });
  assert.equal(detectSiteFramework(root), "react");
});

test("returns null when non-Astro scaffold markers conflict", () => {
  const root = mkSite(path.join(mkTmp(), "site"), {
    react: "^19.0.0",
    vue: "^3.5.0",
    "@vitejs/plugin-react": "^4.3.0",
    "@vitejs/plugin-vue": "^5.2.0",
  });
  assert.equal(detectSiteFramework(root), null);
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

test("returns null when powerpages.config.json is malformed", () => {
  const root = mkSite(path.join(mkTmp(), "site"), {
    "@vitejs/plugin-react": "^4.3.0",
  });
  fs.writeFileSync(path.join(root, "powerpages.config.json"), "{ not valid json");
  assert.equal(detectSiteFramework(root), null);
});

test("returns null when powerpages.config.json is a directory", () => {
  const root = mkSite(
    path.join(mkTmp(), "site"),
    { "@vitejs/plugin-react": "^4.3.0" },
    { config: false }
  );
  fs.mkdirSync(path.join(root, "powerpages.config.json"));
  assert.equal(detectSiteFramework(root), null);
});

test("returns null when framework dependency values are not non-empty strings", () => {
  for (const invalid of [null, "", "   ", false, 0, {}]) {
    const root = mkSite(path.join(mkTmp(), "site"), {
      "@vitejs/plugin-react": invalid,
    });
    assert.equal(
      detectSiteFramework(root),
      null,
      `expected ${JSON.stringify(invalid)} to be rejected`
    );
  }
});

test("returns null when no recognized framework dependency is present", () => {
  // Includes the AngularJS 1.x trap: `angular` is NOT the Angular marker.
  const root = mkSite(path.join(mkTmp(), "site"), { angular: "^1.8.0", lodash: "^4.0.0" });
  assert.equal(detectSiteFramework(root), null);
});

test("returns null instead of throwing for a nonexistent directory", () => {
  assert.equal(detectSiteFramework(path.join(mkTmp(), "does-not-exist")), null);
});
