'use strict';
// A REAL console event — Ctrl+C or Ctrl+Break — sent to a child process on Windows, and how the child ended.
//
// Why it is not `child.kill()`: Windows has no signals. `child.kill('SIGINT')` there is TerminateProcess, which runs nothing in the child and ends it with status 1, and `process.emit('SIGINT')` only calls the
// listeners. What a user's Ctrl+C does is another thing — the console subsystem tells every process attached to the console, a process with no handler of its own ends with STATUS_CONTROL_C_EXIT
// (0xC000013A), and Node turns the event into 'SIGINT' (Ctrl+C) or 'SIGBREAK' (Ctrl+Break) for a process that listens. Only `GenerateConsoleCtrlEvent` does that, and Node cannot call it, so a Windows
// PowerShell does: it starts each child in a console of its own (hidden — never the console of whoever is running the tests), attaches to that console, and sends the event to it.
//
// SAFETY. An event sent with `GenerateConsoleCtrlEvent` reaches EVERY process attached to the console it is sent on: group 0 is all of them, and Ctrl+C cannot be aimed at a narrower group. A shell, an editor, the
// test runner and another job would be ended by it if they shared that console. So nothing is sent until the console the sender has attached to has been LISTED (`GetConsoleProcessList`) and is known to hold the
// child and the sender and no other process; otherwise no event is sent and the scenario ends with an error. No event is ever sent on the console of the process that runs this file, nor on one nobody checked.
//
// Many children are run by ONE PowerShell, one after the other: compiling the few lines of C# that make the calls takes about a second, and each child about one more.
//
//   runInConsoles([{ event: 'CTRL_C', script, args, ready, env }])  →  [{ delivered, exited, status, error }]
//     event    CTRL_C | CTRL_BREAK
//     script   the Node program to run, with `args`; it must say it is ready — by writing the file `ready` — once its handlers are in place
//     env      environment variables for the child alone
//   `status` is the child's exit status as Windows has it, unsigned (a console event ends a child with 0xC000013A, which is -1073741510 as a signed number). `delivered` is false when the event could not be
//   sent (the child never became ready, or the console could not be attached), and `exited` false when the child was still running 20 seconds after it: it is ended then, and the caller decides what that means.
//
// WHEN A TEST THAT USES IT SKIPS, AND WHEN IT FAILS — one answer for every test file, given here (`consoleVerdict`, `controlProblem`) so that it cannot differ from file to file. Whether a machine can carry a console event to
// a child at all is a fact about the machine, not about the code under test: a test SKIPS, with the reason, when the PowerShell cannot compile the sender (a constrained language mode), when the child's console cannot be
// attached or listed, when the event cannot be sent, when the child's console is shared with another process (nothing is sent then, by design), or when the CONTROL of an event — a child that registers nothing — does not end as a
// cancelled process (0xC000013A): a machine that cannot show how a process with no handler ends cannot say how another one does. It FAILS when an event was delivered to a console that another process shared, when the control
// child could not be run for a reason the sender does not explain, and for every defect of the sender or of the child: those say something about the code, and a skip would hide it.
// See: https://learn.microsoft.com/windows/console/generateconsolectrlevent
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const WINDOWS = process.platform === 'win32';
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// The values of GenerateConsoleCtrlEvent's first argument.
const EVENTS = Object.freeze({ CTRL_C: 0, CTRL_BREAK: 1 });
// What Windows ends a process with when a console event reached it and nothing handled it: STATUS_CONTROL_C_EXIT, "{Application Exit by CTRL+C}".
// See: https://learn.microsoft.com/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55
const STATUS_CONTROL_C_EXIT = 0xC000013A;

// The PowerShell that does the work. No backtick and no `${` in it: it lives in a template literal.
const DRIVER = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# A variable first: Windows PowerShell hands a JSON array on as ONE object when it is piped, and the loop would see the whole array as a scenario.
$scenarios = ConvertFrom-Json -InputObject $env:CONSOLE_EVENT_SCENARIOS
# A PowerShell that does not allow Add-Type (a constrained language mode, which a machine's policy can set) cannot send anything: that is said for every scenario, as an error of its result.
$unavailable = $null
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  $unavailable = 'this PowerShell is in ' + $ExecutionContext.SessionState.LanguageMode + ' language mode, which does not allow the helper that sends console events'
} else {
  try {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class ConsoleEvents {
  delegate bool HandlerRoutine(uint type);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetConsoleCtrlHandler(HandlerRoutine handler, bool add);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GenerateConsoleCtrlEvent(uint ev, uint group);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint GetConsoleProcessList(uint[] processList, uint processCount);
  [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
  // The event goes to EVERY process attached to the console, this one included: it is told it was handled.
  static readonly HandlerRoutine ignore = delegate (uint type) { return true; };
  // A process started with Ctrl+C switched off passes that on to its children (a runner can start a step that way); the children started from here must not have it.
  public static void EnableCtrlC() { SetConsoleCtrlHandler(IntPtr.Zero, false); }
  // An event sent to the console reaches every process attached to it — the group 0 of GenerateConsoleCtrlEvent is all of them, and Ctrl+C cannot be aimed at less — so nothing is sent until the console this
  // process has just attached to is KNOWN to hold the child and this process and nobody else: the console made for the child, not the console of whoever is running the tests, a shell, or another job.
  // Every refusal of Send ends in "no event was sent", in this file's words and not in the language of the operating system's own message (Refused): that is what the tests tell a machine that cannot send an event from a defect.
  static Exception Refused(string what, int error) { return new InvalidOperationException(what + " (" + new Win32Exception(error).Message + "): no event was sent"); }
  public static void Send(uint pid, uint ev) {
    FreeConsole();
    if (!AttachConsole(pid)) throw Refused("the child's console could not be attached", Marshal.GetLastWin32Error());
    uint self = GetCurrentProcessId();
    uint[] attached = new uint[64];
    uint count = GetConsoleProcessList(attached, (uint)attached.Length);
    if (count == 0 || count > attached.Length) { FreeConsole(); throw new InvalidOperationException("the processes on the child's console could not be listed: no event was sent"); }
    bool childIsThere = false;
    for (int i = 0; i < count; i++) {
      if (attached[i] == pid) childIsThere = true;
      else if (attached[i] != self) { FreeConsole(); throw new InvalidOperationException("the child's console is shared with another process: no event was sent"); }
    }
    if (!childIsThere) { FreeConsole(); throw new InvalidOperationException("the child is not on the console that was attached: no event was sent"); }
    SetConsoleCtrlHandler(ignore, true);
    if (!GenerateConsoleCtrlEvent(ev, 0)) throw Refused("the event could not be sent", Marshal.GetLastWin32Error());
  }
  public static void Detach() { FreeConsole(); }
}
'@
    [ConsoleEvents]::EnableCtrlC()
  } catch {
    $unavailable = 'the helper that sends console events could not be compiled: ' + $_.Exception.Message
  }
}
$node = $env:CONSOLE_EVENT_NODE
$quote = { param($value) '"' + ([string]$value -replace '"', '\"') + '"' }
$results = @()
foreach ($scenario in $scenarios) {
  $result = [ordered]@{ delivered = $false; exited = $false; status = $null; error = $null }
  if ($unavailable) {
    $result.error = $unavailable
    $results += [pscustomobject]$result
    continue
  }
  $saved = @{}
  $child = $null
  try {
    if ($scenario.env) {
      foreach ($variable in $scenario.env.PSObject.Properties) {
        $saved[$variable.Name] = [Environment]::GetEnvironmentVariable($variable.Name)
        [Environment]::SetEnvironmentVariable($variable.Name, [string]$variable.Value)
      }
    }
    $arguments = (@($scenario.script) + @($scenario.args) | ForEach-Object { & $quote $_ }) -join ' '
    $child = Start-Process -FilePath $node -ArgumentList $arguments -WindowStyle Hidden -PassThru
    # Reading the handle keeps it, which ExitCode needs.
    $null = $child.Handle
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while (-not (Test-Path -LiteralPath $scenario.ready)) {
      if ($child.HasExited) { throw 'the child ended before it was ready' }
      if ([DateTime]::UtcNow -gt $deadline) { throw 'the child was not ready in 60 seconds' }
      Start-Sleep -Milliseconds 50
    }
    [ConsoleEvents]::Send([uint32]$child.Id, [uint32]$scenario.event)
    $result.delivered = $true
    $result.exited = $child.WaitForExit(20000)
    if ($result.exited) { $result.status = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$child.ExitCode), 0) }
  } catch {
    $result.error = $_.Exception.Message
  } finally {
    [ConsoleEvents]::Detach()
    if ($child -and -not $child.HasExited) { $child.Kill() }
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
  }
  $results += [pscustomobject]$result
}
ConvertTo-Json -Compress -InputObject @($results)
`;

/**
 * Runs each scenario in a console of its own, one after the other, and answers one result per scenario (see the top of the file).
 * @param {{ event: 'CTRL_C'|'CTRL_BREAK', script: string, args?: string[], ready: string, env?: Record<string,string> }[]} scenarios
 * @returns {Promise<{ delivered: boolean, exited: boolean, status: number|null, error: string|null }[]>}
 */
function runInConsoles(scenarios) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(DRIVER, 'utf16le').toString('base64');
    const wanted = scenarios.map((scenario) => ({ ...scenario, event: EVENTS[scenario.event] }));
    const driver = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      env: { ...process.env, CONSOLE_EVENT_NODE: process.execPath, CONSOLE_EVENT_SCENARIOS: JSON.stringify(wanted) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    driver.stdout.on('data', (data) => { stdout += data; });
    driver.stderr.on('data', (data) => { stderr += data; });
    // A hung driver must not hold the suite: the longest run is a minute for a child that is never ready and 20 seconds for each child that does not end, per scenario.
    const timer = setTimeout(() => driver.kill(), 90 * 1000 + wanted.length * 25 * 1000);
    driver.once('error', (error) => { clearTimeout(timer); reject(error); });
    driver.once('close', (code) => {
      clearTimeout(timer);
      const line = stdout.trim().split(/\r?\n/).pop();
      try {
        const results = JSON.parse(line);
        if (!Array.isArray(results) || results.length !== scenarios.length) throw new Error('not one result per scenario');
        resolve(results);
      } catch (error) {
        reject(new Error(`the console driver gave no usable answer (exit ${code}): ${error.message}\n${stdout}\n${stderr}`));
      }
    });
  });
}

// What the sender's own refusals say. The one that a test may EXPECT — a child whose console is shared — is told apart from the others, which mean that this machine cannot send an event at all.
const SHARED_CONSOLE = /shared with another process: no event was sent/;
// A PowerShell that cannot compile the sender (a constrained language mode, or a compiler that fails); a refusal of `Send` — attaching to the child's console, listing it, sending (each ends in "no event was sent", see `Refused` in
// the driver); and PowerShell's own wrapper for whatever `Send` throws, `Exception calling "Send" with "2" argument(s): "<the operating system's words>"`, which an operating system's own message for a failed attach (`The handle is
// invalid`, `Access is denied`) arrives in when it is not worded by the driver.
const UNAVAILABLE = /language mode|could not be compiled|\bno event was sent\b|^Exception calling "Send"/;

/**
 * What one result of `runInConsoles` says, so that every test that runs a console scenario answers the same question the same way (see the top of the file):
 *   `delivered`    the event was sent: what became of the child is for the test to judge
 *   `shared`       the sender refused, by design, because the child's console is shared with another process: the right answer for a child that shares its console on purpose (console-event.test.js), and for any other
 *                  test a machine that gives a child no console of its own
 *   `unavailable`  this machine cannot send a console event, and nothing was sent: `reason` says why. A test that needs an event skips, with the reason
 *   `defect`       anything else, which the sender does not explain — a child that was never ready, a driver that failed in another way: the failure of a sender or a child, which a test reports and never skips
 * @param {{ delivered: boolean, error: string|null }} result
 * @returns {{ kind: 'delivered'|'shared'|'unavailable'|'defect', reason?: string }}
 */
function consoleVerdict(result) {
  if (result.delivered) return { kind: 'delivered' };
  const error = String(result.error === null || result.error === undefined ? '' : result.error);
  if (SHARED_CONSOLE.test(error)) return { kind: 'shared', reason: `the child's console is shared with another process (${error})` };
  if (UNAVAILABLE.test(error)) return { kind: 'unavailable', reason: `this machine cannot send a console event to a child (${error})` };
  return { kind: 'defect', reason: error || 'no event was sent, and no reason was given' };
}

/**
 * The check every test that compares how a process ends with how the CONTROL of the same event ends shares: a control is a child that registers nothing, and it shows how Windows ends a process that nothing handles when
 * the event reaches it — STATUS_CONTROL_C_EXIT. Answers `null` when the control ended so, and otherwise the reason to skip the test with: this machine cannot send the event, or its console is shared, or the control
 * did not end as a cancelled process, so it cannot say how any other process ends. Fails (an AssertionError) when the control could not be run for a reason that is a defect of the sender or of the child.
 * @param {{ delivered: boolean, exited: boolean, status: number|null, error: string|null }} control
 * @param {string} key - the event as a person names it, for the reason: `Ctrl+C`
 * @returns {string|null}
 */
function controlProblem(control, key) {
  const verdict = consoleVerdict(control);
  if (verdict.kind === 'unavailable' || verdict.kind === 'shared') return `${verdict.reason}, so it cannot say how a process ends when ${key} reaches it`;
  assert.notStrictEqual(verdict.kind, 'defect', `the control of ${key}, a child that registers nothing, could not be run: ${JSON.stringify({ ...control, files: undefined })}`);
  if (!control.exited) return `the control of ${key}, a child that registers nothing, was still running 20 seconds after the event was sent to it, so this machine cannot say how a process ends when ${key} reaches it`;
  if (control.status !== STATUS_CONTROL_C_EXIT) {
    return `the control of ${key}, a child that registers nothing, ended with status ${control.status} and not with STATUS_CONTROL_C_EXIT (${STATUS_CONTROL_C_EXIT}), so this machine cannot say how a process that is cancelled by ${key} ends`;
  }
  return null;
}

module.exports = { WINDOWS, runInConsoles, consoleVerdict, controlProblem, STATUS_CONTROL_C_EXIT };
