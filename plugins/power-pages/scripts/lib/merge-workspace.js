#!/usr/bin/env node

// The agent⇄extension BRIDGE for selective merge. No network, no ports — a
// file-manifest handshake under docs/inner-loop/merge/<runId>/.
//
// writeMergeWorkspace(): given the build-merge-inputs manifest, materializes one
// folder per merge unit containing base/dataverse/ado/merged files (with real
// extensions for syntax highlighting) and a manifest.json the VS Code extension
// consumes. `merged` is the deterministic git-style 3-way WORKING FILE (non-
// overlapping changes combined; overlaps shown as <<<<<<< Dataverse / >>>>>>> Azure
// DevOps markers) — exactly what `git merge` writes. It is NOT a Copilot/AI
// proposal; the old proposed.txt artifact was removed (2026-06-19).
//
// readMergeCompletion(): after the extension writes completion.json + the edited
// merged file, reads them back into resolved components for
// apply-merged-component.js. Refuses any result that still contains conflict
// markers (D6) — those units are reported unresolved, never applied.
//
// Bridge layout (secure-by-default — owner-only OS temp store, off the repo/session tree):
//   <os.tmpdir()>/pp-merge/<runId>/
//     manifest.json
//     units/<unitId>/{base.<ext>, dataverse.<ext>, ado.<ext>, merged.<ext>}
//     completion.json            (written by the extension)
//   Artifacts are wiped on completion/cancel (wipeMergeRun) and a TTL reaper
//   removes orphaned runs. Pass secure:false to use the legacy in-tree location
//   (<projectRoot>/docs/inner-loop/merge/<runId>/) instead.
//
// Launch URI (the agent opens this; the extension's URI handler picks it up):
//   vscode://power-pages.powerpages-merge/open?runId=<id>&dir=<absolute runDir>
//
// Usage (write):  node merge-workspace.js --write --projectRoot <p> --manifestFile <buildMergeInputs.json>
// Usage (read):   node merge-workspace.js --read  --projectRoot <p> --runId <id>

'use strict';

const fs = require('fs');
const path = require('path');
const { threeWayMerge, stripBom, toLF, detectEol, applyEol, CONFLICT_START } = require('./propose-merge');
const innerLoop = require('./inner-loop-paths');
const store = require('./merge-artifact-store');

const SCHEMA_VERSION = 2;
const URI_AUTHORITY = 'power-pages.powerpages-merge';

function slug(s) { return String(s || 'component').replace(/[^a-z0-9._-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''); }

// Real file extension per merge field so VS Code highlights the content (Liquid/
// HTML) in all three panes instead of showing grey plain text. Power Pages text
// fields (web template source, snippet value, web page copy/summary) are HTML+Liquid.
function fieldExtension(field) {
  switch (String(field || '').toLowerCase()) {
    case 'source': case 'value': case 'copy': case 'summary': return 'html';
    default: return 'txt';
  }
}

function mergeRunDir(projectRoot, runId, { secure = true } = {}) {
  // Secure-by-default: merge artifacts live OFF the project/session tree in an
  // owner-only OS-temp store (closes the data-at-rest leak). The legacy in-tree
  // location under docs/inner-loop/merge is opt-in (secure:false) for callers
  // that explicitly want it.
  if (secure) return store.runDir(runId);
  return path.join(innerLoop.innerLoopDir(projectRoot), 'merge', runId);
}

/**
 * Materialize the merge workspace + manifest from a build-merge-inputs manifest.
 *
 * @param {object} args
 * @param {object} args.manifest   Output of build-merge-inputs.buildMergeInputs.
 * @param {string} [args.projectRoot]  Required only when secure:false (legacy in-tree).
 * @param {boolean} [args.secure]   true (default) = owner-only OS-temp store; false = legacy in-tree.
 * @param {boolean} [args.encrypt]  AES-256-GCM at rest (experimental, single-process only). Default false.
 * @param {object} [args.fsImpl]   DI (tests, legacy mode).
 * @returns {{ runId, runDir, manifestPath, launchUri, units, binaryComponents, secretWarnings, secure, encrypted }}
 */
function writeMergeWorkspace({ projectRoot, manifest, fsImpl = fs, secure = true, encrypt = false } = {}) {
  if (!manifest || !Array.isArray(manifest.components)) throw new Error('manifest.components is required');
  if (!secure && !projectRoot) throw new Error('projectRoot is required when secure:false');

  const runId = manifest.runId || `merge-${Date.now()}`;
  // Secure-by-default: artifacts go to an owner-only OS-temp store off the
  // project/session tree, and we opportunistically reap orphaned runs so no
  // abandoned merge leaves plaintext component source behind.
  if (secure) { try { store.reapStaleRuns(); } catch (_) { /* best-effort */ } }
  const runStore = secure
    ? store.createRunStore(runId, { encrypt })
    : (innerLoop.ensureInnerLoopDir(projectRoot), { dir: mergeRunDir(projectRoot, runId, { secure }), key: null, encrypted: false });
  const runDir = runStore.dir;

  // Single write seam: secure mode → owner-only (0o600), path-escape-guarded,
  // optionally AES-256-GCM encrypted (experimental single-process only — the
  // extension reads plaintext, so encrypt stays OFF for the standard flow);
  // legacy mode → plain fsImpl write under the project tree.
  const writeFile = (rel, content) => {
    if (secure) return store.writeArtifact(runStore, rel, content);
    const abs = path.join(runDir, rel);
    fsImpl.mkdirSync(path.dirname(abs), { recursive: true });
    fsImpl.writeFileSync(abs, content, 'utf8');
    return abs;
  };

  const units = [];
  const binaryComponents = [];
  const deferredUnits = [];
  const secretWarnings = [];

  for (const comp of manifest.components) {
    if (comp.routedTo !== 'selective-merge') {
      binaryComponents.push({ componentId: comp.componentId, name: comp.name, type: comp.type, typeLabel: comp.typeLabel, reason: comp.note || comp.mergeStrategy });
      continue;
    }
    for (const unit of comp.units || []) {
      if (unit.status !== 'mergeable' && unit.status !== 'add-add') {
        // A non-mergeable unit inside a selectively-merged component
        // (deleted-in-git, identical, path-unresolved). Surface it so it is never
        // silently dropped — the agent resolves it via keep/accept (e.g. the
        // delete-vs-keep choice for a field removed in Git).
        deferredUnits.push({
          componentId: comp.componentId, componentName: comp.name, componentType: comp.type,
          field: unit.field, status: unit.status, reason: unit.note || `field '${unit.field}' is ${unit.status}`,
        });
        continue;
      }
      const rawBase = (unit.base && unit.base.content) || '';
      const rawOurs = (unit.ours && unit.ours.content) || '';
      const rawTheirs = (unit.theirs && unit.theirs.content) || '';
      // Normalize EOL + strip BOM so independent edits anchor instead of
      // collapsing into a whole-field conflict; preserve the repo's EOL (THEIRS)
      // on output so the committed file doesn't churn every line.
      const targetEol = detectEol(rawTheirs) || detectEol(rawOurs) || detectEol(rawBase) || '\n';
      const base = toLF(stripBom(rawBase));
      const ours = toLF(stripBom(rawOurs));
      const theirs = toLF(stripBom(rawTheirs));
      // Deterministic git-style 3-way WORKING FILE for `result`: non-overlapping
      // changes are combined; overlapping changes are shown verbatim as
      // <<<<<<< Dataverse / ======= / >>>>>>> Azure DevOps markers for the human to
      // pick. This is exactly what `git merge` writes to a conflicted file — NOT a
      // Copilot/AI proposal (the separate proposed.txt artifact was removed). The
      // native VS Code merge editor opens this; leftover markers ⇒ unresolved (D6).
      const working = threeWayMerge(base, ours, theirs, {
        oursLabel: `Dataverse — ${comp.name} (${unit.field})`,
        theirsLabel: `Azure DevOps — ${comp.name} (${unit.field})`,
      });

      const unitId = `${slug(comp.name)}__${slug(unit.field)}`;
      // Best-effort inline-secret scan (warn, never block — the maker must see
      // the content to merge it; secret/auth-classified components are already
      // routed to the binary path upstream and never reach here).
      for (const [side, text] of [['ours', ours], ['theirs', theirs], ['base', base]]) {
        const hits = store.scanForSecrets(text);
        if (hits.length) secretWarnings.push({ component: comp.name, field: unit.field, side, patterns: hits });
      }
      const ext = fieldExtension(unit.field);
      const names = { base: `base.${ext}`, ours: `dataverse.${ext}`, theirs: `ado.${ext}`, result: `merged.${ext}` };
      const rel = (f) => `units/${unitId}/${f}`;
      writeFile(rel(names.base), applyEol(base, targetEol));
      writeFile(rel(names.ours), applyEol(ours, targetEol));     // LEFT  = Dataverse (your environment)
      writeFile(rel(names.theirs), applyEol(theirs, targetEol)); // RIGHT = Azure DevOps (incoming)
      writeFile(rel(names.result), applyEol(working.merged, targetEol)); // working file (git markers, not a proposal)

      units.push({
        unitId,
        conflictId: comp.conflictId || null,
        componentId: comp.componentId,
        componentName: comp.name,
        componentType: comp.type,
        typeLabel: comp.typeLabel,
        field: unit.field,
        adoPath: unit.adoPath,
        status: unit.status,
        hasConflicts: !working.clean,
        conflictCount: working.conflictCount,
        eol: targetEol === '\r\n' ? 'crlf' : 'lf',
        files: {
          base: rel(names.base),
          ours: rel(names.ours),
          theirs: rel(names.theirs),
          result: rel(names.result),
        },
        labels: { ours: 'Dataverse (your environment)', theirs: 'Azure DevOps (incoming)' },
      });
    }
  }

  const bridgeManifest = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    generatedAt: new Date().toISOString(),
    binding: manifest.binding || null,
    unitCount: units.length,
    units,
    binaryComponents,
    deferredUnits,
    secretWarnings,
    secure: !!secure,
    encrypted: !!runStore.encrypted,
  };
  const manifestPath = writeFile('manifest.json', JSON.stringify(bridgeManifest, null, 2));

  return {
    runId,
    runDir,
    manifestPath,
    launchUri: `vscode://${URI_AUTHORITY}/open?runId=${encodeURIComponent(runId)}&dir=${encodeURIComponent(runDir)}`,
    units,
    binaryComponents,
    secretWarnings,
    secure: !!secure,
    encrypted: !!runStore.encrypted,
  };
}

/**
 * Read the extension's completion back into resolved components for apply.
 * Refuses results that still contain conflict markers (D6).
 *
 * @returns {{ complete, resolved, unresolved, runId, runDir }}
 */
function readMergeCompletion({ projectRoot, runId, fsImpl = fs, secure = true } = {}) {
  if (!runId) throw new Error('runId is required');
  if (!secure && !projectRoot) throw new Error('projectRoot is required when secure:false');
  const runDir = mergeRunDir(projectRoot, runId, { secure });
  const manifestPath = path.join(runDir, 'manifest.json');
  if (!fsImpl.existsSync(manifestPath)) throw new Error(`No merge manifest at ${manifestPath}`);
  const manifest = JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8'));

  const completionPath = path.join(runDir, 'completion.json');
  const completion = fsImpl.existsSync(completionPath) ? JSON.parse(fsImpl.readFileSync(completionPath, 'utf8')) : null;

  const resolved = [];
  const unresolved = [];

  for (const unit of manifest.units || []) {
    const resultAbs = path.join(runDir, unit.files.result);
    let content = null;
    try { content = fsImpl.readFileSync(resultAbs, 'utf8'); } catch { /* missing */ }

    if (content == null) { unresolved.push({ unitId: unit.unitId, componentName: unit.componentName, field: unit.field, reason: 'result.txt missing' }); continue; }
    if (content.includes(CONFLICT_START)) { unresolved.push({ unitId: unit.unitId, componentName: unit.componentName, field: unit.field, reason: 'unresolved conflict markers remain' }); continue; }

    // Carry OURS through so apply can snapshot the pre-mutation environment value
    // for reversibility/audit (the snapshot would otherwise be empty).
    let oursContent = null;
    try { oursContent = fsImpl.readFileSync(path.join(runDir, unit.files.ours), 'utf8'); } catch { /* best-effort */ }

    resolved.push({
      unitId: unit.unitId,
      conflictId: unit.conflictId,
      componentId: unit.componentId,
      name: unit.componentName,
      type: unit.componentType,
      field: unit.field,
      adoPath: unit.adoPath,
      oursContent,
      mergedContent: content,
    });
  }

  return {
    complete: unresolved.length === 0 && resolved.length === (manifest.units || []).length,
    runId,
    runDir,
    resolved,
    unresolved,
    extensionReported: completion ? (completion.status || 'reported') : null,
  };
}

/**
 * Securely wipe a run's artifacts (overwrite-with-random then unlink) from the
 * secure store. Call on completion/cancel so no plaintext component source
 * persists beyond the active merge.
 * @param {string} runId
 * @returns {{ wiped: boolean, files: number }}
 */
function wipeMergeRun(runId) {
  if (!runId) throw new Error('runId is required');
  return store.secureWipeRun(runId);
}

function parseArgs(argv) {
  const a = argv.slice(2);
  const o = { mode: null, projectRoot: null, manifestFile: null, runId: null, secure: true };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--write') o.mode = 'write';
    else if (a[i] === '--read') o.mode = 'read';
    else if (a[i] === '--wipe') o.mode = 'wipe';
    else if (a[i] === '--insecure') o.secure = false;
    else if (a[i] === '--projectRoot' && a[i + 1]) o.projectRoot = a[++i];
    else if (a[i] === '--manifestFile' && a[i + 1]) o.manifestFile = a[++i];
    else if (a[i] === '--runId' && a[i + 1]) o.runId = a[++i];
  }
  return o;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  try {
    if (args.mode === 'write') {
      const manifest = JSON.parse(fs.readFileSync(args.manifestFile, 'utf8'));
      const r = writeMergeWorkspace({ projectRoot: args.projectRoot, manifest, secure: args.secure });
      process.stdout.write(JSON.stringify({ runId: r.runId, runDir: r.runDir, manifestPath: r.manifestPath, launchUri: r.launchUri, unitCount: r.units.length, binaryComponents: r.binaryComponents.length, secretWarnings: r.secretWarnings, secure: r.secure }, null, 2) + '\n');
    } else if (args.mode === 'read') {
      const r = readMergeCompletion({ projectRoot: args.projectRoot, runId: args.runId, secure: args.secure });
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    } else if (args.mode === 'wipe') {
      const r = wipeMergeRun(args.runId);
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    } else {
      process.stderr.write('Specify --write (with --manifestFile), --read (with --runId), or --wipe (with --runId).\n');
      process.exit(1);
    }
  } catch (e) {
    process.stderr.write('merge-workspace: ' + e.message + '\n');
    process.exit(1);
  }
}

module.exports = { writeMergeWorkspace, readMergeCompletion, wipeMergeRun, mergeRunDir, SCHEMA_VERSION, URI_AUTHORITY };
