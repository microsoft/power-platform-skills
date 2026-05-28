# Genpage Plan

## User Requirements
Build a task management board with columns for To Do, In Progress, and Done. Use the task entity. Allow dragging tasks between columns.

## Working Directory
D:/temp/task-board

## Plugin Root
D:/Projects/power-platform-skills/plugins/model-apps

## Environment
- URL: https://aurorabapenv610b3.crmtest.dynamics.com
- App: Genpage Publish Test (3fc905b9-7854-f111-a821-70a8a59ce7bc)
- Languages: English (1033) only
- Solution: Default
- Publisher Prefix: new

## Pages
| Page | File | Purpose | Entities |
|------|------|---------|----------|
| Task Board | task-board.tsx | Kanban board with To Do, In Progress, and Done columns; native HTML5 drag-and-drop moves tasks between columns with status persisted via dataApi.updateRow | task |

## Entity Creation Required
No entity creation required — all entities already exist.

## Existing Entities
task

## Design Preferences
- Styling: Fluent UI V9 Cards in a 3-column horizontal layout. Priority color-coded badges: green = Low, blue = Normal, orange = High, red = Critical. Clean column headers with icons (ClipboardTaskRegular, PlayRegular, CheckmarkCircleRegular). Neutral background per column with subtle border.
- Features: Drag-and-drop between columns using native HTML5 DnD (no external library — no react-dnd, @dnd-kit, or react-beautiful-dnd). Status updates persist to Dataverse via dataApi.updateRow on drop. Loading, empty, and error states per column. Window cache (window.__genpage_tasks_v1) for list data. Display task subject, priority badge, due date (scheduledend), and owner name (ownerid) on each card.
- Accessibility: WCAG AA defaults; draggable cards include appropriate aria attributes; column drop zones indicate active drag visually.

## Relevant Samples
| Page | Sample | Reason |
|------|--------|--------|
| Task Board | 11-kanban-with-dnd.tsx | Direct structural match — kanban board with native HTML5 DnD on the task entity with statuscode column mapping |

## Per-Page Specifications

### Task Board
- **File:** task-board.tsx
- **Purpose:** Kanban board displaying task records in three status columns (To Do, In Progress, Done) with drag-and-drop to move tasks and persist status changes.
- **Entities:** task
- **Needs caching:** true
- **Key Features:**
  - Three columns mapped to task statuscode values: Open (1) = To Do, In Progress (2) = In Progress, Completed (5) = Done
  - Native HTML5 drag-and-drop: onDragStart, onDragOver (with preventDefault), onDrop, onDragEnd
  - Drop triggers dataApi.updateRow to update statuscode on the task record
  - Each card displays: subject, prioritycode badge (0=Low/green, 1=Normal/blue, 2=High/orange, 3=Critical/red), scheduledend formatted as due date, ownerid name
  - Window cache key: window.__genpage_tasks_v1 using inline IIFE pattern
  - Loading spinner, empty-state message, and error MessageBar per column
  - Column headers show icon + label + task count badge
- **Components:** makeStyles, tokens, Card, CardHeader, Body1, Caption1, Text, Badge, Spinner, MessageBar, MessageBarBody from @fluentui/react-components; ClipboardTaskRegular, PlayRegular, CheckmarkCircleRegular from @fluentui/react-icons
- **Layout:** Horizontal 3-column flexbox (flex-direction: row, each column flex: 1, min-width: 280px). Columns scroll vertically independently. Overall board scrolls horizontally on narrow viewports. Responsive: stacks to single column below 640px breakpoint.
- **Data Binding:** queryTable('task', { select: ['subject', 'statuscode', 'prioritycode', 'scheduledend', 'ownerid'], orderby: 'createdon asc' }) on mount. Results split into three arrays by statuscode. On drop, optimistic UI update then dataApi.updateRow({ statuscode: newStatus }) for the dropped task id.
- **Interactions:** Drag task cards between columns; column drop zone highlights on dragover; card snaps to new column on successful drop; revert to original column if updateRow fails (with error toast/MessageBar); no click-to-open required (board is self-contained).
