'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Loads fixtures from a directory. Each subdirectory is one fixture.
// Fixture folder name convention: "<eval-id>-<kebab-slug>" — id is parsed
// from the leading digits before the first hyphen.
//
//   fixtures/
//     1-account-gallery/
//       page.tsx                      ← .tsx output (consumed by Layer 2)
//       workflow-log.md               ← log of agent actions (consumed by Layer 1)
//       genpage-plan.md               ← plan doc (consumed by Layer 1)
//       entity-creation-log.md        ← entity-builder transactions (Layer 1)
//     2-mock-dashboard/
//       dashboard.tsx
//
// Each fixture exposes:
//   id, dirName, dir
//   files: [{ path, name, content }]  ← every .tsx except RuntimeTypes (Layer 2)
//   workflowLog: string | null         ← workflow-log.md content (Layer 1)
//   genpagePlan: string | null         ← genpage-plan.md content (Layer 1)
//   genpageEditPlan: string | null     ← genpage-edit-plan.md content (Layer 1 edit flow)
//   entityCreationLog: string | null   ← entity-creation-log.md content (Layer 1)

function loadFixtures(fixturesDir) {
  if (!fs.existsSync(fixturesDir)) {
    throw new Error(`Fixtures directory does not exist: ${fixturesDir}`);
  }
  const entries = fs.readdirSync(fixturesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const fixtures = [];
  for (const entry of entries) {
    const match = entry.name.match(/^(\d+)(?:-(.+))?$/);
    if (!match) continue;
    const id = parseInt(match[1], 10);
    const dir = path.join(fixturesDir, entry.name);
    fixtures.push({
      id,
      dirName: entry.name,
      dir,
      files: listTsxFiles(dir),
      workflowLog: readOptional(dir, 'workflow-log.md'),
      genpagePlan: readOptional(dir, 'genpage-plan.md'),
      genpageEditPlan: readOptional(dir, 'genpage-edit-plan.md'),
      entityCreationLog: readOptional(dir, 'entity-creation-log.md'),
    });
  }
  return fixtures;
}

function listTsxFiles(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.tsx')) continue;
    if (/^RuntimeTypes\.tsx?$/i.test(name)) continue;
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile()) continue;
    const content = fs.readFileSync(full, 'utf8');
    out.push({ path: full, name, content });
  }
  return out;
}

function readOptional(dir, fileName) {
  const full = path.join(dir, fileName);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, 'utf8');
}

module.exports = { loadFixtures, listTsxFiles, readOptional };
