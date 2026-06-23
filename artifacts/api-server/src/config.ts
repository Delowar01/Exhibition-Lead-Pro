const nodeEnv = process.env.NODE_ENV ?? "development";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Required environment variable ${name} is not set. The API server cannot start without it.`,
    );
  }
  return value;
}

function resolvePort(): number {
  const raw = process.env["PORT"];
  if (!raw) {
    throw new Error(
      "PORT environment variable is required but was not provided.",
    );
  }
  const port = Number(raw);
  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${raw}"`);
  }
  return port;
}

/**
 * Centralized, typed configuration for the API server.
 *
 * This is the single place that reads `process.env` or defines tunable
 * constants (timeouts, limits, AI/OCR settings). Required secrets are validated
 * eagerly at module load (fail-fast at startup). `port` is validated lazily on
 * first access so the Express app stays importable without a PORT set
 * (e.g. in tests), matching prior behavior. Object-storage values are exposed
 * raw and validated lazily by their consumers, preserving existing semantics.
 */
export const config = {
  nodeEnv,
  isProduction: nodeEnv === "production",
  logLevel: process.env.LOG_LEVEL ?? "info",

  // Required secret — throws at module load if missing.
  sessionSecret: requireEnv("SESSION_SECRET"),

  // Validated on access (used by the entrypoint only).
  get port(): number {
    return resolvePort();
  },

  http: {
    // Raised limit so base64 card images embedded in JSON bodies are accepted.
    bodyLimit: "15mb",
  },

  ai: {
    model: "gemini-2.5-flash",
    extractionTimeoutMs: 30_000,
    scoringTimeoutMs: 20_000,
    maxOutputTokens: 8192,
    // gemini-2.5-flash runs "thinking" on by default; 0 disables it for speed.
    thinkingBudget: 0,
  },

  objectStorage: {
    bucketId: process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID ?? "",
    publicSearchPaths: process.env.PUBLIC_OBJECT_SEARCH_PATHS ?? "",
    privateObjectDir: process.env.PRIVATE_OBJECT_DIR ?? "",
  },

  push: {
    // Optional Expo "enhanced security" bearer token.
    expoAccessToken: process.env.EXPO_ACCESS_TOKEN,
  },

  // Comma-separated list of published domains (Replit). Optional.
  replitDomains: process.env.REPLIT_DOMAINS,
} as const;
