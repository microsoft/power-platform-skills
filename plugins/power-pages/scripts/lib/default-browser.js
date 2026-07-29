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
    // query strings. Passing the target as a PowerShell argument keeps it as
    // data while still letting Windows choose the registered default handler.
    execFile('powershell.exe', ['-NoProfile', '-Command', 'param([string]$Target) Start-Process -FilePath $Target', target], { stdio: 'ignore', windowsHide: true });
  } else {
    execFile('xdg-open', [target], { stdio: 'ignore' });
  }
}

module.exports = { openInDefaultBrowser };
