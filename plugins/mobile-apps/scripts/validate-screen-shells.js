#!/usr/bin/env node
'use strict';

/**
 * Enforce the route-shell contract emitted in .tmp/screen-build-pack.json.
 * Root layout owns SafeAreaProvider context only; each app route owns exactly
 * one ScreenShell, which in turn owns top and bottom content insets.
 */

const fs = require('node:fs');
const path = require('node:path');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeRelativePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function parseArgs(argv) {
  const args = { report: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--pack') args.pack = argv[++index];
    else if (argv[index] === '--report') args.report = true;
  }
  return args;
}

function screenShellIssues(projectRoot, pack) {
  const issues = [];
  if (pack?.fixtures?.assetManifest) {
    const assetManifestPath = path.join(projectRoot, normalizeRelativePath(pack.fixtures.assetManifest));
    if (!fs.existsSync(assetManifestPath)) {
      issues.push({
        rule: 'missing-local-asset-manifest',
        file: normalizeRelativePath(pack.fixtures.assetManifest),
        message: 'The build pack requires a materialized local illustration manifest before native route validation.',
      });
    } else {
      try {
        const manifest = readJson(assetManifestPath);
        if (!manifest?.assets || !manifest?.fallbacks) {
          issues.push({
            rule: 'invalid-local-asset-manifest',
            file: normalizeRelativePath(pack.fixtures.assetManifest),
            message: 'Local illustration manifest must expose assets and entity fallback recipes.',
          });
        }
      } catch (error) {
        issues.push({
          rule: 'invalid-local-asset-manifest',
          file: normalizeRelativePath(pack.fixtures.assetManifest),
          message: `Local illustration manifest is not valid JSON: ${error.message}`,
        });
      }
    }
  }
  if (pack?.fixtures?.viewModel) {
    const viewModelPath = path.join(projectRoot, normalizeRelativePath(pack.fixtures.viewModel));
    if (!fs.existsSync(viewModelPath)) {
      issues.push({
        rule: 'missing-experience-view-model',
        file: normalizeRelativePath(pack.fixtures.viewModel),
        message: 'The build pack requires a materialized stable-ID experience view model before native route validation.',
      });
    } else {
      const content = fs.readFileSync(viewModelPath, 'utf8');
      if (!/export function toExperienceRecord\b/.test(content)
        || !/export function getExperienceAsset\b/.test(content)
        || !/export function isExperienceRecordActionable\b/.test(content)
        || !/export function relatedExperienceRecords\b/.test(content)) {
        issues.push({
          rule: 'invalid-experience-view-model',
          file: normalizeRelativePath(pack.fixtures.viewModel),
          message: 'Experience view model must expose canonical record, availability, relationship, and local asset adapters.',
        });
      }
    }
  }
  const rootLayout = path.join(projectRoot, 'app', '_layout.tsx');
  if (fs.existsSync(rootLayout)) {
    const rootContent = fs.readFileSync(rootLayout, 'utf8');
    if (/<SafeAreaView\b[^>]*>[\s\S]{0,600}<Slot\s*\/>[\s\S]{0,600}<\/SafeAreaView>/.test(rootContent)) {
      issues.push({
        rule: 'root-safe-area-slot-wrapper',
        file: 'app/_layout.tsx',
        message: 'Root layout wraps Slot in SafeAreaView; SafeAreaProvider is context-only and routes own insets through ScreenShell.',
      });
    }
  }

  for (const screen of pack?.screens || []) {
    const relativePath = normalizeRelativePath(screen.file);
    const filePath = path.join(projectRoot, relativePath);
    if (!relativePath || !fs.existsSync(filePath)) {
      issues.push({
        rule: 'packed-screen-missing',
        file: relativePath || screen.route || '<unknown>',
        message: 'A screen declared in the build pack is missing from the project.',
      });
      continue;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    if (!/<ScreenShell\b/.test(content)) {
      issues.push({
        rule: 'missing-screen-shell',
        file: relativePath,
        message: 'Packed route must use ScreenShell as its single safe-area and header owner.',
      });
    }
    if (/<SafeAreaView\b/.test(content)) {
      issues.push({
        rule: 'duplicate-route-safe-area',
        file: relativePath,
        message: 'Packed route renders SafeAreaView directly; use ScreenShell instead of a nested route safe-area wrapper.',
      });
    }
    if (/<ScreenShell\b[\s\S]{0,500}\bcontentInsetAdjustmentBehavior\s*=\s*["']automatic["']/.test(content)
      || /contentInsetAdjustmentBehavior\s*=\s*["']automatic["']/.test(content)) {
      issues.push({
        rule: 'automatic-inset-with-screen-shell',
        file: relativePath,
        message: 'ScreenShell owns route insets; do not combine it with automatic scroll-content insets.',
      });
    }
    const headerPattern = new RegExp(`<ScreenShell\\b[^>]*\\bheaderMode\\s*=\\s*["']${screen.headerMode}["']`);
    if (!headerPattern.test(content)) {
      issues.push({
        rule: 'header-mode-implementation-drift',
        file: relativePath,
        message: `Route must render literal headerMode="${screen.headerMode}" from the build pack.`,
      });
    }
  }
  return issues;
}

function validateScreenShells(projectRoot, packPath) {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedPack = path.resolve(resolvedRoot, packPath || '.tmp/screen-build-pack.json');
  const pack = fs.existsSync(resolvedPack) ? readJson(resolvedPack) : null;
  return screenShellIssues(resolvedRoot, pack);
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.projectRoot) {
    process.stderr.write('Usage: node validate-screen-shells.js --project-root <dir> [--pack <path>] [--report]\n');
    return 2;
  }
  try {
    const issues = validateScreenShells(args.projectRoot, args.pack);
    if (args.report) {
      process.stdout.write(`${JSON.stringify({ validator: 'validate-screen-shells', issues }, null, 2)}\n`);
      return 0;
    }
    if (issues.length) {
      for (const issue of issues) process.stderr.write(`${issue.file}: ${issue.rule}: ${issue.message}\n`);
      return 2;
    }
    process.stdout.write('Screen shell contract valid.\n');
    return 0;
  } catch (error) {
    process.stderr.write(`BLOCKED: screen shell validation: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { parseArgs, screenShellIssues, validateScreenShells };
