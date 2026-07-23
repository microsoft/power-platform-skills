'use strict';

const crypto = require('node:crypto');

const MIGRATION_MODES = Object.freeze(['faithful', 'modernize', 'repair-modernize']);

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(toArray(values).filter(Boolean))];
}

function stableId(prefix, identity) {
  return `${prefix}-${crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 16)}`;
}

function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sortCanonical(values) {
  return toArray(values).slice().sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function normalizedTheme(theme) {
  if (!theme || typeof theme !== 'object') return theme || null;
  const palette = theme.palette && typeof theme.palette === 'object'
    ? {
        ...theme.palette,
        colors: sortCanonical(theme.palette.colors),
        sizes: sortCanonical(theme.palette.sizes),
        fontFaces: sortCanonical(theme.palette.fontFaces),
        fontWeights: sortCanonical(theme.palette.fontWeights),
        other: sortCanonical(theme.palette.other),
      }
    : theme.palette || null;
  return {
    ...theme,
    fonts: unique(theme.fonts).sort(),
    palette,
  };
}

function obligationSourceIdentity(category, source) {
  if (category === 'component-command') return { commandId: source.commandId };
  if (category === 'component-command-availability') {
    return {
      commandId: source.commandId,
      screen: source.screen,
      instance: source.instance,
      path: source.path,
    };
  }
  if (category === 'screen-presence') return { screen: source.screen };
  if (category === 'navigation') {
    return {
      from: source.from,
      to: source.to,
      control: source.control,
      contextKeys: unique(source.contextKeys).sort(),
    };
  }
  if (category === 'design-baseline') return { scope: 'app-design-baseline' };
  if (category === 'saved-view-semantics') {
    if (source.viewId) {
      return {
        table: source.table,
        viewId: source.viewId,
        viewKind: source.viewKind || 'unknown',
      };
    }
    return {
      table: source.table,
      sourceInventory: source.sourceInventory || null,
      view: source.view,
      viewKind: source.viewKind || 'unknown',
    };
  }
  if (category === 'start-screen') return { screen: source.screen };
  return source;
}

function canonicalScreenMap(screens) {
  return new Map(toArray(screens)
    .filter((screen) => screen && screen.name)
    .map((screen) => [screen.name, {
      name: screen.name,
      route: screen.route || null,
      file: screen.file || null,
    }]));
}

function normalizedDesignBaseline(baseline) {
  if (!baseline || baseline.confidence === 'low') return null;
  return {
    confidence: baseline.confidence || 'unknown',
    theme: normalizedTheme(baseline.theme),
    namedRecords: sortCanonical(toArray(baseline.namedRecords).map((record) => ({
      ...record,
      entries: sortCanonical(record && record.entries),
    }))),
    colors: sortCanonical(baseline.colors),
    dimensions: sortCanonical(baseline.dimensions),
    typography: baseline.typography
      ? {
          ...baseline.typography,
          fontDeclarations: sortCanonical(baseline.typography.fontDeclarations),
        }
      : null,
  };
}

function selectDesignEvidence(designBaseline) {
  if (!designBaseline) return { colors: [], dimensionTokens: [], font: null };
  const concreteColors = designBaseline.colors.filter((color) => /^(?:#[0-9a-f]{3,8}|rgba?\()/i.test(String(color?.value || '')));
  const formulaColors = concreteColors.filter((color) => !String(color.collection || '').startsWith('theme:'));
  const semanticThemeColors = concreteColors.filter((color) => ['primaryColor', 'backgroundColor', 'textColor'].includes(color.name));
  function chroma(value) {
    const raw = String(value || '').trim();
    let channels = null;
    const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
    if (hex) {
      const expanded = hex[1].length === 3 ? [...hex[1]].map((part) => part + part).join('') : hex[1];
      channels = [expanded.slice(0, 2), expanded.slice(2, 4), expanded.slice(4, 6)].map((part) => parseInt(part, 16));
    }
    const rgb = raw.match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/i);
    if (rgb) channels = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    return channels ? Math.max(...channels) - Math.min(...channels) : 0;
  }
  const orderedColors = [...new Map([...formulaColors, ...semanticThemeColors, ...concreteColors]
    .map((color) => [canonicalJson(color), color])).values()]
    .sort((left, right) => {
      const score = (color) => {
        const formulaSource = String(color.collection || '').startsWith('theme:') ? 0 : 1000;
        const semantic = /primary|accent|brand|link|success|warning|error/i.test(String(color.name || '')) ? 500 : 0;
        const concreteHex = String(color.value || '').startsWith('#') ? 100 : 0;
        return formulaSource + semantic + concreteHex + chroma(color.value);
      };
      return score(right) - score(left) || canonicalJson(left).localeCompare(canonicalJson(right));
    });
  const colorValues = [];
  const seenColors = new Set();
  for (const color of orderedColors) {
    const value = String(color.value);
    const key = value.toLowerCase();
    if (seenColors.has(key)) continue;
    seenColors.add(key);
    colorValues.push(value);
    if (colorValues.length === 3) break;
  }

  const formulaDimensions = designBaseline.dimensions.filter((dimension) => !String(dimension.collection || '').startsWith('theme:'));
  const orderedDimensions = [...formulaDimensions, ...designBaseline.dimensions];
  const dimensionTokens = [];
  const seenDimensions = new Set();
  for (const dimension of orderedDimensions) {
    const token = String(dimension.path || dimension.name || '').split('.').filter(Boolean).pop();
    if (!token || seenDimensions.has(token)) continue;
    seenDimensions.add(token);
    dimensionTokens.push(token);
    if (dimensionTokens.length === 3) break;
  }
  return {
    colors: colorValues,
    dimensionTokens,
    font: designBaseline.typography?.dominantFont || null,
  };
}

function buildCriticalObligations({
  generatedAt,
  sourceTreeSha256,
  sourceInputSha256,
  migrationMode = 'modernize',
  componentCommands = [],
  app = {},
  screens = [],
  navigationEdges = [],
  tables = [],
}) {
  if (!MIGRATION_MODES.includes(migrationMode)) {
    throw new Error(`Unsupported migration mode: ${migrationMode}`);
  }
  if (!/^[0-9a-f]{64}$/.test(String(sourceTreeSha256 || ''))) {
    throw new Error('critical obligations require sourceTreeSha256');
  }
  if (!/^[0-9a-f]{64}$/.test(String(sourceInputSha256 || ''))) {
    throw new Error('critical obligations require sourceInputSha256');
  }

  const screenMap = canonicalScreenMap(screens);
  const commands = toArray(componentCommands)
    .map((command) => ({
      ...command,
      navigateTargets: unique(command && command.navigateTargets).sort(),
      invocations: toArray(command && command.invocations)
        .map((invocation) => ({
          screen: invocation.screen || null,
          instance: invocation.instance || null,
          path: invocation.path || null,
        }))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    }))
    .sort((left, right) => String(left.commandId).localeCompare(String(right.commandId)));
  const obligations = [];
  const obligationIds = new Set();

  function add(category, source, requirement) {
    const sourceIdentity = obligationSourceIdentity(category, source);
    const id = `obl-${crypto.createHash('sha256').update(canonicalJson([category, sourceIdentity])).digest('hex').slice(0, 16)}`;
    if (obligationIds.has(id)) return;
    obligationIds.add(id);
    obligations.push({
      id,
      category,
      criticality: 'critical',
      source,
      requirement,
      evidence: {
        implementationMarker: `source-obligation: ${id}`,
        approvedDeltaMarker: `source-delta: ${id}`,
      },
    });
  }

  for (const command of commands) {
    add('component-command', {
      commandId: command.commandId,
      component: command.component || null,
      control: command.control || null,
      definitionPath: command.definitionPath || null,
      event: command.event || null,
      sourceFormula: command.sourceFormula || null,
    }, {
      commandId: command.commandId,
      implementationOwner: 'shared-command',
      targetFiles: command.target?.module ? [command.target.module] : [],
      targetExport: command.target?.exportName || null,
      accessAppScope: command.accessAppScope === true,
      intents: toArray(command.intents).map((intent) => intent && intent.intent || 'unknown'),
      navigateTargets: command.navigateTargets,
      invocationCount: command.invocations.length,
      policy: 'Implement once in shared domain/application code. Do not duplicate Canvas handler architecture per screen.',
    });

    for (const invocation of command.invocations) {
      const targetFile = screenMap.get(invocation.screen)?.file || null;
      add('component-command-availability', {
        component: command.component || null,
        commandId: command.commandId,
        screen: invocation.screen,
        instance: invocation.instance,
        path: invocation.path,
      }, {
        commandId: command.commandId,
        commandImportPath: command.target?.importPath || null,
        commandExportName: command.target?.exportName || null,
        availableOnScreen: invocation.screen,
        targetFiles: targetFile ? [targetFile] : [],
        navigateTargets: command.navigateTargets,
        policy: 'Compose the shared command into this source placement. The implementation marker belongs at the real invocation site.',
      });
    }
  }

  for (const screen of [...screenMap.values()].sort((left, right) => left.name.localeCompare(right.name))) {
    add('screen-presence', {
      screen: screen.name,
    }, {
      route: screen.route,
      targetFiles: screen.file ? [screen.file] : [],
      policy: 'Implement the source screen as a real native route with its approved workflow purpose, data contract, and reachable navigation semantics.',
    });
  }

  const normalizedEdges = toArray(navigationEdges)
    .filter((edge) => edge && edge.from && edge.to)
    .map((edge) => ({
      from: edge.from,
      to: edge.to,
      control: edge.viaControl || edge.control || edge.trigger || null,
      contextKeys: unique(edge.contextKeys || Object.keys(edge.context || {})).sort(),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  for (const edge of normalizedEdges) {
    const fromScreen = screenMap.get(edge.from);
    const toScreen = screenMap.get(edge.to);
    add('navigation', edge, {
      fromRoute: fromScreen?.route || null,
      targetRoute: toScreen?.route || null,
      targetFiles: fromScreen?.file ? [fromScreen.file] : [],
      contextKeys: edge.contextKeys,
      policy: 'Preserve source reachability and navigation data semantics using the approved native route contract.',
    });
  }

  const designBaseline = normalizedDesignBaseline(app.sourceDesignBaseline || app.designBaseline);
  if (designBaseline) {
    const designEvidence = selectDesignEvidence(designBaseline);
    add('design-baseline', {
      confidence: designBaseline.confidence,
      theme: designBaseline.theme,
      namedRecords: designBaseline.namedRecords,
      colors: designBaseline.colors,
      dimensions: designBaseline.dimensions,
      typography: designBaseline.typography,
    }, {
      targetFiles: ['brand/tokens.ts'],
      migrationMode,
      requiredColors: designEvidence.colors,
      requiredDimensionTokens: designEvidence.dimensionTokens,
      requiredFont: designEvidence.font,
      policy: migrationMode === 'faithful'
        ? 'Preserve source visual identity and interaction hierarchy unless the user approves a documented design delta.'
        : 'Use source identity as the baseline for native redesign. Material changes require a documented, user-approved design delta.',
    });
  }

  const sortedTables = toArray(tables)
    .filter(Boolean)
    .slice()
    .sort((left, right) => String(left.logicalName || left.displayName).localeCompare(String(right.logicalName || right.displayName)));
  for (const table of sortedTables) {
    const views = toArray(table.views)
      .filter((view) => view && (view.name || view.displayName))
      .slice()
      .sort((left, right) => String(left.name || left.displayName).localeCompare(String(right.name || right.displayName)));
    for (const view of views) {
      const targetFiles = unique(toArray(view.screens).map((screenName) => screenName === 'App' ? 'src/bootstrap.ts' : screenMap.get(screenName)?.file)).sort();
      add('saved-view-semantics', {
        table: table.logicalName || table.displayName || null,
        view: view.name || null,
        displayName: view.displayName || null,
        viewId: view.viewId || null,
        viewKind: view.viewKind || 'unknown',
        sourceInventory: view.sourceInventory || null,
      }, {
        targetFiles,
        predicate: view.predicate || null,
        fetchXml: view.fetchXml || null,
        layoutXml: view.layoutXml || null,
        orderBy: toArray(view.orderBy),
        columns: toArray(view.columns),
        queryType: Number.isInteger(view.queryType) ? view.queryType : null,
        targetViewId: view.targetViewId || view.viewId || null,
        targetViewKind: view.targetViewKind || view.viewKind || 'unknown',
        executionParameter: view.executionParameter || (view.viewKind === 'personal' || view.viewKind === 'user' ? 'userQuery' : 'savedQuery'),
        returnedTypeCode: view.returnedTypeCode || null,
        securityScope: view.securityScope || null,
        resolutionStatus: view.resolutionStatus || 'needs-target-view-resolution',
        requiresLiveResolution: !(view.fetchXml || view.predicate)
          || !(view.targetViewId || view.viewId)
          || view.resolutionStatus !== 'resolved',
        policy: 'Resolve the source view by stable ID in the target and preserve its predicate, ordering, columns, ownership, and security scope. Until live metadata fills those fields, generation is blocked; a broad unfiltered query is not equivalent.',
      });
    }
  }

  const startScreen = app.startScreen;
  if (startScreen) {
    const target = screenMap.get(startScreen);
    add('start-screen', { screen: startScreen }, {
      targetRoute: target?.route || null,
      targetFiles: ['app/index.tsx'],
      policy: 'Preserve the source entry workflow at the native authenticated start destination.',
    });
  }

  const sortedObligations = obligations.sort((left, right) => left.id.localeCompare(right.id));
  const sourceCommands = commands.map((command) => ({
    commandId: command.commandId,
    component: command.component || null,
    accessAppScope: command.accessAppScope === true,
    control: command.control || null,
    definitionPath: command.definitionPath || null,
    event: command.event || null,
    sourceFormula: command.sourceFormula || null,
    intents: toArray(command.intents),
    navigateTargets: unique(command.navigateTargets).sort(),
    invocations: toArray(command.invocations),
  }));
  const sourceDigest = crypto.createHash('sha256').update(canonicalJson({
    sourceTreeSha256,
    sourceInputSha256,
    migrationMode,
    commands: sourceCommands,
    app: { startScreen: app.startScreen || null, sourceDesignBaseline: designBaseline },
    screens: [...screenMap.keys()].sort(),
    navigationEdges: normalizedEdges,
    tables: sortedTables.map((table) => ({
      logicalName: table.logicalName || null,
      views: toArray(table.views)
        .map((view) => ({
          name: view.name || null,
          displayName: view.displayName || null,
          viewId: view.viewId || null,
          viewKind: view.viewKind || 'unknown',
          sourceInventory: view.sourceInventory || null,
          screens: unique(view.screens).sort(),
        }))
        .sort((left, right) => String(left.viewId || left.name).localeCompare(String(right.viewId || right.name))),
    })),
  })).digest('hex');

  return {
    $schema: 'critical-obligations-v1',
    generatedAt,
    sourceTreeSha256,
    sourceInputSha256,
    sourceDigest,
    migrationMode,
    rule: 'Every critical source obligation must be implemented or covered by an explicitly user-approved semantic delta. Weighted behavior coverage cannot waive critical obligations.',
    implementationPolicy: {
      componentCommands: 'Implement shared component behavior once, then prove availability at every source placement.',
      traceability: 'Use exact source-obligation markers for equivalent implementations and source-delta markers only with a reviewed source-deltas.json entry.',
      runtimeArchitecture: 'Preserve semantics through domain commands, application use cases, shared navigation, and native UI. Do not recreate Canvas controls, collections, or handler steps as the production architecture.',
    },
    stats: {
      total: sortedObligations.length,
      critical: sortedObligations.length,
      componentCommands: commands.length,
      componentCommandPlacements: sortedObligations.filter((row) => row.category === 'component-command-availability').length,
      sourceScreens: sortedObligations.filter((row) => row.category === 'screen-presence').length,
      navigation: sortedObligations.filter((row) => row.category === 'navigation').length,
      savedViews: sortedObligations.filter((row) => row.category === 'saved-view-semantics').length,
      designBaselines: sortedObligations.filter((row) => row.category === 'design-baseline').length,
      startScreens: sortedObligations.filter((row) => row.category === 'start-screen').length,
    },
    componentCommands: commands,
    obligations: sortedObligations,
  };
}

module.exports = {
  MIGRATION_MODES,
  canonicalJson,
  obligationSourceIdentity,
  normalizedDesignBaseline,
  selectDesignEvidence,
  stableId,
  buildCriticalObligations,
};
