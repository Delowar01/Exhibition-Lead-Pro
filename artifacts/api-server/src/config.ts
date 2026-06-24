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

// Reads a numeric env var with a default + a hard minimum. Falls back to the default
// on missing/NaN input, then clamps to `min` so a misconfiguration can never produce a
// stalled queue (concurrency 0) or a NaN interval that silently never fires.
function numEnv(name: string, def: number, min: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw === "" ? def : Number(raw);
  if (Number.isNaN(n)) return def;
  return Math.max(min, n);
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

  // Email (Phase 2.5). Provider-agnostic; SMTP is the default and only built-in
  // transport. ALL values are optional and read from env — when host/user/pass are
  // unset the email service degrades to a no-op that logs a clear warning instead of
  // crashing. SendGrid/SES/Mailgun/Postmark/M365/Gmail are added later behind the
  // same interface without touching business logic.
  email: {
    provider: process.env.EMAIL_PROVIDER ?? "smtp",
    smtpHost: process.env.SMTP_HOST,
    smtpPort: Number(process.env.SMTP_PORT ?? 587),
    smtpUser: process.env.SMTP_USER,
    smtpPass: process.env.SMTP_PASS,
    // STARTTLS by default (587); set SMTP_SECURE=true for implicit TLS (465).
    smtpSecure: process.env.SMTP_SECURE === "true",
    fromAddress: process.env.EMAIL_FROM ?? "no-reply@cardscannerpro.com",
    fromName: process.env.EMAIL_FROM_NAME ?? "Card Scanner Pro",
    // Brand name shown in templates (white-label friendly).
    brandName: process.env.EMAIL_BRAND_NAME ?? "Card Scanner Pro",
    // Base URL used to build reset/verify/invite links. Falls back to the first
    // published Replit domain, then localhost for dev.
    appBaseUrl:
      process.env.APP_BASE_URL ??
      (process.env.REPLIT_DOMAINS ? `https://${process.env.REPLIT_DOMAINS.split(",")[0]}` : "http://localhost:5000"),
  },

  tokens: {
    // Password-reset and email-verification link lifetimes.
    passwordResetTtlMinutes: Number(process.env.PASSWORD_RESET_TTL_MIN ?? 60),
    emailVerifyTtlHours: Number(process.env.EMAIL_VERIFY_TTL_HOURS ?? 48),
    // Invitation link lifetime.
    invitationTtlDays: Number(process.env.INVITATION_TTL_DAYS ?? 7),
  },

  // Background jobs & queue (Phase 2.6). The queue moves slow/flaky work (email +
  // notification delivery) off the request path and runs recurring maintenance. The
  // in-process default needs no extra infra; `JOBS_DRIVER` is the single swap point
  // for a shared broker (Redis/BullMQ) later. `asyncEmail=false` is the rollback
  // switch: producers fall back to the synchronous 2.5 send path.
  jobs: {
    driver: process.env.JOBS_DRIVER ?? "in-process",
    asyncEmail: process.env.JOBS_ASYNC_EMAIL !== "false",
    concurrency: numEnv("JOBS_CONCURRENCY", 5, 1),
    // Email delivery is retried on transient transport errors with exponential backoff.
    maxAttempts: numEnv("JOBS_MAX_ATTEMPTS", 5, 1),
    backoffBaseMs: numEnv("JOBS_BACKOFF_BASE_MS", 2_000, 0),
    backoffMaxMs: numEnv("JOBS_BACKOFF_MAX_MS", 5 * 60 * 1000, 0),
    // Recurring maintenance cadence + first-run delays (ms). Generous initial delays
    // keep boot light and avoid interfering with short-lived processes/tests.
    schedule: {
      followUpFirstDelayMs: numEnv("JOBS_FOLLOWUP_DELAY_MS", 15_000, 0),
      followUpIntervalMs: numEnv("JOBS_FOLLOWUP_INTERVAL_MS", 60 * 60 * 1000, 1_000),
      maintenanceFirstDelayMs: numEnv("JOBS_MAINTENANCE_DELAY_MS", 60_000, 0),
      maintenanceIntervalMs: numEnv("JOBS_MAINTENANCE_INTERVAL_MS", 6 * 60 * 60 * 1000, 1_000),
    },
    retention: {
      // Delete read notifications older than this many days (0 disables).
      notificationDays: numEnv("JOBS_NOTIFICATION_RETENTION_DAYS", 90, 0),
      // Delete revoked/expired sessions older than this many days (0 disables).
      sessionDays: numEnv("JOBS_SESSION_RETENTION_DAYS", 30, 0),
      // Audit-log retention is OPT-IN. audit_logs is append-only by design; only a
      // positive value enables deletion of rows older than that many days.
      auditDays: numEnv("JOBS_AUDIT_RETENTION_DAYS", 0, 0),
    },
  },

  // Comma-separated list of published domains (Replit). Optional.
  replitDomains: process.env.REPLIT_DOMAINS,
} as const;
