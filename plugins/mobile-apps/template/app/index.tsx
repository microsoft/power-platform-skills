import { ActivityIndicator } from 'react-native';
import { Redirect } from 'expo-router';
import { View } from 'tamagui';
import { useAuth } from '@microsoft/power-apps-native-host';

/**
 * Root index — redirects to the appropriate screen based on auth state.
 * Expo Router renders this as the entry point for the app.
 */
export default function Index() {
  const { isLoading, isSignedIn } = useAuth();

  if (isLoading) {
    return (
      <View flex={1} alignItems="center" justifyContent="center">
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return isSignedIn ? <Redirect href="/(app)/home" /> : <Redirect href="/login" />;
}
