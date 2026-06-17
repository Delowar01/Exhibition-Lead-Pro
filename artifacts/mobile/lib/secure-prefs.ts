import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

// Small key/value wrapper that uses the hardware-backed secure store on native
// devices and falls back to AsyncStorage on web (where SecureStore is not
// available). All values are plain strings — callers JSON-encode as needed.

const isWeb = Platform.OS === "web";

export async function getSecureItem(key: string): Promise<string | null> {
  if (isWeb) return AsyncStorage.getItem(key);
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

export async function setSecureItem(key: string, value: string): Promise<void> {
  if (isWeb) {
    await AsyncStorage.setItem(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

export async function deleteSecureItem(key: string): Promise<void> {
  if (isWeb) {
    await AsyncStorage.removeItem(key);
    return;
  }
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    // ignore
  }
}
