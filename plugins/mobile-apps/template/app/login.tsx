import {
  Button,
  Spinner,
  Text,
  YStack,
} from 'tamagui';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Redirect } from 'expo-router';
import { useAuth } from '@microsoft/power-apps-native-host';
// @ts-ignore - power.config.json is auto-generated at build time
import powerConfig from '../power.config.json';

export default function LoginScreen() {
  const { isLoading, isAuthReady, isSignedIn, signIn, error } = useAuth();
  const busy = isLoading || !isAuthReady;
  const appName = powerConfig.appDisplayName || 'Power Apps Standalone';

  if (isSignedIn) {
    return <Redirect href="/(app)/home" />;
  }

  return (
    <YStack
      flex={1}
      items="center"
      justify="center"
      px="$6"
      bg="$background"
      gap="$4"
    >
      <YStack
        style={{ width: 72, height: 72, borderRadius: 18 }}
        bg="$blue10"
        items="center"
        justify="center"
        mb="$2"
      >
        <MaterialCommunityIcons name="microsoft-powerpoint" size={34} color="white" />
      </YStack>

      <Text fontSize="$8" fontWeight="700" color="$color12" text="center">
        {appName}
      </Text>

      <Text fontSize="$4" color="$color10" style={{ textAlign: 'center', lineHeight: 22 }}>
        Sign in with your work or school email account
      </Text>


      {error ? (
        <Text color="$red10" fontSize="$3" text="center">
          {error.message}
        </Text>
      ) : null}

      <Button
        size="$5"
        style={{ width: '100%' }}
        bg="$blue10"
        color="white"
        fontWeight="600"
        onPress={signIn}
        disabled={busy}
        icon={busy ? <Spinner size="small" color="white" /> : undefined}
        pressStyle={{ opacity: 0.85 }}
      >
        {isLoading ? 'Signing in...' : !isAuthReady ? 'Loading...' : 'Sign in with Microsoft'}
      </Button>
    </YStack>
  );
}
