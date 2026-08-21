#!/usr/bin/env node

/**
 * generate-migration-reports.js
 *
 * Builds the customization report from the PAC customization CSV, stages the
 * FetchXML/Liquid remediation rewrites, and writes the augmented remediation
 * prompts (plugin + DME).
 *
 * It does NOT write the execution/progress report (sdm-to-edm-migration-report.html) —
 * that is the live report, owned by update-state.js + lib/render-live-report.js, which
 * re-render it from migration-state.json after every step.
 *
 * Usage:
 *   # Customization report
 *   node generate-migration-reports.js \
 *     --customization-report "path/to/SiteCustomization.csv" \
 *     --site-name "Contoso Portal" \
 *     --website-id "076bf556-9ae6-ee11-a203-6045bdf0328e" \
 *     --template-name "Starter layout 1" \
 *     --output-dir "./migration-reports"
 *
 *   # Stage remediation rewrites (proposed files land under <output-dir>/remediation-staged/)
 *   node generate-migration-reports.js \
 *     --customization-report "path/to/SiteCustomization.csv" \
 *     --site-name "Contoso Portal" --website-id "<GUID>" \
 *     --site-path "path/to/downloaded/site" \
 *     --automate-fetchxml --automate-liquid \
 *     --output-dir "./migration-reports"
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
    'FetchXML contains adx references': 'badge-fetchxml',
    'Custom workflow': 'badge-workflow',
    'Data Model Extension': 'badge-data-model',
    'Plugins registered on adx entities': 'badge-plugin'
  };

  const badge = badgeMap[type] || 'badge-liquid';
  const typeLabel = type.replace('Liquid contains ', '').replace('Custom ', '');

  let html = `
    <div class="customization-section">
      <div class="section-header">
        <span class="badge ${badge}">${typeLabel}</span>
        <h2>${type}</h2>
        <span class="customization-count">${items.length}</span>
      </div>
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
 * Fill every {{PLACEHOLDER}} token in an HTML report template.
 *
 * Why this exists instead of chained `template.replace('{{X}}', value)`:
 * `String.prototype.replace` with a *string* first argument only swaps the FIRST
 * match. The report templates intentionally repeat some tokens — `{{SITE_NAME}}`
 * appears in both the subtitle and the metadata card, and `{{REPORT_DATE}}` appears
 * in the topbar, the metadata card, AND the footer — so the chained-string approach
 * left the 2nd/3rd occurrences as literal `{{SITE_NAME}}` / `{{REPORT_DATE}}` text in
 * the rendered report. A global regex replaces every occurrence.
 *
 * The value is inserted via a function replacer so `$` sequences in user-derived
 * content (Liquid snippets, FetchXML, plugin names) are treated literally instead of
 * as String.replace special patterns ($&, $1, $$).
 *
 * Tokens are applied in object order; callers pass scalar values before large HTML
 * blocks so a block's content is never re-scanned for a later token.
 */
function fillPlaceholders(template, replacements) {
  return Object.entries(replacements).reduce((html, [token, value]) => {
    // `token` is a literal like '{{SITE_NAME}}'. Escape regex metacharacters so the
    // braces (and any future punctuation a token might contain) match literally.
    const pattern = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    return html.replace(pattern, () => String(value));
  }, template);
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

  // Fill placeholders. Scalars first, large HTML blocks last so block content is
  // never re-scanned for a later token. fillPlaceholders replaces EVERY occurrence
  // (the template repeats {{SITE_NAME}} and {{REPORT_DATE}}), which the previous
  // chained String.replace(string, …) did not — it only swapped the first match,
  // leaving the metadata card's Site Name / Report Generated (and the footer date)
  // as literal {{…}} text.
  template = fillPlaceholders(template, {
    '{{SITE_NAME}}': escapeHtml(args['site-name'] || 'Unknown'),
    '{{WEBSITE_ID}}': escapeHtml(args['website-id'] || 'N/A'),
    '{{TEMPLATE_NAME}}': escapeHtml(args['template-name'] || 'Unknown'),
    '{{REPORT_DATE}}': new Date().toISOString().split('T')[0],
    '{{TOTAL_CUSTOMIZATIONS}}': totalCustomizations.toString(),
    '{{SUMMARY_TEXT}}': summaryText,
    '{{CUSTOMIZATIONS_SECTIONS}}': customizationSections,
  });

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
 * Structured diff used by `remediation-diff.json`. Walks the two line arrays
 * in parallel (same algorithm as unifiedDiff) and groups adjacent changes
 * into hunks with `CONTEXT_LINES` of surrounding context. Returns
 * { linesAdded, linesRemoved, hunks: [...] } — hunks have the shape:
 *   {
 *     oldStart, oldCount, newStart, newCount,
 *     lines: [ { type: 'context'|'added'|'removed', text, oldLine?, newLine? } ]
 *   }
 */
const CONTEXT_LINES = 3;
function structuredDiff(oldContent, newContent) {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  // Build a tagged stream: 'context' | 'removed' | 'added'.
  const stream = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      stream.push({ type: 'context', text: oldLines[i], oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else {
      let oi = i;
      let nj = j;
      while (oi < oldLines.length && newLines.indexOf(oldLines[oi], j) === -1) oi++;
      while (nj < newLines.length && oldLines.indexOf(newLines[nj], i) === -1) nj++;
      for (let k = i; k < oi; k++) stream.push({ type: 'removed', text: oldLines[k], oldLine: k + 1 });
      for (let k = j; k < nj; k++) stream.push({ type: 'added', text: newLines[k], newLine: k + 1 });
      i = oi;
      j = nj;
    }
  }

  // Slice into hunks: a hunk is a run of non-context lines bracketed by
  // up to CONTEXT_LINES of context on either side. Adjacent change runs
  // within 2*CONTEXT_LINES of each other are merged.
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of stream) {
    if (line.type === 'added') linesAdded++;
    else if (line.type === 'removed') linesRemoved++;
  }

  const hunks = [];
  let k = 0;
  while (k < stream.length) {
    if (stream[k].type === 'context') {
      k++;
      continue;
    }
    // Found a change. Walk back for context.
    const hunkStart = Math.max(0, k - CONTEXT_LINES);
    let hunkEnd = k;
    while (hunkEnd < stream.length) {
      if (stream[hunkEnd].type !== 'context') {
        hunkEnd++;
        continue;
      }
      // Look ahead — if another change is within 2*CONTEXT_LINES, keep going.
      let nextChange = -1;
      for (let p = hunkEnd; p < Math.min(stream.length, hunkEnd + 2 * CONTEXT_LINES); p++) {
        if (stream[p].type !== 'context') {
          nextChange = p;
          break;
        }
      }
      if (nextChange === -1) break;
      hunkEnd = nextChange;
    }
    const trailingEnd = Math.min(stream.length, hunkEnd + CONTEXT_LINES);
    const slice = stream.slice(hunkStart, trailingEnd);

    // Compute oldStart/newStart from first context-or-change line.
    let oldStart = null;
    let newStart = null;
    let oldCount = 0;
    let newCount = 0;
    for (const line of slice) {
      if (line.oldLine != null && oldStart == null) oldStart = line.oldLine;
      if (line.newLine != null && newStart == null) newStart = line.newLine;
      if (line.type === 'context') { oldCount++; newCount++; }
      else if (line.type === 'removed') oldCount++;
      else if (line.type === 'added') newCount++;
    }

    hunks.push({
      oldStart: oldStart || 1,
      oldCount,
      newStart: newStart || 1,
      newCount,
      lines: slice,
    });

    k = trailingEnd;
  }

  return { linesAdded, linesRemoved, hunks };
}

/**
 * Materialize a staged copy of `live` at `stagedPath` (mkdir -p its parent).
 */
function writeStaged(stagedPath, content) {
  fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
  fs.writeFileSync(stagedPath, content, 'utf-8');
}

/**
 * Run the FetchXML auto-rewriter. Writes proposed files to
 * `<outputDir>/remediation-staged/<relPath>`. Does NOT modify live files.
 * Live source remains untouched until the apply-remediation step copies
 * staged → live after explicit user approval.
 */
function executeFetchXmlRewrites(sitePath, outputDir) {
  if (!fs.existsSync(sitePath)) {
    throw new Error(`Site path not found: ${sitePath}`);
  }

  const stagedDir = path.join(outputDir, 'remediation-staged');
  const files = walkSiteDirectory(sitePath, ['.html', '.yml']);
  const results = { filesScanned: 0, filesModified: 0, rewrites: [], skipped: [], diffEntries: [] };

  for (const file of files) {
    results.filesScanned++;
    const content = fs.readFileSync(file, 'utf-8');
    if (!/<entity\b[^>]*\bname\s*=\s*['"]adx_/.test(content)) continue;

    const { newContent, changes, skipped } = rewriteFetchXmlInContent(content);
    if (changes.length > 0 && newContent !== content) {
      const relativePath = path.relative(sitePath, file);
      const stagedPath = path.join(stagedDir, relativePath);
      writeStaged(stagedPath, newContent);
      const diff = structuredDiff(content, newContent);
      results.filesModified++;
      results.rewrites.push({ file, stagedPath, changes });
      results.diffEntries.push({
        relativePath,
        kind: 'fetchxml',
        status: 'modified',
        linesAdded: diff.linesAdded,
        linesRemoved: diff.linesRemoved,
        hunks: diff.hunks,
        changeSummary: changes.map((c) => `${c.tag}: ${c.entity} → powerpagecomponent (type=${c.typeValue})`),
        livePath: file,
        stagedPath,
      });
    }
    if (skipped.length > 0) {
      results.skipped.push({ file, skipped });
    }
  }

  results.stagedDir = stagedDir;
  return results;
}

/**
 * Run the Liquid entities['adx_*'] semi-auto rewriter. Writes annotated files
 * to `<outputDir>/remediation-staged/<relPath>` — does NOT modify live files.
 */
function executeLiquidRewrites(sitePath, outputDir) {
  if (!fs.existsSync(sitePath)) {
    throw new Error(`Site path not found: ${sitePath}`);
  }

  const stagedDir = path.join(outputDir, 'remediation-staged');
  const files = walkSiteDirectory(sitePath, ['.html']);
  const results = { filesScanned: 0, filesAnnotated: 0, suggestions: [], diffEntries: [] };

  for (const file of files) {
    results.filesScanned++;
    const content = fs.readFileSync(file, 'utf-8');
    if (!/entities\s*\[/.test(content)) continue;

    const { newContent, suggestions } = annotateLiquidEntitiesInContent(content);
    if (suggestions.length > 0 && newContent !== content) {
      const relativePath = path.relative(sitePath, file);
      const stagedPath = path.join(stagedDir, relativePath);
      // FetchXML rewriter may already have staged this file — if so, diff the
      // staged version against the Liquid output to preserve both passes.
      const baseContent = fs.existsSync(stagedPath) ? fs.readFileSync(stagedPath, 'utf-8') : content;
      const liquidOnly = annotateLiquidEntitiesInContent(baseContent);
      const finalContent = liquidOnly.newContent !== baseContent ? liquidOnly.newContent : newContent;
      writeStaged(stagedPath, finalContent);
      const diff = structuredDiff(content, finalContent);
      results.filesAnnotated++;
      results.suggestions.push({ file, stagedPath, suggestions });
      results.diffEntries.push({
        relativePath,
        kind: 'liquid',
        status: 'modified',
        linesAdded: diff.linesAdded,
        linesRemoved: diff.linesRemoved,
        hunks: diff.hunks,
        changeSummary: suggestions.map((s) => `${s.original || s.match || ''} → ${s.suggestion || s.replacement || ''}`),
        livePath: file,
        stagedPath,
      });
    }
  }

  results.stagedDir = stagedDir;
  return results;
}

/**
 * Merge per-rewriter diff entries by relativePath and emit `remediation-diff.json`.
 *
 * The emitted JSON is a lean, skill-owned manifest consumed only by the live
 * report's Remediation Diff card: `generatedAt`, `siteRoot`, `stagedDir`, and
 * `files[]` (each with `relativePath`, `kind`, `status`, `linesAdded`,
 * `linesRemoved`, `hunks[]`, `changeSummary[]`, and ABSOLUTE `livePath` /
 * `stagedPath`). The report turns each file into a `code --diff "<live>"
 * "<staged>"` command the user runs in any terminal — VS Code's built-in diff
 * editor, no extension required.
 */
function writeRemediationDiff(sitePath, outputDir, fetchXmlResults, liquidResults) {
  const fxEntries = (fetchXmlResults && fetchXmlResults.diffEntries) || [];
  const lqEntries = (liquidResults && liquidResults.diffEntries) || [];

  const byPath = new Map();
  for (const e of fxEntries) byPath.set(e.relativePath, { ...e });
  for (const e of lqEntries) {
    const existing = byPath.get(e.relativePath);
    if (existing) {
      existing.kind = 'fetchxml+liquid';
      existing.linesAdded = e.linesAdded;
      existing.linesRemoved = e.linesRemoved;
      existing.hunks = e.hunks;
      existing.changeSummary = (existing.changeSummary || []).concat(e.changeSummary || []);
    } else {
      byPath.set(e.relativePath, { ...e });
    }
  }

  const files = [...byPath.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  if (files.length === 0) return null;

  // Normalize livePath/stagedPath to ABSOLUTE so the report's per-file
  // `code --diff "<live>" "<staged>"` commands work when pasted into a fresh
  // terminal whose working directory is unrelated to the site root or output
  // dir. Resolved here — the same process/cwd that just wrote the staged files —
  // so any relative inputs resolve correctly.
  for (const entry of files) {
    if (entry.livePath) entry.livePath = path.resolve(entry.livePath);
    if (entry.stagedPath) entry.stagedPath = path.resolve(entry.stagedPath);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    siteRoot: path.resolve(sitePath),
    stagedDir: path.resolve(path.join(outputDir, 'remediation-staged')),
    files,
  };

  const outPath = path.join(outputDir, 'remediation-diff.json');
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  return { outPath, fileCount: files.length };
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
    let sitePathUsed = null;
    if (args['automate-fetchxml']) {
      const sitePath = args['site-path'] || args['sitePath'];
      if (!sitePath) {
        console.error('Error: --site-path <path> is required with --automate-fetchxml. Point this at your `pac pages download` output directory.');
        process.exit(1);
      }
      sitePathUsed = sitePath;
      console.log(`Rewriting FetchXML in: ${sitePath} → staging to remediation-staged/`);
      fetchXmlRewriteResults = executeFetchXmlRewrites(sitePath, args['output-dir']);
      console.log(`✓ FetchXML: scanned ${fetchXmlRewriteResults.filesScanned} files, staged ${fetchXmlRewriteResults.filesModified}, skipped ${fetchXmlRewriteResults.skipped.length}`);
    }

    // Run Liquid entities[''] semi-auto rewriter if requested
    let liquidRewriteResults = null;
    if (args['automate-liquid']) {
      const sitePath = args['site-path'] || args['sitePath'];
      if (!sitePath) {
        console.error('Error: --site-path <path> is required with --automate-liquid. Point this at your `pac pages download` output directory.');
        process.exit(1);
      }
      sitePathUsed = sitePathUsed || sitePath;
      console.log(`Annotating Liquid entities[adx_*] usages in: ${sitePath} → staging to remediation-staged/`);
      liquidRewriteResults = executeLiquidRewrites(sitePath, args['output-dir']);
      console.log(`✓ Liquid: scanned ${liquidRewriteResults.filesScanned} files, staged ${liquidRewriteResults.filesAnnotated}`);
    }

    // Emit remediation-diff.json combining FetchXML + Liquid passes.
    if (sitePathUsed && (fetchXmlRewriteResults || liquidRewriteResults)) {
      const diffOutcome = writeRemediationDiff(sitePathUsed, args['output-dir'], fetchXmlRewriteResults, liquidRewriteResults);
      if (diffOutcome) {
        console.log(`✓ Remediation diff: ${diffOutcome.outPath} (${diffOutcome.fileCount} file${diffOutcome.fileCount === 1 ? '' : 's'})`);
      } else {
        console.log('✓ No remediation diff to emit — auto-rewriters made zero modifications.');
      }
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

    // This script intentionally does NOT write sdm-to-edm-migration-report.html.
    // That file is the LIVE execution report, owned exclusively by update-state.js +
    // lib/render-live-report.js, which re-render it from migration-state.json after every
    // step. Writing it here (from a static template with generic/hardcoded content) would
    // clobber the live report every time this script runs for the customization pass.

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
