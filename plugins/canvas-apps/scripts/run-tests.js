// Canvas-apps script regression gate. Runs every scripts/tests/*.test.js and exits
// non-zero on any failure. Kept as an explicit entrypoint (rather than a bare
// `node --test`) so the documented local command and the CI job invoke exactly the
// same thing — a green CI run means the same as a green local run.
//
// The suite shells out to `dotnet run --file` (the validator is a .NET file-based app),
// so a .NET 10 SDK must be on PATH; see AGENTS.md "Prerequisites".

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const testsDir = path.join(__dirname, 'tests');
const testFiles = fs
    .readdirSync(testsDir)
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => path.join(testsDir, name));

if (testFiles.length === 0) {
    console.error('No test files found under scripts/tests.');
    process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], { stdio: 'inherit' });
process.exit(result.status ?? 1);
