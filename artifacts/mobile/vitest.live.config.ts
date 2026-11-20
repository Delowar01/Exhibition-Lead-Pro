import { defineConfig } from "vitest/config";

// Phase 2 Batch 1 — opt-in compatibility run of the mobile sync / session code
// against a RUNNING LOCAL API (disposable database, stub AI provider, synthetic
// accounts). Never part of `pnpm test`; never pointed at a hosted environment.
//
//   MOBILE_API_COMPAT_URL=http://localhost:80 \
//   MOBILE_API_COMPAT_EMAIL_A=<tenant admin of the local seed> \
//   MOBILE_API_COMPAT_EMAIL_B=<admin of a second tenant> \
//   MOBILE_API_COMPAT_PASSWORD=<their local password> \
//     pnpm --filter @workspace/mobile run test:api-compat
export default defineConfig({
  test: {
    include: ["live/**/*.live.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
