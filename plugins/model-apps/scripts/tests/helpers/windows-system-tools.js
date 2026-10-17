'use strict';
// whoami and icacls as the tests start them: by absolute path, from System32 beside cmd.exe — the place
// lib/windows-folder-acl.js puts first on PATH for the same two programs. Never by name alone: a Windows
// machine with Git's tools on PATH (the GitHub-hosted runners are one) finds Git's GNU `whoami` first, which
// rejects `/user`:
//   whoami: extra operand '/user'
//   Try 'whoami --help' for more information.
// so a test that asked for the user's SID by name read nothing on those machines.
const path = require('node:path');
const { windowsCmd } = require('../../lib/process-runner.js');

function systemTool(program, env = process.env) {
  return path.win32.join(path.win32.dirname(windowsCmd(env)), `${program}.exe`);
}

module.exports = { systemTool };
