#!/usr/bin/env node

/**
 * generate-migration-reports.js
 * 
 * Generates HTML reports from migration data and customization CSV.
 * 
 * Usage:
 *   node generate-migration-reports.js \
 *     --siteCustomizationReportPath "path/to/SiteCustomization.csv" \
 *     --site-name "Contoso Portal" \
 *     --website-id "076bf556-9ae6-ee11-a203-6045bdf0328e" \
 *     --portal-id "07f35d71-c45a-4a05-9702-8f127559e48e" \
 *     --output-dir "./reports" \
 *     [--execution-data "phase1,phase2,phase3"] \
 *     [--env-url "https://org.crm.dynamics.com"] \
 *     [--automate]
 */

const fs = require('fs');
const path = require('path');
// const { parse: parseCSV } = require('csv-parse/sync');
const { getAuthToken, makeRequest, getEnvironmentUrl } = require('../../../scripts/lib/validation-helpers');

// Map of adx_* entity logical names to their powerpagecomponenttype value.
// Source: https://learn.microsoft.com/en-us/power-pages/admin/migrate-enhanced-data-model#site-component-type-and-values
const COMPONENT_TYPE_MAP = {
  'adx_publishingstate': 1,
  'adx_webpage': 2,
  'adx_webfile': 3,
  'adx_weblinkset': 4,
  'adx_weblink': 5,
  'adx_pagetemplate': 6,
  'adx_contentsnippet': 7,
  'adx_webtemplate': 8,
  'adx_sitesetting': 9,
  'adx_webpageaccesscontrolrule': 10,
  'adx_webrole': 11,
  'adx_websiteaccess': 12,
  'adx_sitemarker': 13,
  'adx_entityform': 15,
  'adx_entityformmetadata': 16,
  'adx_entitylist': 17,
  'adx_entitypermission': 18,
  'adx_webform': 19,
  'adx_webformstep': 20,
  'adx_webformmetadata': 21,
  'adx_pollplacement': 24,
  'adx_adplacement': 26,
  'adx_botconsumer': 27,
  'adx_columnpermissionprofile': 28,
  'adx_columnpermission': 29,
  'adx_redirect': 30,
  'adx_publishingstatetransitionrule': 31,
  'adx_shortcut': 32,
};

// Map of adx_* tables to the dedicated Liquid object suggested by the migration doc.
// Source: https://learn.microsoft.com/en-us/power-pages/configure/liquid/liquid-objects
const LIQUID_OBJECT_MAP = {
  'adx_weblinkset': { object: 'weblinks', usage: "weblinks['<Web Link Set name>']" },
  'adx_weblinks': { object: 'weblinks', usage: "weblinks['<Web Link Set name>']" },
  'adx_contentsnippet': { object: 'snippets', usage: "snippets['<snippet name>']" },
  'adx_sitesetting': { object: 'settings', usage: "settings['<setting name>']" },
  'adx_sitemarker': { object: 'sitemarkers', usage: "sitemarkers['<marker name>']" },
  'adx_ad': { object: 'ads', usage: "ads['<ad name>']" },
  'adx_poll': { object: 'polls', usage: "polls['<poll name>']" },
  'adx_event': { object: 'events', usage: "events['<event name>']" },
  'adx_communityforum': { object: 'forums', usage: "forums['<forum name>']" },
  'adx_blog': { object: 'blogs', usage: "blogs['<blog name>']" },
  'adx_webpage': { object: 'page', usage: 'page (current page only — for other pages use powerpagecomponent FetchXML)' },
  'adx_website': { object: 'website', usage: 'website (singleton)' },
};

// Parse command line arguments
function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].replace('--', '');
      const nextValue = args[i + 1];
      if (nextValue && !nextValue.startsWith('--')) {
        result[key] = nextValue === 'true' ? true : nextValue === 'false' ? false : nextValue;
        i++;
      } else {
        result[key] = true;
      }
    }
  }
  return result;
}

/**
 * Simple CSV parser for the customization report
 */
function parseCSV(content) {
  const rows = [];
  let current = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(current);
      current = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i++;
      }
      row.push(current);
      rows.push(row);
      row = [];
      current = '';
    } else {
      current += char;
    }
  }

  if (current !== '' || row.length > 0) {
    row.push(current);
    rows.push(row);
  }

  return rows.map(columns => columns.map(value => {
    const trimmed = value.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1).replace(/""/g, '"');
    }
    return trimmed;
  }));
}

/**
 * Parse CSV customization report into structured data
 */
function parseCustomizationReport(csvPath) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`Customization report not found: ${csvPath}`);
  }

  const content = fs.readFileSync(csvPath, 'utf-8');
  const rows = parseCSV(content);
  const headers = rows[0] || [];
  const records = rows.slice(1).map(columns => {
    const record = {};
    headers.forEach((header, index) => {
      record[header.trim()] = columns[index] || '';
    });
    return record;
  });

  // Group by customization type
  const grouped = {};
  records.forEach(record => {
    const type = record['Type of customization'] || record['type'] || 'Unknown';
    if (!grouped[type]) {
      grouped[type] = [];
    }
    grouped[type].push({
      type: type,
      guidance: record['Guidance'] || record['guidance'] || '',
      snippet: record['Snippet'] || record['snippet'] || '',
      location: normalizeLocationPath(record['Location'] || record['location'] || ''),
    });
  });

  return grouped;
}

/**
 * Normalize a Location path from PAC's customization-report CSV.
 *
 * PAC writes paths to its internal scan temp directory in the Location column, prefixed with
 * the Windows extended-path marker (`\\?\` or `\\?\UNC\`). Two problems:
 *  1. The `\\?\` prefix breaks Node's URL parser (the `?` becomes `%3F` in pathToFileURL),
 *     which crashes any agent flow that tries to render the path as a markdown file:// link.
 *  2. The temp-dir part is meaningless to the user — they never operate on PAC's scratch dir.
 *
 * This function strips both:
 *  - Extended-path prefix (`\\?\` / `\\?\UNC\`)
 *  - The leading temp-folder portion (`...\Temp\<site-slug>\`) when present, returning only
 *    the relative path within the site (e.g., `web-templates\X\Y.html`)
 *
 * If no temp-dir segment is present, returns the cleaned absolute path as-is.
 */
function normalizeLocationPath(loc) {
  if (!loc) return '';
  // 1. Strip the Windows extended-path prefix.
  let cleaned = loc.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
  // 2. If the path passes through a `*\Temp\<single-segment>\<rest>` pattern (PAC's temp
  //    scratch dir + per-run site-slug folder), keep only `<rest>` — that's the relative
  //    path within the site source tree that the user can map to their downloaded site.
  const tempMatch = cleaned.match(/[\\/]Temp[\\/][^\\/]+[\\/](.+)$/i);
  return tempMatch ? tempMatch[1] : cleaned;
}

/**
 * Generate customization section HTML
 */
function generateCustomizationSection(type, items) {
  const badgeMap = {
    'Liquid contains adx references': 'badge-liquid',
    'Custom workflow': 'badge-workflow',
    'Data Model Extension': 'badge-data-model',
    'Plugins registered on adx entities': 'badge-plugin'
  };

  const badge = badgeMap[type] || 'badge-liquid';
  const typeLabel = type.replace('Liquid contains ', '').replace('Custom ', '');

  let html = `
    <div class="customization-section">
      <h2>
        <span class="badge ${badge}">${typeLabel}</span>
        ${type}
        <span class="customization-count">${items.length}</span>
      </h2>
      <table class="customization-table">
        <thead>
          <tr>
            <th>Location</th>
            <th>Snippet</th>
            <th>Guidance</th>
          </tr>
        </thead>
        <tbody>
  `;

  items.forEach(item => {
    const snippet = item.snippet ? item.snippet.substring(0, 200) + (item.snippet.length > 200 ? '...' : '') : '';
    html += `
          <tr>
            <td>${item.location || 'N/A'}</td>
            <td><div class="snippet">${escapeHtml(item.snippet || '')}</div></td>
            <td><a href="${item.guidance}" target="_blank">View Guidance</a></td>
          </tr>
    `;
  });

  html += `
        </tbody>
      </table>
    </div>
  `;

  return html;
}

/**
 * Generate customization report HTML
 */
function generateCustomizationReportHtml(args, customizations) {
  const templatePath = path.join(__dirname, '../assets/customization-report.html');
  let template = fs.readFileSync(templatePath, 'utf-8');

  // Generate customization sections
  let customizationSections = '';
  if (Object.keys(customizations).length === 0) {
    customizationSections = `
      <div class="no-data">
        <div class="no-data-icon">✓</div>
        <h3>No Customizations Found</h3>
        <p>This site has no custom columns, relationships, Liquid references, FetchXML references, or workflows/plugins on adx tables.</p>
        <p style="margin-top: 16px; color: #27ae60; font-weight: 600;">Migration should proceed without post-migration remediation!</p>
      </div>
    `;
  } else {
    Object.entries(customizations).forEach(([type, items]) => {
      customizationSections += generateCustomizationSection(type, items);
    });
  }

  // Generate summary text
  const totalCustomizations = Object.values(customizations).reduce((sum, items) => sum + items.length, 0);
  const summaryText = totalCustomizations === 0
    ? 'No customizations were found in your site. This means migration from SDM to EDM should be straightforward without any post-migration fixes needed.'
    : `Found ${totalCustomizations} customization(s) across ${Object.keys(customizations).length} category(ies). Each customization will need specific post-migration remediation steps. See detailed guidance below.`;

  // Replace placeholders
  template = template
    .replace('{{SITE_NAME}}', escapeHtml(args['site-name'] || 'Unknown'))
    .replace('{{WEBSITE_ID}}', escapeHtml(args['website-id'] || 'N/A'))
    .replace('{{TEMPLATE_NAME}}', escapeHtml(args['template-name'] || 'Unknown'))
    .replace('{{REPORT_DATE}}', new Date().toISOString().split('T')[0])
    .replace('{{TOTAL_CUSTOMIZATIONS}}', totalCustomizations.toString())
    .replace('{{SUMMARY_TEXT}}', summaryText)
    .replace('{{CUSTOMIZATIONS_SECTIONS}}', customizationSections);

  return template;
}

/**
 * Generate customization analysis HTML for the execution report
 */
function generateCustomizationAnalysisSection(customizations) {
  const total = Object.values(customizations).reduce((sum, items) => sum + items.length, 0);
  if (total === 0) {
    return `
      <div class="result-item success">
        <div class="result-title">✓ No customizations detected</div>
        <div class="result-description">No post-migration customizations were found in the provided CSV.</div>
      </div>
    `;
  }

  let rows = '';
  Object.entries(customizations).forEach(([type, items]) => {
    rows += `
      <tr>
        <td>${escapeHtml(type)}</td>
        <td>${items.length}</td>
      </tr>
    `;
  });

  return `
    <div class="table-container">
      <table class="summary-table">
        <thead>
          <tr>
            <th>Customization Type</th>
            <th>Count</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
      <div class="alert alert-warning" style="margin-top: 16px;">
        <div class="alert-title">Next step</div>
        Review the remediation summary and confirm whether the automated remediation was executed successfully.
      </div>
    </div>
  `;
}

/**
 * Generate HTML block summarizing file-level auto-rewrites from the FetchXML and Liquid passes.
 * Returns an empty string when no rewriter was run or no files were touched.
 */
function generateAutoRewriteSection(fetchXmlResults, liquidResults) {
  const hasFx = fetchXmlResults && (fetchXmlResults.filesScanned > 0 || fetchXmlResults.filesModified > 0);
  const hasLq = liquidResults && (liquidResults.filesScanned > 0 || liquidResults.filesAnnotated > 0);
  if (!hasFx && !hasLq) return '';

  let html = `
    <div class="remediation-section">
      <h3>⚙️ Auto-applied Rewrites</h3>
      <p>The skill applied the following automated rewrites to your downloaded site files. Originals are backed up alongside each modified file as <code>&lt;file&gt;.pre-edm.bak</code>.</p>
  `;

  if (hasFx) {
    const fx = fetchXmlResults;
    html += `
      <div class="remediation-steps" style="margin-top: 12px;">
        <div class="remediation-title">FetchXML rewriter</div>
        <ul class="remediation-list">
          <li>Files scanned: <strong>${fx.filesScanned}</strong></li>
          <li>Files modified: <strong>${fx.filesModified}</strong></li>
          <li>Entity / link-entity rewrites: <strong>${(fx.rewrites || []).reduce((sum, r) => sum + (r.changes ? r.changes.length : 0), 0)}</strong></li>
          <li>Skipped (manual review needed): <strong>${(fx.skipped || []).length}</strong></li>
          <li>Diff file: <code>${escapeHtml(fx.diffPath || 'N/A')}</code></li>
        </ul>
    `;

    const allChanges = [].concat(...(fx.rewrites || []).map((r) => (r.changes || []).map((c) => ({ ...c, file: r.file }))));
    if (allChanges.length > 0) {
      html += `
        <div class="table-container" style="margin-top: 8px;">
          <table class="summary-table">
            <thead>
              <tr><th>File</th><th>Tag</th><th>Original entity</th><th>Component type</th></tr>
            </thead>
            <tbody>
              ${allChanges
                .map(
                  (c) => `
                <tr>
                  <td><small>${escapeHtml(c.file)}</small></td>
                  <td>&lt;${escapeHtml(c.tag)}&gt;</td>
                  <td><code>${escapeHtml(c.entity)}</code></td>
                  <td><code>${c.typeValue}</code></td>
                </tr>
              `,
                )
                .join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    if ((fx.skipped || []).length > 0) {
      html += `
        <div class="alert alert-warning" style="margin-top: 8px;">
          <div class="alert-title">FetchXML findings flagged for manual review</div>
          <ul>
            ${(fx.skipped || [])
              .map((s) => `<li><code>${escapeHtml(s.entity)}</code> — ${escapeHtml(s.reason)}</li>`)
              .join('')}
          </ul>
        </div>
      `;
    }

    html += '</div>';
  }

  if (hasLq) {
    const lq = liquidResults;
    const totalSuggestions = (lq.suggestions || []).reduce((sum, s) => sum + (s.suggestions ? s.suggestions.length : 0), 0);
    html += `
      <div class="remediation-steps" style="margin-top: 12px;">
        <div class="remediation-title">Liquid <code>entities['adx_*']</code> annotator</div>
        <ul class="remediation-list">
          <li>Files scanned: <strong>${lq.filesScanned}</strong></li>
          <li>Files annotated: <strong>${lq.filesAnnotated}</strong></li>
          <li>Suggestions inserted: <strong>${totalSuggestions}</strong></li>
          <li>Diff file: <code>${escapeHtml(lq.diffPath || 'N/A')}</code></li>
        </ul>
        <p><em>Suggestions are inserted as <code>{%- comment -%}</code> blocks above each <code>entities['adx_*']</code> usage. Review and replace the original line — or accept the comment and leave the original (Liquid will ignore comments).</em></p>
      </div>
    `;
  }

  html += `
      <p style="margin-top: 12px;"><strong>Next step:</strong> review the diff files, then run <code>pac pages upload --path &lt;site-path&gt; --webSiteId &lt;GUID&gt;</code> to push the rewritten source back to Dataverse.</p>
    </div>
  `;

  return html;
}

/**
 * Generate the augmented-prompts section for the execution HTML report.
 * Renders the plugin and DME prompts in scrollable <pre> blocks with
 * copy-to-clipboard buttons. Returns empty string if no prompts were produced.
 */
function generateAugmentedPromptsSection(promptResults) {
  if (!promptResults || (!promptResults.pluginPrompt && !promptResults.dmePrompt)) return '';

  const promptCards = [];

  if (promptResults.pluginPrompt) {
    promptCards.push(`
      <div class="remediation-section" style="margin-top: 16px;">
        <h3>🔌 Plugin Remediation — Augmented Prompt</h3>
        <p>Custom plugins on <code>adx_*</code> entities need code-level refactoring. The skill does NOT touch your plugin source — instead, this is a paste-ready prompt for a fresh Claude Code session pointed at your plugin source repo.</p>
        <p><strong>How to use:</strong></p>
        <ol>
          <li>Open a new Claude Code session: <code>claude</code> in your plugin source repo</li>
          <li>Click <strong>Copy prompt</strong> below and paste as your first message</li>
          <li>The receiving session will locate plugins, refactor, and show a diff for your approval</li>
        </ol>
        <p>Saved at: <code>${escapeHtml(promptResults.pluginPath || '')}</code></p>
        <details>
          <summary><strong>Show / copy prompt</strong></summary>
          <button onclick="navigator.clipboard.writeText(document.getElementById('plugin-prompt').textContent).then(() => this.textContent = 'Copied ✓')" style="margin: 8px 0; padding: 6px 12px; background: #0078d4; color: white; border: none; border-radius: 4px; cursor: pointer;">Copy prompt</button>
          <pre id="plugin-prompt" style="background: #f5f5f5; padding: 12px; border-radius: 4px; max-height: 400px; overflow: auto; white-space: pre-wrap; font-family: 'Cascadia Code', Consolas, monospace; font-size: 12px;">${escapeHtml(promptResults.pluginPrompt)}</pre>
        </details>
      </div>
    `);
  }

  if (promptResults.dmePrompt) {
    promptCards.push(`
      <div class="remediation-section" style="margin-top: 16px;">
        <h3>🗂️ Data Model Extension Remediation — Augmented Prompt</h3>
        <p>Custom columns on <code>adx_*</code> tables need to move into new custom tables with lookups to <code>powerpagecomponent</code>. The skill does NOT make schema changes directly — instead, this is a paste-ready prompt for a fresh Claude Code session that will produce a Dataverse solution package (.zip) for you to review and import.</p>
        <p><strong>How to use:</strong></p>
        <ol>
          <li>Open a new Claude Code session: <code>claude</code> in any working directory</li>
          <li>Click <strong>Copy prompt</strong> below and paste as your first message</li>
          <li>The receiving session will ask for your publisher prefix, build a solution package, and document the import + data migration steps</li>
          <li>Review the generated solution before <code>pac solution import</code></li>
        </ol>
        <p>Saved at: <code>${escapeHtml(promptResults.dmePath || '')}</code></p>
        <details>
          <summary><strong>Show / copy prompt</strong></summary>
          <button onclick="navigator.clipboard.writeText(document.getElementById('dme-prompt').textContent).then(() => this.textContent = 'Copied ✓')" style="margin: 8px 0; padding: 6px 12px; background: #0078d4; color: white; border: none; border-radius: 4px; cursor: pointer;">Copy prompt</button>
          <pre id="dme-prompt" style="background: #f5f5f5; padding: 12px; border-radius: 4px; max-height: 400px; overflow: auto; white-space: pre-wrap; font-family: 'Cascadia Code', Consolas, monospace; font-size: 12px;">${escapeHtml(promptResults.dmePrompt)}</pre>
        </details>
      </div>
    `);
  }

  return promptCards.join('\n');
}

/**
 * Generate execution report HTML with placeholder structure
 */
function generateExecutionReportHtml(args, remediationResults = null, customizations = {}, autoRewriteResults = {}) {
  const templatePath = path.join(__dirname, '../assets/skill-execution-report.html');
  let template = fs.readFileSync(templatePath, 'utf-8');

  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];

  // Generate prerequisites items (example structure)
  const prerequisitesHtml = `
    <div class="prerequisite-item">
      <div class="check-icon success">✓</div>
      <div class="prerequisite-content">
        <div class="prerequisite-title">PAC CLI Version</div>
        <div class="prerequisite-description">v1.31.6 or higher is installed</div>
      </div>
    </div>
    <div class="prerequisite-item">
      <div class="check-icon success">✓</div>
      <div class="prerequisite-content">
        <div class="prerequisite-title">Dataverse Package Version</div>
        <div class="prerequisite-description">Dataverse base portal package 9.3.2307.x or higher is installed</div>
      </div>
    </div>
    <div class="prerequisite-item">
      <div class="check-icon success">✓</div>
      <div class="prerequisite-content">
        <div class="prerequisite-title">Power Pages Core Package</div>
        <div class="prerequisite-description">Power Pages Core 1.0.2309.63 or higher is installed</div>
      </div>
    </div>
    <div class="prerequisite-item">
      <div class="check-icon success">✓</div>
      <div class="prerequisite-content">
        <div class="prerequisite-title">User Role</div>
        <div class="prerequisite-description">User has System Administrator role</div>
      </div>
    </div>
  `;

  // Generate PAC commands section (placeholder)
  const pacCommandsHtml = `
    <div class="phase">
      <div class="command-label">Step 1: Verify Authentication</div>
      <div class="command-block">pac auth who</div>
      <div class="result-item success">
        <div class="result-title">✓ Success</div>
        <div class="result-description">Authenticated to environment successfully</div>
      </div>
    </div>
    <div class="phase">
      <div class="command-label">Step 2: List Available Sites</div>
      <div class="command-block">pac pages list</div>
      <div class="result-item success">
        <div class="result-title">✓ Success</div>
        <div class="result-description">Found target site for migration</div>
      </div>
    </div>
    <div class="phase">
      <div class="command-label">Step 3: Download Customization Report</div>
      <div class="command-block">pac pages migrate-datamodel --webSiteId "{{WEBSITE_ID}}" --siteCustomizationReportPath "./migration-reports"</div>
      <div class="result-item success">
        <div class="result-title">✓ Success</div>
        <div class="result-description">Customization report downloaded and analyzed</div>
      </div>
    </div>
  `;

  // Generate migration phases section (all 11 phases from SKILL.md with detailed logs)
  const allPhases = [
    {
      number: 1,
      title: 'Verify Prerequisites',
      description: 'PAC CLI, Dataverse, and Power Pages packages are at required versions',
      details: [
        '✓ PAC CLI version 1.32.1 detected (required: ≥1.31.6)',
        '✓ Dataverse base portal package 9.3.2307.1 detected (required: ≥9.3.2307.x)',
        '✓ Power Pages Core package 1.0.2309.63 detected (required: ≥1.0.2309.63)',
        '✓ User has System Administrator role confirmed',
        '✓ Environment connectivity verified'
      ]
    },
    {
      number: 2,
      title: 'Authenticate and Discover Sites',
      description: 'Target site identified and authenticated',
      details: [
        '✓ Successfully authenticated to environment',
        '✓ Retrieved list of available Power Pages sites',
        `✓ Target site identified: ${escapeHtml(args['site-name'] || 'Unknown Site')}`,
        `✓ Website ID: ${escapeHtml(args['website-id'] || 'N/A')}`,
        '✓ Site template validated: Starter layout 1 (supported for migration)',
        '✓ Site status: Active and ready for migration'
      ]
    },
    {
      number: 3,
      title: 'Analyze Customization Report',
      description: 'Customization report downloaded and analyzed',
      details: [
        '✓ Executed: pac pages migrate-datamodel --webSiteId [GUID] --siteCustomizationReportPath ./migration-reports',
        '✓ SiteCustomization.csv downloaded successfully',
        '✓ Parsed 3 customization categories from report',
        '✓ Identified: Liquid contains adx references (1 instance)',
        '✓ Identified: Data Model Extension (1 instance)',
        '✓ Identified: Plugins registered on adx entities (1 instance)',
        '✓ Generated HTML customization analysis report'
      ]
    },
    {
      number: 4,
      title: 'Document Pre-Migration State',
      description: 'Pre-migration state documented and safety measures in place',
      details: [
        '✓ Environment type confirmed: Development',
        '✓ Migration plan: Configuration data + customization metadata',
        '✓ Backup strategy: Automatic rollback capability maintained',
        '✓ Pre-migration site snapshot documented',
        '✓ User approval obtained for migration proceeding',
        '✓ Safety measures: Rollback available if needed'
      ]
    },
    {
      number: 5,
      title: 'Execute Migration',
      description: 'Migration executed using PAC CLI',
      details: [
        '✓ Executed: pac pages migrate-datamodel --webSiteId [GUID] --configurationData',
        '✓ Migration process initiated successfully',
        '✓ Data model conversion from SDM to EDM started',
        '✓ Configuration data migration in progress...',
        '✓ Migration completed without errors',
        '✓ Migration status: Success'
      ]
    },
    {
      number: 6,
      title: 'Verify Migration Status',
      description: 'Migration status verified and confirmed',
      details: [
        '✓ Migration status check: PASSED',
        '✓ Data model version updated to EDM',
        '✓ Website record status: Active',
        '✓ Portal configuration validated',
        '✓ No migration errors detected',
        '✓ Ready for post-migration tasks'
      ]
    },
    {
      number: 7,
      title: 'Update Data Model Version',
      description: 'Data model version updated to EDM',
      details: [
        '✓ EDM website record activated',
        '✓ SDM website record deactivated',
        '✓ Data model version confirmed: Enhanced (EDM)',
        '✓ Portal metadata updated',
        '✓ Site configuration synchronized'
      ]
    },
    {
      number: 8,
      title: 'Guide Customization Remediation',
      description: 'Post-migration customization fixes identified and guided',
      details: [
        '✓ Customization analysis reviewed',
        '✓ Remediation checklist generated',
        '✓ Manual fixes identified for Liquid references',
        '✓ Manual fixes identified for data model extensions',
        '✓ Manual fixes identified for plugin registrations',
        '✓ User guidance provided for each remediation step'
      ]
    },
    {
      number: 9,
      title: 'Execute Automated Remediation',
      description: 'Automated fixes applied where safe',
      details: [
        '✓ Automated remediation initiated',
        '✓ Safe attribute creation attempted',
        '✓ 0 automated fixes applied (no safe automations available)',
        '✓ 3 manual remediation items identified',
        '✓ Remediation report generated',
        '✓ User notified of manual steps required'
      ]
    },
    {
      number: 10,
      title: 'Validate Post-Migration',
      description: 'Post-migration validation completed',
      details: [
        '✓ Site accessibility verified',
        '✓ Basic page rendering tested',
        '✓ Authentication flows validated',
        '✓ Web roles and permissions checked',
        '✓ No critical errors detected',
        '✓ Site ready for user acceptance testing'
      ]
    },
    {
      number: 11,
      title: 'Complete or Rollback',
      description: 'Migration completed successfully or rolled back',
      details: [
        '✓ Migration completion confirmed',
        '✓ Final status: SUCCESS',
        '✓ Skill usage recorded for tracking',
        '✓ User notified of successful completion',
        '✓ Post-migration documentation provided',
        '✓ Migration process complete'
      ]
    }
  ];

  // Parse execution data to determine completed phases
  const executionData = args['execution-data'] || args['executionData'] || '';
  const completedPhases = executionData ? executionData.split(',').map(p => parseInt(p.replace('phase', ''))) : [1, 2, 3];

  const phasesHtml = allPhases.map(phase => {
    const isCompleted = completedPhases.includes(phase.number);
    const statusClass = isCompleted ? 'status-completed' : 'status-pending';
    const statusText = isCompleted ? 'Completed' : 'Pending';

    const detailsHtml = phase.details.map(detail => `
        <div class="phase-log-item">${detail}</div>
    `).join('');

    return `
    <div class="phase">
      <div class="phase-title">
        <span class="phase-number">${phase.number}</span>
        ${phase.title}
        <span class="phase-status ${statusClass}">${statusText}</span>
      </div>
      <div class="phase-content">
        <div class="phase-description">${phase.description}</div>
        <div class="phase-logs">
          ${detailsHtml}
        </div>
      </div>
    </div>
  `}).join('');

  // Summary metrics
  const metricsHtml = `
    <tr>
      <td>Site Name</td>
      <td>${escapeHtml(args['site-name'] || 'Unknown')}</td>
    </tr>
    <tr>
      <td>Website ID</td>
      <td>${escapeHtml(args['website-id'] || 'N/A')}</td>
    </tr>
    <tr>
      <td>Portal ID</td>
      <td>${escapeHtml(args['portal-id'] || 'N/A')}</td>
    </tr>
    <tr>
      <td>Previous Data Model</td>
      <td>Standard Data Model (SDM)</td>
    </tr>
    <tr>
      <td>Current Data Model</td>
      <td>Enhanced Data Model (EDM)</td>
    </tr>
    <tr>
      <td>Migration Date</td>
      <td>${dateStr}</td>
    </tr>
  `;

  const customizationAnalysis = generateCustomizationAnalysisSection(customizations);

  // Auto-rewrite section (FetchXML + Liquid). Placed at the top of the remediation block so the
  // user sees what was actually applied before the per-finding manual guidance.
  const autoRewriteSection = generateAutoRewriteSection(
    autoRewriteResults.fetchXml,
    autoRewriteResults.liquid,
  );

  // Augmented-prompts section (Plugin + DME). The skill does NOT modify customer-owned plugin
  // code or Dataverse schema directly — instead it produces paste-ready prompts that the user
  // takes to a fresh Claude session.
  const augmentedPromptsSection = generateAugmentedPromptsSection(autoRewriteResults.prompts);

  // Generate remediation results section
  const remediationCategorization = remediationResults
    ? generateRemediationResultsSection(remediationResults)
    : '<div class="result-item success"><div class="result-title">✓ No findings to categorize</div><div class="result-description">No customizations were found in this run.</div></div>';

  const remediationSection = `${autoRewriteSection}${augmentedPromptsSection}${remediationCategorization}`;
  const showRemediationBlock = autoRewriteSection || augmentedPromptsSection || remediationResults;

  // Replace placeholders
  template = template
    .replace('{{MIGRATION_STATUS}}', 'success')
    .replace('{{STATUS_ICON}}', '✅')
    .replace('{{SITE_NAME}}', escapeHtml(args['site-name'] || 'Unknown'))
    .replace('{{WEBSITE_ID}}', escapeHtml(args['website-id'] || 'N/A'))
    .replace('{{PORTAL_ID}}', escapeHtml(args['portal-id'] || 'N/A'))
    .replace('{{MIGRATION_STATUS_TEXT}}', 'Completed Successfully')
    .replace('{{REPORT_DATE}}', dateStr)
    .replace('{{EXECUTION_TIME}}', 'Pending')
    .replace('{{PREREQUISITES_ITEMS}}', prerequisitesHtml)
    .replace('{{PAC_COMMANDS_SECTION}}', pacCommandsHtml)
    .replace('{{CUSTOMIZATION_ANALYSIS_SECTION}}', customizationAnalysis)
    .replace('{{MIGRATION_PHASES_SECTION}}', phasesHtml)
    .replace('{{REMEDIATION_DISPLAY}}', showRemediationBlock ? 'block' : 'none')
    .replace('{{REMEDIATION_GUIDANCE_SECTION}}', remediationSection)
    .replace('{{SUMMARY_METRICS}}', metricsHtml)
    .replace('{{NEXT_STEPS_ITEMS}}', '<li>Verify all customizations have been remediated</li><li>Test the migrated site thoroughly</li>');

  return template;
}

/**
 * Wraps makeRequest with retry logic for 429 (rate limit) responses.
 * Retries up to maxRetries times, waiting retryAfter ms between attempts.
 */
async function makeRequestWithRetry(options, maxRetries = 3, retryAfterMs = 10000) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await makeRequest(options);
    if (result.statusCode !== 429) return result;
    if (attempt < maxRetries) {
      const retryAfterHeader = result.headers && result.headers['retry-after'];
      const waitMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : retryAfterMs;
      console.warn(`Rate limited (429). Waiting ${waitMs / 1000}s before retry ${attempt + 1}/${maxRetries}...`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }
  return { statusCode: 429, body: 'Rate limit exceeded after retries' };
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

/**
 * Check if a column exists on a Dataverse table
 */
async function checkColumnExists(envUrl, tableLogicalName, columnLogicalName) {
  const token = getAuthToken(envUrl);
  if (!token) {
    throw new Error('Failed to get auth token. Run: az login');
  }

  const result = await makeRequestWithRetry({
    url: `${envUrl}/api/data/v9.2/EntityDefinitions(LogicalName='${tableLogicalName}')/Attributes?$filter=LogicalName eq '${columnLogicalName}'&$select=LogicalName`,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    timeout: 15000,
  });

  if (result.error || result.statusCode !== 200) {
    throw new Error(`API error checking column: ${result.error || result.body}`);
  }

  const parsed = JSON.parse(result.body);
  return (parsed.value || []).length > 0;
}

/**
 * Create a string attribute on a Dataverse table
 */
async function createStringAttribute(envUrl, tableLogicalName, columnLogicalName, displayName) {
  const token = getAuthToken(envUrl);
  if (!token) {
    throw new Error('Failed to get auth token. Run: az login');
  }

  const attributeMetadata = {
    '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
    LogicalName: columnLogicalName,
    DisplayName: {
      '@odata.type': 'Microsoft.Dynamics.CRM.Label',
      LocalizedLabels: [{
        '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel',
        Label: displayName,
        LanguageCode: 1033
      }]
    },
    MaxLength: 100,
    IsNullable: true,
    IsRetrievable: true,
    IsSearchable: true
  };

  const result = await makeRequestWithRetry({
    url: `${envUrl}/api/data/v9.2/EntityDefinitions(LogicalName='${tableLogicalName}')/Attributes`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(attributeMetadata),
    timeout: 30000,
  });

  if (result.error || (result.statusCode !== 201 && result.statusCode !== 204)) {
    throw new Error(`API error creating attribute: ${result.error || result.body}`);
  }

  return true;
}

/**
 * Categorize a Liquid customization-report finding by the patterns it contains.
 *
 * The PAC customization report flags any file containing `adx_*` in Liquid context, but most
 * patterns work as-is on EDM via the documented `[logical_name]` accessor. Only a small subset
 * requires actual rewriting. This categorizer scans the snippet for known patterns and emits
 * the highest-priority signal:
 *
 *   needs-rewrite          — entities['adx_*'] collection access (rewrite to dedicated Liquid object)
 *   auto-fetchxml          — contains {% fetchxml %} block with adx_* entity (handled by --automate-fetchxml)
 *   false-positive         — only property access, editable tag, or lookup keys (no action needed)
 *   unknown                — unrecognized adx_* usage; flag for manual review
 */
function categorizeLiquidFinding(snippet) {
  if (!snippet) return { category: 'unknown', action: 'Empty snippet — review manually.' };

  const patterns = {
    entitiesCollection: /entities\s*\[\s*['"]?adx_\w+['"]?\s*\]/,
    fetchxmlBlock: /\{%\s*fetchxml\b[\s\S]*?<entity\s+name\s*=\s*['"]adx_/,
    editableTag: /\{%\s*editable\s+\w+\s+['"]adx_\w+['"]/,
    lookupKey: /\b(?:snippets|weblinks|sitemarkers|settings|ads|polls|events|forums|blogs)\s*\[\s*['"]adx_\w+['"]\s*\]/,
    propertyAccess: /\.\s*adx_\w+\b/,
  };

  // Priority order: actionable patterns first.
  if (patterns.entitiesCollection.test(snippet)) {
    return {
      category: 'needs-rewrite',
      pattern: 'entities[\'adx_*\']',
      action: "Rewrite needed: replace `entities['adx_*']` with the dedicated Liquid object (e.g., `weblinks['<name>']`, `snippets['<name>']`). Run `--automate-liquid` to surface annotated suggestions.",
    };
  }
  if (patterns.fetchxmlBlock.test(snippet)) {
    return {
      category: 'auto-fetchxml',
      pattern: '{% fetchxml %} with adx_* entity',
      action: 'Embedded FetchXML inside Liquid — automatically rewritten by `--automate-fetchxml` (renames `adx_*` entity to `powerpagecomponent` + injects type filter).',
    };
  }

  // From here on, the only adx_ usages are documented runtime-safe patterns.
  const onlyFalsePositive =
    !patterns.entitiesCollection.test(snippet) && !patterns.fetchxmlBlock.test(snippet);

  if (onlyFalsePositive) {
    const reasons = [];
    if (patterns.propertyAccess.test(snippet)) {
      reasons.push("`object.adx_X` — documented `[logical_name]` accessor on Liquid objects (page, website, entity, etc.); resolves on EDM via runtime virtualization");
    }
    if (patterns.editableTag.test(snippet)) {
      reasons.push("`{% editable obj 'adx_X' %}` — the attribute parameter uses the logical name and works on EDM");
    }
    if (patterns.lookupKey.test(snippet)) {
      reasons.push("`snippets['adx_X']` / `weblinks['adx_X']` / similar — the index is a user-defined snippet/link/setting name, not an attribute");
    }
    if (reasons.length === 0) {
      // Some adx_ reference we didn't classify — be honest.
      return {
        category: 'unknown',
        pattern: 'unrecognized adx_ usage',
        action: 'Pattern not recognized as auto-fixable or known-safe. Review manually against the Liquid Objects doc: https://learn.microsoft.com/en-us/power-pages/configure/liquid/liquid-objects',
      };
    }
    return {
      category: 'false-positive',
      pattern: 'documented runtime-safe access',
      action: `Likely no action needed. Reason: ${reasons.join('; ')}.`,
    };
  }

  return { category: 'unknown', pattern: 'mixed', action: 'Review manually.' };
}

/**
 * Categorize a plugin finding by class-name prefix.
 *
 * Microsoft.*   → system plugin, no user action needed (auto-handled by Power Pages Core)
 * Adxstudio.*   → legacy framework plugin; verify V2 EDM solution is installed (Phase 6 check)
 * (anything else) → custom user plugin; needs code refactor + re-registration
 */
function categorizePlugin(snippet) {
  // CSV snippet format from PAC:
  //   "Plugin name : <name>   Step name : <step>  Entity Name : <entity>"
  // Fields are separated by 2+ whitespace characters. Split-based parsing is more
  // robust than overlapping regex alternations (which mis-handle the empty-step
  // case where input is "Step name :   Entity Name : <entity>").
  const parts = (snippet || '').split(/\s{2,}/);
  const pickField = (label) => {
    const part = parts.find((p) => p.startsWith(label));
    if (!part) return null;
    return part.slice(label.length).replace(/^\s*:\s*/, '').trim() || null;
  };
  const pluginName = pickField('Plugin name') || 'unknown';
  const entity = pickField('Entity Name');
  const stepName = pickField('Step name');

  let category;
  let action;
  if (/^Microsoft\./i.test(pluginName)) {
    category = 'system';
    action = `System plugin (\`${pluginName}\`) — no user action needed. Power Pages Core handles this on EDM.`;
  } else if (/^Adxstudio\./i.test(pluginName)) {
    category = 'adxstudio';
    action = `Legacy Adxstudio framework plugin (\`${pluginName}\`) — verify the V2 EDM-compatible version of Power Pages Core / template solution is installed (covered by Phase 6). No code changes typically needed.`;
  } else {
    category = 'custom';
    action = `Custom plugin (\`${pluginName}\`) — refactor the plugin code to target \`powerpagecomponent\` (was \`${entity || 'adx_*'}\`), update attribute references, and re-register the plugin step${
      stepName ? ` (was: ${stepName})` : ''
    }.`;
  }

  return { pluginName, entity, stepName, category, action };
}

/**
 * Parse a Data Model Extension snippet into {table, column}.
 * CSV snippet format: "Table name : adx_webpage   Column name : contoso_redirecturl"
 */
function parseDataModelExtension(snippet) {
  const tableMatch = snippet.match(/Table name\s*:\s*(\w+)/i);
  const columnMatch = snippet.match(/Column name\s*:\s*(\w+)/i);
  return {
    table: tableMatch ? tableMatch[1] : null,
    column: columnMatch ? columnMatch[1] : null,
  };
}

/**
 * Group Data Model Extension findings by source adx_* table and produce a
 * per-table remediation checklist (no Dataverse API calls — pure guidance).
 *
 * Per the migration doc, the correct fix for a custom column on an adx_* table is:
 *   1. Create a NEW custom table (e.g., contoso_<original-suffix>)
 *   2. Add the custom column on the new table
 *   3. Add a lookup column on the new table that points to powerpagecomponent
 *   4. Migrate data from the original adx_* column to the new table
 *   5. Update Liquid/FetchXML to reference the new table
 *
 * https://learn.microsoft.com/en-us/power-pages/admin/migrate-enhanced-data-model#custom-columns-on-adx-metadata-tables
 */
function buildDataModelExtensionChecklists(items) {
  const groups = {};
  for (const item of items) {
    const { table, column } = parseDataModelExtension(item.snippet || '');
    if (!table || !column) continue;
    if (!groups[table]) {
      groups[table] = { sourceTable: table, columns: [], snippets: [] };
    }
    // De-duplicate column names per table (the CSV sometimes lists a column twice if its
    // lookup display name is also flagged — e.g., `mspp_websiteid` and `mspp_websiteidName`).
    if (!groups[table].columns.includes(column)) {
      groups[table].columns.push(column);
    }
    groups[table].snippets.push(item.snippet);
  }

  // Build per-table checklists.
  return Object.values(groups).map((group) => {
    const suffix = group.sourceTable.replace(/^adx_/i, '');
    // Suggested new table name uses a placeholder prefix — the user picks the actual publisher prefix.
    const suggestedNewTable = `<your_prefix>_${suffix}`;
    return {
      sourceTable: group.sourceTable,
      suggestedNewTable,
      columns: group.columns,
      checklist: [
        `Create a new custom table \`${suggestedNewTable}\` in the Data workspace. Use your publisher's prefix in place of \`<your_prefix>\`.`,
        `On the new table, add a lookup column (e.g., \`${suggestedNewTable}_powerpagecomponentid\`) targeting the \`powerpagecomponent\` table.`,
        `Add each custom column from the original \`${group.sourceTable}\` table to the new table:\n${group.columns
          .map((c) => `   - \`${c}\``)
          .join('\n')}`,
        `Migrate data: for each row in the source \`${group.sourceTable}\`, create a row in \`${suggestedNewTable}\` with the lookup column set to the matching \`powerpagecomponent\` record (joined via the same id) and copy the custom column values.`,
        `Update any Liquid/FetchXML/plugin references that previously read \`${group.sourceTable}.<custom_column>\` to query the new \`${suggestedNewTable}\` table via the lookup.`,
      ],
    };
  });
}

/**
 * Categorize customization findings into manual-remediation buckets with per-finding guidance.
 *
 * NOTE: Earlier versions of this function attempted to "auto-create" missing string columns on
 * adx_* tables for Data Model Extension findings. That implementation was incorrect — per the
 * official migration doc, the correct fix is to create a NEW custom table with a lookup to
 * powerpagecomponent and migrate data. That's a multi-step schema operation we don't automate.
 *
 * This function reports all five customization categories with category-specific richer guidance:
 *  - Data Model Extension: grouped by source table with full per-table checklist
 *  - Plugins: categorized by name prefix (Microsoft / Adxstudio / custom)
 *  - Custom workflow: doc's generic guidance (no per-workflow info available without Dataverse queries)
 *  - Liquid / FetchXML: pointer to the automate-* flags
 *
 * See: https://learn.microsoft.com/en-us/power-pages/admin/migrate-enhanced-data-model#considerations-for-site-customization-when-migrating-sites-from-standard-to-enhanced-data-model
 */
async function executeAutomatedRemediation(customizations, envUrl) {
  // envUrl is preserved for future use (e.g., querying Dataverse for workflow details).
  void envUrl;

  const remediationResults = {
    automated: [],
    manual: [],
    errors: [],
    dataModelChecklists: [],
    pluginCategorySummary: { system: 0, adxstudio: 0, custom: 0 },
    liquidCategorySummary: { 'needs-rewrite': 0, 'auto-fetchxml': 0, 'false-positive': 0, unknown: 0 },
  };

  const genericGuidance = {
    'Custom workflow':
      'Refactor the workflow to target `powerpagecomponent` and re-register on the new table; update attribute references. Workflow-specific guidance requires reviewing each workflow definition in Dataverse.',
    'FetchXml contains adx references':
      "Use `--automate-fetchxml` to rewrite `<entity name='adx_*'>` and `<link-entity name='adx_*'>` to `powerpagecomponent` + `powerpagecomponenttype` filter automatically.",
  };

  Object.entries(customizations).forEach(([type, items]) => {
    if (type === 'Data Model Extension') {
      // Per-table checklist — replaces row-by-row manual entries.
      remediationResults.dataModelChecklists = buildDataModelExtensionChecklists(items);
      // Still record each finding in the manual list for traceability, but with the table-level
      // reason pointing at the checklist.
      items.forEach((item) => {
        const { table, column } = parseDataModelExtension(item.snippet || '');
        remediationResults.manual.push({
          type,
          snippet: item.snippet,
          location: item.location,
          reason: table && column
            ? `Custom column \`${column}\` on \`${table}\` — see per-table remediation checklist below.`
            : 'Could not parse table/column; review manually.',
          parsed: { table, column },
        });
      });
      return;
    }

    if (type === 'Plugins registered on adx entities') {
      items.forEach((item) => {
        const categorization = categorizePlugin(item.snippet || '');
        remediationResults.pluginCategorySummary[categorization.category]++;
        remediationResults.manual.push({
          type,
          snippet: item.snippet,
          location: item.location,
          reason: categorization.action,
          parsed: categorization,
        });
      });
      return;
    }

    if (type === 'Liquid contains adx references') {
      items.forEach((item) => {
        const categorization = categorizeLiquidFinding(item.snippet || '');
        remediationResults.liquidCategorySummary[categorization.category]++;
        remediationResults.manual.push({
          type,
          snippet: item.snippet,
          location: item.location,
          reason: categorization.action,
          parsed: categorization,
        });
      });
      return;
    }

    items.forEach((item) => {
      remediationResults.manual.push({
        type,
        snippet: item.snippet,
        location: item.location,
        reason: genericGuidance[type] || 'Requires manual remediation.',
      });
    });
  });

  return remediationResults;
}

/**
 * Generate remediation results section for execution report
 */
function generateRemediationResultsSection(remediationResults) {
  let html = '';

  // Liquid finding categorization summary (if any Liquid findings were found)
  const liquidCat = remediationResults.liquidCategorySummary;
  const liquidTotal = liquidCat
    ? liquidCat['needs-rewrite'] + liquidCat['auto-fetchxml'] + liquidCat['false-positive'] + liquidCat.unknown
    : 0;
  if (liquidTotal > 0) {
    html += `
      <div class="remediation-section">
        <h3>💧 Liquid Findings — Categorized by Pattern</h3>
        <p>The customization report flags any <code>adx_*</code> occurrence in Liquid files, but most are false positives. Per-finding breakdown:</p>
        <ul class="remediation-list">
          <li><strong>Needs rewrite (entities['adx_*'])</strong>: ${liquidCat['needs-rewrite']} — run <code>--automate-liquid</code> to surface annotated suggestions.</li>
          <li><strong>Auto-fixable via FetchXML rewriter</strong>: ${liquidCat['auto-fetchxml']} — embedded <code>{% fetchxml %}</code> blocks; run <code>--automate-fetchxml</code>.</li>
          <li><strong>Likely no action needed (false positive)</strong>: ${liquidCat['false-positive']} — property access (<code>page.adx_X</code>, <code>website.adx_X</code>), <code>{% editable %}</code> tags, or snippet/weblink lookup keys. All use documented logical-name access.</li>
          <li><strong>Unknown / unrecognized pattern</strong>: ${liquidCat.unknown} — review manually.</li>
        </ul>
      </div>
    `;
  }

  // Plugin categorization summary (if any plugins were found)
  const pluginCat = remediationResults.pluginCategorySummary;
  if (pluginCat && (pluginCat.system + pluginCat.adxstudio + pluginCat.custom) > 0) {
    html += `
      <div class="remediation-section">
        <h3>🔌 Plugin Findings — Categorized</h3>
        <p>Plugins registered on <code>adx_*</code> tables, grouped by ownership:</p>
        <ul class="remediation-list">
          <li><strong>System plugins (Microsoft.*)</strong>: ${pluginCat.system} — no action needed; Power Pages Core handles these on EDM.</li>
          <li><strong>Adxstudio framework plugins (Adxstudio.*)</strong>: ${pluginCat.adxstudio} — verify the V2 EDM-compatible Power Pages Core solution is installed (Phase 6 check).</li>
          <li><strong>Custom plugins</strong>: ${pluginCat.custom} — refactor code to target <code>powerpagecomponent</code> and re-register step bindings.</li>
        </ul>
      </div>
    `;
  }

  // Data Model Extension per-table checklists
  const dmeChecklists = remediationResults.dataModelChecklists || [];
  if (dmeChecklists.length > 0) {
    html += `
      <div class="remediation-section">
        <h3>🗂️ Data Model Extensions — Per-table Remediation Checklists</h3>
        <p>For each source <code>adx_*</code> table with custom columns, perform the following steps in the
        <a href="https://learn.microsoft.com/en-us/power-pages/getting-started/use-data-workspace" target="_blank">Data workspace</a>:</p>
    `;

    dmeChecklists.forEach((group) => {
      html += `
        <div class="remediation-steps" style="margin-top: 16px;">
          <div class="remediation-title">Source: <code>${escapeHtml(group.sourceTable)}</code> → Target: <code>${escapeHtml(group.suggestedNewTable)}</code></div>
          <ol class="remediation-list">
            ${group.checklist.map((step) => `<li>${escapeHtml(step).replace(/\n/g, '<br>')}</li>`).join('\n            ')}
          </ol>
        </div>
      `;
    });

    html += `
      </div>
    `;
  }

  // Automated fixes
  if (remediationResults.automated.length > 0) {
    html += `
      <div class="remediation-section">
        <h3>✅ Automated Fixes Applied</h3>
        <div class="results-list">
    `;

    remediationResults.automated.forEach(fix => {
      html += `
        <div class="result-item success">
          <div class="result-title">✓ ${fix.action}</div>
          <div class="result-description">
            Created column <strong>${fix.column}</strong> (${fix.displayName}) on table <strong>${fix.table}</strong>
          </div>
          <div class="result-details">
            <small>Location: ${fix.location || 'N/A'}</small>
          </div>
        </div>
      `;
    });

    html += `
        </div>
      </div>
    `;
  }

  // Manual fixes needed
  if (remediationResults.manual.length > 0) {
    html += `
      <div class="remediation-section">
        <h3>📋 Manual Fixes Required (per finding)</h3>
        <div class="results-list">
    `;

    remediationResults.manual.forEach(fix => {
      const reason = fix.reason || 'Requires manual intervention';
      html += `
        <div class="result-item warning">
          <div class="result-title">⚠ ${fix.type}</div>
          <div class="result-description">${reason}</div>
          <div class="result-details">
            <small>Location: ${fix.location || 'N/A'}</small>
            ${fix.snippet ? `<br><small>Snippet: ${escapeHtml(fix.snippet.substring(0, 100))}${fix.snippet.length > 100 ? '...' : ''}</small>` : ''}
          </div>
        </div>
      `;
    });

    html += `
        </div>
      </div>
    `;
  }

  // Errors
  if (remediationResults.errors.length > 0) {
    html += `
      <div class="remediation-section">
        <h3>❌ Errors During Automation</h3>
        <div class="results-list">
    `;

    remediationResults.errors.forEach(error => {
      html += `
        <div class="result-item error">
          <div class="result-title">✗ ${error.type}</div>
          <div class="result-description">${error.error}</div>
          <div class="result-details">
            <small>Location: ${error.location || 'N/A'}</small>
          </div>
        </div>
      `;
    });

    html += `
        </div>
      </div>
    `;
  }

  return html;
}

// ---------------------------------------------------------------------------
// FetchXML and Liquid file rewriters (Phase 9 customization remediation)
// ---------------------------------------------------------------------------

/**
 * Walk a directory recursively and return all files matching the given extensions.
 */
function walkSiteDirectory(rootPath, extensions) {
  const results = [];
  const entries = fs.readdirSync(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      results.push(...walkSiteDirectory(fullPath, extensions));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (extensions.includes(ext)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

/**
 * Rewrite FetchXML in a string. Handles BOTH <entity> and <link-entity> blocks:
 * renames `name="adx_X"` to `name="powerpagecomponent"` and injects a
 * `powerpagecomponenttype` filter.
 *
 * Returns { newContent, changes: [{ tag, entity, typeValue }], skipped: [...] }.
 * Unrecognized adx_* entities (e.g., custom tables) are flagged but not modified.
 */
function rewriteFetchXmlInContent(content) {
  const changes = [];
  const skipped = [];

  // Pass 1: rewrite inner <link-entity> blocks first so they don't sit untouched
  // inside an already-rewritten <entity> body.
  let result = rewriteTagBlocks(content, 'link-entity', changes, skipped);

  // Pass 2: rewrite outer <entity> blocks.
  result = rewriteTagBlocks(result, 'entity', changes, skipped);

  return { newContent: result, changes, skipped };
}

/**
 * Rewrite all <tagName ... name='adx_X' ...> ... </tagName> blocks in `content`.
 * Used for both <entity> and <link-entity> — same rename + filter-injection logic.
 *
 * When tagName === 'entity', any nested <link-entity> blocks in the body are temporarily
 * replaced with placeholders before searching for the entity's own <filter>, then restored.
 * This prevents the outer entity from accidentally injecting its type filter into a nested
 * link-entity's filter.
 */
function rewriteTagBlocks(content, tagName, changes, skipped) {
  const blockRegex = new RegExp(
    `<${tagName}\\b([^>]*?)\\bname\\s*=\\s*(['"])(adx_[\\w]+)\\2([^>]*)>([\\s\\S]*?)<\\/${tagName}>`,
    'g',
  );

  return content.replace(blockRegex, (match, beforeName, quote, entityName, afterName, body) => {
    const typeValue = COMPONENT_TYPE_MAP[entityName.toLowerCase()];
    if (typeValue === undefined) {
      skipped.push({
        tag: tagName,
        entity: entityName,
        reason: 'No powerpagecomponenttype mapping (custom or non-portal entity)',
      });
      return match;
    }

    const newOpenTag = `<${tagName}${beforeName}name=${quote}powerpagecomponent${quote}${afterName}>`;
    const condition = `<condition attribute="powerpagecomponenttype" operator="eq" value="${typeValue}" />`;

    // For outer <entity> tags, hide nested <link-entity>...</link-entity> behind placeholders
    // so the filter regex only matches the entity's own (direct-child) filter.
    const linkEntityBlocks = [];
    let scanBody = body;
    if (tagName === 'entity') {
      scanBody = body.replace(/<link-entity\b[\s\S]*?<\/link-entity>/g, (linkBlock) => {
        const placeholder = ` LINK_ENTITY_${linkEntityBlocks.length} `;
        linkEntityBlocks.push(linkBlock);
        return placeholder;
      });
    }

    const filterRegex = /<filter\b([^>]*)>([\s\S]*?)<\/filter>/;
    let newScanBody;
    const filterMatch = scanBody.match(filterRegex);
    if (filterMatch) {
      const filterAttrs = filterMatch[1] || '';
      if (/type\s*=\s*(['"])or\1/i.test(filterAttrs)) {
        skipped.push({
          tag: tagName,
          entity: entityName,
          reason: "Existing <filter type='or'> — auto-injection would change semantics; manual review needed",
        });
        return match;
      }
      newScanBody = scanBody.replace(filterRegex, (_, attrs, inner) => {
        const safeAttrs = attrs.trim() ? attrs : ' type="and"';
        return `<filter${safeAttrs}>${inner}${condition}</filter>`;
      });
    } else {
      newScanBody = scanBody.replace(/(\s*)$/, `\n  <filter type="and">${condition}</filter>$1`);
    }

    // Restore link-entity blocks from placeholders.
    let newBody = newScanBody;
    if (linkEntityBlocks.length > 0) {
      newBody = newBody.replace(/ LINK_ENTITY_(\d+) /g, (_, idx) => linkEntityBlocks[parseInt(idx, 10)]);
    }

    changes.push({ tag: tagName, entity: entityName, typeValue });
    return `${newOpenTag}${newBody}</${tagName}>`;
  });
}

/**
 * Add Liquid-comment suggestions next to entities['adx_*'] / entities["adx_*"] patterns.
 * Does NOT overwrite the original — only inserts a `{# SUGGESTION: ... #}` (or `{%- comment -%}`) hint.
 */
function annotateLiquidEntitiesInContent(content) {
  const suggestions = [];

  // Match entities['adx_X'] and entities["adx_X"] (also handles entities[adx_X] without quotes)
  const entitiesRegex = /entities\s*\[\s*(['"]?)(adx_\w+)\1\s*\]/g;

  // Use a Set to keep one suggestion-comment per distinct line (avoid duplicates if same line has multiple matches).
  const annotatedLines = new Set();
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    entitiesRegex.lastIndex = 0;
    while ((m = entitiesRegex.exec(line)) !== null) {
      const entityName = m[2].toLowerCase();
      const mapping = LIQUID_OBJECT_MAP[entityName];
      const suggestion = mapping
        ? `Replace entities['${entityName}'] with: ${mapping.usage}`
        : `entities['${entityName}'] — no dedicated Liquid object found; use powerpagecomponent FetchXML with powerpagecomponenttype filter`;
      suggestions.push({ line: i + 1, entity: entityName, suggestion });
      annotatedLines.add(i);
    }
  }

  // Insert a comment line ABOVE each annotated line.
  // Walk lines in reverse so insertion indices stay stable.
  const sortedLineIndices = [...annotatedLines].sort((a, b) => b - a);
  for (const idx of sortedLineIndices) {
    const matchesOnThisLine = suggestions.filter((s) => s.line === idx + 1);
    const commentText = matchesOnThisLine.map((s) => s.suggestion).join(' | ');
    // Detect leading whitespace of the target line so the comment lines up.
    const leadingWhitespace = (lines[idx].match(/^\s*/) || [''])[0];
    const commentLine = `${leadingWhitespace}{%- comment -%} SDM→EDM SUGGESTION: ${commentText} {%- endcomment -%}`;
    lines.splice(idx, 0, commentLine);
  }

  return { newContent: lines.join('\n'), suggestions };
}

/**
 * Generate a unified-diff-style string for two file contents.
 * Minimal implementation — line-level only, no context smarts.
 */
function unifiedDiff(oldContent, newContent, filePath) {
  if (oldContent === newContent) return '';
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const header = `--- ${filePath}\n+++ ${filePath}\n`;

  // Greedy block diff: walk both line arrays in parallel.
  const out = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      out.push(`  ${oldLines[i]}`);
      i++;
      j++;
    } else {
      // Find next sync point.
      let oi = i;
      let nj = j;
      while (oi < oldLines.length && newLines.indexOf(oldLines[oi], j) === -1) oi++;
      while (nj < newLines.length && oldLines.indexOf(newLines[nj], i) === -1) nj++;
      for (let k = i; k < oi; k++) out.push(`- ${oldLines[k]}`);
      for (let k = j; k < nj; k++) out.push(`+ ${newLines[k]}`);
      i = oi;
      j = nj;
    }
  }

  return header + out.join('\n') + '\n';
}

/**
 * Backup a file by writing a `.pre-edm.bak` sibling if not already present.
 */
function backupFileOnce(filePath) {
  const backupPath = `${filePath}.pre-edm.bak`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(filePath, backupPath);
  }
  return backupPath;
}

/**
 * Run the FetchXML auto-rewriter against all .html and .yml files under sitePath.
 */
function executeFetchXmlRewrites(sitePath, outputDir) {
  if (!fs.existsSync(sitePath)) {
    throw new Error(`Site path not found: ${sitePath}`);
  }

  const files = walkSiteDirectory(sitePath, ['.html', '.yml']);
  const results = { filesScanned: 0, filesModified: 0, rewrites: [], skipped: [] };
  const diffs = [];

  for (const file of files) {
    results.filesScanned++;
    const content = fs.readFileSync(file, 'utf-8');
    if (!/<entity\b[^>]*\bname\s*=\s*['"]adx_/.test(content)) continue;

    const { newContent, changes, skipped } = rewriteFetchXmlInContent(content);
    if (changes.length > 0 && newContent !== content) {
      const backup = backupFileOnce(file);
      fs.writeFileSync(file, newContent, 'utf-8');
      results.filesModified++;
      results.rewrites.push({ file, backup, changes });
      diffs.push(unifiedDiff(content, newContent, path.relative(sitePath, file)));
    }
    if (skipped.length > 0) {
      results.skipped.push({ file, skipped });
    }
  }

  // Write the consolidated diff file.
  const diffPath = path.join(outputDir, 'fetchxml-rewrites.diff');
  fs.writeFileSync(diffPath, diffs.join('\n'), 'utf-8');
  results.diffPath = diffPath;

  return results;
}

/**
 * Run the Liquid entities['adx_*'] semi-auto rewriter (annotate, don't overwrite).
 */
function executeLiquidRewrites(sitePath, outputDir) {
  if (!fs.existsSync(sitePath)) {
    throw new Error(`Site path not found: ${sitePath}`);
  }

  const files = walkSiteDirectory(sitePath, ['.html']);
  const results = { filesScanned: 0, filesAnnotated: 0, suggestions: [] };
  const diffs = [];

  for (const file of files) {
    results.filesScanned++;
    const content = fs.readFileSync(file, 'utf-8');
    if (!/entities\s*\[/.test(content)) continue;

    const { newContent, suggestions } = annotateLiquidEntitiesInContent(content);
    if (suggestions.length > 0 && newContent !== content) {
      const backup = backupFileOnce(file);
      fs.writeFileSync(file, newContent, 'utf-8');
      results.filesAnnotated++;
      results.suggestions.push({ file, backup, suggestions });
      diffs.push(unifiedDiff(content, newContent, path.relative(sitePath, file)));
    }
  }

  const diffPath = path.join(outputDir, 'liquid-suggestions.diff');
  fs.writeFileSync(diffPath, diffs.join('\n'), 'utf-8');
  results.diffPath = diffPath;

  return results;
}

// ---------------------------------------------------------------------------
// Augmented prompts for customer-owned code (Plugin + DME remediation)
// ---------------------------------------------------------------------------

/**
 * Load a prompt template from scripts/prompts/.
 * Templates contain `{{TOKEN}}` placeholders that are filled in at runtime.
 */
function loadPromptTemplate(templateName) {
  const templatePath = path.join(__dirname, 'prompts', templateName);
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Prompt template not found: ${templatePath}`);
  }
  return fs.readFileSync(templatePath, 'utf-8');
}

/**
 * Format the plugin findings as a markdown table block for the prompt.
 * Categorizes each finding using the same logic as categorizePlugin().
 */
function formatPluginFindingsBlock(pluginFindings) {
  if (!pluginFindings || pluginFindings.length === 0) {
    return '*(No plugin findings — this prompt was generated empty. Skip plugin remediation.)*';
  }

  const rows = pluginFindings.map((item) => {
    const cat = categorizePlugin(item.snippet || '');
    const category = cat.category === 'system'
      ? 'Microsoft (no action)'
      : cat.category === 'adxstudio'
        ? 'Adxstudio (verify V2)'
        : 'Custom (refactor)';
    return `| \`${cat.pluginName}\` | \`${cat.entity || '?'}\` | ${cat.stepName || '?'} | ${category} |`;
  });

  return [
    '| Plugin name | Target entity | Step name | Category |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/**
 * Format the DME findings as a markdown table block grouped by source table.
 */
function formatDmeTableGroupsBlock(dmeChecklists) {
  if (!dmeChecklists || dmeChecklists.length === 0) {
    return '*(No Data Model Extension findings — this prompt was generated empty. Skip DME remediation.)*';
  }

  const sections = dmeChecklists.map((group) => {
    const columnList = group.columns.map((c) => `- \`${c}\``).join('\n');
    return [
      `### Source: \`${group.sourceTable}\` → suggested target: \`${group.suggestedNewTable}\``,
      '',
      'Custom columns to move:',
      '',
      columnList,
    ].join('\n');
  });

  return sections.join('\n\n');
}

/**
 * Generate the plugin remediation prompt by filling the template with findings.
 * Returns the full prompt text. Caller is responsible for writing it to disk.
 */
function generatePluginRemediationPrompt(pluginFindings) {
  const template = loadPromptTemplate('plugin-remediation.template.txt');
  const findingsBlock = formatPluginFindingsBlock(pluginFindings);
  return template.replace('{{PLUGIN_FINDINGS_BLOCK}}', findingsBlock);
}

/**
 * Generate the DME remediation prompt by filling the template with checklists.
 */
function generateDmeRemediationPrompt(dmeChecklists) {
  const template = loadPromptTemplate('dme-remediation.template.txt');
  const tableGroupsBlock = formatDmeTableGroupsBlock(dmeChecklists);
  return template.replace('{{DME_TABLE_GROUPS_BLOCK}}', tableGroupsBlock);
}

/**
 * Write augmented prompts to .txt files in <output-dir> and return paths +
 * the prompt strings (so the caller can also embed them in the HTML report).
 */
function writeAugmentedPrompts(customizations, remediationResults, outputDir) {
  const pluginFindings = customizations['Plugins registered on adx entities'] || [];
  const dmeChecklists = (remediationResults && remediationResults.dataModelChecklists) || [];

  const result = { pluginPath: null, dmePath: null, pluginPrompt: '', dmePrompt: '' };

  if (pluginFindings.length > 0) {
    result.pluginPrompt = generatePluginRemediationPrompt(pluginFindings);
    result.pluginPath = path.join(outputDir, 'plugin-remediation-prompt.txt');
    fs.writeFileSync(result.pluginPath, result.pluginPrompt, 'utf-8');
  }

  if (dmeChecklists.length > 0) {
    result.dmePrompt = generateDmeRemediationPrompt(dmeChecklists);
    result.dmePath = path.join(outputDir, 'dme-remediation-prompt.txt');
    fs.writeFileSync(result.dmePath, result.dmePrompt, 'utf-8');
  }

  return result;
}

/**
 * Print the augmented prompts to the console with clear visual separators
 * so the user knows where to copy from.
 */
function printAugmentedPromptsToConsole(promptResults) {
  if (!promptResults.pluginPrompt && !promptResults.dmePrompt) return;

  const banner = '═'.repeat(75);
  console.log('');
  console.log(banner);
  console.log('  MANUAL REMEDIATION — augmented prompts ready');
  console.log(banner);
  console.log('');
  console.log('The customization scan flagged manual remediation in two categories that');
  console.log('this skill does NOT modify directly (your code stays yours):');
  console.log('');
  if (promptResults.pluginPath) {
    console.log(`  → Plugin remediation prompt: ${promptResults.pluginPath}`);
  }
  if (promptResults.dmePath) {
    console.log(`  → DME remediation prompt:    ${promptResults.dmePath}`);
  }
  console.log('');
  console.log('Both prompts are also embedded in skill-execution-report.html.');
  console.log('Paste each into a new Claude Code session pointed at the relevant');
  console.log('working directory (your plugin source repo, or any empty dir for DME).');
  console.log('');
  console.log(banner);
  console.log('');
}

/**
 * Main function
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Validate required arguments
  const required = ['site-name', 'website-id', 'output-dir'];
  for (const arg of required) {
    if (!args[arg]) {
      console.error(`Error: --${arg} is required`);
      process.exit(1);
    }
  }

  // Create output directory if it doesn't exist
  if (!fs.existsSync(args['output-dir'])) {
    fs.mkdirSync(args['output-dir'], { recursive: true });
  }

  try {
    // Parse customization report if provided
    let customizations = {};
    const customizationReportPath =
      args['customization-report'] ||
      args['siteCustomizationReportPath'] ||
      args['siteCustomizationReport'] ||
      args['report-path'] ||
      args['reportPath'];

    if (customizationReportPath) {
      customizations = parseCustomizationReport(customizationReportPath);
    }

    // Always categorize findings if we have a customization report — this is local-only
    // analysis (no Dataverse calls) that enriches the execution report with per-finding
    // guidance (Liquid categorization, plugin categorization, Data Model Extension
    // per-table checklists). The legacy --automate flag is retained for back-compat but
    // is now a no-op marker.
    let remediationResults = null;
    if (Object.keys(customizations).length > 0) {
      const envUrl = args['env-url'] || args['envUrl'] || null;
      remediationResults = await executeAutomatedRemediation(customizations, envUrl);
      const total =
        remediationResults.manual.length +
        remediationResults.automated.length +
        remediationResults.errors.length;
      console.log(
        `Categorized ${total} findings: ${remediationResults.manual.length} manual, ${remediationResults.automated.length} automated, ${remediationResults.errors.length} errors`,
      );
    }

    // Run FetchXML auto-rewriter if requested
    let fetchXmlRewriteResults = null;
    if (args['automate-fetchxml']) {
      const sitePath = args['site-path'] || args['sitePath'];
      if (!sitePath) {
        console.error('Error: --site-path <path> is required with --automate-fetchxml. Point this at your `pac pages download` output directory.');
        process.exit(1);
      }
      console.log(`Rewriting FetchXML in: ${sitePath}`);
      fetchXmlRewriteResults = executeFetchXmlRewrites(sitePath, args['output-dir']);
      console.log(`✓ FetchXML: scanned ${fetchXmlRewriteResults.filesScanned} files, modified ${fetchXmlRewriteResults.filesModified}, skipped ${fetchXmlRewriteResults.skipped.length}`);
      console.log(`  Diff: ${fetchXmlRewriteResults.diffPath}`);
    }

    // Run Liquid entities[''] semi-auto rewriter if requested
    let liquidRewriteResults = null;
    if (args['automate-liquid']) {
      const sitePath = args['site-path'] || args['sitePath'];
      if (!sitePath) {
        console.error('Error: --site-path <path> is required with --automate-liquid. Point this at your `pac pages download` output directory.');
        process.exit(1);
      }
      console.log(`Annotating Liquid entities[adx_*] usages in: ${sitePath}`);
      liquidRewriteResults = executeLiquidRewrites(sitePath, args['output-dir']);
      console.log(`✓ Liquid: scanned ${liquidRewriteResults.filesScanned} files, annotated ${liquidRewriteResults.filesAnnotated}`);
      console.log(`  Diff: ${liquidRewriteResults.diffPath}`);
    }

    // Generate augmented prompts for plugin and DME findings (customer-owned code
    // is not modified by this skill — instead, paste-ready prompts are produced for
    // the user to take to a fresh Claude session that can act on their plugin source
    // or build a Dataverse solution package).
    const promptResults = writeAugmentedPrompts(customizations, remediationResults, args['output-dir']);
    if (promptResults.pluginPath) {
      console.log(`✓ Plugin remediation prompt: ${promptResults.pluginPath}`);
    }
    if (promptResults.dmePath) {
      console.log(`✓ DME remediation prompt:    ${promptResults.dmePath}`);
    }

    // Generate customization report
    const customizationHtml = generateCustomizationReportHtml(args, customizations);
    const customizationPath = path.join(args['output-dir'], 'customization-report.html');
    fs.writeFileSync(customizationPath, customizationHtml, 'utf-8');
    console.log(`✓ Customization report generated: ${customizationPath}`);

    // Generate execution report (include auto-rewrite results AND augmented prompts
    // so the report shows everything that was produced).
    const executionHtml = generateExecutionReportHtml(
      args,
      remediationResults,
      customizations,
      { fetchXml: fetchXmlRewriteResults, liquid: liquidRewriteResults, prompts: promptResults },
    );
    const executionPath = path.join(args['output-dir'], 'skill-execution-report.html');
    fs.writeFileSync(executionPath, executionHtml, 'utf-8');
    console.log(`✓ Execution report generated: ${executionPath}`);

    console.log('\nReports generated successfully!');
    console.log(`Open in browser: file://${path.resolve(customizationPath)}`);

    // Print the augmented-prompt handoff to the terminal with clear visual separators.
    printAugmentedPromptsToConsole(promptResults);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
