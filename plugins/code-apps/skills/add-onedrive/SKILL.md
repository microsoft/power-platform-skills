---
name: add-onedrive
description: Adds OneDrive for Business connector to a Power Apps code app. Use when uploading, downloading, listing, or managing files in OneDrive.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, LSP, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion, Skill
model: sonnet
---

**📋 Shared Instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** - Cross-cutting concerns.

# Add OneDrive for Business

## Workflow

1. Check Memory Bank → 2. Add Connector → 3. Configure → 4. Build → 5. Update Memory Bank

---

### Step 1: Check Memory Bank

Check for `memory-bank.md` per [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md).

### Step 2: Add Connector

Get the connection as described in [connector-reference.md](${PLUGIN_ROOT}/shared/connector-reference.md#connections).

**CLI 1.3.0+ (`PA_INLINE_CONNECTIONS=yes`):** tell the user that adding OneDrive for Business may create a connection with their account, then run the add without `-c` and handle the result with the outcome table in connector-reference.md:

```bash
pa app add data-source --connector onedriveforbusiness --non-interactive
```

**Older CLIs:** run `/list-connections` to find the OneDrive for Business connection ID (if none exists, create one with `pa connection create` as described in connector-reference.md), then:

```bash
pa app add data-source --connector onedriveforbusiness -c <connection-id>
```

### Step 3: Configure

Ask the user what file operations they need (list files, upload, download, create folder, etc.).

The generated service is `OneDriveforBusinessService` (lowercase "for"), and its methods take positional parameters. Confirm names and signatures in `src/generated/services/` before using them.

**Common operations:**

```typescript
import { OneDriveforBusinessService } from "../generated/services/OneDriveforBusinessService";

// List the files and folders in the root folder
const root = await OneDriveforBusinessService.ListRootFolder();
const rootItems = root.data ?? [];

// List a subfolder by its Id (from an earlier listing); returns a page of items
const folder = await OneDriveforBusinessService.ListFolderV2("<folder-id>");
const folderItems = folder.data?.value ?? [];

// Get file metadata and content
const metadata = await OneDriveforBusinessService.GetFileMetadata("<file-id>");
const content = await OneDriveforBusinessService.GetFileContent("<file-id>");

// Create a file
await OneDriveforBusinessService.CreateFile("/Documents", "report.txt", "File content here");
```

**Key points:**

- List the root folder with `ListRootFolder()` instead of passing `"root"` as a folder ID. `ListFolderV2` takes the `Id` of a folder returned by an earlier listing.
- Use `ListFolderV2`, not `ListFolder`, which the connector has deprecated. `ListFolderV2` returns a page: the items are in `value`, and `nextLink` is set when there are more.
- Use `folderPath` for creating files by path, `id` for accessing existing files
- Binary file content may need base64 encoding/decoding depending on the operation

Use `Grep` to find specific methods in `src/generated/services/OneDriveforBusinessService.ts` (generated files can be very large -- see [connector-reference.md](${PLUGIN_ROOT}/shared/connector-reference.md#inspecting-large-generated-files)).

### Step 4: Build

```bash
npm run build
```

Fix TypeScript errors before proceeding. Do NOT deploy yet.

### Step 5: Update Memory Bank

Update `memory-bank.md` with: connector added, configured operations, build status.
