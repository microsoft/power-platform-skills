'use strict';

const {
  buildBuildPack,
  buildExperience,
  buildJourney,
  buildScope,
  defaultStates,
  evidence,
} = require('./product-experience-fixtures');

const ACCEPTANCE_SCENARIOS = {
  flightCommerce: {
    brief: 'Build an authenticated in-flight passenger shop where travelers can search the cabin catalog, select products, purchase with a saved card, manage their booking, review orders, and open their profile. The catalog and booking connector are online during the flight; do not promise offline ordering.',
    productName: 'Cabin Cart',
    primaryGoal: 'Find and buy an item during the flight without losing booking context',
    vocabulary: ['cabin catalog', 'seat', 'booking', 'order', 'delivery on board'],
    complexity: 'standard',
    dimensions: {
      primaryUser: { role: 'Airline passenger', proficiency: 'occasional', situation: 'Seated in the cabin with one hand available and limited time before landing' },
      primaryIntent: 'transact',
      workflowShape: 'hub-and-spoke',
      operatingContext: { environment: 'in-vehicle', connectivity: 'always-online', interruptionLevel: 'moderate', handsAvailable: 'one-hand' },
      sessionPattern: { frequency: 'occasional', duration: 'five-to-fifteen-minutes', resumability: 'helpful-to-resume' },
      informationDensity: 'balanced',
      interactionTempo: 'brisk',
      contentEmphasis: { primary: 'imagery', secondary: ['status-signals'] },
      visualPersonality: { tone: 'editorial', expressiveness: 'expressive', rationale: 'Passengers are choosing discretionary products, so merchandise and purchase confidence lead the composition.' },
      mediaStrategy: { necessity: 'essential', types: ['photo'], capture: 'sourced', fallback: 'Product name and category on a stable neutral image block' },
      accessibilityPriorities: ['large-touch-targets', 'one-handed-reach', 'high-contrast'],
    },
    contextEvidence: 'The catalog and booking connector are online during the flight',
    fixtureValues: ['Cloud Runner - seat delivery', 'Terra Carryall - two left', 'Order CAB-20481'],
    coreJobs: [
      {
        id: 'buy-in-flight',
        statement: 'As a passenger I want to find, choose, and purchase cabin merchandise',
        actor: 'Airline passenger',
        outcome: 'A confirmed order tied to the passenger seat and booking',
        surfaceScreenId: 'shop',
        successOutcome: 'The passenger sees order CAB-20481 and its seat delivery window',
        failureRecovery: 'A failed payment returns to checkout with the selected products intact',
      },
      {
        id: 'manage-flight',
        statement: 'As a passenger I want to manage the booking associated with this order',
        actor: 'Airline passenger',
        outcome: 'The booking and seat context are current before fulfillment',
        surfaceScreenId: 'trip',
        successOutcome: 'The updated seat and booking remain attached to the order',
        failureRecovery: 'A connector failure preserves the previous booking details and offers retry',
      },
    ],
    supportingJobs: [
      { id: 'review-orders', statement: 'As a passenger I want to review current orders', actor: 'Airline passenger', outcome: 'Current and past cabin orders are visible', screenId: 'orders' },
      { id: 'manage-profile', statement: 'As a passenger I want to manage my account and sign out', actor: 'Airline passenger', outcome: 'Account details are accessible without displacing shopping tabs', screenId: 'profile' },
    ],
    requirements: [
      { id: 'search-catalog', jobId: 'buy-in-flight', statement: 'Search products available for delivery to this seat', evidence: 'search the cabin catalog', screenId: 'shop', target: 'Search catalog', operation: { kind: 'external-call', entity: 'Cabin catalog', classification: 'schema-backed' } },
      { id: 'select-product', jobId: 'buy-in-flight', statement: 'Select a product after reviewing price and availability', evidence: 'select products', screenId: 'product', target: 'Add to cart', operation: { kind: 'local-state', entity: 'Cart', classification: 'safe-presentation' } },
      { id: 'purchase-order', jobId: 'buy-in-flight', statement: 'Purchase the selected products with the saved payment method', evidence: 'purchase with a saved card', screenId: 'checkout', target: 'Place order', operation: { kind: 'external-call', entity: 'Order', classification: 'schema-backed' } },
      { id: 'manage-booking', jobId: 'manage-flight', statement: 'Manage the booking and seat associated with fulfillment', evidence: 'manage their booking', screenId: 'trip', target: 'Update booking', operation: { kind: 'external-call', entity: 'Booking', classification: 'schema-backed' } },
      { id: 'review-order', jobId: 'review-orders', statement: 'Review current and completed cabin orders', evidence: 'review orders', screenId: 'orders', target: 'Open order' },
      { id: 'open-profile', jobId: 'manage-profile', statement: 'Open account details and the sign-out action', evidence: 'open their profile', screenId: 'profile', target: 'Manage account' },
    ],
    screens: [
      { id: 'shop', title: 'Shop', pattern: 'discovery', classification: 'durable-destination', jobIds: ['buy-in-flight'], focal: 'Cabin-ready products with seat delivery availability', signature: 'Seat-aware merchandise rail', primaryAction: 'Search catalog', parameterizedBy: 'category', interactionSignature: 'catalog-browse' },
      { id: 'trip', title: 'My trip', pattern: 'overview', classification: 'durable-destination', jobIds: ['manage-flight'], focal: 'Flight, seat, and delivery cutoff in one view', signature: 'Booking context band', primaryAction: 'Update booking' },
      { id: 'orders', title: 'Orders', pattern: 'list', classification: 'durable-destination', jobIds: ['review-orders'], focal: 'Open cabin orders before completed purchases', signature: 'Delivery-window order list', primaryAction: 'Open order', parameterizedBy: 'orderStatus', interactionSignature: 'order-browse' },
      { id: 'product', title: 'Product', pattern: 'detail', classification: 'nested-detail', parentScreenId: 'shop', jobIds: ['buy-in-flight'], focal: 'Product imagery, cabin stock, price, and seat delivery', signature: 'Cabin stock buy bar', primaryAction: 'Add to cart', parameterizedBy: 'productId', interactionSignature: 'catalog-detail' },
      { id: 'checkout', title: 'Checkout', pattern: 'workflow-step', classification: 'bounded-flow-step', jobIds: ['buy-in-flight'], focal: 'Saved card, seat, fulfillment window, and final total', signature: 'Seat-bound commit step', primaryAction: 'Place order' },
      { id: 'confirmation', title: 'Confirmed', pattern: 'confirmation', classification: 'bounded-flow-step', jobIds: ['buy-in-flight'], focal: 'Order CAB-20481 and its delivery-to-seat window', signature: 'Cabin delivery receipt', primaryAction: 'View order' },
      { id: 'profile', title: 'Profile', pattern: 'settings', classification: 'nested-detail', parentScreenId: 'shop', jobIds: ['manage-profile'], focal: 'Passenger account, preferences, and sign out', signature: 'Compact account sheet', primaryAction: 'Manage account' },
    ],
    navigation: { pattern: 'tabs-plus-stacks', durableDestinationIds: ['shop', 'trip', 'orders'], visibleTabIds: ['shop', 'trip', 'orders'], authenticated: true, profileScreenId: 'profile', profileAccess: 'account-action' },
    entities: [
      { name: 'Flight', role: 'supporting', realization: 'connector-source', screenIds: ['trip'] },
      { name: 'Passenger', role: 'supporting', realization: 'connector-source', screenIds: ['profile'] },
      { name: 'Fare', role: 'reference', realization: 'connector-source', screenIds: [] },
      { name: 'Booking', role: 'primary', realization: 'connector-source', screenIds: ['trip'] },
      { name: 'Cabin catalog', role: 'primary', realization: 'connector-source', screenIds: ['shop', 'product'] },
      { name: 'Order', role: 'primary', realization: 'connector-source', screenIds: ['orders', 'checkout', 'confirmation'] },
    ],
    newTableBudget: { target: 0, max: 0 },
  },

  icrcReceiving: {
    brief: 'Build an authenticated field receiving app for ICRC warehouse staff who often lose signal. They need to scan or enter a shipment, receive line items, inspect damaged packages, resolve discrepancies, attach photo evidence, and hand off custody. Work must resume after interruption and retry synchronization.',
    productName: 'Relief Receive',
    primaryGoal: 'Receive relief shipments accurately and preserve evidence through handoff',
    vocabulary: ['shipment', 'pallet', 'waybill', 'discrepancy', 'custody'],
    complexity: 'complex',
    dimensions: {
      primaryUser: { role: 'ICRC warehouse receiver', proficiency: 'practiced', situation: 'Moves between loading bays with gloves, interruptions, and unreliable connectivity' },
      primaryIntent: 'capture',
      workflowShape: 'linear-sequence',
      operatingContext: { environment: 'on-the-floor', connectivity: 'offline-first', interruptionLevel: 'high', handsAvailable: 'gloved' },
      sessionPattern: { frequency: 'many-per-day', duration: 'five-to-fifteen-minutes', resumability: 'must-resume' },
      informationDensity: 'dense',
      interactionTempo: 'rapid',
      collaborationMode: 'hand-off',
      contentEmphasis: { primary: 'status-signals', secondary: ['form-entry'] },
      decisionRisk: { level: 'high', drivers: ['A quantity or custody error affects relief inventory and audit evidence'] },
      visualPersonality: { tone: 'precise', expressiveness: 'restrained', rationale: 'Receivers need fast status recognition and explicit recovery while moving through a noisy loading bay.' },
      mediaStrategy: { necessity: 'supportive', types: ['photo'], capture: 'user-captured', fallback: 'Evidence-required marker with package and discrepancy identifiers' },
      accessibilityPriorities: ['large-touch-targets', 'glove-friendly', 'high-contrast'],
    },
    contextEvidence: 'warehouse staff who often lose signal',
    fixtureValues: ['Shipment ICRC-KE-1042', 'Pallet PLT-77-A', '3 cartons damaged'],
    coreJobs: [{
      id: 'receive-shipment',
      statement: 'As a warehouse receiver I want to receive, inspect, reconcile, and hand off one shipment',
      actor: 'ICRC warehouse receiver',
      outcome: 'A reconciled shipment with evidence and recorded custody',
      surfaceScreenId: 'receiving',
      successOutcome: 'Shipment ICRC-KE-1042 is reconciled and handed to the named custodian',
      failureRecovery: 'The in-progress receipt resumes locally and retries synchronization when connectivity returns',
    }],
    supportingJobs: [
      { id: 'recover-sync', statement: 'As a receiver I want failed synchronization to preserve my work and retry', actor: 'ICRC warehouse receiver', outcome: 'Pending work remains visible and can synchronize later', screenId: 'receiving', surfaceKind: 'section' },
    ],
    requirements: [
      { id: 'receive-items', jobId: 'receive-shipment', statement: 'Scan or manually enter a shipment and receive its line items', evidence: 'scan or enter a shipment', screenId: 'receiving', target: 'Scan or enter shipment', operation: { kind: 'update', entity: 'Shipment', classification: 'schema-backed' } },
      { id: 'inspect-packages', jobId: 'receive-shipment', statement: 'Inspect packages and record quantity and condition', evidence: 'inspect damaged packages', screenId: 'inspection', target: 'Record inspection', operation: { kind: 'create', entity: 'Inspection', classification: 'schema-backed' } },
      { id: 'resolve-discrepancy', jobId: 'receive-shipment', statement: 'Resolve a quantity or condition discrepancy with a reason', evidence: 'resolve discrepancies', screenId: 'discrepancy', target: 'Resolve discrepancy', operation: { kind: 'update', entity: 'Discrepancy', classification: 'schema-backed' } },
      { id: 'attach-evidence', jobId: 'receive-shipment', statement: 'Attach photo evidence to the discrepancy record', evidence: 'attach photo evidence', screenId: 'evidence', target: 'Save evidence', operation: { kind: 'create', entity: 'Evidence', classification: 'schema-backed' } },
      { id: 'handoff-custody', jobId: 'receive-shipment', statement: 'Hand off received custody to the next accountable person', evidence: 'hand off custody', screenId: 'handoff', target: 'Confirm handoff', operation: { kind: 'create', entity: 'Custody event', classification: 'schema-backed' } },
      { id: 'retry-sync', jobId: 'recover-sync', statement: 'Retry synchronization without losing received quantities or evidence', evidence: 'retry synchronization', screenId: 'receiving', mechanism: 'state', target: 'retry' },
    ],
    screens: [
      { id: 'receiving', title: 'Receiving', pattern: 'queue', classification: 'durable-destination', jobIds: ['receive-shipment', 'recover-sync'], focal: 'Current shipment, pending scans, and synchronization status', signature: 'Resume-safe receiving rail', primaryAction: 'Scan or enter shipment', stateExtras: { retry: 'Retry pending receipt synchronization without discarding local quantities or evidence' } },
      { id: 'shipment', title: 'Shipment', pattern: 'detail', classification: 'nested-detail', parentScreenId: 'receiving', jobIds: ['receive-shipment'], focal: 'Waybill, expected packages, and current receiving progress', signature: 'Waybill progress header', primaryAction: 'Continue receiving', parameterizedBy: 'shipmentId', interactionSignature: 'shipment-workspace' },
      { id: 'inspection', title: 'Inspect', pattern: 'workflow-step', classification: 'bounded-flow-step', jobIds: ['receive-shipment'], focal: 'Package quantity and condition checks in line-item order', signature: 'Condition-by-line sweep', primaryAction: 'Record inspection' },
      { id: 'discrepancy', title: 'Discrepancy', pattern: 'form', classification: 'bounded-flow-step', jobIds: ['receive-shipment'], focal: 'Expected versus received quantity with required reason', signature: 'Difference-first resolution', primaryAction: 'Resolve discrepancy' },
      { id: 'evidence', title: 'Evidence', pattern: 'capture', classification: 'modal-or-immersive-utility', jobIds: ['receive-shipment'], focal: 'Photo evidence anchored to pallet and discrepancy', signature: 'Identifier-locked evidence capture', primaryAction: 'Save evidence', mediaRole: 'supportive', cannotMergeBecause: { kind: 'capture-or-workflow-fit', evidence: 'Full-camera evidence capture needs an identifier-locked viewfinder and permission recovery.' } },
      { id: 'handoff', title: 'Handoff', pattern: 'confirmation', classification: 'bounded-flow-step', jobIds: ['receive-shipment'], focal: 'Reconciled totals, pending sync, and receiving custodian', signature: 'Custody receipt', primaryAction: 'Confirm handoff' },
    ],
    navigation: { pattern: 'stack-only', durableDestinationIds: ['receiving'], visibleTabIds: [], authenticated: false, profileAccess: 'not-applicable', stackOnlyReason: 'One bounded receiving journey begins and ends at the receiving queue.', returnHomeMechanism: 'Completion or Back returns to Receiving.' },
    entities: [
      { name: 'Shipment', role: 'primary', realization: 'new-table', screenIds: ['shipment'], jobIds: ['receive-shipment'] },
      { name: 'Package', role: 'supporting', realization: 'child-rows', screenIds: [] },
      { name: 'Line item', role: 'supporting', realization: 'child-rows', screenIds: [] },
      { name: 'Discrepancy', role: 'primary', realization: 'new-table', screenIds: ['discrepancy'], jobIds: ['receive-shipment'] },
      { name: 'Evidence', role: 'supporting', realization: 'new-table', screenIds: ['evidence'], jobIds: ['receive-shipment'] },
      { name: 'Custody event', role: 'primary', realization: 'new-table', screenIds: ['handoff'], jobIds: ['receive-shipment'] },
      { name: 'Inspection', role: 'primary', realization: 'new-table', screenIds: ['inspection'], jobIds: ['receive-shipment'] },
    ],
    newTableBudget: { target: 5, max: 7 },
  },

  gymMaintenance: {
    brief: 'Build an authenticated gym maintenance app for technicians working in basement facilities with intermittent Wi-Fi. They need to scan equipment, inspect it, record defects, attach photo evidence, record repairs, close maintenance work, and open Profile to sign out.',
    productName: 'Gym Floor Care',
    primaryGoal: 'Find gym equipment quickly and complete defensible maintenance work',
    vocabulary: ['equipment', 'gym', 'inspection', 'defect', 'repair'],
    complexity: 'standard',
    dimensions: {
      primaryUser: { role: 'Gym maintenance technician', proficiency: 'practiced', situation: 'Works across basement equipment floors with one hand and intermittent Wi-Fi' },
      primaryIntent: 'resolve',
      workflowShape: 'cyclical-recurring',
      operatingContext: { environment: 'on-the-floor', connectivity: 'intermittent', interruptionLevel: 'high', handsAvailable: 'one-hand' },
      sessionPattern: { frequency: 'many-per-day', duration: 'five-to-fifteen-minutes', resumability: 'must-resume' },
      informationDensity: 'balanced',
      interactionTempo: 'brisk',
      contentEmphasis: { primary: 'status-signals', secondary: ['form-entry'] },
      decisionRisk: { level: 'high', drivers: ['Returning unsafe equipment to service can injure a member'] },
      visualPersonality: { tone: 'confident', expressiveness: 'moderate', rationale: 'Technicians need equipment identity, safety state, and the next maintenance action to dominate.' },
      mediaStrategy: { necessity: 'supportive', types: ['photo'], capture: 'user-captured', fallback: 'Equipment identifier block with a photo-missing safety marker' },
      accessibilityPriorities: ['large-touch-targets', 'one-handed-reach', 'high-contrast'],
    },
    contextEvidence: 'basement facilities with intermittent Wi-Fi',
    fixtureValues: ['Treadmill TM-014 - out of service', 'Cable station CS-008 - inspection due', 'Repair WO-771 - awaiting belt'],
    coreJobs: [{
      id: 'maintain-equipment',
      statement: 'As a technician I want to inspect, repair, and close maintenance for one equipment item',
      actor: 'Gym maintenance technician',
      outcome: 'The equipment has a current safety state and complete maintenance history',
      surfaceScreenId: 'home',
      successOutcome: 'The work order closes with inspection, defects, evidence, and repair history intact',
      failureRecovery: 'Interrupted maintenance resumes on the same equipment and synchronizes later',
    }],
    supportingJobs: [
      { id: 'manage-profile', statement: 'As a technician I want to open Profile and sign out', actor: 'Gym maintenance technician', outcome: 'Account and sign-out remain reachable from Home', screenId: 'profile' },
    ],
    requirements: [
      { id: 'scan-equipment', jobId: 'maintain-equipment', statement: 'Scan equipment or enter its asset tag to open the work record', evidence: 'scan equipment', screenId: 'home', target: 'Scan equipment', operation: { kind: 'read', entity: 'Equipment', classification: 'schema-backed' } },
      { id: 'inspect-equipment', jobId: 'maintain-equipment', statement: 'Inspect the equipment against its safety checklist', evidence: 'inspect it', screenId: 'inspection', target: 'Save inspection', operation: { kind: 'create', entity: 'Inspection', classification: 'schema-backed' } },
      { id: 'record-defect', jobId: 'maintain-equipment', statement: 'Record a defect with severity and affected component', evidence: 'record defects', screenId: 'defect', target: 'Save defect', operation: { kind: 'create', entity: 'Defect', classification: 'schema-backed' } },
      { id: 'attach-evidence', jobId: 'maintain-equipment', statement: 'Attach photo evidence to the current defect', evidence: 'attach photo evidence', screenId: 'defect', surfaceKind: 'section', target: 'Attach photo', operation: { kind: 'update', entity: 'Defect', classification: 'schema-backed' } },
      { id: 'record-repair', jobId: 'maintain-equipment', statement: 'Record parts, labor, and the completed repair', evidence: 'record repairs', screenId: 'repair', target: 'Save repair', operation: { kind: 'create', entity: 'Repair', classification: 'schema-backed' } },
      { id: 'close-work', jobId: 'maintain-equipment', statement: 'Close maintenance only after safety checks are complete', evidence: 'close maintenance work', screenId: 'closed', target: 'Close work', operation: { kind: 'update', entity: 'Equipment', classification: 'schema-backed' } },
      { id: 'open-profile', jobId: 'manage-profile', statement: 'Open Profile and sign out of the technician account', evidence: 'open Profile to sign out', screenId: 'profile', target: 'Open account' },
    ],
    screens: [
      { id: 'home', title: 'My shift', pattern: 'overview', classification: 'durable-destination', jobIds: ['maintain-equipment'], focal: 'Assigned work and a scan-first equipment entry', signature: 'Shift-to-scan work rail', primaryAction: 'Scan equipment' },
      { id: 'equipment', title: 'Equipment', pattern: 'detail', classification: 'nested-detail', parentScreenId: 'home', jobIds: ['maintain-equipment'], focal: 'Identity, safety state, open work, and warranty context', signature: 'Safety-state equipment header', primaryAction: 'Start inspection', parameterizedBy: 'equipmentType', interactionSignature: 'equipment-detail' },
      { id: 'inspection', title: 'Inspection', pattern: 'workflow-step', classification: 'bounded-flow-step', jobIds: ['maintain-equipment'], focal: 'Checklist progress with failed safety items first', signature: 'Failure-first checklist', primaryAction: 'Save inspection' },
      { id: 'defect', title: 'Defect', pattern: 'capture', classification: 'modal-or-immersive-utility', jobIds: ['maintain-equipment'], focal: 'Defect severity, component, and photo evidence', signature: 'Evidence-bound defect capture', primaryAction: 'Save defect', secondaryActions: ['Attach photo'], mediaRole: 'supportive' },
      { id: 'repair', title: 'Repair', pattern: 'form', classification: 'bounded-flow-step', jobIds: ['maintain-equipment'], focal: 'Parts, labor, technician note, and return-to-service decision', signature: 'Repair-to-safety commit', primaryAction: 'Save repair' },
      { id: 'closed', title: 'Work complete', pattern: 'confirmation', classification: 'bounded-flow-step', jobIds: ['maintain-equipment'], focal: 'Completed checks, evidence, repair, and final safety state', signature: 'Safety receipt', primaryAction: 'Close work' },
      { id: 'profile', title: 'Profile', pattern: 'settings', classification: 'nested-detail', parentScreenId: 'home', jobIds: ['manage-profile'], focal: 'Technician account, assigned gyms, and sign out', signature: 'Shift account sheet', primaryAction: 'Open account' },
    ],
    navigation: { pattern: 'stack-only', durableDestinationIds: ['home'], visibleTabIds: [], authenticated: true, profileScreenId: 'profile', profileAccess: 'account-action', stackOnlyReason: 'Home is the single shift entry for the bounded equipment maintenance flow.', returnHomeMechanism: 'Completion and Back return to My shift.' },
    entities: [
      { name: 'Equipment', role: 'primary', realization: 'existing-table', screenIds: ['equipment'] },
      { name: 'Equipment type', role: 'reference', realization: 'choice-column', screenIds: [] },
      { name: 'Gym location', role: 'supporting', realization: 'existing-table', screenIds: [] },
      { name: 'Inspection', role: 'primary', realization: 'new-table', screenIds: ['inspection'], jobIds: ['maintain-equipment'] },
      { name: 'Defect', role: 'supporting', realization: 'new-table', screenIds: ['defect'], jobIds: ['maintain-equipment'] },
      { name: 'Repair', role: 'primary', realization: 'new-table', screenIds: ['repair'], jobIds: ['maintain-equipment'] },
    ],
    newTableBudget: { target: 3, max: 5 },
  },

  itAssetTracking: {
    brief: 'Build authenticated company IT asset tracking for asset stewards. They need to find assets across laptops, phones, and docks; assign them; transfer ownership or location; audit condition; record repairs; retire devices; and manage their account. Show permission-denied and no-results states inside the relevant surfaces.',
    productName: 'Asset Steward',
    primaryGoal: 'Understand company asset status and complete the next accountable action',
    vocabulary: ['asset', 'custodian', 'location', 'audit', 'repair', 'retirement'],
    complexity: 'standard',
    dimensions: {
      primaryUser: { role: 'IT asset steward', proficiency: 'expert', situation: 'Works at a desk and around offices while reconciling company devices' },
      primaryIntent: 'monitor',
      workflowShape: 'hub-and-spoke',
      operatingContext: { environment: 'mixed', connectivity: 'always-online', interruptionLevel: 'moderate', handsAvailable: 'one-hand' },
      sessionPattern: { frequency: 'daily', duration: 'five-to-fifteen-minutes', resumability: 'helpful-to-resume' },
      informationDensity: 'dense',
      interactionTempo: 'steady',
      collaborationMode: 'shared-team',
      contentEmphasis: { primary: 'status-signals', secondary: ['quantitative-data'] },
      decisionRisk: { level: 'high', drivers: ['Incorrect custody or retirement creates security and financial exposure'] },
      visualPersonality: { tone: 'quiet', expressiveness: 'restrained', rationale: 'Asset identity, custody, warranty, and exception evidence must remain easy to compare.' },
      mediaStrategy: { necessity: 'none', types: [], capture: 'none', fallback: 'Asset identifiers and condition signals carry the complete meaning' },
      accessibilityPriorities: ['color-independent-status', 'high-contrast', 'large-touch-targets'],
    },
    contextEvidence: 'Works at a desk and around offices while reconciling company devices',
    fixtureValues: ['Laptop LT-2048 - assigned to Morgan Lee', 'Phone PH-311 - audit overdue', 'Dock DK-088 - repair in progress'],
    coreJobs: [
      {
        id: 'steward-inventory',
        statement: 'As an asset steward I want to find, assign, transfer, and retire company assets',
        actor: 'IT asset steward',
        outcome: 'Each asset has current custody, location, and lifecycle state',
        surfaceScreenId: 'inventory',
        successOutcome: 'The selected asset has a current accountable owner and lifecycle state',
        failureRecovery: 'A failed custody change preserves the previous owner and provides a retry path',
      },
      {
        id: 'service-assets',
        statement: 'As an asset steward I want to audit condition and coordinate repairs',
        actor: 'IT asset steward',
        outcome: 'Audit exceptions become tracked repair work',
        surfaceScreenId: 'work-queue',
        successOutcome: 'Every due audit is completed or converted to accountable repair work',
        failureRecovery: 'A failed save keeps the audit or repair draft on the current asset',
      },
    ],
    supportingJobs: [
      { id: 'manage-account', statement: 'As an asset steward I want to manage my account and sign out', actor: 'IT asset steward', outcome: 'Account and sign-out are reachable as a durable destination', screenId: 'account' },
      { id: 'handle-search-states', statement: 'As an asset steward I need access and no-result feedback in context', actor: 'IT asset steward', outcome: 'Search and access failures stay on their owning surfaces', screenId: 'inventory', surfaceKind: 'section' },
    ],
    requirements: [
      { id: 'find-assets', jobId: 'steward-inventory', statement: 'Find assets across laptops, phones, and docks', evidence: 'find assets across laptops, phones, and docks', screenId: 'inventory', target: 'Find asset', operation: { kind: 'read', entity: 'Asset', classification: 'schema-backed' } },
      { id: 'assign-asset', jobId: 'steward-inventory', statement: 'Assign an asset to an accountable custodian', evidence: 'assign them', screenId: 'asset', target: 'Assign asset', operation: { kind: 'update', entity: 'Asset', classification: 'schema-backed' } },
      { id: 'transfer-asset', jobId: 'steward-inventory', statement: 'Transfer asset ownership or location with an audit note', evidence: 'transfer ownership or location', screenId: 'transfer', target: 'Confirm transfer', operation: { kind: 'update', entity: 'Asset', classification: 'schema-backed' } },
      { id: 'audit-condition', jobId: 'service-assets', statement: 'Audit an asset condition and warranty status', evidence: 'audit condition', screenId: 'audit', target: 'Save audit', operation: { kind: 'create', entity: 'Asset audit', classification: 'schema-backed' } },
      { id: 'record-repair', jobId: 'service-assets', statement: 'Record repair work and its current disposition', evidence: 'record repairs', screenId: 'repair', target: 'Save repair', operation: { kind: 'create', entity: 'Repair', classification: 'schema-backed' } },
      { id: 'retire-device', jobId: 'steward-inventory', statement: 'Retire a device with disposition and data-wipe evidence', evidence: 'retire devices', screenId: 'retire', target: 'Retire asset', operation: { kind: 'update', entity: 'Asset', classification: 'schema-backed' } },
      { id: 'manage-account', jobId: 'manage-account', statement: 'Manage the asset-steward account and sign out', evidence: 'manage their account', screenId: 'account', target: 'Manage account' },
      { id: 'permission-feedback', jobId: 'handle-search-states', statement: 'Show permission denial inside the asset surface', evidence: 'permission-denied', screenId: 'asset', mechanism: 'state', target: 'permission' },
      { id: 'no-results-feedback', jobId: 'handle-search-states', statement: 'Show no search results inside Inventory', evidence: 'no-results', screenId: 'inventory', mechanism: 'state', target: 'noResults' },
    ],
    screens: [
      { id: 'inventory', title: 'Inventory', pattern: 'list', classification: 'durable-destination', jobIds: ['steward-inventory', 'handle-search-states'], focal: 'Searchable asset identity with custody and exception signals', signature: 'Exception-aware inventory list', primaryAction: 'Find asset', parameterizedBy: 'assetCategory', interactionSignature: 'asset-browse', stateExtras: { noResults: 'Keep filters visible and offer tag scan or query adjustment when no assets match' } },
      { id: 'work-queue', title: 'Work', pattern: 'queue', classification: 'durable-destination', jobIds: ['service-assets'], focal: 'Overdue audits, repair blockers, and warranty risk', signature: 'Accountability-ranked work queue', primaryAction: 'Open work item' },
      { id: 'account', title: 'Account', pattern: 'settings', classification: 'durable-destination', jobIds: ['manage-account'], focal: 'Steward identity, organization scope, and sign out', signature: 'Scoped account center', primaryAction: 'Manage account' },
      { id: 'asset', title: 'Asset', pattern: 'detail', classification: 'nested-detail', parentScreenId: 'inventory', jobIds: ['steward-inventory', 'handle-search-states'], focal: 'Identity, custodian, location, warranty, and status history', signature: 'Custody-first asset record', primaryAction: 'Assign asset', parameterizedBy: 'assetCategory', interactionSignature: 'asset-detail', stateExtras: { permission: 'Explain which asset scope is unavailable and keep a route back to Inventory' } },
      { id: 'transfer', title: 'Transfer', pattern: 'form', classification: 'bounded-flow-step', jobIds: ['steward-inventory'], focal: 'Current and new custodian or location with effective date', signature: 'Before-and-after custody commit', primaryAction: 'Confirm transfer' },
      { id: 'audit', title: 'Audit', pattern: 'workflow-step', classification: 'bounded-flow-step', jobIds: ['service-assets'], focal: 'Condition, ownership, warranty, and evidence checks', signature: 'Condition exception sweep', primaryAction: 'Save audit' },
      { id: 'repair', title: 'Repair', pattern: 'detail', classification: 'nested-detail', parentScreenId: 'work-queue', jobIds: ['service-assets'], focal: 'Repair owner, parts status, cost, and next checkpoint', signature: 'Repair accountability timeline', primaryAction: 'Save repair', parameterizedBy: 'repairId', interactionSignature: 'repair-detail' },
      { id: 'retire', title: 'Retire', pattern: 'confirmation', classification: 'bounded-flow-step', jobIds: ['steward-inventory'], focal: 'Disposition, data-wipe evidence, and irreversible impact', signature: 'Irreversible retirement receipt', primaryAction: 'Retire asset' },
    ],
    navigation: { pattern: 'tabs-plus-stacks', durableDestinationIds: ['inventory', 'work-queue', 'account'], visibleTabIds: ['inventory', 'work-queue', 'account'], authenticated: true, profileScreenId: 'account', profileAccess: 'tab' },
    entities: [
      { name: 'Asset', role: 'primary', realization: 'existing-table', screenIds: ['inventory', 'asset', 'transfer', 'retire'] },
      { name: 'Asset type', role: 'reference', realization: 'choice-column', screenIds: [] },
      { name: 'Location', role: 'supporting', realization: 'existing-table', screenIds: [] },
      { name: 'Owner', role: 'supporting', realization: 'existing-table', screenIds: [] },
      { name: 'Status', role: 'reference', realization: 'choice-column', screenIds: [] },
      { name: 'Device category', role: 'reference', realization: 'choice-column', screenIds: [] },
      { name: 'Asset audit', role: 'primary', realization: 'new-table', screenIds: ['audit'], jobIds: ['service-assets'] },
      { name: 'Repair', role: 'primary', realization: 'new-table', screenIds: ['repair'], jobIds: ['service-assets'] },
    ],
    newTableBudget: { target: 2, max: 4 },
  },
};

function statesFor(screen, offlineSelected) {
  return {
    ...defaultStates(screen.title, { offline: offlineSelected }),
    ...(screen.stateExtras || {}),
  };
}

function acceptanceBundle(key) {
  const descriptor = ACCEPTANCE_SCENARIOS[key];
  if (!descriptor) throw new Error(`Unknown acceptance scenario: ${key}`);

  const experience = buildExperience({
    productName: descriptor.productName,
    domainVocabulary: descriptor.vocabulary,
    primaryGoal: descriptor.primaryGoal,
    ...descriptor.dimensions,
    promptEvidence: {
      operatingContext: evidence(descriptor.contextEvidence),
      primaryGoal: evidence(descriptor.primaryGoal),
    },
  });
  const offlineSelected = ['intermittent', 'offline-first'].includes(
    experience.operatingContext.connectivity,
  );
  const requirementById = new Map(descriptor.requirements.map((item) => [item.id, item]));
  const coreJobIds = new Set(descriptor.coreJobs.map((job) => job.id));

  const requirements = descriptor.requirements.map((item) => ({
    id: item.id,
    statement: item.statement,
    evidence: item.evidence,
    disposition: 'shipping',
    jobId: item.jobId,
  }));
  const requirementCoverage = descriptor.requirements.map((item) => ({
    requirementId: item.id,
    screenId: item.screenId,
    mechanism: item.mechanism || 'action',
    target: item.target,
  }));
  const coreJobs = descriptor.coreJobs.map((job) => ({
    id: job.id,
    statement: job.statement,
    actor: job.actor,
    outcome: job.outcome,
    criticality: 'critical',
    surface: { kind: 'screen', screenId: job.surfaceScreenId },
    criticalSteps: descriptor.requirements
      .filter((item) => item.jobId === job.id)
      .map((item) => item.id),
    evidence: job.evidence || descriptor.primaryGoal,
  }));
  const supportingJobs = descriptor.supportingJobs.map((job) => ({
    id: job.id,
    statement: job.statement,
    actor: job.actor,
    outcome: job.outcome,
    surface: {
      kind: job.surfaceKind || 'screen',
      screenId: job.screenId,
      ...(job.surfaceKind && job.surfaceKind !== 'screen' ? { detail: `${job.statement} on ${job.screenId}` } : {}),
    },
    evidence: job.evidence || descriptor.primaryGoal,
  }));
  const screens = descriptor.screens.map((screen) => ({
    id: screen.id,
    route: `/${screen.id}`,
    title: screen.title,
    purpose: `${screen.title} lets the user answer: ${screen.focal}`,
    userFacing: true,
    pattern: screen.pattern,
    jobIds: screen.jobIds,
    classification: screen.classification,
    ...(screen.parentScreenId ? { parentScreenId: screen.parentScreenId } : {}),
    ...(screen.cannotMergeBecause ? { cannotMergeBecause: screen.cannotMergeBecause } : {}),
    ...(screen.interactionSignature ? { interactionSignature: screen.interactionSignature } : {}),
    ...(screen.parameterizedBy ? { parameterizedBy: screen.parameterizedBy } : {}),
    justification: `${screen.focal}; this is a ${screen.classification} in the approved job graph.`,
    compositionNote: `${screen.signature} defines the product-specific interaction rather than an entity CRUD template.`,
  }));
  const newTables = descriptor.entities
    .filter((entity) => entity.realization === 'new-table')
    .map((entity) => ({
      name: entity.name,
      jobIds: entity.jobIds,
      lifecycleJustification: {
        reasons: ['independent-lifecycle', 'independent-querying-or-reporting'],
        statement: `${entity.name} has an independent lifecycle and must remain queryable for the jobs it supports.`,
      },
    }));
  const dataEntities = descriptor.entities.map(({ jobIds, ...entity }) => entity);
  const scope = buildScope(experience, {
    productComplexity: descriptor.complexity,
    complexityJustification: `The brief contains ${descriptor.coreJobs.length} core job(s), ${descriptor.supportingJobs.length} supporting job(s), and a connected mobile workflow.`,
    requirements,
    requirementCoverage,
    coreJobs,
    supportingJobs,
    screens,
    screenBudget: { target: screens.length, max: descriptor.complexity === 'complex' ? 12 : 9 },
    navigation: descriptor.navigation,
    newTableBudget: descriptor.newTableBudget,
    newTables,
    dataEntities,
  });

  const journey = buildJourney(experience, scope, {
    journeys: descriptor.coreJobs.map((job) => {
      const jobRequirements = descriptor.requirements.filter((item) => item.jobId === job.id);
      return {
        id: `${job.id}-journey`,
        jobId: job.id,
        name: `${job.id} workflow`,
        resumable: experience.sessionPattern.resumability === 'must-resume',
        steps: jobRequirements.map((requirement, index) => {
          const screen = descriptor.screens.find((item) => item.id === requirement.screenId);
          return {
            id: requirement.id,
            order: index + 1,
            label: requirement.target,
            satisfies: [requirement.id],
            surface: { kind: requirement.surfaceKind || 'screen', screenId: requirement.screenId },
            userAction: requirement.statement,
            dataOperation: requirement.operation || { kind: 'read', entity: descriptor.entities[0].name, classification: 'schema-backed' },
            entryCondition: index === 0 ? 'The user starts this job' : 'The previous required step succeeded',
            exitCondition: `${requirement.target} succeeds`,
            states: statesFor(screen, offlineSelected),
          };
        }),
        successOutcome: job.successOutcome,
        failureRecovery: job.failureRecovery,
      };
    }),
  });

  const buildPack = buildBuildPack(experience, scope, journey, {
    packs: descriptor.screens.map((screen) => {
      const screenRequirements = descriptor.requirements.filter((item) => (
        item.screenId === screen.id && (item.mechanism || 'action') === 'action'
      ));
      const actionLabels = [...new Set([
        screen.primaryAction,
        ...(screen.secondaryActions || []),
        ...screenRequirements.map((item) => item.target),
      ].filter(Boolean))];
      const primaryAction = screen.primaryAction || actionLabels[0] || 'Continue';
      const mediaRequired = experience.mediaStrategy.necessity === 'essential'
        && screen.jobIds.some((jobId) => coreJobIds.has(jobId));
      const mediaRole = screen.mediaRole || (mediaRequired ? 'essential' : 'none');
      const previewRecords = descriptor.fixtureValues.map((value, index) => ({
        title: value,
        subtitle: `${screen.title}: ${index === 0 ? screen.focal : 'Related context for the current job'}`,
        meta: index === 0 ? 'Current' : `Evidence ${index + 1}`,
        ...(mediaRole !== 'none' ? { mediaLabel: `${value} product or evidence image` } : {}),
      }));
      return {
        screenId: screen.id,
        route: `/${screen.id}`,
        purpose: `${screen.title} supports ${screen.jobIds.join(', ')} without creating an entity-driven route family.`,
        userQuestion: `What does the user need to know or do on ${screen.title}?`,
        firstViewport: { regionOrder: ['context', 'focal-content', 'primary-action'], focalContent: screen.focal, primaryAction },
        hierarchy: { dominant: screen.focal, supporting: [screen.signature] },
        primaryActions: [{ label: primaryAction, outcome: `${primaryAction} advances the approved job` }],
        secondaryActions: actionLabels
          .filter((label) => label !== primaryAction)
          .map((label) => ({ label, outcome: `${label} completes its explicit requirement` })),
        trustSignals: [{ label: `${descriptor.productName} source and status are visible`, classification: 'safe-presentation' }],
        decisionSupport: [{ label: screen.signature, classification: 'safe-presentation' }],
        media: mediaRole === 'none'
          ? { role: 'none' }
          : { role: mediaRole, treatment: 'Stable focal media with identity visible', source: experience.mediaStrategy.capture, fallback: experience.mediaStrategy.fallback },
        context: { vocabulary: descriptor.vocabulary, contextualData: [{ label: descriptor.fixtureValues[0], classification: 'safe-presentation' }] },
        states: statesFor(screen, offlineSelected),
        navigation: { incoming: [], outgoing: [] },
        signatureInteraction: { name: screen.signature, description: `${screen.signature} makes ${screen.title} specific to ${descriptor.productName}.` },
        forbiddenDefaults: ['Entity-driven list, detail, and form triplet with no job boundary'],
        dataAssumptions: [],
        previewContent: {
          eyebrow: descriptor.productName,
          headline: screen.focal,
          supportingText: `${screen.title} is grounded in the approved job and realistic fixture records.`,
          ...(mediaRole !== 'none' ? { heroMediaLabel: `${descriptor.fixtureValues[0]} focal image` } : {}),
          metrics: [
            { label: 'Primary action', value: primaryAction },
            { label: 'Current context', value: descriptor.fixtureValues[0] },
          ],
          records: previewRecords,
          fields: [{ label: 'Job', value: screen.jobIds[0] }],
          summaryRows: [{ label: 'Outcome', value: screen.signature }],
        },
        composition: { kind: screen.pattern, rationale: `${screen.focal} requires the ${screen.pattern} composition and ${screen.signature}.` },
      };
    }),
  });

  for (const requirement of descriptor.requirements) {
    if (!requirementById.has(requirement.id)) throw new Error(`Missing requirement ${requirement.id}`);
  }
  return { descriptor, experience, scope, journey, buildPack };
}

module.exports = { ACCEPTANCE_SCENARIOS, acceptanceBundle };