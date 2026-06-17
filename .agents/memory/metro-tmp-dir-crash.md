---
name: Metro tmp-dir watch crash
description: Expo/Metro workflow crash-loop after installing an expo package, caused by a stale temp-dir reference in Metro's file-map cache.
---

# Metro tmp-dir watch crash

After `expo install <pkg>` (e.g. expo-notifications), the Expo workflow can crash on startup with:
`Error: ENOENT: no such file or directory, watch '.../node_modules/.pnpm/<pkg>_tmp_NNNNN/android'` (syscall `watch`, errno -2).

The package itself is intact — pnpm/expo left a `<pkg>_tmp_NNNNN` temp dir during install that was then removed, but Metro's persisted file-map cache still references it and tries to watch it on boot, crashing the bundler (exit 7). A plain workflow restart does NOT fix it because the stale cache survives.

**Fix:** delete Metro caches and restart the workflow:
`rm -rf /tmp/metro-cache /tmp/metro-file-map-* /tmp/haste-map-* node_modules/.cache`
then `restart_workflow` the expo artifact. It bundles cleanly afterward.
