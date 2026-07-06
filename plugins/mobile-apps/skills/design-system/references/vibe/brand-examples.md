# Brand Example References

Pre-loaded design system markdown files from real-world apps. Use these as `--brand-doc` input or as inspiration when the user says "I want it to look like X".

## Available Examples

| File | App Type | Best For |
|------|----------|----------|
| [`uber-design.md`](./uber-design.md) | Mobile-first, field drivers | Field apps, logistics, delivery, transportation |
| [`linear-design.md`](./linear-design.md) | Enterprise SaaS, dark mode | Task management, project tracking, dev tools |
| [`intercom-design.md`](./intercom-design.md) | Enterprise chat/support | Customer service, helpdesk, communication |
| [`sentry-design.md`](./sentry-design.md) | Developer tools, monitoring | Ops dashboards, error tracking, technical apps |

## Usage

### As `--brand-doc` input

```bash
/design-system --brand-doc skills/design-system/references/vibe/linear-design.md
```

The skill will:
1. Read the file (50 KB cap)
2. Sanitize and validate content (see Security below)
3. Extract palette/typography/voice/components/negatives
4. Skip the vibe picker (direction is already defined)
5. Lock that direction for all screen builders

### As reference inspiration

When the user says:
- "I want it to look like Linear" -> read `linear-design.md`, extract key tokens
- "Make it feel like Uber" -> read `uber-design.md`, apply pill buttons + black/white palette
- "Dark mode like Sentry" -> read `sentry-design.md`, use deep purple backgrounds

### Key characteristics per example

**Uber** (`uber-design.md`)
- Pure black/white, no mid-grays
- Pill-shaped everything (999px radius)
- UberMove/UberMoveText fonts (fallback: Inter)
- 52px tap targets for field use
- Warm illustrations on stark monochrome

**Linear** (`linear-design.md`)
- Dark mode first, keyboard-driven
- Clean enterprise aesthetic
- Tight spacing, information-dense
- Subtle animations, no decoration

**Intercom** (`intercom-design.md`)
- Cream canvas (`#f5f1ec`), editorial feel
- Single accent: Fin Orange (`#ff5600`)
- Saans font family
- Hairline borders, minimal radii (8-16px)
- Product screenshots dominate

**Sentry** (`sentry-design.md`)
- Deep purple-black backgrounds (`#1f1633`)
- Lime green accent (`#c2ef4e`) for CTAs
- Rubik + Monaco (monospace for code)
- Inset shadows on buttons (tactile feel)
- Frosted glass effects

---

## Security — Input Sanitization

When reading user-provided brand documents (`--brand-doc`, `--from-url`, or pasted content), apply these checks **before** processing:

### 1. File validation

```
- Max file size: 50 KB (reject larger with clear error)
- Allowed extensions: .md, .markdown, .txt, .yaml, .yml, .json
- Reject binary files, executables, or unknown types
- Path traversal check: reject paths containing "..", "~", or absolute paths outside working_dir
```

### 2. Content sanitization

```
MUST strip or escape before processing:
- HTML script tags: <script>, </script>, javascript:
- Event handlers: onclick, onerror, onload, etc.
- Data URIs: data:text/html, data:application/javascript
- Template injection: {{ }}, <% %>, ${ }
- Shell metacharacters in any value that might reach Bash: ; | & ` $() 
- Null bytes: \x00
- Control characters except newline/tab
```

### 3. Structural validation

```
Brand doc MUST contain at least ONE of:
- A "colors" or "palette" section with valid hex codes
- A "typography" section with font names
- A "components" section with named elements

Brand doc MUST NOT contain:
- URLs pointing to localhost, 127.0.0.1, or internal IPs
- References to file:// protocol
- Base64-encoded content longer than 1KB
- More than 10 external URL references (likely scraping attempt)
```

### 4. Hex color validation

```python
# Only accept valid 3, 4, 6, or 8 character hex codes
valid_hex = re.match(r'^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$', color)
```

### 5. Font name validation

```
- Max 50 characters per font name
- Alphanumeric, spaces, hyphens only
- Reject font names containing path separators or shell chars
- Cross-check against known font list OR accept with warning
```

### 6. URL validation (for --from-url)

```
ALLOW:
- https:// only (reject http://)
- Known safe domains: github.com, githubusercontent.com, figma.com, notion.so

REJECT:
- Internal IPs: 10.x, 172.16-31.x, 192.168.x, 127.x
- localhost, 0.0.0.0
- Non-standard ports
- URLs with credentials (user:pass@)
- Redirect chains > 3 hops
```

### 7. Error handling

```
On validation failure:
- STOP processing immediately
- Print specific error: "BLOCKED: <file> contains <issue> at line <N>"
- Do NOT echo the problematic content back to the user
- Log the attempt to memory-bank.md under ## Security events
```

### Implementation checklist

When implementing `--brand-doc` or any user file input:

- [ ] Check file size before reading full content
- [ ] Validate file extension
- [ ] Check path for traversal attempts
- [ ] Read content into sandboxed string (not eval'd)
- [ ] Run sanitization regex pass
- [ ] Validate structure has required sections
- [ ] Validate all color codes
- [ ] Validate all font names  
- [ ] Log sanitization actions to debug output
- [ ] On any failure: stop, don't proceed with partial data

---

## Adding Your Own

Users can provide their own brand markdown file:

```bash
/design-system --brand-doc ~/my-company/brand-guidelines.md
```

The file should include:
- Color palette with hex values (validated)
- Typography (font families, sizes, weights)
- Component patterns (buttons, cards, inputs)
- Voice/tone guidelines
- What to avoid (negatives)

See the examples above for format reference. All user-provided files go through the security validation pipeline above.

## Source

Examples sourced from [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md/tree/main/design-md) — a collection of 70+ design system markdown files from major tech companies.
