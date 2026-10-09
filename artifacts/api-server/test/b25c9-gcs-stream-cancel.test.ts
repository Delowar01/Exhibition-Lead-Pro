// B25 Correction 9 — the GCS driver must survive a consumer that closes the object stream before the
// provider has answered (routes/files.ts does exactly that for HEAD; a client abort does the same).
// On Node >= 23 the SDK's response handler pipes into a destroyed stream and node's pipeline() throws
// ERR_STREAM_UNABLE_TO_PIPE inside an event handler: an uncaught exception that terminated the hosted
// API (run 37930815158). Each scenario runs the REAL GcsStorageDriver against a loopback stand-in in a
// CHILD PROCESS without any uncaught-exception handler, so a crash is a non-zero exit, never a hidden
// rejection. The child never calls process.exit on success: it must DRAIN naturally (resource-cleanup
// proof) and the parent kills a child that hangs (watchdog). No credentials, no network beyond 127.0.0.1.
//
// Driver-level proof only. The HTTP route (GET/HEAD /api/files/:id through the real API) is exercised by
// test/b25c9-gcs-stream-http.test.ts, which is opt-in because it needs an API instance wired to the stand-in.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const helpers = path.join(here, "helpers");
const nodeMajor = Number(process.versions.node.split(".")[0]);
const WATCHDOG_MS = 20_000;

let emulator: ReturnType<typeof spawn> | null = null;
let port = 0;
let sha = "";

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const p = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return p;
}

type ChildResult = { code: number | null; signal: NodeJS.Signals | null; out: string; hung: boolean };
async function child(scenario: string): Promise<ChildResult> {
  const proc = spawn(process.execPath, ["--import", "tsx", path.join(helpers, "gcs-stream-child.ts"), scenario, sha], {
    cwd: path.join(here, ".."),
    env: { ...process.env, STORAGE_EMULATOR_HOST: `http://127.0.0.1:${port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let hung = false;
  proc.stdout!.on("data", (d) => (out += d));
  proc.stderr!.on("data", (d) => (out += d));
  // parent-side watchdog: a child that neither exits nor drains is killed and reported as hung
  const watchdog = setTimeout(() => { hung = true; proc.kill("SIGKILL"); }, WATCHDOG_MS);
  const [code, signal] = (await once(proc, "close")) as [number | null, NodeJS.Signals | null];
  clearTimeout(watchdog);
  return { code, signal, out, hung };
}
/** Every scenario must end the same way: no crash, SCENARIO_DONE, a natural drain and exit code 0. */
function expectClean(r: ChildResult) {
  expect(r.hung, `child hung (killed by the watchdog)\n${r.out}`).toBe(false);
  expect(r.out).not.toContain("ERR_STREAM_UNABLE_TO_PIPE");
  expect(r.out).not.toContain("RUN_ERROR");
  expect(r.out).not.toContain("UNEXPECTED");
  expect(r.out).toContain("SCENARIO_DONE");
  expect(r.out).toMatch(/^DRAINED after=\d+ms active=\["PipeWrap","PipeWrap"\]$/m); // only the stdio pipes remain
  expect(r.out).not.toContain("NOT_DRAINED");
  expect(r.out).toMatch(/^EXIT 0$/m);
  expect(r.code).toBe(0);
}
const drainMs = (out: string) => Number(/^DRAINED after=(\d+)ms/m.exec(out)?.[1] ?? NaN);

beforeAll(async () => {
  port = await freePort();
  emulator = spawn(process.execPath, [path.join(helpers, "gcs-emulator.mjs")], { env: { ...process.env, EMU_PORT: String(port), EMU_ROW_ID: "row" }, stdio: ["ignore", "pipe", "pipe"] });
  sha = await new Promise<string>((resolve, reject) => {
    emulator!.stdout!.once("data", (d) => resolve(String(d).trim()));
    emulator!.once("exit", (c) => reject(new Error(`stand-in exited ${c}`)));
  });
}, 20_000);

afterAll(() => {
  emulator?.kill();
});

describe(`B25 C9 — GCS read stream closed before the provider responds (child process, real driver, loopback stand-in; node ${process.versions.node}${nodeMajor >= 23 ? "; crashed before the fix" : "; the crash needs node >= 23"})`, () => {
  it("cancel before the (delayed) response: the response is still handed to the SDK, then torn down; the process stays alive and later reads work", async () => {
    const r = await child("cancel-before-response");
    expect(r.out).toContain("source[late-slowbody]: media_attempts=[200] aborted=1 completed=0");
    expect(r.out).toContain("ALIVE after cancel-before-response; later GET ok bytes=204800 sha_match=true");
    expectClean(r);
  }, 30_000);

  it("cancel racing an immediate response: torn down as soon as the response is handed over", async () => {
    const r = await child("cancel-before-response-fast");
    expect(r.out).toContain("source[slowbody]: media_attempts=[200] aborted=1 completed=0");
    expect(r.out).toContain("ALIVE after cancel-before-response-fast; later GET ok bytes=204800 sha_match=true");
    expectClean(r);
  }, 30_000);

  it("cancel long before the response (2.5 s): the request stays open until the provider answers (the SDK exposes no abort; same before the fix), then it is torn down without a crash", async () => {
    const r = await child("cancel-long-delay");
    expect(r.out).toContain("before the delayed response: source[verylate-slowbody]: media_attempts=[] aborted=0 completed=0");
    expect(r.out).toContain("after the delayed response: source[verylate-slowbody]: media_attempts=[200] aborted=1 completed=0");
    expect(r.out).toContain("ALIVE after cancel-long-delay");
    expectClean(r);
  }, 30_000);

  it("ten cancels (five of them concurrent with three outstanding full reads) tear down ten transfers; eight full reads deliver the exact bytes", async () => {
    const r = await child("repeat-concurrent");
    expect(r.out).toContain("source[late-slowbody]: media_attempts=[200,200,200,200,200,200,200,200,200,200] aborted=10 completed=0");
    expect(r.out).toContain("ALIVE after 10 cancels + 8 full reads sha_all_match=true");
    expectClean(r);
    expect(drainMs(r.out)).toBeLessThan(2000);
  }, 30_000);

  it("a normal read delivers the exact bytes (sha256)", async () => {
    const r = await child("get");
    expect(r.out).toContain("GET ok bytes=204800 sha_match=true");
    expectClean(r);
  }, 30_000);

  it("a consumer that disconnects mid-body tears the provider transfer down and does not terminate the process", async () => {
    const r = await child("disconnect");
    expect(r.out).toContain("source[slowbody]: media_attempts=[200] aborted=1 completed=0");
    expect(r.out).toContain("ALIVE after mid-body disconnect");
    expectClean(r);
  }, 30_000);

  it("provider drops the connection mid-body: the SDK stream neither ends nor errors (pre-existing SDK behaviour, identical before the fix); the consumer's destroy frees everything and the process survives", async () => {
    // Classification (B25 C9 validation): after 4 KiB the stand-in closes the socket; the SDK makes no retry and
    // surfaces no error (observed on Node 22 / 24.13 / 24.21 with the eb2edb0 driver and with the fix). The
    // driver holds no socket meanwhile (only the stdio pipes are active). Bounding the stall is the consumer's
    // job: routes/files.ts tears the stream down when the response closes (client abort / proxy read timeout).
    const r = await child("midfail");
    expect(r.out).toMatch(/^STALL bytes=4096 after=3000ms destroyed=false$/m);
    expect(r.out).toContain('active resources while stalled: ["PipeWrap","PipeWrap"]');
    expect(r.out).toContain("source[midfail]: media_attempts=[200] aborted=1 completed=0");
    expect(r.out).toContain('active resources after destroy: ["PipeWrap","PipeWrap"]');
    expect(r.out).toContain("ALIVE after provider mid-body failure");
    expectClean(r);
  }, 30_000);

  it("an integrity mismatch is reported by VerifyingStream (STORAGE_INTEGRITY / DIGEST_MISMATCH) and the process survives", async () => {
    const r = await child("badsha");
    expect(r.out).toContain("integrity mismatch surfaced code=STORAGE_INTEGRITY reason=DIGEST_MISMATCH");
    expect(r.out).toContain("ALIVE after integrity mismatch");
    expectClean(r);
  }, 30_000);

  it("provider error before the response (500 on every attempt): the driver re-opens twice (3 attempts in total), then STORAGE_UNAVAILABLE reaches the consumer within the budget", async () => {
    const r = await child("error-before-response");
    expect(r.out).toMatch(/^ERROR code=STORAGE_UNAVAILABLE reason=- bytes=0 at=\d+ms$/m);
    expect(r.out).toContain("source[err500]: media_attempts=[500,500,500]");
    expect(r.out).toContain("ALIVE after provider error before the response");
    expectClean(r);
  }, 30_000);

  it("cancel, then a provider error before any response: no re-open for a consumer that left, nothing is left to crash on", async () => {
    const r = await child("cancel-then-error");
    expect(r.out).toContain("source[late-err500]: media_attempts=[500]");
    expect(r.out).toContain("ALIVE after cancel-then-error");
    expectClean(r);
  }, 30_000);

  it("retry ordering: a failed first attempt (500) is re-opened by the driver before any byte was delivered; the second attempt delivers the exact bytes (the SDK's own stream retry stays off: it is the second crash path on node >= 23)", async () => {
    const r = await child("retry-ordering");
    expect(r.out).toContain("source[flaky]: media_attempts=[500,200]");
    expect(r.out).toContain("GET after retry ok bytes=204800 sha_match=true");
    expectClean(r);
  }, 30_000);

  it("media 404 after a successful head surfaces STORAGE_NOT_FOUND on the stream", async () => {
    const r = await child("media-404");
    expect(r.out).toMatch(/^ERROR code=STORAGE_NOT_FOUND /m);
    expectClean(r);
  }, 30_000);

  it("an absent object (head 404) throws STORAGE_NOT_FOUND before any stream exists", async () => {
    const r = await child("head-404");
    expect(r.out).toContain("thrown before any stream code=STORAGE_NOT_FOUND");
    expectClean(r);
  }, 30_000);

  it("maxBytes is enforced on metadata before any transfer (STORAGE_TOO_LARGE, no media request)", async () => {
    const r = await child("maxbytes-head");
    expect(r.out).toContain("thrown before any stream code=STORAGE_TOO_LARGE");
    expect(r.out).toContain("source[plain]: media_attempts=[] aborted=0 completed=0");
    expectClean(r);
  }, 30_000);

  it("maxBytes is enforced on the data path when metadata lies (STORAGE_TOO_LARGE on the stream; the source transfer is torn down)", async () => {
    const r = await child("maxbytes-data");
    expect(r.out).toMatch(/^ERROR code=STORAGE_TOO_LARGE /m);
    expect(r.out).toContain("source[lies-slowbody]: media_attempts=[200] aborted=1 completed=0");
    expectClean(r);
  }, 30_000);

  it("cancel during the first retry back-off: no further request is opened (exactly one attempt)", async () => {
    const r = await child("cancel-during-first-backoff");
    expect(r.out).toContain("source[err500]: media_attempts=[500] ");
    expect(r.out).toContain("ALIVE after cancel during the first backoff");
    expectClean(r);
  }, 30_000);

  it("cancel during a later retry back-off: the attempts stay at two", async () => {
    const r = await child("cancel-during-later-backoff");
    expect(r.out).toContain("source[err500]: media_attempts=[500,500] ");
    expect(r.out).toContain("ALIVE after cancel during a later backoff");
    expectClean(r);
  }, 30_000);

  it("exhausted attempts for an active consumer: three attempts, then STORAGE_UNAVAILABLE", async () => {
    const r = await child("exhausted-attempts");
    expect(r.out).toMatch(/^ERROR code=STORAGE_UNAVAILABLE reason=- bytes=0 at=\d+ms$/m);
    expect(r.out).toContain("source[err500]: media_attempts=[500,500,500] ");
    expectClean(r);
  }, 30_000);

  it("the API installs no global uncaughtException / unhandledRejection handler (a crash stays a crash; the fix is in the driver)", () => {
    const src = path.join(here, "..", "src");
    const files: string[] = [];
    const walk = (d: string) => { for (const e of readdirSync(d)) { const p = path.join(d, e); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts")) files.push(p); } };
    walk(src);
    const offenders = files.filter((f) => /process\.on\(\s*["'](uncaughtException|unhandledRejection)["']/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
