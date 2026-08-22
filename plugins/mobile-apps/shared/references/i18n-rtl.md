# Internationalization And RTL

Generated mobile apps must remain usable when device locale, script, and
reading direction change. English layout is not the canonical geometry.

## Locale And Messages

- Format dates, numbers, currencies, and plurals with `Intl` using the active
  device locale. Do not concatenate translated fragments.
- Quantity copy uses `Intl.PluralRules`, project i18n plural forms, or an
  explicit singular/plural branch.
- Test realistic translated content, not mirrored English placeholders.

## Script-Aware Typography

Arabic and other joining scripts do not tolerate Latin display tracking or
uppercase transforms. Resolve typography from the active locale:

```tsx
const isLatinScript = /^en\b|^fr\b|^de\b/i.test(locale);
<Text
  fontFamily={isLatinScript ? '$heading' : '$body'}
  letterSpacing={isLatinScript ? -0.5 : 0}
  textTransform={isLatinScript ? 'uppercase' : 'none'}
/>
```

Literal non-zero `letterSpacing` and unconditional uppercase UI text are
forbidden. Arabic uses a font stack with Arabic glyph coverage and spacing 0.

## Logical Layout

- Use `start`/`end`, `marginStart`/`marginEnd`, `paddingStart`/`paddingEnd`, and
  logical border properties. Do not encode reading direction with left/right.
- Read direction from the app i18n layer or `I18nManager.isRTL`.
- A direction-sensitive horizontal group uses `testID="mirror-row:<key>"`.
  Its meaningful children expose `dataSet={{ logicalOrder: '<1..N>' }}` so the
  harness can prove increasing logical order appears right-to-left in Arabic.

## Directional Icons

Mirror only icons whose meaning depends on reading direction. Back/forward,
chevrons, arrows, progressions, and navigation transitions use an explicit
`I18nManager.isRTL` branch:

```tsx
<Ionicons name={I18nManager.isRTL ? 'chevron-forward' : 'chevron-back'} />
```

Do not mirror media controls, clocks, brand marks, numbers, or non-directional
object icons.

## Browser Matrix

Run the same registry-driven harness in LTR and Arabic RTL modes:

```bash
node harness/run.js --project "$PROJECT_DIR" --check all
node harness/run.js --project "$PROJECT_DIR" --check all --locale ar
```
