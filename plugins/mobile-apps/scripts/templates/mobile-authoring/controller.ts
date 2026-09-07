export type RecordReference = { conceptId: string; recordId: string; label?: string };
export type TargetRole = 'screen' | 'collection' | 'item' | 'form' | 'field' | 'action' | 'surface';
export type TargetMetadata = { id: string; label: string; role: TargetRole; actionId?: string };
export type ScreenMetadata = { screenId: string; route: string; targets: readonly TargetMetadata[] };
export type Registry = { schemaVersion: 1; appInstanceId: string; screens: readonly ScreenMetadata[] };
export type DataPreview = { previewKind: 'active' | 'candidate'; dataNamespace: string; baseDataNamespace?: string };
export type SourceStamp = DataPreview & { protocolVersion: 2; appInstanceId: string; jobId: string; previewRevision: string };
export type Bounds = { x: number; y: number; width: number; height: number };
export type Issue = { code: string; message: string };
export type AuthoringState = { phase: 'checking' | 'standalone' | 'active' | 'blocked'; issue: Issue | null; acknowledgedScreenId: string | null };
export type ScreenLease = { readonly id: number; readonly screenId: string };
export type NativeResult = { available: boolean; reason?: string; acknowledged?: boolean };
export type NativeAuthoringModule = {
  getCurrentSession?: () => Promise<unknown>;
  getDiagnostics?: () => Promise<unknown>;
  getAuthoringCapabilities?: () => Promise<unknown>;
  registerAuthoringContext?: (context: object, targets: object[]) => Promise<NativeResult>;
  clearAuthoringContext?: (screenId: string) => Promise<NativeResult>;
  reportAuthoringReady?: (input: object) => Promise<NativeResult>;
};

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const namespace = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/;
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && identifier.test(value) && !/[\r\n]/.test(value);
}
function sameSource(value: unknown, stamp: SourceStamp): boolean {
  const input = object(value);
  return !!input && input.protocolVersion === 2 && input.appInstanceId === stamp.appInstanceId
    && input.jobId === stamp.jobId && input.previewRevision === stamp.previewRevision && input.previewKind === stamp.previewKind;
}

export function readSourceStamp(value: unknown, appInstanceId: string): SourceStamp | null {
  const input = object(value);
  if (input?.protocolVersion === 2 && input.active === false && Object.keys(input).every((key) => ['protocolVersion', 'active'].includes(key))) return null;
  if (!input || input.protocolVersion !== 2 || input.appInstanceId !== appInstanceId
    || !validId(input.appInstanceId) || !validId(input.jobId)
    || typeof input.previewRevision !== 'string' || input.previewRevision.length !== 64 || !/^[a-f0-9]{64}$/.test(input.previewRevision)
    || !['active', 'candidate'].includes(input.previewKind as string)
    || typeof input.dataNamespace !== 'string' || input.dataNamespace.length > 240 || !namespace.test(input.dataNamespace)
    || /[\r\n]/.test(input.dataNamespace)
    || (input.baseDataNamespace !== undefined && (typeof input.baseDataNamespace !== 'string'
      || input.baseDataNamespace.length > 240 || !namespace.test(input.baseDataNamespace) || /[\r\n]/.test(input.baseDataNamespace)))
    || Object.keys(input).some((key) => !['protocolVersion', 'appInstanceId', 'jobId', 'previewRevision', 'previewKind', 'dataNamespace', 'baseDataNamespace'].includes(key))) {
    throw new Error('The publisher source stamp is missing or invalid.');
  }
  if (input.previewKind === 'candidate' && (input.dataNamespace === 'active' || input.dataNamespace === (input.baseDataNamespace ?? 'active'))) {
    throw new Error('Candidate data must use an isolated namespace.');
  }
  return {
    protocolVersion: 2, appInstanceId: input.appInstanceId, jobId: input.jobId,
    previewRevision: input.previewRevision, previewKind: input.previewKind as DataPreview['previewKind'],
    dataNamespace: input.dataNamespace, ...(input.baseDataNamespace === undefined ? {} : { baseDataNamespace: input.baseDataNamespace as string }),
  };
}

function reference(value: RecordReference | undefined): RecordReference | undefined {
  if (value === undefined) return undefined;
  const input = object(value);
  if (!input || !validId(input.conceptId) || typeof input.recordId !== 'string' || !input.recordId.trim()
    || input.recordId.length > 256 || (input.label !== undefined && (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 200))
    || Object.keys(input).some((key) => !['conceptId', 'recordId', 'label'].includes(key))) {
    throw new Error('Only a minimal record reference is allowed.');
  }
  return {
    conceptId: input.conceptId, recordId: input.recordId.trim(),
    ...(input.label === undefined ? {} : { label: (input.label as string).trim() }),
  };
}
function bounds(value: Bounds | null): Bounds | null {
  if (!value || ['x', 'y', 'width', 'height'].some((key) => {
    const item = value[key as keyof Bounds];
    return typeof item !== 'number' || !Number.isFinite(item) || Math.abs(item) > 100000;
  }) || value.width <= 0 || value.height <= 0) return null;
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}
function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Authoring operation timed out.')), milliseconds);
    work.then((value) => { clearTimeout(timeout); resolve(value); }, (error) => { clearTimeout(timeout); reject(error); });
  });
}

type TargetRegistration = { token: number; metadata: TargetMetadata; measure: () => Promise<Bounds | null>; recordRef?: RecordReference };
type FocusedScreen = {
  lease: ScreenLease; metadata: ScreenMetadata; laidOut: boolean; ready: boolean; dirty: boolean;
  targets: Map<string, TargetRegistration>;
};
export type RuntimeOptions = {
  registry: Registry;
  stamp: unknown;
  getNativeModule: () => NativeAuthoringModule | null;
  configureDataPreview: (preview: DataPreview) => void | Promise<void>;
  schedule?: (work: () => void) => void;
};

/** App-owned coordinator. It never polls, derives a stamp from native state, or issues maker decisions. */
export function createAuthoringRuntime(options: RuntimeOptions) {
  let state: AuthoringState = { phase: 'checking', issue: null, acknowledgedScreenId: null };
  const listeners = new Set<() => void>();
  let native: NativeAuthoringModule | null = null;
  let stamp: SourceStamp | null = null;
  let configuredKey: string | null = null;
  let initializing: Promise<AuthoringState> | null = null;
  let current: FocusedScreen | null = null;
  let nextId = 0;
  let geometryEpoch = 0;
  let generation = 0;
  let suspended = false;
  let scheduled = false;
  let serial: Promise<void> = Promise.resolve();
  const acknowledged = new Set<string>();
  const acknowledging = new Set<string>();
  const schedule = options.schedule ?? ((work: () => void) => { queueMicrotask(work); });

  function publish(patch: Partial<AuthoringState>) {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  }
  function issue(code: string, message: string, blocked = false) {
    if (state.phase === 'standalone' && !blocked) return;
    publish({ issue: { code, message }, ...(blocked ? { phase: 'blocked' } : {}) });
  }
  function owns(lease: ScreenLease | null): lease is ScreenLease {
    return !!lease && current?.lease.id === lease.id && current.lease.screenId === lease.screenId;
  }
  function enqueue(work: () => Promise<void>) {
    serial = serial.then(work).catch(() => {
      issue('native-request-failed', 'Native authoring failed. Retry from the current screen.');
    });
    return serial;
  }
  function context(screen: FocusedScreen) {
    return {
      protocolVersion: 2, appInstanceId: stamp!.appInstanceId, jobId: stamp!.jobId, previewRevision: stamp!.previewRevision,
      scope: 'screen', screenId: screen.metadata.screenId, route: screen.metadata.route, hasUnsavedChanges: screen.dirty,
    };
  }
  function eligible(screen: FocusedScreen, epoch: number) {
    return state.phase === 'active' && !suspended && current === screen && geometryEpoch === epoch && !!stamp && !!native;
  }
  async function acknowledgeMounted(screen: FocusedScreen, source: SourceStamp, key: string) {
    const stillCurrent = () => state.phase === 'active' && !suspended && current === screen
      && !!stamp && sameSource(stamp, source) && screen.ready && screen.laidOut;
    try {
      const ready = await bounded(Promise.resolve(native!.reportAuthoringReady!({
        protocolVersion: 2, appInstanceId: source.appInstanceId, jobId: source.jobId,
        previewRevision: source.previewRevision, screenId: screen.metadata.screenId,
      })), 8000);
      if (!stillCurrent()) return;
      if (ready?.available !== true || ready.acknowledged !== true) {
        issue('acknowledgement-unavailable', 'This mounted screen has not been acknowledged. Retry from the current screen.');
        return;
      }
      acknowledged.add(key);
      publish({
        acknowledgedScreenId: screen.metadata.screenId,
        issue: state.issue?.code.startsWith('acknowledgement-') ? null : state.issue,
      });
    } catch {
      if (stillCurrent()) issue('acknowledgement-failed', 'This mounted screen has not been acknowledged. Retry from the current screen.');
    } finally { acknowledging.delete(key); }
  }
  async function register(screen: FocusedScreen, epoch: number, targets: object[], acknowledge: boolean) {
    if (!eligible(screen, epoch)) return;
    const registered = await bounded(Promise.resolve(native!.registerAuthoringContext!(context(screen), targets)), 5000);
    if (!eligible(screen, epoch)) return;
    if (registered?.available !== true) {
      issue('registration-unavailable', 'Screen targeting is unavailable. Reconnect the builder or retry registration.');
      return;
    }
    if (['registration-unavailable', 'registration-failed', 'native-request-failed'].includes(state.issue?.code ?? '')) publish({ issue: null });
    if (!acknowledge || !screen.ready || !screen.laidOut) return;
    const key = `${stamp!.appInstanceId}:${stamp!.jobId}:${stamp!.previewRevision}:${screen.metadata.screenId}`;
    if (acknowledged.has(key) || acknowledging.has(key)) return;
    acknowledging.add(key);
    // Network acknowledgement must not hold up scroll/focus geometry invalidation.
    void acknowledgeMounted(screen, stamp!, key);
  }
  async function measureCurrent() {
    const screen = current;
    const epoch = geometryEpoch;
    if (!screen || !eligible(screen, epoch) || !screen.ready || !screen.laidOut) return;
    const registrations = Array.from(screen.targets.values());
    const measured = await Promise.all(registrations.map(async (target) => {
      try {
        const measuredBounds = bounds(await bounded(Promise.resolve(target.measure()), 1500));
        if (!measuredBounds) return null;
        return {
          ...target.metadata, screenId: screen.metadata.screenId, bounds: measuredBounds,
          ...(target.recordRef ? { recordRef: target.recordRef } : {}),
        };
      } catch {
        return null;
      }
    }));
    if (!eligible(screen, epoch)) return;
    if (measured.some((target) => target === null)) issue('measurement-unavailable', 'Some targets could not be measured. Re-measure after layout.');
    else if (state.issue?.code === 'measurement-unavailable') publish({ issue: null });
    await enqueue(() => register(screen, epoch, measured.filter((target): target is NonNullable<typeof target> => target !== null), true));
  }
  function invalidate() {
    geometryEpoch++;
    const screen = current;
    const epoch = geometryEpoch;
    if (screen && state.phase === 'active' && !suspended) {
      // Clear geometry immediately while preserving the screen's dirty flag.
      void enqueue(() => register(screen, epoch, [], false));
    }
    if (!scheduled) {
      scheduled = true;
      schedule(() => {
        scheduled = false;
        void measureCurrent().catch(() => issue('registration-failed', 'Screen registration failed. Retry after layout.'));
      });
    }
  }

  async function initialize(): Promise<AuthoringState> {
    if (initializing) return initializing;
    const expected = ++generation;
    const operation = Promise.resolve().then(async () => {
      try {
        stamp = readSourceStamp(options.stamp, options.registry.appInstanceId);
        try { native = options.getNativeModule(); } catch { native = null; }
        if (!native?.getCurrentSession) {
          if (stamp) issue('native-rebuild-required', 'This published preview requires a compatible native Player. Reopen it from the builder.', true);
          else publish({ phase: 'standalone', issue: null, acknowledgedScreenId: null });
          return state;
        }
        const session = object(await bounded(Promise.resolve(native.getCurrentSession()), 5000));
        if (expected !== generation) return state;
        if (!session?.authoring) {
          if (stamp) issue('unauthenticated-preview', 'This published preview has no active authenticated builder session. Reopen it from the builder.', true);
          else publish({ phase: 'standalone', issue: null, acknowledgedScreenId: null });
          return state;
        }
        if (!stamp || !sameSource(session.authoring, stamp)) {
          issue('source-mismatch', 'This preview does not match the publisher source stamp. Reload it from the builder.', true);
          return state;
        }
        if (!native.getDiagnostics || !native.getAuthoringCapabilities || !native.registerAuthoringContext
          || !native.clearAuthoringContext || !native.reportAuthoringReady) {
          issue('native-rebuild-required', 'Rebuild Mobile Preview to enable source-bound authoring.', true);
          return state;
        }
        const [rawCapabilities, rawDiagnostics] = await Promise.all([
          bounded(Promise.resolve(native.getAuthoringCapabilities()), 5000),
          bounded(Promise.resolve(native.getDiagnostics()), 5000),
        ]);
        if (expected !== generation) return state;
        const capabilities = object(rawCapabilities);
        const diagnostics = object(rawDiagnostics);
        const diagnosticSession = object(diagnostics?.currentSession);
        if (capabilities?.protocolVersion !== 2 || ['context', 'selection', 'handoff', 'revisionAcknowledgement'].some((key) => capabilities[key] !== true)) {
          issue('native-rebuild-required', 'Rebuild Mobile Preview to enable source-bound authoring.', true);
          return state;
        }
        if (diagnostics?.isRunningDevSession !== true || object(diagnostics.authoring)?.authenticated !== true
          || !sameSource(diagnosticSession?.authoring, stamp)) {
          issue('unauthenticated-preview', 'Reconnect this preview through the builder before using its data or authoring controls.', true);
          return state;
        }
        const selection: DataPreview = {
          previewKind: stamp.previewKind, dataNamespace: stamp.dataNamespace,
          ...(stamp.baseDataNamespace === undefined ? {} : { baseDataNamespace: stamp.baseDataNamespace }),
        };
        const key = JSON.stringify(selection);
        if (configuredKey !== null && configuredKey !== key) {
          issue('reload-required', 'Changing the preview data namespace requires a full preview reload.', true);
          return state;
        }
        if (configuredKey === null) {
          await options.configureDataPreview(selection);
          configuredKey = key;
        }
        if (expected !== generation) return state;
        suspended = false;
        publish({ phase: 'active', issue: null });
        invalidate();
        return state;
      } catch {
        // Never include native exception text, records, paths, or credentials in user-facing errors.
        issue('initialization-failed', 'Authoring initialization failed. Retry or reopen the preview from the builder.', true);
        return state;
      }
    });
    initializing = operation;
    void operation.finally(() => { if (initializing === operation) initializing = null; });
    return operation;
  }

  return {
    initialize,
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    focusScreen(screenId: string): ScreenLease | null {
      if (state.phase !== 'active') return null;
      const metadata = options.registry.screens.find((screen) => screen.screenId === screenId);
      const old = current;
      if (!metadata) {
        current = null;
        geometryEpoch++;
        if (old) void enqueue(async () => {
          if (current?.metadata.screenId === old.metadata.screenId) return;
          await bounded(Promise.resolve(native!.clearAuthoringContext!(old.metadata.screenId)), 5000);
        });
        issue('unknown-screen', 'This screen has no registered authoring metadata. General app editing is still available.');
        return null;
      }
      const lease = { id: ++nextId, screenId };
      current = { lease, metadata, laidOut: false, ready: false, dirty: false, targets: new Map() };
      if (old) void enqueue(async () => { await bounded(Promise.resolve(native!.clearAuthoringContext!(old.metadata.screenId)), 5000); });
      invalidate();
      return lease;
    },
    blurScreen(lease: ScreenLease | null) {
      if (!owns(lease)) return;
      const id = lease.screenId;
      current = null;
      geometryEpoch++;
      void enqueue(async () => {
        // A late cleanup for an old instance must not clear a newer same-ID screen.
        if (current?.metadata.screenId === id) return;
        const result = await bounded(Promise.resolve(native!.clearAuthoringContext!(id)), 5000);
        if (result?.available === false && !suspended) issue('cleanup-unavailable', 'Native screen cleanup is unavailable.');
      });
    },
    setScreenState(lease: ScreenLease | null, next: { ready: boolean; hasUnsavedChanges: boolean }) {
      if (!owns(lease) || !current) return;
      if (typeof next.ready !== 'boolean' || typeof next.hasUnsavedChanges !== 'boolean') {
        issue('invalid-screen-state', 'Screen readiness and dirty state must be explicit booleans.');
        return;
      }
      if (current.ready === next.ready && current.dirty === next.hasUnsavedChanges) return;
      current.ready = next.ready;
      current.dirty = next.hasUnsavedChanges;
      invalidate();
    },
    screenLayout(lease: ScreenLease | null, width: number, height: number) {
      if (!owns(lease) || !current) return;
      current.laidOut = !!bounds({ x: 0, y: 0, width, height });
      invalidate();
    },
    attachTarget(lease: ScreenLease | null, targetId: string, measure: () => Promise<Bounds | null>, recordRef?: RecordReference) {
      if (!owns(lease) || !current) return () => {};
      const screen = current;
      const metadata = screen.metadata.targets.find((target) => target.id === targetId);
      if (!metadata || screen.targets.has(targetId)) {
        issue('unknown-target', 'The target is unregistered or duplicated. Use explicit unique target metadata.');
        return () => {};
      }
      let safeReference: RecordReference | undefined;
      try { safeReference = reference(recordRef); }
      catch { issue('invalid-record-reference', 'Only a minimal concept/record reference may be captured.'); return () => {}; }
      const token = ++nextId;
      screen.targets.set(targetId, { token, metadata, measure, recordRef: safeReference });
      invalidate();
      return () => {
        if (current !== screen || screen.targets.get(targetId)?.token !== token) return;
        screen.targets.delete(targetId);
        invalidate();
      };
    },
    remeasure(lease?: ScreenLease | null) { if (lease === undefined || owns(lease)) invalidate(); },
    pause() { suspended = true; generation++; geometryEpoch++; },
    async resume() { if (initializing) await initializing; await initialize(); if (state.phase === 'active') invalidate(); },
    async retry() { if (initializing) await initializing; await initialize(); if (state.phase === 'active') invalidate(); },
    async settled() { await Promise.resolve(); await serial; },
  };
}

export type AuthoringRuntime = ReturnType<typeof createAuthoringRuntime>;
