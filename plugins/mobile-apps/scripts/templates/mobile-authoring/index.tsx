import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { AppState, Dimensions, Pressable, Text, View, type LayoutChangeEvent, type ViewProps } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { requireOptionalNativeModule } from 'expo';
import runtimeStamp from '../../.devplayer-builder/runtime.json';
import { registry } from './registry';
import {
  createAuthoringRuntime, type AuthoringRuntime, type AuthoringState, type Bounds, type DataPreview,
  type NativeAuthoringModule, type RecordReference, type ScreenLease,
} from './controller';

export type { AuthoringState, DataPreview, RecordReference } from './controller';
export { registry as authoringRegistry } from './registry';

type Configuration = (selection: DataPreview) => void | Promise<void>;
let shared: { runtime: AuthoringRuntime; configure: Configuration } | null = null;
function runtimeFor(configure: Configuration): AuthoringRuntime {
  if (!shared) {
    shared = {
      configure,
      runtime: createAuthoringRuntime({
        registry, stamp: runtimeStamp,
        getNativeModule: () => requireOptionalNativeModule<NativeAuthoringModule>('PowerAppsDevLauncher'),
        configureDataPreview: (selection) => shared!.configure(selection),
        schedule: (work) => { requestAnimationFrame(work); },
      }),
    };
  }
  shared.configure = configure;
  return shared.runtime;
}

const Context = createContext<{ runtime: AuthoringRuntime; state: AuthoringState } | null>(null);
const ScreenContext = createContext<AuthoringScreenHandle | null>(null);

/** Wrap OUTSIDE data providers. Children cannot run repository hooks before initialization finishes. */
export function AuthoringProvider({
  configureDataPreview, children, fallback,
}: PropsWithChildren<{ configureDataPreview: Configuration; fallback?: React.ReactNode }>) {
  const runtime = runtimeFor(configureDataPreview);
  const [state, setState] = useState(runtime.getSnapshot);
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    let mounted = true;
    const unsubscribe = runtime.subscribe(() => setState(runtime.getSnapshot()));
    void runtime.resume().then(() => { if (mounted) setInitialized(true); });
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') void runtime.resume();
      else runtime.pause();
    });
    const dimensions = Dimensions.addEventListener('change', () => runtime.remeasure());
    return () => {
      mounted = false;
      unsubscribe();
      appState.remove();
      dimensions.remove();
      runtime.pause();
    };
  }, [runtime]);
  const context = useMemo(() => ({ runtime, state }), [runtime, state]);
  const checking = !initialized || state.phase === 'checking';
  if (checking || state.phase === 'blocked') {
    return (
      <View style={{ flex: 1, padding: 24, justifyContent: 'center' }}>
        {checking && fallback ? fallback : (
          <>
            <Text accessibilityRole="header">
              {checking ? 'Preparing preview' : 'Preview cannot start safely'}
            </Text>
            <Text accessibilityLiveRegion="polite">
              {state.issue?.message ?? 'Checking the publisher source and native session before opening app data.'}
            </Text>
            {!checking && state.phase === 'blocked' && (
              <Pressable accessibilityRole="button" accessibilityLabel="Retry preview initialization"
                onPress={() => { void runtime.retry(); }} style={{ minHeight: 48, justifyContent: 'center' }}>
                <Text>Retry preview initialization</Text>
              </Pressable>
            )}
          </>
        )}
      </View>
    );
  }
  return (
    <Context.Provider value={context}>
      {state.phase === 'active' && state.issue && (
        <View accessibilityLiveRegion="polite" style={{ padding: 12 }}>
          <Text>{state.issue.message}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Retry screen authoring"
            onPress={() => { void runtime.retry(); }} style={{ minHeight: 44, justifyContent: 'center' }}>
            <Text>Retry screen authoring</Text>
          </Pressable>
        </View>
      )}
      {children}
    </Context.Provider>
  );
}

export function useAuthoringStatus() {
  const context = useContext(Context);
  return context?.state ?? { phase: 'standalone' as const, issue: null, acknowledgedScreenId: null };
}

export type AuthoringScreenOptions = { ready: boolean; hasUnsavedChanges?: boolean };
export type AuthoringScreenHandle = {
  readonly runtime: AuthoringRuntime | null;
  readonly lease: ScreenLease | null;
  onLayout: (event: LayoutChangeEvent) => void;
  /** Attach to onScroll/onScrollBeginDrag/onScrollEndDrag/onMomentumScrollEnd; use scrollEventThrottle=16. */
  onScroll: () => void;
  remeasure: () => void;
};

/** ready must describe the usable screen, not just a loading/root component. Attach the returned onLayout. */
export function useAuthoringScreen(screenId: string, { ready, hasUnsavedChanges = false }: AuthoringScreenOptions): AuthoringScreenHandle {
  const context = useContext(Context);
  const runtime = context?.runtime ?? null;
  const phase = context?.state.phase;
  const live = useRef({ ready, hasUnsavedChanges });
  live.current = { ready, hasUnsavedChanges };
  const leaseRef = useRef<ScreenLease | null>(null);
  const [lease, setLease] = useState<ScreenLease | null>(null);
  const layout = useRef<{ width: number; height: number } | null>(null);
  useFocusEffect(useCallback(() => {
    if (!runtime || phase !== 'active') return;
    const next = runtime.focusScreen(screenId);
    leaseRef.current = next;
    setLease(next);
    runtime.setScreenState(next, live.current);
    if (layout.current) runtime.screenLayout(next, layout.current.width, layout.current.height);
    return () => {
      runtime.blurScreen(next);
      if (leaseRef.current?.id === next?.id) leaseRef.current = null;
    };
  }, [runtime, phase, screenId]));
  useEffect(() => {
    runtime?.setScreenState(leaseRef.current, { ready, hasUnsavedChanges });
  }, [runtime, ready, hasUnsavedChanges]);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    layout.current = { width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height };
    runtime?.screenLayout(leaseRef.current, layout.current.width, layout.current.height);
  }, [runtime]);
  const remeasure = useCallback(() => { runtime?.remeasure(leaseRef.current); }, [runtime]);
  return useMemo(() => ({ runtime, lease, onLayout, onScroll: remeasure, remeasure }), [runtime, lease, onLayout, remeasure]);
}

export type AuthoringScreenProps = Omit<ViewProps, 'children'> & PropsWithChildren<AuthoringScreenOptions & { screenId: string }>;
export function AuthoringScreen({ screenId, ready, hasUnsavedChanges, children, onLayout, ...viewProps }: AuthoringScreenProps) {
  const screen = useAuthoringScreen(screenId, { ready, hasUnsavedChanges });
  return (
    <ScreenContext.Provider value={screen}>
      <View {...viewProps} collapsable={false} onLayout={(event) => { screen.onLayout(event); onLayout?.(event); }}>
        {children}
      </View>
    </ScreenContext.Provider>
  );
}

/** Re-measures the nearest AuthoringScreen; attach to scroll callbacks, never infer React descendants. */
export function useAuthoringRemeasure(): () => void {
  const screen = useContext(ScreenContext);
  return screen?.remeasure ?? (() => {});
}

export function useAuthoringTarget(
  targetId: string,
  options: { screen?: AuthoringScreenHandle; recordRef?: RecordReference } = {},
) {
  const inherited = useContext(ScreenContext);
  const screen = options.screen ?? inherited;
  const ref = useRef<View | null>(null);
  const recordRef = options.recordRef;
  useEffect(() => {
    if (!screen?.runtime || !screen.lease) return;
    return screen.runtime.attachTarget(screen.lease, targetId, () => new Promise<Bounds | null>((resolve) => {
      const view = ref.current;
      if (!view) { resolve(null); return; }
      view.measureInWindow((x, y, width, height) => {
        resolve(ref.current === view ? { x, y, width, height } : null);
      });
    }), recordRef);
  }, [screen?.runtime, screen?.lease, targetId, recordRef?.conceptId, recordRef?.recordId, recordRef?.label]);
  const onLayout = useCallback(() => { screen?.remeasure(); }, [screen]);
  return { ref, onLayout };
}

export type AuthoringTargetProps = Omit<ViewProps, 'children'> & PropsWithChildren<{
  targetId: string; recordRef?: RecordReference; screen?: AuthoringScreenHandle;
}>;
export function AuthoringTarget({ targetId, recordRef, screen, children, onLayout, ...viewProps }: AuthoringTargetProps) {
  const target = useAuthoringTarget(targetId, { recordRef, screen });
  return (
    <View {...viewProps} ref={target.ref} collapsable={false}
      onLayout={(event) => { target.onLayout(); onLayout?.(event); }}>
      {children}
    </View>
  );
}
