// B25 Correction 6 — the mobile private-file helper must work with BOTH
// protocols of the B25 transition and fail closed for anything else:
//   • B25 first-party URL (the configured API origin, /api/files/…): session
//     bearer required, upload capability required, relative URLs resolved
//     against the configured origin only, no query credentials;
//   • pre-B25 signed Google Cloud Storage URL (an emergency API rollback to
//     5a072fd returns these and no uploadToken): HTTPS, the exact host the
//     pre-B25 API minted, signed query preserved, NO Lead Capture credential
//     and NO capability header sent to Google;
//   • any other origin / scheme / shape: refused BEFORE a network request.
// Red on dff27bc: the helper attached the session bearer (and a capability
// header of "undefined") to the signed GCS URL, sent relative and lookalike
// URLs as-is and never refused anything.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBaseUrl } from "@workspace/api-client-react";

const state = vi.hoisted(() => ({
  OS: "ios" as string,
  token: "session-token-SECRET-VALUE" as string | null,
  downloadAsync: vi.fn(),
  uploadAsync: vi.fn(),
}));
vi.mock("react-native", () => ({ Platform: { get OS() { return state.OS; } } }));
vi.mock("expo-file-system/legacy", () => ({
  downloadAsync: state.downloadAsync,
  uploadAsync: state.uploadAsync,
  FileSystemUploadType: { BINARY_CONTENT: "binary" },
  cacheDirectory: "file:///cache/",
}));
vi.mock("./auth-storage", () => ({ getCachedToken: () => state.token }));

import { downloadPrivateFile, fetchPrivateBlob, putPrivateUpload } from "./private-files";

const ORIGIN = "https://admin.kaptnow.com";
const ID = "0b7c2f2e-1d7a-4c0e-9a7b-3c3d1a2b4c5d";
const FIRST_PARTY_GET = `${ORIGIN}/api/files/${ID}`;
const FIRST_PARTY_PUT = `${ORIGIN}/api/files/uploads/${ID}`;
const CAPABILITY = "capability-SECRET-VALUE";
const SIGNATURE = "deadbeefSIGNATURESECRET";
const SIGNED_GET = `https://storage.googleapis.com/some-bucket/.private/uploads/${ID}?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=svc%40project.iam.gserviceaccount.com%2F20261002%2Fauto%2Fstorage%2Fgoog4_request&X-Goog-Date=20261002T000000Z&X-Goog-Expires=900&X-Goog-SignedHeaders=host&X-Goog-Signature=${SIGNATURE}`;
const SIGNED_PUT = SIGNED_GET;
const SECRETS = [state.token!, CAPABILITY, SIGNATURE];

const fetchMock = vi.fn();
function okFetch() {
  return { ok: true, status: 200, blob: async () => new Blob(["bytes"]) };
}
function noSecret(err: unknown) {
  const text = JSON.stringify({ message: (err as Error).message, stack: (err as Error).stack, ...(err as object) });
  for (const s of SECRETS) expect(text, `error leaked ${s}`).not.toContain(s);
}

beforeEach(() => {
  setBaseUrl(ORIGIN);
  state.OS = "ios";
  state.token = "session-token-SECRET-VALUE";
  state.downloadAsync.mockReset().mockResolvedValue({ status: 200, uri: "file:///cache/out" });
  state.uploadAsync.mockReset().mockResolvedValue({ status: 200, body: "" });
  fetchMock.mockReset().mockImplementation(async () => okFetch());
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("B25 first-party URLs (native)", () => {
  it("download sends the session bearer", async () => {
    await downloadPrivateFile(FIRST_PARTY_GET, "file:///cache/x");
    expect(state.downloadAsync).toHaveBeenCalledTimes(1);
    const [url, , opts] = state.downloadAsync.mock.calls[0];
    expect(url).toBe(FIRST_PARTY_GET);
    expect(opts.headers).toEqual({ Authorization: `Bearer ${state.token}` });
  });

  it("a relative first-party URL resolves against the configured API origin only", async () => {
    await downloadPrivateFile(`/api/files/${ID}`, "file:///cache/x");
    expect(state.downloadAsync.mock.calls[0][0]).toBe(FIRST_PARTY_GET);
    expect(state.downloadAsync.mock.calls[0][2].headers).toEqual({ Authorization: `Bearer ${state.token}` });
  });

  it("upload sends the bearer, the content type and the capability", async () => {
    await putPrivateUpload(FIRST_PARTY_PUT, CAPABILITY, "file:///doc.pdf", "application/pdf");
    expect(state.uploadAsync).toHaveBeenCalledTimes(1);
    const [url, fileUri, opts] = state.uploadAsync.mock.calls[0];
    expect(url).toBe(FIRST_PARTY_PUT);
    expect(fileUri).toBe("file:///doc.pdf");
    expect(opts.httpMethod).toBe("PUT");
    expect(opts.headers).toEqual({ Authorization: `Bearer ${state.token}`, "Content-Type": "application/pdf", "X-Storage-Capability": CAPABILITY });
  });

  it("upload without a capability fails before any network request", async () => {
    for (const missing of [undefined, null, ""] as const) {
      const err = await putPrivateUpload(FIRST_PARTY_PUT, missing as unknown as string, "file:///doc.pdf", "application/pdf").catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      noSecret(err);
    }
    expect(state.uploadAsync).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a first-party request without a session fails before any network request", async () => {
    state.token = null;
    const d = await downloadPrivateFile(FIRST_PARTY_GET, "file:///cache/x").catch((e) => e);
    const u = await putPrivateUpload(FIRST_PARTY_PUT, CAPABILITY, "file:///doc.pdf", "application/pdf").catch((e) => e);
    expect(d).toBeInstanceOf(Error);
    expect(u).toBeInstanceOf(Error);
    noSecret(d);
    noSecret(u);
    expect(state.downloadAsync).not.toHaveBeenCalled();
    expect(state.uploadAsync).not.toHaveBeenCalled();
  });

  it("query credentials on a first-party URL are refused", async () => {
    const err = await downloadPrivateFile(`${FIRST_PARTY_GET}?t=${CAPABILITY}`, "file:///cache/x").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    noSecret(err);
    expect(state.downloadAsync).not.toHaveBeenCalled();
  });
});

describe("pre-B25 signed Google Cloud Storage URLs (API rolled back to 5a072fd)", () => {
  it("download sends NO Lead Capture credential and preserves the signed query exactly", async () => {
    await downloadPrivateFile(SIGNED_GET, "file:///cache/x");
    expect(state.downloadAsync).toHaveBeenCalledTimes(1);
    const [url, , opts] = state.downloadAsync.mock.calls[0];
    expect(url).toBe(SIGNED_GET);
    expect(opts.headers).toEqual({});
    expect(JSON.stringify(opts.headers)).not.toContain("Bearer");
  });

  it("upload without an uploadToken (the pre-B25 response has none) sends Content-Type only — no bearer, no capability", async () => {
    await putPrivateUpload(SIGNED_PUT, undefined as unknown as string, "file:///doc.pdf", "application/pdf");
    expect(state.uploadAsync).toHaveBeenCalledTimes(1);
    const [url, , opts] = state.uploadAsync.mock.calls[0];
    expect(url).toBe(SIGNED_PUT);
    expect(opts.headers).toEqual({ "Content-Type": "application/pdf" });
  });

  it("a signed upload never forwards a capability even when one is present", async () => {
    await putPrivateUpload(SIGNED_PUT, CAPABILITY, "file:///doc.pdf", "application/pdf");
    expect(state.uploadAsync.mock.calls[0][2].headers).toEqual({ "Content-Type": "application/pdf" });
  });
});

describe("untrusted URLs are refused before any request", () => {
  const BAD = [
    `https://storage.googleapis.com.evil.example/b/o?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=${SIGNATURE}`,
    `https://storage-googleapis.com/b/o?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=${SIGNATURE}`,
    `https://evil.example/api/files/${ID}`,
    `http://admin.kaptnow.com/api/files/${ID}`,
    `http://storage.googleapis.com/b/o?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=${SIGNATURE}`,
    `//storage.googleapis.com/b/o?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=${SIGNATURE}`,
    `https://user:pw@storage.googleapis.com/b/o?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=${SIGNATURE}`,
    `https://storage.googleapis.com@evil.example/b/o?X-Goog-Signature=${SIGNATURE}`,
    `https://storage.googleapis.com%2eevil.example/b/o?X-Goog-Signature=${SIGNATURE}`,
    `https://xn--storage-googleapis-com.example/b/o?X-Goog-Signature=${SIGNATURE}`,
    `https://storage.googleapis.com/b/o`,
    `${ORIGIN}/api/documents/${ID}`,
    `${ORIGIN}/api/files/../files/${ID}`,
    `javascript:alert(1)`,
    `data:text/plain,hello`,
    `file:///etc/passwd`,
    `not a url`,
    "",
  ];
  it("download / fetch / upload all refuse every untrusted URL", async () => {
    for (const bad of BAD) {
      const d = await downloadPrivateFile(bad, "file:///cache/x").catch((e) => e);
      const f = await fetchPrivateBlob(bad).catch((e) => e);
      const u = await putPrivateUpload(bad, CAPABILITY, "file:///doc.pdf", "application/pdf").catch((e) => e);
      for (const err of [d, f, u]) {
        expect(err, `accepted: ${bad}`).toBeInstanceOf(Error);
        noSecret(err);
        if (bad.trim() !== "") expect((err as Error).message).not.toContain(bad.slice(0, 24));
      }
    }
    expect(state.downloadAsync).not.toHaveBeenCalled();
    expect(state.uploadAsync).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("web branch", () => {
  beforeEach(() => {
    state.OS = "web";
  });
  it("fetchPrivateBlob sends the bearer to first-party URLs and nothing to signed GCS URLs", async () => {
    await fetchPrivateBlob(FIRST_PARTY_GET);
    expect(fetchMock.mock.calls[0][0]).toBe(FIRST_PARTY_GET);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Authorization: `Bearer ${state.token}` });
    await fetchPrivateBlob(SIGNED_GET);
    expect(fetchMock.mock.calls[1][0]).toBe(SIGNED_GET);
    expect(fetchMock.mock.calls[1][1].headers).toEqual({});
  });
  it("putPrivateUpload (web) sends bearer + capability to first-party and Content-Type only to signed GCS", async () => {
    await putPrivateUpload(FIRST_PARTY_PUT, CAPABILITY, "blob:local", "application/pdf");
    const firstPartyPut = fetchMock.mock.calls.find((c) => c[0] === FIRST_PARTY_PUT)!;
    expect(firstPartyPut[1].method).toBe("PUT");
    expect(firstPartyPut[1].headers).toEqual({ Authorization: `Bearer ${state.token}`, "Content-Type": "application/pdf", "X-Storage-Capability": CAPABILITY });
    fetchMock.mockClear();
    await putPrivateUpload(SIGNED_PUT, undefined as unknown as string, "blob:local", "application/pdf");
    const signedPut = fetchMock.mock.calls.find((c) => c[0] === SIGNED_PUT)!;
    expect(signedPut[1].headers).toEqual({ "Content-Type": "application/pdf" });
  });
  it("web refuses untrusted URLs before fetching", async () => {
    const err = await fetchPrivateBlob(`https://evil.example/api/files/${ID}`).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
