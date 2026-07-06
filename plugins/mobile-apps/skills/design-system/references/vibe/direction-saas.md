# Direction: SaaS

The default productivity look. Familiar, professional, the look people inside an org expect from internal tools. Microsoft 365 / Asana / Salesforce family resemblance.

## Reference apps

Microsoft Teams mobile, Asana, Slack, Salesforce mobile, Notion (the trustworthy default), GitHub mobile, Jira mobile, Monday.com

## Gestalt

> "Trustworthy, predictable, doesn't surprise. Looks like every other internal tool you use — and that's the point."

## Bundle

```yaml
direction: saas
surface: subtle-depth
background: cool-gray-light
palette: cool-gray + indigo
typography: sans-only
heading_font: Inter
body_font: Inter
body_size: 15pt
list_style: row-with-chevron
density: comfortable
motion: subtle
status_saturation: desaturated
empty_state: icon-explanation-ghostbutton
primary_action_shape: rectangular
primary_action_position: top-right-or-in-flow
accent_color: indigo (#4f46e5)
tone: professional
```

## Visual rules

### Surface
- **Background:** off-white (`#fafafa` or `#f7f8fa`) — cool-gray tint
- **Cards:** white surface (`#ffffff`) with 1px hairline border (`#e5e7eb`) AND subtle shadow on raised cards (`shadowOpacity: 0.04, shadowRadius: 8`)
- **Borders:** 1px hairline on cards, 0.5px separator on list rows, 1px on inputs
- **Card spacing:** `gap="$4"` (~16pt) — comfortable, not crammed

### Palette
- **Base:** cool gray (`#f9fafb` → `#9ca3af` → `#111827`)
- **Primary accent:** indigo `#4f46e5` (or blue `#0066cc` / violet `#7c3aed` if user prefers)
- **Accent usage:** primary buttons, active tab indicator, links, unread badges. NOT borders, NOT icons, NOT card surfaces.
- **Status colors (DESATURATED — pill bg at saturation 3, text at saturation 10):**
  - Success: `bg="$green3" col="$green10"` (NOT `bg="$green9" color="white"` — that looks alarming)
  - Warning: `bg="$amber3" col="$amber10"`
  - Error: `bg="$red3" col="$red10"`
  - Info: `bg="$blue3" col="$blue10"`

### Typography
- **Family:** Inter or SF Pro — sans-serif system font feel
- **Sizes:** body 15pt, secondary 13pt, titles 17–22pt, page titles 28pt
- **Weights:** 400 body, 500 emphasised body, 600 titles, 700 page headers
- **Tracking:** default (no negative tracking)
- **Numerals:** proportional default, tabular only for tables/data

### List rows
- **Row with chevron** (the universal pattern):
  ```tsx
  <XStack ai="center" gap="$3" px="$4" py="$3" borderBottomWidth={0.5} borderBottomColor="$borderColor">
    <Avatar size={36} />
    <YStack flex={1} gap="$1">
      <Text fontSize="$5" fontWeight="500" numberOfLines={1}>{item.title}</Text>
      <Text fontSize="$3" color="$color10" numberOfLines={1}>{item.meta}</Text>
    </YStack>
    <StatusPill status={item.status} />
    <Ionicons name="chevron-forward" size={16} color="$color10" />
  </XStack>
  ```
- Avatar/icon left, title + meta middle, status pill + chevron right
- 0.5px separator between rows (not full borders)
- Tap target: entire row, 56pt+ tall

### Empty state
- Medium Ionicon (size 40) at top, in `$color10` (muted but readable)
- One-line explanation in 15pt
- Ghost (outline) button below — `<Button variant="outlined">` not `<Button theme="active">`
- Example: `<Ionicons name="folder-open-outline" size={40} color="$color10" />` + "No projects yet" + ghost "+ Create project" button

### Error state
- Inline icon + message + retry button (subtle, not alarming)
- Copy: `"Couldn't load projects. Try again."` — professional, not chatty

### Loading
- Shimmer skeleton (animated gradient sweep) — feels modern in office context
- 3–4 row skeletons matching the populated layout

### Primary action
- **Position:** top-right `+` icon button on list screens (matches Teams / Slack / GitHub pattern), in-flow primary button with verified tokens (`bg="$blue10" color="$color1"` or brand tokens) on detail / form screens
- **Shape:** rectangular with 8pt radius (`borderRadius: 8`)
- **Color:** indigo accent fill, white text
- **Label:** noun-or-verb-with-object — `"Save changes"`, `"Create project"`, `"Send for approval"`. Slightly more formal than Inspection.

### Motion
- **Subtle:** `FadeIn` on screen enter (200ms), `pressStyle={{ scale: 0.98 }}` on tappable rows
- No stagger, no spring, no parallax
- Modal sheets slide up from bottom (system default — don't override)

### Status pills
- Desaturated background with darker text:
  ```tsx
  <YStack bg="$green3" px="$2" py="$1" br="$2">
    <Text col="$green10" fontSize="$2" fontWeight="600">Active</Text>
  </YStack>
  ```
- Sentence case (NOT all caps), weight 600, sized 11pt

### Tone
- **Professional, not stiff:** `"Save changes"` not `"Submit"`, `"Couldn't load projects"` not `"Failed to retrieve project list"`
- **Action-specific labels:** never `"Submit"` / `"OK"` / `"Continue"` alone
- **Polite errors:** `"Couldn't load projects. Try again."` not `"Error: failed to load"`
- **No emojis, no exclamations**

## When this fits well

- Internal employee-facing apps
- Anywhere users expect Microsoft 365 family resemblance
- Multi-stakeholder approval / review workflows
- Reporting and dashboard apps for managers
- Apps with clear hierarchical navigation (projects → tasks → comments)
- The user said "make it look professional" or "like Asana / Teams"

## When this misfits

- Outdoor / field use (insufficient contrast)
- Premium consumer experience (too templated)
- Apps where personality matters (engagement, retention, onboarding)
- Quick-glance utility apps (chevrons + decorations get in the way)
