#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, filePath);
}

function stringConstant(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`const\\s+${escaped}\\s*=.*?\\|\\|\\s*['"]([^'"]+)['"]`))?.[1] || '';
}

function fontFamily(source, role) {
  const escaped = role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`\\b${escaped}\\s*:\\s*['"]([^'"]+)['"]`))?.[1] || '';
}

function contract(projectDir) {
  const planPath = path.join(projectDir, '.mobile-build', 'screen-plan.json');
  if (!fs.existsSync(planPath)) throw new Error('structured screen plan is missing; thin plans cannot generate full device evidence');
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const configSource = fs.readFileSync(path.join(projectDir, 'app.config.js'), 'utf8');
  const tokenSource = fs.readFileSync(path.join(projectDir, 'brand', 'tokens.ts'), 'utf8');
  const appId = process.env.IOS_BUNDLE_IDENTIFIER || stringConstant(configSource, 'IOS_BUNDLE_IDENTIFIER');
  const scheme = process.env.APP_SCHEME || stringConstant(configSource, 'APP_SCHEME') || stringConstant(configSource, 'APP_SLUG');
  const home = plan.screens.find((screen) => screen.id === 'home' || /\/home$/.test(screen.route)) || plan.screens[0];
  return {
    schemaVersion: 1,
    launch: { appId, scheme, route: home?.route || '' },
    fonts: [
      { role: 'heading', family: fontFamily(tokenSource, 'heading'), id: 'device-font:heading', route: home?.route || '' },
      { role: 'body', family: fontFamily(tokenSource, 'body'), id: 'device-font:body', route: home?.route || '' },
    ],
    tabs: plan.screens.filter((screen) => screen.archetype === 'tab-root').map((screen) => ({ id: `device-tab:${screen.id}`, label: screen.id, route: screen.route })),
    forms: plan.screens.filter((screen) => ['form', 'modal-sheet'].includes(screen.archetype)).map((screen) => ({
      id: screen.id,
      route: screen.route,
      inputId: `device-input:${screen.id}`,
      ctaId: `device-cta:${screen.id}`,
    })),
  };
}

function generate(projectDir) {
  const output = path.join(projectDir, '.mobile-build', 'device-contract.json');
  try {
    const value = contract(projectDir);
    atomicWrite(output, value);
    return { output, contract: value };
  } catch (error) {
    fs.rmSync(output, { force: true });
    throw error;
  }
}

function main() {
  try {
    const projectArg = process.argv[2];
    if (!projectArg) throw new Error('usage: generate-device-contract.js <project-dir>');
    const result = generate(path.resolve(projectArg));
    console.log(`device-contract: wrote ${result.output}`);
  } catch (error) {
    console.error(`device-contract: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { contract, fontFamily, generate, stringConstant };
