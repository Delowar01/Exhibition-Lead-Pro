// B25 Correction 9 — the GCS driver must survive a consumer that closes the object stream before the
// provider has answered (routes/files.ts does exactly that for HEAD; a client abort does the same).
// On Node >= 23 the SDK's response handler pipes into a destroyed stream and node's pipeline() throws
// ERR_STREAM_UNABLE_TO_PIPE inside an event handler: an uncaught exception that terminated the hosted
// API (run 37930815158). Each scenario runs the REAL GcsStorageDriver against a loopback stand-in in a
// CHILD PROCESS without any uncaught-exception handler, so a crash is a non-zero exit, never a hidden
// rejection. No credentials, no network beyond 127.0.0.1.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const helpers = path.join(here, "helpers");
const nodeMajor = Number(process.versions.node.split(".")[0]);

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

async function child(scenario: string): Promise<{ code: number | null; out: string }> {
  const proc = spawn(process.execPath, ["--import", "tsx", path.join(helpers, "gcs-stream-child.ts"), scenario, sha], {
    cwd: path.join(here, ".."),
    env: { ...process.env, STORAGE_EMULATOR_HOST: `http://127.0.0.1:${port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout!.on("data", (d) => (out += d));
  proc.stderr!.on("data", (d) => (out += d));
  const [code] = (await once(proc, "close")) as [number | null];
  return { code, out };
}

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

describe("B25 C9 — GCS read stream closed before the provider responds (child process, real driver, loopback stand-in)", () => {
  it(`HEAD-style close before the response keeps the process alive and later reads still work (node ${process.versions.node}${nodeMajor >= 23 ? "; crashed before the fix" : "; the crash needs node >= 23"})`, async () => {
    const r = await child("head-cancel");
    expect(r.out).not.toContain("ERR_STREAM_UNABLE_TO_PIPE");
    expect(r.out).toContain("ALIVE after head-cancel");
    expect(r.code).toBe(0);
  }, 30_000);

  it("five immediate closes followed by five full reads keep the process alive", async () => {
    const r = await child("repeat");
    expect(r.out).not.toContain("ERR_STREAM_UNABLE_TO_PIPE");
    expect(r.out).toContain("ALIVE after 5 cancels + 5 full reads");
    expect(r.code).toBe(0);
  }, 30_000);

  it("a normal read delivers the exact bytes (sha256)", async () => {
    const r = await child("get");
    expect(r.out).toContain("sha_match=true");
    expect(r.code).toBe(0);
  }, 30_000);

  it("a consumer that disconnects mid-body does not terminate the process", async () => {
    const r = await child("disconnect");
    expect(r.out).toContain("ALIVE after mid-body disconnect");
    expect(r.code).toBe(0);
  }, 30_000);

  it("a provider that drops the connection mid-body never completes the read and never terminates the process (error or stall is recorded)", async () => {
    const r = await child("midfail");
    expect(r.out).not.toContain("UNEXPECTED: midfail stream completed");
    expect(r.out).toMatch(/midfail (surfaced as stream error|STALLED)/);
    expect(r.out).toContain("ALIVE after provider mid-body failure");
    expect(r.code).toBe(0);
  }, 60_000);

  it("an integrity mismatch is reported by VerifyingStream (STORAGE_INTEGRITY) and the process survives", async () => {
    const r = await child("badsha");
    expect(r.out).toContain("code=STORAGE_INTEGRITY");
    expect(r.out).toContain("ALIVE after integrity mismatch");
    expect(r.code).toBe(0);
  }, 30_000);
});
