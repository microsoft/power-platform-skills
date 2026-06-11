"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const agentInfo = require("../lib/agent-info");

function withClaudeCodeFixture(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-agent-"));
  fs.mkdirSync(path.join(tmp, "bin"));
  fs.writeFileSync(
    path.join(tmp, "package.json"),
    JSON.stringify({ name: "@anthropic-ai/claude-code", version: "2.0.0" })
  );
  const execPath = path.join(tmp, "bin", "claude.exe");
  fs.writeFileSync(execPath, "");
  try {
    fn({ tmp, execPath });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("readAiAgent returns Claude Code + version when CLAUDECODE=1 and pkg.json exists", () => {
  withClaudeCodeFixture(({ execPath }) => {
    const result = agentInfo.readAiAgent({
      CLAUDECODE: "1",
      CLAUDE_CODE_EXECPATH: execPath,
    });
    assert.deepEqual(result, { aiAgentName: "Claude Code", aiAgentVersion: "2.0.0" });
  });
});

test("readAiAgent returns Claude Code with empty version when EXECPATH missing and no AI_AGENT", () => {
  const result = agentInfo.readAiAgent({ CLAUDECODE: "1" });
  assert.deepEqual(result, { aiAgentName: "Claude Code", aiAgentVersion: "" });
});

test("readAiAgent falls back to AI_AGENT version on native installs (EXECPATH has no sibling package.json)", () => {
  // Native installer: execpath points at a standalone binary with no
  // ../package.json. The npm-layout read fails; AI_AGENT carries the version.
  const result = agentInfo.readAiAgent({
    CLAUDECODE: "1",
    CLAUDE_CODE_EXECPATH: path.join(os.tmpdir(), "does-not-exist", "bin", "claude.exe"),
    AI_AGENT: "claude-code_2-1-156_agent",
  });
  assert.deepEqual(result, { aiAgentName: "Claude Code", aiAgentVersion: "2.1.156" });
});

test("readAiAgent falls back to AI_AGENT version when EXECPATH is unset", () => {
  const result = agentInfo.readAiAgent({
    CLAUDECODE: "1",
    AI_AGENT: "claude-code_2-1-156_agent",
  });
  assert.deepEqual(result, { aiAgentName: "Claude Code", aiAgentVersion: "2.1.156" });
});

test("readAiAgent: npm package.json version wins over AI_AGENT when both available", () => {
  withClaudeCodeFixture(({ execPath }) => {
    const result = agentInfo.readAiAgent({
      CLAUDECODE: "1",
      CLAUDE_CODE_EXECPATH: execPath, // package.json says 2.0.0
      AI_AGENT: "claude-code_9-9-9_agent",
    });
    assert.equal(result.aiAgentVersion, "2.0.0");
  });
});

test("readAiAgent: AI_AGENT with no parseable version yields empty version", () => {
  const result = agentInfo.readAiAgent({
    CLAUDECODE: "1",
    AI_AGENT: "claude-code_agent", // no numeric version segment
  });
  assert.deepEqual(result, { aiAgentName: "Claude Code", aiAgentVersion: "" });
});

test("readAiAgent: AI_AGENT fallback also backfills when only AI_AGENT_NAME is set", () => {
  const result = agentInfo.readAiAgent({
    AI_AGENT_NAME: "Claude Code",
    // No AI_AGENT_VERSION, no resolvable EXECPATH
    CLAUDECODE: "1",
    AI_AGENT: "claude-code_2-1-156_agent",
  });
  assert.deepEqual(result, { aiAgentName: "Claude Code", aiAgentVersion: "2.1.156" });
});

test("readAiAgent returns empty when CLAUDECODE not set and no explicit env", () => {
  const result = agentInfo.readAiAgent({});
  assert.deepEqual(result, { aiAgentName: "", aiAgentVersion: "" });
});

test("readAiAgent honours explicit AI_AGENT_NAME / AI_AGENT_VERSION", () => {
  const result = agentInfo.readAiAgent({
    AI_AGENT_NAME: "Custom Agent",
    AI_AGENT_VERSION: "3.1.4",
  });
  assert.deepEqual(result, { aiAgentName: "Custom Agent", aiAgentVersion: "3.1.4" });
});

test("readAiAgent backfills aiAgentVersion from CLAUDECODE when only AI_AGENT_NAME is set", () => {
  withClaudeCodeFixture(({ execPath }) => {
    const result = agentInfo.readAiAgent({
      AI_AGENT_NAME: "Claude Code",
      // No AI_AGENT_VERSION
      CLAUDECODE: "1",
      CLAUDE_CODE_EXECPATH: execPath,
    });
    assert.deepEqual(result, { aiAgentName: "Claude Code", aiAgentVersion: "2.0.0" });
  });
});

test("readAiAgent backfills aiAgentVersion from COPILOT_CLI when only AI_AGENT_NAME is set", () => {
  const result = agentInfo.readAiAgent({
    AI_AGENT_NAME: "Copilot CLI",
    // No AI_AGENT_VERSION
    COPILOT_CLI: "1",
    COPILOT_CLI_BINARY_VERSION: "1.2.3",
  });
  assert.deepEqual(result, { aiAgentName: "Copilot CLI", aiAgentVersion: "1.2.3" });
});

test("readAiAgent returns explicit AI_AGENT_VERSION even when CLAUDECODE detect could also resolve", () => {
  // Explicit version wins over backfill
  withClaudeCodeFixture(({ execPath }) => {
    const result = agentInfo.readAiAgent({
      AI_AGENT_NAME: "Claude Code",
      AI_AGENT_VERSION: "99.99.99-explicit",
      CLAUDECODE: "1",
      CLAUDE_CODE_EXECPATH: execPath,
    });
    assert.equal(result.aiAgentVersion, "99.99.99-explicit");
  });
});

test("readAiAgent returns empty version when AI_AGENT_NAME set but no detector matches", () => {
  const result = agentInfo.readAiAgent({
    AI_AGENT_NAME: "Mystery Agent",
    // No CLAUDECODE, no COPILOT_CLI
  });
  assert.deepEqual(result, { aiAgentName: "Mystery Agent", aiAgentVersion: "" });
});

test("readAiAgent: explicit AI_AGENT_NAME wins over CLAUDECODE", () => {
  const result = agentInfo.readAiAgent({
    CLAUDECODE: "1",
    AI_AGENT_NAME: "Custom Agent",
    AI_AGENT_VERSION: "9.9.9",
  });
  assert.deepEqual(result, { aiAgentName: "Custom Agent", aiAgentVersion: "9.9.9" });
});

test("readAiAgent returns Copilot CLI + version when COPILOT_CLI=1", () => {
  const result = agentInfo.readAiAgent({
    COPILOT_CLI: "1",
    COPILOT_CLI_BINARY_VERSION: "1.0.48-2",
  });
  assert.deepEqual(result, {
    aiAgentName: "Copilot CLI",
    aiAgentVersion: "1.0.48-2",
  });
});

test("readAiAgent returns Copilot CLI with empty version when COPILOT_CLI_BINARY_VERSION missing", () => {
  const result = agentInfo.readAiAgent({ COPILOT_CLI: "1" });
  assert.deepEqual(result, { aiAgentName: "Copilot CLI", aiAgentVersion: "" });
});

test("readAiAgent: explicit AI_AGENT_NAME wins over COPILOT_CLI", () => {
  const result = agentInfo.readAiAgent({
    COPILOT_CLI: "1",
    COPILOT_CLI_BINARY_VERSION: "1.0.48-2",
    AI_AGENT_NAME: "Custom Agent",
    AI_AGENT_VERSION: "9.9.9",
  });
  assert.deepEqual(result, { aiAgentName: "Custom Agent", aiAgentVersion: "9.9.9" });
});

test("readAiAgent: CLAUDECODE wins over COPILOT_CLI when both set", () => {
  const result = agentInfo.readAiAgent({
    CLAUDECODE: "1",
    COPILOT_CLI: "1",
    COPILOT_CLI_BINARY_VERSION: "1.0.48-2",
  });
  assert.equal(result.aiAgentName, "Claude Code");
});

test("readAiAgent returns Copilot CLI when COPILOT_CLI is truthy", () => {
  const result = agentInfo.readAiAgent({
    COPILOT_CLI: "true",
    COPILOT_CLI_VERSION: "1.0.57",
  });
  assert.deepEqual(result, {
    aiAgentName: "Copilot CLI",
    aiAgentVersion: "1.0.57",
  });
});

test("readAiAgent returns Codex from CODEX_CLI env", () => {
  const result = agentInfo.readAiAgent({
    CODEX_CLI: "1",
    CODEX_CLI_VERSION: "0.8.1",
  });
  assert.deepEqual(result, {
    aiAgentName: "Codex",
    aiAgentVersion: "0.8.1",
  });
});

test("readAiAgent returns OpenCode from OPENCODE env", () => {
  const result = agentInfo.readAiAgent({
    OPENCODE: "1",
    OPENCODE_VERSION: "2.3.4",
  });
  assert.deepEqual(result, {
    aiAgentName: "OpenCode",
    aiAgentVersion: "2.3.4",
  });
});

test("readAiAgent returns Hermes from HERMES_AGENT env", () => {
  const result = agentInfo.readAiAgent({
    HERMES_AGENT: "1",
    HERMES_AGENT_VERSION: "3.4.5",
  });
  assert.deepEqual(result, {
    aiAgentName: "Hermes",
    aiAgentVersion: "3.4.5",
  });
});

test("readAiAgent returns OpenClaw from OPENCLAW_CLI env", () => {
  const result = agentInfo.readAiAgent({
    OPENCLAW_CLI: "1",
    OPENCLAW_CLI_BINARY_VERSION: "4.5.6",
  });
  assert.deepEqual(result, {
    aiAgentName: "OpenClaw",
    aiAgentVersion: "4.5.6",
  });
});

test("readAiAgent detects known agent and version from AI_AGENT", () => {
  const result = agentInfo.readAiAgent({
    AI_AGENT: "opencode_2-1-0_agent",
  });
  assert.deepEqual(result, {
    aiAgentName: "OpenCode",
    aiAgentVersion: "2.1.0",
  });
});

test("readAiAgent backfills explicit known agent version from matching env", () => {
  const result = agentInfo.readAiAgent({
    AI_AGENT_NAME: "Codex",
    CODEX_CLI_VERSION: "0.9.0",
  });
  assert.deepEqual(result, {
    aiAgentName: "Codex",
    aiAgentVersion: "0.9.0",
  });
});

test("readAiAgent ignores falsey known-agent env flags", () => {
  const result = agentInfo.readAiAgent({
    CODEX_CLI: "0",
    OPENCODE: "false",
  });
  assert.deepEqual(result, { aiAgentName: "", aiAgentVersion: "" });
});

test("readPacCliVersion parses semver from pac --version output", () => {
  agentInfo._resetCache();
  const result = agentInfo.readPacCliVersion({
    _exec: () => "Microsoft PowerPlatform CLI Version: 1.36.0",
  });
  assert.equal(result, "1.36.0");
});

test("readPacCliVersion returns empty string when pac is missing", () => {
  agentInfo._resetCache();
  const result = agentInfo.readPacCliVersion({
    _exec: () => {
      const e = new Error("ENOENT");
      e.code = "ENOENT";
      throw e;
    },
  });
  assert.equal(result, "");
});

test("readPacCliVersion returns empty string when output unparseable", () => {
  agentInfo._resetCache();
  const result = agentInfo.readPacCliVersion({
    _exec: () => "no version here",
  });
  assert.equal(result, "");
});

test("readPacCliVersion caches result across calls", () => {
  agentInfo._resetCache();
  let calls = 0;
  const exec = () => {
    calls++;
    return "Microsoft PowerPlatform CLI Version: 1.36.0";
  };
  agentInfo.readPacCliVersion({ _exec: exec });
  agentInfo.readPacCliVersion({ _exec: exec });
  assert.equal(calls, 1, "second call should hit cache");
});

test("readPacCliVersion respects _exec=false short-circuit", () => {
  agentInfo._resetCache();
  const result = agentInfo.readPacCliVersion({ _exec: false });
  assert.equal(result, "");
});

test("readPacCliVersion parses version from err.stdout when pac exits non-zero (PAC 2.x behavior)", () => {
  // PAC 2.x prints the version banner to stdout but exits with status 1
  // because it treats `--version` as an unknown command. execFileSync
  // throws on non-zero exit; we must read err.stdout for the banner.
  agentInfo._resetCache();
  const result = agentInfo.readPacCliVersion({
    _exec: () => {
      const e = new Error("Command failed: pac --version");
      e.status = 1;
      e.stdout =
        "Microsoft PowerPlatform CLI\n" +
        "Version: 2.7.4+g06bb2eb (.NET Framework 4.8.9332.0)\n" +
        "Online documentation: https://aka.ms/PowerPlatformCLI\n";
      throw e;
    },
  });
  assert.equal(result, "2.7.4");
});

test("readPacCliVersion prefers PAC version line over .NET Framework version", () => {
  agentInfo._resetCache();
  const result = agentInfo.readPacCliVersion({
    _exec: () =>
      "Microsoft PowerPlatform CLI\n" +
      "Version: 2.7.4+g06bb2eb (.NET Framework 4.8.9332.0)\n",
  });
  assert.equal(result, "2.7.4");
});
