---
name: add-office365
description: Adds Office 365 Outlook connector to a Power Apps code app. Use when accessing calendars, sending emails, reading inbox, or managing Outlook events.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, LSP, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion, Skill
model: sonnet
---

**📋 Shared Instructions: [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md)** - Cross-cutting concerns.

# Add Office 365 Outlook

## Workflow

1. Check Memory Bank -> 2. Add Connector -> 3. Review Generated Service -> 4. Configure -> 5. Build -> 6. Update Memory Bank

---

### Step 1: Check Memory Bank

Check for `memory-bank.md` per [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md).

### Step 2: Add Connector

**First, find the connection ID** (see [connector-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/connector-reference.md)):

Run the `/list-connections` skill. Find the Office 365 Outlook connection in the output (API name contains `office365`). If none exists, direct the user to create one using the environment-specific Connections URL — construct it from the active environment ID in context (from `power.config.json` or a prior step): `https://make.powerapps.com/environments/<environment-id>/connections` → **+ New connection** → search for the connector → Create.

```bash
pwsh -NoProfile -Command "pac code add-data-source -a office365 -c <connection-id>"
```

### Step 3: Review Generated Service

The generated service file (`src/generated/services/Office365OutlookService.ts`) is large. **Use `Grep` to find specific methods** instead of reading the entire file:

```
Grep pattern="async \w+" path="src/generated/services/Office365OutlookService.ts"
```

Key methods (sorted by common usage):

#### Calendar Operations

| Method                    | Purpose                    | Key Parameters                                           |
| ------------------------- | -------------------------- | -------------------------------------------------------- |
| `GetEventsCalendarViewV2` | Get events in a date range | `calendarId`, `startDateTimeOffset`, `endDateTimeOffset` |
| `V3CalendarPostItem`      | Create a calendar event    | `table` (calendar ID), `item` (CalendarEventHtmlClient)  |
| `CalendarDeleteItem`      | Delete an event            | `table` (calendar ID), `id` (event ID)                   |
| `CalendarPatchItem`       | Update an event            | `table`, `id`, `item`                                    |
| `V2CalendarGetTables`     | List available calendars   | (none)                                                   |

#### Email Operations

| Method            | Purpose            | Key Parameters                           |
| ----------------- | ------------------ | ---------------------------------------- |
| `SendEmailV2`     | Send an email      | `emailMessage` (body, to, subject, etc.) |
| `GetEmails`       | Get inbox emails   | `folderPath`, `fetchOnlyUnread`, `top`   |
| `GetEmail`        | Get single email   | `messageId`                              |
| `MarkAsRead`      | Mark email as read | `messageId`                              |
| `ReplyToV3`       | Reply to an email  | `messageId`, `body`                      |
| `Flag` / `Unflag` | Flag/unflag email  | `messageId`                              |

#### Contact Operations

| Method              | Purpose              |
| ------------------- | -------------------- |
| `GetContactFolders` | List contact folders |
| `ContactGetTables`  | List contact tables  |

### Step 4: Configure

Ask the user what Office 365 Outlook operations they need (skip if already specified by caller).

**Calendar -- Get events for a date range:**

```typescript
import { Office365OutlookService } from "../generated/services/Office365OutlookService";

const result = await Office365OutlookService.GetEventsCalendarViewV2(
  "Calendar", // calendarId -- "Calendar" for default
  startDate.toISOString(),
  endDate.toISOString()
);
const events = result.data?.value || [];
```

**Calendar -- Create an event:**

```typescript
await Office365OutlookService.V3CalendarPostItem("Calendar", {
  Subject: "Focus Time",
  Start: "2025-06-15T10:00:00", // ISO 8601 format
  End: "2025-06-15T11:00:00",
  ShowAs: "Busy",
  Importance: "Normal",
  IsAllDay: false,
  Body: "<p>Blocked for focus work</p>",
  Reminder: 5
});
```

**Calendar -- Delete an event:**

```typescript
await Office365OutlookService.CalendarDeleteItem("Calendar", eventId);
```

**Email -- Send an email:**

```typescript
await Office365OutlookService.SendEmailV2({
  To: "<recipient-address>",
  Subject: "Subject line",
  Body: "<p>HTML email body</p>",
  Importance: "Normal"
});
```

**Key types:**

| Type                                                       | Purpose                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `CalendarEventClientReceiveStringEnums`                    | Read model -- has `Subject`, `Start`, `End`, `Id`, `ShowAs`, `IsAllDay`, `Organizer`                   |
| `CalendarEventHtmlClient`                                  | Write model -- requires `Subject`, `Start`, `End`; optional `Body`, `ShowAs`, `Importance`, `Reminder` |
| `EntityListResponse_CalendarEventClientReceiveStringEnums` | Response wrapper -- access events via `.value`                                                         |

**Response pattern:**

```typescript
const result = await Office365OutlookService.GetEventsCalendarViewV2(...);
if (result.success) {
  const events = result.data?.value || [];
} else {
  console.error("Failed:", result.error);
}
```

### Step 5: Build

```powershell
npm run build
```

Fix TypeScript errors before proceeding. Do NOT deploy yet.

### Step 6: Update Memory Bank

Update `memory-bank.md` with: connector added, configured operations, build status.
