const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pluginRoot = path.join(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(pluginRoot, relativePath), 'utf8');
}

test('create-site can hand a Standard or Enhanced baseline to declarative customization', () => {
  const skill = read(path.join('skills', 'create-site', 'SKILL.md'));
  const workflow = read(path.join('skills', 'create-site', 'workflows', 'declarative-site.md'));

  assert.match(skill, /allowed-tools: [^\n]*\bSkill\b/);
  assert.match(skill, /create-site:declarative-1-select-model/);
  assert.match(skill, /create-site:declarative-8-customize/);
  assert.match(workflow, /Which data model should the new declarative site use\?/);
  assert.match(workflow, /enabled for this environment\?/);
  assert.match(workflow, /disabled for this environment\?/);
  assert.match(workflow, /--modelVersion "<MODEL_VERSION>"/);
  assert.match(workflow, /verify the site reports `MODEL_VERSION`/);
  assert.match(workflow, /Would you like to customize the downloaded declarative template now\?/);
  assert.match(workflow, /invoke `\/customize-declarative-site` through the `Skill` tool/);
  assert.match(workflow, /validated, committed baseline/);
});

test('customize-declarative-site coordinates owning skills without authoring records directly', () => {
  const skill = read(path.join('skills', 'customize-declarative-site', 'SKILL.md'));
  const contract = read(path.join(
    'skills',
    'customize-declarative-site',
    'references',
    'customization-plan-contract.md'
  ));

  assert.match(skill, /user-invocable: true/);
  assert.match(skill, /author-web-file/);
  assert.match(skill, /author-content-snippet/);
  assert.match(skill, /author-web-template/);
  assert.match(skill, /author-page-template/);
  assert.match(skill, /author-webpage-content/);
  assert.match(skill, /invoke `style-site` last/);
  assert.match(skill, /does not directly author webpage, snippet, web-file, web-template, page-template/);
  assert.match(skill, /current-plan\.json/);
  assert.match(skill, /current-execution\.json/);
  assert.match(skill, /promote-customize-declarative-site-plan\.js/);
  assert.match(skill, /content-and-page-compositions\.md/);
  assert.match(skill, /visual-asset-planning\.md/);
  assert.match(skill, /prepare-declarative-asset\.js/);
  assert.match(skill, /WebSearch/);
  assert.match(skill, /Do not generate raster images or use another stock provider/);
  assert.match(skill, /outputBindings/);
  assert.match(skill, /--action resolve/);
  assert.match(skill, /publish the approved JSON/);
  assert.match(skill, /--imageChecks "<APPROVED_REVIEW_DIR>\/plan.html.image-checks.json"/);
  assert.match(skill, /If a check fails, do not request approval/);
  assert.match(skill, /reuse these source checks for unchanged URLs/);
  assert.match(contract, /External-image plans cannot be newly\s+published without matching successful results/);
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

test('classic Unsplash sourcing follows SPA discovery without a photo-page or attribution gate', () => {
  const skill = read(path.join('skills', 'customize-declarative-site', 'SKILL.md'));
  const assets = read(path.join('skills', 'customize-declarative-site', 'references', 'visual-asset-planning.md'));
  const contract = read(path.join('skills', 'customize-declarative-site', 'references', 'customization-plan-contract.md'));
  assert.match(skill, /WebSearch-to-CDN flow, as in SPA creation/);
  assert.match(skill, /without requiring a photo-page fetch or photographer\s+lookup/);
  assert.match(skill, /renderer still verifies final external URLs before producing approval artifacts/);
  assert.match(assets, /same \*\*WebSearch-to-CDN\*\* sourcing approach as SPA creation/);
  assert.match(assets, /do not require a photo-page fetch, scraping, API credentials, or a\s+photographer lookup/);
  assert.match(assets, /otherwise omit them rather than inventing attribution/);
  assert.match(assets, /anti-bot challenge[\s\S]*is not evidence that\s+`images\.unsplash\.com` is unavailable/);
  assert.match(assets, /Do not bypass the challenge/);
  assert.match(assets, /failed CDN image check still blocks approval HTML/);
  assert.match(contract, /`source\.sourcePage` and `source\.photographer`\s+are optional/);
  assert.match(contract, /does not relax the final direct-image check or exact-plan `--imageChecks`/);
  assert.doesNotMatch(assets, /Record both:|Extract the actual CDN resource URL from that photo's source evidence/);
});

test('deploy-site keeps code and declarative upload commands isolated', () => {
  const skill = read(path.join('skills', 'deploy-site', 'SKILL.md'));
  const declarative = read(path.join('skills', 'deploy-site', 'workflows', 'declarative-site.md'));

  assert.match(skill, /Site-Type Routing/);
  assert.match(skill, /pac pages upload-code-site --rootPath/);
  assert.match(skill, /Do not continue into the\s+code-site phases below/);
  assert.match(declarative, /Use `pac pages upload`, never `pac pages upload-code-site`/);
  assert.match(declarative, /--modelVersion "<Enhanced\|Standard>"/);
  assert.match(declarative, /Data model: Pending verification/);
  assert.match(declarative, /First upload — create site records/);
  assert.match(declarative, /Which data model should be used for the first upload\?/);
  assert.match(declarative, /Do not recommend, preselect, or silently default either model/);
  assert.match(declarative, /different website record with the same site name/);
  assert.match(declarative, /Create this declarative site in the selected\s+environment using the chosen data model\?/);
  assert.match(declarative, /--websiteRecordId "<WEBSITE_RECORD_ID>"/);
  assert.match(declarative, /--siteRoot "<PROJECT_RELATIVE_SITE_ROOT>"/);
  assert.match(declarative, /Do not invoke `activate-site`/);
  assert.match(declarative, /deploy-site:declarative-5.upload/);
});

test('classic creation uses verified Bootstrap 5 and image-rich design without SPA preview requirements', () => {
  const skill = read(path.join('skills', 'create-site', 'SKILL.md'));
  const workflow = read(path.join('skills', 'create-site', 'workflows', 'declarative-site.md'));
  const customization = read(path.join('skills', 'customize-declarative-site', 'SKILL.md'));
  const common = skill.split('## Code-Site Workflow')[0];
  assert.match(common, /references\/site-design-quality\.md/);
  assert.match(common, /Classic sites need no dev server or live preview/);
  assert.doesNotMatch(common, /dev server MUST|scaffold-status\.json|images\.unsplash\.com\/photo-/);
  assert.match(workflow, /Enhanced with Bootstrap 5 \(Recommended\)/);
  assert.match(workflow, /Standard with Bootstrap 3 compatibility/);
  assert.match(workflow, /--bootstrapVersion "<BOOTSTRAP_VERSION>"/);
  assert.match(workflow, /filtered `catalog\.templates`/);
  assert.match(workflow, /catalog\.bootstrapCompatibility/);
  assert.match(workflow, /no model or Bootstrap-version field/);
  assert.match(workflow, /Do not recreate it/);
  assert.match(workflow, /creationIntent: "new-site"/);
  assert.match(workflow, /verifiedBootstrapMajor/);
  assert.match(workflow, /imageDelivery: "external-url"/);
  assert.match(workflow, /Skip image staging\/downloads/);
  assert.match(customization, /newSiteDesign/);
  assert.match(customization, /newSiteDesign\.imageDelivery: "external-url"/);
  assert.match(customization, /exact URL in the consumer's static/);
  assert.match(customization, /at least one relevant content photograph or original illustration/);
  assert.match(customization, /`designContext` to its owning skill/);
  assert.match(customization, /exact-diff\/hash approval is a separate binding/);
  assert.match(customization, /No dev server, live preview/);
});

test('classic authors preserve Bootstrap conventions and do not gate CSS on display order', () => {
  const webFile = read(path.join('skills', 'classic-site-skills', 'author-web-file',
    'references', 'design-studio-web-file-authoring.md'));
  const sections = read(path.join('skills', 'classic-site-skills', 'page-elements',
    'references', 'design-studio-section-layouts.md'));
  const content = read(path.join('skills', 'classic-site-skills', 'author-webpage-content', 'SKILL.md'));
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

test('creation image URL policy reaches content planning and the classic design adapter', () => {
  const assetGuide = read(path.join('skills', 'customize-declarative-site', 'references', 'visual-asset-planning.md'));
  const contentGuide = read(path.join('skills', 'customize-declarative-site', 'references', 'content-and-page-compositions.md'));
  const designGuide = read(path.join('skills', 'style-site', 'references', 'design-quality.md'));
  const contract = read(path.join('skills', 'customize-declarative-site', 'references', 'customization-plan-contract.md'));
  assert.match(assetGuide, /direct HTTPS URLs for added images/);
  assert.match(assetGuide, /Power Pages permissions do not protect external URLs/);
  assert.match(assetGuide, /Do not download it/);
  assert.match(contentGuide, /approved direct HTTPS URL for a new-site image addition/);
  assert.match(designGuide, /During creation, add images using direct approved HTTPS URLs/);
  assert.match(contract, /"delivery": "external-url"/);
  assert.match(contract, /"status": "remote"/);
  assert.match(contract, /"heroImageUrl": "https:\/\/cdn\.example\.com\/images\/contact-team\.jpg"/);
  for (const document of [assetGuide, contentGuide, designGuide]) {
    assert.doesNotMatch(document, /Do not hotlink the Unsplash URL|Never place an Unsplash hotlink|Deliver locally staged\/imported Web Files, not Unsplash/);
  }
});

test('classic template selection and new-site handoff distinguish requirements from visual constraints', () => {
  const entry = read(path.join('skills', 'create-site', 'SKILL.md')).split('## Code-Site Workflow')[0];
  const workflow = read(path.join('skills', 'create-site', 'workflows', 'declarative-site.md'));
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
  assert.match(workflow, /On \*\*Keep the template unchanged\*\*, finish/);
});

test('classic planning defaults allow recomposition but preserve explicit preferences and existing-site scope', () => {
  const shared = read(path.join('references', 'site-design-quality.md'));
  const customization = read(path.join('skills', 'customize-declarative-site', 'SKILL.md'));
  const content = read(path.join('skills', 'customize-declarative-site', 'references', 'content-and-page-compositions.md'));
  const contract = read(path.join('skills', 'customize-declarative-site', 'references', 'customization-plan-contract.md'));
  const assets = read(path.join('skills', 'customize-declarative-site', 'references', 'visual-asset-planning.md'));
  const templateRole = shared.split('## Classic creation templates:')[1].split('## Direction')[0];
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
  const page = read(path.join('skills', 'classic-site-skills', 'author-webpage', 'SKILL.md'));
  const content = read(path.join('skills', 'classic-site-skills', 'author-webpage-content', 'SKILL.md'));
  const composition = read(path.join('skills', 'classic-site-skills', 'author-webpage-content',
    'references', 'webpage-content-composition.md'));
  const styling = read(path.join('skills', 'style-site', 'references', 'design-quality.md'));
  const critique = read(path.join('skills', 'style-site', 'references', 'design-critique.md'));
  for (const source of [page, content, composition, styling, critique]) {
    assert.match(source, /creation template/);
    assert.match(source, /designContext/);
    assert.match(source, /preservation/);
  }
  assert.match(page, /do not substitute the creation template's layout or branding/);
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
  const customization = read(path.join('skills', 'customize-declarative-site', 'SKILL.md'));
  const planning = read(path.join('skills', 'customize-declarative-site', 'references', 'content-and-page-compositions.md'));
  const contract = read(path.join('skills', 'customize-declarative-site', 'references', 'customization-plan-contract.md'));
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
  const composition = read(path.join('skills', 'classic-site-skills', 'author-webpage-content',
    'references', 'webpage-content-composition.md'));
  const pageTemplate = read(path.join('skills', 'classic-site-skills', 'author-page-template', 'SKILL.md'));
  const webTemplate = read(path.join('skills', 'classic-site-skills', 'author-web-template', 'SKILL.md'));
  const planning = read(path.join('skills', 'customize-declarative-site', 'references', 'content-and-page-compositions.md'));
  assert.match(planning, /Do not create `type: form`, `type: list` or `type: reuse`/);
  assert.match(composition, /exact existing source boundary or Liquid\/snippet\s+reference and destination/);
  assert.match(composition, /dependent scripts, IDs and Liquid scope/);
  assert.match(composition, /do not regenerate a form\/list\s+as a new element type or wrap it in a text component/);
  assert.match(composition, /every requested element and reused component appears at its planned destination/);
  assert.match(pageTemplate, /table compatibility alone does not justify retaining the starter design/);
  assert.match(pageTemplate, /Carry|carry/);
  assert.match(pageTemplate, /designContext/);
  assert.match(webTemplate, /implement the custom composition in `designContext`/);
  assert.match(webTemplate, /preserving their\s+bindings, editable regions and runtime behavior/);
  assert.match(webTemplate, /does not require changing the website binding or dropping authentication\/navigation branches/);
});

test('new-site layout work may remove unneeded starter sections and component placements without deleting records', () => {
  const shared = read(path.join('references', 'site-design-quality.md'));
  const creation = read(path.join('skills', 'create-site', 'workflows', 'declarative-site.md'));
  const customization = read(path.join('skills', 'customize-declarative-site', 'SKILL.md'));
  const planning = read(path.join('skills', 'customize-declarative-site', 'references', 'content-and-page-compositions.md'));
  const contract = read(path.join('skills', 'customize-declarative-site', 'references', 'customization-plan-contract.md'));
  const content = read(path.join('skills', 'classic-site-skills', 'author-webpage-content', 'SKILL.md'));
  const composition = read(path.join('skills', 'classic-site-skills', 'author-webpage-content',
    'references', 'webpage-content-composition.md'));
  const webTemplate = read(path.join('skills', 'classic-site-skills', 'author-web-template', 'SKILL.md'));
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
  const customization = read(path.join('skills', 'customize-declarative-site', 'SKILL.md'));
  const review = customization.split('## Phase 6:')[1].split('## Phase 7:')[0];
  const styling = read(path.join('skills', 'style-site', 'references', 'design-quality.md'));
  const critique = read(path.join('skills', 'style-site', 'references', 'design-critique.md'));
  assert.match(review, /Trace the planned Home\/primary-journey section structure and reused-component placements/);
  assert.match(review, /copy\/image swaps or CSS on an unchanged starter layout do not satisfy/);
  assert.match(review, /Record missing planned composition work as incomplete/);
  assert.match(review, /changed section count or new class name alone is not evidence/);
  assert.match(styling, /report the structural dependency as incomplete before styling that surface/);
  assert.match(critique, /incomplete layout work, not a completed custom design/);
  assert.match(critique, /Do not infer success from a larger diff, or failure from missing screenshots/);
  assert.deepEqual([...customization.matchAll(/<!-- gate: ([^ |]+)/g)].map((match) => match[1]),
    ['customize-declarative-site:4.approve', 'customize-declarative-site:7.deploy']);
  assert.match(customization, /--imageChecks "<APPROVED_REVIEW_DIR>\/plan.html.image-checks.json"/);
  assert.match(customization, /exact-diff\/hash approval is a separate binding/);
});
