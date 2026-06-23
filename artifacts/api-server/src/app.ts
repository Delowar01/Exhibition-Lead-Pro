import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { config } from "./config.js";
import { errorHandler, notFoundHandler } from "./middlewares/errorHandler.js";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
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
app.use(express.json({ limit: config.http.bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: config.http.bodyLimit }));

app.use("/api", router);

// Unmatched routes -> JSON 404; anything thrown/rejected -> unified handler.
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
