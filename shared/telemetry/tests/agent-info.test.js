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

test("readAiAgent returns Claude Code with empty version when EXECPATH missing", () => {
  const result = agentInfo.readAiAgent({ CLAUDECODE: "1" });
  assert.deepEqual(result, { aiAgentName: "Claude Code", aiAgentVersion: "" });
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

test("readAiAgent: explicit AI_AGENT_NAME wins over CLAUDECODE", () => {
  const result = agentInfo.readAiAgent({
    CLAUDECODE: "1",
    AI_AGENT_NAME: "Custom Agent",
    AI_AGENT_VERSION: "9.9.9",
  });
  assert.deepEqual(result, { aiAgentName: "Custom Agent", aiAgentVersion: "9.9.9" });
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
