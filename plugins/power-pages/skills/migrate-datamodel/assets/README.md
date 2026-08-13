# HTML Report Templates

This directory contains boilerplate HTML templates for generating user-friendly reports during the SDM to EDM migration.

## Templates

### 1. `customization-report.html`
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

### 2. `sdm-to-edm-migration-report.html`
Displays the complete migration execution workflow with PAC commands, results, and remediation guidance.

**Placeholders to fill:**
- `{{MIGRATION_STATUS}}` - One of: `success`, `warning`, `error`
- `{{STATUS_ICON}}` - Emoji: ✅ (success), ⚠️ (warning), ❌ (error)
- `{{SITE_NAME}}` - Power Pages site name
- `{{WEBSITE_ID}}` - Website GUID
- `{{PORTAL_ID}}` - Portal GUID
- `{{MIGRATION_STATUS_TEXT}}` - Human-readable status (e.g., "Completed Successfully")
- `{{REPORT_DATE}}` - ISO format date
- `{{EXECUTION_TIME}}` - Time taken for migration (e.g., "3 minutes 45 seconds")
- `{{PREREQUISITES_ITEMS}}` - HTML for prerequisites (see below)
- `{{PAC_COMMANDS_SECTION}}` - HTML for executed PAC commands (see below)
- `{{CUSTOMIZATION_ANALYSIS_SECTION}}` - HTML for customization analysis results
- `{{MIGRATION_PHASES_SECTION}}` - HTML for each migration phase (see below)
- `{{REMEDIATION_DISPLAY}}` - `block` if remediation needed, `none` if not
- `{{REMEDIATION_GUIDANCE_SECTION}}` - HTML for remediation guidance (see below)
- `{{SUMMARY_METRICS}}` - HTML table rows with migration metrics
- `{{NEXT_STEPS_ITEMS}}` - HTML list items with recommended next steps

**Prerequisites Items Format:**
```html
<div class="prerequisite-item">
  <div class="check-icon success">✓</div>
  <div class="prerequisite-content">
    <div class="prerequisite-title">PAC CLI Version</div>
    <div class="prerequisite-description">v1.31.6 or higher is installed (Current: v1.32.1)</div>
  </div>
</div>
```

**PAC Commands Section Format:**
```html
<div class="phase">
  <div class="command-label">Command 1: Check Authentication</div>
  <div class="command-block">pac auth who</div>
  <div class="result-item success">
    <div class="result-title">✓ Success</div>
    <div class="result-description">Authenticated to https://org12345.crm.dynamics.com</div>
  </div>
</div>

<div class="phase">
  <div class="command-label">Command 2: List Available Sites</div>
  <div class="command-block">pac pages list</div>
  <div class="result-item success">
    <div class="result-title">✓ Success</div>
    <div class="result-description">Found 3 websites. Target site selected: "Contoso Portal" (ID: 076bf556-9ae6-ee11-a203-6045bdf0328e)</div>
  </div>
</div>
```

**Migration Phases Section Format:**
```html
<div class="phase">
  <div class="phase-title">
    <span class="phase-number">1</span>
    Verify Prerequisites
    <span class="phase-status status-completed">Completed</span>
  </div>
  <div class="phase-content">
    <div class="result-item success">
      <div class="result-title">✓ PAC CLI Verified</div>
      <div class="result-description">PAC CLI version 1.32.1 meets minimum requirement (1.31.6)</div>
    </div>
    <div class="result-item success">
      <div class="result-title">✓ Package Versions Confirmed</div>
      <div class="result-description">Dataverse base portal package 9.3.2307.x or higher, Power Pages Core 1.0.2309.63 or higher</div>
    </div>
  </div>
</div>

<div class="phase">
  <div class="phase-title">
    <span class="phase-number">2</span>
    Authentication & Site Discovery
    <span class="phase-status status-completed">Completed</span>
  </div>
  <div class="phase-content">
    <div class="result-item success">
      <div class="result-title">✓ Environment Authenticated</div>
      <div class="result-description">Successfully authenticated to https://org12345.crm.dynamics.com</div>
    </div>
  </div>
</div>
```

**Remediation Guidance Section Format:**
```html
<div class="remediation-section">
  <h3 style="color: #003d82; margin-bottom: 16px;">8A: Custom Columns on adx Metadata Tables</h3>
  <div class="remediation-steps">
    <div class="remediation-title">Found: 3 custom columns</div>
    <ul class="remediation-list">
      <li>Table: <strong>adx_webpage</strong>, Column: <strong>contoso_pagetype</strong> - Create new table and migrate data</li>
      <li>Table: <strong>adx_weblink</strong>, Column: <strong>contoso_priority</strong> - Create new table and migrate data</li>
      <li>Table: <strong>adx_ad</strong>, Column: <strong>contoso_adtype</strong> - Create new table and migrate data</li>
    </ul>
  </div>
</div>

<div class="remediation-section">
  <h3 style="color: #003d82; margin-bottom: 16px;">8C: adx Table References in Liquid Code</h3>
  <div class="remediation-steps">
    <div class="remediation-title">Found: 8 Liquid references</div>
    <div style="margin-top: 12px; padding: 12px; background: #f5f5f5; border-radius: 4px;">
      <strong style="color: #333;">Example - Before (SDM):</strong>
      <div class="code-snippet">{% assign homeurl = website.adx_partialurl %}</div>
      <strong style="color: #333; display: block; margin-top: 8px;">After (EDM):</strong>
      <div class="code-snippet">{% assign homeurl = website.powerpages_partialurl %}</div>
    </div>
  </div>
</div>

<table class="component-type-table">
  <thead>
    <tr>
      <th>Component</th>
      <th>Type Value</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Publishing State</td>
      <td>1</td>
    </tr>
    <tr>
      <td>Web Page</td>
      <td>2</td>
    </tr>
    <!-- ... more rows ... -->
  </tbody>
</table>
```

## Usage in SKILL.md

During skill execution:

1. **Phase 3 (After Customization Analysis):**
   - Parse the CSV customization report
   - Render `customization-report.html` with populated placeholders
   - Save to output directory and share with user

2. **Phase 10 (After Migration Complete):**
   - Render `sdm-to-edm-migration-report.html` with all execution data
   - Include all PAC commands run and their results
   - Include remediation guidance for each customization type found
   - Save to output directory and share with user

## Placeholder Substitution

When populating templates, use simple string replacement (e.g., in Node.js):

```javascript
const template = fs.readFileSync('./assets/customization-report.html', 'utf8');
const report = template
  .replace('{{SITE_NAME}}', siteName)
  .replace('{{WEBSITE_ID}}', websiteId)
  .replace('{{CUSTOMIZATIONS_SECTIONS}}', customizationsSectionHtml);
fs.writeFileSync(outputPath, report, 'utf8');
```

Or use a template engine like Handlebars if more complex logic is needed.

## Styling Notes

Both templates use:
- Gradient backgrounds and modern UI
- Accessible color contrast (WCAG AA compliant)
- Responsive grid layouts
- Consistent spacing and typography
- Status indicators (success/warning/error states)
- Code block styling with monospace fonts
- Hover effects for interactive elements

The templates are self-contained (no external CSS or JS dependencies) for offline use.
