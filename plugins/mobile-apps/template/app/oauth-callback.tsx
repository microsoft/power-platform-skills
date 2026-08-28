import { useEffect, useRef } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { completePowerAppsAuthSession } from '@microsoft/power-apps-native-host';

completePowerAppsAuthSession();

export default function OAuthCallbackScreen() {
  const router = useRouter();
  const didNavigate = useRef(false);

  useEffect(() => {
    if (didNavigate.current) return;
    didNavigate.current = true;
    router.replace('/(app)/home');
  }, [router]);

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1 }}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    </SafeAreaView>
  );
}
