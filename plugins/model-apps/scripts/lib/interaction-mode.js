'use strict';

// Whether a human is reachable on the other end of this run.
//
// WHY this is shared rather than decided per skill: `/app-builder` and `/genpage` both have
// gates that must behave differently when nobody can answer, and a second, subtly different
// definition of "unattended" is exactly how one skill ends up waiting forever on a host where
// the other correctly proceeded. One definition, one place.
//
// The host matters here as much as the flags. Copilot CLI autopilot and Claude Code's
// auto-accept both drive these skills with **no user watching**, so a gate that is specified
// as "ask the user" has no answer to wait for: the run either stalls or, worse, records an
// answer nobody gave. Detecting the mode is what lets a gate choose a documented default
// instead of inventing one.

// Env var truthiness for the unattended opt-in: '1' or 'true' (case-insensitive) count as set;
// a missing or other value is false. Matches the dotnet-style boolean env convention used
// elsewhere in this repo (see AGENTS.md "Shared Telemetry").
function envTruthy(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true';
}

// The repo-wide unattended opt-in. Named once here so a caller cannot typo it into a silent
// "attended" result — the failure mode of a mistyped env var is a run that hangs on a prompt
// nobody sees, which looks like a hang rather than a configuration error.
const NONINTERACTIVE_ENV = 'POWER_PLATFORM_SKILLS_NONINTERACTIVE';

// Resolve the mode from an explicit flag first, then the env var, then default to attended.
//
// Defaulting to ATTENDED is deliberate: assuming a human is present makes an unattended run
// stall visibly, whereas assuming one is absent makes an attended run silently skip the
// questions the user expected to be asked. A stall is reported; a skipped question is not.
//
// SUPPRESSION ONLY. Being unattended never grants destructive authority — that stays gated on
// an explicit `--allow-destructive`, because "nobody is watching" is the opposite of
// "everyone consented".
function resolveInteractionMode(opts = {}) {
  const argv = Array.isArray(opts.argv) ? opts.argv : [];
  const env = opts.env || process.env;

  if (argv.includes('--non-interactive')) {
    return { interactive: false, reason: '--non-interactive flag' };
  }
  if (envTruthy(env[NONINTERACTIVE_ENV])) {
    return { interactive: false, reason: `${NONINTERACTIVE_ENV} is set` };
  }
  return { interactive: true, reason: 'default (attended)' };
}

module.exports = { envTruthy, resolveInteractionMode, NONINTERACTIVE_ENV };
