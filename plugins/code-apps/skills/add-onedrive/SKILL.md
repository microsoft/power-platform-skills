---
name: add-onedrive
description: Adds OneDrive for Business connector to a Power Apps code app. Use when uploading, downloading, listing, or managing files in OneDrive.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, LSP, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion, Skill
model: sonnet
---

**📋 Shared Instructions: [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md)** - Cross-cutting concerns.

# Add OneDrive for Business

## Workflow

1. Check Memory Bank → 2. Add Connector → 3. Configure → 4. Build → 5. Update Memory Bank

---

### Step 1: Check Memory Bank

Check for `memory-bank.md` per [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md).

### Step 2: Add Connector

**First, find the connection ID** (see [connector-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/connector-reference.md)):

Run the `/list-connections` skill. Find the OneDrive for Business connection in the output. If none exists, direct the user to create one using the environment-specific Connections URL — construct it from the active environment ID in context (from `power.config.json` or a prior step): `https://make.powerapps.com/environments/<environment-id>/connections` → **+ New connection** → search for the connector → Create.

```bash
pwsh -NoProfile -Command "pac code add-data-source -a onedriveforbusiness -c <connection-id>"
```

### Step 3: Configure

Ask the user what file operations they need (list files, upload, download, create folder, etc.).

**Common operations:**

```typescript
// List files in a folder
const files = await OneDriveForBusinessService.ListFolder({
  id: "root" // or folder ID
});

// Get file metadata
const metadata = await OneDriveForBusinessService.GetFileMetadata({
  id: "file-id"
});

// Get file content
const content = await OneDriveForBusinessService.GetFileContent({
  id: "file-id"
});

// Create file
await OneDriveForBusinessService.CreateFile({
  folderPath: "/Documents",
  name: "report.txt",
  body: "File content here"
});
```

**Key points:**

- File and folder IDs can be obtained from `ListFolder` or `ListRootFolder`
- Use `folderPath` for creating files by path, `id` for accessing existing files
- Binary file content may need base64 encoding/decoding depending on the operation

Use `Grep` to find specific methods in `src/generated/services/OneDriveForBusinessService.ts` (generated files can be very large -- see [connector-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/connector-reference.md#inspecting-large-generated-files)).

### Step 4: Build

```powershell
npm run build
```

Fix TypeScript errors before proceeding. Do NOT deploy yet.

### Step 5: Update Memory Bank

Update `memory-bank.md` with: connector added, configured operations, build status.
