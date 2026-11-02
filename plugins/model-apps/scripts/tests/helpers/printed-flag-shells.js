'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { commandArg } = require('../../lib/cli-failure.js');

// Runs the `--authorize …` text a build PRINTED (not a value the test spelled itself) through the real shells this machine has, into a program that reports the
// arguments it received, and returns what each shell handed it. A shell that is not installed is skipped, so the same test passes on Windows, macOS and Linux.
//   Windows          powershell.exe (Windows PowerShell 5.1, always there) and pwsh (PowerShell 7) when installed
//   elsewhere        sh, and bash, zsh and pwsh when installed
// A printed hint is either one spelling for every shell (`--authorize "adopt:view:t/a b"`) or one per shell family, introduced by a label (lib/cli-failure.js
// authorizeFlag); the spelling for the family of the shell under test is the one that is run.
const LABELS = {
  posix: 'in a POSIX shell (sh, bash, zsh) ',
  powershell: 'in PowerShell 7.3 or later ',
  windowsPowerShell: 'in Windows PowerShell 5.1 or PowerShell 7.0\u20137.2 on Windows ',
};

function spellingFor(printed, family) {
  const label = LABELS[family];
  const at = printed.indexOf(label);
  if (at < 0) return printed.slice(printed.lastIndexOf('--authorize'));
  const from = at + label.length;
  const next = printed.indexOf('; in ', from);
  return printed.slice(from, next < 0 ? printed.length : next);
}

function installedShells() {
  const windows = process.platform === 'win32';
  const found = [];
  // Git for Windows ships a POSIX sh; when it is installed the POSIX spelling is run on Windows too.
  const gitSh = windows ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'sh.exe') : null;
  for (const shell of windows ? ['powershell.exe', 'pwsh', ...(gitSh && fs.existsSync(gitSh) ? [gitSh] : [])] : ['sh', 'bash', 'zsh', 'pwsh']) {
    const powershell = shell === 'powershell.exe' || shell === 'pwsh';
    const probe = spawnSync(shell, powershell ? ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'] : ['-c', 'exit 0'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) continue;
    let family = 'posix';
    if (shell === 'powershell.exe') family = 'windowsPowerShell';
    else if (shell === 'pwsh') {
      // PowerShell 7.0-7.2 on Windows still joins the arguments into one command line the way Windows PowerShell does; from 7.3 (and on every other system) they are exact.
      const [major, minor] = String(probe.stdout).trim().split('.').map(Number);
      family = windows && (major < 7 || (major === 7 && minor < 3)) ? 'windowsPowerShell' : 'powershell';
    }
    found.push({ shell, family, powershell });
  }
  return found;
}

// printedTexts: the printed texts, each holding one `--authorize …` hint. Returns [{ shell, family, argv: [[...args of text 0], ...] }].
function runPrintedFlags(printedTexts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'printed-flag-'));
  try {
    const probe = path.join(dir, 'argv.js');
    fs.writeFileSync(probe, "require('node:fs').appendFileSync(process.env.PRINTED_FLAG_OUT, JSON.stringify(process.argv.slice(2)) + '\\n');\n", 'utf8');
    const ran = [];
    for (const { shell, family, powershell } of installedShells()) {
      const out = path.join(dir, `argv-${shell.replace(/\W/g, '')}.jsonl`);
      const lines = printedTexts.map((text) => `${powershell ? '& ' : ''}${commandArg(process.execPath)} ${commandArg(probe)} ${spellingFor(text, family)}`);
      const script = path.join(dir, `run-${shell.replace(/\W/g, '')}.${powershell ? 'ps1' : 'sh'}`);
      // A BOM so Windows PowerShell 5.1 reads the script as UTF-8 and not in the ANSI code page.
      fs.writeFileSync(script, `${powershell ? '\uFEFF' : ''}${lines.join('\n')}\n`, 'utf8');
      const r = spawnSync(shell, powershell ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script] : [script], { encoding: 'utf8', env: { ...process.env, PRINTED_FLAG_OUT: out } });
      assert.ifError(r.error);
      assert.strictEqual(r.status, 0, `${shell}: ${r.stderr}\n${lines.join('\n')}`);
      const argv = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.strictEqual(argv.length, printedTexts.length, `${shell} ran every command`);
      ran.push({ shell, family, argv });
    }
    assert.ok(ran.some((r) => r.shell === (process.platform === 'win32' ? 'powershell.exe' : 'sh')), `the platform's own shell ran: ${ran.map((r) => r.shell).join(', ')}`);
    return ran;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runPrintedFlags, spellingFor, LABELS };
