#!/usr/bin/env node

// Checks for an ALM plan and reports freshness. Used as a Phase 0 gate by ALM
// skills (setup-pipeline, deploy-pipeline, etc.) so the orchestrator
// (plan-alm) becomes the front door for ALM intents.
//
// Usage:
//   node check-alm-plan.js --projectRoot <path>
//                          [--envUrl <url>] [--token <t>] [--solutionId <id>]
//
// Output (JSON to stdout):
//   {
//     exists:     true | false,
//     planPath:   "<projectRoot>/docs/.alm-plan-data.json" | null,
//     htmlPath:   "<projectRoot>/docs/alm-plan.html" | null,
//     generatedAt: "<ISO timestamp>" | null,
//     approver:    "..." | null,
//     planStatus:  "Draft" | "Approved" | "In Execution" | "Completed" | null,
//     stale:       true | false,
//     staleness: {
//       reason:    "no-plan" | "solution-modified" | null,
//       detail:    "<human-readable>" | null
//     }
//   }
//
// Exit 0 always (callers inspect the JSON). Exit 1 on argparse / fatal error.
//
// Freshness logic:
//   - No plan file -> exists:false, stale:true (reason: "no-plan").
//   - Plan file unreadable -> exists:false, stale:true (reason: "no-plan").
//   - When --envUrl + --token + --solutionId are all provided, query the
//     solution's modifiedon and compare against planData.GENERATED_AT. If
//     the solution was modified after the plan was generated -> stale
//     (reason: "solution-modified").
//   - Without env credentials, the helper returns stale:false based on
//     existence alone — callers that want a deeper check can run
//     discover-site-components.js separately.

'use strict';

const fs = require('fs');
const path = require('path');
const helpers = require('./validation-helpers');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    projectRoot: process.cwd(),
    envUrl: null,
    token: null,
    solutionId: null,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--projectRoot' && args[i + 1]) out.projectRoot = args[++i];
    else if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--solutionId' && args[i + 1]) out.solutionId = args[++i];
  }
  return out;
}

function emptyResult(extraStaleness) {
  return {
    exists: false,
    planPath: null,
    htmlPath: null,
    generatedAt: null,
    approver: null,
    planStatus: null,
    stale: true,
    staleness: extraStaleness || { reason: 'no-plan', detail: 'ALM plan not found. Run /power-pages:plan-alm to create one.' },
  };
}

async function checkAlmPlan({ projectRoot, envUrl, token, solutionId, makeRequest }) {
  if (!projectRoot) throw new Error('--projectRoot is required');
  const planPath = path.join(projectRoot, 'docs', '.alm-plan-data.json');
  const htmlPath = path.join(projectRoot, 'docs', 'alm-plan.html');

  if (!fs.existsSync(planPath)) {
    return emptyResult();
  }

  let planData;
  try {
    planData = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  } catch (e) {
    return emptyResult({
      reason: 'no-plan',
      detail: 'docs/.alm-plan-data.json could not be parsed as JSON: ' + e.message,
    });
  }

  const result = {
    exists: true,
    planPath,
    htmlPath: fs.existsSync(htmlPath) ? htmlPath : null,
    generatedAt: planData.GENERATED_AT || null,
    approver: planData.APPROVED_BY || null,
    planStatus: planData.PLAN_STATUS || null,
    stale: false,
    staleness: { reason: null, detail: null },
  };

  // Optional: solution modifiedon vs plan GENERATED_AT comparison.
  if (envUrl && token && solutionId) {
    const url = envUrl.replace(/\/+$/, '') +
      '/api/data/v9.2/solutions(' + solutionId + ')?$select=modifiedon,version';
    let res;
    try {
      res = await (makeRequest || helpers.makeRequest)({
        url,
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + token,
          'OData-Version': '4.0',
          'OData-MaxVersion': '4.0',
          Accept: 'application/json',
        },
        timeout: 10000,
      });
    } catch {
      // Network errors are non-fatal — skip the check
      return result;
    }

    if (res && res.statusCode === 200 && res.body) {
      let sol;
      try { sol = JSON.parse(res.body); } catch { return result; }
      const modOn = sol.modifiedon;
      if (modOn && result.generatedAt) {
        const planTime = Date.parse(result.generatedAt);
        const solTime = Date.parse(modOn);
        if (Number.isFinite(planTime) && Number.isFinite(solTime) && solTime > planTime) {
          result.stale = true;
          result.staleness = {
            reason: 'solution-modified',
            detail: 'Solution was modified at ' + modOn + ' (after plan generated at ' + result.generatedAt + '). Components may have changed since.',
          };
        }
      }
    }
  }

  return result;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  checkAlmPlan(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => { process.stderr.write('check-alm-plan: ' + e.message + '\n'); process.exit(1); });
}

module.exports = { checkAlmPlan };
