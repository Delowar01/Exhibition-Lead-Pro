module.exports = function (api) {
  api.cache(true);
  return {
    presets: [["babel-preset-expo", { unstable_transformImportMeta: true }]],
    plugins: [
      // Required for react-native-reanimated@4.x + react-native-worklets@0.5.x.
      // The worklets plugin must come BEFORE any reanimated transform so the
      // worklet function transform runs first. babel-preset-expo does NOT
      // auto-include this plugin.
      "react-native-worklets/plugin",
    ],
  };
};
