import {
  Button,
  Spinner,
  Text,
  YStack,
} from 'tamagui';
import { Redirect } from 'expo-router';
import { useAuth } from '@microsoft/power-apps-native-host';

export default function LoginScreen() {
  const { isLoading, isAuthReady, isSignedIn, signIn, error } = useAuth();
  const busy = isLoading || !isAuthReady;

  if (isSignedIn) {
    return <Redirect href="/(app)/home" />;
  }

  return (
    <YStack
      flex={1}
      alignItems="center"
      justifyContent="center"
      paddingHorizontal="$6"
      backgroundColor="$background"
      gap="$4"
    >
      {/* Logo / icon */}
      <YStack
        width={80}
        height={80}
        borderRadius={20}
        backgroundColor="$blue10"
        alignItems="center"
        justifyContent="center"
        marginBottom="$2"
      >
        <Text fontSize={40}>⚡</Text>
      </YStack>

      <Text fontSize="$8" fontWeight="700" color="$color12" textAlign="center">
        Power Apps
      </Text>

      <Text fontSize="$4" color="$color10" textAlign="center" lineHeight="$5">
        Sign in with your Microsoft account to access Power Platform data
      </Text>


      {error ? (
        <Text color="$red10" fontSize="$3" textAlign="center">
          {error.message}
        </Text>
      ) : null}

      <Button
        size="$5"
        width="100%"
        backgroundColor="$blue10"
        color="white"
        fontWeight="600"
        onPress={signIn}
        disabled={busy}
        icon={busy ? <Spinner size="small" color="white" /> : undefined}
        pressStyle={{ opacity: 0.85 }}
      >
        {isLoading ? 'Signing in…' : !isAuthReady ? 'Loading…' : 'Sign in with Microsoft'}
      </Button>
    </YStack>
  );
}
