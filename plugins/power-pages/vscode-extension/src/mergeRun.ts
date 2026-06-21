// Pure bridge logic for the Power Pages selective-merge extension. Kept free of
// the `vscode` API so it can be unit-tested with plain Node. Mirrors the manifest
// contract written by the agent's scripts/lib/merge-workspace.js.

import * as fs from 'fs';
import * as path from 'path';

export const CONFLICT_START = '<<<<<<<';

export interface MergeUnitFiles {
  base: string;
  ours: string;
  theirs: string;
  result: string;
}

export interface MergeUnit {
  unitId: string;
  conflictId: string | null;
  componentId: string;
  componentName: string;
  componentType: number;
  typeLabel?: string;
  field: string;
  adoPath: string;
  status: 'mergeable' | 'add-add';
  hasConflicts: boolean;
  conflictCount: number;
  eol?: 'lf' | 'crlf';
  files: MergeUnitFiles;
  labels: { ours: string; theirs: string };
}

/** A non-mergeable field inside a selectively-merged component (deleted-in-git,
 *  identical, path-unresolved). Surfaced so the agent resolves it via keep/accept
 *  instead of silently dropping it. The extension only displays these. */
export interface DeferredUnit {
  componentId: string;
  componentName: string;
  componentType: number;
  field: string;
  status: string;
  reason?: string;
}

export interface BridgeManifest {
  schemaVersion: number;
  runId: string;
  generatedAt: string;
  binding: Record<string, unknown> | null;
  unitCount: number;
  units: MergeUnit[];
  binaryComponents: Array<Record<string, unknown>>;
  deferredUnits?: DeferredUnit[];
}

export interface CompletionUnit {
  unitId: string;
  resolved: boolean;
  reason?: string;
}

export interface Completion {
  schemaVersion: number;
  runId: string;
  status: 'done' | 'partial' | 'cancelled';
  resolvedAt: string;
  units: CompletionUnit[];
}

/** Load and validate the bridge manifest from a run directory. */
// Bridge schema versions this extension build understands. The agent stamps
// manifest.schemaVersion; checkSchemaCompatibility() lets us show a friendly
// "update the extension / plugin" message instead of failing cryptically when the
// agent and the extension drift out of sync (Wave 5 #1 version handshake).
export const MIN_SUPPORTED_SCHEMA = 2;
export const MAX_SUPPORTED_SCHEMA = 2;

export interface SchemaVerdict { ok: boolean; action?: 'update-extension' | 'update-plugin'; message?: string; }

export function checkSchemaCompatibility(schemaVersion: unknown): SchemaVerdict {
  const v = Number(schemaVersion);
  if (!Number.isFinite(v)) return { ok: true }; // unknown/legacy — don't block, best-effort
  if (v > MAX_SUPPORTED_SCHEMA) {
    return { ok: false, action: 'update-extension', message: `This merge was created by a newer Power Pages plugin (schema ${v}). Update the “Power Pages Selective Merge” extension to continue.` };
  }
  if (v < MIN_SUPPORTED_SCHEMA) {
    return { ok: false, action: 'update-plugin', message: `This extension expects a newer merge format (schema ≥ ${MIN_SUPPORTED_SCHEMA}); the run is schema ${v}. Update the Power Pages plugin/CLI, or downgrade the extension.` };
  }
  return { ok: true };
}

export function loadManifest(runDir: string): BridgeManifest {
  const manifestPath = path.join(runDir, 'manifest.json');
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw) as BridgeManifest;
  if (!Array.isArray(manifest.units)) {
    throw new Error('Invalid merge manifest: units[] missing');
  }
  return manifest;
}

/** True if the text still contains an unresolved git-style conflict marker. */
export function hasConflictMarkers(text: string): boolean {
  return typeof text === 'string' && text.includes(CONFLICT_START);
}

export function resultAbsPath(runDir: string, unit: MergeUnit): string {
  return path.join(runDir, unit.files.result);
}

export function unitAbsPath(runDir: string, unit: MergeUnit, kind: keyof MergeUnitFiles): string {
  return path.join(runDir, unit.files[kind]);
}

/** Inputs for VS Code's native 3-way merge editor (`_open.mergeEditor`). Pure so
 *  it can be unit-tested; extension.ts wraps the paths in vscode.Uri. */
export interface MergeEditorInput {
  basePath: string;
  oursPath: string;
  theirsPath: string;
  outputPath: string;
  input1Title: string;
  input2Title: string;
  description: string;
}

export function buildMergeEditorInput(runDir: string, unit: MergeUnit): MergeEditorInput {
  const id = `${unit.componentName} (${unit.field})`;
  return {
    basePath: unitAbsPath(runDir, unit, 'base'),
    oursPath: unitAbsPath(runDir, unit, 'ours'),
    theirsPath: unitAbsPath(runDir, unit, 'theirs'),
    outputPath: resultAbsPath(runDir, unit),
    input1Title: `Dataverse — your environment · ${id}`,
    input2Title: `Azure DevOps — incoming · ${id}`,
    description: `${unit.typeLabel || 'component'} · ${unit.conflictCount} conflict(s)`,
  };
}

/**
 * Inspect a single unit's saved result.txt: resolved only if the file exists and
 * carries no leftover conflict markers (D6).
 */
export function inspectUnit(runDir: string, unit: MergeUnit, readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf8')): CompletionUnit {
  const p = resultAbsPath(runDir, unit);
  let content: string;
  try {
    content = readFile(p);
  } catch {
    return { unitId: unit.unitId, resolved: false, reason: 'result.txt missing' };
  }
  if (hasConflictMarkers(content)) {
    return { unitId: unit.unitId, resolved: false, reason: 'unresolved conflict markers remain' };
  }
  return { unitId: unit.unitId, resolved: true };
}

/** Build a completion record by inspecting every unit's result. */
export function buildCompletion(
  manifest: BridgeManifest,
  runDir: string,
  status: 'done' | 'partial' | 'cancelled' | undefined = undefined,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf8'),
): Completion {
  const units = manifest.units.map((u) => inspectUnit(runDir, u, readFile));
  const allResolved = units.every((u) => u.resolved);
  const finalStatus = status || (allResolved ? 'done' : 'partial');
  return {
    schemaVersion: manifest.schemaVersion,
    runId: manifest.runId,
    status: finalStatus,
    resolvedAt: new Date().toISOString(),
    units,
  };
}

/** Parse the runId/dir out of a `vscode://…/open?runId=…&dir=…` URI query string. */
export function parseLaunchQuery(query: string): { runId: string | null; dir: string | null } {
  const params = new URLSearchParams(query);
  return { runId: params.get('runId'), dir: params.get('dir') };
}
