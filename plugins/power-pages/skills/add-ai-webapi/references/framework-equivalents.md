# Framework equivalents — non-React UI snippets

The `ai-webapi-integration` agent spells out two UI pieces as **worked React examples**:

1. the **safe-markdown renderer** (`SummaryMarkdown` / `renderInline`) used for list/data
   summaries, and
2. **citation rendering** (`parseSummaryWithCitations` consumer + `resolveCitationHref`) used
   for Search Summary.

This file carries the **Vue (SFC), Angular (component), and Astro** equivalents so non-React
runs are as deterministic as React. The contract is identical across frameworks:

- **Never** use `v-html`, `[innerHTML]`, `dangerouslySetInnerHTML`, or a general markdown
  renderer. The summary string is server content that isn't sanitized for HTML injection;
  render React/Vue/Angular nodes (or escaped text) only.
- Same token set for the markdown renderer: `**bold**` → `<strong>`, `\n\n` → paragraph break,
  `\n` → `<br>` inside a paragraph. No headings, lists, links, code blocks, or tables.
- Citations use the `SummaryPart[]` shape from
  [`ai-api-reference.md`](./ai-api-reference.md) (`{ kind: 'text', text }` |
  `{ kind: 'citation', token, url }`); rewrite hrefs with `extractKnowledgeArticleId` and label
  with `CitationTitleMapping[token]` (falling back to the URL).

Keep `parseSummaryWithCitations`, `extractKnowledgeArticleId`, `normalizeSummaryString`, and
`resolveCitationHref` in the shared `aiSummaryService.*` (or shared utils) — these are
framework-agnostic and must not be redefined per component.

---

## 1. Safe-markdown renderer

Input has already passed through `normalizeSummaryString` (the JSON-array tabular-insight shape
is collapsed to paragraph-separated text before it reaches the UI), so the renderer only handles
`**bold**`, `\n\n`, and `\n`.

### Vue (SFC)

`src/components/SummaryMarkdown.vue` — split into paragraphs, then split each line on the
`**bold**` regex; emit `<strong>` or text spans. No `v-html`.

```vue
<script setup lang="ts">
const props = defineProps<{ text: string }>()

interface Segment { bold: boolean; text: string }
interface Line { segments: Segment[] }
interface Para { lines: Line[] }

function toParagraphs(raw: string): Para[] {
  return raw
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({
      lines: p.split('\n').map((line) => ({ segments: splitBold(line) })),
    }))
}

function splitBold(line: string): Segment[] {
  const out: Segment[] = []
  const re = /\*\*([^*]+?)\*\*/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) out.push({ bold: false, text: line.slice(last, m.index) })
    out.push({ bold: true, text: m[1] })
    last = re.lastIndex
  }
  if (last < line.length) out.push({ bold: false, text: line.slice(last) })
  return out
}
</script>

<template>
  <div>
    <p v-for="(para, pi) in toParagraphs(text)" :key="pi">
      <template v-for="(line, li) in para.lines" :key="li">
        <template v-for="(seg, si) in line.segments" :key="si">
          <strong v-if="seg.bold">{{ seg.text }}</strong>
          <span v-else>{{ seg.text }}</span>
        </template>
        <br v-if="li < para.lines.length - 1" />
      </template>
    </p>
  </div>
</template>
```

### Angular

`src/app/components/summary-markdown.component.ts` — a pure component with `text` as `@Input()`,
rendering the same paragraph/line/segment structure with `*ngFor` / `*ngIf`. No `[innerHTML]`.

```ts
import { Component, Input } from '@angular/core';

interface Segment { bold: boolean; text: string; }
interface Line { segments: Segment[]; }
interface Para { lines: Line[]; }

@Component({
  selector: 'app-summary-markdown',
  template: `
    <div>
      <p *ngFor="let para of paragraphs">
        <ng-container *ngFor="let line of para.lines; let li = index">
          <ng-container *ngFor="let seg of line.segments">
            <strong *ngIf="seg.bold">{{ seg.text }}</strong>
            <span *ngIf="!seg.bold">{{ seg.text }}</span>
          </ng-container>
          <br *ngIf="li < para.lines.length - 1" />
        </ng-container>
      </p>
    </div>
  `,
})
export class SummaryMarkdownComponent {
  paragraphs: Para[] = [];

  @Input() set text(raw: string) {
    this.paragraphs = (raw ?? '')
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => ({ lines: p.split('\n').map((line) => ({ segments: this.splitBold(line) })) }));
  }

  private splitBold(line: string): Segment[] {
    const out: Segment[] = [];
    const re = /\*\*([^*]+?)\*\*/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) out.push({ bold: false, text: line.slice(last, m.index) });
      out.push({ bold: true, text: m[1] });
      last = re.lastIndex;
    }
    if (last < line.length) out.push({ bold: false, text: line.slice(last) });
    return out;
  }
}
```

### Astro

If the site mounts React/Vue islands, reuse the island component rather than duplicating the
logic. For a pure-Astro component, do the parsing in the frontmatter and iterate in the template
— Astro escapes `{...}` expressions by default, so plain text interpolation is safe.

```astro
---
interface Props { text: string }
const { text } = Astro.props

const paragraphs = text
  .split(/\n{2,}/)
  .map((p) => p.trim())
  .filter(Boolean)
  .map((p) =>
    p.split('\n').map((line) => {
      const segs: { bold: boolean; text: string }[] = []
      const re = /\*\*([^*]+?)\*\*/g
      let last = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(line)) !== null) {
        if (m.index > last) segs.push({ bold: false, text: line.slice(last, m.index) })
        segs.push({ bold: true, text: m[1] })
        last = re.lastIndex
      }
      if (last < line.length) segs.push({ bold: false, text: line.slice(last) })
      return segs
    }),
  )
---
<div>
  {paragraphs.map((lines) => (
    <p>
      {lines.map((segs, li) => (
        <>
          {segs.map((seg) => (seg.bold ? <strong>{seg.text}</strong> : <span>{seg.text}</span>))}
          {li < lines.length - 1 && <br />}
        </>
      ))}
    </p>
  ))}
</div>
```

---

## 2. Citation rendering (Search Summary)

`parseSummaryWithCitations(Summary)` returns `SummaryPart[]`. Emit framework-native anchors for
`citation` parts; rewrite the href via `resolveCitationHref` (which calls
`extractKnowledgeArticleId` and falls back to the raw URL on SPA sites); label with
`CitationTitleMapping[token]` falling back to the URL, then the bare token. Keep the visible text
as the token so inline citations stay scannable.

`resolveCitationHref` is shared (define once in the service):

```ts
import { extractKnowledgeArticleId } from '../services/aiSummaryService';

export function resolveCitationHref(url: string): string {
  const articleId = extractKnowledgeArticleId(url);
  return articleId ? `/knowledge/${articleId}` : url; // confirm the project's actual KB route
}
```

### Vue (SFC)

```vue
<script setup lang="ts">
import { parseSummaryWithCitations } from '../services/aiSummaryService'
import { resolveCitationHref } from '../services/citations'

const props = defineProps<{
  summary: string
  citationTitleMapping?: Record<string, string>
}>()

const parts = parseSummaryWithCitations(props.summary)
const label = (token: string, url: string) =>
  props.citationTitleMapping?.[token] ?? url ?? token
</script>

<template>
  <p>
    <template v-for="(part, i) in parts" :key="i">
      <span v-if="part.kind === 'text'">{{ part.text }}</span>
      <a
        v-else
        :href="resolveCitationHref(part.url)"
        :title="label(part.token, part.url)"
        target="_blank"
        rel="noopener noreferrer"
        >{{ part.token }}</a
      >
    </template>
  </p>
</template>
```

### Angular

```ts
import { Component, Input } from '@angular/core';
import { parseSummaryWithCitations } from '../services/aiSummaryService';
import { resolveCitationHref } from '../services/citations';

@Component({
  selector: 'app-summary-with-citations',
  template: `
    <p>
      <ng-container *ngFor="let part of parts">
        <span *ngIf="part.kind === 'text'">{{ part.text }}</span>
        <a
          *ngIf="part.kind === 'citation'"
          [href]="resolveCitationHref(part.url)"
          [title]="label(part.token, part.url)"
          target="_blank"
          rel="noopener noreferrer"
          >{{ part.token }}</a
        >
      </ng-container>
    </p>
  `,
})
export class SummaryWithCitationsComponent {
  @Input() summary = '';
  @Input() citationTitleMapping?: Record<string, string>;
  resolveCitationHref = resolveCitationHref;

  get parts() {
    return parseSummaryWithCitations(this.summary);
  }

  label(token: string, url: string): string {
    return this.citationTitleMapping?.[token] ?? url ?? token;
  }
}
```

### Astro

```astro
---
import { parseSummaryWithCitations } from '../services/aiSummaryService'
import { resolveCitationHref } from '../services/citations'

interface Props { summary: string; citationTitleMapping?: Record<string, string> }
const { summary, citationTitleMapping } = Astro.props
const parts = parseSummaryWithCitations(summary)
const label = (token: string, url: string) => citationTitleMapping?.[token] ?? url ?? token
---
<p>
  {parts.map((part) =>
    part.kind === 'text' ? (
      <span>{part.text}</span>
    ) : (
      <a
        href={resolveCitationHref(part.url)}
        title={label(part.token, part.url)}
        target="_blank"
        rel="noopener noreferrer"
      >{part.token}</a>
    ),
  )}
</p>
```

> **Citation list ("Sources" footer).** The visible label for each row is
> `CitationTitleMapping[token]`; fall back to the URL **only** when the mapping is missing.
> Never show a bare URL when a mapping exists — it reads as broken UI.
