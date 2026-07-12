'use strict';

const os = require('os');
const { execFileSync } = require('child_process');

function openInDefaultBrowser(target, deps = {}) {
  const platform = (deps.os || os).platform();
  const execFile = deps.execFileSync || execFileSync;
  if (platform === 'darwin') {
    execFile('open', [target], { stdio: 'ignore' });
  } else if (platform === 'win32') {
    // Windows `start` is a cmd.exe built-in, not an executable. The empty
    // string is the window-title slot; without it, a quoted URL/path can be
    // misread as the title and nothing opens.
    execFile('cmd', ['/c', 'start', '', target], { stdio: 'ignore', windowsHide: true });
  } else {
    execFile('xdg-open', [target], { stdio: 'ignore' });
  }
}

module.exports = { openInDefaultBrowser };
