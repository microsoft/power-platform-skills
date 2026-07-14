#!/usr/bin/env node
'use strict';

/**
 * Verify that every approved pathological Canvas event handler is implemented
 * as an invoked named-step workflow module. Behavior semantics remain covered
 * by check-behavior-coverage.js; this gate enforces the approved architecture.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const STRICT = process.argv.includes('--strict') || process.env.STRICT === '1';
const PLAN_PATH = path.join(ROOT, 'workflows.json');

function fail(message, code = 1) {
  console.error(`[workflows] ${message}`);
  process.exit(code);
}

if (!fs.existsSync(PLAN_PATH)) {
  if (STRICT) fail('workflows.json not found in strict mode');
  console.log('[workflows] workflows.json not found - skipping');
  process.exit(0);
}

function readJson(file, label) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} must be a regular file`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${label} is invalid: ${error.message}`, 2);
  }
}

function contained(relativePath) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(relativePath) || path.posix.normalize(relativePath) !== relativePath) return null;
  const resolved = path.resolve(ROOT, relativePath);
  const relative = path.relative(ROOT, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return resolved;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactMarker(text, prefix, id) {
  return new RegExp(`^\\s*//\\s*${escapeRegExp(prefix)}:\\s*${escapeRegExp(id)}(?![a-z0-9-])`, 'im').exec(text);
}

function exactBehaviorMarker(text, behaviorId) {
  return exactMarker(text, 'source-behavior', behaviorId);
}

function controlFlowToken(frame) {
  if (frame.kind === 'if') return frame.role === 'else' ? 'else' : `then-${frame.branchIndex ?? 0}`;
  if (frame.kind === 'switch') return frame.role === 'default' ? 'default' : `case-${frame.caseIndex ?? 0}`;
  if (frame.kind === 'ifError') return frame.role === 'default' ? 'default' : `${frame.role || 'clause'}-${frame.clauseIndex ?? 0}`;
  if (frame.kind === 'concurrent') return `branch-${frame.branchIndex ?? 0}`;
  if (frame.kind === 'forAll') return 'body';
  if (frame.kind === 'with') return 'scope';
  return 'frame';
}

function exactControlFlowMarker(text, frame) {
  const suffix = `${escapeRegExp(frame.kind)}\\s+${escapeRegExp(controlFlowToken(frame))}`;
  return new RegExp(`^\\s*//\\s*source-control-flow:\\s*${escapeRegExp(frame.id)}\\s+${suffix}(?![a-z0-9-])`, 'im').exec(text);
}

function functionDeclaration(text, name) {
  const escaped = escapeRegExp(name);
  return new RegExp(`(?:async\\s+function\\s+${escaped}\\b|const\\s+${escaped}\\s*=\\s*async\\b)`).exec(text);
}

function exportedFunction(text, name) {
  const escaped = escapeRegExp(name);
  return new RegExp(`export\\s+(?:async\\s+function\\s+${escaped}\\b|const\\s+${escaped}\\s*=\\s*async\\b)`).exec(text);
}

const plan = readJson(PLAN_PATH, 'workflows.json');
if (plan.$schema !== 'workflow-plan-v1') fail(`unsupported schema: ${plan.$schema || 'missing'}`, 2);
const workflows = Array.isArray(plan.workflows) ? plan.workflows : fail('workflows must be an array', 2);
const findings = [];
let implemented = 0;
let pending = 0;
let blocked = 0;

for (const workflow of workflows) {
  const id = String(workflow.workflowId || '(missing)');
  const approval = workflow.approval || {};
  const target = workflow.proposal?.target || {};
  const steps = Array.isArray(workflow.proposal?.steps) ? workflow.proposal.steps : [];
  const result = { id, source: `${workflow.source?.screen || '?'} / ${workflow.source?.control || '?'}.${workflow.source?.event || '?'}`, issues: [] };

  if (approval.status === 'pending') {
    pending += 1;
    result.issues.push('approval is pending');
  } else if (approval.status === 'blocked') {
    blocked += 1;
    result.issues.push('workflow is blocked');
  } else if (approval.status !== 'approved') {
    result.issues.push(`invalid approval status ${approval.status || 'missing'}`);
  }

  const moduleFile = contained(target.module);
  const callSiteFile = contained(target.callSiteFile);
  if (!moduleFile || !String(target.module || '').startsWith('src/features/')) result.issues.push('target module is unsafe or outside src/features');
  if (!callSiteFile) result.issues.push('call site is unsafe or missing');
  if (moduleFile && !fs.existsSync(moduleFile)) result.issues.push(`module missing: ${target.module}`);
  if (callSiteFile && !fs.existsSync(callSiteFile)) result.issues.push(`call site missing: ${target.callSiteFile}`);

  let moduleText = '';
  if (moduleFile && fs.existsSync(moduleFile)) {
    moduleText = fs.readFileSync(moduleFile, 'utf8');
    if (!exactMarker(moduleText, 'source-workflow', id)) result.issues.push('module lacks exact source-workflow marker');
    if (STRICT && /TODO|placeholder|not[ -]implemented/i.test(moduleText)) result.issues.push('module still contains TODO/placeholder/not-implemented text');

    const orchestration = exportedFunction(moduleText, target.exportName);
    if (!orchestration) result.issues.push(`module lacks exported orchestrator ${target.exportName}`);
    const workflowMarker = exactMarker(moduleText, 'source-workflow', id);
    if (workflowMarker && orchestration
        && moduleText.slice(workflowMarker.index + workflowMarker[0].length, orchestration.index).trim() !== '') {
      result.issues.push('source-workflow marker must be immediately above the exported orchestrator');
    }
    const stepDeclarations = steps.map((step) => functionDeclaration(moduleText, step.targetFunction));
    let previousCall = orchestration ? orchestration.index : -1;
    for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
      const step = steps[stepIndex];
      const stepMarker = exactMarker(moduleText, 'source-workflow-step', step.stepId);
      const declaration = stepDeclarations[stepIndex];
      if (!stepMarker) result.issues.push(`step ${step.stepId} lacks exact marker`);
      if (!declaration) result.issues.push(`step ${step.stepId} lacks named function ${step.targetFunction}`);
      if (stepMarker && declaration && stepMarker.index > declaration.index) result.issues.push(`step ${step.stepId} marker must precede its function`);
      if (stepMarker && declaration
          && moduleText.slice(stepMarker.index + stepMarker[0].length, declaration.index).trim() !== '') {
        result.issues.push(`step ${step.stepId} marker must be immediately above ${step.targetFunction}`);
      }
      if (orchestration && declaration && declaration.index > orchestration.index) result.issues.push(`step function ${step.targetFunction} must be declared before the exported orchestrator`);
      const nextDeclaration = stepDeclarations.slice(stepIndex + 1).find(Boolean);
      const stepEnd = nextDeclaration ? nextDeclaration.index : (orchestration ? orchestration.index : moduleText.length);
      const stepRegion = declaration ? moduleText.slice(declaration.index, stepEnd) : '';
      for (const behaviorId of step.behaviorIds || []) {
        if (!exactBehaviorMarker(stepRegion, behaviorId)) result.issues.push(`step ${step.stepId} lacks source-behavior marker ${behaviorId} in its named function`);
      }
      if (orchestration) {
        const call = new RegExp(`\\b${escapeRegExp(step.targetFunction)}\\s*\\(`, 'g');
        call.lastIndex = Math.max(orchestration.index + orchestration[0].length, previousCall + 1);
        const match = call.exec(moduleText);
        if (!match) result.issues.push(`orchestrator does not invoke ${step.targetFunction} in approved order`);
        else previousCall = match.index;
      }
    }

    const frames = [];
    const frameKeys = new Set();
    for (const step of steps) {
      for (const frame of Array.isArray(step.controlFlow) ? step.controlFlow : []) {
        const key = `${frame?.id || ''}:${frame?.kind || ''}:${controlFlowToken(frame || {})}`;
        if (!frameKeys.has(key)) {
          frameKeys.add(key);
          frames.push(frame);
        }
      }
    }
    for (const frame of frames) {
      if (!frame?.id || !frame?.kind || !exactControlFlowMarker(moduleText, frame)) {
        result.issues.push(`control-flow frame ${frame?.id || 'missing'} ${frame?.kind || 'missing'} ${controlFlowToken(frame || {})} lacks an exact source-control-flow marker`);
      }
    }
    const frameKinds = new Set(frames.map((frame) => frame?.kind));
    if (frameKinds.has('if') && !/\bif\s*\(/.test(moduleText)) result.issues.push('source If frames lack a native if condition');
    if (frameKinds.has('switch') && !/\bswitch\s*\(/.test(moduleText)) result.issues.push('source Switch frames lack a native switch');
    if (frameKinds.has('ifError') && (!/\btry\s*\{/.test(moduleText) || !/\bcatch\s*(?:\([^)]*\))?\s*\{/.test(moduleText))) result.issues.push('source IfError frames lack a native try/catch boundary');
    if (frameKinds.has('forAll') && !/(?:\bfor\s*(?:await\s*)?\([^)]*\bof\b|\.(?:map|forEach)\s*\()/.test(moduleText)) result.issues.push('source ForAll frames lack an explicit native iteration');
    if (frameKinds.has('concurrent') && !/\bPromise\.all\s*\(/.test(moduleText)) result.issues.push('source Concurrent frames lack Promise.all');
  }

  if (callSiteFile && fs.existsSync(callSiteFile)) {
    const callSiteText = fs.readFileSync(callSiteFile, 'utf8');
    const callMarker = exactMarker(callSiteText, 'source-workflow-call', id);
    if (!callMarker) result.issues.push('call site lacks exact source-workflow-call marker');
    else {
      const after = callSiteText.slice(callMarker.index + callMarker[0].length, callMarker.index + callMarker[0].length + 2500);
      if (!new RegExp(`\\b${escapeRegExp(target.exportName)}\\s*\\(`).test(after)) {
        result.issues.push(`call marker is not followed by ${target.exportName}(...)`);
      }
      if (/TODO|placeholder|not[ -]implemented/i.test(after.slice(0, 500))) result.issues.push('call site marker is attached to a TODO/placeholder');
    }
  }

  if (result.issues.length === 0) implemented += 1;
  findings.push(result);
}

console.log('\n=== workflow decomposition coverage ===');
if (findings.length === 0) console.log('No pathological event handlers detected.');
for (const finding of findings) {
  const marker = finding.issues.length === 0 ? 'v' : 'x';
  console.log(`${marker} ${finding.id} — ${finding.source}${finding.issues.length ? `: ${finding.issues.join('; ')}` : ''}`);
}
console.log(`\nimplemented: ${implemented}/${workflows.length}; pending: ${pending}; blocked: ${blocked}`);

const failed = findings.filter((finding) => finding.issues.length > 0).length;
if (failed > 0) fail(`${failed} workflow(s) failed decomposition coverage`);
process.exit(0);
