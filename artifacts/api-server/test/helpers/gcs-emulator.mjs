// LOCAL ONLY: a minimal stand-in for the GCS JSON/media API (no credentials, loopback only) with
// controllable behaviour per object name: "slow" delays the media response, "midfail" closes the
// socket mid-body, "badsha" serves different bytes than the registered digest.
import http from "node:http";
import { createHash } from "node:crypto";
const PORT = Number(process.env.EMU_PORT || 4443);
const bytes = Buffer.alloc(200 * 1024, 7);
const sha = createHash("sha256").update(bytes).digest("hex");
const meta = (name) => ({ name, bucket: "fake-bucket", size: String(bytes.length), contentType: "application/pdf", generation: "1760000000000001", metageneration: "1", metadata: { "lcp-object-id": process.env.EMU_ROW_ID || "row" } });
const log = (...a) => process.stderr.write(`[emu] ${a.join(" ")}\n`);
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  log(req.method, u.pathname, u.search);
  // The SDK addresses a custom endpoint as <endpoint>/b/<bucket>/o/<name> (metadata and ?alt=media) and the
  // public API as /storage/v1/... or /download/storage/v1/...; accept every form.
  const m = u.pathname.match(/^(\/download)?(\/storage\/v1)?\/b\/([^/]+)\/o\/(.+)$/);
  if (!m) { res.writeHead(404); return res.end("{}"); }
  const name = decodeURIComponent(m[4]);
  const media = !!m[1] || u.searchParams.get("alt") === "media";
  if (req.method === "GET" && !media) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(meta(name))); }
  if (req.method === "GET" && media) {
    const delay = name.includes("slow") ? Number(process.env.EMU_DELAY_MS || 400) : 0;
    setTimeout(() => {
      // "midfail": EVERY attempt (including the SDK's ranged retries) sends headers plus 4 KiB and then drops the socket
      if (name.includes("midfail")) { res.writeHead(200, { "content-type": "application/pdf", "content-length": String(bytes.length) }); res.write(bytes.subarray(0, 4096)); setTimeout(() => res.socket.destroy(), 50); return; }
      const body = name.includes("badsha") ? Buffer.concat([bytes.subarray(0, bytes.length - 1), Buffer.from([8])]) : bytes;
      res.writeHead(200, { "content-type": "application/pdf", "content-length": String(body.length) }); res.end(body);
    }, delay);
    return;
  }
  res.writeHead(405); res.end();
});
srv.listen(PORT, "127.0.0.1", () => { log("listening", PORT, "sha", sha); process.stdout.write(`${sha}\n`); });
