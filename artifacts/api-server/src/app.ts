import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import compression from "compression";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { config } from "./config.js";
import { errorHandler, notFoundHandler } from "./middlewares/errorHandler.js";
import { authRateLimiter, loginRateLimiter } from "./middlewares/rateLimit.js";
import { bustCacheOnWrite } from "./middlewares/microCache.js";
import { metricsMiddleware } from "./lib/metrics.js";
import type { AuthRequest } from "./middlewares/requireAuth.js";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    // Enrich every request-completion log with the authenticated principal so logs are
    // correlatable by user/tenant. requireAuth populates req.user before the response
    // finishes; customProps is evaluated at log time, so it sees it. Anonymous requests
    // (pre-auth, public routes) simply add nothing.
    customProps: (req) => {
      const user = (req as AuthRequest).user;
      return user ? { userId: user.id, companyId: user.companyId } : {};
    },
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Surface the per-request id (assigned by pino-http) on every response so clients and
// logs can correlate a failed call to a server log line, AND guarantee every error
// envelope carries `requestId` without each handler having to add it. Additive: the
// header is new, and the field is injected only into error-shaped bodies ({ error })
// that don't already set it — success payloads are never touched.
app.use((req: Request, res: Response, next: NextFunction) => {
  const id = (req as Request & { id?: unknown }).id;
  if (id === undefined) {
    next();
    return;
  }
  const requestId = String(id);
  res.setHeader("X-Request-Id", requestId);
  const originalJson = res.json.bind(res);
  res.json = ((body?: unknown) => {
    if (
      res.statusCode >= 400 &&
      body !== null &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      "error" in (body as Record<string, unknown>) &&
      (body as Record<string, unknown>).requestId === undefined
    ) {
      (body as Record<string, unknown>).requestId = requestId;
    }
    return originalJson(body);
  }) as typeof res.json;
  next();
});

// Operational metrics: record every request's status + latency. Mounted early so the
// measured duration spans the full pipeline. Observes only — never alters the response.
app.use(metricsMiddleware);

// Security response headers. CSP and the cross-origin resource/embedder policies
// are disabled on purpose: this is a JSON + image API consumed cross-origin
// (open CORS) by the web and mobile clients, so CORP/COEP would block legitimate
// cross-origin image loads, and CSP applies to HTML documents this server never
// serves. The remaining helmet defaults (nosniff, frameguard, referrer-policy,
// HSTS over https, etc.) change no response bodies and reject no valid requests.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false,
    crossOriginEmbedderPolicy: false,
  }),
);
app.use(cors());
// gzip/deflate response bodies. Large JSON analytics payloads (reports, lists)
// compress well; small bodies fall under compression's default threshold and are
// sent uncompressed. Additive: changes transport encoding only, never the body.
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: config.http.bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: config.http.bodyLimit }));

// Bust the analytics micro-cache after every successful mutation. Mounted before
// the router so it observes all non-GET requests regardless of which base path
// (/api or /api/v1) they arrive on.
app.use(bustCacheOnWrite);

// Rate limiting on the auth surface. The stricter login limiter is mounted on the
// credential-checking endpoints; a broader limiter covers the rest of /api/auth.
// Mounted on both the versioned and legacy auth prefixes so the same protection
// applies regardless of which base path the client uses.
app.use(["/api/v1/auth/login", "/api/auth/login"], loginRateLimiter);
app.use(["/api/v1/auth/mfa/verify-login", "/api/auth/mfa/verify-login"], loginRateLimiter);
app.use(["/api/v1/auth", "/api/auth"], authRateLimiter);

// API versioning. `/api/v1` is the canonical, versioned base path; the legacy `/api`
// prefix is kept mounted to the SAME router so existing web/mobile clients keep
// working unchanged (rollback is a client base-path change, not a redeploy). Legacy
// requests get RFC 8594 deprecation signaling so consumers can migrate to /api/v1.
app.use("/api/v1", router);
app.use(
  "/api",
  (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Deprecation", "true");
    res.setHeader("Link", '</api/v1>; rel="successor-version"');
    next();
  },
  router,
);

// Unmatched routes -> JSON 404; anything thrown/rejected -> unified handler.
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
