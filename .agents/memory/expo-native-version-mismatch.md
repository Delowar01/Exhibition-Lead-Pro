---
name: Expo native module version mismatch (NoSuchMethodError)
description: How to diagnose/fix Android runtime crashes from skewed Expo SDK package versions in a pnpm monorepo.
---

# Expo native module ABI skew → Android runtime crash

**Symptom:** APK builds fine but crashes at startup on-device with a Java
`NoSuchMethodError` (e.g. `No static method getDirectConverter(...)` at
`expo.modules.filesystem.FileSystemModule.definition()`). This is NOT app logic —
it means an Expo module's native code was compiled against a different
`expo-modules-core` ABI than the one in the SDK.

**Root cause pattern:** a package.json pins an Expo package to a version from the
wrong SDK era (saw `expo-file-system: ^56.0.8` / `expo-sharing: ^56.0.18` against
SDK 54, whose correct versions are `~19.0.x` / `~14.0.x`). pnpm then keeps the
wrong direct copy AND the SDK's transitive correct copy side-by-side; the app
symlink resolves to the wrong one, which autolinks mismatched Java.

**Why versions look "weird":** modern Expo modules are SDK-aligned but each on its
own version line — `expo-file-system` is 19.x for SDK 54, `expo-sharing` is 14.x.
Do not assume a single shared version number across expo-* packages.

**How to fix:**
1. `npx expo install --check` (run inside the artifact dir) is the authoritative
   source of correct versions — trust it over guessing.
2. Edit package.json to the expected versions, then `pnpm install`, then
   `pnpm prune` to drop the orphaned wrong-version copies from `.pnpm`.
3. Verify ONE copy: `ls node_modules/.pnpm/<pkg>@*` and
   `pnpm --filter @workspace/<app> why <pkg>`.

**pnpm-monorepo caveats vs the usual npm advice:** there is no
`package-lock.json` and `npm ls` is misleading — use `pnpm why` / `pnpm list`.
Do NOT delete the whole workspace `node_modules`; `pnpm install` + `pnpm prune`
reconciles correctly.

**API-break side effect:** bumping `expo-file-system` to 19.x (SDK 54) makes the
class-based API the default export; legacy functional helpers (`deleteAsync`,
`documentDirectory`, `readAsStringAsync`, …) moved to `expo-file-system/legacy`.
Update imports or they're `undefined` at runtime.

**expo-doctor / `expo config` gotcha:** a package listed in app.json `plugins`
that ships NO config plugin (`app.plugin.js`) makes `expo config` (and therefore
`expo-doctor`) throw `PluginError: Unable to resolve a valid config plugin`.
`expo-sharing` has no config plugin — it must not be in the `plugins` array.
Check with: `test -f $(readlink -f node_modules/<pkg>)/app.plugin.js`.

**EAS build "Install dependencies" failure in pnpm monorepo:**
When `eas.json` lives in a subdirectory (e.g. `artifacts/mobile/`) and
`pnpm-lock.yaml` is at the workspace root, EAS can't detect pnpm and falls back
to npm → instant failure (no `package-lock.json`). Fix: add
`"packageManager": "pnpm@X.Y.Z"` to the **workspace root** `package.json`.
EAS then walks up the directory tree from `eas.json`, finds `pnpm-lock.yaml` and
`pnpm-workspace.yaml` at the workspace root, and uses pnpm automatically.
NOTE: `buildRootDir` is NOT a valid eas.json field — using it causes immediate
schema validation failure before any build step runs.

**Verification without an Android device (Replit has no Android SDK/emulator/adb):**
strongest offline proof is `npx expo export --platform android` (full Metro +
Hermes compile of the shipped bundle) + `expo install --check` clean +
single-copy check. `expo-doctor` itself is network-blocked in the container and
times out with no output — don't rely on it here.
