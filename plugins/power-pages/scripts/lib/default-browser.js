'use strict';

const os = require('os');
const { execFileSync } = require('child_process');

function openInDefaultBrowser(target, deps = {}) {
  const platform = (deps.os || os).platform();
  const execFile = deps.execFileSync || execFileSync;
  if (platform === 'darwin') {
    execFile('open', [target], { stdio: 'ignore' });
  } else if (platform === 'win32') {
    // Avoid `cmd /c start`: cmd.exe reparses metacharacters such as `&` in URL
    // query strings. Also avoid passing the URL as a positional PowerShell
    // argument after `-Command`; Windows PowerShell can treat it as an extra
    // command token instead of binding it to `param(...)`. An environment
    // variable keeps URLs and file paths as inert data while Start-Process still
    // uses the registered default handler.
    execFile('powershell.exe', ['-NoProfile', '-Command', 'Start-Process -FilePath $env:COPILOT_OPEN_TARGET'], {
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, COPILOT_OPEN_TARGET: target },
    });
  } else {
    execFile('xdg-open', [target], { stdio: 'ignore' });
  }
}

module.exports = { openInDefaultBrowser };
