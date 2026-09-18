'use strict';

const path = require('node:path');
const protocol = require('./authoring-protocol');
const { fileToRoute } = require('../validate-navigation-layout');
const { validateContext } = require('./mobile-authoring-context');
const { readJson, exists, relativePath, inside } = require('./mobile-authoring-files');
const { validateDomain } = require('./prototype-domain');

const REGISTRY_PATH = '.tmp/authoring-registry.json';
const DOMAIN_PATH = '.tmp/prototype-domain.json';

function registeredContext(root, descriptor) {
  const context = descriptor.context ? validateContext(descriptor.context, descriptor) : null;
  if (exists(root, DOMAIN_PATH) && readJson(root, DOMAIN_PATH).appInstanceId !== descriptor.appInstanceId) {
    throw new Error('The app domain does not match the authoring workspace identity');
  }
  const registry = exists(root, REGISTRY_PATH) ? readJson(root, REGISTRY_PATH) : null;
  if (registry && (registry.schemaVersion !== 1 || registry.appInstanceId !== descriptor.appInstanceId || !Array.isArray(registry.screens))) {
    throw new Error('The semantic authoring registry belongs to another app or is invalid');
  }
  if (!context || context.scope === 'app') return { context, target: null, screen: null, targeted: false };
  if (!registry) {
    return { context: null, target: null, screen: null, targeted: false, clarification: 'Select a registered screen or describe the intended screen by name.' };
  }
  const screens = registry.screens.filter((screen) => screen.screenId === context.screenId);
  if (screens.length !== 1 || screens[0].route !== context.route) throw new Error('The selected screen is not registered at this preview revision');
  const screen = screens[0];
  relativePath(screen.sourceFile);
  inside(root, screen.sourceFile);
  if (!screen.sourceFile.startsWith('app/') || !screen.sourceFile.endsWith('.tsx')
    || fileToRoute(path.join(root, screen.sourceFile), path.join(root, 'app')) !== screen.route) {
    throw new Error('The registered screen source does not match its canonical route');
  }
  const compiled = readJson(root, '.tmp/compiled-screen-build-pack.json');
  if (compiled.contractType !== 'compiled-screen-build-pack' || !Array.isArray(compiled.screens) || compiled.screens.filter((pack) => (
    pack.screenId === screen.screenId && pack.route === screen.route
  )).length !== 1) throw new Error('The selected screen is not in the current compiled screen contract');
  let target = null;
  if (context.scope === 'target') {
    const matches = (screen.targets || []).filter((entry) => entry.id === context.targetId);
    if (matches.length !== 1) throw new Error('The selected target is not registered on this screen');
    target = matches[0];
    protocol.id(target.id, 'registered target ID');
    protocol.text(target.label, 'registered target label', 200);
    protocol.enumeration(target.role, protocol.TARGET_ROLES, 'registered target role');
    if (context.actionId && target.actionId !== context.actionId) throw new Error('The selected action does not belong to this target');
  }
  if (context.actionId || context.recordRef) {
    if (!exists(root, DOMAIN_PATH)) throw new Error('Selected data context requires the declared app domain, not inferred pixels');
    const domain = validateDomain(readJson(root, DOMAIN_PATH));
    if (domain.appInstanceId !== descriptor.appInstanceId) throw new Error('Selected data context belongs to another app');
    if (context.actionId && !domain.actions.some((action) => action.id === context.actionId)) {
      throw new Error('The selected action is not a declared domain action');
    }
    if (context.recordRef) {
      const bindings = readJson(root, '.tmp/prototype-bindings.json');
      if (!bindings.entities?.some((binding) => binding.conceptId === context.recordRef.conceptId
        && domain.entities.some((entity) => entity.id === binding.entityId))) {
        throw new Error('The selected record reference is not a declared app concept');
      }
    }
  }
  return { context, target, screen, targeted: !!target };
}

function inspectEdit(root, descriptor, intent = 'general') {
  protocol.enumeration(intent, ['general', 'background', 'layout', 'teach'], 'edit intent');
  const selected = registeredContext(root, descriptor);
  const compiled = exists(root, '.tmp/compiled-screen-build-pack.json')
    ? readJson(root, '.tmp/compiled-screen-build-pack.json') : null;
  const screens = (compiled?.screens || []).map((pack) => ({ screenId: pack.screenId, route: pack.route }));
  const domain = exists(root, DOMAIN_PATH) ? validateDomain(readJson(root, DOMAIN_PATH)) : null;
  const missingTarget = intent === 'layout' && (!selected.target || selected.target.role !== 'collection');
  return {
    context: selected.context,
    defaultScope: intent === 'background' ? 'app' : intent === 'teach' ? 'all-saves'
      : selected.targeted ? 'target' : selected.screen ? 'screen' : 'app',
    ...(selected.screen ? { selectedScreen: { screenId: selected.screen.screenId, route: selected.screen.route, sourceFile: selected.screen.sourceFile } } : {}),
    ...(selected.target ? { selectedTarget: { id: selected.target.id, role: selected.target.role, label: selected.target.label } } : {}),
    screens,
    domain: domain ? {
      entities: domain.entities.map((entity) => ({ id: entity.id, label: entity.label, operations: entity.operations, fields: entity.fields })),
      actions: domain.actions,
    } : null,
    needsClarification: missingTarget || (intent === 'teach' && !domain) || !!selected.clarification,
    clarification: missingTarget
      ? 'Which existing collection should become cards? Select its registered target or choose a screen by name.'
      : (intent === 'teach' && !domain)
        ? 'Which existing save action and fields should this rule use? No app domain is registered.'
        : selected.clarification || null,
    preservedBehavior: ['navigation', 'queries', 'actions', 'paging'],
  };
}

module.exports = { REGISTRY_PATH, DOMAIN_PATH, registeredContext, inspectEdit };
