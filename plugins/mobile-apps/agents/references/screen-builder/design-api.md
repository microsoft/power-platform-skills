# Design translation and API lookup

This is a lookup reference, not required reading for an already resolved skeleton.
Read only when translating unresolved design fields or answering an API question.

## Design precedence and translation

Brand `## Negatives` forbids patterns absolutely. Approved brand components, palette,
and typography precede per-screen overrides; inherit missing fields from Design
Direction. Do not treat a recipe's preferred style as an approved requirement.

| Approved field | Implementation decision |
|---|---|
| Domain layout / primary action | Lead with fields needed for that actor's task; preserve operation/success/recovery |
| Density | Adjust padding/spacing/row rhythm without shrinking effective touch targets |
| Flat / depth / strong cards / editorial | Choose grouping from that treatment, not mandatory generic cards or opacity that harms contrast |
| Container hierarchy | Match grouping to the task: rows, timelines, grids, readers, cards or sections; remove redundant nesting, not meaningful hierarchy |
| Restrained / expressive / monochrome | Place accent accordingly; monochrome may communicate hierarchy with weight and boundaries |
| Hero / visual emphasis | Render only the specified meaningful emphasis; “content leads” means no invented hero |
| Radius / typography / tone | Use actual configured tokens/fonts and domain-appropriate wording |
| Primary action position | Header, inline, floating, or bottom as approved; keyboard/reachability remain required |
| Motion | Respect approved policy and reduced motion over every animation recipe |

The “one memorable thing” can be supported by restraint. It does not require a hero
on every form or dashboard metrics on every home screen. No universal palette ratio,
monospace values, large title, truncation, bottom bar, shadow, or required empty-state art.
At the approved device width, avoid decoration that overwhelms content and disclose secondary
information progressively without hiding essential evidence. Cards and continuous lists are
both valid; neither is the universal default. Preserve tablet-specific composition when requested.
Preserve the approved task-critical facts, relationships and next action, not just a preview's
colors and containers. If an essential field/operation is absent from the verified contract,
return the mismatch to foreground; do not invent production data to reproduce a richer mock.
Implement the accepted entry composition from Layout delta and the accepted visual reference,
not a superseded provisional planner suggestion: preserve first-viewport priorities, visible
media-subject scale and below-fold access, not just colors or outer container dimensions.
A selected preview state is not
automatically the app's default filter or record; honor the approved Data/Navigation entry.

## Tamagui and host contract

Inspect `tamagui.config.ts` / supplied resolved tokens. Current host config uses Tamagui
2, Config v5, `createPowerAppsTamaguiConfig`, customization markers and `customConfig`.
Missing/stale factory config is a foreground prerequisite, not a builder rewrite.

Host semantic aliases: `$surface0`–`$surface3`, `$mediaSurface`, `$accentDeep`,
`$accentBase`, `$accentSoft`, `$accentOnAccent`, `$text0`–`$text3`, documented
`$status*` pairs and `$mono`. Config v5 provides standard numbered values.
Only use other aliases/fonts/themes when actual config defines them. Brand hex values
belong in brand tokens/config, not screen JSX.

- Tamagui layout uses `$token` strings; raw RN/native controls use resolved
  `useThemeTokens()` values. Do not access `.val` on host string tokens.
- Use v5 shorthands where defined: `bg`, `items`, `justify`, `rounded`, `text`, `self`,
  `grow`, `shrink`, spacing/edge/min/max. Keep unaliased longhands such as `flex`,
  `width`, `height`, `color`, `fontSize`, `fontWeight`, `position`.
- No v4 aliases (`ai`, `jc`, `br`, `f`, `w`, `h`, `col`, `pos`, `ta`, `als`, `tt`, `ls`).
- `Button.Text` owns label color/font styling. Use verified theme or explicit
  frame/text tokens, never guessed `theme="active"`/`"primary"`.
- `$color`, `$bg`, guessed `$primary`, raw hex, and unknown aliases can silently
  misrender. Readable text/icons need sufficient contrast in light and dark themes.
- Tamagui shadows use `boxShadow` or verified v2 tokens, not spread native shadow props.
- RN scroll/keyboard/gesture APIs and Expo Router navigation options stay native;
  Tamagui replaces visual/layout primitives, not navigation.

For a remaining component API question load the matching section of
`shared/references/tamagui-component-recipes.md` or the matching screen sample.
Only a requested custom palette/font/tone calls for the corresponding sections of
`color-palette-architecture.md` / `typography-and-tone.md`. Do not load full industry
or philosophy catalogues based on a keyword alone.
