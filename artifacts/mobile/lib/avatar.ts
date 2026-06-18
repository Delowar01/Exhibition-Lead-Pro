import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";

export type AvatarSource = "camera" | "library";

// Picks an image (with square crop), downsizes to 256px and compresses to JPEG,
// returning a base64 data URL ready to store on the user record. Returns null if
// the user cancels. Throws with a user-facing message when a permission is denied.
export async function pickAvatar(source: AvatarSource): Promise<string | null> {
  if (source === "camera") {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) throw new Error("Camera access is needed to take a photo.");
  } else {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted)
      throw new Error("Photo library access is needed to choose a photo.");
  }

  const opts: ImagePicker.ImagePickerOptions = {
    mediaTypes: ["images"],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 1,
  };

  const result =
    source === "camera"
      ? await ImagePicker.launchCameraAsync(opts)
      : await ImagePicker.launchImageLibraryAsync(opts);

  if (result.canceled || !result.assets?.[0]) return null;

  const manipulated = await ImageManipulator.manipulateAsync(
    result.assets[0].uri,
    [{ resize: { width: 256, height: 256 } }],
    { compress: 0.6, format: ImageManipulator.SaveFormat.JPEG, base64: true },
  );

  if (!manipulated.base64) return null;
  return `data:image/jpeg;base64,${manipulated.base64}`;
}
