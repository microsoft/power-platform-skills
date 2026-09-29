'use strict';
// Shared PAC executor. Windows resolves `pac` to pac.cmd, so this is the one documented shell
// exception in the plugin; every other process runner can use an argv array with shell:false.
const { spawnSync } = require('node:child_process');

// Quote an arg for a Windows/POSIX shell command line (needed because pac resolves as pac.cmd on
// Windows, which requires shell:true — and shell:true does not quote an args array). Embedded
// newlines terminate the Windows command line (pac then sees a truncated command and dumps its
// help), so collapse them to spaces first. This is now purely a DEFENSIVE net for whatever args
// still flow inline — e.g. a page --name; it is NOT how multi-line prompts survive. upload() passes
// the prompt and agent-message to pac BY FILE (--prompt-file/--agent-message-file) precisely because
// collapsing THEIR newlines was lossy (a downloaded prompt is a multi-line conversation transcript).
function quoteArg(a) {
  const s = String(a).replace(/\r\n|[\r\n]/g, ' ');
  const q = s.replace(/"/g, '""').replace(/%/g, '"^%"');
  // cmd.exe expands %VAR% even inside double quotes; break out of the quoted segment and caret-escape
  // each percent so prompts/names containing environment-variable syntax round-trip literally.
  if (!/[\s"'&|<>^()%]/.test(s)) return s;
  // A run of backslashes immediately before the closing quote must be DOUBLED. Windows command-line
  // parsing treats `\"` as an escaped quote, so a directory argument ending in a separator —
  //   --output-directory "C:\Users\Power User\download\"
  // — escaped its own closing quote and swallowed the following flags into the path. MEASURED via a
  // real cmd.exe parse:
  //   ["--output-directory", "C:\\Users\\Power User\\download\" --app-id after"]
  // Only the trailing run matters: an interior `\` is literal to the parser, so escaping those would
  // corrupt every ordinary Windows path.
  // See: https://learn.microsoft.com/cpp/cpp/main-function-command-line-args#parsing-c-command-line-arguments
  const trailingSlashesDoubled = q.replace(/(\\+)$/, (m) => m + m);
  return `"${trailingSlashesDoubled}"`;
}

// Build the spawnSync invocation for a `pac` call, per platform. Windows: pac resolves as pac.cmd,
// which requires a shell; shell:true ignores an args array, so pass a single cmd-quoted command
// line ("" escapes an embedded quote). POSIX: spawn pac directly with the args array (no shell) so
// embedded quotes and other shell metacharacters round-trip verbatim instead of being mangled by
// cmd-style quoting. Embedded newlines are still collapsed to spaces on every arg — a DEFENSIVE net
// for any arg that still flows inline (e.g. a page --name), since a newline truncates the Windows
// command line. It is no longer relied on for prompts: upload() passes prompt/agent-message via file
// precisely because collapsing THEIR newlines was lossy for multi-line transcripts.
function buildPacInvocation(args, platform = process.platform, opts = {}) {
  const clean = args.map((a) => String(a).replace(/\r\n|[\r\n]/g, ' '));
  const options = { encoding: 'utf8' };
  if (opts.cwd) options.cwd = opts.cwd;
  if (opts.env) options.env = opts.env;
  if (opts.timeoutMs) options.timeout = opts.timeoutMs;
  if (platform === 'win32') {
    return { command: 'pac ' + clean.map(quoteArg).join(' '), args: undefined, options: { ...options, shell: true } };
  }
  return { command: 'pac', args: clean, options };
}

function runPac(args, opts = {}) {
  const inv = buildPacInvocation(args, process.platform, opts);
  const r = inv.args ? spawnSync(inv.command, inv.args, inv.options) : spawnSync(inv.command, inv.options);
  return { status: r.status == null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

module.exports = { quoteArg, buildPacInvocation, runPac };
