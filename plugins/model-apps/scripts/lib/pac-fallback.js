'use strict';
// Running pac as the FALLBACK of a script that reads through the bundled SDK first (list-connections.js, connector.js, solution-settings.js): one place that
// starts it through the process runner, bounds the time it may take — a call that runs out has its whole process tree ended before it is reported, and is reported as stopped only
// when the runner has confirmed that — and says why a run failed, without pac's own header. list-connections.js starts `pac connection list` itself, as it always has, through
// the same runner and with the same read budget (PAC_READ_TIMEOUT_MS below).
//
// Every run goes through lib/process-runner.js — an absolute executable from PATH, never the working directory, no shell — so a script
// that falls back to pac starts nothing the rest of the plugin would not.
const { spawnResultTree } = require('./process-runner.js');

// How long ONE pac call may take, as fixed constants — the way check-auth.js bounds its `pac org who` probe with PAC_PROBE_TIMEOUT_MS — so there is
// nothing to tune and nothing to document beyond these lines. A call that outlasts its budget is stopped and reported as that, never as "pac is not
// installed": pac can stall (waiting on a sign-in, a slow service), and a script that waits for ever hides why.
//
// A read — a connector's definition, the settings template of a zip, the connection list — is a cold start of pac's .NET runtime (~7 s measured on
// Windows, more on a busy machine; check-auth.js allows that start alone 60 s) plus one service call whose answer can be a few hundred kilobytes.
// Three minutes leaves room for the slowest of those and still ends a stall before an agent's shell tool gives up.
const PAC_READ_TIMEOUT_MS = 180000;
// A solution import is different in kind: the platform imports the package synchronously and a large one takes many minutes, and a call stopped
// halfway leaves the outcome unknown (the import carries on in the environment) — so it is not cut off after minutes like a read. It gets pac's own
// longest wait for an import, the default of `pac solution import --max-async-wait-time` (60 minutes); one that outlasts even that is reported as
// stopped, with where to look.
const PAC_IMPORT_TIMEOUT_MS = 3600000;
// A listing of a large connector is a few hundred kilobytes; spawnSync's default buffer is 1 MiB, and a run that overflows it is ended.
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** The time one pac call of `kind` ('read' or 'import') may take. */
function pacBudgetMs(kind) {
  return kind === 'import' ? PAC_IMPORT_TIMEOUT_MS : PAC_READ_TIMEOUT_MS;
}

// What pac wrote, cut to what a message can carry: its own diagnostic is the one thing that says why it failed, and it can be long.
function shortened(text, max = 2000) {
  const trimmed = String(text == null ? '' : text).trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

// A line ends at CRLF, a bare CR or LF, and pac's output is split on all three: deleting the CRs instead would join the line a bare CR
// ended to the next one (`Connected as [maker001]\rWarning: …` became a single line that began like the banner).
const LINE_BREAK = /\r\n|\r|\n/;

// pac's auth banner, printed before any listing:
//   Connected as maker@contoso.onmicrosoft.com       (the form most pac commands print)
//   Connected as [maker001]                          (the form `pac connection list` printed in a live capture)
// It is recognised by its exact shape and nothing broader: a WHOLE line — `Connected as`, then one word or one bracketed alias (a word that opens a bracket must
// close it), and nothing after it — because a prefix test swallowed a diagnostic joined to it:
//   Connected as [maker001] Warning: failed to retrieve connections.
const PAC_BANNER = /^connected as (?:[^\s[]\S*|\[[^\]\r\n]+\])$/i;

// The lines pac prints at the top of a run besides that banner — live captures, PAC CLI 2.12.2; a run that fails prints all of them before its error:
//   Connected to... Contoso Maker
//   Microsoft PowerPlatform CLI
//   Version: 2.12.2+ga6b1ffa (.NET 10.0.12)
//   Online documentation: https://aka.ms/PowerPlatformCLI
//   Feedback, Suggestions, Issues: https://github.com/microsoft/powerplatform-build-tools/discussions
const PAC_HEADER_LINES = [
  PAC_BANNER,
  /^connected to\.\.\.(?:\s.*)?$/i,
  /^microsoft powerplatform cli$/i,
  /^version:\s*\S.*$/i,
  /^online documentation:\s*\S.*$/i,
  /^feedback, suggestions, issues:\s*\S.*$/i,
];
/** Whether a line is one of the lines pac prints at the top of a run (its banner included). */
const isPacHeaderLine = (line) => PAC_HEADER_LINES.some((pattern) => pattern.test(String(line).trim()));

/**
 * What pac said about a failure, without its header. The header names the signed-in account, the CLI version and links: noise in an error, and the user's identity in a
 * message that is copied into reports. The leading header lines and blank lines are dropped; then, when there is an `Error:` line, the text starts at the first one (pac's own
 * words for what failed, and any lines that continue them — not the progress it printed before), else it is what pac printed after its header.
 */
function pacErrorText(text) {
  const lines = String(text == null ? '' : text).split(LINE_BREAK);
  let start = 0;
  while (start < lines.length && (lines[start].trim() === '' || isPacHeaderLine(lines[start]))) start += 1;
  const body = lines.slice(start);
  const error = body.findIndex((line) => /^\s*error\s*:/i.test(line));
  return (error === -1 ? body : body.slice(error)).join('\n').trim();
}

// What a Windows batch launcher cannot carry, and the two ways round it: when the process runner refuses an argument (see its CMD_INERT_ARG), `pac` is installed as
// a launcher that is not recognised as a plain forwarder (lib/process-runner.js forwardedProgram), so the value would pass through cmd.exe's parsing and be changed.
const LAUNCHER_ADVICE = 'The launcher is a Windows batch file, which cannot receive a double quote, a % or a control character unchanged. '
  + 'Install pac as pac.exe (`dotnet tool install -g Microsoft.PowerApps.CLI.Tool`), which takes the value as it is, or run the command yourself in a shell that passes it as it is.';

// What a call that ran out of time or output says about the process it started, and so what its message may claim. The runner ends the whole tree and settles once the pipes
// have closed (`error.containment` 'confirmed', lib/process-runner.js spawnResultTree): nothing pac started still holds its output, and "was stopped" is true. When the wait for the
// pipes ran out first ('unconfirmed') a process pac started still holds them and may still be running — typically one that outlived pac itself, which no process tree can be walked
// to from a launcher that has already exited — so the message says that instead: it must not tell a reader a local process is gone when one is not. The one id it can give is
// the process pac was started as, which has usually exited by then; the survivor's own is not known. An error with no containment (a stand-in, a synchronous runner) is read as before.
function stopClaim(error) {
  if (!error || error.containment !== 'unconfirmed') return { stopped: true, claim: 'was stopped' };
  const pid = Number.isInteger(error.pid) ? ` (pac was started as process ${error.pid}, which has exited; what it started is not known by id)` : '';
  return { stopped: false, claim: `was asked to stop, but a process it started still held its output when the wait for it ended, so it may still be running${pid}` };
}
const LEFTOVER_ADVICE = ' End any leftover pac process (`Get-Process pac` on Windows, `ps` elsewhere) before trying again.';

/**
 * Runs `pac <args>`; never throws.
 * @param {string[]} args - the arguments after `pac`
 * @param {object} options
 * @param {string} options.label - the command as a message names it, e.g. `pac solution import`
 * @param {'read'|'import'} [options.kind='read'] - which budget applies
 * @param {(text: string) => string} [options.redact] - applied to pac's own text before it is put in a message
 * @param {Function} [options.spawn] - test seam: the process runner's `spawnResultTree` (a function that returns spawnSync's result, or a promise of it)
 * @returns {Promise<{ ok: true, stdout: string, stderr: string } | { ok: false, failure: 'missing'|'timeout'|'failed'|'refused', message: string }>}
 */
async function runPac(args, { label, kind = 'read', redact = (text) => text, spawn = spawnResultTree } = {}) {
  const budget = pacBudgetMs(kind);
  const result = await spawn('pac', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: budget,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  // The result has spawnSync's shape. A failure to LAUNCH the process (pac not on PATH: ENOENT) or to finish in time (ETIMEDOUT) is reported through `error`, with
  // `status` null; a process that ran and exited non-zero has a numeric `status`. A call that ran out of time has had its whole process tree ended before it got
  // here (lib/process-runner.js spawnResultTree): on Windows `pac.cmd` can be cmd.exe running pac, and ending cmd.exe alone would leave pac working. What the message
  // says of that ending is what the runner confirmed (stopClaim), not what it tried.
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      const { stopped, claim } = stopClaim(result.error);
      const next = kind === 'import'
        ? ' The environment may still be importing the package: look at its import history (Solutions → History in Maker) before importing again.'
        : ' A stalled call is usually transient, or pac is waiting for a sign-in (`pac auth list` shows the profile it uses): run it again.';
      return { ok: false, failure: 'timeout', message: `\`${label}\` did not finish within ${Math.round(budget / 1000)} s and ${claim}.${stopped ? '' : LEFTOVER_ADVICE}${next}` };
    }
    if (result.error.code === 'ENOBUFS') {
      const { stopped, claim } = stopClaim(result.error);
      return { ok: false, failure: 'failed', message: `\`${label}\` wrote more than ${MAX_OUTPUT_BYTES / (1024 * 1024)} MiB of output and ${claim}.${stopped ? '' : LEFTOVER_ADVICE}` };
    }
    // The process runner refuses, before it starts anything, an argument a Windows batch launcher (`pac.cmd`) cannot pass on unchanged — a `%` or a
    // double quote, as in a URL-encoded SharePoint site address — unless the launcher is a plain forwarder to a native program, which it starts directly.
    // pac IS installed, so the "ensure it is installed" advice below would mislead; the way through is the launcher's.
    //   cannot pass "https://contoso.sharepoint.com/sites/My%20Site" to pac.cmd: a Windows batch file cannot receive a double quote, %, a control character unchanged
    if (result.error.code === 'EARGUMENT') {
      return { ok: false, failure: 'refused', message: `\`${label}\` was not run, and nothing was sent to pac: ${redact(String(result.error.message))}. ${LAUNCHER_ADVICE}` };
    }
    return {
      ok: false,
      failure: 'missing',
      message: `\`${label}\` could not run: ${redact(String(result.error.message))}. Ensure the PAC CLI is installed and on PATH (dotnet tool install -g Microsoft.PowerApps.CLI.Tool).`,
    };
  }
  if (result.status !== 0) {
    // pac's header (the signed-in account, the version, links) is not part of why it failed, and the redaction runs before the text is cut, so a value cannot be cut in half.
    const detail = shortened(redact(pacErrorText(String(result.stderr || result.stdout || ''))));
    // A process ended by a signal has no exit status: `status` is null and `signal` names it.
    const how = result.status === null ? `ended by ${result.signal || 'a signal'}` : `exit ${result.status}${result.signal ? `, signal ${result.signal}` : ''}`;
    return { ok: false, failure: 'failed', message: `\`${label}\` failed (${how})${detail ? `: ${detail}` : ''}` };
  }
  return { ok: true, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

/**
 * The JSON object a pac command prints after its banner — the form `pac model genpage list-connector-operations` and
 * `get-connector-schema` answer in:
 *   Connected as maker@contoso.onmicrosoft.com
 *   {"operations":[{"name":"GetItems","summary":"Get items"}]}
 * Only blank lines and pac's header (its banner and the lines of product information it prints beside it) may come before it, and nothing but blank lines after it:
 * output this does not recognise is refused, never guessed at, because the caller turns what it returns into the next step of a plan. Throws an Error whose message names the line.
 * @param {string} stdout
 * @param {string} label - the command, for the message
 */
function pacPayload(stdout, label) {
  const lines = String(stdout == null ? '' : stdout).split(LINE_BREAK);
  const first = lines.findIndex((line) => line.trim() && !isPacHeaderLine(line));
  const unreadable = (why, line) => new Error(
    `\`${label}\` printed output this script could not read — ${why}${line === undefined ? '' : ` (line: "${shortened(line, 200)}")`}.`
  );
  if (first === -1) throw unreadable('it printed no JSON');
  if (!/^[[{]/.test(lines[first].trim())) throw unreadable('a line before the JSON is not pac\'s sign-in banner', lines[first]);
  let payload;
  try {
    payload = JSON.parse(lines.slice(first).join('\n'));
  } catch {
    throw unreadable('what follows the banner is not one JSON value', lines[first]);
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw unreadable('the JSON is not an object');
  return payload;
}

module.exports = {
  runPac,
  pacPayload,
  pacBudgetMs,
  pacErrorText,
  isPacHeaderLine,
  shortened,
  stopClaim,
  LEFTOVER_ADVICE,
  LINE_BREAK,
  PAC_BANNER,
  PAC_READ_TIMEOUT_MS,
  PAC_IMPORT_TIMEOUT_MS,
};
