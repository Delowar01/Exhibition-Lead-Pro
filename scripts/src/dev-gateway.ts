/**
 * Local development gateway — same-origin reverse proxy for localhost.
 *
 * Replicates the routing the Replit gateway (and the self-host nginx config in
 * docker/nginx/default.conf.template) provides in front of the app:
 *
 *   /api/*  → the API server   (default http://127.0.0.1:8080)
 *   /*      → the web dev server (default http://127.0.0.1:3000), incl. the
 *             WebSocket upgrade Vite HMR needs.
 *
 * The API and Playwright suites target http://localhost:80 (see
 * docs/LOCALHOST_DEVELOPMENT.md), and the web client calls the API via
 * relative /api paths, so both apps must share one origin locally. Run:
 *
 *   pnpm --filter @workspace/scripts run dev-gateway
 *
 * Env overrides: GATEWAY_PORT (80), API_UPSTREAM, WEB_UPSTREAM.
 * One trusted hop is added via X-Forwarded-* headers, matching the API's
 * default TRUST_PROXY=1.
 */
import http from "node:http";
import net from "node:net";

const PORT = Number(process.env.GATEWAY_PORT || 80);
const API_UPSTREAM = new URL(process.env.API_UPSTREAM || "http://127.0.0.1:8080");
const WEB_UPSTREAM = new URL(process.env.WEB_UPSTREAM || "http://127.0.0.1:3000");

function upstreamFor(url: string): URL {
  return url === "/api" || url.startsWith("/api/") ? API_UPSTREAM : WEB_UPSTREAM;
}

function forwardHeaders(req: http.IncomingMessage): http.OutgoingHttpHeaders {
  const remote = req.socket.remoteAddress ?? "";
  const prior = req.headers["x-forwarded-for"];
  return {
    ...req.headers,
    "x-forwarded-for": prior ? `${prior}, ${remote}` : remote,
    "x-forwarded-proto": "http",
    "x-real-ip": remote,
  };
}

const server = http.createServer((req, res) => {
  const upstream = upstreamFor(req.url ?? "/");
  const proxied = http.request(
    {
      host: upstream.hostname,
      port: upstream.port,
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req),
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  proxied.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`dev-gateway: upstream ${upstream.href} unreachable\n`);
  });
  req.pipe(proxied);
});

// WebSocket passthrough (Vite HMR). Hand the raw sockets to each other after
// replaying the upgrade request to the upstream.
server.on("upgrade", (req, socket: net.Socket, head: Buffer) => {
  const upstream = upstreamFor(req.url ?? "/");
  const proxied = net.connect(Number(upstream.port), upstream.hostname, () => {
    const headerLines = Object.entries(forwardHeaders(req))
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
    proxied.write(`${req.method} ${req.url} HTTP/1.1\r\n${headerLines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) proxied.write(head);
    proxied.pipe(socket);
    socket.pipe(proxied);
  });
  const drop = () => {
    socket.destroy();
    proxied.destroy();
  };
  proxied.on("error", drop);
  socket.on("error", drop);
});

server.listen(PORT, () => {
  console.log(
    `dev-gateway listening on http://localhost:${PORT} — /api → ${API_UPSTREAM.href}, / → ${WEB_UPSTREAM.href}`,
  );
});
