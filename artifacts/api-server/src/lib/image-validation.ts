import { AppError } from "../middlewares/errorHandler.js";

// Batch 7 — pre-provider scan-image validation. Every uploaded card image is
// validated HERE, before a scan row is created and before any Gemini call, so
// bad input is a 400 client error (with a machine code) and never records
// provider token usage. Validation is based on the ACTUAL file bytes (magic
// numbers), not the caller-declared data-URL MIME, so disguised payloads
// (e.g. "data:image/jpeg" wrapping an SVG or executable) are rejected.

/** Max DECODED image size accepted for OCR (bytes). The JSON body limit (15mb)
 * bounds the transport; this bounds the decoded payload sent to the provider. */
export const MAX_SCAN_IMAGE_BYTES = 10 * 1024 * 1024;

/** Formats Gemini Vision accepts and we allow. SVG and any non-raster/executable
 * content are rejected by design (never reaches the provider or storage). */
const SNIFFERS: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
  { mime: "image/jpeg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  {
    mime: "image/webp",
    test: (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP",
  },
  {
    mime: "image/heic",
    test: (b) => {
      if (b.length < 12 || b.toString("ascii", 4, 8) !== "ftyp") return false;
      const brand = b.toString("ascii", 8, 12);
      return ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "heif"].includes(brand);
    },
  },
];

export interface ValidatedScanImage {
  /** Base64 payload WITHOUT a data-URL prefix. */
  data: string;
  /** MIME type sniffed from the actual bytes (authoritative, not caller-declared). */
  mimeType: string;
  bytes: number;
  /** Data-URL with the SNIFFED MIME — what should be sent to the provider. */
  dataUrl: string;
}

function fail(code: string, message: string): never {
  throw new AppError(400, message, { code });
}

/**
 * Validate a scan image payload (data-URL or raw base64) from real file bytes.
 * Throws AppError(400) with a machine code on any problem:
 *   SCAN_IMAGE_EMPTY | SCAN_IMAGE_INVALID | SCAN_IMAGE_UNSUPPORTED | SCAN_IMAGE_TOO_LARGE
 */
export function validateScanImage(imageData: string | undefined | null): ValidatedScanImage {
  if (typeof imageData !== "string" || imageData.trim().length === 0) {
    fail("SCAN_IMAGE_EMPTY", "No image was provided. Capture or upload a card photo.");
  }
  const trimmed = imageData.trim();
  let base64 = trimmed;
  if (trimmed.startsWith("data:")) {
    const match = /^data:(.+?);base64,(.*)$/s.exec(trimmed);
    if (!match) fail("SCAN_IMAGE_INVALID", "The image payload is not a valid base64 data URL.");
    const declared = match[1].toLowerCase();
    // Non-image declarations (text/html, image/svg+xml is handled by sniffing anyway,
    // application/*) are rejected up front with an honest message.
    if (!declared.startsWith("image/") || declared.includes("svg")) {
      fail("SCAN_IMAGE_UNSUPPORTED", "Unsupported file type. Upload a JPEG, PNG, WebP, or HEIC photo.");
    }
    base64 = match[2];
  }
  if (base64.length === 0) {
    fail("SCAN_IMAGE_EMPTY", "The uploaded image file is empty. Capture or upload a card photo.");
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(base64, "base64");
  } catch {
    fail("SCAN_IMAGE_INVALID", "The image payload could not be decoded.");
  }
  if (buf.length === 0) {
    fail("SCAN_IMAGE_EMPTY", "The uploaded image file is empty. Capture or upload a card photo.");
  }
  if (buf.length < 64) {
    fail("SCAN_IMAGE_INVALID", "The uploaded file is not a readable image. Please retake the photo.");
  }
  if (buf.length > MAX_SCAN_IMAGE_BYTES) {
    fail(
      "SCAN_IMAGE_TOO_LARGE",
      `The image is too large (over ${Math.round(MAX_SCAN_IMAGE_BYTES / (1024 * 1024))}MB). Use a smaller photo.`,
    );
  }
  const sniffed = SNIFFERS.find((s) => s.test(buf));
  if (!sniffed) {
    fail("SCAN_IMAGE_UNSUPPORTED", "Unsupported or unreadable file type. Upload a JPEG, PNG, WebP, or HEIC photo.");
  }
  return {
    data: base64,
    mimeType: sniffed.mime,
    bytes: buf.length,
    dataUrl: `data:${sniffed.mime};base64,${base64}`,
  };
}

/** Card-identity fields that make an extraction "readable". An image where the
 * model found none of these is treated as a controlled no-card result. */
export function hasReadableCard(fields: {
  firstName: string | null;
  lastName: string | null;
  arabicName: string | null;
  company: string | null;
  email: string | null;
  mobile: string | null;
}): boolean {
  return Boolean(
    fields.firstName || fields.lastName || fields.arabicName || fields.company || fields.email || fields.mobile,
  );
}
