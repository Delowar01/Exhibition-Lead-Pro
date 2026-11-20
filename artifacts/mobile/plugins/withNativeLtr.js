// Expo config plugin (Phase 2 Batch 1): the app mirrors its own layout for
// Arabic from the language chosen in the app (hooks/useLocale.ts). Android's
// native right-to-left mirroring must therefore stay off, or an Arabic SYSTEM
// language mirrors everything a second time. See lib/layout-direction.ts.
//
// It takes effect in the next native build (no build is triggered by adding it).
const { AndroidConfig, withAndroidManifest } = require("expo/config-plugins");

/** Pure: set android:supportsRtl="false" on the <application> of a parsed manifest. */
function setNativeLtr(manifest) {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  application.$["android:supportsRtl"] = "false";
  return manifest;
}

const withNativeLtr = (config) =>
  withAndroidManifest(config, (cfg) => {
    cfg.modResults = setNativeLtr(cfg.modResults);
    return cfg;
  });

module.exports = withNativeLtr;
module.exports.setNativeLtr = setNativeLtr;
