"use strict";

// Builds a native `pac` the telemetry hooks will actually start.
//
// native-exec resolves `pac` to an absolute path and only accepts a native
// executable (.exe/.com on Windows, an executable file elsewhere). It deliberately
// ignores .cmd/.bat, so the az.cmd shim used by cli-failure.test.js would never
// run here — the enrichment parser would stay dark, and a leaked PATH could still
// reach a real pac.exe further down the path. The stub is therefore a real
// executable that prints a fixed banner. It also touches started.txt beside itself
// so a test can prove which binary ran.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const STUB_BANNER = {
  orgId: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  objectId: "33333333-3333-4333-8333-333333333333",
  user: "maker@contoso.example",
  version: "9.9.9",
  cloud: "Public",
};

// Distinct from the stub so a leaked PATH (trap is placed first) cannot be
// mistaken for a successful stub read.
const TRAP_BANNER = {
  orgId: "99999999-9999-4999-8999-999999999999",
  tenantId: "88888888-8888-4888-8888-888888888888",
  objectId: "77777777-7777-4777-8777-777777777777",
  user: "trap@contoso.example",
  version: "0.0.1",
  cloud: "Trap",
};

function startedMarker(dir) {
  return path.join(dir, "started.txt");
}

// Writes a native `pac` into `dir` and returns true, or returns false when this machine
// cannot build one: on Windows the stub is compiled with the .NET Framework C# compiler,
// which a minimal image may lack. A caller that needs the stub's banner skips then; a
// caller that only needs PATH isolated is unaffected — an isolated PATH holding no pac is
// still hermetic.
function writePacExecutable(dir, banner) {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === "win32") {
    return writeWindowsExe(dir, banner);
  }
  writePosixScript(dir, banner);
  return true;
}

// Drop every PATH spelling, then set one isolated value. On Windows Node forwards
// the lexicographically first of Path/PATH, so leaving the inherited spelling in
// place would still find an ambient pac.
function isolatePath(env, stubDir) {
  const isolated = { ...env };
  for (const key of Object.keys(isolated)) {
    if (key.toUpperCase() === "PATH") delete isolated[key];
  }
  isolated.PATH = stubDir;
  return isolated;
}

function writePosixScript(dir, banner) {
  // Shell builtins only. The hooks start this stub with PATH set to its own directory
  // (isolatePath), so an external command such as `dirname` is not found there: the
  // directory came back empty and the marker went to "/started.txt" (permission
  // denied), failing every marker assertion off Windows. `$0` is the absolute path
  // native-exec resolved, so stripping the last component gives the stub's directory.
  const script = [
    "#!/bin/sh",
    'case "$0" in */*) dir=${0%/*} ;; *) dir=. ;; esac',
    "printf '%s\\n' started > \"$dir/started.txt\"",
    'case " $* " in',
    "  *' --version '*)",
    "    printf '%s\\n' 'Version: " + banner.version + "'",
    "    ;;",
    "  *)",
    "    printf '%s\\n' 'Tenant Id: " + banner.tenantId + "'",
    "    printf '%s\\n' 'Organization Id: " + banner.orgId + "'",
    "    printf '%s\\n' 'Cloud: " + banner.cloud + "'",
    "    printf '%s\\n' 'Entra ID Object Id: " + banner.objectId + "'",
    "    printf '%s\\n' 'User: " + banner.user + "'",
    "    ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n");
  const file = path.join(dir, "pac");
  fs.writeFileSync(file, script, { mode: 0o755 });
  try {
    fs.chmodSync(file, 0o755);
  } catch {
    // Windows has no execute bit; this helper is the POSIX path.
  }
}

function writeWindowsExe(dir, banner) {
  const csc = [
    "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
    "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe",
  ].find((candidate) => fs.existsSync(candidate));
  if (!csc) return false;
  const source = [
    "using System;",
    "using System.IO;",
    "using System.Reflection;",
    "class PacStub {",
    "  static int Main(string[] args) {",
    "    string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);",
    "    File.WriteAllText(Path.Combine(dir, \"started.txt\"), \"started\");",
    "    string joined = string.Join(\" \", args);",
    "    if (joined.IndexOf(\"--version\", StringComparison.OrdinalIgnoreCase) >= 0) {",
    "      Console.WriteLine(\"Version: " + banner.version + "\");",
    "      return 0;",
    "    }",
    "    Console.WriteLine(\"Tenant Id: " + banner.tenantId + "\");",
    "    Console.WriteLine(\"Organization Id: " + banner.orgId + "\");",
    "    Console.WriteLine(\"Cloud: " + banner.cloud + "\");",
    "    Console.WriteLine(\"Entra ID Object Id: " + banner.objectId + "\");",
    "    Console.WriteLine(\"User: " + banner.user + "\");",
    "    return 0;",
    "  }",
    "}",
    "",
  ].join("\r\n");
  const cs = path.join(dir, "pac.cs");
  const exe = path.join(dir, "pac.exe");
  fs.writeFileSync(cs, source);
  const compiled = spawnSync(csc, ["/nologo", "/t:exe", "/out:" + exe, cs], { encoding: "utf8" });
  if (compiled.status !== 0 || !fs.existsSync(exe)) {
    throw new Error("csc failed: " + (compiled.stderr || compiled.stdout || compiled.error));
  }
  return true;
}

module.exports = {
  STUB_BANNER,
  TRAP_BANNER,
  startedMarker,
  writePacExecutable,
  isolatePath,
};
