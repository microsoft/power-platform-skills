#!/usr/bin/env node

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DATAVERSE_GUIDED_INSTALLS,
  DATAVERSE_INSTALLS,
  installCanonicalDataverse,
  parseInstallerOptions,
} = require("../install.js");

test("Dataverse companion is opt-in", () => {
  assert.deepEqual(parseInstallerOptions([]), { includeDataverse: false });
  assert.deepEqual(parseInstallerOptions(["--include-dataverse"]), {
    includeDataverse: true,
  });
});

test("uses canonical Dataverse marketplace identifiers", () => {
  assert.match(DATAVERSE_INSTALLS.claude.command, /dataverse@claude-plugins-official/);
  assert.match(DATAVERSE_INSTALLS.copilot.command, /dataverse@awesome-copilot/);
  assert.match(DATAVERSE_INSTALLS.codex.command, /dataverse@openai-curated/);
  assert.deepEqual(DATAVERSE_INSTALLS.codex.fallbackCommands, [
    'codex plugin marketplace add "microsoft/Dataverse-skills"',
    'codex plugin add "dataverse@dataverse-skills"',
  ]);
  assert.ok(DATAVERSE_GUIDED_INSTALLS.some((entry) => entry.includes("/add-plugin dataverse")));
});

test("verifies a successful Dataverse installation", () => {
  const commands = [];
  const runCommand = (command) => {
    commands.push(command);
    return commands.length === 1
      ? { ok: true, output: "installed" }
      : { ok: true, output: "dataverse@awesome-copilot" };
  };

  assert.equal(installCanonicalDataverse("copilot", runCommand), true);
  assert.deepEqual(commands, [
    DATAVERSE_INSTALLS.copilot.command,
    DATAVERSE_INSTALLS.copilot.listCommand,
  ]);
});

test("accepts an already-installed Dataverse plugin", () => {
  let call = 0;
  const runCommand = () => {
    call += 1;
    return call === 1
      ? { ok: false, output: "plugin already installed" }
      : { ok: true, output: "dataverse@claude-plugins-official" };
  };

  assert.equal(installCanonicalDataverse("claude", runCommand), true);
});

test("installs Dataverse directly from the OpenAI curated marketplace", () => {
  const commands = [];
  const runCommand = (command) => {
    commands.push(command);
    return { ok: true, output: command.includes("list") ? "dataverse" : "ok" };
  };

  assert.equal(installCanonicalDataverse("codex", runCommand), true);
  assert.deepEqual(commands, [
    DATAVERSE_INSTALLS.codex.command,
    DATAVERSE_INSTALLS.codex.listCommand,
  ]);
});

test("falls back to the canonical repository for stale Codex catalogs", () => {
  const commands = [];
  const runCommand = (command) => {
    commands.push(command);
    if (command.includes("@openai-curated")) {
      return { ok: false, output: "plugin not found" };
    }
    return { ok: true, output: command.includes("list") ? "dataverse" : "ok" };
  };

  assert.equal(installCanonicalDataverse("codex", runCommand), true);
  assert.deepEqual(commands, [
    DATAVERSE_INSTALLS.codex.command,
    ...DATAVERSE_INSTALLS.codex.fallbackCommands,
    DATAVERSE_INSTALLS.codex.listCommand,
  ]);
});

test("reports installation or verification failures", () => {
  assert.equal(
    installCanonicalDataverse("copilot", () => ({ ok: false, output: "network error" })),
    false
  );

  let call = 0;
  assert.equal(
    installCanonicalDataverse("copilot", () => {
      call += 1;
      return call === 1
        ? { ok: true, output: "installed" }
        : { ok: true, output: "canvas-apps" };
    }),
    false
  );
});
