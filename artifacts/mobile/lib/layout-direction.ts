// Phase 2 Batch 1 — who mirrors the layout for Arabic.
//
// This app mirrors its own layout from the language chosen IN the app
// (hooks/useLocale.ts: rows are reversed, text is right-aligned, directional
// icons are swapped), so the language can be switched instantly, without a
// restart, and independently of the phone's system language.
//
// React Native can ALSO mirror every layout natively, and by default it does so
// whenever the phone's system language is right-to-left. With both active, an
// Arabic system language mirrored the app a second time: in Arabic the rows
// came out left-to-right again, and in English the whole interface came out
// mirrored.
//
// The app therefore switches the native mirroring off, in two places:
//   • at build time: plugins/withNativeLtr.js sets android:supportsRtl="false",
//     which holds from the very first launch;
//   • at run time: the call below stores the same choice in React Native's own
//     preferences (it takes effect at the next start), as a second line for
//     builds whose manifest was not produced by that plugin.
// Arabic text itself is unaffected: its letters are still shaped and ordered
// right-to-left by the platform's text engine.

export interface NativeDirectionManager {
  isRTL: boolean;
  allowRTL(allow: boolean): void;
  forceRTL(force: boolean): void;
}

export interface LayoutDirectionState {
  /**
   * True when native mirroring is active in THIS run despite the above (a
   * build without the manifest setting, on a right-to-left system language).
   * It ends with the next start of the app.
   */
  nativeMirroringActive: boolean;
}

/** Tell React Native that the app, not the system language, decides the layout direction. */
export function claimLayoutDirection(manager: NativeDirectionManager | null | undefined): LayoutDirectionState {
  if (!manager) return { nativeMirroringActive: false };
  try {
    manager.allowRTL(false);
    manager.forceRTL(false);
  } catch {
    // Not available on this platform (web): nothing mirrors natively there.
  }
  return { nativeMirroringActive: manager.isRTL === true };
}
