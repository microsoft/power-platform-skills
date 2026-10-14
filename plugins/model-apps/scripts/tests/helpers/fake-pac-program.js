'use strict';
// The program behind a fake `pac` (helpers/fake-pac.js puts it on PATH): it records its arguments and answers what the test configured.
//
// The configuration is a JSON file named by FAKE_PAC_CONFIG:
//   { "log": "<file the calls are appended to, one JSON object per line>",
//     "responses": [ { "match": ["solution", "create-settings"],        the leading arguments a call must have
//                      "status": 0, "stdout": "…", "stderr": "…",
//                      "writeFlag": "--settings-file", "writeContent": "<text>",   write this text at the path that flag names (what pac does)
//                      "snapshot": ["--settings-file", "--path"] } ] }   record what these flags' files held (text, and a package's size)
// A call no response matches exits 9, so a script that runs a pac command a test did not expect fails loudly.
//
// Two ways to run: as a script (`node fake-pac-program.js <pac's arguments>`), and — behind a launcher the process runner starts directly (fake-pac.js, launcher
// 'forwarder') — `--require`d by a node.exe that is named pac.launcher.exe: node was handed pac's arguments where it expects a script, and this file answers for pac
// and exits before node looks for one. node has already made its first argument an absolute path, so what pac was given is that path's file name ('model',
// 'solution', 'connection': pac's first argument is never a path). Every other node process that inherits the option — the script under test — does nothing here.
const fs = require('node:fs');
const path = require('node:path');

const asLauncher = /^pac\.launcher\.exe$/i.test(path.basename(process.execPath));
if (require.main !== module && !asLauncher) return;

const config = JSON.parse(fs.readFileSync(process.env.FAKE_PAC_CONFIG, 'utf8'));
const args = asLauncher ? [path.basename(process.argv[1]), ...process.argv.slice(2)] : process.argv.slice(2);
const response = config.responses.find((r) => r.match.every((m, i) => args[i] === m));

const call = { args };
if (response) {
  call.snapshots = {};
  for (const flag of response.snapshot || []) {
    const file = args[args.indexOf(flag) + 1];
    try {
      const bytes = fs.readFileSync(file);
      call.snapshots[flag] = { bytes: bytes.length, text: bytes.toString('utf8').slice(0, 20000) };
    } catch {
      call.snapshots[flag] = null;
    }
  }
}
fs.appendFileSync(config.log, `${JSON.stringify(call)}\n`);

if (!response) {
  process.stderr.write(`fake pac: no response for: ${args.join(' ')}\n`);
  process.exit(9);
}
if (response.writeFlag) fs.writeFileSync(args[args.indexOf(response.writeFlag) + 1], response.writeContent);
if (response.stdout) process.stdout.write(response.stdout);
if (response.stderr) process.stderr.write(response.stderr);
process.exit(response.status || 0);
