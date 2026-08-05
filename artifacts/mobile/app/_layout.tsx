import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { Feather } from "@/components/icons";
import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { Platform, Pressable } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { setAuthTokenGetter, setBaseUrl } from "@workspace/api-client-react";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { NotificationsManager } from "@/components/NotificationsManager";
import { AppLockOverlay } from "@/components/AppLockOverlay";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { AppLockProvider, useAppLock } from "@/contexts/AppLockContext";
import { useLocale } from "@/hooks/useLocale";
import { CardProvider } from "@/contexts/CardContext";
import { OfflineProvider } from "@/contexts/OfflineContext";
import { SettingsProvider } from "@/contexts/SettingsContext";
import { getCachedToken } from "@/lib/auth-storage";

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

// Wire the API client once, at module load, before any request fires.
// Resolution order:
//   1. EXPO_PUBLIC_API_URL — explicit production URL baked in at EAS build time
//      (e.g. "https://my-app.replit.app"). Set this in eas.json env or as a
//      Replit Secret named EXPO_PUBLIC_API_URL before running eas build.
//   2. EXPO_PUBLIC_DOMAIN  — Replit dev domain injected by the local workflow
//      (no protocol; https:// is prepended automatically).
// If neither resolves, the base URL stays null. The app still boots to the
// login screen and shows auth/network errors rather than crashing — which
// surfaces the config problem without a hard stop.
const apiUrl =
  process.env.EXPO_PUBLIC_API_URL ??
  (process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
    : null);
if (apiUrl) {
  setBaseUrl(apiUrl);
} else {
  console.warn(
    "[CSP] No API URL configured. Set EXPO_PUBLIC_API_URL in your EAS build " +
      "environment (eas.json env section) before running eas build.",
  );
}
setAuthTokenGetter(() => getCachedToken());

// Centralized cache freshness: after ANY successful mutation, mark all queries
// stale. Active (mounted) queries refetch immediately; inactive ones refetch on
// next mount. This guarantees the dashboard, lists, counters, and detail screens
// stay in sync across the app without per-call-site invalidation or app restart.
// Mirrors the offline-sync invalidation so online and offline behave identically.
const queryClient: QueryClient = new QueryClient({
  // Snappy navigation: serve cached data instantly when revisiting a screen
  // within staleTime instead of showing a spinner + refetch on every mount.
  // The blanket invalidation below still forces a refresh after any mutation,
  // so data never goes stale where it matters.
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
  mutationCache: new MutationCache({
    onSuccess: () => {
      void queryClient.invalidateQueries();
    },
    onError: (error, _vars, _ctx, mutation) => {
      if (__DEV__) {
        const key = mutation.options.mutationKey?.join("/") ?? "mutation";
        console.warn(`[CSP/cache] ${key} error`, error);
      }
    },
  }),
});

// On web there is no hardware/native back gesture, so provide an explicit
// header back affordance. On native, leaving headerLeft unset preserves the
// platform's native back button + swipe gesture.
function WebHeaderBack({ canGoBack }: { canGoBack?: boolean }) {
  const router = useRouter();
  if (!canGoBack) return null;
  return (
    <Pressable
      onPress={() => router.back()}
      hitSlop={12}
      style={{ paddingHorizontal: 4, paddingVertical: 4 }}
    >
      <Feather name="arrow-left" size={22} />
    </Pressable>
  );
}

function RootLayoutNav() {
  const { isAuthenticated, isLoading } = useAuth();
  const { isLocked } = useAppLock();
  const segments = useSegments();
  const router = useRouter();
  const { t } = useLocale();

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
      <AppLockOverlay />
      <Stack
        screenOptions={{
          headerBackTitle: t("common.back"),
          // Disable all swipe-back / swipe-down gestures while the app is
          // locked so the overlay cannot be bypassed by navigation gestures.
          gestureEnabled: !isLocked,
          ...(Platform.OS === "web"
            ? { headerLeft: (props) => <WebHeaderBack canGoBack={props.canGoBack} /> }
            : {}),
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen
        name="scan-review"
        options={{ presentation: "modal", title: t("screens.reviewDetails") }}
      />
      <Stack.Screen
        name="capture-camera"
        options={{ headerShown: false, presentation: "fullScreenModal" }}
      />
      <Stack.Screen
        name="batch-review"
        options={{ headerShown: false, presentation: "fullScreenModal" }}
      />
      <Stack.Screen
        name="event-picker"
        options={{ headerShown: false, presentation: "modal" }}
      />
      <Stack.Screen
        name="capture-qr"
        options={{ headerShown: false, presentation: "fullScreenModal" }}
      />
      <Stack.Screen
        name="capture-nfc"
        options={{ headerShown: false, presentation: "fullScreenModal" }}
      />
      <Stack.Screen name="capture-manual" options={{ title: t("screens.manualEntry") }} />
      <Stack.Screen name="card" options={{ headerShown: false }} />
      <Stack.Screen name="events" options={{ headerShown: false }} />
      <Stack.Screen name="meetings" options={{ headerShown: false }} />
      <Stack.Screen name="tasks" options={{ headerShown: false }} />
      <Stack.Screen name="duplicates" options={{ headerShown: false }} />
      <Stack.Screen name="my-numbers" options={{ headerShown: false }} />
      <Stack.Screen name="settings" options={{ headerShown: false }} />
      <Stack.Screen name="notifications" options={{ headerShown: false }} />
      <Stack.Screen name="sync" options={{ headerShown: false }} />
      <Stack.Screen name="forgot-password" options={{ headerShown: false }} />
      <Stack.Screen name="dev-perf" options={{ headerShown: false }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  // Load only the Inter text fonts. Icons are NOT a font anymore — they render
  // as SVG (see `components/icons.tsx`), which has no font family and no load
  // step, so there is nothing icon-related to gate on here. This is what fixes
  // the Android/Expo Go "tofu" (empty box) icons that the old icon font caused.
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

  // `fontError` still lets the app through (degraded icons) rather than hanging
  // on the splash screen if a font asset ever fails to load.
  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <SettingsProvider>
        <ErrorBoundary>
          <QueryClientProvider client={queryClient}>
            <AuthProvider>
              <AppLockProvider>
                <OfflineProvider>
                  <CardProvider>
                    <GestureHandlerRootView>
                      <KeyboardProvider>
                        <RootLayoutNav />
                      </KeyboardProvider>
                    </GestureHandlerRootView>
                  </CardProvider>
                </OfflineProvider>
              </AppLockProvider>
            </AuthProvider>
          </QueryClientProvider>
        </ErrorBoundary>
      </SettingsProvider>
    </SafeAreaProvider>
  );
}
