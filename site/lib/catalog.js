'use strict';

// Loads site/catalog.json and checks it against the marketplace, so the site cannot drift
// from what users can actually install. The catalog holds only the plain-language content
// that no manifest carries (who a plugin is for, example prompts, prerequisites); names,
// versions and sources always come from marketplace.json and each plugin's manifest.

const fs = require('node:fs');
const path = require('node:path');
const { isValidPluginName } = require('./install-links.js');

const AUDIENCES = new Set(['makers', 'developers', 'both']);
const STATUSES = new Set([null, 'preview', 'private-preview']);

// The Microsoft product each plugin works with, shown as the product's official icon with its
// full name beside it. Microsoft's icon terms require the name near the icon and allow an icon
// only for the product it was designed for, so the label here must be that product's name.
// Icons: https://learn.microsoft.com/power-platform/guidance/icons (see site/assets/brand/README.md)
const PRODUCTS = {
  'power-pages': { label: 'Power Pages', icon: 'assets/brand/power-pages.svg' },
  'power-apps': { label: 'Power Apps', icon: 'assets/brand/power-apps.svg' },
  'power-automate': { label: 'Power Automate', icon: 'assets/brand/power-automate.svg' },
  dataverse: { label: 'Dataverse', icon: 'assets/brand/dataverse.svg' },
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isHttpsUrl(value) {
  if (!isNonEmptyString(value)) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

// Collects every problem instead of stopping at the first, so one CI run reports the whole
// list when someone adds a plugin to the marketplace without a catalog entry.
function loadCatalog(repoRoot) {
  const marketplace = readJson(path.join(repoRoot, 'marketplace.json'));
  const catalog = readJson(path.join(repoRoot, 'site', 'catalog.json'));
  const problems = [];

  const goals = Array.isArray(catalog.goals) ? catalog.goals : [];
  const goalIds = new Set();
  for (const goal of goals) {
    if (!isNonEmptyString(goal.id) || !isNonEmptyString(goal.title) || !isNonEmptyString(goal.summary)) {
      problems.push(`goal ${JSON.stringify(goal.id)} needs an id, title and summary`);
      continue;
    }
    if (goalIds.has(goal.id)) problems.push(`goal ${goal.id} is listed twice`);
    goalIds.add(goal.id);
  }

  const marketplaceEntries = new Map(marketplace.plugins.map((entry) => [entry.name, entry]));
  const catalogPlugins = Array.isArray(catalog.plugins) ? catalog.plugins : [];
  const seen = new Set();
  const plugins = [];

  for (const entry of catalogPlugins) {
    const name = entry && entry.name;
    const where = `plugin ${JSON.stringify(name)}`;
    if (!isValidPluginName(name)) {
      problems.push(`${where} has an invalid name`);
      continue;
    }
    if (seen.has(name)) problems.push(`${where} is listed twice`);
    seen.add(name);

    const source = marketplaceEntries.get(name);
    if (!source) {
      problems.push(`${where} is in site/catalog.json but not in marketplace.json`);
      continue;
    }

    if (!isNonEmptyString(entry.title)) problems.push(`${where} needs a title`);
    if (!isNonEmptyString(entry.summary)) problems.push(`${where} needs a summary`);
    if (!goalIds.has(entry.goal)) problems.push(`${where} uses unknown goal ${JSON.stringify(entry.goal)}`);
    if (!AUDIENCES.has(entry.audience)) problems.push(`${where} has unknown audience ${JSON.stringify(entry.audience)}`);
    if (!STATUSES.has(entry.status)) problems.push(`${where} has unknown status ${JSON.stringify(entry.status)}`);
    if (!Object.prototype.hasOwnProperty.call(PRODUCTS, entry.product)) problems.push(`${where} has unknown product ${JSON.stringify(entry.product)}`);
    for (const field of ['prompts', 'requirements', 'notes']) {
      if (!Array.isArray(entry[field]) || !entry[field].every(isNonEmptyString)) {
        problems.push(`${where} needs ${field} as a list of strings`);
      }
    }
    if (Array.isArray(entry.prompts) && (entry.prompts.length < 1 || entry.prompts.length > 5)) {
      problems.push(`${where} needs 1 to 5 example prompts`);
    }
    if (!Array.isArray(entry.learn) || !entry.learn.every((link) => isNonEmptyString(link.title) && isHttpsUrl(link.url))) {
      problems.push(`${where} needs learn links with a title and an https url`);
    }

    // marketplace.json uses a "./plugins/<dir>" string for plugins in this repository and a
    // source object for external ones, e.g.
    //   { "source": "github", "repo": "microsoft/Dataverse-skills", "path": ".github/plugins/dataverse" }
    let version = null;
    let docsUrl;
    const skills = Array.isArray(entry.skills) ? entry.skills : [];
    if (typeof source.source === 'string') {
      const pluginDir = path.join(repoRoot, source.source);
      const manifest = readJson(path.join(pluginDir, '.plugin', 'plugin.json'));
      if (manifest.name !== name) problems.push(`${where} manifest is named ${JSON.stringify(manifest.name)}`);
      version = manifest.version || null;
      docsUrl = `https://github.com/microsoft/power-platform-skills/tree/main/${source.source.replace(/^\.\//, '')}`;
      for (const skill of skills) {
        if (!isNonEmptyString(skill.name) || !fs.existsSync(path.join(pluginDir, 'skills', skill.name, 'SKILL.md'))) {
          problems.push(`${where} lists skill ${JSON.stringify(skill.name)}, which has no skills/<name>/SKILL.md`);
        }
      }
      if (entry.external) problems.push(`${where} lives in this repository, so it must not set external`);
    } else {
      // External skills live in another repository, so only their shape can be checked here.
      if (!isHttpsUrl(entry.external)) problems.push(`${where} is external, so it needs an https external url`);
      docsUrl = entry.external;
      for (const skill of skills) {
        if (!isNonEmptyString(skill.name)) problems.push(`${where} has a skill with no name`);
      }
    }
    if (!skills.every((skill) => isNonEmptyString(skill.description))) {
      problems.push(`${where} needs a description for every skill`);
    }

    plugins.push({ ...entry, skills, version, docsUrl, external: Boolean(entry.external) });
  }

  for (const name of marketplaceEntries.keys()) {
    if (!seen.has(name)) problems.push(`marketplace plugin ${name} has no entry in site/catalog.json`);
  }
  for (const goal of goalIds) {
    if (!plugins.some((plugin) => plugin.goal === goal)) problems.push(`goal ${goal} has no plugins`);
  }

  const faq = Array.isArray(catalog.faq) ? catalog.faq : [];
  if (!faq.every((item) => isNonEmptyString(item.question) && isNonEmptyString(item.answer))) {
    problems.push('every faq entry needs a question and an answer');
  }

  // The transcript under the explainer video: each paragraph of narration ("spoken"), then what
  // is on screen while it is spoken ("shown"), for anyone who cannot see or play the video.
  const video = catalog.video && typeof catalog.video === 'object' ? catalog.video : {};
  const transcript = Array.isArray(video.transcript) ? video.transcript : [];
  if (transcript.length === 0 || !transcript.every((item) => isNonEmptyString(item.spoken) && isNonEmptyString(item.shown))) {
    problems.push('video.transcript needs at least one paragraph, each with spoken and shown text');
  }

  // The hero replays example sessions. Each prompt must be one of the plugin's own example
  // prompts, so the demo and the plugin page never disagree about what to ask.
  const showcase = Array.isArray(catalog.showcase) ? catalog.showcase : [];
  if (showcase.length < 1 || showcase.length > 6) problems.push('showcase needs 1 to 6 example sessions');
  for (const [index, item] of showcase.entries()) {
    const where = `showcase[${index}]`;
    const plugin = plugins.find((candidate) => candidate.name === item.plugin);
    if (!plugin) {
      problems.push(`${where} names unknown plugin ${JSON.stringify(item.plugin)}`);
      continue;
    }
    if (!Array.isArray(plugin.prompts) || !plugin.prompts.includes(item.prompt)) problems.push(`${where} prompt is not one of ${item.plugin}'s prompts`);
    if (!Array.isArray(item.steps) || item.steps.length < 2 || item.steps.length > 5 || !item.steps.every(isNonEmptyString)) {
      problems.push(`${where} needs 2 to 5 steps`);
    }
    if (item.waiting !== null && item.waiting !== undefined && !isNonEmptyString(item.waiting)) {
      problems.push(`${where} waiting must be text or null`);
    }
  }

  if (problems.length > 0) {
    const error = new Error(`site/catalog.json has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
    error.problems = problems;
    throw error;
  }

  return { goals, plugins, faq, showcase, video: { transcript } };
}

module.exports = { loadCatalog, PRODUCTS };
