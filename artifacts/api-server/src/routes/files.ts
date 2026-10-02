// =============================================================================
// Batch 25 — product-file byte routes (B25 Correction 1: authenticated).
//
//   PUT /files/uploads/:id   client upload to a RESERVED object
//   GET /files/:id           bounded streaming download (HEAD ok)
//
// Mounted in app.ts BEFORE the JSON/urlencoded body parsers so an upload body
// streams straight into the storage boundary and is never buffered. Every
// request goes through the NORMAL application authentication (bearer token +
// live server-side session) and the platform-owner firewall, then the object
// manager re-checks, at byte time: the current active user, tenant access to
// the object's company, the operation, object ownership/state and the feature
// permission for the object kind. A logged-out or disabled user, a revoked
// permission or a lost tenant membership is refused on the very next request.
//
// Uploads additionally present the header-bound capability minted when the
// upload was reserved (X-Storage-Capability: bound to user + tenant + object +
// PUT, short-lived). Credentials NEVER travel in the URL: a legacy `?t=` query
// credential is rejected outright, the request serializer logs the path only
// and the header is never logged. Byte responses carry
// Referrer-Policy: no-referrer, Cache-Control: private, no-store, no-transform
// and X-Content-Type-Options: nosniff. Nothing here reveals storage keys,
// filesystem paths, bucket names or hosts.
//
// The intentionally PUBLIC routes (managed branding logo by its random id and
// the published-card logo) live in routes/branding.ts and routes/cards.ts and
// expose only their constrained projections — never this byte route.
// =============================================================================
import { Router, type IRouter, type Request, type Response } from "express";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "../config.js";
import { AppError } from "../middlewares/errorHandler.js";
import { requireAuth, requireTenantUser, type AuthRequest } from "../middlewares/requireAuth.js";
import * as storage from "../services/storage.service.js";
import type { StorageKind } from "../storage/keys.js";

const router: IRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTENT_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
const INLINE_SAFE_TYPES = storage.INLINE_SAFE_TYPES;

/** A credential in the query string is never accepted (it would reach proxy logs, history and referrers). */
function rejectQueryCredentials(req: Request, res: Response, next: () => void): void {
  if (req.query.t !== undefined || req.query.token !== undefined || req.query.capability !== undefined) {
    req.resume();
    res.status(403).json({ error: "Credentials are not accepted in the URL", code: "STORAGE_QUERY_CREDENTIAL_REJECTED" });
    return;
  }
  next();
}

function noReferrer(res: Response): void {
  res.setHeader("Referrer-Policy", "no-referrer");
}

router.use("/files", rejectQueryCredentials, requireAuth, requireTenantUser);

// ── upload ──────────────────────────────────────────────────────────────────
router.put("/files/uploads/:id", async (req: AuthRequest, res: Response) => {
  const id = String(req.params.id);
  noReferrer(res);
  if (!UUID.test(id)) {
    req.resume();
    throw new AppError(404, "File not found");
  }
  const capabilityHeader = req.headers[storage.CAPABILITY_HEADER];
  const capability = Array.isArray(capabilityHeader) ? capabilityHeader[0] : capabilityHeader;
  const declared = req.headers["content-length"];
  const declaredBytes = declared !== undefined ? Number(declared) : undefined;
  // Non-production hook for the storage-failure rollback tests (same pattern as
  // the branding suite): the next primary write fails after the row was reserved.
  if (!config.isProduction && req.headers["x-storage-test-fail"] === "1") storage.armPrimaryFailureForTests();

  // Decouple the request socket from the storage pipeline: a failed write
  // (size cap, storage outage) destroys the PassThrough, not the socket, so
  // the client still receives the JSON error instead of a connection reset.
  const body = new PassThrough();
  req.pipe(body);
  req.once("error", (err) => body.destroy(err));
  res.once("close", () => {
    if (!res.writableEnded) body.destroy(new Error("client disconnected during upload"));
  });

  try {
    const result = await storage.receiveUpload(req.user!, id, capability, body, declaredBytes);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ sizeBytes: result.sizeBytes, sha256: result.sha256 });
  } catch (err) {
    req.unpipe(body);
    req.resume();
    throw err;
  }
});

// ── download ────────────────────────────────────────────────────────────────
router.get("/files/:id", async (req: AuthRequest, res: Response) => {
  const id = String(req.params.id);
  noReferrer(res);
  const user = req.user!;
  const row = await storage.authorizeObject(user, id, "get");
  if (!row) throw new AppError(404, "File not found");
  if (!storage.userHasPermission(user, storage.permissionForKind(row.kind as StorageKind, "get"))) {
    throw new AppError(403, "Missing permission for this file");
  }

  let opened: storage.OpenedObject;
  try {
    opened = await storage.openObject(row);
  } catch (err) {
    throw storage.toAppError(err);
  }

  const contentType = CONTENT_TYPE.test(opened.contentType) ? opened.contentType : "application/octet-stream";
  const inline = INLINE_SAFE_TYPES.has(contentType.toLowerCase());
  const fileName = await storage.displayFileName(row);
  res.status(200);
  res.setHeader("Content-Type", contentType);
  if (opened.sizeBytes != null) res.setHeader("Content-Length", String(opened.sizeBytes));
  res.setHeader("Content-Disposition", storage.contentDisposition(inline ? "inline" : "attachment", fileName));
  // no-transform keeps intermediaries (and the response compressor) from
  // re-encoding the bytes, so Content-Length stays exact for every file type.
  res.setHeader("Cache-Control", "private, no-store, no-transform");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method === "HEAD") {
    opened.stream.destroy();
    res.end();
    return;
  }

  try {
    await pipeline(opened.stream, res);
  } catch (err) {
    // Headers are already on the wire: the only honest signal for a mid-stream
    // integrity/auth failure is a truncated transfer, never a silently short file.
    if (!res.headersSent) throw storage.toAppError(err);
    res.destroy();
  }
});

export default router;
