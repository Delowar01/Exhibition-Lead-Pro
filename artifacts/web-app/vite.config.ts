import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

// PORT and BASE_PATH are injected by the Replit workflow / deployment config.
// They stay mandatory for the dev server (each artifact must bind its assigned
// port and path prefix — a silent default would break the preview), but a
// production build needs neither: `vite build` is portable and defaults the
// base path to "/" when BASE_PATH is unset.
export default defineConfig(async ({ command }) => {
  const isServe = command === "serve";

  const rawPort = process.env.PORT;
  if (!rawPort && isServe) {
    throw new Error("PORT environment variable is required to run the dev server.");
  }
  const port = rawPort ? Number(rawPort) : undefined;
  if (rawPort && (Number.isNaN(port) || (port as number) <= 0)) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  const basePath = process.env.BASE_PATH;
  if (!basePath && isServe) {
    throw new Error("BASE_PATH environment variable is required to run the dev server.");
  }

  return {
    base: basePath ?? "/",
    plugins: [
      react(),
      tailwindcss(),
      runtimeErrorOverlay(),
      // Replit-only dev conveniences; skipped automatically outside Replit.
      ...(process.env.NODE_ENV !== "production" &&
      process.env.REPL_ID !== undefined
        ? [
            await import("@replit/vite-plugin-cartographer").then((m) =>
              m.cartographer({
                root: path.resolve(import.meta.dirname, ".."),
              }),
            ),
            await import("@replit/vite-plugin-dev-banner").then((m) =>
              m.devBanner(),
            ),
          ]
        : []),
    ],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "src"),
        "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
      },
      dedupe: ["react", "react-dom"],
    },
    root: path.resolve(import.meta.dirname),
    build: {
      outDir: path.resolve(import.meta.dirname, "dist/public"),
      emptyOutDir: true,
    },
    server: {
      port,
      strictPort: true,
      host: "0.0.0.0",
      allowedHosts: true,
      fs: {
        strict: true,
      },
    },
    preview: {
      port,
      host: "0.0.0.0",
      allowedHosts: true,
    },
  };
});
