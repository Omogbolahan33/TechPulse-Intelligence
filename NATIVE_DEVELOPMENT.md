# Native Development Guide

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Initial Setup](#initial-setup)
3. [Capacitor Workflow](#capacitor-workflow)
4. [Building for Android](#building-for-android)
5. [Building for iOS](#building-for-ios)
6. [Adding New Plugins](#adding-new-plugins)
7. [Firebase App Distribution](#firebase-app-distribution)
8. [CI/CD Pipeline](#cicd-pipeline)
9. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### All Platforms

- Node.js 20+
- npm 10+
- Git

### Android

- Android Studio (latest stable)
- JDK 17
- Android SDK (API 24+)
- Android Build Tools

### iOS (macOS only)

- macOS 13+
- Xcode 15+
- CocoaPods (`sudo gem install cocoapods`)
- Apple Developer Account (for distribution)

---

## Initial Setup

```bash
# Clone the repository
git clone https://github.com/Omogbolahan33/TechPulse-Intelligence.git
cd TechPulse-Intelligence

# Install dependencies
npm install

# Build the web application
npm run build

# Sync Capacitor (generates native projects if needed)
npx cap sync
```

---

## Capacitor Workflow

The standard development workflow follows this order:

```
Install dependencies → Build web app → Capacitor sync → Native build
```

### Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Build the React/Vite web application |
| `npx cap sync` | Sync web assets and plugins to native projects |
| `npx cap copy` | Copy web assets only (no plugin update) |
| `npx cap open android` | Open Android project in Android Studio |
| `npx cap open ios` | Open iOS project in Xcode |

---

## Building for Android

### Debug Build

```bash
# Build debug APK
npm run android:build

# Output: android/app/build/outputs/apk/debug/app-debug.apk
```

### Release Build

```bash
# Build release AAB (for Play Store)
npm run android:build:release

# Output: android/app/build/outputs/bundle/release/app-release.aab
```

### Using Android Studio

```bash
# Open project in Android Studio
npm run android

# Then in Android Studio:
# 1. Build → Build Bundle(s) / APK(s) → Build APK(s) for debug
# 2. Build → Generate Signed Bundle / APK for release
```

### Signing Configuration

For release builds, create `android/app/release-signing.properties`:

```properties
storeFile=/path/to/keystore.jks
storePassword=your-store-password
keyAlias=your-key-alias
keyPassword=your-key-password
```

---

## Building for iOS

### Requirements

- macOS with Xcode 15+
- Apple Developer account for device testing
- Proper provisioning profiles for distribution

### Debug Build

```bash
# Build for iOS Simulator
npm run ios:build
```

### Using Xcode

```bash
# Open project in Xcode
npm run ios

# Then in Xcode:
# 1. Select target device (simulator or physical device)
# 2. Product → Build (⌘B)
# 3. Product → Run (⌘R) to install on device
```

### Signing & Provisioning

1. Open Xcode → Project → Signing & Capabilities
2. Select your Team
3. Xcode will automatically manage provisioning profiles

---

## Adding New Plugins

### Step 1: Install the Plugin

```bash
npm install @capacitor/plugin-name
```

### Step 2: Sync to Native Projects

```bash
npx cap sync
```

### Step 3: Use in Code

```typescript
import { PluginName } from '@capacitor/plugin-name';

// Use the plugin
await PluginName.someMethod();
```

### Step 4: Verify Installation

```bash
# Check Android registration
grep -r "PluginName" android/app/src/main/java/

# Check iOS registration (Package.swift should include it)
cat ios/App/Package.swift
```

---

## Firebase App Distribution

### Setup

1. Create a Firebase project at https://console.firebase.google.com
2. Add Android and iOS apps to the project
3. Download config files:
   - Android: `google-services.json`
   - iOS: `GoogleService-Info.plist`

### CI/CD Secrets

Set these secrets in GitHub → Settings → Secrets → Actions:

| Secret | Description |
|--------|-------------|
| `FIREBASE_TOKEN` | Firebase CI token (`firebase login:ci`) |
| `TECHPULSE_FIREBASE_APP_ID_ANDROID` | Android app ID from Firebase |
| `TECHPULSE_FIREBASE_APP_ID_IOS` | iOS app ID from Firebase |
| `TECHPULSE_GOOGLE_SERVICES_JSON` | Base64-encoded `google-services.json` |
| `TECHPULSE_GOOGLE_SERVICE_INFO_PLIST` | Base64-encoded `GoogleService-Info.plist` |

### Encoding Config Files

```bash
# Android
base64 -i google-services.json | pbcopy

# macOS
base64 -i GoogleService-Info.plist | pbcopy
```

### Manual Distribution

```bash
# Install Firebase CLI
npm install -g firebase-tools

# Login
firebase login:ci

# Get token and set as FIREBASE_TOKEN secret
```

### Tester Groups

Configure groups in Firebase Console → App Distribution:

- `internal-qa` - Internal QA team
- `beta-testers` - External beta testers
- `stakeholders` - Product stakeholders

---

## CI/CD Pipeline

### Pull Requests

Triggered on PRs to `main` or `develop`:

1. Install dependencies
2. Run linter
3. Build web application
4. Verify Capacitor sync

### Develop Branch

Triggered on push to `develop`:

1. Build Android debug APK
2. Upload to Firebase App Distribution (internal-qa, beta-testers)

### Main Branch / Release Tags

Triggered on push to `main` or tags `v*`:

1. Build Android release AAB
2. Build iOS release (on macOS runner)
3. Upload both to Firebase App Distribution (all groups)
4. Archive build artifacts

### Manual Deployment

Go to GitHub → Actions → Firebase App Distribution → Run workflow:

- Select platform (android/ios/both)
- Select release type (debug/release)
- Enter tester groups (comma-separated)

---

## Troubleshooting

### Common Issues

#### Capacitor Sync Fails

```bash
# Clean and rebuild
npm run clean
npm run build
npx cap sync
```

#### Android Build Fails

```bash
# Clean Gradle
cd android
./gradlew clean
cd ..
npm run android:build
```

#### iOS Build Fails

```bash
# Clean and reinstall pods
cd ios/App
pod deintegrate
pod install
cd ../..
npm run ios:build
```

#### Plugin Not Found

```bash
# Reinstall plugin
npm install @capacitor/plugin-name
npx cap sync
```

#### Firebase Upload Fails

- Verify `FIREBASE_TOKEN` is valid
- Check `FIREBASE_APP_ID_*` matches Firebase console
- Ensure config files are properly base64-encoded

### Version Management

Version is automatically set from Git tags:

- Tag format: `v1.2.3`
- Android: `versionCode = MAJOR*10000 + MINOR*100 + PATCH`
- iOS: `CFBundleShortVersionString = "1.2.3"`

### Getting Help

- Capacitor Docs: https://capacitorjs.com/docs
- Firebase App Distribution: https://firebase.google.com/docs/app-distribution
- GitHub Issues: https://github.com/Omogbolahan33/TechPulse-Intelligence/issues
