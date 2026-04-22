#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function getArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const target = getArg("target");
if (!target) {
  process.stderr.write("Usage: sync-to-plugin.js --target <plugin-dir>\n");
  process.exit(1);
}

const source = path.resolve(__dirname);

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDir(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else copyFile(src, dst);
  }
}

function safeCopyFile(from, to) {
  if (fs.existsSync(from)) copyFile(from, to);
}

// 1. Library + iKey config → <target>/scripts/lib/telemetry/
const telemetryDst = path.join(target, "scripts", "lib", "telemetry");
fs.mkdirSync(telemetryDst, { recursive: true });

copyDir(path.join(source, "lib"), path.join(telemetryDst, "lib"));
copyFile(path.join(source, "ikey.json"), path.join(telemetryDst, "ikey.json"));

// 2. Reference doc → <target>/references/
safeCopyFile(
  path.join(source, "references", "telemetry-consent-reference.md"),
  path.join(target, "references", "telemetry-consent-reference.md")
);

process.stdout.write(`Synced shared/telemetry → ${telemetryDst}\n`);
process.exit(0);
