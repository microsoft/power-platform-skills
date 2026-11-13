# Set up Firebase for push notifications

Push notifications for a wrapped Power Apps mobile app are sent with Firebase Cloud Messaging (FCM). You need one Firebase project with an Android app and an iOS app, both registered with the **bundle ID you wrap the app with**, and, for iOS, an Apple Push Notification service (APNs) key.

## 1. Create the Firebase project

1. Open the [Firebase console](https://console.firebase.google.com/) and select **Create a project** (or **Add project**).
2. Enter a name and continue. Google Analytics is optional for push notifications.

## 2. Register the Android app

1. In the project overview, select **Add app** → **Android**.
2. Enter the wrap bundle ID (for example `com.contoso.fieldservice`) as the **Android package name**, then select **Register app**. Skip the SHA-1 field.
3. Download **google-services.json**. Skip the remaining SDK steps: the wrapped app already includes the Firebase SDK.

## 3. Register the iOS app

1. Select **Add app** → **Apple** (iOS).
2. Enter the same wrap bundle ID as the **Apple bundle ID**, then select **Register app**.
3. Download **GoogleService-Info.plist**. Skip the remaining SDK steps.

## 4. Connect Firebase to APNs (iOS)

1. In the [Apple Developer portal](https://developer.apple.com/account/resources/authkeys/list), go to **Certificates, Identifiers & Profiles** → **Keys**, and add a key with **Apple Push Notifications service (APNs)** enabled. Download the `.p8` file (it can be downloaded only once) and note its **Key ID** and your **Team ID**.
2. In the Firebase console, open **Project settings** → **Cloud Messaging** → **Apple app configuration**, select the iOS app, and upload the `.p8` file under **APNs Authentication Key** with the Key ID and Team ID.
3. In **Identifiers**, open the App ID for the wrap bundle ID and turn on the **Push Notifications** capability.
4. Regenerate the distribution provisioning profile for that App ID, so it carries the push entitlement, and use it to sign the wrap (update the profile in the app's Azure Key Vault). Wrapped apps are signed for production APNs.

## 5. Add the files to the app

Run `/add-native push-notifications` and give it the two downloaded files; it validates them against the wrap bundle ID and places them in `firebase/`. Then deploy the app with `/deploy`, and turn on push notifications for each platform when you wrap it. Alternatively, upload the files in the wrap wizard when you turn on push notifications.

## 6. Send a test notification

1. Install the wrapped app, sign in, and allow notifications when asked.
2. In the Firebase console, open **Messaging** and create a **Firebase Notification messages** campaign with a title and text.
3. Target the app (**User segment** → your Android or iOS app) or the topic **allUsers**, which every signed-in device subscribes to, then publish.

Notifications appear in the system tray while the app is in the background, and as an in-app alert while it is open. A topic receives its first messages a few minutes after its first device subscribes.
