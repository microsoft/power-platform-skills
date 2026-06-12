#!/usr/bin/env node

// Validates that the add-ai-webapi skill produced AI summarization integration code.
// Runs as the PostToolUse Skill hook validator.
//
// A valid run must produce at least one of:
//   - a search-summary service that POSTs to /_api/search/v1.0/summary
//   - a data-summarization service that POSTs to /_api/summarization/data/v1.0/
//
// Blocking checks (these are documented or structural and break the API at runtime). All are
// project-wide: the required token must appear somewhere under src/, not necessarily in the same
// file as the endpoint URL — a correct integration commonly centralizes header and URL
// construction in a shared helper (the same pattern validate-webapi-integration.js accepts for
// powerPagesApi.ts), so a per-file requirement would false-fail those projects.
//   - The integration must attach the __RequestVerificationToken header. The Data Summarization
//     docs require a CSRF token on these POST requests; omitting it produces a token-validation
//     failure. (These endpoints are semantically read-only — they never mutate Dataverse — but the
//     runtime enforces CSRF on POST regardless of mutation semantics, so the token is still required.)
//   - Data summarization must include $select — Power Pages Web API never allows wildcard columns,
//     and the Microsoft sample URL has $select.
//   - Data summarization must set OData-MaxVersion: 4.0 and OData-Version: 4.0. The endpoint
//     inherits the Power Pages Web API rules and rejects requests without the OData version headers.
//   - Search Summary must use Content-Type: application/x-www-form-urlencoded. The endpoint rejects
//     application/json with a 400 — this is the most common copy-paste failure when the data
//     endpoint's headers leak into the search call.
//
// Advisory only (missing prints a warning but does not block):
//   - X-Requested-With: XMLHttpRequest — matches shell.ajaxSafePost's default behaviour
//     used by the Microsoft-shipped case-page Copilot snippet, but neither summarization
//     doc mandates it. Worth flagging so reviewers can confirm it was intentional.
//   - Search Summary citation parsing — the API embeds [[N]](url) markdown tokens inline
//     in Summary. Rendering Summary directly shows raw markdown. Warn when no source file
//     references parseSummaryWithCitations or contains a [[N]](url) parsing pattern.
//   - Search Summary KB-id rewrite — on Single Page Application (SPA) sites the API returns
//     /page-not-found/?id=<guid> citation URLs that need rewriting to the SPA's KB route.
//     Warn when search-summary code is present but no file references
//     extractKnowledgeArticleId (or an equivalent inline rewrite).
//   - Search Summary disabled-state envelope — the endpoint returns HTTP 200 with
//     { Code, Message } when the site-level Gen AI Search toggle is off. Naive code
//     treats this as a success. Warn when search code is present but no file references
//     SearchSummaryApiError / isGenAiSearchDisabled (or an equivalent inline detection
//     of body.Code + body.Message).
//   - List-summary ContentSizeLimit — when fetchListSummary appears in source, the
//     Summarization/Data/ContentSizeLimit site setting must be present at >= 200000.
//     The 100k server default silently truncates list content; truncation is invisible
//     (no error code), so summaries ship based on partial data. Warn when the YAML is
//     missing or its value is below 200000.
//   - Plain-scalar Summarization/prompt/* values > 200 chars. Plain-scalar YAML breaks
//     pac pages upload-code-site silently when prompts contain ": ", "|", "<|", colons-
//     followed-by-quotes, or newlines — and any prompt > 200 chars is likely to hit one
//     of those. Warn so the maker switches to block-literal (value: |) before deploy.
//
// Blocking checks (these will refuse the run):
//   - Summarization/prompt/* size > 2000 chars. The adx_sitesetting.adx_value column has
//     a default Memo MaxLength of 2000 in older environments, so a longer value can fail
//     the Dataverse upload silently or produce a truncated prompt at runtime. 2000 is the
//     hard ceiling we support.
//
// Advisory only:
//   - Summarization/prompt/* size > 1000 chars. Long prompts cost more per call and are
//     harder to maintain. Warn so makers can compress before hitting the 2000 ceiling.

const fs = require('fs');
const path = require('path');
const { approve, block, runValidation, findProjectRoot } = require('../../../scripts/lib/validation-helpers');
const { validatePowerPagesSchema } = require('../../../scripts/lib/powerpages-schema-validator');

const SEARCH_SUMMARY_URL = '/_api/search/v1.0/summary';
const DATA_SUMMARIZATION_URL = '/_api/summarization/data/v1.0/';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.vue', '.astro']);

runValidation((cwd) => {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) approve();

  const srcDir = path.join(projectRoot, 'src');
  if (!fs.existsSync(srcDir)) approve();

  const sourceFiles = collectSourceFiles(srcDir);
  const hits = [];

  for (const file of sourceFiles) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const hasSearch = content.includes(SEARCH_SUMMARY_URL);
    const hasData = content.includes(DATA_SUMMARIZATION_URL);
    if (hasSearch || hasData) {
      hits.push({ file, content, hasSearch, hasData });
    }
  }

  if (hits.length === 0) approve();

  const errors = [];
  const warnings = [];

  // Header and URL-token checks are project-wide, not per-file. A correct integration commonly
  // centralizes header construction and URL building in a shared helper (the same pattern
  // validate-webapi-integration.js accepts for powerPagesApi.ts), so requiring every token to
  // appear in the same file as the endpoint URL would false-fail those projects. We read the
  // whole src/ tree once and block only when a required token is absent project-wide.
  const allContent = sourceFiles
    .map((f) => {
      try {
        return fs.readFileSync(f, 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');

  const projectHasData = hits.some((h) => h.hasData);
  const projectHasSearchSummary = hits.some((h) => h.hasSearch);

  if (!allContent.includes('__RequestVerificationToken')) {
    errors.push(
      'summarization integration is missing the __RequestVerificationToken header anywhere under src/ (CSRF token is required on these POST requests — fetch it from /_layout/tokenhtml)'
    );
  }
  if (!allContent.includes('X-Requested-With')) {
    warnings.push(
      'summarization integration does not set the X-Requested-With: XMLHttpRequest header anywhere under src/ (not strictly required by the docs, but matches shell.ajaxSafePost behaviour used by the Microsoft case-page snippet)'
    );
  }
  if (projectHasData) {
    if (!/\$select=/.test(allContent)) {
      errors.push(
        'data summarization integration is missing $select anywhere under src/ — Power Pages Web API requires explicit column lists, never wildcards'
      );
    }
    // OData 4.0 headers are mandatory on the data-summarization endpoint — it inherits
    // the Power Pages Web API rules and rejects requests without them.
    if (!allContent.includes('OData-MaxVersion')) {
      errors.push(
        'data summarization integration is missing the OData-MaxVersion: 4.0 header anywhere under src/ — the Power Pages Web API rejects requests without it'
      );
    }
    if (!allContent.includes('OData-Version')) {
      errors.push(
        'data summarization integration is missing the OData-Version: 4.0 header anywhere under src/ — the Power Pages Web API rejects requests without it'
      );
    }
  }
  if (projectHasSearchSummary) {
    // Search Summary requires application/x-www-form-urlencoded. Sending application/json
    // (the most common copy-paste failure from the data endpoint) returns 400.
    if (!allContent.includes('application/x-www-form-urlencoded')) {
      errors.push(
        'Search Summary integration is missing Content-Type: application/x-www-form-urlencoded anywhere under src/ — sending application/json returns 400 (this is the #1 way to break /_api/search/v1.0/summary)'
      );
    }
  }

  // Project-wide checks for Search Summary UI rendering. The parser/rewrite typically lives in a
  // UI component (or a shared util), not the file containing the fetch call. We only run them when
  // the project actually calls /_api/search/v1.0/summary somewhere.
  if (projectHasSearchSummary) {
    // [[N]](url) parser: either by helper name or by a pattern that handles the token.
    // The documented parser is a regex literal `/\[\[(\d+)\]\]\(([^)]+)\)/`, so the source
    // text contains the escaped-bracket characters `\[\[ ... \]\]\(`. Match that form (any
    // capture-group content between the escaped brackets), or a literal `[[N]](` token.
    const usesParserHelper = allContent.includes('parseSummaryWithCitations');
    const handlesTokenInline =
      /\\\[\\\[.*?\\\]\\\]\\\(/.test(allContent) || /\[\[\d+\]\]\(/.test(allContent);
    if (!usesParserHelper && !handlesTokenInline) {
      warnings.push(
        'Search Summary is integrated but no source file references parseSummaryWithCitations or a [[N]](url) parsing pattern — Summary will render as raw markdown unless a parser is wired in.'
      );
    }

    // KB-id rewrite for SPA sites: either by helper name or by inline reading of ?id=<guid>.
    const usesRewriteHelper = allContent.includes('extractKnowledgeArticleId');
    const handlesRewriteInline = /searchParams\.get\(\s*['"]id['"]\s*\)/.test(allContent);
    if (!usesRewriteHelper && !handlesRewriteInline) {
      warnings.push(
        "Search Summary is integrated but no source file references extractKnowledgeArticleId or reads the citation URL's ?id parameter — citation links will land on the built-in /page-not-found page on SPA sites."
      );
    }

    // Disabled-state envelope: the endpoint returns HTTP 200 with { Code, Message } when
    // the site-level Gen AI Search toggle is off. Naive code that calls response.json() on
    // a 200 treats this as success and renders the empty-state message. Detection can be
    // by helper name (SearchSummaryApiError / isGenAiSearchDisabled) or by an inline check
    // that pattern-matches body.Code (number) + body.Message (string) without a Summary.
    const usesDisabledHelper =
      allContent.includes('SearchSummaryApiError') || allContent.includes('isGenAiSearchDisabled');
    const handlesDisabledInline =
      /\.\s*Code\s*[=!]==?/.test(allContent) && /\.\s*Message\s*[=!]==?/.test(allContent);
    if (!usesDisabledHelper && !handlesDisabledInline) {
      warnings.push(
        'Search Summary is integrated but no source file references SearchSummaryApiError / isGenAiSearchDisabled or detects the embedded { Code, Message } envelope inline — when the site-level Gen AI Search toggle is off, the endpoint returns HTTP 200 with that envelope and the UI will silently render the empty-state message. See agents/ai-webapi-integration.md §3.2.'
      );
    }
  }

  // List-summary check: when fetchListSummary is referenced, ContentSizeLimit must be >= 200000.
  // The collection endpoint silently truncates input content at the server-side cap; the 100k
  // default produces summaries based on partial data with no error to catch.
  const projectHasListSummary = sourceFiles.some((f) => {
    try {
      return fs.readFileSync(f, 'utf8').includes('fetchListSummary');
    } catch {
      return false;
    }
  });
  if (projectHasListSummary) {
    const settingPath = path.join(
      projectRoot,
      '.powerpages-site',
      'site-settings',
      'Summarization-Data-ContentSizeLimit.sitesetting.yml'
    );
    let yaml = null;
    try {
      yaml = fs.readFileSync(settingPath, 'utf8');
    } catch {
      yaml = null;
    }
    if (yaml === null) {
      warnings.push(
        'List summary (fetchListSummary) is integrated but Summarization-Data-ContentSizeLimit.sitesetting.yml is missing — the 100k server default will silently truncate list content. Set Summarization/Data/ContentSizeLimit = 200000.'
      );
    } else {
      // Reuse extractSiteSettingValue so block-literal YAML (`value: |\n  200000`) is parsed as
      // well as plain/quoted scalars. ContentSizeLimit is conventionally a plain integer, but a
      // hand-written block-literal would otherwise slip past validation silently.
      const rawValue = extractSiteSettingValue(yaml);
      const trimmedValue = rawValue !== null ? rawValue.trim() : '';
      const numericValue = /^\d+$/.test(trimmedValue) ? parseInt(trimmedValue, 10) : null;
      if (numericValue === null) {
        warnings.push(
          'Summarization-Data-ContentSizeLimit.sitesetting.yml exists but its `value` field is not a parseable integer — list-summary truncation cannot be verified. Set value: 200000.'
        );
      } else if (numericValue < 200000) {
        warnings.push(
          `Summarization/Data/ContentSizeLimit is ${numericValue}; list summaries should use at least 200000 to avoid silent truncation of ~500-row payloads.`
        );
      }
    }
  }

  // Summarization/prompt/* size check.
  // The prompt is stored in adx_sitesetting.adx_value (Memo column). Default Memo MaxLength is 2000
  // in many environments, so we treat 2000 as the hard ceiling. We also warn at 1000 — long prompts
  // cost more per summarization call and are harder to maintain.
  const siteSettingsDir = path.join(projectRoot, '.powerpages-site', 'site-settings');
  if (fs.existsSync(siteSettingsDir)) {
    let entries = [];
    try {
      entries = fs.readdirSync(siteSettingsDir);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.startsWith('Summarization-prompt-') || !entry.endsWith('.sitesetting.yml')) continue;
      const filePath = path.join(siteSettingsDir, entry);
      let yaml;
      try {
        yaml = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      const promptValue = extractSiteSettingValue(yaml);
      if (promptValue === null) continue;
      const charCount = promptValue.length;
      if (charCount > 2000) {
        errors.push(
          `${entry}: prompt value is ${charCount} characters, exceeding the supported maximum of 2000. Shorten this site-setting prompt — condense or drop inline examples within the prompt text. The Data Summarization request body does not accept prompt text (only InstructionIdentifier / RecommendationConfig), so the full instruction must fit in this site-setting value.`
        );
      } else if (charCount > 1000) {
        warnings.push(
          `${entry}: prompt value is ${charCount} characters; aim for ≤1000 to keep prompts compact and maintainable. Hard ceiling is 2000.`
        );
      }
      // Plain-scalar prompts > 200 chars are likely to break pac pages upload-code-site
      // silently because long prompts almost always contain ": ", "|", "<|", or newlines —
      // any of which trip plain-scalar YAML parsing. Block-literal (value: |) is the
      // documented safe form. See agents/ai-webapi-settings-architect.md §5.1a.
      if (charCount > 200 && isPlainScalarValue(yaml)) {
        warnings.push(
          `${entry}: prompt value is ${charCount} characters and uses plain-scalar YAML (value: <text>). Plain-scalar parsing breaks pac pages upload-code-site for prompts containing ": ", "|", "<|", or newlines — any of which is likely above 200 chars. Switch to block-literal form (value: |\\n  <prompt body indented 2 spaces>).`
        );
      }
    }
  }

  const schemaValidation = validatePowerPagesSchema(projectRoot);
  const schemaErrors = schemaValidation.findings
    .filter(finding => finding.severity === 'error')
    .map(finding => finding.filePath ? `${finding.message} (${path.basename(finding.filePath)})` : finding.message);

  if (schemaErrors.length > 0) {
    errors.push('Invalid Power Pages permissions/site-settings schema:\n  - ' + schemaErrors.join('\n  - '));
  }

  if (warnings.length > 0) {
    process.stderr.write('AI summarization integration warnings:\n- ' + warnings.join('\n- ') + '\n');
  }

  if (errors.length > 0) {
    block('AI summarization integration validation failed:\n- ' + errors.join('\n- '));
  }

  approve();
});

// Extract the `value:` field from a site-setting YAML. Handles four shapes:
//   plain:           value: some text
//   quoted:          value: "some text"   or   value: 'some text'
//   block-literal:   value: |
//                       indented
//                       multi-line content
//   folded-scalar:   value: >
//                       paragraph one
//                       continuation
//
// For block-literal and folded-scalar we read the indented block the same way and join with
// newlines. Folded scalar would render newlines as spaces at runtime, so the joined string
// is a slight over-estimate of the runtime length — that's acceptable for the size guard.
// Returns the string value, or null if the file has no `value:` key.
function extractSiteSettingValue(yaml) {
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const blockMatch = line.match(/^value\s*:\s*[|>][+-]?\s*$/);
    if (blockMatch) {
      // Collect subsequent indented lines until indentation drops back to column 0 (or non-blank line at column 0).
      const collected = [];
      let baseIndent = null;
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (next.trim() === '') {
          collected.push('');
          continue;
        }
        const indentMatch = next.match(/^(\s+)/);
        if (!indentMatch) break; // dedent — block ended
        const indent = indentMatch[1].length;
        if (baseIndent === null) baseIndent = indent;
        if (indent < baseIndent) break;
        collected.push(next.slice(baseIndent));
      }
      return collected.join('\n').replace(/\n+$/, '');
    }
    const inlineMatch = line.match(/^value\s*:\s*(.*)$/);
    if (inlineMatch) {
      let raw = inlineMatch[1].trim();
      if (raw === '') return '';
      // Strip matching outer quotes (single or double).
      if (
        (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
        (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
      ) {
        raw = raw.slice(1, -1);
      }
      return raw;
    }
  }
  return null;
}

// Returns true when the YAML stores `value` as a plain (non-block) scalar — i.e. inline
// after the colon, optionally quoted. Block-literal (`value: |`) and folded-scalar
// (`value: >`) return false. Used to flag long prompts that should be migrated to
// block-literal form to avoid pac pages upload-code-site parsing failures.
function isPlainScalarValue(yaml) {
  const lines = yaml.split(/\r?\n/);
  for (const line of lines) {
    if (/^value\s*:\s*[|>][+-]?\s*$/.test(line)) return false;
    if (/^value\s*:\s*.+$/.test(line)) return true;
    if (/^value\s*:\s*$/.test(line)) return false; // empty value (no scalar at all)
  }
  return false;
}

function collectSourceFiles(dir) {
  const results = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        results.push(full);
      }
    }
  }
  return results;
}
