import { useEffect, useRef } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { completePowerAppsAuthSession } from '@microsoft/power-apps-native-host';
import { useTheme } from 'tamagui';

completePowerAppsAuthSession();

export default function OAuthCallbackScreen() {
  const router = useRouter();
  const theme = useTheme();
  const didNavigate = useRef(false);

  useEffect(() => {
    if (didNavigate.current) return;
    didNavigate.current = true;
    router.replace('/(app)/home');
  }, [router]);

  return (
    <SafeAreaView
      edges={['top', 'bottom']}
      style={{ flex: 1, backgroundColor: theme.surface0.val }}
    >
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    </SafeAreaView>
  );
}
