import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { useRouter } from 'expo-router';

WebBrowser.maybeCompleteAuthSession();

export default function OAuthCallbackScreen() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/(app)/home');
  }, []);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator />
    </View>
  );
}

