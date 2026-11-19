import path from "node:path";
import { defineConfig } from "vitest/config";

// Unit tests for the web app: framework-free helpers, and design-system components rendered
// to static markup with react-dom/server. They run in a plain node environment — no browser
// and no DOM library. Everything interactive is covered by the Playwright suite in e2e/.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  esbuild: { jsx: "automatic" },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
