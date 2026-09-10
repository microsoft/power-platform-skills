#!/usr/bin/env node
'use strict';

// Detects the Power Pages template a downloaded SDM site was created from, so the
// migration can ensure the matching Enhanced (V2) solution is installed.
//
// Two indicators, resolved in order:
//   1. Site inspection  — identifies the three D365 portals that ship distinctive
//                         built-in components (Community, Employee Self-Service, Partner)
//                         directly from the downloaded site source.
//   2. Installed anchor solution — the template ("anchor") solution present in the
//                         environment is the source of truth. Covers Customer
//                         Self-Service + the medium templates (FAQ, Building Permit,
//                         Program Registration, Book Meeting), and confirms/overrides
//                         the site-inspection result for the D365 portals.
//
// If neither indicator resolves a template, the site is treated as low-complexity
// (Blank / Starter Layout) and no template package is installed.
//
// Usage:
//   node detect-template.js --site-root <path-to-downloaded-sdm-site>
//                           [--solutions "<comma,separated,uniquenames>"]
//                           [--solutions-file <path-to-pac-solution-list-output>]
//                           [--pretty]
//
// Output: JSON resolution to stdout. Exit 0 on success, 1 on failure.

const fs = require('fs');
const path = require('path');

// D365 portals — have a site-inspection signal (except CSS) AND an anchor solution.
const D365 = {
  Community:           { anchor: 'CommunityPortal', v2: 'PowerPages_CommunityPortal_V2', label: 'Community Portal' },
  CustomerSelfService: { anchor: 'CustomerPortal',  v2: 'PowerPages_CustomerPortal_V2',  label: 'Customer Self-Service Portal' },
  EmployeeSelfService: { anchor: 'ESSPortal',       v2: 'PowerPages_ESSPortal_V2',       label: 'Employee Self-Service Portal' },
  Partner:             { anchor: 'PartnerPortal',   v2: 'PowerPages_PartnerPortal_V2',   label: 'Partner Portal' },
};

// Medium templates — no reliable site-inspection signal; detected by anchor solution only.
const MEDIUM = {
  FAQ:                    { anchor: 'PowerPages_FAQ',                     v2: 'PowerPages_FAQ_V2',                 label: 'FAQ' },
  ScheduleManageMeetings: { anchor: 'PowerPortals_BookMeeting',          v2: 'PowerPages_BookMeeting_V2',         label: 'Schedule and Manage Meetings' },
  ApplicationProcessing:  { anchor: 'PowerPages_BuildingPermit',         v2: 'PowerPages_BuildingPermit_V2',      label: 'Application Processing (Building Permit)' },
  ProgramRegistration:    { anchor: 'PowerPortals_ProgramRegistrationCore', v2: 'PowerPages_ProgramRegistration_V2', label: 'Program Registration' },
};

// D365 anchor solutions (for the anchor-primary resolution of Community/ESS/Partner).
const D365_ANCHORS = Object.values(D365).map((t) => t.anchor);

// "Group B" anchors — detected purely by installed solution: CSS + all medium templates.
const GROUP_B_ANCHORS = [
  D365.CustomerSelfService.anchor,
  ...Object.values(MEDIUM).map((t) => t.anchor),
];

function parseArgs(argv) {
  const out = { siteRoot: null, solutions: [], solutionsFile: null, pretty: false };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--site-root' && args[i + 1]) out.siteRoot = args[++i];
    else if (args[i] === '--solutions' && args[i + 1]) {
      out.solutions = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (args[i] === '--solutions-file' && args[i + 1]) out.solutionsFile = args[++i];
    else if (args[i] === '--pretty') out.pretty = true;
  }
  return out;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Site inspection — returns the D365 portal recognizable from distinctive built-in
 * components, or null. Order matters: Partner (keyed roles) is the most specific.
 */
function inspectSite(siteRoot) {
  const signals = [];

  // Partner — dedicated partner web roles with fixed keys (stable across installs).
  const webrole = readText(path.join(siteRoot, 'webrole.yml'));
  if (/adx_key:\s*(partneradmin|partnermanager|partnerseller|nonpartneruser)\b/i.test(webrole)) {
    signals.push('partner web roles (partneradmin / partnermanager / partnerseller / nonpartneruser)');
    return { match: 'Partner', signals };
  }

  // Community — blog AND idea web pages (use web-pages/ nodes, NOT the root blogs/
  // folder, which every exported site has as record scaffolding).
  const webPages = path.join(siteRoot, 'web-pages');
  if (dirExists(path.join(webPages, 'blogs')) && dirExists(path.join(webPages, 'ideas'))) {
    signals.push('web-pages/blogs and web-pages/ideas present');
    return { match: 'Community', signals };
  }
  if (/adx_name:\s*Blog Authors\b/i.test(webrole) && dirExists(path.join(webPages, 'blogs'))) {
    signals.push('"Blog Authors" web role with blog pages');
    return { match: 'Community', signals };
  }

  // Employee Self-Service — license-specific access-denied page/marker.
  const sitemarker = readText(path.join(siteRoot, 'sitemarker.yml'));
  if (
    /adx_name:\s*Access Denied - Missing License\b/i.test(sitemarker) ||
    dirExists(path.join(webPages, 'access-denied---missing-license'))
  ) {
    signals.push('"Access Denied - Missing License" site marker / page');
    return { match: 'EmployeeSelfService', signals };
  }

  return { match: null, signals };
}

function loadInstalledSolutions(opts) {
  const found = new Set(opts.solutions.map((s) => s));
  if (opts.solutionsFile) {
    const text = readText(opts.solutionsFile);
    // Scan for each known anchor uniquename regardless of pac output formatting.
    const known = [...D365_ANCHORS, ...GROUP_B_ANCHORS];
    for (const name of known) {
      const re = new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`, 'm');
      if (re.test(text)) found.add(name);
    }
  }
  return [...found];
}

function anchorToTemplate(anchor) {
  const all = { ...D365, ...MEDIUM };
  for (const [key, val] of Object.entries(all)) {
    if (val.anchor.toLowerCase() === String(anchor).toLowerCase()) return { key, ...val };
  }
  return null;
}

function resolve(inspection, installed) {
  const installedLc = new Set(installed.map((s) => s.toLowerCase()));
  const has = (u) => installedLc.has(String(u).toLowerCase());

  const d365Present = D365_ANCHORS.filter(has);
  const groupBPresent = GROUP_B_ANCHORS.filter(has);

  if (inspection.match) {
    const pos = D365[inspection.match];

    // Exactly one D365 anchor present — anchor wins even if it disagrees with inspection.
    if (d365Present.length === 1) {
      const t = anchorToTemplate(d365Present[0]);
      const agrees = d365Present[0].toLowerCase() === pos.anchor.toLowerCase();
      return {
        decision: 'install-v2',
        template: t.label,
        templateKey: t.key,
        v1Anchor: t.anchor,
        v2Package: t.v2,
        method: 'site-inspection + single installed anchor (anchor authoritative)',
        agreement: agrees ? 'inspection and anchor agree' : `anchor overrides inspection (inspection suggested ${pos.label})`,
        needsPrompt: false,
      };
    }

    // Multiple D365 anchors present — site inspection breaks the tie.
    if (d365Present.length >= 2) {
      if (d365Present.some((a) => a.toLowerCase() === pos.anchor.toLowerCase())) {
        return {
          decision: 'install-v2',
          template: pos.label,
          templateKey: inspection.match,
          v1Anchor: pos.anchor,
          v2Package: pos.v2,
          method: 'multiple anchors present; site inspection broke the tie',
          needsPrompt: false,
        };
      }
      return {
        decision: 'prompt-pick',
        needsPrompt: true,
        promptReason: 'multiple template solutions installed and none match the site',
        candidates: d365Present.map(anchorToTemplate),
      };
    }

    // No D365 anchor installed — confirm with the user before installing.
    return {
      decision: 'prompt-confirm',
      needsPrompt: true,
      promptReason: `the site looks like ${pos.label}, but its template solution is not installed in this environment`,
      confirmTemplate: pos.label,
      confirmTemplateKey: inspection.match,
      v1Anchor: pos.anchor,
      v2Package: pos.v2,
      onConfirm: { decision: 'install-v2', v2Package: pos.v2 },
      onDecline: { decision: 'low-complexity-skip' },
    };
  }

  // No positive site inspection — decide purely by installed anchor solution.
  if (groupBPresent.length === 1) {
    const t = anchorToTemplate(groupBPresent[0]);
    return {
      decision: 'install-v2',
      template: t.label,
      templateKey: t.key,
      v1Anchor: t.anchor,
      v2Package: t.v2,
      method: 'installed anchor solution (single)',
      needsPrompt: false,
    };
  }
  if (groupBPresent.length >= 2) {
    return {
      decision: 'prompt-pick-or-install-all',
      needsPrompt: true,
      promptReason: 'multiple template solutions are installed and the site is not distinctive',
      candidates: groupBPresent.map(anchorToTemplate),
    };
  }

  return {
    decision: 'low-complexity-skip',
    needsPrompt: false,
    template: 'Low-complexity (Blank Page / Starter Layout)',
    v2Package: null,
    method: 'no template anchor solution present',
  };
}

function main() {
  const opts = parseArgs(process.argv);
  if (!opts.siteRoot) {
    process.stderr.write('ERROR: --site-root is required\n');
    process.exit(1);
  }
  if (!dirExists(opts.siteRoot)) {
    process.stderr.write(`ERROR: site root not found or not a directory: ${opts.siteRoot}\n`);
    process.exit(1);
  }

  const inspection = inspectSite(opts.siteRoot);
  const installed = loadInstalledSolutions(opts);
  const resolution = resolve(inspection, installed);

  const result = {
    siteRoot: opts.siteRoot,
    inspection,
    installedAnchors: installed,
    resolution,
  };

  process.stdout.write(JSON.stringify(result, null, opts.pretty ? 2 : 0) + '\n');
}

main();
