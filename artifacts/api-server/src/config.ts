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

  auth: {
    // Access token (JWT, sent as Bearer). Kept long enough not to disrupt the
    // mobile client; logout/terminate are immediate via server-side session
    // validation regardless of this TTL.
    accessTokenTtl: process.env.ACCESS_TOKEN_TTL ?? "7d",
    // Refresh-token / session lifetime. Remember-me extends it.
    refreshTtlDays: Number(process.env.REFRESH_TTL_DAYS ?? 30),
    rememberMeRefreshTtlDays: Number(process.env.REMEMBER_ME_TTL_DAYS ?? 90),
    // Short-lived token that carries a pending (password-verified) MFA challenge.
    mfaChallengeTtl: "10m",
    // "Remember this device" lifetime for skipping MFA.
    trustedDeviceTtlDays: Number(process.env.TRUSTED_DEVICE_TTL_DAYS ?? 30),
    // Optional dedicated key for encrypting MFA secrets; derived from
    // SESSION_SECRET when unset so no new required env is introduced.
    mfaEncryptionKey: process.env.MFA_ENCRYPTION_KEY,
    issuer: "card-scanner-pro",
  },

  security: {
    // Brute-force lockout: N failed attempts for the same email+IP within the
    // window locks further attempts for the lockout duration.
    maxFailedAttempts: Number(process.env.LOGIN_MAX_ATTEMPTS ?? 5),
    lockoutWindowMinutes: Number(process.env.LOGIN_LOCKOUT_WINDOW_MIN ?? 15),
    lockoutMinutes: Number(process.env.LOGIN_LOCKOUT_MIN ?? 15),
    // express-rate-limit window/ceiling for the /api/auth surface.
    rateLimitWindowMs: Number(process.env.AUTH_RATE_WINDOW_MS ?? 15 * 60 * 1000),
    rateLimitMax: Number(process.env.AUTH_RATE_MAX ?? 100),
    loginRateLimitMax: Number(process.env.LOGIN_RATE_MAX ?? 20),
    // Minimum password length; complexity is enforced in validatePassword.
    minPasswordLength: Number(process.env.MIN_PASSWORD_LENGTH ?? 8),
    // Secure cookie flag — on in production (https), off in dev (http preview).
    cookieSecure: nodeEnv === "production",
  },

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
