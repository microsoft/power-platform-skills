"use strict";

// Non-blocking variants of the shared telemetry library's PAC readers.
//
// Why this file exists: scripts/lib/telemetry/lib is a byte-identical copy of
// shared/telemetry/lib and must stay that way, so plugin-specific additions
// cannot live inside it. The shared readers are synchronous and fork `pac`
// with an 8s timeout; on Windows a cold `pac auth who` is ~4s and
// `pac --version` ~2s, and the hooks run on every tracked prompt. This module
// adds two things on top of the shared library without modifying it:
//
//   1. async execution, so the hook's event loop is not blocked, and
//   2. a disk cache for the non-identity PAC version, so its .NET cold start
//      is paid at most once per TTL across hook processes.
//
// Executables are resolved through the shared library's native-exec, so `pac`
// is started by absolute path from PATH with shell:false — never by bare name
// out of the working directory. Every path is best-effort and fail-closed:
// a missing executable, timeout, non-zero exit, or unparseable output all
// resolve to the empty result and never throw.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const { resolveNative } = require("./lib/native-exec");
const { readAiAgent } = require("./lib/agent-info");
const { detectSlashCommand } = require("./lib/prompt-detector");
const { loadResolver } = require("./lib/resolver-loader");
const { emitSkillStartedFromPrompt } = require("./lib/emit-from-prompt");

const TIMEOUT_MS = 8000;

// The CLI version changes only when the user updates PAC.
const VERSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const LEGACY_AUTH_CACHE_FILE = "pac-auth-cache.json";
const VERSION_CACHE_FILE = "pac-version-cache.json";

let authCache;
let versionCache;

function _resetCache() {
  authCache = undefined;
  versionCache = undefined;
}

function defaultCacheDir() {
  return (
    process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR ||
    path.join(os.homedir(), ".power-platform-skills")
  );
}

function cachePath(fileName, configDir) {
  return path.join(configDir || defaultCacheDir(), fileName);
}

// Returns the cached entry's `value`, or null when absent, unreadable, or expired.
function readDiskCache(fileName, configDir) {
  try {
    const entry = JSON.parse(fs.readFileSync(cachePath(fileName, configDir), "utf8"));
    if (!entry || typeof entry.expiresAt !== "number" || entry.expiresAt < Date.now()) {
      return null;
    }
    return "value" in entry ? entry.value : null;
  } catch {
    return null;
  }
}

// Atomic write (tmp + rename) so a concurrent reader never sees a partial file.
let writeSeq = 0;
function writeDiskCache(fileName, value, ttlMs, configDir) {
  const dir = configDir || defaultCacheDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return;
  }
  const file = cachePath(fileName, dir);
  const tmp = `${file}.tmp.${process.pid}.${writeSeq++}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ value, expiresAt: Date.now() + ttlMs }), "utf8");
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

// execFile against an absolute path resolved from PATH. Resolves to stdout, or
// "" when the tool is absent or the run fails without usable output.
function runNativeAsync(name, args) {
  return new Promise((resolve) => {
    let file;
    try {
      file = resolveNative(name);
    } catch {
      file = null;
    }
    if (!file) {
      resolve("");
      return;
    }
    try {
      execFile(
        file,
        args,
        { encoding: "utf8", timeout: TIMEOUT_MS, windowsHide: true, shell: false },
        (err, stdout) => {
          // PAC 2.x prints its banner to stdout and then exits non-zero for an
          // unknown command, so stdout captured alongside an error still parses.
          resolve(stdout || (err && err.stdout ? String(err.stdout) : ""));
        }
      );
    } catch {
      resolve("");
    }
  });
}

function pickLine(text, label) {
  const re = new RegExp("^\\s*" + label + "\\s*:\\s*(\\S.*?)\\s*$", "im");
  const match = text.match(re);
  return match ? match[1] : null;
}

// Mirrors lib/pac-auth.js's banner parse, including `Entra ID Object Id`.
function parseAuth(output) {
  if (typeof output !== "string" || !output) return null;
  const tenantId = pickLine(output, "Tenant Id");
  const orgId = pickLine(output, "Organization Id");
  if (!tenantId && !orgId) return null;
  return {
    orgId: orgId || "",
    tenantId: tenantId || "",
    cloud: pickLine(output, "Cloud") || "",
    objectId: pickLine(output, "Entra ID Object Id") || "",
  };
}

function parseVersion(stdout) {
  const match = String(stdout || "").match(/Version:\s*(\d+\.\d+\.\d+(?:\.\d+)?)/);
  return match ? match[1] : "";
}

// Per-process cache → async `pac auth who`. Identity is never persisted across
// hook processes, so PAC profile switches cannot reuse another profile's IDs.
async function readPacAuthAsync(opts = {}) {
  if (authCache !== undefined) return authCache;
  try {
    fs.unlinkSync(cachePath(LEGACY_AUTH_CACHE_FILE));
  } catch {
    /* no legacy cache to remove, or it is not writable */
  }
  if (opts._exec === false) {
    authCache = null;
    return null;
  }
  const runNative = typeof opts._runNative === "function" ? opts._runNative : runNativeAsync;
  const result = parseAuth(await runNative("pac", ["auth", "who"]));
  authCache = result || null;
  return authCache;
}

// Per-process cache → disk cache → async `pac --version`. Resolves to the
// version string or "".
async function readPacCliVersionAsync(opts = {}) {
  if (versionCache !== undefined) return versionCache;
  if (opts._exec === false) {
    versionCache = "";
    return "";
  }
  if (opts._skipDiskCache !== true) {
    const cached = readDiskCache(VERSION_CACHE_FILE);
    if (typeof cached === "string" && cached) {
      versionCache = cached;
      return versionCache;
    }
  }
  const version = parseVersion(await runNativeAsync("pac", ["--version"]));
  versionCache = version;
  if (version) writeDiskCache(VERSION_CACHE_FILE, version, VERSION_CACHE_TTL_MS);
  return versionCache;
}

// Reads the plugin's telemetry config the same way lib/emit-from-prompt.js's
// readIkey does, so the gates below agree with it. Fails closed.
function readIkeyConfig(telemetryDir) {
  const override = process.env.POWER_PLATFORM_SKILLS_IKEY_JSON;
  const overridePath = override && override.trim() ? override : "";
  if (!overridePath && (typeof telemetryDir !== "string" || !telemetryDir)) {
    return { cfg: null, dir: "", disabled: true };
  }
  const ikeyPath = overridePath || path.join(telemetryDir, "ikey.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(ikeyPath, "utf8"));
    return { cfg, dir: path.dirname(ikeyPath), disabled: cfg.disabled === true };
  } catch {
    return { cfg: null, dir: path.dirname(ikeyPath), disabled: true };
  }
}

// Async variant of lib/emit-from-prompt.js's emitSkillStartedFromPrompt.
//
// The two PAC reads run in parallel off the event loop and are then handed to
// the shared implementation through its documented `_readPacAuth` /
// `_readAgentInfo` seams, so event construction and dispatch stay in one place.
// The slash-command, kill-switch, and provisioning gates are evaluated here
// first — matching the shared implementation's ordering — so an untracked
// prompt or a disabled/unprovisioned plugin never forks `pac`.
async function emitSkillStartedFromPromptAsync(promptText, opts = {}) {
  const { pluginName, trackedSkills, telemetryDir, _readPacAuth, _readAgentInfo } = opts;

  const skillName = detectSlashCommand(promptText, { pluginName, trackedSkills });
  if (!skillName) return { emitted: false, skillName: null };

  // Caller supplied its own readers (tests): nothing to prefetch.
  if (typeof _readPacAuth === "function" || typeof _readAgentInfo === "function") {
    return emitSkillStartedFromPrompt(promptText, opts);
  }

  const { cfg, dir, disabled } = readIkeyConfig(telemetryDir);
  if (disabled) return { emitted: false, skillName };

  const resolver = loadResolver(dir);
  let provisioned;
  try {
    provisioned =
      resolver && typeof resolver.isProvisioned === "function"
        ? resolver.isProvisioned(cfg)
        : !!(
            cfg &&
            cfg.instrumentationKey &&
            cfg.instrumentationKey !== "PLACEHOLDER_REPLACE_BEFORE_SHIPPING"
          );
  } catch {
    provisioned = false;
  }
  if (!provisioned) return { emitted: false, skillName };

  let pacAuth = null;
  let agentInfo = {};
  try {
    const [auth, version] = await Promise.all([
      readPacAuthAsync().catch(() => null),
      readPacCliVersionAsync().catch(() => ""),
    ]);
    pacAuth = auth;
    agentInfo = { ...readAiAgent(), pacCliVersion: version };
  } catch {
    pacAuth = null;
    agentInfo = {};
  }

  return emitSkillStartedFromPrompt(promptText, {
    ...opts,
    _readPacAuth: () => pacAuth,
    _readAgentInfo: () => agentInfo,
  });
}

module.exports = {
  readPacAuthAsync,
  readPacCliVersionAsync,
  emitSkillStartedFromPromptAsync,
  _resetCache,
  VERSION_CACHE_TTL_MS,
};
