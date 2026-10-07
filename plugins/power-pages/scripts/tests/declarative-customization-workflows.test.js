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
  assert.match(contract, /Unsplash assets retain their photo page/);
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
  assert.match(content, /may replace or recompose/);
  assert.match(composition, /required forms\/lists, data bindings, Liquid behavior, native markers and locale scope/);
  assert.match(composition, /never replace it with a\s+static lookalike or silently discard it/);
  assert.match(composition, /does not broaden an unrelated existing-site `append` or `modify`/);
  assert.match(styling, /native DOM delivered by structural authoring/);
  assert.match(styling, /return missing structural changes to those owners/);
  assert.match(critique, /not resemblance to the selected creation template/);
  assert.match(critique, /Do not turn an existing-site narrow edit into an unsolicited redesign/);
});
