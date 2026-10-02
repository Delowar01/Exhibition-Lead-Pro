// =============================================================================
// Batch 25 — product-file byte routes.
//
//   PUT /files/uploads/:id?t=<capability>   client upload to a RESERVED object
//   GET /files/:id?t=<capability>           bounded streaming download (HEAD ok)
//
// Mounted in app.ts BEFORE the JSON/urlencoded body parsers so an upload body
// streams straight into the storage boundary and is never buffered. The
// capability token (minted by the feature route AFTER the normal auth, tenant
// and permission checks) is the only credential: it is bound to one object id,
// one tenant and one operation, and it expires. The route re-checks the object
// against the inventory on every request (tenant match + state), so a token
// for a deleted object or another tenant's object answers 403/404 — never a
// file. Nothing here reveals storage keys, filesystem paths, bucket names or
// hosts; the query string (token) is stripped from request logs by app.ts.
// =============================================================================
import { Router, type IRouter, type Request, type Response } from "express";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "../config.js";
import { AppError } from "../middlewares/errorHandler.js";
import { verifyCapability } from "../storage/capability.js";
import * as storage from "../services/storage.service.js";

const router: IRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTENT_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
const INLINE_SAFE_TYPES = storage.INLINE_SAFE_TYPES;

function tokenOf(req: Request): string | undefined {
  const t = req.query.t;
  return typeof t === "string" ? t : undefined;
}

function invalidUpload(): AppError {
  return new AppError(403, "Upload link is invalid or expired", { code: "STORAGE_UPLOAD_INVALID" });
}

function invalidDownload(): AppError {
  return new AppError(403, "Download link is invalid or expired", { code: "STORAGE_DOWNLOAD_INVALID" });
}

// ── upload ──────────────────────────────────────────────────────────────────
router.put("/files/uploads/:id", async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const payload = verifyCapability(tokenOf(req), "put");
  if (!payload || !UUID.test(id) || payload.o !== id) {
    req.resume(); // drain so the 403 can be delivered on a kept-alive socket
    throw invalidUpload();
  }
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
    const result = await storage.receiveUpload(payload, body, declaredBytes);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ sizeBytes: result.sizeBytes, sha256: result.sha256 });
  } catch (err) {
    req.unpipe(body);
    req.resume();
    throw err;
  }
});

// ── download ────────────────────────────────────────────────────────────────
router.get("/files/:id", async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const payload = verifyCapability(tokenOf(req), "get");
  if (!payload || !UUID.test(id) || payload.o !== id) throw invalidDownload();

  const row = await storage.loadForDownload(payload);
  if (!row) throw new AppError(404, "File not found");

  let opened: storage.OpenedObject;
  try {
    opened = await storage.openObject(row);
  } catch (err) {
    throw storage.toAppError(err);
  }

  const contentType = CONTENT_TYPE.test(opened.contentType) ? opened.contentType : "application/octet-stream";
  const inline = payload.d === "inline" && INLINE_SAFE_TYPES.has(contentType.toLowerCase());
  res.status(200);
  res.setHeader("Content-Type", contentType);
  if (opened.sizeBytes != null) res.setHeader("Content-Length", String(opened.sizeBytes));
  res.setHeader("Content-Disposition", storage.contentDisposition(inline ? "inline" : "attachment", payload.fn ?? "download"));
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
