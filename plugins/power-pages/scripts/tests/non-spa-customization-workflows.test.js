const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pluginRoot = path.join(__dirname, '..', '..');
const classicReferences = new Map([
  ['author-web-file', 'web-file-authoring.md'],
  ['author-content-snippet', 'content-snippet-authoring.md'],
  ['author-web-template', 'web-template-authoring.md'],
  ['author-page-template', 'page-template-authoring.md'],
  ['author-webpage', 'webpage-authoring.md'],
  ['author-site-marker', 'site-marker-authoring.md'],
]);

function read(relativePath) {
  return fs.readFileSync(path.join(pluginRoot, relativePath), 'utf8');
}

function readClassicReference(owner) {
  return read(path.join('skills', 'edit-site', 'references',
    classicReferences.get(owner)));
}

function assertBundledFile(target, label) {
  const relative = path.relative(pluginRoot, target);
  assert.ok(!path.isAbsolute(relative) && relative !== '..' &&
    !relative.startsWith(`..${path.sep}`), `${label} escapes the plugin`);
  assert.ok(fs.statSync(target).isFile(), label);
}

test('classic component authoring uses references without extra skill registrations', () => {
  const skillsRoot = path.join(pluginRoot, 'skills');
  const registered = fs.readdirSync(skillsRoot, { recursive: true })
    .filter((file) => path.basename(file) === 'SKILL.md');
  const names = registered.map((file) =>
    fs.readFileSync(path.join(skillsRoot, file), 'utf8').match(/^name: (.+)$/m)[1]);
  const advertisedCount = read('README.md').match(/The plugin provides (\d+) skills/);
  assert.ok(advertisedCount, 'README must advertise the bundled skill count');
  assert.equal(Number(advertisedCount[1]), registered.length);
  assert.ok(names.includes('edit-site'));
  assert.ok(names.includes('author-webpage-content'));
  assert.ok(!names.includes('style-site'));
  assert.ok(!fs.existsSync(path.join(skillsRoot, 'style-site', 'SKILL.md')));

  for (const [owner, filename] of classicReferences) {
    assert.ok(!names.includes(owner), owner);
    assert.ok(!fs.existsSync(path.join(skillsRoot, owner, 'SKILL.md')), owner);
    assert.match(filename, /-authoring\.md$/);
    const reference = readClassicReference(owner);
    assert.match(reference, owner === 'author-site-marker'
      ? /^# Site Marker Authoring$/m
      : /^# Design Studio /, owner);
    assert.match(reference, /\[shared routing and execution\]\(non-spa-site-authoring\.md\)/, owner);
    assert.match(reference, /^## Contents$/m, owner);
    assert.match(reference, /^## Verification checklist$/m, owner);
    assert.match(reference, /^## Prohibited shortcuts$/m, owner);
    assert.doesNotMatch(reference, /\$ARGUMENTS|user-invocable:/, owner);
  }
});

test('localized content authoring remains model-invocable without a direct user entry point', () => {
  const content = read(path.join('skills', 'author-webpage-content', 'SKILL.md'));
  const customization = read(path.join('skills', 'edit-site', 'SKILL.md'));
  const integration = read(path.join('skills', 'integrate-webapi', 'references',
    'non-spa-site-workflow.md'));
  const readme = read('README.md');

  assert.match(content, /^user-invocable: false$/m);
  assert.doesNotMatch(content, /^disable-model-invocation:\s*true\b/m);
  assert.match(customization, /^user-invocable: true$/m);
  assert.match(customization, /Invoke only `author-webpage-content` through the `Skill` tool/);
  assert.match(integration, /Invoke `author-webpage-content` with the exact existing localized body target/);
  assert.match(readme, /38 user-invocable skills and one model-only worker/);
  assert.doesNotMatch(readme, /^#### `\/author-webpage-content`/m);
});

test('site-marker authoring preserves aggregate PAC metadata and requested scope', () => {
  const marker = readClassicReference('author-site-marker');
  const discovery = read(path.join('references', 'design-studio-site-discovery.md'));
  const dispatch = read(path.join('skills', 'edit-site', 'references', 'non-spa-site-authoring.md'));

  assert.match(discovery, /\| Site marker \|.*`web-pages\/`.*`sitemarker\.yml`/);
  assert.match(dispatch, /\| `author-site-marker` \|.*\(site-marker-authoring\.md\)/);
  assert.match(marker, /website\.yml\s+sitemarker\.yml\s+web-pages\//);
  assert.match(marker, /- adx_name: <exact-marker-name>\s+adx_pageid: <existing-webpage-id>\s+adx_sitemarkerid: <site-marker-id>/);
  assert.match(marker, /Existing downloaded records may omit `adx_pageid`/);
  assert.match(marker, /Preserve those unrelated entries\s+without inventing a page binding/);
  assert.match(marker, /stop unless the request also authorizes page creation/);
  assert.match(marker, /does not upload or change Dataverse/);
  assert.match(marker, /selected sequence entry does not prove that the remote Dataverse record will\s+be deleted/);
  assert.doesNotMatch(marker, /sitemarkers\/|\.sitemarker\.yml|\bStudio\b/);
});

test('reference dispatch preserves the coordinator phases and local authoring boundaries', () => {
  const skill = read(path.join('skills', 'edit-site', 'SKILL.md'));
  const shared = read(path.join('skills', 'edit-site', 'references', 'non-spa-site-authoring.md'));
  assert.match(shared, /^# Non-SPA Site Authoring$/m);
  assert.match(skill, /Apply \*\*Request routing\*\* before creating coordination tasks/);
  assert.match(skill, /For an individual page or component request, follow the shared authoring reference and\s+finish/);
  assert.match(skill, /For coordinated work, create these tasks before starting/);
  assert.match(shared, /Execute its reference directly for styling-only requests/);
  assert.match(shared, /\| `style-site` \|.*\[Styling\]\(style-site-workflow\.md\)/);
  assert.deepEqual([...skill.matchAll(/^## Phase (\d+):/gm)].map((match) => Number(match[1])),
    [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual([...skill.matchAll(/<!-- gate: ([^ |]+)/g)].map((match) => match[1]),
    ['edit-site:4.approve', 'edit-site:7.deploy']);
  assert.match(shared, /Do not invoke these operation identifiers through the `Skill` tool/);
  assert.match(shared, /Do not rewrite an approved plan, its identifiers, or its hash/);
  assert.match(shared, /Load another component reference only when its records or callers are affected/);
  assert.match(shared, /Do not create or replace a customization plan\/receipt, initialize Git, commit/);
  assert.match(shared, /current\s+approved execution exists, inspect its scope/);
  assert.match(shared, /preserve existing IDs and unknown PAC fields/);
  assert.match(shared, /Do not upload, deploy, activate,\s+modify Dataverse directly/);
  assert.match(shared, /Complete an operation only after its reference verification succeeds/);
  assert.match(shared, /^## Entry-point behavior$/m);
  assert.match(shared, /Record only skill invocations, not reference reads/);
  assert.match(shared, /never create a tracking directory/);

  const snippet = readClassicReference('author-content-snippet');
  assert.match(snippet, /Do not expand a one-language edit or invent translations/);
  assert.match(snippet, /^## Output-context safety$/m);
  assert.match(readClassicReference('author-web-file'), /^## File validation and security$/m);
});

test('styling-only requests use local reference execution without coordinated planning', () => {
  const skill = read(path.join('skills', 'edit-site', 'SKILL.md'));
  const workflow = read(path.join('skills', 'edit-site',
    'references', 'style-site-workflow.md'));
  const contract = read(path.join('skills', 'edit-site',
    'references', 'customization-plan-contract.md'));
  assert.match(skill, /For styling-only requests outside a current approved coordinated execution, follow/);
  assert.match(skill, /references\/style-site-workflow\.md/);
  assert.match(skill, /finish after its local verification\/report, without the phases below/);
  assert.match(workflow, /Styling-only requests finish here: no broad customization plan, Git initialization,/);
  assert.match(workflow, /commit, deployment prompt, final-completion confirmation, HTML preview, local server or browser review/);
  assert.match(workflow, /Preserve identifiers, approved inputs, scope, locales, design context, hashes and\s+receipts/);
  assert.match(workflow, /Coordinated approval does not approve the exact CSS\/source diff/);
  assert.match(workflow, /records `EditSite` once after successful completion, not per/);
  assert.match(contract, /Only `author-webpage-content` is a skill invocation/);
  assert.match(contract, /Keep `style-site` as the operation identifier/);
  assert.doesNotMatch(skill + contract, /invoke `style-site`|`style-site` are skill invocations/);
});

test('new classic pages default to navigation with explicit opt-out and resolved placement', () => {
  const page = readClassicReference('author-webpage');
  assert.match(page, /default: yes, unless the request\s+excludes navigation/);
  assert.match(page, /New pages update navigation by default unless the user explicitly asks not to/);
  assert.match(page, /Resolve the target web link set and label before writing/);
  assert.match(page, /By default, add a web link for the root webpage/);
  assert.match(page, /`adx_pageid` set to the root webpage ID/);
  assert.match(page, /with an active state/);
  assert.match(page, /do not add the page to every\s+web link set/);
  assert.match(page, /do not remove or reorder unrelated links/);
  assert.match(page, /For an approved operation, apply only its approved navigation scope/);
  assert.match(page, /body-only edits leave navigation unchanged/);
  assert.match(page, /request explicitly excludes navigation/);
  assert.doesNotMatch(page, /default: no|page creation alone leaves navigation unchanged|Do not create navigation links merely/);

  for (const relativePath of [
    'AGENTS.md',
    'README.md',
    path.join('skills', 'edit-site', 'references', 'non-spa-site-authoring.md'),
  ]) {
    assert.match(read(relativePath), /[Nn]ew pages update\s+navigation by default unless (?:the user|you) explicitly asks? not to/,
      relativePath);
  }
  const compositions = read(path.join('skills', 'edit-site',
    'references', 'content-and-page-compositions.md'));
  assert.match(compositions, /including default\s+navigation or its explicit opt-out/);
});

test('non-SPA authoring links and contents resolve within the installed plugin', () => {
  const skills = ['edit-site', 'author-webpage-content'];
  const documents = [
    path.join('skills', 'integrate-webapi', 'references', 'non-spa-site-workflow.md'),
    ...skills.map((skill) => path.join('skills', skill, 'SKILL.md')),
    ...skills.flatMap((skill) => {
      const directory = path.join('skills', skill, 'references');
      return fs.readdirSync(path.join(pluginRoot, directory))
        .filter((filename) => filename.endsWith('.md'))
        .map((filename) => path.join(directory, filename));
    }),
  ];
  for (const relativePath of documents) {
    const file = path.join(pluginRoot, relativePath);
    const content = read(relativePath);
    const links = [...content.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)].map((match) => match[1]);
    const pluginLinks = [...content.matchAll(/\$\{PLUGIN_ROOT\}\/([^`"\s]+\.(?:md|js))/g)]
      .map((match) => path.join(pluginRoot, ...match[1].split('/')));
    for (const target of pluginLinks) {
      assertBundledFile(target, `${relativePath}: ${target}`);
    }
    for (const href of links.filter((link) => !/^https?:/i.test(link))) {
      const [relativeTarget, fragment] = href.split('#');
      const target = relativeTarget
        ? path.resolve(path.dirname(file), ...relativeTarget.split('/'))
        : file;
      assertBundledFile(target, `${relativePath}: ${href}`);
      if (fragment) {
        const targetContent = fs.readFileSync(target, 'utf8');
        const anchors = [...targetContent.matchAll(/^#{1,6} (.+)$/gm)]
          .map((match) => match[1].trim().toLowerCase()
            .replace(/[^a-z0-9 _-]/g, '').replace(/ /g, '-'));
        assert.ok(anchors.includes(fragment), `${relativePath}: missing heading ${href}`);
      }
    }
  }
});

test('all declarative preview entry points disclose once and propagate the handoff marker', () => {
  const policy = read(path.join('references', 'non-spa-preview.md'));
  const createSkill = read(path.join('skills', 'create-site', 'SKILL.md'));
  const createWorkflow = read(
    path.join('skills', 'create-site', 'workflows', 'non-spa-site.md')
  );
  const coveredSkills = [
    path.join('skills', 'edit-site', 'SKILL.md'),
    path.join('skills', 'author-webpage-content', 'SKILL.md'),
  ];

  assert.match(
    policy,
    /not to Power Pages, the Enhanced\s+data model, Design Studio, or PAC CLI generally/,
  );
  assert.match(policy, /The notice is informational/);
  assert.match(policy, /previewNoticeShown: true/);
  assert.match(policy, /invocationSource: <calling-skill-name>/);
  assert.match(
    policy,
    /It will not update the[\s>]+live website unless deployment is separately requested and approved/,
  );
  assert.match(
    policy,
    /Do not extend this disclosure\s+to SPA workflows or `deploy-site`/,
  );

  assert.match(
    createSkill,
    /Non-SPA \(Liquid \+ Web Template\)/,
  );
  assert.doesNotMatch(createSkill, /Which type of Power Pages site should I create\?/);
  assert.match(createSkill, /Which frontend framework\?[\s\S]*Non-SPA \(Liquid \+ Web Template\)/);
  const codeSiteWorkflow = createSkill.split('## Phase 2: Scaffold & Launch Dev Server')[1];
  assert.doesNotMatch(codeSiteWorkflow, /non-spa-preview\.md|Preview experience/);
  assert.match(createWorkflow, /references\/non-spa-preview\.md/);
  assert.match(createWorkflow, /present the \*\*Creation notice\*\*/);
  assert.match(createWorkflow, /previewNoticeShown: true/);
  assert.match(createWorkflow, /invocationSource: create-site/);
  assert.match(
    createWorkflow,
    /Continuing with the preview non-SPA site customization experience/,
  );
  assert.match(
    createWorkflow,
    /generate-subdomain\.js"/,
  );
  assert.doesNotMatch(createWorkflow, /generate-subdomain\.js" --siteName/);
  assert.match(
    createWorkflow,
    /\| Subdomain \| Subdomain \| `<SUGGESTED_SUBDOMAIN>` \|/,
  );
  assert.match(createWorkflow, /one editable text field pre-populated with the suggestion/);
  assert.doesNotMatch(createWorkflow, /Would you like to use this subdomain|Enter a custom subdomain/);
  assert.match(createWorkflow, /never append another random suffix or otherwise change it/);

  for (const skillPath of coveredSkills) {
    const skill = read(skillPath);
    assert.match(skill, /references\/non-spa-preview\.md/, skillPath);
    assert.match(skill, /\*\*Customization notice\*\*/, skillPath);
    assert.match(
      skill,
      /before (?:site discovery|inspecting|inspection|project inspection)/i,
      skillPath,
    );
  }

  const customization = read(
    path.join('skills', 'edit-site', 'SKILL.md')
  );
  assert.match(customization, /previewNoticeShown: true/);
  assert.match(customization, /invocationSource: edit-site/);
});

test('non-SPA header planning reaches creation, approval and styling without widening narrow edits', () => {
  const workflow = read(path.join('skills', 'create-site', 'workflows', 'non-spa-site.md'));
  const customization = read(path.join('skills', 'edit-site', 'SKILL.md'));
  const composition = read(path.join('skills', 'edit-site', 'references', 'content-and-page-compositions.md'));
  const contract = read(path.join('skills', 'edit-site', 'references', 'customization-plan-contract.md'));
  const styling = read(path.join('skills', 'edit-site', 'references', 'styling', 'design-quality.md'));
  const headerSection = composition.match(/## Site header planning\r?\n([\s\S]*?)(?=\r?\n## |$)/);
  assert.ok(headerSection);
  const header = headerSection[1];
  assert.match(workflow, /requirement to include header branding, navigation styling and mobile treatment/);
  assert.match(customization, /For new-site design and full-site redesign, explicitly plan the site header/);
  assert.match(customization, /Do not assume\s+that a template named `Header` is the one the site uses/);
  assert.match(customization, /CSS-only header treatment needs no dummy structural operation/);
  assert.match(customization, /missing planned header work as incomplete/);
  assert.match(header, /creation template supplies component\/domain\s+context, not a visual constraint/);
  assert.match(header, /part of the required custom site composition, not a substitute/);
  for (const owner of ['author-content-snippet', 'author-web-template', 'style-site']) {
    assert.ok(header.includes(`\`${owner}\``), owner);
  }
  assert.match(header, /new header binding requires explicitly approved global scope/);
  for (const preserved of ['navigation', 'search', 'language selection', 'sign-in/out',
    'anonymous/authenticated', 'accessible labels/skip links', 'substitution']) {
    assert.ok(header.includes(preserved), preserved);
  }
  assert.match(header, /Do not duplicate the global header inside page content or hide it with CSS/);
  assert.match(header, /Narrow existing-site work leaves unrelated header content and appearance unchanged/);
  assert.match(contract, /do not add a mandatory header field/);
  assert.match(contract, /header planning adds no separate gate or schema/);
  assert.match(contract, /instead of creating a\s+dummy operation/);
  assert.match(styling, /Return missing snippet, markup or Liquid changes to their native owners before styling/);
  assert.match(styling, /remain pending separately authorized observation/);
});

test('every non-SPA header update includes a website-appropriate logo decision and native verification', () => {
  const workflow = read(path.join('skills', 'create-site', 'workflows', 'non-spa-site.md'));
  const customization = read(path.join('skills', 'edit-site', 'SKILL.md'));
  const composition = read(path.join('skills', 'edit-site', 'references', 'content-and-page-compositions.md'));
  const contract = read(path.join('skills', 'edit-site', 'references', 'customization-plan-contract.md'));
  const assets = read(path.join('skills', 'edit-site', 'references', 'visual-asset-planning.md'));
  const styling = read(path.join('skills', 'edit-site', 'references', 'styling', 'design-quality.md'));
  const logoSection = assets.match(/## Logos and favicons\r?\n([\s\S]*?)(?=\r?\n## |$)/);
  assert.ok(logoSection);
  const logos = logoSection[1];

  assert.match(workflow, /explicit website-appropriate logo or wordmark\s+decision/);
  assert.match(customization, /For every header update, explicitly resolve the logo or wordmark against the website requirements/);
  assert.match(composition, /including a header-only request/);
  assert.match(logos, /Do not preserve an unrelated starter logo/);
  assert.match(logos, /1\. use a supplied approved logo/);
  assert.match(logos, /retain the verified current logo only when it meets those requirements or the user explicitly/);
  assert.match(logos, /Report unresolved logo work as incomplete/);
  assert.match(logos, /Honor an explicit no-logo or no-change request/);
  assert.match(logos, /Do not silently invent an official company logo or use stock photography/);
  assert.match(logos, /new-site additions need an approved hosted URL/);
  assert.match(logos, /a logo alone does not satisfy the new-site\s+imagery requirement/);
  assert.match(logos, /Do not\s+silently expand a header-logo change to favicons, footer branding or unrequested locales/);
  assert.match(contract, /`kind: "logo"`, `role: "brand"`/);
  assert.match(contract, /typography-only wordmark uses native owner inputs, not a fake\s+image asset/);
  assert.match(contract, /including any logo source\/value change/);
  assert.match(customization, /approved logo or wordmark in every resolved desktop\/mobile caller and requested locale/);
  assert.match(customization, /An unchanged starter logo is incomplete when the plan approved its replacement/);
  assert.match(styling, /CSS-only restyling does not replace an unsuitable starter logo/);
  assert.match(styling, /avoid cropping or stretching the mark/);
  assert.doesNotMatch(customization, /<!-- gate: [^\n]*logo/);
});

test('new non-SPA creation is Enhanced-only while customization remains model-neutral', () => {
  const skill = read(path.join('skills', 'create-site', 'SKILL.md'));
  const workflow = read(path.join('skills', 'create-site', 'workflows', 'non-spa-site.md'));
  const customization = read(path.join('skills', 'edit-site', 'SKILL.md'));
  const contract = read(
    path.join('skills', 'edit-site', 'references', 'customization-plan-contract.md'),
  );

  assert.match(skill, /allowed-tools: [^\n]*\bSkill\b/);
  assert.doesNotMatch(skill, /create-site:non-spa-1-select-model/);
  assert.match(skill, /Which frontend framework\?[\s\S]*Non-SPA \(Liquid \+ Web Template\)/);
  assert.match(workflow, /create-site:non-spa-8-customize/);
  assert.match(workflow, /Continue with Enhanced \(Recommended\)/);
  assert.match(workflow, /MODEL_VERSION=Enhanced/);
  assert.match(workflow, /BOOTSTRAP_VERSION=5/);
  assert.match(workflow, /explicit Standard\/SDM creation request is not consent/);
  assert.match(
    workflow,
    /https:\/\/admin\.powerplatform\.microsoft\.com\/manage\/environments\/<org-id>\/<env-name>\/portals\?geo=<env-geo>/,
  );
  assert.match(workflow, /check whether \*\*Switch to Enhanced Data Model\*\* is on/);
  assert.match(workflow, /Open the direct settings URL/);
  assert.doesNotMatch(workflow, /https:\/\/aka\.ms\/ppac/);
  assert.doesNotMatch(workflow, /disabled for this environment\?/);
  assert.doesNotMatch(workflow, /Standard with Bootstrap 3 compatibility/);
  assert.match(workflow, /--modelVersion "<MODEL_VERSION>"/);
  assert.match(workflow, /verify the site reports `MODEL_VERSION`/);
  assert.match(workflow, /Would you like to customize the downloaded non-SPA template now\?/);
  assert.match(workflow, /invoke `\/edit-site` through the `Skill` tool/);
  assert.match(workflow, /validated, committed baseline/);
  assert.match(workflow, /Customization success is not a prerequisite/);
  assert.match(workflow, /Suggest `\/setup-datamodel` only when/);
  assert.match(workflow, /Never suggest `\/add-sample-data` for a non-SPA site/);
  assert.match(workflow, /Suggest `\/create-webroles` only when/);
  assert.match(workflow, /Suggest `\/integrate-webapi` only when/);
  assert.match(customization, /Standard or Enhanced data model non-SPA/);
  assert.match(contract, /customization plan is data-model-neutral/);
});

test('edit-site executes authoring references without changing approved-plan contracts', () => {
  const skill = read(path.join('skills', 'edit-site', 'SKILL.md'));
  const contract = read(path.join(
    'skills',
    'edit-site',
    'references',
    'customization-plan-contract.md'
  ));

  assert.match(skill, /user-invocable: true/);
  assert.match(skill, /author-web-file/);
  assert.match(skill, /author-content-snippet/);
  assert.match(skill, /author-web-template/);
  assert.match(skill, /author-page-template/);
  assert.match(skill, /author-site-marker/);
  assert.match(skill, /author-webpage-content/);
  assert.match(skill, /execute the `style-site` reference workflow last/);
  assert.match(skill, /authors webpage, snippet, web-file, web-template, page-template, and site-marker records only through/);
  assert.match(skill, /references\/non-spa-site-authoring\.md/);
  assert.match(skill, /Execute reference workflows directly; invoke only/);
  assert.match(skill, /current-plan\.json/);
  assert.match(skill, /current-execution\.json/);
  assert.match(skill, /promote-edit-site-plan\.js/);
  assert.match(skill, /content-and-page-compositions\.md/);
  assert.match(skill, /visual-asset-planning\.md/);
  assert.match(skill, /prepare-non-spa-asset\.js/);
  assert.match(skill, /WebSearch/);
  assert.match(skill, /Do not generate raster images or use another stock provider/);
  assert.match(skill, /outputBindings/);
  assert.match(skill, /--action resolve/);
  assert.match(skill, /publish the approved JSON/);
  assert.match(skill, /--imageChecks "<APPROVED_REVIEW_DIR>\/plan.html.image-checks.json"/);
  assert.match(skill, /If a check fails, do not request approval/);
  assert.match(skill, /reuse these source checks for unchanged URLs/);
  assert.match(contract, /External images may be\s+reviewed and published without a report/);
  assert.match(contract, /"layout": "two-equal-columns"/);
  assert.match(contract, /do not flatten\s+elements into numeric column indexes/i);
  assert.match(contract, /immutable latest approved plan/);
  assert.match(contract, /current-execution\.json/);
  assert.match(contract, /history\/<UTC-timestamp>/);
  assert.match(contract, /data-model-neutral/);
  assert.match(contract, /Schema version 1 plans must include `assets`/);
  assert.match(contract, /"assets": \[\]/);
  assert.match(contract, /Web File imports retain required `sourcePage`, `photographer`, `license` and `downloadUrl`/);
});

test('non-SPA Unsplash sourcing follows SPA discovery without a photo-page or attribution gate', () => {
  const skill = read(path.join('skills', 'edit-site', 'SKILL.md'));
  const assets = read(path.join('skills', 'edit-site', 'references', 'visual-asset-planning.md'));
  const contract = read(path.join('skills', 'edit-site', 'references', 'customization-plan-contract.md'));
  assert.match(skill, /WebSearch-to-CDN flow, as in SPA creation/);
  assert.match(skill, /without requiring a photo-page fetch or photographer\s+lookup/);
  assert.match(skill, /renderer labels unchecked external images as unverified/);
  assert.match(assets, /same \*\*WebSearch-to-CDN\*\* sourcing approach as SPA creation/);
  assert.match(assets, /do not require a photo-page fetch, scraping, API credentials, or a\s+photographer lookup/);
  assert.match(assets, /otherwise omit them rather than inventing attribution/);
  assert.match(assets, /anti-bot challenge[\s\S]*is not evidence that\s+`images\.unsplash\.com` is unavailable/);
  assert.match(assets, /Do not bypass the challenge/);
  assert.match(assets, /failed CDN image\s+check still blocks approval HTML for that checked review/);
  assert.match(contract, /`source\.sourcePage` and `source\.photographer`\s+are optional/);
  assert.match(contract, /Supplied `--imageChecks` reports must match this exact plan/);
  assert.doesNotMatch(assets, /Record both:|Extract the actual CDN resource URL from that photo's source evidence/);
});

test('non-SPA image verification is opt-in without another gate or mandatory runtime preview', () => {
  const skill = read(path.join('skills', 'edit-site', 'SKILL.md'));
  const assets = read(path.join('skills', 'edit-site', 'references', 'visual-asset-planning.md'));
  const contract = read(path.join('skills', 'edit-site', 'references', 'customization-plan-contract.md'));
  const gates = read(path.join('references', 'approval-gates.md'));
  assert.match(skill, /Only when the user requests source verification, append `--verifyImages true`/);
  assert.match(skill, /By default, the renderer validates the plan without image-network requests/);
  assert.match(skill, /Do not add a mandatory verification-choice question or live-preview requirement/);
  assert.match(skill, /If the approved review included source checks, append/);
  assert.match(skill, /do not drop a checked review's report or invent one for unchecked images/);
  assert.match(assets, /`imageChecks: null`, `verifiedImages: 0`/);
  assert.match(assets, /Do not disable checking to hide a known failure/);
  assert.match(contract, /missing, malformed, stale or failed supplied reports block publication/);
  assert.match(gates, /external images explicitly unverified or supported by successful requested exact-plan checks/);
  assert.deepEqual([...skill.matchAll(/<!-- gate: ([^ |]+)/g)].map((match) => match[1]), [
    'edit-site:4.approve', 'edit-site:7.deploy',
  ]);
});

test('deploy-site keeps code and declarative upload commands isolated', () => {
  const skill = read(path.join('skills', 'deploy-site', 'SKILL.md'));
  const nonSpa = read(path.join('skills', 'deploy-site', 'workflows', 'non-spa-site.md'));

  assert.match(skill, /Site-Type Routing/);
  assert.match(skill, /pac pages upload-code-site --rootPath/);
  assert.match(skill, /Do not continue into the\s+SPA phases below/);
  assert.match(nonSpa, /Use `pac pages upload`, never `pac pages upload-code-site`/);
  assert.match(nonSpa, /--modelVersion "<Enhanced\|Standard>"/);
  assert.match(nonSpa, /Data model: Pending verification/);
  assert.match(nonSpa, /First upload — create site records/);
  assert.match(nonSpa, /first-upload creation supports only Enhanced/);
  assert.match(nonSpa, /existing verified Standard sites remain deployable/);
  assert.match(nonSpa, /EDM-only first-upload policy/);
  assert.match(nonSpa, /existing website's authoritative model for an update/);
  assert.match(nonSpa, /with `Enhanced` for a first upload/);
  assert.doesNotMatch(nonSpa, /Which data model should be used for the first upload\?/);
  assert.match(nonSpa, /different website record with the same site name/);
  assert.match(nonSpa, /Create this Enhanced data model non-SPA site\s+in the selected environment\?/);
  assert.match(nonSpa, /--websiteRecordId "<WEBSITE_RECORD_ID>"/);
  assert.match(nonSpa, /--siteRoot "<PROJECT_RELATIVE_SITE_ROOT>"/);
  assert.match(nonSpa, /Do not invoke `activate-site`/);
  assert.match(skill, /deploy-site:non-spa-4.permissions-audit/);
  assert.match(nonSpa, /permission-sensitive surface changed/);
  assert.match(nonSpa, /Run permissions audit \(Recommended\)/);
  assert.match(nonSpa, /rerun the non-SPA validator, recompute\s+the Git diff, and regenerate the complete Phase 4 component summary/);
  assert.match(nonSpa, /skip this gate without mentioning it/);
  assert.match(nonSpa, /deploy-site:non-spa-5.upload/);
});

test('non-SPA creation uses verified Bootstrap 5 and image-rich design without SPA preview requirements', () => {
  const skill = read(path.join('skills', 'create-site', 'SKILL.md'));
  const workflow = read(path.join('skills', 'create-site', 'workflows', 'non-spa-site.md'));
  const customization = read(path.join('skills', 'edit-site', 'SKILL.md'));
  const common = skill.split('## SPA-Site Workflow')[0];
  assert.match(common, /references\/site-design-quality\.md/);
  assert.match(common, /Non-SPA sites need no dev server or live preview/);
  assert.match(workflow, /No dev server, live preview/);
  assert.match(workflow, /Enhanced with Bootstrap 5/);
  assert.match(workflow, /Continue with Enhanced \(Recommended\)/);
  assert.doesNotMatch(workflow, /Standard with Bootstrap 3 compatibility/);
  assert.match(workflow, /--bootstrapVersion "<BOOTSTRAP_VERSION>"/);
  assert.match(workflow, /filtered `catalog\.templates`/);
  assert.match(workflow, /catalog\.bootstrapCompatibility/);
  assert.match(workflow, /no model or Bootstrap-version field/);
  assert.match(workflow, /Do not recreate it/);
  assert.match(workflow, /creationIntent: "new-site"/);
  assert.match(workflow, /verifiedBootstrapMajor/);
  assert.match(workflow, /imageDelivery: "external-url"/);
  assert.match(workflow, /Skip image staging\/downloads/);
  assert.match(workflow, /organizationBaseLanguageLcid/);
  assert.match(workflow, /organizationBaseLanguage\.name/);
  assert.match(workflow, /organizationBaseLanguage\.code/);
  assert.match(workflow, /Use `BASE_LANGUAGE_LCID` as `SELECTED_BASE_LANGUAGE` without asking a language question/);
  assert.match(workflow, /Ask for a human-readable language, not a raw LCID/);
  assert.match(workflow, /SELECTED_BASE_LANGUAGE_SOURCE` to `Organization default`/);
  assert.match(workflow, /Base language: <SELECTED_BASE_LANGUAGE_SOURCE> \(LCID <SELECTED_BASE_LANGUAGE>\)/);
  assert.match(workflow, /--cloud "<cloud>"/);
  assert.match(workflow, /--languageName "<BASE_LANGUAGE_NAME>"/);
  assert.match(workflow, /--terminalReason "<safe plain-text failure summary>"/);
  assert.match(workflow, /Never mark the completed creation as failed or canceled/);
  assert.doesNotMatch(workflow, /--language "<lcid>"/);
  assert.doesNotMatch(
    workflow.split('## Phase 3:')[1].split('## Phase 4:')[0],
    /Base language LCID; default to English/,
  );
  assert.match(customization, /newSiteDesign/);
  assert.match(customization, /newSiteDesign\.imageDelivery: "external-url"/);
  assert.match(customization, /exact URL in the consumer's static/);
  assert.match(customization, /at least one relevant content photograph or original illustration/);
  assert.match(customization, /Supply the approved `designContext`/);
  assert.match(customization, /exact-diff\/hash approval is a separate binding/);
  assert.match(customization, /No dev server, live preview/);
});

test('non-SPA authors preserve Bootstrap conventions and do not gate CSS on display order', () => {
  const webFile = readClassicReference('author-web-file');
  const sections = read(path.join('skills', 'author-webpage-content',
    'references', 'design-studio-section-layouts.md'));
  const content = read(path.join('skills', 'author-webpage-content', 'SKILL.md'));
  assert.match(webFile, /higher priority than `theme\.css` and lower priority than `portalbasictheme\.css`/);
  assert.match(webFile, /advisory, not an `adx_displayorder`\/`displayorder` constraint/);
  assert.match(webFile, /Omit `displayorder` on new CSS Web Files/);
  assert.doesNotMatch(webFile, /Keep display-order values deliberate|Update `adx_displayorder` after/);
  assert.match(sections, /Bootstrap 5 new-section examples/);
  assert.match(sections, /Bootstrap 3 site with no comparable section/);
  assert.match(sections, /`text-left` rather than/);
  assert.match(sections, /RTL\/language/);
  assert.match(content, /verified Bootstrap major/);
  assert.match(content, /return missing evidence to the caller/);
});

test('creation image URL policy reaches content planning and the non-SPA design adapter', () => {
  const assetGuide = read(path.join('skills', 'edit-site', 'references', 'visual-asset-planning.md'));
  const contentGuide = read(path.join('skills', 'edit-site', 'references', 'content-and-page-compositions.md'));
  const designGuide = read(path.join('skills', 'edit-site', 'references', 'styling', 'design-quality.md'));
  const contract = read(path.join('skills', 'edit-site', 'references', 'customization-plan-contract.md'));
  assert.match(assetGuide, /direct HTTPS URLs for added images/);
  assert.match(assetGuide, /Power Pages permissions do not protect external URLs/);
  assert.match(assetGuide, /Do not download the image to a file/);
  assert.match(contentGuide, /approved direct HTTPS URL for a new-site image addition/);
  assert.match(designGuide, /During creation, add images using direct approved HTTPS URLs/);
  assert.match(contract, /"delivery": "external-url"/);
  assert.match(contract, /"status": "remote"/);
  assert.match(contract, /"heroImageUrl": "https:\/\/cdn\.example\.com\/images\/contact-team\.jpg"/);
  for (const document of [assetGuide, contentGuide, designGuide]) {
    assert.doesNotMatch(document, /Do not hotlink the Unsplash URL|Never place an Unsplash hotlink|Deliver locally staged\/imported Web Files, not Unsplash/);
  }
});

test('non-SPA template selection and new-site handoff distinguish requirements from visual constraints', () => {
  const entry = read(path.join('skills', 'create-site', 'SKILL.md')).split('## SPA-Site Workflow')[0];
  const workflow = read(path.join('skills', 'create-site', 'workflows', 'non-spa-site.md'));
  const selection = workflow.split('## Phase 2:')[1].split('## Phase 3:')[0];
  const handoff = workflow.split('On **Customize now**')[1].split('On **Keep the template unchanged**')[0];
  for (const source of [entry, selection, handoff]) {
    assert.match(source, /data-model\/domain|domain\/data/);
    assert.match(source, /requirements/);
    assert.match(source, /not a (?:constraint|visual commitment|visual\s+constraint)/);
    assert.match(source, /preservation preferences/);
  }
  assert.match(selection, /requested capabilities and content/);
  assert.match(handoff, /newSiteDesign\.composition/);
  assert.match(handoff, /designContext/);
  assert.match(handoff, /do not default to retaining\s+the starter arrangement/);
  assert.match(
    workflow,
    /On \*\*Keep the template unchanged\*\*, do not require customization before evaluating downstream\s+needs/
  );
});

test('non-SPA planning defaults allow recomposition but preserve explicit preferences and existing-site scope', () => {
  const shared = read(path.join('references', 'site-design-quality.md'));
  const customization = read(path.join('skills', 'edit-site', 'SKILL.md'));
  const content = read(path.join('skills', 'edit-site', 'references', 'content-and-page-compositions.md'));
  const contract = read(path.join('skills', 'edit-site', 'references', 'customization-plan-contract.md'));
  const assets = read(path.join('skills', 'edit-site', 'references', 'visual-asset-planning.md'));
  const templateRole = shared.split('## Non-SPA creation templates:')[1].split('## Direction')[0];
  for (const term of ['data-model/domain', 'requirements', 'appearance', 'page composition',
    'layout', 'branding', 'presentation', 'PAC metadata', 'record identities', 'data bindings',
    'authentication', 'locale scope', 'Bootstrap/Studio-compatible serialization']) {
    assert.ok(templateRole.includes(term), term);
  }
  assert.match(templateRole, /template arrangement is not protected/);
  assert.match(templateRole, /does not turn an existing-site narrow edit into a redesign/);
  assert.match(customization, /Existing-site and narrow edits remain preservation-first/);
  assert.match(customization, /do not require separate redesign permission/);
  assert.doesNotMatch(customization, /template preservation level/);
  assert.match(content, /For existing-site work without a redesign request/);
  assert.match(content, /instead of the layout-reuse and styling\s+defaults/);
  assert.match(content, /freely recomposing supported native sections\/columns\/elements/);
  assert.match(content, /binding is a rendering contract, not the creation template's visual identity/);
  assert.doesNotMatch(content, /Keep existing native\s+color roles/);
  assert.match(contract, /`preservation`: required content\/capabilities, native contracts, and explicit user preferences/);
  assert.doesNotMatch(contract, /"preservation": "Retain the template structure/);
  assert.match(assets, /Among sources that fit the approved design/);
  assert.match(assets, /Honor explicit asset-preservation\s+preferences/);
});

test('native authors and final styling carry the approved composition without sacrificing native integrity', () => {
  const page = readClassicReference('author-webpage');
  const content = read(path.join('skills', 'author-webpage-content', 'SKILL.md'));
  const composition = read(path.join('skills', 'author-webpage-content',
    'references', 'webpage-content-composition.md'));
  const styling = read(path.join('skills', 'edit-site', 'references', 'styling', 'design-quality.md'));
  const critique = read(path.join('skills', 'edit-site', 'references', 'styling', 'design-critique.md'));
  for (const source of [page, content, composition, styling, critique]) {
    assert.match(source, /creation template/);
    assert.match(source, /designContext/);
    assert.match(source, /preservation/);
  }
  assert.match(page, /do not substitute the creation template's\s+layout or branding/);
  assert.match(content, /requires custom composition/);
  assert.match(composition, /required forms\/lists, data bindings, Liquid behavior, native markers and locale scope/);
  assert.match(composition, /never replace it with a\s+static lookalike or silently discard it/);
  assert.match(composition, /does not broaden an unrelated existing-site `append` or `modify`/);
  assert.match(styling, /native DOM delivered by structural authoring/);
  assert.match(styling, /return missing structural changes to those owners/);
  assert.match(critique, /not resemblance to the selected creation template/);
  assert.match(critique, /Do not turn an existing-site narrow edit into an unsolicited redesign/);
});

test('new-site plans require custom Home and journey layouts rather than cosmetic template changes', () => {
  const customization = read(path.join('skills', 'edit-site', 'SKILL.md'));
  const planning = read(path.join('skills', 'edit-site', 'references', 'content-and-page-compositions.md'));
  const contract = read(path.join('skills', 'edit-site', 'references', 'customization-plan-contract.md'));
  const shared = read(path.join('references', 'site-design-quality.md'));
  assert.match(shared, /custom design and layout are required, not merely permitted/i);
  assert.match(shared, /forms, lists, content snippets/);
  assert.match(shared, /template reskin, not the requested custom design/);
  assert.match(customization, /caller omitted the literal `creationIntent` field/);
  assert.match(customization, /not a file timestamp or the mere presence of template metadata/);
  assert.match(planning, /Inventory reusable \*\*components\*\* independently of layout/);
  assert.match(planning, /Do not use the starter outline as the default outline/);
  assert.match(planning, /Map that composition to actual native owner operations and exact source targets/);
  assert.match(planning, /required source\/bindings and explicit user exceptions in `preserve`/);
  assert.match(planning, /A preserved logo or working registration form does not\s+preserve the whole page/);
  assert.match(customization, /only copy\/image substitutions, additional pages and styling while leaving\s+the starter Home\/layout intact is incomplete/);
  assert.match(contract, /Record the proposed Home\/primary-journey sections and component destinations in actual native/);
  assert.match(contract, /a non-empty brief or a passing validator alone is insufficient/);
  assert.match(contract, /Do not add dummy structural operations/);
});

test('component reuse preserves existing source without forcing the surrounding template layout', () => {
  const composition = read(path.join('skills', 'author-webpage-content',
    'references', 'webpage-content-composition.md'));
  const pageTemplate = readClassicReference('author-page-template');
  const webTemplate = readClassicReference('author-web-template');
  const planning = read(path.join('skills', 'edit-site', 'references', 'content-and-page-compositions.md'));
  assert.match(planning, /Do not create `type: form`, `type: list` or `type: reuse`/);
  assert.match(composition, /exact existing source boundary or Liquid\/snippet\s+reference and destination/);
  assert.match(composition, /dependent scripts, IDs and Liquid scope/);
  assert.match(composition, /do not regenerate a form\/list\s+as a new element type or wrap it in a text component/);
  assert.match(composition, /every requested element and reused component appears at its planned destination/);
  assert.match(pageTemplate, /table compatibility alone does not justify retaining the starter design/);
  assert.match(pageTemplate, /Carry|carry/);
  assert.match(pageTemplate, /designContext/);
  assert.match(webTemplate, /implement the custom composition in `designContext`/);
  assert.match(webTemplate, /preserving their bindings, editable regions and\s+runtime behavior/);
  assert.match(webTemplate, /without dropping\s+authentication\/navigation branches or changing the website binding implicitly/);
});

test('new-site layout work may remove unneeded starter sections and component placements without deleting records', () => {
  const shared = read(path.join('references', 'site-design-quality.md'));
  const creation = read(path.join('skills', 'create-site', 'workflows', 'non-spa-site.md'));
  const customization = read(path.join('skills', 'edit-site', 'SKILL.md'));
  const planning = read(path.join('skills', 'edit-site', 'references', 'content-and-page-compositions.md'));
  const contract = read(path.join('skills', 'edit-site', 'references', 'customization-plan-contract.md'));
  const content = read(path.join('skills', 'author-webpage-content', 'SKILL.md'));
  const composition = read(path.join('skills', 'author-webpage-content',
    'references', 'webpage-content-composition.md'));
  const webTemplate = readClassicReference('author-web-template');
  assert.match(shared, /remove, replace or reorder unneeded out-of-box sections and\s+components/);
  assert.match(shared, /Presence in the starter template\s+alone does not make something a requirement/);
  assert.match(creation, /Allow removal of unneeded starter sections and component placements/);
  assert.match(planning, /retain, relocate, replace or remove/);
  assert.match(planning, /what is removed and why/);
  assert.match(planning, /does not delete its definition, permissions,\s+underlying data or other callers/);
  assert.match(contract, /existing operation `summary` and `inputs`/);
  assert.match(contract, /do not add a deletion schema, delete backing records/);
  for (const owner of [content, webTemplate]) {
    assert.match(owner, /remove unneeded starter sections (?:and|or) component placements/i);
    assert.match(owner, /backing records/);
  }
  assert.match(composition, /not the wrappers of a removed section/);
  assert.match(composition, /unknown purpose or dependencies remains unresolved/);
  assert.match(composition, /does not broaden an unrelated existing-site `append` or `modify`/);
  assert.match(customization, /approved removals are absent from the authored source, not merely hidden by CSS/);
  assert.match(customization, /required components, their dependencies and explicitly preserved regions remain intact/);
});

test('the existing final review treats an unimplemented custom layout as incomplete without adding gates', () => {
  const customization = read(path.join('skills', 'edit-site', 'SKILL.md'));
  const review = customization.split('## Phase 6:')[1].split('## Phase 7:')[0];
  const styling = read(path.join('skills', 'edit-site', 'references', 'styling', 'design-quality.md'));
  const critique = read(path.join('skills', 'edit-site', 'references', 'styling', 'design-critique.md'));
  assert.match(review, /Trace the planned Home\/primary-journey section structure and reused-component placements/);
  assert.match(review, /copy\/image swaps or CSS on an unchanged starter layout do not satisfy/);
  assert.match(review, /Record missing planned composition work as incomplete/);
  assert.match(review, /changed section count or new class name alone is not evidence/);
  assert.match(styling, /report the structural dependency as incomplete before styling that surface/);
  assert.match(critique, /incomplete layout work, not a completed custom design/);
  assert.match(critique, /Do not infer success from a larger diff, or failure from missing screenshots/);
  assert.deepEqual([...customization.matchAll(/<!-- gate: ([^ |]+)/g)].map((match) => match[1]),
    ['edit-site:4.approve', 'edit-site:7.deploy']);
  assert.match(customization, /--imageChecks "<APPROVED_REVIEW_DIR>\/plan.html.image-checks.json"/);
  assert.match(customization, /exact-diff\/hash approval is a separate binding/);
});

test('non-SPA webpage composition supports the Generative AI Search component', () => {
  const content = read(path.join('skills', 'author-webpage-content', 'SKILL.md'));
  const composition = read(path.join('skills', 'author-webpage-content',
    'references', 'webpage-content-composition.md'));
  const search = read(path.join('skills', 'author-webpage-content',
    'references', 'design-studio-generative-ai-search-component.md'));

  assert.match(content, /design-studio-generative-ai-search-component\.md/);
  assert.match(content, /Generative AI Search components/);
  assert.match(content, /Do not substitute\s+`\{% include 'Search' %\}`/);
  assert.match(composition, /Generative AI Search component/);
  assert.match(search, /^# Generative AI Search Component$/m);
  assert.match(search, /Use this reference only to add or edit/);
  assert.match(search, /Do not use it for `\{% include 'Search' %\}`/);
  assert.match(search, /Search web templates, Search content snippets/);
  assert.match(search, /\{% codecomponent name:Pages\.SearchSummary enableRedirectToSearchPage:'true' %\}/);
  assert.match(search, /\{% codecomponent name:Pages\.SearchSummary %\}/);
  assert.match(search, /Attributes are independently composable/);
  assert.match(search, /Allow multiple instances/);
  assert.match(search, /Do not impose a column width, breakpoint, padding, or margin/);
  assert.match(search, /Show results inline \| `enableRedirectToSearchPage` \| `'false'`/);
  assert.match(search, /Redirect to the Search Results page \| `enableRedirectToSearchPage` \| `'true'`/);
  assert.match(search, /`searchResultHeading`/);
  assert.match(search, /Search Results page only/);
  assert.match(search, /Base64-encoded JSON/);
  assert.match(search, /"SearchBar": \{\}/);
  assert.match(search, /Preserve unknown sectors and properties/);
  assert.match(search, /Preserve existing `enableFeedback`, `enableFollowUpActions`/);
  assert.match(search, /Treat it as a leaf component/);
  assert.doesNotMatch(search, /## Studio toolbar|## Design panel/);
  assert.match(search, /Faceted search is unavailable/);
  assert.match(search, /Dataverse search must be enabled for the environment/);
  assert.match(search, /\*\*Enable Site search with generative AI\*\* must be on/);
  assert.match(search, /Tenant governance must allow generative AI usage/);
  assert.match(search, /available for the website's region and language/);
  assert.match(search, /search index must be provisioned and synchronized/);
  assert.match(search, /Redirect mode requires a valid page assigned to the `Search` site marker/);
  assert.match(search, /uses `id` as its record query-string parameter/);
  assert.match(search, /Report\s+environment, tenant, region\/language, or index readiness/);
  assert.match(search, /\[Add a search component\]\(https:\/\/learn\.microsoft\.com\/power-pages\/getting-started\/add-search\)/);
  assert.match(search, /\[Power Pages search with generative AI\]\(https:\/\/learn\.microsoft\.com\/power-pages\/configure\/search\/generative-ai\)/);
});
