# Universal Pattern Index

Optional patterns, selected by the actor's task and approved UX contract — **not by industry or a need for extra decoration**. Read this index, then only the named recipe section needed for the current screen. Locate its heading with search and read that range; do not read the whole library or every row in a thematic group.

## Data and discovery

- [Horizontal carousel](universal-patterns/recipes.md#1-horizontal-scroll-carousel): browse comparable media/products when horizontal grouping helps discovery.
- [Sparkline](universal-patterns/recipes.md#2-sparkline--mini-chart): compare a real trend; pair with readable values.
- [Deep search and filters](universal-patterns/recipes.md#4-deep-search-with-filter-drawer): retrieve/triage a collection, using supported server queries.
- [Editorial photography](universal-patterns/recipes.md#25-full-bleed-editorial-photography), [content discovery](universal-patterns/recipes.md#26-content-discovery-feed-netflix--spotify-style): content-led exploration, not an obligatory card dashboard.

## Feedback and progress

- [Skeleton shimmer](universal-patterns/recipes.md#3-skeleton-shimmer-animation), [progress ring](universal-patterns/recipes.md#5-circular-progress-ring): meaningful loading or measured progress, with static/reduced-motion alternatives.
- [Action confirmation](universal-patterns/recipes.md#13-cart-animation--action-confirmation), [live status](universal-patterns/recipes.md#27-live-status-tracker-uber--delivery-style): actual committed state, not success simulated by animation.
- [Elevation on scroll](universal-patterns/recipes.md#21-elevation-change-on-scroll), [empty states](universal-patterns/recipes.md#22-illustrated-empty-states): orientation/recovery where useful.

## Trust and input

- [Biometric reveal](universal-patterns/recipes.md#6-biometric-auth--reveal-gate), [session timeout](universal-patterns/recipes.md#7-session-timeout-warning): only for an actual security requirement and supported auth lifecycle.
- [Offline queue](universal-patterns/recipes.md#8-offline-sync-queue-ui): only if verified runtime support exists; a profile is not a queue.
- [Priority alert](universal-patterns/recipes.md#9-safety--priority-alert-banner), [voice input](universal-patterns/recipes.md#10-voice-input-button): evidence-backed urgency or supported input, not a field-industry default.
- [Progressive disclosure](universal-patterns/recipes.md#18-progressive-disclosure), [inline validation](universal-patterns/recipes.md#19-inline-field-validation): reduce effort without hiding errors or required work.
- [True-black mode](universal-patterns/recipes.md#20-oled-true-black-mode): optional explicit device/theme choice, never an industry-implied preference.

## Content, collaboration, and field work

- [Gamification](universal-patterns/recipes.md#11-gamification-patterns), [coaching](universal-patterns/recipes.md#17-breathing--coaching-animations): only when motivation/coaching is the actual task.
- [Conversation/activity](universal-patterns/recipes.md#12-conversation-thread--activity-feed): actual message/history source; generic chat does not imply Teams.
- [Before/after evidence](universal-patterns/recipes.md#14-photo-annotation--before-after), [larger field targets](universal-patterns/recipes.md#15-enlarged-touch-targets-for-field-use), [map](universal-patterns/recipes.md#16-map-dominant-screens): only as supported by workflow/device evidence.
- [Work timer](universal-patterns/recipes.md#23-startstop-work-timer), [Kanban](universal-patterns/recipes.md#24-kanban-board-view): actual timed work or stage transitions.
- [Swipe actions](universal-patterns/recipes.md#28-swipe-to-act-list-rows-ios-mail-style), [media mini-player](universal-patterns/recipes.md#29-media-mini-player): supported frequent actions/playback, with accessible controls.

## Guardrails

The existing [native allowlist](../../skills/add-native/SKILL.md), [data-performance](data-performance.md), and [accessibility](accessibility-checklist.md) contracts override illustrative snippets. `expo-haptics` is runtime-banned. Do not install native modules from examples, fabricate queue/status data, or infer signatures/auth gates. Optional patterns do not determine screen count or create new requirements.
