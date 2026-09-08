// =============================================================================
// Batch 18 — managed logo validation. Decisions are made from the ACTUAL bytes
// (magic numbers + a real decode through sharp), never from the declared
// content type alone. Output is a normalized, metadata-stripped, size-bounded
// PNG (transparency preserved) or JPEG that is what gets stored.
// =============================================================================
import sharp, { type Metadata, type OutputInfo } from "sharp";
import { AppError } from "../../middlewares/errorHandler.js";
import { config } from "../../config.js";

export const LOGO_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type LogoMime = (typeof LOGO_MIME_TYPES)[number];
export const LOGO_MIN_DIMENSION = 32;
export const LOGO_MAX_DIMENSION = 4096;
/** Decoded-pixel ceiling handed to sharp so a tiny "bomb" file can never inflate. */
export const LOGO_MAX_PIXELS = LOGO_MAX_DIMENSION * LOGO_MAX_DIMENSION;
/** Stored logos are downscaled to fit this box (keeps storage + page weight small). */
export const LOGO_STORED_MAX_EDGE = 1024;

const SNIFFERS: Array<{ mime: LogoMime; test: (b: Buffer) => boolean }> = [
  { mime: "image/png", test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  { mime: "image/jpeg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/webp", test: (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
];

function fail(code: string, message: string): never {
  throw new AppError(400, message, { code });
}

export interface ValidatedLogo {
  buffer: Buffer;
  contentType: "image/png" | "image/jpeg";
  extension: "png" | "jpg";
  width: number;
  height: number;
  sourceMime: LogoMime;
  sourceBytes: number;
  sourceWidth: number;
  sourceHeight: number;
}

/**
 * Validate and normalize an uploaded logo.
 *   BRANDING_LOGO_EMPTY | BRANDING_LOGO_TOO_LARGE | BRANDING_LOGO_UNSUPPORTED |
 *   BRANDING_LOGO_INVALID | BRANDING_LOGO_DIMENSIONS
 */
export async function validateLogoUpload(bytes: Buffer | undefined | null, declaredType: string | undefined): Promise<ValidatedLogo> {
  const declared = (declaredType ?? "").split(";")[0].trim().toLowerCase();
  if (declared && !(LOGO_MIME_TYPES as readonly string[]).includes(declared)) {
    fail("BRANDING_LOGO_UNSUPPORTED", "Unsupported file type. Upload a PNG, JPEG or WebP logo.");
  }
  if (!bytes || !Buffer.isBuffer(bytes) || bytes.length === 0) {
    fail("BRANDING_LOGO_EMPTY", "No logo file was received.");
  }
  if (bytes.length > config.branding.maxLogoBytes) {
    fail("BRANDING_LOGO_TOO_LARGE", `The logo must be ${Math.round(config.branding.maxLogoBytes / (1024 * 1024))} MB or smaller.`);
  }
  if (bytes.length < 24) fail("BRANDING_LOGO_INVALID", "The file is not a readable image.");
  const sniffed = SNIFFERS.find((s) => s.test(bytes));
  if (!sniffed) {
    fail("BRANDING_LOGO_UNSUPPORTED", "Unsupported or unreadable file type. Upload a PNG, JPEG or WebP logo.");
  }
  if (declared && declared !== sniffed.mime) {
    fail("BRANDING_LOGO_UNSUPPORTED", `The file content is ${sniffed.mime}, not ${declared}. Upload the original image file.`);
  }

  let meta: Metadata;
  try {
    meta = await sharp(bytes, { limitInputPixels: LOGO_MAX_PIXELS, failOn: "error", animated: false }).metadata();
  } catch {
    fail("BRANDING_LOGO_INVALID", "The image could not be decoded. Upload a valid PNG, JPEG or WebP file.");
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) fail("BRANDING_LOGO_INVALID", "The image has no readable dimensions.");
  if ((meta.pages ?? 1) > 1) fail("BRANDING_LOGO_UNSUPPORTED", "Animated images are not supported for logos.");
  if (width < LOGO_MIN_DIMENSION || height < LOGO_MIN_DIMENSION) {
    fail("BRANDING_LOGO_DIMENSIONS", `The logo must be at least ${LOGO_MIN_DIMENSION}×${LOGO_MIN_DIMENSION} pixels (got ${width}×${height}).`);
  }
  if (width > LOGO_MAX_DIMENSION || height > LOGO_MAX_DIMENSION) {
    fail("BRANDING_LOGO_DIMENSIONS", `The logo must be at most ${LOGO_MAX_DIMENSION}×${LOGO_MAX_DIMENSION} pixels (got ${width}×${height}).`);
  }

  // Normalize: apply EXIF orientation, strip metadata, fit into the stored box.
  // PNG/WebP keep their alpha channel (PNG output); JPEG stays JPEG.
  const keepAlpha = sniffed.mime !== "image/jpeg";
  let out: { data: Buffer; info: OutputInfo };
  try {
    const pipeline = sharp(bytes, { limitInputPixels: LOGO_MAX_PIXELS, failOn: "error", animated: false })
      .rotate()
      .resize({ width: LOGO_STORED_MAX_EDGE, height: LOGO_STORED_MAX_EDGE, fit: "inside", withoutEnlargement: true });
    out = keepAlpha
      ? await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer({ resolveWithObject: true })
      : await pipeline.jpeg({ quality: 88, progressive: true, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  } catch {
    fail("BRANDING_LOGO_INVALID", "The image could not be processed. Upload a valid PNG, JPEG or WebP file.");
  }
  if (out.data.length > config.branding.maxLogoBytes) {
    fail("BRANDING_LOGO_TOO_LARGE", "The logo is too complex to store within the size limit. Use a simpler or smaller image.");
  }
  return {
    buffer: out.data,
    contentType: keepAlpha ? "image/png" : "image/jpeg",
    extension: keepAlpha ? "png" : "jpg",
    width: out.info.width,
    height: out.info.height,
    sourceMime: sniffed.mime,
    sourceBytes: bytes.length,
    sourceWidth: width,
    sourceHeight: height,
  };
}
