'use strict';

const { Platform } = require('react-native');

if (Platform.OS !== 'web') {
  const messaging = require('@react-native-firebase/messaging').default;

  // This template no-op keeps the fresh snapshot runnable before push integration.
  // `/add-push-notifications` replaces it with a require of the generated wrapper's
  // `handleBackgroundNotification`; strict final/build validation rejects this stub.
  async function unconfiguredBackgroundHandler() {}
  messaging().setBackgroundMessageHandler(unconfiguredBackgroundHandler);
}

require('expo-router/entry');
