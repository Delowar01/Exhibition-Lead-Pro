import { defineConfig } from "vitest/config";

// Unit tests for pure, framework-free modules (e.g. lib/contact-parse.ts).
// These intentionally avoid React Native runtime imports so they run under a
// plain node environment without a native build.
export default defineConfig({
  test: {
    include: ["lib/**/*.test.ts"],
    environment: "node",
  },
});
