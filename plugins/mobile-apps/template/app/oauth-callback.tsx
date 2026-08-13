import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useRouter } from 'expo-router';
import { completePowerAppsAuthSession } from '@microsoft/power-apps-native-host';

completePowerAppsAuthSession();

export default function OAuthCallbackScreen() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/(app)/home');
  }, [router]);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator />
    </View>
  );
}

