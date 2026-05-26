# Genpage Plan

## User Requirements
Build a Kanban board page for Task records with three columns: To Do, In Progress, and Done. Task cards are draggable between columns and show the task title (subject), priority badge, and due date. Drag-and-drop updates the task statecode in Dataverse. Use standard Fluent UI V9 styling with responsive column wrapping on narrow screens. Columns and cards must be keyboard-navigable with ARIA drop target support.

## Working Directory
D:/temp/task-board

## Plugin Root
D:/Projects/power-platform-skills/plugins/model-apps

## Environment
- URL: https://aurorabapenv610b3.crm.dynamics.com
- App: Genpage Publish Test (3fc905b9-7854-f111-a821-70a8a59ce7bc)
- Languages: English (1033) only
- Solution: Default
- Publisher Prefix: new

## Pages
| Page | File | Purpose | Entities |
|------|------|---------|----------|
| Task Board | task-board.tsx | Kanban board with To Do, In Progress, Done columns; drag-and-drop tasks between columns | task |

## Entity Creation Required
No entity creation required — all entities already exist.

## Existing Entities
task

## Design Preferences
- Styling: Standard Fluent UI V9 tokens and components; neutral card backgrounds with colored priority badges; three equal-width columns with a light column-header accent
- Features: Drag-and-drop task cards between Kanban columns; each card displays subject, priority badge (Low / Normal / High / Urgent), and due date; statecode update on drop; responsive layout (columns wrap to single column on narrow viewports)
- Accessibility: Full keyboard navigation for columns and cards; ARIA roles for list and listitem on card containers; ARIA drop-target attributes on column drop zones; visible focus rings on all interactive elements

## Relevant Samples
| Page | Sample | Reason |
|------|--------|--------|
| Task Board | 11-kanban-with-dnd.tsx | Provides the canonical drag-and-drop Kanban pattern with Fluent UI V9, column droppable zones, and card drag handles to adapt for Task entity data |

## Per-Page Specifications

### Task Board
- **File:** task-board.tsx
- **Purpose:** Kanban board displaying Task records in three status columns (To Do, In Progress, Done) with drag-and-drop to update statecode
- **Entities:** task
- **Needs caching:** true
- **Key Features:**
  - Query all Task records using `queryTable("task")` with fields: activityid, subject, statecode, scheduledend, prioritycode, ownerid
  - Group records into three columns by statecode: 0 = To Do, 2 = In Progress, 1 = Completed (Done) — note: Dataverse task statecode 0=Open, 1=Completed, 2=Canceled; map "In Progress" to a client-side filter on a custom view or use statuscode to distinguish active sub-states; if statecode only has 0/1, use statuscode values 2 (In Progress) and 1 (Not Started) within statecode 0 as the split, OR use statecode 0 = To Do, and drive In Progress via statuscode; document the chosen mapping in code comments
  - Each card displays: subject (bold), prioritycode badge (color-coded: 0=Low/grey, 1=Normal/blue, 2=High/orange, 3=Urgent/red), scheduledend formatted as short date
  - Drag a card and drop onto a target column to call `updateRow("task", activityid, { statecode, statuscode })` with the appropriate code pair for that column
  - Keyboard navigation: Tab moves between columns, Arrow keys move between cards within a column, Space/Enter activates drag, Arrow keys select target column, Space/Enter confirms drop (or Escape to cancel)
  - Show a loading spinner while data is fetching; show an empty-state message per column if no tasks
- **Components:**
  - `Card`, `CardHeader`, `CardPreview`, `Badge` from `@fluentui/react-components`
  - `Spinner`, `Text`, `tokens` from `@fluentui/react-components`
  - Custom droppable column wrapper and draggable card wrapper using HTML5 Drag and Drop API (or pointer events) with ARIA attributes (`role="listbox"` on columns, `role="option"` on cards, `aria-dropeffect="move"`, `aria-grabbed`)
  - `makeStyles` for column layout and responsive CSS grid
- **Layout:**
  - CSS Grid with `grid-template-columns: repeat(3, 1fr)` on wide screens
  - Wraps to `grid-template-columns: 1fr` on viewports below 600 px via `@media` query in `makeStyles`
  - Each column has a fixed header (column title + card count badge) and a scrollable card list body
  - Minimum column width 260 px; cards have 8 px gap
- **Data Binding:**
  - On mount: `queryTable("task", { select: ["activityid", "subject", "statecode", "scheduledend", "prioritycode", "ownerid"], orderby: "scheduledend asc" })` — cache result in component state
  - On drop: optimistic UI update (move card in local state immediately), then call `updateRow` in background; on error revert and show toast
  - statecode/statuscode mapping for columns:
    - To Do: statecode=0, statuscode=2 (Not Started)
    - In Progress: statecode=0, statuscode=3 (In Progress) — statuscode 3 is the standard "In Progress" for Task
    - Done: statecode=1, statuscode=5 (Completed)
- **Interactions:**
  - dragstart on card: set dataTransfer with activityid and current column
  - dragover on column: preventDefault to allow drop, highlight column with visual indicator
  - drop on column: read activityid from dataTransfer, compute new statecode/statuscode, update local state, call updateRow
  - dragend: clear drag highlight from all columns
  - Keyboard: focus management so that after a keyboard drop the focus returns to the moved card in its new column
