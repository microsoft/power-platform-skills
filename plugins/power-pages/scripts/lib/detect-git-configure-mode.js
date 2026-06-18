#!/usr/bin/env node

// Computes the execution mode for the merged `git-configure` skill.
//
// `git-configure` is a single SKILL.md that dispatches into one of FOUR modes
// based on the current Dataverse Git binding state AND the user's $ARGUMENTS:
//
//   • setup          — env is NOT bound; run the full first-bind cascade
//                      (replaces /power-pages:setup-git-integration and
//                      /power-pages:connect-solution-to-git).
//   • switch-branch  — env IS bound, user wants only the branch to change
//                      (same org/project/repo/folder; replaces
//                      /power-pages:branch-switch).
//   • rebind         — env IS bound, user wants to change ADO coordinates
//                      (org / project / repo / folder), not just branch.
//                      NEW capability — partially possible today only by
//                      manually running disconnect-from-git then setup.
//   • disconnect     — env IS bound, user wants to unbind entirely. NEW skill
//                      surface — the helper exists today but no slash command.
//
// Mode auto-detection is overridable via `--mode=<name>`. The function returns
// the dispatched mode + a human-readable reason + a "headless eligibility"
// nested object: `setup` mode can auto-pick ADO org/project/repo when all the
// inferred context is unambiguous; the other modes never run headless because
// they have user-required choices (branch / rebind target / disconnect typed
// confirm) that cannot be inferred.
//
// Output:
//   {
//     mode:            "setup" | "switch-branch" | "rebind" | "disconnect",
//     reason:          "<short prose>",
//     explicitOverride: boolean,             // true when --mode=X forced the choice
//     requiresIntentPrompt?: boolean,        // true when bound + no mode/branch given:
//                                            //   SKILL.md MUST confirm intent before mutating
//                                            //   (idempotency / N2 — don't silently switch-branch)
//     noOp?: boolean,                        // true when the request would change nothing
//                                            //   (e.g. --branch == current branch)
//     headless: {
//       eligible:      boolean,              // only true for setup mode when context is unambiguous
//       blockers:      [ "<reason>", ... ],  // populated when eligible=false
//     },
//   }
//
// Errors are signalled by throwing — callers should wrap in try/catch.

'use strict';

const VALID_MODES = Object.freeze([
  'setup',
  'switch-branch',
  'rebind',
  'disconnect',
]);

/**
 * Parse a $ARGUMENTS-like array into a small structured options bag.
 *
 * Accepted forms:
 *   --mode=setup     (long form)
 *   --mode setup     (long form, space-separated)
 *   --branch=main    (explicit target branch; sets `targetBranch`)
 *   --branch main    (space form)
 *   --headless       (request headless even when default would prompt)
 *   --interactive    (force-disable headless even when auto-eligible)
 *   --non-interactive (CI mode: fail-loud on any unmet required input instead of prompting)
 *   --no-intro       (skip the first-run preamble)
 *
 * Unknown flags are ignored (keeps forward-compat with extra mentor flags).
 *
 * @param {string[]} args
 * @returns {{ mode?: string, targetBranch?: string, headless?: boolean,
 *             interactive?: boolean, nonInteractive?: boolean, noIntro?: boolean }}
 */
function parseModeArgs(args = []) {
  const out = {};
  if (!Array.isArray(args)) return out;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') continue;

    if (a === '--headless') { out.headless = true; continue; }
    if (a === '--interactive') { out.interactive = true; continue; }
    if (a === '--non-interactive' || a === '--no-interactive') { out.nonInteractive = true; continue; }
    if (a === '--no-intro') { out.noIntro = true; continue; }

    let key, val;
    if (a.startsWith('--') && a.includes('=')) {
      const eq = a.indexOf('=');
      key = a.slice(2, eq);
      val = a.slice(eq + 1);
    } else if (a.startsWith('--')) {
      key = a.slice(2);
      val = args[i + 1];
      if (val !== undefined && !String(val).startsWith('--')) i++;
      else val = undefined;
    } else {
      continue;
    }

    if (key === 'mode' && val) {
      out.mode = val;
    } else if (key === 'branch' && val) {
      out.targetBranch = val;
    }
  }
  return out;
}

/**
 * Detect the execution mode.
 *
 * @param {object} input
 * @param {object|null} input.binding            Output of detect-git-binding.js.
 *                                               Pass `null` for "binding was not
 *                                               yet probed" (which is an error —
 *                                               Phase 1 MUST run before mode dispatch).
 * @param {string[]} [input.args=[]]             User's $ARGUMENTS array.
 * @returns {{ mode: string, reason: string, explicitOverride: boolean,
 *             headless: { eligible: boolean, blockers: string[] } }}
 */
function detectGitConfigureMode({ binding, args = [] } = {}) {
  if (binding === undefined || binding === null) {
    throw new Error(
      'detectGitConfigureMode: binding is required — pass detect-git-binding.js ' +
      'output (or { bound: false } when explicitly unbound).',
    );
  }
  if (typeof binding !== 'object') {
    throw new Error('detectGitConfigureMode: binding must be an object');
  }
  if (binding.error) {
    throw new Error(
      `detectGitConfigureMode: binding probe failed — ${binding.error}. ` +
      'Resolve the underlying Dataverse / auth error before dispatching a mode.',
    );
  }

  const opts = parseModeArgs(args);
  const bound = binding.bound === true;

  // Explicit override always wins, but we validate the mode name.
  if (opts.mode) {
    if (!VALID_MODES.includes(opts.mode)) {
      throw new Error(
        `detectGitConfigureMode: --mode='${opts.mode}' is not one of ` +
        `[${VALID_MODES.join(', ')}].`,
      );
    }
    // Some overrides only make sense in specific binding states. We allow but
    // surface in `reason` so the caller can warn the user.
    if (opts.mode === 'switch-branch' && !bound) {
      return {
        mode: 'switch-branch',
        reason: 'User forced --mode=switch-branch but env is NOT bound. The skill will fail in Phase 1 unless the user re-runs with --mode=setup.',
        explicitOverride: true,
        headless: { eligible: false, blockers: ['mode=switch-branch but env is not bound'] },
      };
    }
    if (opts.mode === 'rebind' && !bound) {
      return {
        mode: 'rebind',
        reason: 'User forced --mode=rebind but env is NOT bound. The skill will fall back to setup-style behavior.',
        explicitOverride: true,
        headless: { eligible: false, blockers: ['mode=rebind but env is not bound'] },
      };
    }
    if (opts.mode === 'disconnect' && !bound) {
      return {
        mode: 'disconnect',
        reason: 'User forced --mode=disconnect but env is NOT bound — nothing to disconnect.',
        explicitOverride: true,
        headless: { eligible: false, blockers: ['mode=disconnect but env is not bound'] },
      };
    }
    if (opts.mode === 'setup' && bound) {
      return {
        mode: 'setup',
        reason: 'User forced --mode=setup but env is ALREADY bound. The skill will refuse in Phase 1 unless the user first disconnects.',
        explicitOverride: true,
        headless: { eligible: false, blockers: ['mode=setup but env is already bound'] },
      };
    }
    // Any remaining explicit mode (e.g. disconnect/rebind/switch-branch on a
    // bound env, or setup on an unbound env) is allowed as-is.
    return {
      mode: opts.mode,
      reason: `Mode explicitly set via --mode=${opts.mode}.`,
      explicitOverride: true,
      headless: opts.mode === 'setup'
        ? evaluateHeadless({ binding, opts, bound })
        : { eligible: false, blockers: [`headless not supported for mode=${opts.mode}`] },
    };
  }

  // ----- Auto-detection -----
  if (!bound) {
    return {
      mode: 'setup',
      reason: 'No Git binding detected on env — entering first-bind flow.',
      explicitOverride: false,
      headless: evaluateHeadless({ binding, opts, bound }),
    };
  }

  // Bound. If user passed --branch=X and X IS the current branch ⇒ idempotent
  // no-op. Surface noOp so the SKILL.md short-circuits with a friendly summary
  // instead of running a pointless disconnect+reconnect (N2).
  if (opts.targetBranch && binding.branch && opts.targetBranch === binding.branch) {
    return {
      mode: 'switch-branch',
      reason: `Env is already bound to branch '${binding.branch}' and the requested branch matches ⇒ nothing to switch.`,
      explicitOverride: false,
      noOp: true,
      headless: { eligible: false, blockers: ['no-op: already on the requested branch'] },
    };
  }

  // Bound. If user passed --branch=X and X differs from current branch ⇒ switch-branch.
  if (opts.targetBranch && binding.branch && opts.targetBranch !== binding.branch) {
    return {
      mode: 'switch-branch',
      reason: `Env is bound to branch '${binding.branch}' and --branch='${opts.targetBranch}' differs ⇒ switch-branch.`,
      explicitOverride: false,
      headless: { eligible: false, blockers: ['switch-branch always confirms target branch'] },
    };
  }

  // Bound, no explicit mode, no target branch ⇒ genuinely ambiguous between
  // switch-branch / rebind / disconnect. Rather than silently walk the full
  // switch-branch flow (the legacy behaviour, which surprised users re-running
  // the skill on an already-bound env), set requiresIntentPrompt so the SKILL.md
  // surfaces the current binding and asks the user what they want (N2 idempotency
  // / intent-confirmation). The mode stays switch-branch as the most-likely
  // intent, but it MUST NOT proceed without the prompt.
  return {
    mode: 'switch-branch',
    reason: `Env is bound to ${binding.organization}/${binding.project}/${binding.repository}@${binding.branch} and no mode was given — confirm intent before proceeding. Options: switch-branch / rebind / disconnect.`,
    explicitOverride: false,
    requiresIntentPrompt: true,
    headless: { eligible: false, blockers: ['ambiguous intent on a bound env: requires confirmation'] },
  };
}

/**
 * Evaluate whether the auto-pick ADO cascade can run headless for `setup` mode.
 *
 * Headless requires ALL of:
 *   • The binding probe completed successfully (we already checked above).
 *   • `--interactive` was NOT passed (explicit opt-out wins).
 *   • Caller supplied a `binding.codeSiteName` or `binding.solutionUniqueName`
 *     (i.e. Phase 1 context auto-detection succeeded).
 *
 * The ACTUAL "exactly one ADO org / project / repo" checks live in
 * Phase 4 of the SKILL.md, where the list-ado-* helpers run. This function
 * answers: "is headless even on the table?" — Phase 4 then verifies the rest.
 *
 * @param {{ binding: object, opts: object, bound: boolean }} input
 * @returns {{ eligible: boolean, blockers: string[] }}
 */
function evaluateHeadless({ binding, opts, bound }) {
  const blockers = [];

  if (opts.interactive) blockers.push('--interactive flag set');
  if (bound) blockers.push('headless setup requires unbound env');

  // Context auto-detection signals.
  const hasCodeSite = Boolean(binding.codeSiteName);
  const hasSolution = Boolean(binding.solutionUniqueName);
  if (!hasCodeSite && !hasSolution) {
    blockers.push('no code site or solution manifest detected');
  }

  // User can opt INTO headless via --headless when partial context exists.
  // Otherwise eligibility requires both signals to be present (safest default).
  if (!opts.headless && (!hasCodeSite || !hasSolution)) {
    blockers.push('partial context: pass --headless to opt in, or run interactive');
  }

  return {
    eligible: blockers.length === 0,
    blockers,
  };
}

function parseCliArgs(argv) {
  // Slice past `node script.js`. Supports `--binding-file path` to load the
  // detect-git-binding output from disk (for CLI / hook usage) and passes the
  // rest through as the $ARGUMENTS array.
  const args = argv.slice(2);
  const out = { bindingFile: null, passthrough: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--binding-file' && args[i + 1]) {
      out.bindingFile = args[++i];
    } else {
      out.passthrough.push(args[i]);
    }
  }
  return out;
}

if (require.main === module) {
  const fs = require('fs');
  const cli = parseCliArgs(process.argv);
  let binding;
  if (cli.bindingFile) {
    try {
      binding = JSON.parse(fs.readFileSync(cli.bindingFile, 'utf8'));
    } catch (e) {
      process.stderr.write(`detect-git-configure-mode: cannot read --binding-file: ${e.message}\n`);
      process.exit(2);
    }
  } else {
    // Allow piping detect-git-binding's stdout in.
    const chunks = [];
    try {
      const stdinFd = 0;
      const buf = fs.readFileSync(stdinFd);
      if (buf.length > 0) binding = JSON.parse(buf.toString('utf8'));
    } catch {
      // No stdin — fall through to error below.
    }
  }
  if (!binding) {
    process.stderr.write(
      'detect-git-configure-mode: pass --binding-file <path> or pipe detect-git-binding output to stdin.\n',
    );
    process.exit(2);
  }
  try {
    const result = detectGitConfigureMode({ binding, args: cli.passthrough });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (e) {
    process.stderr.write('detect-git-configure-mode: ' + e.message + '\n');
    process.exit(1);
  }
}

module.exports = {
  detectGitConfigureMode,
  parseModeArgs,
  VALID_MODES,
};
