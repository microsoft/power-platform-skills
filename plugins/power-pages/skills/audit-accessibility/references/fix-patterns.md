# Accessibility fix patterns

Use these patterns to propose the smallest change that resolves each finding. Always fix the shared component, layout, or template rather than each page. Follow the site's framework (React, Vue, Angular, Astro, or Liquid web templates) and its existing styling approach.

## axe-core rules

| Rule | WCAG | Fix |
|------|------|-----|
| `image-alt`, `role-img-alt`, `input-image-alt` | 1.1.1 | Add `alt` text that conveys the image's purpose. Use `alt=""` for decorative images. |
| `svg-img-alt` | 1.1.1 | Add `role="img"` with `aria-label`, or `aria-hidden="true"` when decorative. |
| `button-name` | 4.1.2 | Give icon buttons visible text or an `aria-label`. |
| `link-name` | 2.4.4, 4.1.2 | Add link text or an `aria-label`. Icon-only links need a label too. |
| `label`, `select-name` | 1.3.1, 4.1.2 | Associate a `<label for>` with each field, or wrap the field in a label. Placeholders aren't labels. |
| `aria-input-field-name`, `aria-toggle-field-name` | 4.1.2 | Add `aria-label` or `aria-labelledby` to custom widgets. |
| `color-contrast` | 1.4.3 | Raise contrast to at least 4.5:1 (3:1 for large text). Prefer adjusting an existing theme token. |
| `link-in-text-block` | 1.4.1 | Underline links inside text, or give them 3:1 contrast with the surrounding text plus a non-color cue on focus and hover. |
| `html-has-lang`, `html-lang-valid` | 3.1.1 | Set `<html lang="en">` (or the site language) in the root template or `index.html`. |
| `document-title` | 2.4.2 | Set a unique, descriptive `<title>` per page or route. |
| `heading-order`, `page-has-heading-one` | 1.3.1 (best practice) | Use one `<h1>` per page and don't skip heading levels. |
| `landmark-one-main`, `region` | 1.3.1 (best practice) | Wrap the main content in `<main>`, and put header, nav, and footer content in landmarks. |
| `bypass` | 2.4.1 | Add a "Skip to main content" link as the first focusable element. |
| `list`, `listitem` | 1.3.1 | Keep `<li>` elements directly inside `<ul>` or `<ol>`. |
| `aria-allowed-attr`, `aria-required-attr`, `aria-valid-attr-value` | 4.1.2 | Use only the ARIA attributes the role supports, with valid values. Prefer native elements. |
| `aria-hidden-focus` | 4.1.2 | Don't hide focusable elements with `aria-hidden`. Make them non-focusable too, or use `inert`. |
| `nested-interactive` | 4.1.2 | Don't put a button or link inside another button or link. |
| `duplicate-id-aria` | 4.1.2 | Make ids referenced by `aria-labelledby` or `for` unique. Watch for repeated components. |
| `meta-viewport` | 1.4.4 | Remove `maximum-scale=1` and `user-scalable=no`. |
| `frame-title` | 4.1.2 | Add a `title` to each `<iframe>` (for example, embedded maps or videos). |
| `target-size` | 2.5.8 | Make touch targets at least 24 by 24 CSS pixels, or space them apart. |

## Extended checks

| Finding | WCAG | Fix |
|---------|------|-----|
| `pp-keyboard-trap` | 2.1.2 | Let `Tab` and `Escape` move focus out of the widget. For modal dialogs, trap focus only while open and return focus to the trigger when closed. |
| `pp-focus-not-visible` | 2.4.7 | Remove `outline: none` without a replacement. Add a visible `:focus-visible` style with at least 3:1 contrast. |
| `pp-focus-offscreen` | 2.4.7 | Don't leave hidden content focusable. Use `display: none`, `hidden`, or `inert` for closed menus, and show skip links on focus. |
| `pp-reflow-horizontal-scroll` | 1.4.10 | Remove fixed widths; use `max-width: 100%`, flexible grids, and wrapping. Let wide tables scroll inside their own container. |
| `pp-text-clipped-at-200` | 1.4.4 | Replace fixed heights with `min-height`, avoid `overflow: hidden` on text containers, and size text in `rem`. |
| `pp-motion-ignores-reduced-motion` | 2.2.2 | Give long-running motion a pause control, and wrap animations and transitions in `@media (prefers-reduced-motion: no-preference)` (or turn them off under `reduce`), which also meets 2.3.3 (AAA). |
| `pp-autoplay-video-no-controls` | 2.2.2, 1.4.2 | Add `controls`, or a visible pause button, to autoplaying video. Don't autoplay audio. Heuristic: if the page already has its own pause button, it isn't a defect. |
| `pp-page-title-missing` | 2.4.2 | Set a `<title>` for the route. In single-page apps, update `document.title` on navigation. |
| `pp-page-title-duplicate` | 2.4.2 | Make each page's title unique, for example "Contact us – Contoso". |

## Power Pages notes

- **Code sites**: Shared layout lives in the root component or layout file (for example, `src/App.tsx` or `src/layouts/Layout.astro`), and the document language and viewport live in `index.html`.
- **Declarative sites**: Fix markup in web templates, page copy, and content snippets under `.powerpages-site/`. Theme colors usually come from the site's CSS files.
- **Out-of-the-box components**: Some markup (for example, basic forms, lists, or the sign-in page) comes from the Power Pages runtime. When a finding is in runtime markup you can't edit, report it and suggest a supported setting or CSS change instead of a source edit.
- **Design decisions**: Color, wording, and alternative text affect the brand and meaning. Propose a value and let the user confirm.
