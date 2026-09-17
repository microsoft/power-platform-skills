# HTML Report Template

This directory contains the boilerplate HTML template for the **customization report** shown during the SDM to EDM migration.

> The execution/progress report (`datamodel-migration-report.html`) is **not** a static template. It is the live report rendered from `migration-state.json` by `scripts/lib/render-live-report.js` (driven by `scripts/update-state.js`), and is intentionally not generated from a template here.

## Template

### `customization-report.html`
Displays the customization report parsed from the PAC CLI output.

**Placeholders to fill:**
- `{{SITE_NAME}}` - Name of the Power Pages site
- `{{WEBSITE_ID}}` - Website GUID
- `{{TEMPLATE_NAME}}` - Site template name
- `{{REPORT_DATE}}` - ISO format date when report was generated
- `{{TOTAL_CUSTOMIZATIONS}}` - Total count of customizations found
- `{{SUMMARY_TEXT}}` - Summary paragraph explaining what the customizations mean
- `{{CUSTOMIZATIONS_SECTIONS}}` - HTML sections for each customization type (see below)

**Customization Sections Format:**
Generate one section per customization type found in the report. Each section should include:

```html
<div class="customization-section">
  <h2>
    <span class="badge badge-liquid">Liquid References</span>
    Liquid contains adx references
    <span class="customization-count">5</span>
  </h2>
  <table class="customization-table">
    <thead>
      <tr>
        <th>File/Location</th>
        <th>Snippet</th>
        <th>Guidance</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>web-templates/header/Header.webtemplate.source.html</td>
        <td><div class="snippet">{% assign homeurl = website.adx_partialurl %}</div></td>
        <td><a href="https://go.microsoft.com/fwlink/?linkid=2247170">View Guidance</a></td>
      </tr>
    </tbody>
  </table>
</div>
```

**Customization Type Badges:**
- Liquid References: `badge-liquid`
- Custom Workflows: `badge-workflow`
- Data Model Extensions: `badge-data-model`
- Plugins: `badge-plugin`

## Usage in SKILL.md

During skill execution:

1. **After customization analysis (Phase 2.3):**
   - Parse the CSV customization report
   - Render `customization-report.html` with populated placeholders
   - Save to output directory and share with user

> The execution/progress report is owned by the live-report system (`update-state.js` + `render-live-report.js`), not by a template in this folder.

## Placeholder Substitution

When populating the template, replace **every** occurrence of each `{{PLACEHOLDER}}` token. Some tokens (e.g. `{{SITE_NAME}}`, `{{REPORT_DATE}}`) appear more than once, so `String.replace('{{X}}', value)` — which only swaps the *first* match — is **not** sufficient. `generate-migration-reports.js` uses a `fillPlaceholders()` helper that does a global replace:

```javascript
const template = fs.readFileSync('./assets/customization-report.html', 'utf8');
const report = fillPlaceholders(template, {
  '{{SITE_NAME}}': siteName,
  '{{WEBSITE_ID}}': websiteId,
  '{{CUSTOMIZATIONS_SECTIONS}}': customizationsSectionHtml,
});
fs.writeFileSync(outputPath, report, 'utf8');
```

## Styling Notes

The template uses:
- Gradient backgrounds and modern UI
- Accessible color contrast (WCAG AA compliant)
- Responsive grid layouts
- Consistent spacing and typography
- Status indicators (success/warning/error states)
- Code block styling with monospace fonts
- Hover effects for interactive elements

The templates are self-contained (no external CSS or JS dependencies) for offline use.
