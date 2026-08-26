#!/usr/bin/env node
'use strict';

/**
 * Small action-first experience-pattern registry. It intentionally maps a
 * person's primary job to an entry composition before industry is considered.
 * Industry can refine labels and content, never replace primaryJob/entryMode.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ENTRY_PATTERNS = {
  discovery: {
    visualCharacter: 'warm-friendly',
    regionOrder: ['context', 'feature', 'supporting-content', 'primary-action'],
    density: 'balanced',
    motifs: ['featured-content', 'guided-category-path'],
    forbidden: ['dashboard-first-home', 'crud-triad', 'status-card-catalog'],
  },
  workflow: {
    visualCharacter: 'confident-utility',
    regionOrder: ['context', 'feature', 'primary-action', 'supporting-content'],
    density: 'balanced',
    motifs: ['next-step-progress', 'action-state'],
    forbidden: ['dashboard-first-home', 'card-catalog', 'hidden-primary-action'],
  },
  overview: {
    visualCharacter: 'minimal-refined',
    regionOrder: ['context', 'feature', 'supporting-content', 'primary-action'],
    density: 'dense',
    motifs: ['signal-summary', 'priority-callout'],
    forbidden: ['generic-dashboard-card-grid', 'crud-triad', 'unprioritized-metrics'],
  },
  inbox: {
    visualCharacter: 'quiet-editorial',
    regionOrder: ['context', 'feature', 'supporting-content', 'primary-action'],
    density: 'balanced',
    motifs: ['attention-summary', 'conversation-state'],
    forbidden: ['dashboard-first-home', 'card-catalog', 'hidden-unread-state'],
  },
  feed: {
    visualCharacter: 'quiet-editorial',
    regionOrder: ['context', 'feature', 'supporting-content', 'primary-action'],
    density: 'balanced',
    motifs: ['story-rail', 'contextual-reaction'],
    forbidden: ['dashboard-first-home', 'crud-triad', 'metric-strip-only'],
  },
  'detail-first': {
    visualCharacter: 'minimal-refined',
    regionOrder: ['context', 'feature', 'primary-action', 'supporting-content'],
    density: 'balanced',
    motifs: ['hero-context', 'decision-summary'],
    forbidden: ['dashboard-first-home', 'generic-list-before-detail', 'card-catalog'],
  },
  capture: {
    visualCharacter: 'confident-utility',
    regionOrder: ['context', 'primary-action', 'feature', 'supporting-content'],
    density: 'sparse',
    motifs: ['capture-frame', 'manual-fallback'],
    forbidden: ['dashboard-first-home', 'crud-triad', 'secondary-capture-action'],
  },
  onboarding: {
    visualCharacter: 'warm-friendly',
    regionOrder: ['context', 'feature', 'primary-action'],
    density: 'sparse',
    motifs: ['guided-start', 'value-preview'],
    forbidden: ['dashboard-first-home', 'card-catalog', 'premature-tab-bar'],
  },
};

const RULES = [
  {
    id: 'capture',
    score: /\b(scan|capture|photograph|photo|receipt|barcode|qr|upload|submit evidence|record a measurement)\b/i,
    entryMode: 'capture',
    interactionMode: 'create',
    primaryAction: 'Capture and continue',
    focalPoint: 'The capture surface and the next safe action',
    content: ['records'],
    audience: 'mixed',
  },
  {
    id: 'booking',
    score: /\b(book|booking|schedule|appointment|reserve|reservation|availability|time slot)\b/i,
    entryMode: 'discovery',
    interactionMode: 'decide',
    primaryAction: 'Choose a time',
    focalPoint: 'The clearest available option or appointment',
    content: ['people', 'locations', 'records'],
    audience: 'consumer',
  },
  {
    id: 'learning',
    score: /\b(learn|learning|lesson|course|study|curriculum|quiz|practice)\b/i,
    entryMode: 'workflow',
    interactionMode: 'learn',
    primaryAction: 'Continue learning',
    focalPoint: 'The next meaningful learning step',
    content: ['media', 'records'],
    audience: 'consumer',
  },
  {
    id: 'communication',
    score: /\b(message|messages|chat|inbox|conversation|reply|notify)\b/i,
    entryMode: 'inbox',
    interactionMode: 'communicate',
    primaryAction: 'Open the highest-priority conversation',
    focalPoint: 'The conversation or message that needs attention',
    content: ['people', 'records'],
    audience: 'mixed',
  },
  {
    id: 'browse',
    score: /\b(browse|shop|shopping|buy|purchase|compare|discover|explore|catalog|product)\b/i,
    entryMode: 'discovery',
    interactionMode: 'browse',
    primaryAction: 'Explore options',
    focalPoint: 'Featured options that help the user choose',
    content: ['products', 'media'],
    audience: 'consumer',
  },
  {
    id: 'finance',
    score: /\b(balance|budget|spend|spending|income|expense|finance|financial|cash flow)\b/i,
    entryMode: 'overview',
    interactionMode: 'decide',
    primaryAction: 'Review the next financial decision',
    focalPoint: 'A clear financial signal with its decision context',
    content: ['records'],
    audience: 'consumer',
  },
  {
    id: 'work',
    score: /\b(complete|inspection|inspect|repair|maintain|maintenance|dispatch|approve|assignment|work order|checklist|task)\b/i,
    entryMode: 'workflow',
    interactionMode: 'operate',
    primaryAction: 'Start the next task',
    focalPoint: 'The next task and its completion state',
    content: ['tasks', 'records'],
    audience: 'employee',
  },
  {
    id: 'track',
    score: /\b(track|tracking|progress|history|status|monitor|goal)\b/i,
    entryMode: 'overview',
    interactionMode: 'track',
    primaryAction: 'Update progress',
    focalPoint: 'The most useful current progress signal',
    content: ['records'],
    audience: 'mixed',
  },
];

// These signals describe user intent, not industry presets. A winning intent
// must be supported by multiple actor/verb/object/context clues; the older
// RULES registry below remains a low-confidence fallback for terse briefs.
const SEMANTIC_SIGNALS = {
  consumer: [/\b(?:consumers?|customers?|passengers?|travelers?|shoppers?|members?|patients?|learners?)\b/i],
  employee: [/\b(?:employee|staff|technician|operator|manager|agent|dispatcher|team|auditor|inspector|logistician)s?\b/i],
  commerce: [/\b(?:sell|selling|shop|shopping|buy|purchase|add to cart|checkout)\b/i],
  product: [/\b(?:product|products|item|items|inventory|accessor(?:y|ies)|beauty|watch|watches|catalog|services?|options?|choices?)\b/i],
  category: [/\b(?:category|categories|accessor(?:y|ies)|beauty|watch|watches|collection)\b/i],
  cart: [/\b(?:cart|basket|add to cart|checkout|purchase)\b/i],
  media: [/\b(?:image|images|photo|photos|photograph|photographs|media|showcase|showcasing|visual)\b/i],
  creator: [/\b(?:creator|create content|publish|publishing|post|posts|article|articles|video|videos|followers?)\b/i],
  discovery: [/\b(?:browse|browsing|discover|explore|showcase|showcasing|compare|find)\b/i],
  booking: [/\b(?:book|booking|schedule|appointment|reserve|reservation|availability|time slot)\b/i],
  learning: [/\b(?:learn|learning|lesson|course|study|curriculum|quiz|practice)\b/i],
  communication: [/\b(?:message|messages|chat|inbox|conversation|reply|notify)\b/i],
  finance: [/\b(?:balance|budget|spend|spending|income|expense|finance|financial|cash flow)\b/i],
  operation: [/\b(?:complete|audit|auditing|inspection|inspect|repair|repairs|maintain|maintenance|maintining|maintence|maintennce|dispatch|approve|assignment|assignments|work order|checklist|task|warehouse|cycle count|receive|received|receiving|shipment|shipments|damaged|quantities|batch|expiry|bin|bins)\b/i],
  capture: [/\b(?:scan|capture|photograph|photo|receipt|barcode|qr|upload|submit evidence|record a measurement)\b/i],
  tracking: [/\b(?:track|tracking|progress|history|status|monitor|goal)\b/i],
  portfolio: [/\b(?:records?|issues?|on\s*going|upcoming|warranty|warranties|ownership|updates?)\b/i],
  offline: [/\b(?:offline|limited connectivity|intermittent connectivity|no (?:internet|network|connection)|works? without (?:an? )?(?:internet|network|connection)|disconnected (?:operation|work|mode)|save(?:d)? on (?:the )?device|sync later|airplane mode)\b/i],
  cachedCdn: [/\b(?:cdn|cache-backed|cached\s+(?:cdn|image|media)|device\s+cache|remote-cdn-cached)\b/i],
  clean: [/\b(?:clean|minimal|simple|calm|refined)\b/i],
};

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function slug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function evidenceMatches(text, signal, patterns) {
  const matches = [];
  for (const pattern of patterns) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const matcher = new RegExp(pattern.source, flags);
    let match;
    while ((match = matcher.exec(text)) !== null) {
      matches.push({ signal, text: match[0], start: match.index, end: match.index + match[0].length });
      if (match[0].length === 0) matcher.lastIndex += 1;
    }
  }
  return matches;
}

function collectSemanticProfile(text) {
  const profile = {};
  for (const [signal, patterns] of Object.entries(SEMANTIC_SIGNALS)) {
    profile[signal] = evidenceMatches(text, signal, patterns);
  }
  return profile;
}

function evidenceFor(profile, signals, fallback) {
  const values = signals.flatMap((signal) => profile[signal] || []);
  if (values.length) {
    const seen = new Set();
    return values.filter((value) => {
      const key = `${value.signal}:${value.start}:${value.end}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return [{ signal: 'brief-context', text: fallback, start: 0, end: fallback.length }];
}

function signalCount(profile, signal) {
  return (profile[signal] || []).length;
}

function chooseSemanticIntent(profile) {
  const score = (weights) => Object.entries(weights)
    .reduce((total, [signal, weight]) => total + signalCount(profile, signal) * weight, 0);
  const candidates = [
    { id: 'commerce', score: score({ commerce: 3, product: 2, category: 1, cart: 2, discovery: 1, consumer: 2 }), evidence: ['commerce', 'product', 'category', 'cart', 'discovery', 'consumer'] },
    { id: 'capture', score: score({ capture: 4, employee: 1, consumer: 1 }), evidence: ['capture', 'employee', 'consumer'] },
    { id: 'booking', score: score({ booking: 4, discovery: 1, consumer: 1 }), evidence: ['booking', 'discovery', 'consumer'] },
    { id: 'learning', score: score({ learning: 4, consumer: 1, tracking: 1 }), evidence: ['learning', 'consumer', 'tracking'] },
    { id: 'communication', score: score({ communication: 4, consumer: 1, employee: 1 }), evidence: ['communication', 'consumer', 'employee'] },
    { id: 'content', score: score({ creator: 4, media: 2, consumer: 1, discovery: 1 }), evidence: ['creator', 'media', 'consumer', 'discovery'] },
    { id: 'finance', score: score({ finance: 4, tracking: 1, consumer: 1 }), evidence: ['finance', 'tracking', 'consumer'] },
    { id: 'operation', score: score({ operation: 4, employee: 2, tracking: 1 }), evidence: ['operation', 'employee', 'tracking'] },
    { id: 'tracking', score: score({ tracking: 3, portfolio: 4, consumer: 1, employee: 1 }), evidence: ['tracking', 'portfolio', 'consumer', 'employee'] },
  ].sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  return { winner: candidates[0], runnerUp: candidates[1] };
}

function hasSufficientIntentEvidence(intent, profile) {
  if (!intent || intent.score === 0) return false;
  // Product nouns alone are ambiguous: they can describe a passenger shop,
  // employee warehouse, catalog, or a static data set. Require one journey
  // signal before classifying them as consumer commerce.
  if (intent.id === 'commerce') {
    return signalCount(profile, 'product') > 0
      && (signalCount(profile, 'commerce') > 0
        || signalCount(profile, 'discovery') > 0
        || signalCount(profile, 'consumer') > 0
        || signalCount(profile, 'cart') > 0);
  }
  return true;
}

function experienceFromIntent(intent, profile, text) {
  const clean = signalCount(profile, 'clean') > 0;
  const byIntent = {
    commerce: {
      audience: 'consumer',
      primaryJob: 'Browse and add useful products.',
      interactionMode: 'browse',
      entryMode: 'discovery',
      contentModel: ['products', 'categories', 'media', 'cart'],
      primarySurface: 'product-led-discovery',
      primaryAction: 'Browse onboard products',
      focalPoint: 'Featured products with clear category context and a visible cart action',
      signatureMotifs: ['featured-product-media', 'category-browse', 'cart-action'],
      forbiddenDefaults: ['dashboard-first-home', 'crud-triad', 'warehouse-operations', 'airline-operations', 'status-card-catalog'],
      visualCharacter: clean ? 'minimal-refined' : 'warm-friendly',
      navigationModel: 'stack',
      evidence: ['consumer', 'commerce', 'product', 'category', 'cart', 'media', 'discovery'],
    },
    booking: {
      audience: 'consumer', primaryJob: 'Find and choose an available option.', interactionMode: 'decide', entryMode: 'discovery', contentModel: ['people', 'locations', 'records'], primarySurface: 'availability-led-discovery', primaryAction: 'Choose a time', focalPoint: 'The clearest available option or appointment', signatureMotifs: ['availability-focus', 'guided-choice'], forbiddenDefaults: ['dashboard-first-home', 'crud-triad', 'status-card-catalog'], visualCharacter: 'warm-friendly', navigationModel: 'stack', evidence: ['booking', 'discovery', 'consumer'],
    },
    learning: {
      audience: 'consumer', primaryJob: 'Continue a learning journey.', interactionMode: 'learn', entryMode: 'workflow', contentModel: ['media', 'tasks', 'records'], primarySurface: 'learning-journey', primaryAction: 'Continue learning', focalPoint: 'The next meaningful learning step', signatureMotifs: ['learning-progress', 'next-lesson'], forbiddenDefaults: ['dashboard-first-home', 'crud-triad', 'card-catalog'], visualCharacter: 'warm-friendly', navigationModel: 'stack', evidence: ['learning', 'consumer', 'tracking'],
    },
    communication: {
      audience: signalCount(profile, 'employee') && !signalCount(profile, 'consumer') ? 'employee' : 'mixed', primaryJob: 'Handle the conversation needing attention.', interactionMode: 'communicate', entryMode: 'inbox', contentModel: ['people', 'messages', 'records'], primarySurface: 'conversation-led-inbox', primaryAction: 'Open the highest-priority conversation', focalPoint: 'The conversation or message that needs attention', signatureMotifs: ['attention-summary', 'conversation-state'], forbiddenDefaults: ['dashboard-first-home', 'crud-triad', 'metric-strip-only'], visualCharacter: 'quiet-editorial', navigationModel: 'tabs-stack', evidence: ['communication', 'consumer', 'employee'],
    },
    content: {
      audience: 'consumer', primaryJob: 'Create and share meaningful content.', interactionMode: 'create', entryMode: 'feed', contentModel: ['media', 'people', 'records'], primarySurface: 'content-led-feed', primaryAction: 'Create an update', focalPoint: 'Fresh content with a clear path to publish or continue reading', signatureMotifs: ['story-rail', 'creator-action'], forbiddenDefaults: ['dashboard-first-home', 'crud-triad', 'metric-strip-only'], visualCharacter: 'quiet-editorial', navigationModel: 'tabs-stack', evidence: ['creator', 'media', 'consumer', 'discovery'],
    },
    finance: {
      audience: 'consumer', primaryJob: 'Understand finances and make the next decision.', interactionMode: 'decide', entryMode: 'overview', contentModel: ['records'], primarySurface: 'decision-led-overview', primaryAction: 'Review the next financial decision', focalPoint: 'A clear financial signal with its decision context', signatureMotifs: ['signal-summary', 'priority-callout'], forbiddenDefaults: ['crud-triad', 'unprioritized-metrics'], visualCharacter: 'minimal-refined', navigationModel: 'tabs-stack', evidence: ['finance', 'tracking', 'consumer'],
    },
    operation: {
      audience: 'employee', primaryJob: 'Complete the next piece of work.', interactionMode: 'operate', entryMode: 'workflow', contentModel: ['tasks', 'records', 'locations'], primarySurface: 'task-led-workflow', primaryAction: 'Start the next task', focalPoint: 'The next task and its completion state', signatureMotifs: ['next-step-progress', 'action-state'], forbiddenDefaults: ['dashboard-first-home', 'card-catalog', 'hidden-primary-action'], visualCharacter: 'confident-utility', navigationModel: 'stack', evidence: ['operation', 'employee', 'tracking'],
    },
    tracking: {
      audience: signalCount(profile, 'employee') && !signalCount(profile, 'consumer') ? 'employee' : 'mixed', primaryJob: 'Understand current progress and update it.', interactionMode: 'track', entryMode: 'overview', contentModel: ['records'], primarySurface: 'decision-led-overview', primaryAction: 'Update progress', focalPoint: 'The most useful current progress signal', signatureMotifs: ['signal-summary', 'priority-callout'], forbiddenDefaults: ['crud-triad', 'unprioritized-metrics'], visualCharacter: 'minimal-refined', navigationModel: 'tabs-stack', evidence: ['tracking', 'portfolio', 'consumer', 'employee'],
    },
    capture: {
      audience: signalCount(profile, 'consumer') && !signalCount(profile, 'employee') ? 'consumer' : 'mixed', primaryJob: 'Capture information and continue.', interactionMode: 'create', entryMode: 'capture', contentModel: ['records', 'media'], primarySurface: 'capture-led-utility', primaryAction: 'Capture and continue', focalPoint: 'The capture surface and the next safe action', signatureMotifs: ['capture-frame', 'manual-fallback'], forbiddenDefaults: ['dashboard-first-home', 'crud-triad', 'secondary-capture-action'], visualCharacter: 'confident-utility', navigationModel: 'stack', evidence: ['capture', 'consumer', 'employee'],
    },
  };
  const selected = byIntent[intent] || {
    audience: signalCount(profile, 'consumer') ? 'consumer' : signalCount(profile, 'employee') ? 'employee' : 'mixed', primaryJob: 'Understand the product and take the first useful action.', interactionMode: 'create', entryMode: 'onboarding', contentModel: ['records'], primarySurface: 'guided-onboarding', primaryAction: 'Start the guided flow', focalPoint: 'The clearest first step for the user', signatureMotifs: ['guided-start', 'value-preview'], forbiddenDefaults: ['dashboard-first-home', 'card-catalog', 'premature-tab-bar'], visualCharacter: 'warm-friendly', navigationModel: 'stack', evidence: [],
  };
  const contentModel = signalCount(profile, 'media') > 0
    ? unique([...selected.contentModel, 'media'])
    : selected.contentModel;
  const explicitCachedCdn = signalCount(profile, 'cachedCdn') > 0 && contentModel.includes('media');
  const assetPolicy = {
    connectivity: signalCount(profile, 'offline') ? 'offline-preferred' : 'network-optional',
    media: explicitCachedCdn
      ? 'remote-cdn-cached'
      : signalCount(profile, 'offline') && contentModel.includes('media') ? 'local-first' : contentModel.includes('media') ? 'remote-allowed' : 'not-applicable',
  };
  return { ...selected, contentModel, assetPolicy, text };
}

function normalizeMediaPolicy(value) {
  if (value === undefined || value === null || value === '') return null;
  if (['local-first', 'remote-cdn-cached', 'remote-allowed', 'not-applicable'].includes(value)) return value;
  throw new Error(`mediaPolicy must be local-first, remote-cdn-cached, remote-allowed, or not-applicable; received ${value}`);
}

function contentFromBrief(brief, fallback) {
  const lower = String(brief || '').toLowerCase();
  const content = [];
  if (/\b(product|item|shop|buy|catalog|price)\b/.test(lower)) content.push('products');
  if (/\b(team|staff|customer|client|patient|coach|teacher|technician|traveler)\b/.test(lower)) content.push('people');
  if (/\b(task|checklist|assignment|repair|work order|lesson)\b/.test(lower)) content.push('tasks');
  if (/\b(photo|video|article|lesson|content|media)\b/.test(lower)) content.push('media');
  if (/\b(location|site|gym|venue|office|clinic|store)\b/.test(lower)) content.push('locations');
  if (/\b(document|file|pdf|evidence)\b/.test(lower)) content.push('documents');
  if (/\b(record|history|balance|appointment|booking|receipt|transaction)\b/.test(lower)) content.push('records');
  return unique([...content, ...(fallback || [])]).slice(0, 3);
}

function audienceFromBrief(brief, fallback) {
  const lower = String(brief || '').toLowerCase();
  const consumer = /\b(customer|consumer|traveler|passenger|patient|learner|shopper|member)\b/.test(lower);
  const employee = /\b(employee|staff|technician|operator|manager|agent|dispatcher|team)\b/.test(lower);
  if (consumer && employee) return 'mixed';
  if (consumer) return 'consumer';
  if (employee) return 'employee';
  return fallback || 'mixed';
}

function chooseRule(brief) {
  const matches = RULES
    .map((rule) => ({ rule, count: (String(brief || '').match(new RegExp(rule.score.source, rule.score.flags + 'g')) || []).length }))
    .filter((match) => match.count > 0)
    .sort((left, right) => right.count - left.count || RULES.indexOf(left.rule) - RULES.indexOf(right.rule));
  return matches[0] || null;
}

function deriveExperienceFromBrief(brief, options = {}) {
  const text = String(brief || '').trim();
  if (!text) throw new Error('brief must be a non-empty string');
  const profile = collectSemanticProfile(text);
  const { winner, runnerUp } = chooseSemanticIntent(profile);
  const semanticIntent = hasSufficientIntentEvidence(winner, profile) ? winner : null;
  const fallback = semanticIntent ? null : winner.score === 0 ? chooseRule(text) : null;
  const intent = semanticIntent?.id || (fallback?.rule.id === 'browse' ? 'commerce' : fallback?.rule.id);
  const semantic = experienceFromIntent(intent, profile, text);
  const mediaPolicy = normalizeMediaPolicy(options.mediaPolicy);
  if (mediaPolicy) semantic.assetPolicy.media = mediaPolicy;
  const score = semanticIntent?.score || fallback?.count || 0;
  const margin = winner.score - (runnerUp?.score || 0);
  const confidence = score >= 6 && margin >= 2 ? 'high' : score >= 3 ? 'medium' : 'low';
  const evidenceSignals = semantic.evidence.length ? semantic.evidence : fallback ? [fallback.rule.id] : [];
  const primaryEvidence = evidenceFor(profile, evidenceSignals, text);
  const audienceEvidence = evidenceFor(profile, semantic.audience === 'consumer' ? ['consumer'] : semantic.audience === 'employee' ? ['employee'] : ['consumer', 'employee'], text);
  const contentSignals = semantic.contentModel.includes('products') ? ['product', 'category', 'cart', 'media'] : evidenceSignals;
  const contract = {
    schemaVersion: 1,
    audience: semantic.audience,
    primaryJob: semantic.primaryJob,
    interactionMode: semantic.interactionMode,
    contentModel: semantic.contentModel,
    primarySurface: semantic.primarySurface,
    assetPolicy: semantic.assetPolicy,
    promptEvidence: {
      audience: audienceEvidence,
      primaryJob: primaryEvidence,
      interactionMode: primaryEvidence,
      entryMode: primaryEvidence,
      contentModel: evidenceFor(profile, contentSignals, text),
      primarySurface: primaryEvidence,
      assetPolicy: evidenceFor(profile, ['cachedCdn', 'offline', ...evidenceSignals], text),
    },
    entryMode: semantic.entryMode,
    navigationModel: semantic.navigationModel,
    primaryScreen: {
      id: 'home',
      route: '/(app)/home',
      file: 'app/(app)/home.tsx',
      compositionKind: semantic.entryMode,
    },
    firstViewport: {
      focalPoint: semantic.focalPoint,
      regionOrder: ENTRY_PATTERNS[semantic.entryMode].regionOrder,
      primaryAction: semantic.primaryAction,
      contentDensity: semantic.entryMode === 'commerce' ? 'balanced' : ENTRY_PATTERNS[semantic.entryMode].density,
    },
    signatureMotifs: semantic.signatureMotifs,
    forbiddenDefaults: semantic.forbiddenDefaults,
    visualCharacter: semantic.visualCharacter,
    confidence,
    assumptions: confidence === 'low'
      ? ['The brief does not name a dominant user action; ask what a person should accomplish first.']
      : mediaPolicy
        ? [`Use the explicitly selected ${mediaPolicy} media policy.`]
        : semantic.assetPolicy.connectivity === 'offline-preferred'
        ? ['Use bundled or local media before attempting a network fetch.']
        : [],
    source: options.referenceOverride ? 'brief-plus-reference' : 'brief',
  };
  if (options.referenceOverride) contract.referenceOverride = options.referenceOverride;
  return contract;
}

function validateExperienceContract(contract) {
  const issues = [];
  if (!contract || contract.schemaVersion !== 1) issues.push('schemaVersion must be 1');
  const enums = {
    audience: ['consumer', 'employee', 'mixed'],
    interactionMode: ['discover', 'browse', 'operate', 'decide', 'create', 'track', 'communicate', 'learn'],
    entryMode: Object.keys(ENTRY_PATTERNS),
    navigationModel: ['tabs-stack', 'stack', 'modal-flow', 'drawer', 'other'],
    visualCharacter: ['quiet-editorial', 'confident-utility', 'warm-friendly', 'energetic', 'playful', 'minimal-refined', 'other'],
    confidence: ['high', 'medium', 'low'],
    source: ['brief', 'reference-override', 'brief-plus-reference'],
  };
  for (const [field, values] of Object.entries(enums)) {
    if (!values.includes(contract?.[field])) issues.push(`${field} is invalid`);
  }
  if (typeof contract?.primaryJob !== 'string' || contract.primaryJob.trim().length < 10) issues.push('primaryJob is too short');
  const contentValues = new Set(['products', 'categories', 'cart', 'people', 'tasks', 'media', 'records', 'locations', 'documents', 'messages']);
  if (!Array.isArray(contract?.contentModel) || !contract.contentModel.length || contract.contentModel.length > 5 || contract.contentModel.some((value) => !contentValues.has(value))) issues.push('contentModel must contain 1-5 supported values');
  const surfaces = new Set(['product-led-discovery', 'availability-led-discovery', 'task-led-workflow', 'learning-journey', 'conversation-led-inbox', 'decision-led-overview', 'capture-led-utility', 'content-led-feed', 'detail-led-decision', 'guided-onboarding', 'other']);
  if (!surfaces.has(contract?.primarySurface)) issues.push('primarySurface is invalid');
  if (!['offline-preferred', 'network-optional', 'unknown'].includes(contract?.assetPolicy?.connectivity) || !['local-first', 'remote-cdn-cached', 'remote-allowed', 'not-applicable'].includes(contract?.assetPolicy?.media)) issues.push('assetPolicy is invalid');
  const evidenceFields = ['audience', 'primaryJob', 'interactionMode', 'entryMode', 'contentModel', 'primarySurface', 'assetPolicy'];
  for (const field of evidenceFields) {
    const spans = contract?.promptEvidence?.[field];
    if (!Array.isArray(spans) || !spans.length || spans.some((span) => typeof span?.signal !== 'string' || typeof span?.text !== 'string' || !Number.isInteger(span?.start) || !Number.isInteger(span?.end) || span.end <= span.start)) {
      issues.push(`promptEvidence.${field} is invalid`);
    }
  }
  if (!contract?.primaryScreen || contract.primaryScreen.route !== '/(app)/home' || contract.primaryScreen.file !== 'app/(app)/home.tsx') {
    issues.push('primaryScreen must point to the canonical home route');
  }
  const viewport = contract?.firstViewport;
  if (!viewport || typeof viewport.focalPoint !== 'string' || typeof viewport.primaryAction !== 'string') {
    issues.push('firstViewport focalPoint and primaryAction are required');
  }
  const validRegions = ['context', 'feature', 'primary-action', 'supporting-content', 'navigation'];
  if (!Array.isArray(viewport?.regionOrder) || viewport.regionOrder.length < 3 || viewport.regionOrder.some((region) => !validRegions.includes(region))) {
    issues.push('firstViewport.regionOrder is invalid');
  }
  if (!['sparse', 'balanced', 'dense'].includes(viewport?.contentDensity)) issues.push('firstViewport.contentDensity is invalid');
  if (!Array.isArray(contract?.signatureMotifs) || !contract.signatureMotifs.length || contract.signatureMotifs.length > 5) issues.push('signatureMotifs must contain 1-5 values');
  if (!Array.isArray(contract?.forbiddenDefaults) || contract.forbiddenDefaults.length > 5) issues.push('forbiddenDefaults must contain 0-5 values');
  if (contract?.source === 'reference-override' || contract?.source === 'brief-plus-reference') {
    if (!contract.referenceOverride?.fidelity || !Array.isArray(contract.referenceOverride?.preservationIntent)) {
      issues.push('referenceOverride fidelity and preservationIntent are required');
    }
  }
  return issues;
}

function primaryComposition(contract) {
  const pattern = ENTRY_PATTERNS[contract.entryMode];
  return {
    compositionKind: contract.entryMode,
    userOutcome: contract.primaryJob,
    focalPoint: contract.firstViewport.focalPoint,
    regionOrder: contract.firstViewport.regionOrder,
    primaryAction: contract.firstViewport.primaryAction,
    contentDensity: contract.firstViewport.contentDensity,
    signatureMotifs: contract.signatureMotifs.length ? contract.signatureMotifs : pattern.motifs,
    forbiddenDefaults: unique([...pattern.forbidden, ...contract.forbiddenDefaults]),
    runtimeMarkers: [
      ...contract.firstViewport.regionOrder.map((region) => `experience-region-${slug(region)}`),
      'experience-primary-action',
      ...contract.signatureMotifs.map((motif) => `experience-motif-${slug(motif)}`),
    ],
  };
}

function contractHash(contract) {
  return sha256(JSON.stringify(contract));
}

function pascalCase(value) {
  return slug(value)
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function foundationContract(contract) {
  return {
    schemaVersion: 1,
    experienceContractSha256: contractHash(contract),
    primitives: contract.signatureMotifs.map((motif) => {
      const component = `Experience${pascalCase(motif)}`;
      return {
        motif,
        component,
        file: `src/components/experience/${component}.tsx`,
        testID: `experience-motif-${slug(motif)}`,
      };
    }),
  };
}

function usage() {
  return 'Usage: node experience-patterns.js --brief-file <brief.md> --output <experience-contract.json> [--media-policy local-first|remote-cdn-cached|remote-allowed|not-applicable] [--reference-fidelity directional|high|strict-structural]';
}

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--brief-file') args.briefFile = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
    else if (argv[index] === '--media-policy') args.mediaPolicy = argv[++index];
    else if (argv[index] === '--reference-fidelity') args.referenceFidelity = argv[++index];
    else if (argv[index] === '--help') args.help = true;
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!args.briefFile || !args.output) throw new Error(usage());
  const brief = fs.readFileSync(path.resolve(args.briefFile), 'utf8');
  const referenceOverride = args.referenceFidelity
    ? { fidelity: args.referenceFidelity, preservationIntent: ['reference-led hierarchy'] }
    : null;
  const contract = deriveExperienceFromBrief(brief, { referenceOverride, mediaPolicy: args.mediaPolicy });
  const issues = validateExperienceContract(contract);
  if (issues.length) throw new Error(issues.join('; '));
  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(contract, null, 2)}\n`);
  process.stdout.write(`experience-patterns: ${contract.entryMode}/${contract.interactionMode} (${contract.confidence})\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`experience-patterns: ${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = {
  ENTRY_PATTERNS,
  collectSemanticProfile,
  contractHash,
  deriveExperienceFromBrief,
  foundationContract,
  normalizeMediaPolicy,
  primaryComposition,
  slug,
  validateExperienceContract,
};
