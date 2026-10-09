// Child process for test/b25c9-gcs-stream-cancel.test.ts: exercises the REAL GcsStorageDriver against the
// loopback stand-in (helpers/gcs-emulator.mjs) in its own process, WITHOUT any uncaught-exception handler,
// so an uncaught stream error surfaces as a process failure. The child never calls process.exit on the
// success path: after the scenario it reports SCENARIO_DONE and lets the event loop drain naturally
// (DRAINED + the remaining active resources at 'beforeExit', then EXIT <code>); a loop that has not
// drained 5 s later reports NOT_DRAINED with the resources still alive and exits 97. The parent adds a
// SIGKILL watchdog on top. argv[2] = scenario, argv[3] = sha256 of the stand-in's object bytes.
import { Storage } from "@google-cloud/storage";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { pipeline } from "node:stream/promises";
import { Writable, type Readable } from "node:stream";
import { GcsStorageDriver } from "../../src/storage/gcs-driver.js";
import { VerifyingStream } from "../../src/storage/verify.js";

const scenario = process.argv[2] || "cancel-before-response";
const expectedSha = process.argv[3] || "";
const EMU = process.env.STORAGE_EMULATOR_HOST || "";
const TAG = randomBytes(3).toString("hex"); // per-process object names: the stand-in's statistics stay isolated
const t0 = Date.now();
const ms = () => Date.now() - t0;
const say = (s: string) => console.log(s);
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
const K = (behaviour: string) => `tenants/1/documents/${TAG}-${behaviour}-row`;
const MAX = 25 << 20;
// short retry budget: a provider that keeps failing must surface within seconds, not after the SDK's default back-off
const driver = new GcsStorageDriver(new Storage({ apiEndpoint: EMU, projectId: "x", retryOptions: { maxRetries: 1, retryDelayMultiplier: 1, totalTimeout: 3, maxRetryDelay: 1 } }), "fake-bucket");
const open = (behaviour: string, maxBytes = MAX) => driver.getStream(K(behaviour), { maxBytes });

type Stats = { media: Record<string, number[]>; aborted: Record<string, number>; completed: Record<string, number>; metadata: Record<string, number>; open: number };
function stats(): Promise<Stats> {
  // plain http.get without keep-alive so the statistics request never holds the event loop open
  return new Promise((resolve, reject) => {
    http.get(`${EMU}/__emu/stats`, { agent: false }, (res) => { let b = ""; res.setEncoding("utf8"); res.on("data", (d) => (b += d)); res.on("end", () => resolve(JSON.parse(b))); res.on("error", reject); }).on("error", reject);
  });
}
function sink() {
  const h = createHash("sha256");
  let n = 0;
  const w = new Writable({ write(c, _e, cb) { h.update(c); n += c.length; cb(); } });
  return { w, done: () => ({ n, sha: h.digest("hex") }) };
}
async function readAll(s: Readable) {
  const k = sink();
  await pipeline(s, k.w);
  return k.done();
}
/** What the consumer observes within a bound: END, ERROR (code/reason) or STALL (no end, no error). */
function outcome(s: Readable, boundMs: number): Promise<string> {
  return new Promise((resolve) => {
    let bytes = 0;
    const t = setTimeout(() => resolve(`STALL bytes=${bytes} after=${boundMs}ms destroyed=${s.destroyed}`), boundMs);
    s.on("data", (c: Buffer) => (bytes += c.length));
    s.once("error", (e: any) => { clearTimeout(t); resolve(`ERROR code=${e.code || e.name} reason=${e.reason || "-"} bytes=${bytes} at=${ms()}ms`); });
    s.once("end", () => { clearTimeout(t); resolve(`END bytes=${bytes}`); });
  });
}
const source = async (behaviour: string) => { const st = await stats(); const n = K(behaviour); return `source[${behaviour}]: media_attempts=${JSON.stringify(st.media[n] || [])} aborted=${st.aborted[n] || 0} completed=${st.completed[n] || 0} open_connections=${st.open}`; };

async function run() {
  if (scenario === "cancel-before-response") {
    // what routes/files.ts does for HEAD: the consumer closes before the provider has answered (400 ms delay, chunked body)
    const s = await open("late-slowbody");
    s.stream.destroy();
    await sleep(1500);
    say(await source("late-slowbody")); // the delayed response arrived AFTER the cancel and was torn down (aborted=1)
    const d = await readAll((await open("plain")).stream);
    say(`ALIVE after cancel-before-response; later GET ok bytes=${d.n} sha_match=${d.sha === expectedSha}`);
  } else if (scenario === "cancel-before-response-fast") {
    // the same close, against a provider that answers immediately (the response races the cancel)
    const s = await open("slowbody");
    s.stream.destroy();
    await sleep(800);
    say(await source("slowbody")); // torn down as soon as the response was handed over (aborted=1)
    const d = await readAll((await open("plain2")).stream);
    say(`ALIVE after cancel-before-response-fast; later GET ok bytes=${d.n} sha_match=${d.sha === expectedSha}`);
  } else if (scenario === "cancel-long-delay") {
    // cancel, then the provider answers only 2.5 s later: the request stays open until that answer (pre-existing
    // SDK behaviour — the SDK exposes no abort for a read stream), then it is torn down without a crash
    const s = await open("verylate-slowbody");
    s.stream.destroy();
    await sleep(600);
    say(`before the delayed response: ${await source("verylate-slowbody")}`);
    await sleep(2600);
    say(`after the delayed response: ${await source("verylate-slowbody")}`);
    say("ALIVE after cancel-long-delay");
  } else if (scenario === "get") {
    const d = await readAll((await open("plain")).stream);
    say(`GET ok bytes=${d.n} sha_match=${d.sha === expectedSha}`);
  } else if (scenario === "disconnect") {
    // the client goes away mid-body (slowbody: 8 KiB every 20 ms)
    const s = await open("slowbody");
    await new Promise<void>((resolve) => s.stream.once("data", () => { s.stream.destroy(); resolve(); }));
    await sleep(800);
    say(await source("slowbody")); // the provider saw its response aborted (aborted=1)
    say("ALIVE after mid-body disconnect");
  } else if (scenario === "midfail") {
    // the provider drops the socket after 4 KiB: the consumer observes neither end nor error (SDK stall)
    const s = await open("midfail");
    say(await outcome(s.stream, 3000));
    say(`active resources while stalled: ${JSON.stringify(process.getActiveResourcesInfo())}`);
    say(await source("midfail"));
    s.stream.destroy(); // the consumer (route / proxy / client) must bound the stall
    await sleep(300);
    say(`active resources after destroy: ${JSON.stringify(process.getActiveResourcesInfo())}`);
    say("ALIVE after provider mid-body failure");
  } else if (scenario === "badsha") {
    const s = await open("badsha");
    const v = new VerifyingStream({ sizeBytes: 200 * 1024, sha256: expectedSha });
    const k = sink();
    try { await pipeline(s.stream, v, k.w); say("UNEXPECTED: integrity mismatch not detected"); } catch (e: any) { say(`integrity mismatch surfaced code=${e.code || e.name} reason=${e.reason || "-"}`); }
    await sleep(300);
    say("ALIVE after integrity mismatch");
  } else if (scenario === "error-before-response") {
    // the provider answers 500 on every media attempt: the driver re-opens twice (READ_ATTEMPTS = 3) and the error surfaces
    const s = await open("err500");
    say(await outcome(s.stream, 8000));
    say(await source("err500")); // media_attempts=[500,500]
    say("ALIVE after provider error before the response");
  } else if (scenario === "cancel-then-error") {
    // the consumer closes BEFORE the provider errors (delayed 500): nothing is left to crash on
    const s = await open("late-err500");
    s.stream.destroy();
    await sleep(3000);
    say(await source("late-err500"));
    say("ALIVE after cancel-then-error");
  } else if (scenario === "retry-ordering") {
    // first media attempt 500, second 200: the driver's bounded re-open (the SDK's own stream retry is off:
    // it is the second crash path) delivers the exact bytes from the second attempt
    const d = await readAll((await open("flaky")).stream);
    say(await source("flaky")); // media_attempts=[500,200]
    say(`GET after retry ok bytes=${d.n} sha_match=${d.sha === expectedSha}`);
  } else if (scenario === "media-404") {
    const s = await open("media404");
    say(await outcome(s.stream, 5000)); // ERROR code=STORAGE_NOT_FOUND
    say("ALIVE after media 404");
  } else if (scenario === "head-404") {
    try { await open("meta404"); say("UNEXPECTED: absent object opened"); } catch (e: any) { say(`thrown before any stream code=${e.code || e.name}`); }
    say("ALIVE after head 404");
  } else if (scenario === "maxbytes-head") {
    try { await open("plain", 100 * 1024); say("UNEXPECTED: oversized object opened"); } catch (e: any) { say(`thrown before any stream code=${e.code || e.name}`); }
    say(await source("plain")); // media_attempts=[] — refused on metadata alone
    say("ALIVE after maxBytes refusal on metadata");
  } else if (scenario === "maxbytes-data") {
    // metadata claims 1024 bytes (passes the head check for maxBytes 4096) but 200 KiB arrive
    const s = await open("lies-slowbody", 4096);
    say(await outcome(s.stream, 5000)); // ERROR code=STORAGE_TOO_LARGE
    await sleep(800);
    say(await source("lies-slowbody")); // the source transfer was torn down (aborted=1)
    say("ALIVE after maxBytes enforcement on the data path");
  } else if (scenario === "repeat-concurrent") {
    // five immediate cancels issued concurrently while three full reads are outstanding, then five more
    // cancels and five full reads in sequence
    const cancels = Promise.all(Array.from({ length: 5 }, async () => { const s = await open("late-slowbody"); s.stream.destroy(); }));
    const reads = Promise.all(Array.from({ length: 3 }, async () => readAll((await open("plain")).stream)));
    await cancels;
    const r = await reads;
    for (let i = 0; i < 5; i++) { const s = await open("late-slowbody"); s.stream.destroy(); }
    for (let i = 0; i < 5; i++) r.push(await readAll((await open("plain")).stream));
    await sleep(1500);
    say(await source("late-slowbody")); // aborted=10
    say(`ALIVE after 10 cancels + 8 full reads sha_all_match=${r.every((d) => d.sha === expectedSha && d.n === 200 * 1024)}`);
  } else {
    say(`UNKNOWN scenario ${scenario}`);
    process.exitCode = 95;
  }
}

run()
  .then(() => {
    const tDone = ms();
    say(`SCENARIO_DONE at=${tDone}ms`);
    process.once("beforeExit", () => say(`DRAINED after=${ms() - tDone}ms active=${JSON.stringify(process.getActiveResourcesInfo())}`));
    // fires ONLY if something still keeps the loop alive 5 s after the scenario (unref: it never delays a natural exit)
    setTimeout(() => { say(`NOT_DRAINED after=5000ms active=${JSON.stringify(process.getActiveResourcesInfo())}`); process.exit(97); }, 5000).unref();
  })
  .catch((e) => { say(`RUN_ERROR ${e && e.code ? e.code : e}`); process.exitCode = 96; });
process.on("exit", (code) => say(`EXIT ${code}`));
