"use strict";

// The PostToolUse validator hook resolves the plugin root from its own directory
// (hooks/ -> scripts/lib/modelapps-hook-utils.js -> skills/). Spawning the checked-in
// hook would discover the real skills tree, which has no synthetic validators. Stage
// a temp plugin that contains a byte copy of the real hook plus synthetic skills.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PLUGIN_ROOT = path.resolve(__dirname, "..", "..");
const REAL_HOOK = path.join(PLUGIN_ROOT, "hooks", "run-skill-posttool-validation.js");
const HOOKS_JSON = path.join(PLUGIN_ROOT, "hooks", "hooks.json");

const dirs = [];
test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mkTemp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modelapps-posttool-"));
  dirs.push(dir);
  return dir;
}

function stagePlugin() {
  const root = mkTemp();
  fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
  fs.copyFileSync(REAL_HOOK, path.join(root, "hooks", "run-skill-posttool-validation.js"));
  fs.copyFileSync(
    path.join(PLUGIN_ROOT, "scripts", "lib", "modelapps-hook-utils.js"),
    path.join(root, "scripts", "lib", "modelapps-hook-utils.js")
  );
  fs.copyFileSync(
    path.join(PLUGIN_ROOT, "scripts", "lib", "utf8-stream.js"),
    path.join(root, "scripts", "lib", "utf8-stream.js")
  );
  // The staged hook must be the real source, not a rewritten stand-in.
  assert.equal(
    fs.readFileSync(path.join(root, "hooks", "run-skill-posttool-validation.js"), "utf8"),
    fs.readFileSync(REAL_HOOK, "utf8")
  );
  return root;
}

function writeSkill(root, name, scripts) {
  const skillDir = path.join(root, "skills", name);
  fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: " + name + "\n---\nSynthetic skill for hook tests.\n");
  for (const script of scripts) {
    fs.writeFileSync(path.join(skillDir, "scripts", script.name), script.source);
  }
}

function validatorSource({ which, exitCode }) {
  return [
    '"use strict";',
    'const fs = require("node:fs");',
    "const chunks = [];",
    'process.stdin.on("data", (chunk) => chunks.push(chunk));',
    'process.stdin.on("end", () => {',
    '  const data = Buffer.concat(chunks).toString("utf8");',
    "  const marker = process.env.VALIDATOR_MARKER;",
    "  if (marker) {",
    "    fs.writeFileSync(marker, JSON.stringify({ which: " + JSON.stringify(which) + ", cwd: process.cwd(), data }));",
    "  }",
    '  process.stdout.write("STDOUT:" + data);',
    '  process.stderr.write("STDERR:' + which + '");',
    "  process.exit(" + exitCode + ");",
    "});",
    "",
  ].join("\n");
}

function hookEnv(root, extra) {
  return {
    ...process.env,
    ...extra,
    DEBUG: "",
    MODEL_APPS_DISABLE_HOOKS: extra && extra.MODEL_APPS_DISABLE_HOOKS ? extra.MODEL_APPS_DISABLE_HOOKS : "",
    VALIDATOR_MARKER: path.join(root, "marker.json"),
  };
}

function runHookSync(root, input, extraEnv) {
  return spawnSync(process.execPath, [path.join(root, "hooks", "run-skill-posttool-validation.js")], {
    input,
    encoding: "utf8",
    cwd: root,
    env: hookEnv(root, extraEnv),
    timeout: 15_000,
  });
}

// Feed stdin from a file. Node reads a file-backed stdin as an fs.ReadStream in 64 KiB
// chunks (its default highWaterMark), so a multibyte character placed across byte
// 65,536 arrives in two `data` events on every run. Two writes to a pipe give no such
// guarantee: the child may read them as one chunk, and a hook that decoded each chunk
// on its own would still pass.
const STDIN_CHUNK = 64 * 1024;

function runHookFromFile(root, input, extraEnv, hook = path.join(root, "hooks", "run-skill-posttool-validation.js")) {
  const file = path.join(root, "stdin.json");
  fs.writeFileSync(file, input, "utf8");
  const fd = fs.openSync(file, "r");
  try {
    return spawnSync(process.execPath, [hook], {
      stdio: [fd, "pipe", "pipe"],
      encoding: "utf8",
      cwd: root,
      env: hookEnv(root, extraEnv),
      timeout: 15_000,
    });
  } finally {
    fs.closeSync(fd);
  }
}

// A JSON payload whose `note` ends in 😀東京, with the 4-byte 😀 starting two bytes
// before the first stdin chunk ends.
function payloadSplitAcrossChunks(fields) {
  const head = JSON.stringify({ ...fields, note: "" }).slice(0, -2);
  const pad = "a".repeat(STDIN_CHUNK - 2 - Buffer.byteLength(head, "utf8"));
  const payload = head + pad + "😀東京" + '"}';
  const bytes = Buffer.from(payload, "utf8");
  assert.ok(bytes.subarray(STDIN_CHUNK - 2, STDIN_CHUNK + 2).equals(Buffer.from("😀", "utf8")), "😀 straddles the chunk boundary");
  assert.equal(JSON.parse(payload).note.slice(-4), "😀東京");
  return payload;
}

// The real hook with its stdin reader swapped for one that decodes each chunk on its
// own — the regression the payload above must expose.
function stageNaiveHook(root) {
  const hook = path.join(root, "hooks", "naive-posttool.js");
  const source = fs.readFileSync(REAL_HOOK, "utf8");
  const reader = "readUtf8Stream(process.stdin)";
  assert.equal(source.split(reader).length, 2, "the hook reads stdin through readUtf8Stream exactly once");
  fs.writeFileSync(hook, source.replace(reader,
    "new Promise((resolve) => { let d = ''; process.stdin.on('data', (c) => { d += c.toString('utf8'); }); process.stdin.on('end', () => resolve(d)); })"));
  return hook;
}

function readMarker(root) {
  const marker = path.join(root, "marker.json");
  if (!fs.existsSync(marker)) return null;
  return JSON.parse(fs.readFileSync(marker, "utf8"));
}

test("hooks.json registers posttool validation for Skill", () => {
  const hooks = JSON.parse(fs.readFileSync(HOOKS_JSON, "utf8"));
  const post = hooks.hooks.PostToolUse;
  const skill = post.find((entry) => entry.matcher === "Skill|skill");
  assert.ok(skill, "PostToolUse must match Skill|skill");
  assert.equal(skill.hooks.length, 1);
  assert.equal(skill.hooks[0].type, "command");
  assert.equal(skill.hooks[0].timeout, 30);
  assert.match(skill.hooks[0].command, /PLUGIN_ROOT\|\|process\.env\.CLAUDE_PLUGIN_ROOT/);
  assert.match(skill.hooks[0].command, /run-skill-posttool-validation\.js/);
  assert.equal(fs.existsSync(REAL_HOOK), true);
});

test("posttool forwards payload cwd output and validator exit", () => {
  const root = stagePlugin();
  const validatorCwd = path.join(root, "validator-cwd");
  fs.mkdirSync(validatorCwd);
  writeSkill(root, "genpage", [
    {
      name: "validate-a.js",
      source: validatorSource({ which: "validate-a.js", exitCode: 3 }),
    },
  ]);
  const payload = payloadSplitAcrossChunks({
    tool_input: { skill: "model-apps:genpage" },
    cwd: validatorCwd,
  });
  const { status, stdout, stderr } = runHookFromFile(root, payload);
  assert.equal(status, 3, stderr);
  assert.match(stdout, /STDOUT:/);
  assert.match(stdout, /😀東京/);
  assert.match(stderr, /STDERR:validate-a\.js/);
  const marker = readMarker(root);
  assert.ok(marker, "validator must have run");
  assert.equal(marker.which, "validate-a.js");
  // realpath on both sides: on macOS the temp dir is under /var, a symlink, while the
  // child's process.cwd() reports the resolved /private/var path.
  assert.equal(fs.realpathSync(marker.cwd), fs.realpathSync(validatorCwd));
  assert.equal(marker.data, payload, "the payload reaches the validator byte for byte");

  // Negative control: the same payload through a hook that decodes each chunk on its own
  // reaches the validator damaged, so the split above really happened.
  fs.rmSync(path.join(root, "marker.json"));
  const naive = runHookFromFile(root, payload, undefined, stageNaiveHook(root));
  assert.equal(naive.status, 3, naive.stderr);
  const damaged = readMarker(root);
  assert.ok(damaged, "the naive hook still runs the validator");
  assert.notEqual(damaged.data, payload);
  assert.match(damaged.data, /\uFFFD/);
});

test("posttool runs the lexicographically first validate script", () => {
  const root = stagePlugin();
  writeSkill(root, "genpage", [
    { name: "helper.js", source: validatorSource({ which: "helper.js", exitCode: 9 }) },
    { name: "validate-z.js", source: validatorSource({ which: "validate-z.js", exitCode: 9 }) },
    { name: "validate-a.js", source: validatorSource({ which: "validate-a.js", exitCode: 3 }) },
    { name: "validate.txt", source: "not javascript\n" },
  ]);
  const { status } = runHookSync(root, JSON.stringify({ tool_input: { skill: "genpage" } }));
  assert.equal(status, 3);
  assert.equal(readMarker(root).which, "validate-a.js");
});

test("posttool exits 0 on malformed stdin", () => {
  const root = stagePlugin();
  writeSkill(root, "genpage", [
    { name: "validate-a.js", source: validatorSource({ which: "validate-a.js", exitCode: 3 }) },
  ]);
  const { status, stderr } = runHookSync(root, "{not json");
  assert.equal(status, 0);
  assert.match(stderr, /Unexpected error/);
  assert.equal(readMarker(root), null, "a parse failure must not run the validator");
});

test("posttool approves a skill with no validator", () => {
  const root = stagePlugin();
  writeSkill(root, "plain", []);
  writeSkill(root, "genpage", [
    { name: "validate-a.js", source: validatorSource({ which: "validate-a.js", exitCode: 3 }) },
  ]);
  const { status, stderr } = runHookSync(root, JSON.stringify({ tool_input: { skill: "plain" } }));
  assert.equal(status, 0);
  assert.doesNotMatch(stderr, /Unexpected error/);
  assert.equal(readMarker(root), null);
});

test("posttool fail-opens when the validator cannot be spawned", () => {
  const root = stagePlugin();
  writeSkill(root, "genpage", [
    { name: "validate-a.js", source: validatorSource({ which: "validate-a.js", exitCode: 3 }) },
  ]);
  const missingCwd = path.join(root, "missing-cwd");
  const { status, stderr } = runHookSync(
    root,
    JSON.stringify({ tool_input: { skill: "genpage" }, cwd: missingCwd })
  );
  // spawnSync reports a missing cwd as a spawn error (status null), and the hook
  // fail-opens that to 0. A successful spawn would have exited 3.
  assert.equal(status, 0, stderr);
  assert.equal(readMarker(root), null, "a spawn error must not look like the validator ran");
  assert.doesNotMatch(stderr, /Unexpected error/);
});

test("posttool disable switch is a clean no-op", () => {
  for (const value of ["1", "true"]) {
    const root = stagePlugin();
    writeSkill(root, "genpage", [
      { name: "validate-a.js", source: validatorSource({ which: "validate-a.js", exitCode: 3 }) },
    ]);
    const { status, stdout, stderr } = runHookSync(
      root,
      JSON.stringify({ tool_input: { skill: "genpage" } }),
      { MODEL_APPS_DISABLE_HOOKS: value }
    );
    assert.equal(status, 0, value);
    assert.equal(stdout, "");
    assert.equal(stderr, "");
    assert.equal(readMarker(root), null, value + " must not run the validator");
  }
});
