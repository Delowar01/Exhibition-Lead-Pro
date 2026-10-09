// LOCAL ONLY: a minimal stand-in for the GCS JSON/media API (no credentials, loopback only) with
// controllable behaviour selected by substrings of the object name:
//   "late"       media response headers delayed (EMU_DELAY_MS, default 400 ms); "verylate" = 2500 ms
//   "slowbody"   body in 8 KiB chunks every 20 ms (a teardown mid-body is observable as an aborted response)
//   "midfail"    EVERY attempt: headers + 4 KiB, then the socket is dropped (provider failure mid-body)
//   "badsha"     the last byte differs from the registered digest (integrity mismatch)
//   "err500"     EVERY media attempt answers 500 (provider error before the response is usable)
//   "flaky"      the FIRST media attempt answers 500, later attempts succeed (SDK retry ordering)
//   "lies"       metadata reports size 1024 while 200 KiB are served (metadata cannot be trusted for limits)
//   "meta404"    metadata answers 404 (object absent)
//   "media404"   metadata ok, media answers 404
// GET /__emu/stats reports, per object name: media attempts (with the status answered), responses aborted
// before their end (the client tore the transfer down), completed responses, and open connections.
import http from "node:http";
import { createHash } from "node:crypto";
const PORT = Number(process.env.EMU_PORT || 4443);
const bytes = Buffer.alloc(200 * 1024, 7);
const sha = createHash("sha256").update(bytes).digest("hex");
const meta = (name) => ({ name, bucket: "fake-bucket", size: name.includes("lies") ? "1024" : String(bytes.length), contentType: "application/pdf", generation: "1760000000000001", metageneration: "1", metadata: { "lcp-object-id": process.env.EMU_ROW_ID || "row" } });
const log = (...a) => process.stderr.write(`[emu] ${a.join(" ")}\n`);
const stats = { media: {}, aborted: {}, completed: {}, metadata: {}, open: 0 };
const bump = (m, k) => { m[k] = (m[k] || 0) + 1; };
const attempts = (name) => (stats.media[name] = stats.media[name] || []);
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  log(req.method, u.pathname, u.search, req.headers.range ? `range=${req.headers.range}` : "");
  if (u.pathname === "/__emu/stats") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(stats)); }
  // bucket listing (the readiness probe lists one object under a prefix)
  if (req.method === "GET" && /^(\/storage\/v1)?\/b\/[^/]+\/o\/?$/.test(u.pathname)) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ kind: "storage#objects", items: [] })); }
  // The SDK addresses a custom endpoint as <endpoint>/b/<bucket>/o/<name> (metadata and ?alt=media) and the
  // public API as /storage/v1/... or /download/storage/v1/...; accept every form.
  const m = u.pathname.match(/^(\/download)?(\/storage\/v1)?\/b\/([^/]+)\/o\/(.+)$/);
  if (!m) { res.writeHead(404); return res.end("{}"); }
  const name = decodeURIComponent(m[4]);
  const media = !!m[1] || u.searchParams.get("alt") === "media";
  if (req.method === "GET" && !media) {
    bump(stats.metadata, name);
    if (name.includes("meta404")) { res.writeHead(404, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { code: 404, message: "Not Found" } })); }
    res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(meta(name)));
  }
  if (req.method === "GET" && media) {
    const n = attempts(name).length + 1;
    const delay = name.includes("verylate") ? 2500 : name.includes("late") ? Number(process.env.EMU_DELAY_MS || 400) : 0;
    res.on("close", () => { if (!res.writableFinished) bump(stats.aborted, name); else bump(stats.completed, name); });
    setTimeout(() => {
      const answer = (status) => attempts(name).push(status);
      if (name.includes("media404")) { answer(404); res.writeHead(404, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { code: 404, message: "Not Found" } })); }
      if (name.includes("err500") || (name.includes("flaky") && n === 1)) { answer(500); res.writeHead(500, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { code: 500, message: "Backend Error" } })); }
      // "midfail": EVERY attempt (including the SDK's ranged retries) sends headers plus 4 KiB and then drops the socket
      if (name.includes("midfail")) { answer(200); res.writeHead(200, { "content-type": "application/pdf", "content-length": String(bytes.length) }); res.write(bytes.subarray(0, 4096)); setTimeout(() => res.socket.destroy(), 50); return; }
      const body = name.includes("badsha") ? Buffer.concat([bytes.subarray(0, bytes.length - 1), Buffer.from([8])]) : bytes;
      answer(200);
      res.writeHead(200, { "content-type": "application/pdf", "content-length": String(body.length) });
      if (name.includes("slowbody")) {
        let off = 0;
        const tick = () => { if (res.destroyed) return; const end = Math.min(off + 8192, body.length); res.write(body.subarray(off, end)); off = end; if (off < body.length) setTimeout(tick, 20); else res.end(); };
        return tick();
      }
      res.end(body);
    }, delay);
    return;
  }
  res.writeHead(405); res.end();
});
srv.on("connection", (s) => { stats.open += 1; s.on("close", () => { stats.open -= 1; }); });
srv.listen(PORT, "127.0.0.1", () => { log("listening", PORT, "sha", sha); process.stdout.write(`${sha}\n`); });
