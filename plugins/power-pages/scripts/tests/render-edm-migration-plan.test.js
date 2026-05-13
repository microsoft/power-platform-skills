const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(
  __dirname,
  '..',
  'render-edm-migration-plan.js'
);

const SAMPLE_DATA = {
  SITE_NAME: 'Customer Portal',
  PLAN_TITLE: 'EDM Migration Plan',
  SUMMARY: 'The Customer Portal is a classic EDM Power Pages site with 6 pages, 2 entity lists, and 3 entity forms. Migrating to a React SPA with Web API integration.',
  SITE_STATS: {
    routeCount: 8,
    componentCount: 12,
    tableCount: 3,
    manualGapCount: 2,
  },
  DESIGN_DATA: {
    framework: 'React',
    aesthetic: 'Bold & Vibrant',
    mood: 'Professional & Trustworthy',
    layout: 'Spacious',
    navigation: 'Sidebar',
    weblinkLayout: 'vertical',
    typography: 'Cabinet Grotesk + Fira Code',
    motion: 'Confident slide-ins',
    palette: {
      name: 'Strong Blue with Coral Accent',
      colors: [
        { name: 'Primary',    hex: '#1e40af' },
        { name: 'Accent',     hex: '#fb7185' },
        { name: 'Background', hex: '#f8fafc' },
        { name: 'Surface',    hex: '#ffffff' },
        { name: 'Text',       hex: '#0f172a' },
      ],
    },
  },
  ROUTES_DATA: [
    {
      path: '/',
      sourcePages: ['Home'],
      componentMapping: [
        { edm: 'Web template "Home"',          targetKind: 'component', target: 'Home' },
        { edm: 'Snippet "Announcement"',       targetKind: 'content',   target: 'AnnouncementText' },
      ],
      dataNeeds: ['Static assets'],
      rationale: 'Static landing page with no Liquid logic — direct SPA equivalent per the patterns reference.',
      confidence: 'high',
    },
    {
      path: '/incidents',
      sourcePages: ['List of Incidents'],
      componentMapping: [
        { edm: 'Entity list "Incidents"',                  targetKind: 'component', target: 'IncidentList' },
        { edm: 'Custom JS sidecar (jQuery filters)',       targetKind: 'component', target: 'FilterBar'    },
        { edm: 'Liquid {% fetchxml %} for incident counts', targetKind: 'serverLogic', target: 'getIncidentSummary' },
      ],
      dataNeeds: ['Web API: GET /incidents'],
      rationale: 'Entity list reproducible via Web API + table permissions; FetchXML aggregate depends on server-only context so it routes to /add-server-logic.',
      confidence: 'high',
    },
    {
      path: '/incidents/:id',
      sourcePages: ['View Incident'],
      componentMapping: [
        { edm: 'Basic form "incident_view"', targetKind: 'component', target: 'IncidentDetail' },
        { edm: 'Web API call /incident',     targetKind: 'webApi',    target: 'incidentService.getById' },
      ],
      dataNeeds: ['Web API: GET/PATCH /incidents/:id'],
      rationale: 'Basic form in ReadOnly mode maps to client-form-readonly per Form Conversion Standards; runtime confirms GET /incidents/(id) shape.',
      confidence: 'medium',
    },
    {
      path: '/admin/legacy-liquid',
      sourcePages: ['Custom Liquid Page'],
      componentMapping: [
        { edm: 'Liquid block with portal globals',  targetKind: 'manualGap', target: 'undocumented runtime' },
      ],
      dataNeeds: ['Inferred from Liquid block'],
      rationale: 'Liquid block reads undocumented portal runtime globals; cannot be safely reproduced client-side without re-implementing portal internals.',
      confidence: 'low',
    },
  ],
  DATAVERSE_DATA: [
    {
      name: 'incident',
      source: 'Entity list on List of Incidents page',
      operations: ['Read', 'Create', 'Update'],
      siteSettings: ['webapi/incident/fields'],
      followUpSkill: '/integrate-webapi',
      fields: ['incidentid', 'title', 'customerid', 'createdon'],
      relationships: [
        { type: 'lookup', target: 'contact', field: 'customerid', label: 'reported by' },
      ],
    },
    {
      name: 'contact',
      source: 'Lookup field in Incident form',
      operations: ['Read'],
      siteSettings: ['webapi/contact/fields'],
      followUpSkill: '',
      fields: ['contactid', 'fullname', 'emailaddress1'],
      relationships: [],
    },
  ],
  SECURITY_DATA: {
    webRoles: [
      {
        name: 'Anonymous',
        description: 'Unauthenticated users; read-only access',
        status: 'Reuse',
        permissions: ['Read'],
      },
      {
        name: 'Customer',
        description: 'Authenticated customers',
        status: 'Create',
        permissions: ['Read', 'Create'],
      },
    ],
    constraints: [
      {
        title: 'Authenticated Access Required',
        description: 'Most routes require Web API authentication',
      },
    ],
  },
  GAPS_DATA: [
    {
      feature: 'Portal-Managed Hierarchy',
      description: 'Static SPA does not support portal hierarchy navigation',
      impact: 'Manual breadcrumb navigation required',
      recommendedAction: 'Implement role-based breadcrumb navigation',
    },
  ],
  RATIONALE_DATA: [
    {
      title: 'Web API Over Portal-Managed Forms',
      description: 'Direct Web API gives more control over UI/UX and validation',
    },
  ],
};

test('render-edm-migration-plan renders HTML from JSON data', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edm-migration-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'edm-migration-plan.html');

  fs.writeFileSync(dataPath, JSON.stringify(SAMPLE_DATA, null, 2), 'utf8');

  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(fs.existsSync(outputPath));

  const html = fs.readFileSync(outputPath, 'utf8');
  assert.match(html, /Customer Portal/);
  assert.match(html, /EDM Migration Plan/);
  assert.match(html, /classic EDM Power Pages site/);
  assert.match(html, /incident/);
  assert.match(html, /Anonymous/);
  assert.match(html, /Portal-Managed Hierarchy/);
  assert.match(html, /Web API Over Portal-Managed Forms/);
});

test('render-edm-migration-plan applies confidence color coding', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edm-migration-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'edm-migration-plan.html');

  fs.writeFileSync(dataPath, JSON.stringify(SAMPLE_DATA, null, 2), 'utf8');

  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const html = fs.readFileSync(outputPath, 'utf8');
  // CSS classes for confidence visual encoding must exist in the template
  assert.match(html, /confidence-high/);
  assert.match(html, /confidence-medium/);
  assert.match(html, /confidence-low/);
  assert.match(html, /badge-high/);
  assert.match(html, /badge-medium/);
  assert.match(html, /badge-low/);
});

test('render-edm-migration-plan injects all stats into the page', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edm-migration-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'edm-migration-plan.html');

  fs.writeFileSync(dataPath, JSON.stringify(SAMPLE_DATA, null, 2), 'utf8');

  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const html = fs.readFileSync(outputPath, 'utf8');
  // SITE_STATS object should be JSON-stringified and injected into the script
  assert.match(html, /"routeCount":8/);
  assert.match(html, /"componentCount":12/);
  assert.match(html, /"tableCount":3/);
  assert.match(html, /"manualGapCount":2/);
});

test('render-edm-migration-plan escapes HTML special characters in string values', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edm-migration-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'edm-migration-plan.html');

  // Site name and summary contain HTML special characters that must be escaped
  // when placed into HTML text contexts (otherwise they could break layout or
  // open up injection vectors).
  const dataWithSpecials = {
    ...SAMPLE_DATA,
    SITE_NAME: 'Acme <Special> & Co.',
    SUMMARY: 'Migrating <legacy> portal to "modern" SPA with B&D integration.',
  };

  fs.writeFileSync(dataPath, JSON.stringify(dataWithSpecials, null, 2), 'utf8');

  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const html = fs.readFileSync(outputPath, 'utf8');
  // Special characters must be escaped in HTML text contexts
  assert.match(html, /Acme &lt;Special&gt; &amp; Co\./);
  assert.match(html, /Migrating &lt;legacy&gt; portal/);
  // Raw unescaped HTML must NOT appear (would indicate broken escaping)
  assert.ok(!html.includes('Acme <Special> & Co.'));
});

test('render-edm-migration-plan does not place SUMMARY string inside script block', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edm-migration-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'edm-migration-plan.html');

  // SUMMARY containing single quotes or </script> would break a JS context if injected raw.
  const dataWithRiskySummary = {
    ...SAMPLE_DATA,
    SUMMARY: "It's a portal with </script><script>alert(1)</script> markers.",
  };

  fs.writeFileSync(dataPath, JSON.stringify(dataWithRiskySummary, null, 2), 'utf8');

  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const html = fs.readFileSync(outputPath, 'utf8');
  // Verify SUMMARY is not declared as a JS string literal that could break out of the script
  assert.ok(!/const SUMMARY = '/.test(html), 'SUMMARY must not appear as a JS string literal');
  // The risky markup should be HTML-escaped where it does appear
  assert.match(html, /&lt;\/script&gt;/);
  // Raw </script> from the data must not bleed out into the rendered HTML
  assert.ok(!html.includes('</script><script>alert(1)</script>'));
});

test('render-edm-migration-plan refuses to overwrite an existing file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edm-migration-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'edm-migration-plan.html');

  fs.writeFileSync(dataPath, JSON.stringify(SAMPLE_DATA, null, 2), 'utf8');

  // First render — should succeed
  const result1 = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });
  assert.equal(result1.status, 0, result1.stderr || result1.stdout);

  const originalContent = fs.readFileSync(outputPath, 'utf8');

  // Second render to same path — should fail with exit code 1
  const result2 = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });
  assert.equal(result2.status, 1);
  assert.match(result2.stderr, /Output file already exists/);

  // Original file should be untouched
  assert.equal(fs.readFileSync(outputPath, 'utf8'), originalContent);
});

test('render-edm-migration-plan fails when required keys are missing', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edm-migration-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'edm-migration-plan.html');

  // Missing SITE_STATS, GAPS_DATA, RATIONALE_DATA, DESIGN_DATA
  const incomplete = {
    SITE_NAME: 'Test',
    PLAN_TITLE: 'EDM Migration Plan',
    SUMMARY: 'test',
    ROUTES_DATA: [],
    DATAVERSE_DATA: [],
    SECURITY_DATA: { webRoles: [], constraints: [] },
  };

  fs.writeFileSync(dataPath, JSON.stringify(incomplete, null, 2), 'utf8');

  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing required keys/);
  assert.match(result.stderr, /SITE_STATS/);
  assert.match(result.stderr, /GAPS_DATA/);
  assert.match(result.stderr, /RATIONALE_DATA/);
  assert.match(result.stderr, /DESIGN_DATA/);
});

test('render-edm-migration-plan errors when --output or --data are missing', () => {
  const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
});

test('render-edm-migration-plan handles empty arrays for GAPS_DATA and RATIONALE_DATA', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edm-migration-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'edm-migration-plan.html');

  const dataWithoutGaps = {
    ...SAMPLE_DATA,
    GAPS_DATA: [],
    RATIONALE_DATA: [],
  };

  fs.writeFileSync(dataPath, JSON.stringify(dataWithoutGaps, null, 2), 'utf8');

  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const html = fs.readFileSync(outputPath, 'utf8');
  // Empty array should be rendered as []
  assert.match(html, /const GAPS_DATA = \[\]/);
  assert.match(html, /const RATIONALE_DATA = \[\]/);
});

test('render-edm-migration-plan renders the routes table with EDM Today and Target Replacement columns', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edm-migration-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'edm-migration-plan.html');

  fs.writeFileSync(dataPath, JSON.stringify(SAMPLE_DATA, null, 2), 'utf8');

  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const html = fs.readFileSync(outputPath, 'utf8');
  // The routes table must show both legacy and target columns
  assert.match(html, /<th>EDM Today<\/th>/);
  assert.match(html, /<th>Target Replacement<\/th>/);
  // Header reflects mapping intent
  assert.match(html, /SPA Routes &amp; Component Mapping|SPA Routes & Component Mapping/);
  // The componentMapping data must reach the page (JSON-stringified into the script)
  assert.match(html, /"componentMapping":/);
  assert.ok(html.includes('Entity list \\"Incidents\\"'));
  assert.match(html, /jQuery filters/);
});

test('render-edm-migration-plan classifies targets with typed badges', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edm-migration-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'edm-migration-plan.html');

  fs.writeFileSync(dataPath, JSON.stringify(SAMPLE_DATA, null, 2), 'utf8');

  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const html = fs.readFileSync(outputPath, 'utf8');
  // CSS classes for each targetKind must be defined in the template stylesheet
  assert.match(html, /\.badge-component\s*\{/);
  assert.match(html, /\.badge-content\s*\{/);
  assert.match(html, /\.badge-server-logic\s*\{/);
  assert.match(html, /\.badge-webapi\s*\{/);
  assert.match(html, /\.badge-manualgap\s*\{/);
  // The renderTargetCell helper and TARGET_KIND_META map must be present
  assert.match(html, /TARGET_KIND_META/);
  assert.match(html, /serverLogic[\s\S]*?Server Logic/);
  // The serverLogic mapping from SAMPLE_DATA must reach the page
  assert.match(html, /"targetKind":"serverLogic"/);
  assert.match(html, /getIncidentSummary/);
});

test('render-edm-migration-plan renders the design system palette with hex codes', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edm-migration-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'edm-migration-plan.html');

  fs.writeFileSync(dataPath, JSON.stringify(SAMPLE_DATA, null, 2), 'utf8');

  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const html = fs.readFileSync(outputPath, 'utf8');
  // Design metadata should make it to the page
  assert.match(html, /Design System/);
  assert.match(html, /"framework":"React"/);
  assert.match(html, /"layout":"Spacious"/);
  assert.match(html, /"navigation":"Sidebar"/);
  // Aesthetic and mood (the two questions the skill actually asks) must reach the page
  assert.match(html, /"aesthetic":"Bold & Vibrant"/);
  assert.match(html, /"mood":"Professional & Trustworthy"/);
  // The Overview tab renders an aesthetic+mood headline so the user sees the chosen direction
  assert.match(html, /id="designHeadline"/);
  assert.match(html, /design-headline-aesthetic/);
  assert.match(html, /design-headline-mood/);
  // Derived motion direction makes it through too
  assert.match(html, /"motion":"Confident slide-ins"/);
  // Palette must include the descriptive name and derived hex values
  assert.match(html, /"name":"Strong Blue with Coral Accent"/);
  assert.match(html, /"hex":"#1e40af"/);
  assert.match(html, /"hex":"#fb7185"/);
  // The palette grid container must exist in the template
  assert.match(html, /id="paletteGrid"/);
  assert.match(html, /palette-color/);
});

test('render-edm-migration-plan injects DATAVERSE relationships and embeds a Mermaid ER diagram block', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edm-migration-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'edm-migration-plan.html');

  fs.writeFileSync(dataPath, JSON.stringify(SAMPLE_DATA, null, 2), 'utf8');

  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const html = fs.readFileSync(outputPath, 'utf8');
  // Mermaid CDN must be present so the ER diagram renders in the browser
  assert.match(html, /cdn\.jsdelivr\.net\/npm\/mermaid/);
  // ER container must exist for the runtime renderer to populate
  assert.match(html, /id="erContainer"/);
  // buildMermaidErd helper, the syntax it emits, and cardinality logic must be present
  assert.match(html, /erDiagram/);
  assert.match(html, /buildMermaidErd/);
  // Relationships from SAMPLE_DATA must reach the page in JSON
  assert.match(html, /"relationships":/);
  assert.match(html, /"target":"contact"/);
  assert.match(html, /"fields":\["incidentid"/);
  // Table contents survive in the data payload
  assert.match(html, /"name":"incident"/);
});

test('render-edm-migration-plan handles missing relationships and an empty palette gracefully', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edm-migration-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'edm-migration-plan.html');

  const minimalDesign = {
    ...SAMPLE_DATA,
    DESIGN_DATA: {
      framework: 'React',
      layout: 'Compact',
      navigation: 'Topbar',
      palette: { name: 'Slate', colors: [] },
    },
    DATAVERSE_DATA: [
      { name: 'incident', source: 'List', operations: ['Read'], siteSettings: [], followUpSkill: '' },
    ],
  };

  fs.writeFileSync(dataPath, JSON.stringify(minimalDesign, null, 2), 'utf8');

  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const html = fs.readFileSync(outputPath, 'utf8');
  // Renderer must not crash when fields/relationships are absent and palette is empty
  assert.match(html, /"name":"Slate"/);
  // Tables without relationships should still produce a valid mermaid block
  assert.match(html, /erDiagram/);
});

test('render-edm-migration-plan renders DESIGN_DATA.weblinkLayout when present, and omits the row when null', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edm-migration-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'edm-migration-plan.html');

  fs.writeFileSync(dataPath, JSON.stringify(SAMPLE_DATA, null, 2), 'utf8');
  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const html = fs.readFileSync(outputPath, 'utf8');
  // The chosen weblink layout from DESIGN_DATA must reach the page payload so the user sees the decision.
  assert.match(html, /"weblinkLayout":"vertical"/);
  // The Design System block renders a "Weblink Layout" row (title-cased) when a value is set.
  assert.match(html, /Weblink Layout:/);

  // When weblinkLayout is absent (source had no weblink-sets/), the payload must carry null so
  // the runtime guard `if (DESIGN_DATA.weblinkLayout)` skips the row. Verify the data payload —
  // the template's JS source string always contains the row markup inside a template literal,
  // so grepping rendered HTML can't distinguish source from output. The data payload is the
  // single point that drives runtime behaviour.
  const outputPath2 = path.join(tempDir, 'edm-migration-plan-no-weblinks.html');
  const noWeblinks = {
    ...SAMPLE_DATA,
    DESIGN_DATA: { ...SAMPLE_DATA.DESIGN_DATA, weblinkLayout: null },
  };
  fs.writeFileSync(dataPath, JSON.stringify(noWeblinks, null, 2), 'utf8');
  const result2 = spawnSync(process.execPath, [scriptPath, '--output', outputPath2, '--data', dataPath], {
    encoding: 'utf8',
  });
  assert.equal(result2.status, 0, result2.stderr || result2.stdout);
  const html2 = fs.readFileSync(outputPath2, 'utf8');
  // Payload must carry the null so the runtime guard skips the row.
  assert.match(html2, /"weblinkLayout":null/);
  // The runtime metaItems builder must still use a truthy guard so null / undefined skip the row.
  assert.match(html2, /if\s*\(\s*DESIGN_DATA\.weblinkLayout\s*\)/);
});

test('render-edm-migration-plan surfaces the AI-generated-content disclaimer near the top of the page', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edm-migration-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'edm-migration-plan.html');

  fs.writeFileSync(dataPath, JSON.stringify(SAMPLE_DATA, null, 2), 'utf8');
  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const html = fs.readFileSync(outputPath, 'utf8');
  // The disclaimer must be present, exactly worded, and styled so it's visible above the layout.
  assert.match(html, /AI-generated content may be incorrect/);
  assert.match(html, /class="ai-disclaimer"/);
  // It must sit between the topbar and the layout (so it's the first thing users see after the title).
  const topbarIdx = html.indexOf('class="topbar"');
  const disclaimerIdx = html.indexOf('class="ai-disclaimer"');
  const layoutIdx = html.indexOf('class="layout"');
  assert.ok(topbarIdx >= 0 && disclaimerIdx > topbarIdx && layoutIdx > disclaimerIdx,
    'disclaimer must appear between the topbar and the layout');
});

test('render-edm-migration-plan includes an EDM-vs-SPA comparison table on the Overview tab', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edm-migration-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'edm-migration-plan.html');

  fs.writeFileSync(dataPath, JSON.stringify(SAMPLE_DATA, null, 2), 'utf8');
  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const html = fs.readFileSync(outputPath, 'utf8');
  // Heading must be present so users with no SPA background can find the explainer.
  assert.match(html, /EDM vs\. SPA — What's Different/);
  // A representative sampling of rows must be there so the table covers the core concepts.
  assert.match(html, /Server-rendered HTML built by the portal runtime/);
  assert.match(html, /Liquid Dataverse helpers/);
  assert.match(html, /Web Roles \+ Table Permissions enforced by the portal runtime/);
  assert.match(html, /\/add-server-logic/);
  // The table must sit on the Overview tab, not somewhere else.
  const overviewIdx = html.indexOf('id="tab-overview"');
  const tableIdx = html.indexOf("EDM vs. SPA");
  const routesTabIdx = html.indexOf('id="tab-routes"');
  assert.ok(overviewIdx >= 0 && tableIdx > overviewIdx && tableIdx < routesTabIdx,
    'EDM-vs-SPA table must live on the Overview tab, before the Routes tab');
});

test('render-edm-migration-plan includes a Rationale column for routes', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edm-migration-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'edm-migration-plan.html');

  fs.writeFileSync(dataPath, JSON.stringify(SAMPLE_DATA, null, 2), 'utf8');
  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const html = fs.readFileSync(outputPath, 'utf8');
  // Header must include the Rationale column so reviewers see *why* each mapping was chosen.
  assert.match(html, /<th>Rationale<\/th>/);
  // Rationale strings from SAMPLE_DATA must reach the page payload.
  assert.match(html, /server-only context so it routes to/);
  // The renderer must address a rationale-cell class so the column has consistent styling.
  assert.match(html, /rationale-cell/);
});

test('render-edm-migration-plan labels the routes confidence column as "Migration Confidence"', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edm-migration-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'edm-migration-plan.html');

  fs.writeFileSync(dataPath, JSON.stringify(SAMPLE_DATA, null, 2), 'utf8');
  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const html = fs.readFileSync(outputPath, 'utf8');
  // The routes table header must read "Migration Confidence" so users understand
  // it scores the mapping confidence, not data confidence.
  assert.match(html, /<th>Migration Confidence<\/th>/);
  // And the legacy plain "Confidence" header must not be present.
  assert.ok(!/<th>Confidence<\/th>/.test(html));
});

test('render-edm-migration-plan defers Mermaid render until the Data Model tab is opened', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edm-migration-plan-'));
  const dataPath = path.join(tempDir, 'data.json');
  const outputPath = path.join(tempDir, 'edm-migration-plan.html');

  fs.writeFileSync(dataPath, JSON.stringify(SAMPLE_DATA, null, 2), 'utf8');
  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath, '--data', dataPath], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const html = fs.readFileSync(outputPath, 'utf8');

  // Regression guard: mermaid.initialize must use startOnLoad:false. With
  // startOnLoad:true the ER diagram lives inside a display:none tab at page
  // load and Mermaid renders a misleading "Syntax error in text" message
  // because it cannot measure dimensions inside a hidden container.
  assert.match(html, /startOnLoad:\s*false/);
  assert.ok(
    !/startOnLoad:\s*true/.test(html),
    'startOnLoad:true would re-introduce the hidden-tab Mermaid rendering bug'
  );

  // The renderer must validate the diagram source via mermaid.parse before
  // calling mermaid.run, and must expose a lazy renderErdOnce hook plus a
  // fallback for parse/render failures.
  assert.match(html, /function renderErdOnce\b/);
  assert.match(html, /mermaid\.parse\(/);
  assert.match(html, /mermaid\.run\(/);
  assert.match(html, /showRawMermaidFallback\b/);

  // The lazy hook must be wired into tab activation so the diagram renders
  // when the user opens the Data Model tab.
  assert.match(html, /tabName === 'datamodel'/);
  assert.match(html, /renderErdOnce\(\)/);
});
