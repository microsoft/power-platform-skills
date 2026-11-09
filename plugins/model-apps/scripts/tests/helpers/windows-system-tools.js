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

// How an access list saved as SDDL (`icacls /save`) names this user: by its SID — or, when the account is the machine's own
// built-in Administrator (RID 500) or Guest (RID 501), by the alias LA or LG. The administrator account a CI runner or a
// virtual machine is made with IS the built-in Administrator, renamed, and its lists read `(A;OICI;FA;;;LA)`.
function sddlNamesOf(sid) {
  const names = [sid];
  if (/^S-1-5-21-\d+-\d+-\d+-500$/.test(sid)) names.push('LA');
  if (/^S-1-5-21-\d+-\d+-\d+-501$/.test(sid)) names.push('LG');
  return names;
}
// BUILTIN\Administrators: the owner of what an ELEVATED process makes (a CI runner's processes are), which lib/windows-folder-acl.js
// accepts as an owner beside the user.
const ADMINISTRATORS_SID = 'S-1-5-32-544';

module.exports = { systemTool, sddlNamesOf, ADMINISTRATORS_SID };
