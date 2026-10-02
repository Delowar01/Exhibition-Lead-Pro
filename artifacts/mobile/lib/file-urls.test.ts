// B25 Correction 6 — exhaustive tests of the shared private-file URL
// classifier and header builder used by every mobile file helper (native and
// web branches build their requests from exactly these two functions).
import { describe, expect, it } from "vitest";

import { CAPABILITY_HEADER, FileUrlError, classifyFileUrl, fileRequestHeaders } from "./file-urls";

const ORIGIN = "https://admin.kaptnow.com";
const ID = "0b7c2f2e-1d7a-4c0e-9a7b-3c3d1a2b4c5d";
const SIG = "X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=svc%40p.iam.gserviceaccount.com%2F20261002%2Fauto%2Fstorage%2Fgoog4_request&X-Goog-Date=20261002T000000Z&X-Goog-Expires=900&X-Goog-SignedHeaders=host&X-Goog-Signature=abcdef0123456789";
const SIGNED = `https://storage.googleapis.com/some-bucket/.private/uploads/${ID}?${SIG}`;

describe("classifyFileUrl — first party", () => {
  it("accepts the exact configured origin with the B25 download and upload routes", () => {
    expect(classifyFileUrl(`${ORIGIN}/api/files/${ID}`, ORIGIN)).toEqual({ kind: "first_party", url: `${ORIGIN}/api/files/${ID}`, route: "download" });
    expect(classifyFileUrl(`${ORIGIN}/api/files/uploads/${ID}`, ORIGIN)).toEqual({ kind: "first_party", url: `${ORIGIN}/api/files/uploads/${ID}`, route: "upload" });
  });
  it("resolves a relative B25 path against the configured origin only", () => {
    expect(classifyFileUrl(`/api/files/${ID}`, ORIGIN)).toEqual({ kind: "first_party", url: `${ORIGIN}/api/files/${ID}`, route: "download" });
    expect(classifyFileUrl(`/api/files/${ID}`, `${ORIGIN}/`)).toMatchObject({ kind: "first_party", url: `${ORIGIN}/api/files/${ID}` });
    expect(classifyFileUrl(`/api/files/${ID}`, null)).toMatchObject({ kind: "rejected" });
    expect(classifyFileUrl(`/api/files/${ID}`, "")).toMatchObject({ kind: "rejected" });
  });
  it("tolerates a trailing slash in the configured origin and a non-default port only when configured", () => {
    expect(classifyFileUrl(`${ORIGIN}/api/files/${ID}`, `${ORIGIN}/`)).toMatchObject({ kind: "first_party" });
    expect(classifyFileUrl(`https://admin.kaptnow.com:8443/api/files/${ID}`, ORIGIN)).toMatchObject({ kind: "rejected", reason: "origin" });
    expect(classifyFileUrl(`https://admin.kaptnow.com:8443/api/files/${ID}`, "https://admin.kaptnow.com:8443")).toMatchObject({ kind: "first_party" });
  });
  it("allows an http origin only when the configured origin itself is http (local development)", () => {
    expect(classifyFileUrl(`http://localhost/api/files/${ID}`, "http://localhost")).toMatchObject({ kind: "first_party" });
    expect(classifyFileUrl(`http://admin.kaptnow.com/api/files/${ID}`, ORIGIN)).toMatchObject({ kind: "rejected" });
  });
  it("rejects first-party paths outside the private-file routes, with a query, hash, userinfo or traversal", () => {
    for (const bad of [
      `${ORIGIN}/api/documents/${ID}`,
      `${ORIGIN}/api/files/`,
      `${ORIGIN}/api/files/not-a-uuid`,
      `${ORIGIN}/api/files/${ID}/extra`,
      `${ORIGIN}/api/files/${ID}?t=token`,
      `${ORIGIN}/api/files/${ID}#frag`,
      `${ORIGIN}/api/files/uploads/${ID}?token=x`,
      `https://user:pw@admin.kaptnow.com/api/files/${ID}`,
      `${ORIGIN}/api/files/../files/${ID}`,
      `${ORIGIN}/API/files/${ID}`,
    ]) {
      expect(classifyFileUrl(bad, ORIGIN), bad).toMatchObject({ kind: "rejected" });
    }
  });
});

describe("classifyFileUrl — legacy signed Google Cloud Storage", () => {
  it("accepts an HTTPS path-style storage.googleapis.com URL with a V4 signature", () => {
    expect(classifyFileUrl(SIGNED, ORIGIN)).toEqual({ kind: "legacy_signed_gcs", url: SIGNED });
  });
  it("preserves the signed query byte for byte", () => {
    const c = classifyFileUrl(SIGNED, ORIGIN);
    expect(c.kind === "legacy_signed_gcs" && c.url).toBe(SIGNED);
  });
  it("rejects every host that is not exactly storage.googleapis.com", () => {
    for (const host of [
      "storage.googleapis.com.evil.example",
      "evil.storage.googleapis.com",
      "storage-googleapis.com",
      "storage.googleapis.co",
      "storage.googleapis.com:8443",
      "xn--storage-googleapis-com.example",
      "storage.googleapis.com%2eevil.example",
      "some-bucket.storage.googleapis.com",
      "googleapis.com",
    ]) {
      expect(classifyFileUrl(`https://${host}/b/o?${SIG}`, ORIGIN), host).toMatchObject({ kind: "rejected" });
    }
  });
  it("rejects unsigned, http, userinfo, protocol-relative and bucket-less forms", () => {
    for (const bad of [
      `https://storage.googleapis.com/b/o`,
      `https://storage.googleapis.com/b/o?X-Goog-Algorithm=GOOG4-RSA-SHA256`,
      `https://storage.googleapis.com/b/o?X-Goog-Signature=abc`,
      `http://storage.googleapis.com/b/o?${SIG}`,
      `https://user:pw@storage.googleapis.com/b/o?${SIG}`,
      `https://storage.googleapis.com@evil.example/b/o?${SIG}`,
      `//storage.googleapis.com/b/o?${SIG}`,
      `https://storage.googleapis.com/?${SIG}`,
      `https://storage.googleapis.com/onlybucket?${SIG}`,
      `https://storage.googleapis.com/b/o?${SIG}#frag`,
    ]) {
      expect(classifyFileUrl(bad, ORIGIN), bad).toMatchObject({ kind: "rejected" });
    }
  });
});

describe("classifyFileUrl — everything else", () => {
  it("rejects other origins, schemes, malformed and non-string values without echoing them", () => {
    for (const bad of [
      `https://evil.example/api/files/${ID}`,
      `https://admin.kaptnow.com.evil.example/api/files/${ID}`,
      `javascript:alert(1)`,
      `data:text/plain,hello`,
      `file:///etc/passwd`,
      `ftp://storage.googleapis.com/b/o`,
      `not a url`,
      `//admin.kaptnow.com/api/files/${ID}`,
      "",
      "   ",
    ]) {
      const c = classifyFileUrl(bad, ORIGIN);
      expect(c.kind, bad).toBe("rejected");
      expect(JSON.stringify(c)).not.toContain(bad.trim().slice(0, 12) || "x");
    }
    for (const notString of [undefined, null, 42, {}, [], true]) {
      expect(classifyFileUrl(notString, ORIGIN)).toMatchObject({ kind: "rejected" });
    }
  });
});

describe("fileRequestHeaders", () => {
  const fp = classifyFileUrl(`${ORIGIN}/api/files/uploads/${ID}`, ORIGIN);
  const fpGet = classifyFileUrl(`${ORIGIN}/api/files/${ID}`, ORIGIN);
  const legacy = classifyFileUrl(SIGNED, ORIGIN);
  const rejected = classifyFileUrl("https://evil.example/x", ORIGIN);
  const creds = { sessionToken: "sess-SECRET", uploadToken: "cap-SECRET", contentType: "application/pdf" };

  it("first party GET: bearer only; PUT: bearer + content type + capability", () => {
    expect(fileRequestHeaders(fpGet, "get", creds)).toEqual({ Authorization: "Bearer sess-SECRET" });
    expect(fileRequestHeaders(fp, "put", creds)).toEqual({ Authorization: "Bearer sess-SECRET", "Content-Type": "application/pdf", [CAPABILITY_HEADER]: "cap-SECRET" });
  });
  it("legacy signed GCS GET: no headers; PUT: content type only (never a Lead Capture credential or capability)", () => {
    expect(fileRequestHeaders(legacy, "get", creds)).toEqual({});
    expect(fileRequestHeaders(legacy, "put", creds)).toEqual({ "Content-Type": "application/pdf" });
  });
  it("first party without a session or without a capability throws a fixed error before any request", () => {
    for (const bad of [{ ...creds, sessionToken: null }, { ...creds, sessionToken: "" }, { ...creds, sessionToken: undefined }]) {
      const err = (() => { try { fileRequestHeaders(fpGet, "get", bad); return null; } catch (e) { return e; } })();
      expect(err).toBeInstanceOf(FileUrlError);
      expect((err as FileUrlError).code).toBe("session_required");
    }
    for (const bad of [{ ...creds, uploadToken: null }, { ...creds, uploadToken: "" }, { ...creds, uploadToken: undefined }]) {
      const err = (() => { try { fileRequestHeaders(fp, "put", bad); return null; } catch (e) { return e; } })();
      expect(err).toBeInstanceOf(FileUrlError);
      expect((err as FileUrlError).code).toBe("capability_required");
    }
  });
  it("a download route is never used for an upload and vice versa", () => {
    expect(() => fileRequestHeaders(fpGet, "put", creds)).toThrow(FileUrlError);
    expect(() => fileRequestHeaders(fp, "get", creds)).toThrow(FileUrlError);
  });
  it("a rejected URL throws a fixed message that carries no URL, token, capability or signature", () => {
    const err = (() => { try { fileRequestHeaders(rejected, "get", creds); return null; } catch (e) { return e; } })() as FileUrlError;
    expect(err).toBeInstanceOf(FileUrlError);
    expect(err.code).toBe("untrusted_url");
    const text = JSON.stringify({ ...err, message: err.message, stack: err.stack });
    for (const s of ["evil.example", "sess-SECRET", "cap-SECRET", "X-Goog-Signature"]) expect(text).not.toContain(s);
  });
});
