// Power Pages Selective Merge — companion VS Code extension.
//
// The agent (Copilot CLI / scripts/lib/merge-workspace.js) materializes a merge
// run in a secure, owner-only OS-temp store (off the project tree) and opens it
// via an absolute path in the launch URI:
//   vscode://power-pages.powerpages-merge/open?runId=<id>&dir=<absolute runDir>
//
// This extension reads the manifest and walks the conflicted component fields one
// at a time. For each conflicted field it opens VS Code's NATIVE 3-way Merge
// Editor (OURS | Result | THEIRS with per-hunk Accept Current/Incoming/Both),
// writing the resolved output to result.txt; if that command is unavailable it
// falls back to editing result.txt's <<<<<<< markers with an OURS↔THEIRS diff.
// Clean (auto-merged) fields just open result.txt for review. On finish it writes
// completion.json for the agent to commit to ADO and pull into Dataverse.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  loadManifest, buildCompletion, inspectUnit, hasConflictMarkers,
  resultAbsPath, unitAbsPath, buildMergeEditorInput, checkSchemaCompatibility, parseLaunchQuery, BridgeManifest, MergeUnit,
} from './mergeRun';

let controller: MergeRunController | undefined;
let statusBar: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'powerpages-merge.resolveNext';
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        if (uri.path === '/open') {
          const { dir } = parseLaunchQuery(uri.query);
          if (dir) { void startRun(dir); }
          else { void vscode.window.showErrorMessage('Power Pages Merge: launch URI missing dir.'); }
        }
      },
    }),
    vscode.commands.registerCommand('powerpages-merge.openRun', async () => {
      const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Open merge run folder' });
      if (picked && picked[0]) { void startRun(picked[0].fsPath); }
    }),
    vscode.commands.registerCommand('powerpages-merge.resolveNext', () => controller?.resolveCurrentAndAdvance()),
    vscode.commands.registerCommand('powerpages-merge.openReferenceDiff', () => controller?.openReferenceDiff()),
    vscode.commands.registerCommand('powerpages-merge.finish', () => controller?.finish()),
    vscode.commands.registerCommand('powerpages-merge.cancel', () => controller?.cancel()),
  );
}

export function deactivate(): void {
  statusBar?.dispose();
}

async function startRun(runDir: string): Promise<void> {
  // Re-entrancy guard: don't clobber a merge already in progress (a second
  // launch URI or command while the maker is mid-merge). Offer a clean switch.
  if (controller && controller.isActive()) {
    const choice = await vscode.window.showWarningMessage(
      'A Power Pages merge is already in progress. Cancel it and open the new one?',
      'Keep current', 'Cancel & open new',
    );
    if (choice !== 'Cancel & open new') { return; }
    await controller.cancel();
  }
  try {
    const manifest = loadManifest(runDir);
    const compat = checkSchemaCompatibility(manifest.schemaVersion);
    if (!compat.ok) {
      const action = compat.action === 'update-extension' ? 'Open Extensions' : 'OK';
      const picked = await vscode.window.showErrorMessage(`Power Pages Merge: ${compat.message}`, action);
      if (picked === 'Open Extensions') { void vscode.commands.executeCommand('workbench.extensions.action.checkForUpdates'); }
      return;
    }
    if (manifest.units.length === 0) {
      await vscode.window.showInformationMessage('Power Pages Merge: no text-merge units in this run (all conflicts are binary keep/accept).');
      return;
    }
    controller = new MergeRunController(runDir, manifest);
    await controller.openCurrent();
  } catch (e) {
    await vscode.window.showErrorMessage(`Power Pages Merge: could not open run — ${(e as Error).message}`);
  }
}

class MergeRunController {
  private index = 0;
  private finished = false;

  constructor(private readonly runDir: string, private readonly manifest: BridgeManifest) {}

  isActive(): boolean { return !this.finished; }

  private get current(): MergeUnit { return this.manifest.units[this.index]; }
  private get total(): number { return this.manifest.units.length; }

  private updateStatus(): void {
    const u = this.current;
    const flag = u.hasConflicts ? '$(warning) conflicts' : '$(check) clean';
    statusBar.text = `$(git-merge) Merge ${this.index + 1}/${this.total}: ${u.componentName} · ${u.field} (${flag}) — resolve & save ▶`;
    statusBar.tooltip = 'Resolve the result, save, then click to mark resolved & continue';
    statusBar.show();
  }

  async openCurrent(): Promise<void> {
    const u = this.current;
    this.updateStatus();
    if (u.hasConflicts) {
      // Preferred: VS Code's native 3-way merge editor. Fall back to editing the
      // result.txt markers if the (internal) merge-editor command is unavailable.
      const opened = await this.openNativeMergeEditor(u);
      if (!opened) { await this.openMarkerFallback(u); }
    } else {
      const resultUri = vscode.Uri.file(resultAbsPath(this.runDir, u));
      const doc = await vscode.workspace.openTextDocument(resultUri);
      await vscode.window.showTextDocument(doc, { preview: false });
      await vscode.window.showInformationMessage(
        `“${u.componentName}” (${u.field}) auto-merged cleanly. Review result, save, then click the status-bar item to continue.`,
        'OK',
      );
    }
  }

  /** Open VS Code's native 3-way merge editor (OURS | Result | THEIRS, per-hunk
   *  checkboxes), writing the resolved output to result.txt. Returns false if the
   *  command isn't available so the caller can fall back. */
  private async openNativeMergeEditor(u: MergeUnit): Promise<boolean> {
    try {
      const m = buildMergeEditorInput(this.runDir, u);
      await vscode.commands.executeCommand('_open.mergeEditor', {
        base: vscode.Uri.file(m.basePath),
        input1: { uri: vscode.Uri.file(m.oursPath), title: m.input1Title, detail: u.componentName, description: m.description },
        input2: { uri: vscode.Uri.file(m.theirsPath), title: m.input2Title, detail: u.componentName, description: m.description },
        output: vscode.Uri.file(m.outputPath),
      });
      await vscode.window.showInformationMessage(
        `“${u.componentName}” (${u.field}): resolve the ${u.conflictCount} conflict(s) in the merge editor (Accept Current / Incoming / Both per hunk), choose “Complete Merge”, then click the status-bar item to continue.`,
        'OK',
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Legacy fallback: edit the <<<<<<< markers in result.txt + an OURS↔THEIRS diff. */
  private async openMarkerFallback(u: MergeUnit): Promise<void> {
    const resultUri = vscode.Uri.file(resultAbsPath(this.runDir, u));
    const doc = await vscode.workspace.openTextDocument(resultUri);
    await vscode.window.showTextDocument(doc, { preview: false });
    await this.openReferenceDiff();
    await vscode.window.showWarningMessage(
      `“${u.componentName}” (${u.field}) has ${u.conflictCount} overlapping change(s). Resolve the <<<<<<< markers in result, save, then click the status-bar item.`,
      'OK',
    );
  }

  async openReferenceDiff(): Promise<void> {
    const u = this.current;
    const oursUri = vscode.Uri.file(unitAbsPath(this.runDir, u, 'ours'));
    const theirsUri = vscode.Uri.file(unitAbsPath(this.runDir, u, 'theirs'));
    await vscode.commands.executeCommand('vscode.diff', oursUri, theirsUri,
      `${u.componentName} · ${u.field}: Dataverse (your env) ↔ Azure DevOps (incoming)`, { preview: true });
  }

  async resolveCurrentAndAdvance(): Promise<void> {
    // Persist any pending edits to result.txt first.
    if (vscode.window.activeTextEditor?.document.isDirty) {
      await vscode.window.activeTextEditor.document.save();
    }
    const u = this.current;
    const verdict = inspectUnit(this.runDir, u);
    if (!verdict.resolved) {
      await vscode.window.showErrorMessage(`Cannot continue: ${verdict.reason} in “${u.componentName}” (${u.field}). Resolve all markers and save.`);
      return;
    }
    if (this.index < this.total - 1) {
      this.index += 1;
      await this.openCurrent();
    } else {
      await this.finish();
    }
  }

  async finish(): Promise<void> {
    const completion = buildCompletion(this.manifest, this.runDir);
    const unresolved = completion.units.filter((x) => !x.resolved);
    if (unresolved.length > 0) {
      const choice = await vscode.window.showWarningMessage(
        `${unresolved.length} unit(s) still have unresolved conflicts. Finish anyway (the agent will skip them) or keep editing?`,
        'Keep editing', 'Finish with unresolved',
      );
      if (choice !== 'Finish with unresolved') { return; }
    }
    this.writeCompletion(completion);
    this.finished = true;
    statusBar.hide();
    await vscode.window.showInformationMessage(
      `Power Pages Merge complete (${completion.units.filter((x) => x.resolved).length}/${this.total} resolved). Return to the agent to commit & pull.`,
    );
  }

  async cancel(): Promise<void> {
    const completion = buildCompletion(this.manifest, this.runDir, 'cancelled');
    this.writeCompletion(completion);
    this.finished = true;
    statusBar.hide();
    await vscode.window.showInformationMessage('Power Pages Merge cancelled. No changes were applied.');
  }

  private writeCompletion(completion: ReturnType<typeof buildCompletion>): void {
    fs.writeFileSync(path.join(this.runDir, 'completion.json'), JSON.stringify(completion, null, 2), 'utf8');
  }
}

// Re-export for completeness / future programmatic use.
export { hasConflictMarkers };
