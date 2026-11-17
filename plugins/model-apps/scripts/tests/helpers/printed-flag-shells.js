'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { commandArg } = require('../../lib/cli-failure.js');

// Runs the `--authorize …` text a build PRINTED (not a value the test spelled itself) through the real shells this machine has, into a program that reports the
// arguments it received, and returns what each shell handed it. Each shell that is installed is run and each one that is not is skipped, so the same test passes
// on Windows, macOS and Linux — and when none can run, skipWithoutShells reports a skip, never a failure.
//   Windows          powershell.exe (Windows PowerShell 5.1), pwsh (PowerShell 7) and Git for Windows' sh when installed
//   elsewhere        sh, and bash, zsh and pwsh when installed
// The printed hint is one spelling for every shell (lib/cli-failure.js authorizeFlag), so the same text is run in all of them.

function probeShell(shell, powershell) {
  const r = spawnSync(shell, powershell ? ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'] : ['-c', 'exit 0'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

// probe(shell, powershell) → true when that shell runs; a test passes its own to stand in for a machine without a shell.
function installedShells(probe = probeShell) {
  const windows = process.platform === 'win32';
  // Git for Windows ships a POSIX sh; when it is installed the same text is run through it on Windows too.
  const gitSh = windows ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'sh.exe') : null;
  const candidates = windows ? ['powershell.exe', 'pwsh', ...(gitSh && fs.existsSync(gitSh) ? [gitSh] : [])] : ['sh', 'bash', 'zsh', 'pwsh'];
  const found = [];
  for (const shell of candidates) {
    const powershell = shell === 'powershell.exe' || shell === 'pwsh';
    if (probe(shell, powershell)) found.push({ shell, powershell });
  }
  return found;
}

// Marks the running test skipped when no shell can run and returns true, so the caller returns; false when there is something to check.
function skipWithoutShells(t, ran) {
  if (ran.length > 0) return false;
  t.skip('no shell (powershell.exe, pwsh, sh, bash or zsh) is installed on this machine');
  return true;
}

// printedTexts: the printed texts, each holding one `--authorize …` hint. Returns [{ shell, argv: [[...args of text 0], ...] }], one entry per shell that ran.
function runPrintedFlags(printedTexts, shells = installedShells()) {
  if (shells.length === 0) return [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'printed-flag-'));
  try {
    const probe = path.join(dir, 'argv.js');
    fs.writeFileSync(probe, "require('node:fs').appendFileSync(process.env.PRINTED_FLAG_OUT, JSON.stringify(process.argv.slice(2)) + '\\n');\n", 'utf8');
    const ran = [];
    for (const { shell, powershell } of shells) {
      const out = path.join(dir, `argv-${shell.replace(/\W/g, '')}.jsonl`);
      const lines = printedTexts.map((text) => `${powershell ? '& ' : ''}${commandArg(process.execPath)} ${commandArg(probe)} ${text.slice(text.lastIndexOf('--authorize'))}`);
      const script = path.join(dir, `run-${shell.replace(/\W/g, '')}.${powershell ? 'ps1' : 'sh'}`);
      // A BOM so Windows PowerShell 5.1 reads the script as UTF-8 and not in the ANSI code page.
      fs.writeFileSync(script, `${powershell ? '\uFEFF' : ''}${lines.join('\n')}\n`, 'utf8');
      const r = spawnSync(shell, powershell ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script] : [script], { encoding: 'utf8', env: { ...process.env, PRINTED_FLAG_OUT: out } });
      assert.ifError(r.error);
      assert.strictEqual(r.status, 0, `${shell}: ${r.stderr}\n${lines.join('\n')}`);
      const argv = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.strictEqual(argv.length, printedTexts.length, `${shell} ran every command`);
      ran.push({ shell, argv });
    }
    return ran;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runPrintedFlags, installedShells, skipWithoutShells };
