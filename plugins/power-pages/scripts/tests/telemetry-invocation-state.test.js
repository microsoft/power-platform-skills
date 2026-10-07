"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const state = require("../lib/telemetry/invocation-state");

test("persists correlation state without storing the project path", (t) => {
  const original = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-state-"));
  const projectRoot = path.join(configDir, "customer-project");
  process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = configDir;
  t.after(() => {
    if (original === undefined) {
      delete process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
    } else {
      process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = original;
    }
  });

  const now = Date.now();
  assert.equal(state.projectHash({ invalid: "cwd" }), "");
  assert.equal(
    state.recordStart(
      "add-localization",
      "invalid-project-session",
      { invalid: "cwd" },
      now
    ),
    null
  );
  const file = state.recordStart(
    "add-localization",
    "host-session-123",
    projectRoot,
    now
  );
  assert.ok(file);
  const raw = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(raw, /customer-project/);
  assert.equal(state.findActive("add-localization", projectRoot).sessionId, "host-session-123");

  state.markConfigured("add-localization", projectRoot, now + 1);
  const configured = state.findActive(
    "add-localization",
    projectRoot,
    { requireConfigured: true }
  );
  assert.equal(configured.configuredAt, now + 1);
  assert.equal(
    state.findActive("add-localization", projectRoot, {
      requireConfigured: true,
      sessionId: "different-session",
    }),
    null
  );

  state.removeState(configured);
  assert.equal(
    state.findActive("add-localization", projectRoot, { requireConfigured: true }),
    null
  );
});

test("binds one pending invocation to the resolved project root", (t) => {
  const original = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-state-"));
  const projectRoot = path.join(configDir, "resolved-project");
  process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = configDir;
  t.after(() => {
    if (original === undefined) {
      delete process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
    } else {
      process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = original;
    }
  });

  const pendingFile = state.recordPendingStart(
    "add-localization",
    "pending-session"
  );
  assert.ok(pendingFile);
  const raw = fs.readFileSync(pendingFile, "utf8");
  assert.doesNotMatch(raw, /resolved-project/);
  assert.equal(JSON.parse(raw).projectHash, undefined);

  const bound = state.bindPending("add-localization", projectRoot);
  assert.equal(bound.sessionId, "pending-session");
  assert.equal(bound.projectHash, state.projectHash(projectRoot));
  assert.equal(fs.existsSync(pendingFile), false);
});

test("does not guess when multiple project-less invocations are pending", (t) => {
  const original = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-state-"));
  process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = configDir;
  t.after(() => {
    if (original === undefined) {
      delete process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
    } else {
      process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = original;
    }
  });

  state.recordPendingStart("add-localization", "first-session");
  state.recordPendingStart("add-localization", "second-session");

  assert.equal(
    state.bindPending(
      "add-localization",
      path.join(configDir, "ambiguous-project")
    ),
    null
  );
});

test("does not bind over an existing project invocation", (t) => {
  const original = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-state-"));
  const projectRoot = path.join(configDir, "shared-project");
  process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = configDir;
  t.after(() => {
    if (original === undefined) {
      delete process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
    } else {
      process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = original;
    }
  });

  state.recordStart("add-localization", "bound-session", projectRoot);
  state.recordPendingStart("add-localization", "pending-session");

  assert.equal(
    state.findOrBindActive("add-localization", projectRoot),
    null
  );
});

test("rejects ambiguous project-only matches", (t) => {
  const original = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-state-"));
  const projectRoot = path.join(configDir, "shared-project");
  process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = configDir;
  t.after(() => {
    if (original === undefined) {
      delete process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
    } else {
      process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = original;
    }
  });

  state.recordStart("add-localization", "first-session", projectRoot);
  state.recordStart("add-localization", "second-session", projectRoot);

  assert.equal(state.findActive("add-localization", projectRoot), null);
  assert.equal(
    state.findActive(
      "add-localization",
      projectRoot,
      { sessionId: "first-session" }
    ).sessionId,
    "first-session"
  );
});

test("keeps projects separate when a host session is reused", (t) => {
  const original = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-state-"));
  process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = configDir;
  t.after(() => {
    if (original === undefined) {
      delete process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
    } else {
      process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = original;
    }
  });

  const firstRoot = path.join(configDir, "first-project");
  const secondRoot = path.join(configDir, "second-project");
  const now = Date.now();
  state.recordStart("add-localization", "shared-session", firstRoot, now);
  state.recordStart("add-localization", "shared-session", secondRoot, now + 1);

  assert.equal(state.findActive("add-localization", undefined), null);
  assert.equal(state.findActive("add-localization", { invalid: true }), null);
  assert.equal(
    state.findActive(
      "add-localization",
      firstRoot,
      { sessionId: "different-session" }
    ),
    null
  );
  assert.equal(
    state.findActive(
      "add-localization",
      path.join(configDir, "unrelated-project"),
      { sessionId: "shared-session" }
    ),
    null
  );
  const first = state.findActive(
    "add-localization",
    firstRoot,
    { sessionId: "shared-session" }
  );
  const second = state.findActive(
    "add-localization",
    secondRoot,
    { sessionId: "shared-session" }
  );
  assert.equal(first.projectHash, state.projectHash(firstRoot));
  assert.equal(second.projectHash, state.projectHash(secondRoot));
  assert.notEqual(first.file, second.file);
  assert.equal(
    fs.readdirSync(path.dirname(first.file))
      .filter((entry) => entry.endsWith(".json")).length,
    2
  );
  assert.equal(
    state.findActive(
      "add-localization",
      undefined,
      { sessionId: "shared-session", allowSessionOnly: true }
    ),
    null
  );
  assert.equal(
    state.findActive(
      "add-localization",
      path.join(configDir, "unrelated-project"),
      { allowLatestFallback: true }
    ).sessionId,
    "shared-session"
  );

  state.removeState(first);
  assert.equal(
    state.findActive(
      "add-localization",
      firstRoot,
      { sessionId: "shared-session" }
    ),
    null
  );
  assert.equal(
    state.findActive(
      "add-localization",
      secondRoot,
      { sessionId: "shared-session" }
    ).projectHash,
    state.projectHash(secondRoot)
  );
  assert.equal(
    state.findActive(
      "add-localization",
      undefined,
      { sessionId: "shared-session", allowSessionOnly: true }
    ).projectHash,
    state.projectHash(secondRoot)
  );
});

test("migrates a matching legacy state file when configuration is marked", (t) => {
  const original = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-state-"));
  const projectRoot = path.join(configDir, "legacy-project");
  const legacyDir = path.join(
    configDir,
    "telemetry",
    "power-pages",
    "invocations",
    "add-localization"
  );
  const legacyFile = path.join(legacyDir, "legacy-session.json");
  process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = configDir;
  t.after(() => {
    if (original === undefined) {
      delete process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
    } else {
      process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = original;
    }
  });

  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(legacyFile, JSON.stringify({
    sessionId: "legacy-session",
    startedAt: Date.now(),
    projectHash: state.projectHash(projectRoot),
  }));

  const migratedFile = state.markConfigured(
    "add-localization",
    projectRoot
  );

  assert.ok(migratedFile);
  assert.notEqual(migratedFile, legacyFile);
  assert.equal(fs.existsSync(legacyFile), false);
  assert.ok(fs.existsSync(migratedFile));
});
