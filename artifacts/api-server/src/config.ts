const nodeEnv = process.env.NODE_ENV ?? "development";

// Public self-registration is OUTSIDE product scope: in production the
// /auth/register endpoint is unconditionally disabled — no environment
// variable can enable it there (the && makes the override powerless when
// nodeEnv is "production"). Outside production it defaults ON because the
// API test suites provision throwaway tenants through it;
// AUTH_ENABLE_REGISTRATION=false turns it off explicitly. Exported as a pure
// function so the truth table is unit-testable (test/registration-lockdown.test.ts).
export function resolveEnableRegistration(env: string, override: string | undefined): boolean {
  return env !== "production" && override !== "false";
}

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
    // See resolveEnableRegistration above: always false in production.
    enableRegistration: resolveEnableRegistration(nodeEnv, process.env.AUTH_ENABLE_REGISTRATION),
  },

  security: {
    // Brute-force lockout: N failed attempts for the same email+IP within the
    // window locks further attempts for the lockout duration.
    maxFailedAttempts: Number(process.env.LOGIN_MAX_ATTEMPTS ?? 5),
    lockoutWindowMinutes: Number(process.env.LOGIN_LOCKOUT_WINDOW_MIN ?? 15),
    lockoutMinutes: Number(process.env.LOGIN_LOCKOUT_MIN ?? 15),
    // express-rate-limit window/ceiling for the /api/auth surface. This is an
    // IP-wide ceiling that counts EVERY auth request (incl. successful logins), so
    // the integration test suite — which performs hundreds of logins against the
    // shared dev server in one run — trips the default 100 and returns spurious
    // 429s. The real credential-abuse guards (per-account DB lockout +
    // loginRateLimiter, failures-only) are unaffected, so we lift this ceiling
    // OUTSIDE production while keeping the hardened default when NODE_ENV=production.
    // An explicit AUTH_RATE_MAX env always wins.
    rateLimitWindowMs: Number(process.env.AUTH_RATE_WINDOW_MS ?? 15 * 60 * 1000),
    rateLimitMax: Number(process.env.AUTH_RATE_MAX ?? (nodeEnv === "production" ? 100 : 100_000)),
    loginRateLimitMax: Number(process.env.LOGIN_RATE_MAX ?? 20),
    // Per IP+email ceiling for forgot-password requests (anti mail-bomb).
    forgotPasswordRateLimitMax: Number(process.env.FORGOT_PASSWORD_RATE_MAX ?? 5),
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
    // CORS_ORIGINS: comma-separated exact origins, "*" for allow-all, unset for
    // the environment default (dev: allow-all, production: no cross-origin).
    // Parsed/resolved by lib/httpPolicy.ts (see that file for the full contract).
    corsOrigins: process.env.CORS_ORIGINS,
    // TRUST_PROXY: Express `trust proxy` value — hop count, boolean, or subnet
    // list. Unset defaults to 1 (single trusted reverse proxy = Replit topology).
    trustProxy: process.env.TRUST_PROXY,
  },

  ai: {
    // Active AI provider (Stage 5.0). Gemini is the sole active provider; the
    // abstraction layer (src/ai/) supports adding more without touching callers.
    provider: process.env.AI_PROVIDER ?? "gemini",
    // Gemini credentials — either the Replit AI integration proxy pair
    // (AI_INTEGRATIONS_GEMINI_API_KEY + AI_INTEGRATIONS_GEMINI_BASE_URL) or a
    // direct Google Gemini API key (GEMINI_API_KEY, portable/self-hosted).
    // The client itself lives in @workspace/integrations-gemini-ai; this only
    // centralizes the "is it configured?" signal.
    gemini: {
      apiKey:
        process.env.AI_INTEGRATIONS_GEMINI_API_KEY ?? process.env.GEMINI_API_KEY,
      baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL,
    },
    model: "gemini-2.5-flash",
    extractionTimeoutMs: 30_000,
    scoringTimeoutMs: 20_000,
    maxOutputTokens: 8192,
    // gemini-2.5-flash runs "thinking" on by default; 0 disables it for speed.
    thinkingBudget: 0,
    // Shared retry policy for the AI runner. Default 0 preserves the historical
    // single-attempt behavior + latency exactly; raise to opt into transient-error
    // retries. Backoff is multiplied by the attempt number.
    maxRetries: numEnv("AI_MAX_RETRIES", 0, 0),
    retryBackoffMs: numEnv("AI_RETRY_BACKOFF_MS", 500, 0),
    // Health-probe timeout for provider reachability checks.
    healthTimeoutMs: numEnv("AI_HEALTH_TIMEOUT_MS", 8_000, 100),
    // Per-tenant AI settings are cached in-process for this long to keep the hot
    // scan/score path from re-reading the row on every call. Short TTL so an admin
    // toggle takes effect quickly.
    settingsCacheTtlMs: numEnv("AI_SETTINGS_CACHE_TTL_MS", 60_000, 0),
    // ESTIMATED provider prices in micro-USD (1e-6 USD) per 1,000 tokens, used for
    // cost VISIBILITY only (never billing). Override via env if prices change; an
    // unknown model resolves to 0 cost (reported as "estimate unavailable").
    // pricingVersion identifies the pricing configuration in effect; it is stamped on
    // every ledger row at invocation time so historical totals never change when
    // prices are updated (bump the version when changing any rate).
    pricingVersion: process.env.AI_PRICING_VERSION ?? "v1-2025-06-defaults",
    pricing: {
      "gemini-2.5-flash": {
        inputPer1kMicroUsd: numEnv("AI_PRICE_FLASH_INPUT_PER1K_MICROUSD", 300, 0),
        outputPer1kMicroUsd: numEnv("AI_PRICE_FLASH_OUTPUT_PER1K_MICROUSD", 2_500, 0),
      },
      // Deterministic stub provider models (non-production only; see providers/stub.ts).
      // Priced like flash so cost-estimation paths are testable without live Gemini.
      ...(nodeEnv !== "production"
        ? {
            "stub-model": { inputPer1kMicroUsd: 300, outputPer1kMicroUsd: 2_500 },
          }
        : {}),
    } as Record<string, { inputPer1kMicroUsd: number; outputPer1kMicroUsd: number }>,
    // Batch 6 — deterministic stub provider for automated tests (never in production).
    enableStubProvider: nodeEnv !== "production" && process.env.AI_ENABLE_STUB !== "false",
    // Batch 6 — feature-specific maximum output tokens. Structured JSON outputs
    // (scores, recommendations) need far fewer tokens than long-form drafts; the
    // fallback remains the historical 8192 cap. Values are deliberately generous
    // (≥4x observed output sizes) so quality is never affected.
    maxOutputTokensByFeature: {
      card_extraction: 8192, // full OCR payload + per-field originals/confidences
      lead_scoring: 1024,
      contact_enrichment: 1024,
      assignee_recommendation: 1024,
      lead_intelligence: 4096,
      company_intelligence: 4096,
      contact_intelligence: 4096,
      smart_classification: 2048,
      opportunity_potential: 2048,
      email_composer: 4096,
      whatsapp_composer: 2048,
      call_preparation: 4096,
      meeting_preparation: 4096,
      proposal_assistant: 8192, // longest-form draft
      followup_suggestions: 2048,
      sales_coaching: 4096,
      conversation_summary: 4096,
      workflow_next_action: 2048,
      workflow_routing: 2048,
      workflow_progression: 2048,
      workflow_reminder: 2048,
      workflow_task: 2048,
      executive_summary: 8192,
      executive_forecast: 8192,
      assistant_answer: 4096,
    } as Record<string, number>,
    // Batch 6 — atomic tenant-budget enforcement. Before each provider call a
    // reservation of this many tokens (and its cost at current pricing) counts toward
    // the month budget until the call finalizes; abandoned reservations expire after
    // reservationTtlMs so a crash can never block a tenant permanently.
    budget: {
      reserveTokens: numEnv("AI_BUDGET_RESERVE_TOKENS", 2_000, 0),
      // Must exceed the worst-case provider call (timeout × retries + backoff) or an
      // in-flight call's reservation can expire mid-call and reopen budget headroom.
      reservationTtlMs: numEnv("AI_BUDGET_RESERVATION_TTL_MS", 5 * 60 * 1000, 1_000),
    },
    // Batch 6 — duplicate-request protection + conservative safe result reuse at the
    // Enterprise AI Layer seam. Keys are tenant+user+feature+prompt-hash scoped;
    // assistant conversations are never reused. TTL is deliberately short.
    dedup: {
      resultTtlMs: numEnv("AI_DEDUP_RESULT_TTL_MS", 30_000, 0), // 0 disables reuse window
      maxEntries: numEnv("AI_DEDUP_MAX_ENTRIES", 500, 10),
    },
    // Batch 6 — AI-specific rate limits (single policy source). Fixed one-minute
    // windows keyed per user, per tenant, and per user+heavy-feature. Deterministic
    // for tests via env overrides. platform_owner/system calls fall into a shared
    // "system" bucket keyed by user id, so no caller silently bypasses protection.
    rateLimits: {
      windowMs: numEnv("AI_RATE_WINDOW_MS", 60_000, 1_000),
      perUserMax: numEnv("AI_RATE_USER_MAX", 30, 1),
      perTenantMax: numEnv("AI_RATE_TENANT_MAX", 90, 1),
      heavyPerUserMax: numEnv("AI_RATE_HEAVY_USER_MAX", 10, 1),
      // High-cost long-form features get the stricter heavy per-user ceiling.
      heavyFeatures: [
        "proposal_assistant",
        "executive_summary",
        "executive_forecast",
        "meeting_preparation",
        "call_preparation",
      ],
    },
    // Batch 6 — usage alert policy (single source for all thresholds). Alerts are
    // delivered through the existing notification system (category "ai") and deduped
    // to one per kind per tenant per local day.
    alerts: {
      approachingBudgetPct: numEnv("AI_ALERT_APPROACHING_PCT", 80, 1),
      // Spike: today's provider requests exceed multiplier × trailing 7-day daily
      // average (with a minimum floor so tiny tenants don't false-positive).
      spikeMultiplier: numEnv("AI_ALERT_SPIKE_MULTIPLIER", 3, 1),
      spikeMinRequests: numEnv("AI_ALERT_SPIKE_MIN_REQUESTS", 50, 1),
      // Failure rate over the last hour (with a minimum request floor).
      failureRatePct: numEnv("AI_ALERT_FAILURE_RATE_PCT", 50, 1),
      failureMinRequests: numEnv("AI_ALERT_FAILURE_MIN_REQUESTS", 10, 1),
      sweepFirstDelayMs: numEnv("AI_ALERT_SWEEP_DELAY_MS", 180_000, 0),
      sweepIntervalMs: numEnv("AI_ALERT_SWEEP_INTERVAL_MS", 60 * 60 * 1000, 1_000),
    },
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
      // Scheduled-export sweep: find due export schedules and produce their files.
      exportFirstDelayMs: numEnv("JOBS_EXPORT_DELAY_MS", 90_000, 0),
      exportIntervalMs: numEnv("JOBS_EXPORT_INTERVAL_MS", 15 * 60 * 1000, 1_000),
      // Stage 5F workflow risk alert sweep: critical/high SLA risks → notifications.
      // Dispatch is deduped to one digest per user per local day regardless of cadence.
      workflowAlertsFirstDelayMs: numEnv("JOBS_WORKFLOW_ALERTS_DELAY_MS", 120_000, 0),
      workflowAlertsIntervalMs: numEnv("JOBS_WORKFLOW_ALERTS_INTERVAL_MS", 6 * 60 * 60 * 1000, 1_000),
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
