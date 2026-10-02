/**
 * B25 Correction 6 — ONE trusted-URL classifier for every private-file request
 * the mobile app makes, so the client is safe across the B25 transition:
 *
 *   first_party        the B25 API (`/api/files/<id>` download, `/api/files/uploads/<id>`
 *                      upload) on the EXACT configured API origin — session bearer required,
 *                      upload capability required, no query, no hash, no userinfo;
 *   legacy_signed_gcs  a V4-signed Google Cloud Storage URL as minted by the pre-B25 API
 *                      (an emergency API rollback to 5a072fd returns these and no
 *                      uploadToken): HTTPS, the exact host `storage.googleapis.com`,
 *                      path-style bucket/object, signature query present — NO Lead Capture
 *                      credential and NO capability header may ever travel with it;
 *   rejected           everything else, refused BEFORE any network request.
 *
 * Pure module (no React Native / Expo imports) so it is exhaustively unit-tested.
 * Errors carry fixed messages only — never the URL, a token, a capability or a
 * signed query value.
 */

export const CAPABILITY_HEADER = "X-Storage-Capability";
/** The only host the pre-B25 API ever signed URLs for (path-style `https://storage.googleapis.com/<bucket>/<object>`). */
export const LEGACY_SIGNED_GCS_HOST = "storage.googleapis.com";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const DOWNLOAD_PATH = new RegExp(`^/api/files/${UUID}$`);
const UPLOAD_PATH = new RegExp(`^/api/files/uploads/${UUID}$`);
const LEGACY_PREFIX = `https://${LEGACY_SIGNED_GCS_HOST}/`;

export type FileRoute = "download" | "upload";
export type RejectReason = "empty" | "not_string" | "protocol_relative" | "malformed" | "scheme" | "userinfo" | "origin" | "path" | "query" | "hash" | "host" | "unsigned";
export type ClassifiedFileUrl =
  | { kind: "first_party"; url: string; route: FileRoute }
  | { kind: "legacy_signed_gcs"; url: string }
  | { kind: "rejected"; reason: RejectReason };

export type FileUrlErrorCode = "untrusted_url" | "session_required" | "capability_required" | "route_mismatch";
const MESSAGES: Record<FileUrlErrorCode, string> = {
  untrusted_url: "Private file request refused: the file URL is not trusted.",
  session_required: "Private file request refused: no active session.",
  capability_required: "Private file request refused: the upload authorization is missing.",
  route_mismatch: "Private file request refused: the file URL does not match the operation.",
};

export class FileUrlError extends Error {
  readonly code: FileUrlErrorCode;
  constructor(code: FileUrlErrorCode) {
    super(MESSAGES[code]);
    this.name = "FileUrlError";
    this.code = code;
  }
}

function parseOrigin(apiOrigin: string | null | undefined): URL | null {
  if (typeof apiOrigin !== "string" || apiOrigin.trim() === "") return null;
  try {
    const u = new URL(apiOrigin.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null;
    return u;
  } catch {
    return null;
  }
}

function classifyFirstParty(raw: string, url: URL, origin: URL): ClassifiedFileUrl {
  if (url.protocol !== origin.protocol) return { kind: "rejected", reason: "scheme" };
  if (url.username || url.password) return { kind: "rejected", reason: "userinfo" };
  if (url.origin !== origin.origin) return { kind: "rejected", reason: "origin" };
  if (url.search !== "") return { kind: "rejected", reason: "query" };
  if (url.hash !== "") return { kind: "rejected", reason: "hash" };
  // The parser must not have normalized anything away (dot segments, encoded
  // dots, case): the raw path has to be exactly the path that will be requested.
  if (raw !== url.pathname && raw !== `${url.origin}${url.pathname}`) return { kind: "rejected", reason: "path" };
  if (DOWNLOAD_PATH.test(url.pathname)) return { kind: "first_party", url: `${url.origin}${url.pathname}`, route: "download" };
  if (UPLOAD_PATH.test(url.pathname)) return { kind: "first_party", url: `${url.origin}${url.pathname}`, route: "upload" };
  return { kind: "rejected", reason: "path" };
}

function classifyLegacySignedGcs(raw: string, url: URL): ClassifiedFileUrl {
  // Exact, case-sensitive prefix on the RAW string (no percent-encoded or
  // userinfo tricks can reach the parser's view) plus the parsed view.
  if (!raw.startsWith(LEGACY_PREFIX)) return { kind: "rejected", reason: "host" };
  if (url.protocol !== "https:") return { kind: "rejected", reason: "scheme" };
  if (url.username || url.password) return { kind: "rejected", reason: "userinfo" };
  if (url.hostname !== LEGACY_SIGNED_GCS_HOST || url.port !== "") return { kind: "rejected", reason: "host" };
  if (url.hash !== "") return { kind: "rejected", reason: "hash" };
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return { kind: "rejected", reason: "path" };
  const q = url.searchParams;
  if (!q.get("X-Goog-Signature") || !q.get("X-Goog-Algorithm")) return { kind: "rejected", reason: "unsigned" };
  return { kind: "legacy_signed_gcs", url: raw };
}

/**
 * Classify a private-file URL returned by the API. `apiOrigin` is the
 * configured mobile API origin (the generated client's base URL); a relative
 * B25 path is resolved against it and nothing else.
 */
export function classifyFileUrl(raw: unknown, apiOrigin: string | null | undefined): ClassifiedFileUrl {
  if (typeof raw !== "string") return { kind: "rejected", reason: "not_string" };
  const value = raw.trim();
  if (value === "") return { kind: "rejected", reason: "empty" };
  if (value.startsWith("//")) return { kind: "rejected", reason: "protocol_relative" };
  if (/[\s\u0000-\u001f]/.test(value)) return { kind: "rejected", reason: "malformed" };
  const origin = parseOrigin(apiOrigin);

  if (value.startsWith("/")) {
    if (!origin) return { kind: "rejected", reason: "origin" };
    let url: URL;
    try {
      url = new URL(value, origin.origin);
    } catch {
      return { kind: "rejected", reason: "malformed" };
    }
    return classifyFirstParty(value, url, origin);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: "rejected", reason: "malformed" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { kind: "rejected", reason: "scheme" };
  if (origin && url.hostname === origin.hostname) return classifyFirstParty(value, url, origin);
  if (url.hostname === LEGACY_SIGNED_GCS_HOST && url.protocol === "https:") return classifyLegacySignedGcs(value, url);
  return { kind: "rejected", reason: "origin" };
}

export interface FileRequestCredentials {
  /** The cached Lead Capture session token (null / empty when signed out). */
  sessionToken: string | null | undefined;
  /** The header-bound upload capability returned by the B25 API (absent from a pre-B25 response). */
  uploadToken?: string | null;
  /** Content type for uploads. */
  contentType?: string;
}

/**
 * Headers for a classified URL. First party: bearer (+ capability and content
 * type for uploads). Legacy signed GCS: content type only for uploads, nothing
 * for downloads — the Lead Capture session and capability NEVER leave the API
 * origin. Rejected: throws before any request.
 */
export function fileRequestHeaders(classified: ClassifiedFileUrl, op: "get" | "put", creds: FileRequestCredentials): Record<string, string> {
  if (classified.kind === "rejected") throw new FileUrlError("untrusted_url");
  const contentType = creds.contentType && creds.contentType.trim() !== "" ? creds.contentType : "application/octet-stream";
  if (classified.kind === "legacy_signed_gcs") {
    return op === "put" ? { "Content-Type": contentType } : {};
  }
  if ((op === "put") !== (classified.route === "upload")) throw new FileUrlError("route_mismatch");
  const session = typeof creds.sessionToken === "string" ? creds.sessionToken.trim() : "";
  if (session === "") throw new FileUrlError("session_required");
  if (op === "get") return { Authorization: `Bearer ${session}` };
  const capability = typeof creds.uploadToken === "string" ? creds.uploadToken.trim() : "";
  if (capability === "") throw new FileUrlError("capability_required");
  return { Authorization: `Bearer ${session}`, "Content-Type": contentType, [CAPABILITY_HEADER]: capability };
}
