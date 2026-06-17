import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { setAuthTokenGetter, setBaseUrl } from "@workspace/api-client-react";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { SettingsProvider } from "@/contexts/SettingsContext";
import { getCachedToken } from "@/lib/auth-storage";

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

// Wire the API client once, at module load, before any request fires.
// EXPO_PUBLIC_DOMAIN is the Replit dev domain (no protocol) in dev, and the
// deployment domain in production — both route through the shared proxy.
const apiDomain = process.env.EXPO_PUBLIC_DOMAIN;
if (apiDomain) {
  setBaseUrl(`https://${apiDomain}`);
}
setAuthTokenGetter(() => getCachedToken());

const queryClient = new QueryClient();

function RootLayoutNav() {
  const { isAuthenticated, isLoading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    const inAuthGroup = segments[0] === "login";
    if (!isAuthenticated && !inAuthGroup) {
      router.replace("/login");
    } else if (isAuthenticated && inAuthGroup) {
      router.replace("/");
    }
  }, [isAuthenticated, isLoading, segments, router]);

  return (
    <Stack screenOptions={{ headerBackTitle: "Back" }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen
        name="scan-review"
        options={{ presentation: "modal", title: "Review details" }}
      />
      <Stack.Screen
        name="capture-camera"
        options={{ headerShown: false, presentation: "fullScreenModal" }}
      />
      <Stack.Screen
        name="capture-qr"
        options={{ headerShown: false, presentation: "fullScreenModal" }}
      />
      <Stack.Screen name="capture-manual" options={{ title: "Manual entry" }} />
      <Stack.Screen name="leads" options={{ headerShown: false }} />
      <Stack.Screen name="events" options={{ headerShown: false }} />
      <Stack.Screen name="duplicates" options={{ headerShown: false }} />
      <Stack.Screen name="settings" options={{ headerShown: false }} />
      <Stack.Screen name="forgot-password" options={{ headerShown: false }} />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <SettingsProvider>
        <ErrorBoundary>
          <QueryClientProvider client={queryClient}>
            <AuthProvider>
              <GestureHandlerRootView>
                <KeyboardProvider>
                  <RootLayoutNav />
                </KeyboardProvider>
              </GestureHandlerRootView>
            </AuthProvider>
          </QueryClientProvider>
        </ErrorBoundary>
      </SettingsProvider>
    </SafeAreaProvider>
  );
}
