import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { Feather } from "@expo/vector-icons";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { setAuthTokenGetter, setBaseUrl } from "@workspace/api-client-react";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { NotificationsManager } from "@/components/NotificationsManager";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { OfflineProvider } from "@/contexts/OfflineContext";
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
    const PUBLIC_ROUTES = ["login", "forgot-password"];
    const onPublicRoute = PUBLIC_ROUTES.includes(segments[0] ?? "");
    if (!isAuthenticated && !onPublicRoute) {
      router.replace("/login");
    } else if (isAuthenticated && segments[0] === "login") {
      router.replace("/");
    }
  }, [isAuthenticated, isLoading, segments, router]);

  return (
    <>
      <NotificationsManager />
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
      <Stack.Screen name="sync" options={{ headerShown: false }} />
      <Stack.Screen name="forgot-password" options={{ headerShown: false }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    ...Feather.font,
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
              <OfflineProvider>
                <GestureHandlerRootView>
                  <KeyboardProvider>
                    <RootLayoutNav />
                  </KeyboardProvider>
                </GestureHandlerRootView>
              </OfflineProvider>
            </AuthProvider>
          </QueryClientProvider>
        </ErrorBoundary>
      </SettingsProvider>
    </SafeAreaProvider>
  );
}
