import { AppState, type AppStateStatus, Platform } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { QueryClient, focusManager, onlineManager } from '@tanstack/react-query';

// Wire react-query's onlineManager to NetInfo so refetchOnReconnect actually
// fires when the device regains connectivity (the default true is a no-op on
// React Native otherwise). NetInfo.addEventListener returns an unsubscribe
// function that onlineManager will call when the manager is replaced.
onlineManager.setEventListener((setOnline) => {
  const unsubscribe = NetInfo.addEventListener((state) => setOnline(!!state.isConnected));
  return unsubscribe;
});

// Wire focusManager to AppState so queries refetch when the app returns to
// the foreground. Without this, refetchOnWindowFocus has no effect on iOS/Android.
focusManager.setEventListener((handleFocus) => {
  const sub = AppState.addEventListener('change', (status: AppStateStatus) => {
    if (Platform.OS !== 'web') handleFocus(status === 'active');
  });
  return () => sub.remove();
});

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: 2,
    },
    mutations: {
      retry: 0,
    },
  },
});
