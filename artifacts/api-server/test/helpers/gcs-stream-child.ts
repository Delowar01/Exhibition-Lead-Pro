// Child process for test/b25c9-gcs-stream-cancel.test.ts: exercises the REAL GcsStorageDriver against the
// loopback stand-in (helpers/gcs-emulator.mjs) in its own process, WITHOUT any uncaught-exception handler,
// so an uncaught stream error surfaces as a process failure. SCENARIO = head-cancel | get | disconnect |
// midfail | badsha | repeat; argv[3] = sha256 of the stand-in's object bytes.
import { Storage } from "@google-cloud/storage";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import { GcsStorageDriver } from "../../src/storage/gcs-driver.js";
import { VerifyingStream } from "../../src/storage/verify.js";
const scenario = process.argv[2] || "head-cancel";
const expectedSha = process.argv[3] || "";
// short retry budget: a provider that keeps failing must surface within seconds, not after the SDK's default back-off
const driver = new GcsStorageDriver(new Storage({ apiEndpoint: process.env.STORAGE_EMULATOR_HOST, projectId: "x", retryOptions: { maxRetries: 1, retryDelayMultiplier: 1, totalTimeout: 3, maxRetryDelay: 1 } }), "fake-bucket");
const sink = () => { const h = createHash("sha256"); let n = 0; const w = new Writable({ write(c, _e, cb) { h.update(c); n += c.length; cb(); } }); return { w, done: () => ({ n, sha: h.digest("hex") }) }; };
async function run() {
  if (scenario === "head-cancel") {
    const s = await driver.getStream("tenants/1/documents/slow-row", { maxBytes: 25 << 20 });
    s.stream.destroy();                         // what routes/files.ts does for HEAD, before the provider response arrives
    await new Promise((r) => setTimeout(r, 1500));
    const again = await driver.getStream("tenants/1/documents/row", { maxBytes: 25 << 20 }); const k = sink(); await pipeline(again.stream, k.w);
    console.log(`ALIVE after head-cancel; later GET ok bytes=${k.done().n}`);
  } else if (scenario === "get") {
    const s = await driver.getStream("tenants/1/documents/row", { maxBytes: 25 << 20 }); const k = sink(); await pipeline(s.stream, k.w); const d = k.done();
    console.log(`GET ok bytes=${d.n} sha_match=${d.sha === expectedSha}`);
  } else if (scenario === "disconnect") {
    const s = await driver.getStream("tenants/1/documents/row", { maxBytes: 25 << 20 });
    await new Promise<void>((resolve) => { s.stream.once("data", () => { s.stream.destroy(); resolve(); }); });   // client went away mid-body
    await new Promise((r) => setTimeout(r, 800));
    console.log("ALIVE after mid-body disconnect");
  } else if (scenario === "midfail") {
    const s = await driver.getStream("tenants/1/documents/midfail-row", { maxBytes: 25 << 20 }); const k = sink();
    const outcome = await Promise.race([
      pipeline(s.stream, k.w).then(() => "UNEXPECTED: midfail stream completed").catch((e: any) => `midfail surfaced as stream error code=${e.code || e.name}`),
      new Promise<string>((r) => setTimeout(() => r("midfail STALLED (neither end nor error within 3s)"), 3000)),
    ]);
    console.log(outcome);
    s.stream.destroy();
    await new Promise((r) => setTimeout(r, 300)); console.log("ALIVE after provider mid-body failure");
  } else if (scenario === "badsha") {
    const s = await driver.getStream("tenants/1/documents/badsha-row", { maxBytes: 25 << 20 });
    const v = new VerifyingStream({ sizeBytes: 200 * 1024, sha256: expectedSha }); const k = sink();
    try { await pipeline(s.stream, v, k.w); console.log("UNEXPECTED: integrity mismatch not detected"); } catch (e: any) { console.log(`integrity mismatch surfaced code=${e.code || e.name} reason=${e.reason || "-"}`); }
    await new Promise((r) => setTimeout(r, 300)); console.log("ALIVE after integrity mismatch");
  } else if (scenario === "repeat") {
    for (let i = 0; i < 5; i++) { const s = await driver.getStream("tenants/1/documents/slow-row", { maxBytes: 25 << 20 }); s.stream.destroy(); }
    for (let i = 0; i < 5; i++) { const s = await driver.getStream("tenants/1/documents/row", { maxBytes: 25 << 20 }); const k = sink(); await pipeline(s.stream, k.w); }
    await new Promise((r) => setTimeout(r, 1500)); console.log("ALIVE after 5 cancels + 5 full reads");
  }
  process.exit(0);
}
run().catch((e) => { console.log(`RUN_ERROR ${e && e.code ? e.code : e}`); process.exit(96); });
