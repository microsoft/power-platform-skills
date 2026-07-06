import { Redirect, Stack } from 'expo-router';
import { useAuth } from '@microsoft/power-apps-native-host';

/**
 * Protected layout — any screen inside (app)/ is only reachable when signed in.
 * Unauthenticated users are redirected to /login automatically.
 */
export default function AppLayout() {
  const { isSignedIn, isLoading } = useAuth();

  if (!isLoading && !isSignedIn) {
    return <Redirect href="/login" />;
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
      }}
    />
  );
}
