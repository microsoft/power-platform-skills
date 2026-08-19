# Visual QA Static Evaluation

Date: 2026-08-19

## Result

All three eval scenarios pass all ten objective criteria.

| Criterion | Result |
|---|---|
| Native-only runtime evidence | Pass |
| Product Experience/static gates before capture | Pass |
| Deterministic `experience-*` geometry | Pass |
| Premium/high-fidelity full viewport matrix | Pass |
| No brittle pixel-RMSE requirement | Pass |
| Focused repair and same-viewport recapture | Pass |
| Honest block when MCP/screenshots are unavailable | Pass |
| `/debug-app` remains log/runtime focused | Pass |
| Report/status/capture artifacts | Pass |
| No extra approval gate | Pass |

## Scenario Results

1. Premium CMMS with high-fidelity design intake: Pass. Uses full iOS/Android matrix, deterministic geometry, reference comparison, focused fixes, and report artifacts.
2. Utility inspection smoke test without reference: Pass. Uses standard Home/tab coverage, preserves approved personality, and fixes only concrete rendering failures.
3. No Metro, Expo MCP, or native screenshots: Pass. Runs available static preflight, asks once for native evidence, then returns `BLOCKED: no native visual evidence` without treating HTML/source inspection as a runtime pass.

## Baseline Comparison

A generic no-skill response is likely to use one screenshot, browser/static preview, or subjective "looks good" language. The skill instead requires native evidence, measurable contract fields, explicit coverage, focused recapture, and honest incomplete/blocking states.

## Follow-up

Runtime device evaluation remains required when a suitable native app fixture and iOS/Android devices are connected. Static evaluation verifies the workflow contract, not Expo MCP behavior itself.
