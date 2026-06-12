const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');

const { createTempProject, writeProjectFile } = require('./test-utils');

const VALIDATOR_PATH = path.join(
  __dirname,
  '..',
  '..',
  'skills',
  'add-ai-webapi',
  'scripts',
  'validate-ai-webapi.js'
);

function runValidator(projectRoot) {
  return spawnSync(process.execPath, [VALIDATOR_PATH], {
    input: JSON.stringify({ cwd: projectRoot }),
    encoding: 'utf8',
  });
}

const VALID_SEARCH_SERVICE = `
export async function fetchSearchSummary(userQuery) {
  const token = await getCsrfToken();
  const response = await fetch('/_api/search/v1.0/summary', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      '__RequestVerificationToken': token,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: new URLSearchParams({ userQuery }).toString(),
  });
  return response.json();
}
`;

const VALID_DATA_SERVICE = `
export async function fetchCaseSummary(caseId) {
  const token = await getCsrfToken();
  const url = '/_api/summarization/data/v1.0/incidents(' + caseId + ')?$select=description,title&$expand=incident_adx_portalcomments($select=description)';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      '__RequestVerificationToken': token,
      'X-Requested-With': 'XMLHttpRequest',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
    },
    body: JSON.stringify({ InstructionIdentifier: 'Summarization/prompt/case_summary' }),
  });
  return response.json();
}
`;

test('approves when no AI summarization calls exist', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/index.ts', 'export const noop = () => {};');

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('approves when src directory is missing', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('valid search summary service passes validation', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/services/aiSummaryService.ts', VALID_SEARCH_SERVICE);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('valid data summarization service passes validation', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/services/aiSummaryService.ts', VALID_DATA_SERVICE);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('missing __RequestVerificationToken is flagged', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(
    projectRoot,
    'src/services/aiSummaryService.ts',
    VALID_SEARCH_SERVICE.replace("'__RequestVerificationToken': token,", '')
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing the __RequestVerificationToken header/);
});

test('missing X-Requested-With is warned but not blocked', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(
    projectRoot,
    'src/services/aiSummaryService.ts',
    VALID_SEARCH_SERVICE.replace("'X-Requested-With': 'XMLHttpRequest',", '')
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /X-Requested-With/);
});

test('data summarization without $select is flagged', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(
    projectRoot,
    'src/services/aiSummaryService.ts',
    VALID_DATA_SERVICE.replace(/\?\$select=[^']+/, '')
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing \$select/);
});

test('header tokens are checked project-wide, not per-file (shared-helper pattern)', (t) => {
  // A correct integration commonly centralizes header construction in a shared helper while the
  // fetch call lives in a service file. The header/$select/OData checks are project-wide: a token
  // present anywhere under src/ satisfies the check, so this must NOT block (no false failure).
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(
    projectRoot,
    'src/services/case.ts',
    VALID_DATA_SERVICE
      .replace("'__RequestVerificationToken': token,", '')
      .replace("'OData-MaxVersion': '4.0',", '')
      .replace("'OData-Version': '4.0',", '')
  );
  writeProjectFile(
    projectRoot,
    'src/shared/powerPagesApi.ts',
    `export const summarizationHeaders = {
      '__RequestVerificationToken': token,
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
    };`
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('a required header missing from every source file still blocks project-wide', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/services/search.ts', VALID_SEARCH_SERVICE);
  writeProjectFile(
    projectRoot,
    'src/services/case.ts',
    VALID_DATA_SERVICE.replace("'__RequestVerificationToken': token,", '')
  );
  // search.ts still declares the token, so project-wide the integration is fine.
  const present = runValidator(projectRoot);
  assert.equal(present.status, 0, present.stderr);

  // Remove it from search.ts too — now absent everywhere, so it must block.
  writeProjectFile(
    projectRoot,
    'src/services/search.ts',
    VALID_SEARCH_SERVICE.replace("'__RequestVerificationToken': token,", '')
  );
  const absent = runValidator(projectRoot);
  assert.equal(absent.status, 2);
  assert.match(absent.stderr, /missing the __RequestVerificationToken header/);
});

test('Search Summary without parseSummaryWithCitations is warned but not blocked', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/services/aiSummaryService.ts', VALID_SEARCH_SERVICE);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /parseSummaryWithCitations/);
});

test('Search Summary with parseSummaryWithCitations does not warn about parsing', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/services/aiSummaryService.ts', VALID_SEARCH_SERVICE);
  writeProjectFile(
    projectRoot,
    'src/components/SummaryWithCitations.tsx',
    "import { parseSummaryWithCitations } from '../services/aiSummaryService';\nexport function SummaryWithCitations() { return parseSummaryWithCitations(''); }"
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /parseSummaryWithCitations/);
});

test('Search Summary with literal [[N]](url) handling does not warn about parsing', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/services/aiSummaryService.ts', VALID_SEARCH_SERVICE);
  writeProjectFile(
    projectRoot,
    'src/components/Inline.tsx',
    "// Hand-rolled parser handling [[1]](https://example.com/foo)\nexport const re = /\\[\\[(\\d+)\\]\\]\\(([^)]+)\\)/g;"
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /parseSummaryWithCitations/);
});

test('Search Summary without extractKnowledgeArticleId is warned but not blocked', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/services/aiSummaryService.ts', VALID_SEARCH_SERVICE);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /extractKnowledgeArticleId/);
});

test('Search Summary with extractKnowledgeArticleId does not warn about KB rewrite', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/services/aiSummaryService.ts', VALID_SEARCH_SERVICE);
  writeProjectFile(
    projectRoot,
    'src/components/CitationLink.tsx',
    "import { extractKnowledgeArticleId } from '../services/aiSummaryService';\nexport function rewrite(url) { return extractKnowledgeArticleId(url); }"
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /extractKnowledgeArticleId/);
});

test('Search Summary with inline ?id= parsing does not warn about KB rewrite', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/services/aiSummaryService.ts', VALID_SEARCH_SERVICE);
  writeProjectFile(
    projectRoot,
    'src/components/CitationLink.tsx',
    "export function rewrite(url) { const u = new URL(url); return u.searchParams.get('id'); }"
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /extractKnowledgeArticleId/);
});

test('Data-only project does not trigger Search Summary warnings', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/services/aiSummaryService.ts', VALID_DATA_SERVICE);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /parseSummaryWithCitations/);
  assert.doesNotMatch(result.stderr, /extractKnowledgeArticleId/);
});

const VALID_LIST_SERVICE = `
export async function fetchListSummary(entitySet, options) {
  const token = await getCsrfToken();
  const url = '/_api/summarization/data/v1.0/' + entitySet + '?$select=' + options.select;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      '__RequestVerificationToken': token,
      'X-Requested-With': 'XMLHttpRequest',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
    },
    body: JSON.stringify({ InstructionIdentifier: options.instructionIdentifier }),
  });
  return response.json();
}
`;

test('list summary without ContentSizeLimit setting warns', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/services/aiSummaryService.ts', VALID_LIST_SERVICE);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Summarization-Data-ContentSizeLimit\.sitesetting\.yml is missing/);
});

test('list summary with ContentSizeLimit below 200000 warns', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/services/aiSummaryService.ts', VALID_LIST_SERVICE);
  writeProjectFile(
    projectRoot,
    '.powerpages-site/site-settings/Summarization-Data-ContentSizeLimit.sitesetting.yml',
    "id: 11111111-1111-4111-8111-111111111111\nname: Summarization/Data/ContentSizeLimit\nvalue: '150000'\n"
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /ContentSizeLimit is 150000.*at least 200000/);
});

test('list summary with ContentSizeLimit at 200000 does not warn', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/services/aiSummaryService.ts', VALID_LIST_SERVICE);
  writeProjectFile(
    projectRoot,
    '.powerpages-site/site-settings/Summarization-Data-ContentSizeLimit.sitesetting.yml',
    "id: 11111111-1111-4111-8111-111111111111\nname: Summarization/Data/ContentSizeLimit\nvalue: '200000'\n"
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /ContentSizeLimit/);
});

test('single-record-only project does not check ContentSizeLimit', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/services/aiSummaryService.ts', VALID_DATA_SERVICE);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /ContentSizeLimit/);
});

function promptSettingYaml(promptText) {
  const escaped = promptText.replace(/\n/g, '\n  ');
  return [
    'id: 22222222-2222-4222-8222-222222222222',
    'name: Summarization/prompt/case_summary',
    'value: |',
    '  ' + escaped,
    '',
  ].join('\n');
}

test('prompt under 1000 chars is approved with no warning', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/services/aiSummaryService.ts', VALID_DATA_SERVICE);
  writeProjectFile(
    projectRoot,
    '.powerpages-site/site-settings/Summarization-prompt-case_summary.sitesetting.yml',
    promptSettingYaml('Summarize key details and critical information')
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Summarization-prompt/);
});

test('prompt between 1000 and 2000 chars warns', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/services/aiSummaryService.ts', VALID_DATA_SERVICE);
  const longPrompt = 'A'.repeat(1500);
  writeProjectFile(
    projectRoot,
    '.powerpages-site/site-settings/Summarization-prompt-long_one.sitesetting.yml',
    promptSettingYaml(longPrompt)
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Summarization-prompt-long_one\.sitesetting\.yml: prompt value is 1500 characters; aim for ≤1000/);
});

test('prompt over 2000 chars blocks the run', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/services/aiSummaryService.ts', VALID_DATA_SERVICE);
  const tooLong = 'B'.repeat(2500);
  writeProjectFile(
    projectRoot,
    '.powerpages-site/site-settings/Summarization-prompt-too_big.sitesetting.yml',
    promptSettingYaml(tooLong)
  );

  const result = runValidator(projectRoot);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Summarization-prompt-too_big\.sitesetting\.yml: prompt value is 2500 characters, exceeding the supported maximum of 2000/);
});

test('plain-scalar prompt YAML is parsed and measured correctly', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/services/aiSummaryService.ts', VALID_DATA_SERVICE);
  writeProjectFile(
    projectRoot,
    '.powerpages-site/site-settings/Summarization-prompt-short.sitesetting.yml',
    "id: 33333333-3333-4333-8333-333333333333\nname: Summarization/prompt/short\nvalue: Summarize this record briefly\n"
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Summarization-prompt/);
});

test('project with no Summarization/prompt settings does not warn', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/services/aiSummaryService.ts', VALID_DATA_SERVICE);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Summarization-prompt/);
});

// --- OData 4.0 header checks (data summarization) ---

test('data summarization missing OData-MaxVersion header is blocked', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(
    projectRoot,
    'src/services/aiSummaryService.ts',
    VALID_DATA_SERVICE.replace("'OData-MaxVersion': '4.0',", '')
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing the OData-MaxVersion: 4\.0 header/);
});

test('data summarization missing OData-Version header is blocked', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(
    projectRoot,
    'src/services/aiSummaryService.ts',
    VALID_DATA_SERVICE.replace("'OData-Version': '4.0',", '')
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing the OData-Version: 4\.0 header/);
});

test('search-only project does not require OData headers', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/services/aiSummaryService.ts', VALID_SEARCH_SERVICE);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /OData-/);
});

// --- Search Summary content-type check ---

test('Search Summary with application/json instead of urlencoded is blocked', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(
    projectRoot,
    'src/services/aiSummaryService.ts',
    VALID_SEARCH_SERVICE.replace(
      "'Content-Type': 'application/x-www-form-urlencoded',",
      "'Content-Type': 'application/json',"
    )
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing Content-Type: application\/x-www-form-urlencoded/);
});

// --- Disabled-state envelope advisory ---

test('Search Summary without SearchSummaryApiError is warned but not blocked', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/services/aiSummaryService.ts', VALID_SEARCH_SERVICE);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /SearchSummaryApiError/);
});

test('Search Summary with SearchSummaryApiError export does not warn about envelope', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(
    projectRoot,
    'src/services/aiSummaryService.ts',
    VALID_SEARCH_SERVICE +
      '\nexport class SearchSummaryApiError extends Error {}\nexport function isGenAiSearchDisabled() { return false; }\n'
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /SearchSummaryApiError/);
});

test('Search Summary with inline body.Code === pattern does not warn about envelope', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/services/aiSummaryService.ts', VALID_SEARCH_SERVICE);
  writeProjectFile(
    projectRoot,
    'src/components/SearchSummaryCard.tsx',
    "export function detect(body) { return body.Code === 400 && body.Message !== ''; }"
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /SearchSummaryApiError/);
});

test('Data-only project does not warn about disabled-state envelope', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/services/aiSummaryService.ts', VALID_DATA_SERVICE);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /SearchSummaryApiError/);
});

// --- Plain-scalar long prompt advisory ---

test('plain-scalar prompt over 200 chars warns about block-literal', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/services/aiSummaryService.ts', VALID_DATA_SERVICE);
  const longPrompt = 'X'.repeat(300);
  writeProjectFile(
    projectRoot,
    '.powerpages-site/site-settings/Summarization-prompt-plain_long.sitesetting.yml',
    `id: 44444444-4444-4444-8444-444444444444\nname: Summarization/prompt/plain_long\nvalue: ${longPrompt}\n`
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Summarization-prompt-plain_long\.sitesetting\.yml: prompt value is 300 characters and uses plain-scalar YAML/);
});

test('block-literal prompt over 200 chars does not warn about plain-scalar', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/services/aiSummaryService.ts', VALID_DATA_SERVICE);
  writeProjectFile(
    projectRoot,
    '.powerpages-site/site-settings/Summarization-prompt-block_long.sitesetting.yml',
    promptSettingYaml('Y'.repeat(300))
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /uses plain-scalar YAML/);
});

test('plain-scalar prompt under 200 chars does not warn about plain-scalar', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/services/aiSummaryService.ts', VALID_DATA_SERVICE);
  writeProjectFile(
    projectRoot,
    '.powerpages-site/site-settings/Summarization-prompt-short_plain.sitesetting.yml',
    "id: 55555555-5555-4555-8555-555555555555\nname: Summarization/prompt/short_plain\nvalue: Summarize key details and critical information\n"
  );

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /uses plain-scalar YAML/);
});

// --- Folded scalar (`>`) parsing ---

test('folded-scalar prompt is parsed and size-checked', (t) => {
  const projectRoot = createTempProject(t);
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
  writeProjectFile(projectRoot, 'src/services/aiSummaryService.ts', VALID_DATA_SERVICE);
  // Build a folded-scalar YAML file by hand. Folded scalars use `>`; the validator
  // should pick up the indented body (size-check it) instead of treating it as null.
  const longBody = 'Z'.repeat(2200);
  const yaml = [
    'id: 66666666-6666-4666-8666-666666666666',
    'name: Summarization/prompt/folded_one',
    'value: >',
    '  ' + longBody,
    '',
  ].join('\n');
  writeProjectFile(
    projectRoot,
    '.powerpages-site/site-settings/Summarization-prompt-folded_one.sitesetting.yml',
    yaml
  );

  const result = runValidator(projectRoot);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Summarization-prompt-folded_one\.sitesetting\.yml: prompt value is \d+ characters, exceeding the supported maximum of 2000/);
});
