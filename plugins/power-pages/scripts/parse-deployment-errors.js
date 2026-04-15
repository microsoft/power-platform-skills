#!/usr/bin/env node

// Parses PAC CLI stderr output and Dataverse OData error JSON into structured
// diagnostic findings for the diagnose-deployment skill.
//
// Usage:
//   node parse-deployment-errors.js --input "<stderr text or JSON string>"
//   node parse-deployment-errors.js --file "/path/to/error-output.txt"
//
// Output (JSON to stdout):
//   {
//     "findings": [
//       {
//         "patternId": "blocked-js",
//         "type": "upload" | "solution" | "auth" | "config" | "build",
//         "severity": "Error" | "Warning" | "Info",
//         "message": "Human-readable description",
//         "rawMatch": "The matched text fragment",
//         "autoFixAvailable": true | false,
//         "suggestedFix": "Description of fix or manual steps"
//       }
//     ],
//     "errorCount": 2,
//     "warningCount": 1,
//     "infoCount": 0
//   }

const fs = require('fs');

function output(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

function parseArgs(argv) {
  const args = {};
  const inputIdx = argv.indexOf('--input');
  const fileIdx = argv.indexOf('--file');
  if (inputIdx !== -1 && inputIdx + 1 < argv.length) args.input = argv[inputIdx + 1];
  if (fileIdx !== -1 && fileIdx + 1 < argv.length) args.file = argv[fileIdx + 1];
  return args;
}

// Known error patterns — ordered by specificity (more specific patterns first)
const ERROR_PATTERNS = [
  {
    patternId: 'stale-manifest',
    type: 'upload',
    severity: 'Error',
    patterns: [
      /manifest.*out of date/i,
      /manifest mismatch/i,
      /manifest version conflict/i,
      /manifest.*not match/i,
    ],
    message: 'Stale environment manifest file detected. The local manifest does not match the target environment.',
    autoFixAvailable: true,
    suggestedFix: 'Delete the stale *-manifest.yml file in .powerpages-site/. PAC CLI will regenerate it on next upload.',
  },
  {
    patternId: 'blocked-js',
    type: 'upload',
    severity: 'Error',
    patterns: [
      /javascript.*attachment.*blocked/i,
      /\.js.*not allowed/i,
      /blocked file type.*\.js/i,
      /files could not be uploaded.*\.js/i,
      /blocked.*attachment.*js/i,
    ],
    message: 'JavaScript (.js) file uploads are blocked in this environment.',
    autoFixAvailable: true,
    suggestedFix: "Update the 'blockedattachments' environment setting to remove .js from the blocked list using: pac env update-settings --name blockedattachments",
  },
  {
    patternId: 'missing-website-record-id',
    type: 'config',
    severity: 'Error',
    patterns: [
      /websiteRecordId.*missing/i,
      /websiteRecordId.*empty/i,
      /no website record id/i,
      /cannot identify target website/i,
      /websiterecordid.*null/i,
    ],
    message: "Missing websiteRecordId in powerpages.config.json. The site may not be activated yet.",
    autoFixAvailable: true,
    suggestedFix: "Run 'pac pages list' to find the websiteRecordId, then update powerpages.config.json. If no record exists, activate the site first with /power-pages:activate-site.",
  },
  {
    patternId: 'auth-expired',
    type: 'auth',
    severity: 'Error',
    patterns: [
      /authentication token expired/i,
      /AADSTS70011/i,
      /AADSTS/i,
      /unauthorized.*401/i,
      /run.*pac auth create/i,
      /please.*log.*in/i,
      /token.*expired/i,
    ],
    message: 'Authentication token has expired. Re-authentication is required.',
    autoFixAvailable: true,
    suggestedFix: "Re-authenticate: run 'pac auth create --environment <envUrl>' and 'az login'.",
  },
  {
    patternId: 'empty-build',
    type: 'build',
    severity: 'Error',
    patterns: [
      /no files to upload/i,
      /0 files uploaded/i,
      /build output.*not found/i,
      /dist.*directory.*empty/i,
      /dist.*is empty/i,
      /compiledpath.*missing/i,
    ],
    message: "Build output is empty or missing. The site was not built before upload.",
    autoFixAvailable: true,
    suggestedFix: "Run 'npm run build' in the project root to generate the build output, then retry the upload.",
  },
  {
    patternId: 'missing-dependency',
    type: 'solution',
    severity: 'Error',
    patterns: [
      /MissingDependency/i,
      /missing required component/i,
      /dependency not found/i,
      /solution requires.*not present/i,
    ],
    message: 'Solution import failed due to missing dependencies in the target environment.',
    autoFixAvailable: false,
    suggestedFix: 'Export and import the dependency solutions first, then retry. Use StageSolution before import to identify all missing dependencies upfront.',
  },
  {
    patternId: 'solution-timeout',
    type: 'solution',
    severity: 'Warning',
    patterns: [
      /export.*still.*running.*timeout/i,
      /import.*still.*running.*timeout/i,
      /async.*operation.*timeout/i,
      /still in progress after/i,
    ],
    message: 'Solution async operation timed out. The operation may still be running in Dataverse.',
    autoFixAvailable: false,
    suggestedFix: "Check the operation status: GET {envUrl}/api/data/v9.2/asyncoperations({asyncJobId})?$select=statecode,statuscode. If statecode=3 and statuscode=30, it succeeded — retry the download step.",
  },
  {
    patternId: 'pac-not-installed',
    type: 'upload',
    severity: 'Error',
    patterns: [
      /pac.*command not found/i,
      /pac.*not recognized/i,
      /pac cli.*not installed/i,
      /'pac'.*not recognized/i,
    ],
    message: 'Power Platform CLI (pac) is not installed or not found in PATH.',
    autoFixAvailable: false,
    suggestedFix: "Install PAC CLI: 'dotnet tool install --global Microsoft.PowerApps.CLI.Tool'. Verify with: 'pac --version'.",
  },
  {
    patternId: 'environment-mismatch',
    type: 'config',
    severity: 'Warning',
    patterns: [
      /uploading.*different environment.*manifest/i,
      /environment.*url.*mismatch/i,
      /target environment.*does not match/i,
    ],
    message: 'Current PAC CLI environment differs from the environment recorded in the solution manifest.',
    autoFixAvailable: true,
    suggestedFix: "Verify the target environment: run 'pac env who'. Switch if needed: 'pac org select --environment <envUrl>'.",
  },
  {
    patternId: 'duplicate-component',
    type: 'solution',
    severity: 'Info',
    patterns: [
      /component already exists in solution/i,
      /duplicate component/i,
      /already part of the solution/i,
    ],
    message: 'A component was already present in the solution (duplicate add was skipped).',
    autoFixAvailable: false,
    suggestedFix: 'No action needed. This is informational — the component is already correctly included in the solution.',
  },
];

function parseInput(text) {
  const findings = [];
  const seenPatternIds = new Set();

  for (const errorDef of ERROR_PATTERNS) {
    for (const regex of errorDef.patterns) {
      const match = text.match(regex);
      if (match && !seenPatternIds.has(errorDef.patternId)) {
        seenPatternIds.add(errorDef.patternId);
        findings.push({
          patternId: errorDef.patternId,
          type: errorDef.type,
          severity: errorDef.severity,
          message: errorDef.message,
          rawMatch: match[0].substring(0, 200), // cap raw match length
          autoFixAvailable: errorDef.autoFixAvailable,
          suggestedFix: errorDef.suggestedFix,
        });
        break; // only add once per error definition
      }
    }
  }

  // Also try to parse as OData error JSON
  try {
    const parsed = JSON.parse(text);
    const odataError = parsed.error || parsed.Error;
    if (odataError && odataError.message && !seenPatternIds.has('odata-error')) {
      // Check if the OData error matches a known pattern
      let matched = false;
      for (const errorDef of ERROR_PATTERNS) {
        for (const regex of errorDef.patterns) {
          if (regex.test(odataError.message) && !seenPatternIds.has(errorDef.patternId)) {
            seenPatternIds.add(errorDef.patternId);
            findings.push({
              patternId: errorDef.patternId,
              type: errorDef.type,
              severity: errorDef.severity,
              message: errorDef.message,
              rawMatch: odataError.message.substring(0, 200),
              autoFixAvailable: errorDef.autoFixAvailable,
              suggestedFix: errorDef.suggestedFix,
            });
            matched = true;
            break;
          }
        }
        if (matched) break;
      }

      // If no pattern matched, surface as a generic OData error
      if (!matched) {
        findings.push({
          patternId: 'odata-error',
          type: 'solution',
          severity: 'Error',
          message: `Dataverse API error: ${odataError.message}`,
          rawMatch: odataError.message.substring(0, 200),
          autoFixAvailable: false,
          suggestedFix: `Error code: ${odataError.code || 'unknown'}. Check Dataverse solution logs for details.`,
        });
      }
    }
  } catch {
    // Not JSON — that's fine, already parsed as text above
  }

  const errorCount = findings.filter((f) => f.severity === 'Error').length;
  const warningCount = findings.filter((f) => f.severity === 'Warning').length;
  const infoCount = findings.filter((f) => f.severity === 'Info').length;

  return { findings, errorCount, warningCount, infoCount };
}

// Main
const args = parseArgs(process.argv.slice(2));

let inputText = '';

if (args.file) {
  try {
    inputText = fs.readFileSync(args.file, 'utf8');
  } catch (err) {
    output({ error: `Cannot read file: ${err.message}` });
  }
} else if (args.input) {
  inputText = args.input;
} else {
  // Read from stdin
  let stdinData = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (stdinData += chunk));
  process.stdin.on('end', () => {
    output(parseInput(stdinData));
  });
  process.stdin.resume();
  return; // async path
}

output(parseInput(inputText));
