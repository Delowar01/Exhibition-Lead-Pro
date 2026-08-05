// On-device capture-quality scoring (advisory only — never blocks a capture).
//
// Device round found the old whole-frame heuristic (JPEG bytes-per-pixel over
// the entire camera frame) produced FALSE "poor quality" warnings: the dark
// surround around the card deflated the byte density even when the card itself
// was crisp. This module replaces it with a pixel-level analysis of the CROPPED
// card image:
//
//   1. The caller passes a small JPEG thumbnail of the cropped card (~160px).
//      It is decoded with jpeg-js (pure JS — works on Hermes and in node
//      tests) and scored on real signal:
//        - exposure: mean luminance + clipped-shadow/highlight fractions
//        - sharpness: high-percentile luminance gradient (p95). Sharp text
//          edges produce strong gradients even when text is sparse; blur
//          flattens them. Using a high percentile (not the mean) keeps a
//          mostly-white card with little text from reading as "blurry".
//   2. If no thumbnail is available (web fallback path, decode failure), it
//      falls back to the old bytes-per-pixel heuristic — now computed on the
//      cropped card, which already removes the dark-surround bias.
//
// Pure library: no React Native imports, fully unit-testable.

import * as jpeg from "jpeg-js";

export interface CaptureQuality {
  score: number; // 0..100; UI bands: good >= 66, fair >= 40, poor < 40
  meta: {
    heuristic: string;
    width: number;
    height: number;
    payloadKb: number;
    bytesPerPixel: number | null;
    meanLuma: number | null;
    sharpness: number | null; // p95 luminance gradient, 0..255
    clipDark: number | null; // fraction of near-black pixels
    clipBright: number | null; // fraction of near-white pixels
    cropped: boolean;
  };
}

// ── Tunables (exported for tests) ────────────────────────────────────────────
// Exposure: business cards are mostly paper, so the "ideal" mean-luma band is
// wide and skews bright. Outside the band the score falls off linearly.
export const EXPOSURE_IDEAL_LO = 70;
export const EXPOSURE_IDEAL_HI = 215;
export const EXPOSURE_ZERO_LO = 25;
export const EXPOSURE_ZERO_HI = 250;
// Sharpness: top-tail mean gradient below LO scores 0, above HI scores 100.
// A crisp text edge (dark ink on paper) yields ~150-220; defocus collapses it.
export const SHARPNESS_LO = 40;
export const SHARPNESS_HI = 130;
// Fallback bytes-per-pixel band (cropped card, JPEG q≈0.5).
export const BPP_LO = 0.08;
export const BPP_HI = 0.45;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

const B64_LOOKUP = (() => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < chars.length; i++) table[chars.charCodeAt(i)] = i;
  table["=".charCodeAt(0)] = -2;
  return table;
})();

// Minimal base64 → bytes decoder (no atob/Buffer dependency; Hermes + node).
export function base64ToBytes(b64: string): Uint8Array | null {
  const clean = b64.replace(/[\r\n\s]/g, "");
  if (!clean) return null;
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    const v = code < 128 ? B64_LOOKUP[code] : -1;
    if (v === -2) break; // padding
    if (v < 0) return null;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function stripDataUrl(imageData: string): string {
  if (imageData.startsWith("data:")) {
    const idx = imageData.indexOf(",");
    return idx >= 0 ? imageData.slice(idx + 1) : "";
  }
  return imageData;
}

export interface ThumbAnalysis {
  meanLuma: number;
  sharpness: number; // p95 of |luma gradient| (horizontal + vertical samples)
  clipDark: number;
  clipBright: number;
}

// Decode a small JPEG and measure exposure + edge sharpness. Returns null when
// the payload is not decodable (corrupt, not a JPEG, absurd size).
export function analyzeJpegThumbnail(thumbBase64OrDataUrl: string): ThumbAnalysis | null {
  try {
    const bytes = base64ToBytes(stripDataUrl(thumbBase64OrDataUrl));
    if (!bytes || bytes.length < 4) return null;
    const { data, width, height } = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 32 });
    if (!width || !height || width * height > 512 * 512) return null;

    // Luma plane.
    const luma = new Float32Array(width * height);
    let sum = 0;
    let dark = 0;
    let bright = 0;
    for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
      const y = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      luma[i] = y;
      sum += y;
      if (y < 15) dark++;
      else if (y > 245) bright++;
    }
    const meanLuma = sum / luma.length;

    // Gradient magnitudes (horizontal + vertical neighbours).
    const grads: number[] = [];
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width - 1; x++) {
        grads.push(Math.abs(luma[row + x + 1] - luma[row + x]));
      }
    }
    for (let y = 0; y < height - 1; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        grads.push(Math.abs(luma[row + width + x] - luma[row + x]));
      }
    }
    if (grads.length === 0) return null;
    // Sharpness = mean of the strongest 0.5% of gradients. Text edges are a
    // tiny fraction of all pixel pairs (a sparse card can be <1%), so any
    // fixed mid percentile (p95) sits in the flat paper and reads "blurry".
    // The top tail isolates the edges themselves; JPEG decoding has already
    // smoothed single-pixel noise that could fake an edge.
    grads.sort((a, b) => b - a);
    const take = Math.max(32, Math.floor(grads.length * 0.005));
    let topSum = 0;
    const n = Math.min(take, grads.length);
    for (let i = 0; i < n; i++) topSum += grads[i];
    const topMean = topSum / n;

    return {
      meanLuma,
      sharpness: topMean,
      clipDark: dark / luma.length,
      clipBright: bright / luma.length,
    };
  } catch {
    return null;
  }
}

export function exposureScore(a: ThumbAnalysis): number {
  const m = a.meanLuma;
  let s: number;
  if (m >= EXPOSURE_IDEAL_LO && m <= EXPOSURE_IDEAL_HI) s = 100;
  else if (m < EXPOSURE_IDEAL_LO) {
    s = 100 * clamp01((m - EXPOSURE_ZERO_LO) / (EXPOSURE_IDEAL_LO - EXPOSURE_ZERO_LO));
  } else {
    s = 100 * clamp01((EXPOSURE_ZERO_HI - m) / (EXPOSURE_ZERO_HI - EXPOSURE_IDEAL_HI));
  }
  // Heavy clipping (crushed shadows / blown highlights) caps the score even
  // when the mean happens to land in the ideal band.
  if (a.clipDark + a.clipBright > 0.6) s = Math.min(s, 30);
  return Math.round(s);
}

export function sharpnessScore(a: ThumbAnalysis): number {
  return Math.round(100 * clamp01((a.sharpness - SHARPNESS_LO) / (SHARPNESS_HI - SHARPNESS_LO)));
}

/**
 * Score a capture. `imageData` is the (cropped) upload payload — used for
 * payload size and the bytes-per-pixel fallback. `thumbnail`, when provided,
 * is a small JPEG of the same image and enables the pixel-level analysis.
 */
export function computeCaptureQuality(input: {
  imageData: string;
  width: number;
  height: number;
  thumbnail?: string | null;
  cropped?: boolean;
}): CaptureQuality | null {
  const { imageData, width, height } = input;
  if (!imageData || !imageData.startsWith("data:image") || !width || !height) return null;
  const b64 = stripDataUrl(imageData);
  if (!b64) return null;
  const payloadBytes = Math.round(b64.length * 0.75);
  const pixels = width * height;
  if (pixels <= 0) return null;
  const cropped = !!input.cropped;

  const analysis = input.thumbnail ? analyzeJpegThumbnail(input.thumbnail) : null;
  if (analysis) {
    const exp = exposureScore(analysis);
    const sharp = sharpnessScore(analysis);
    // Sharpness dominates (it is what breaks OCR); terrible exposure caps the
    // total so a pitch-black-but-"sharp" noise frame cannot read as good.
    let score = Math.round(0.4 * exp + 0.6 * sharp);
    if (exp < 25) score = Math.min(score, 35);
    return {
      score,
      meta: {
        heuristic: "cropped-card-pixels",
        width,
        height,
        payloadKb: Math.round(payloadBytes / 1024),
        bytesPerPixel: Math.round((payloadBytes / pixels) * 1000) / 1000,
        meanLuma: Math.round(analysis.meanLuma),
        sharpness: Math.round(analysis.sharpness),
        clipDark: Math.round(analysis.clipDark * 1000) / 1000,
        clipBright: Math.round(analysis.clipBright * 1000) / 1000,
        cropped,
      },
    };
  }

  // Fallback: JPEG detail density on the (cropped) upload image.
  const bpp = payloadBytes / pixels;
  const score = Math.round(100 * clamp01((bpp - BPP_LO) / (BPP_HI - BPP_LO)));
  return {
    score,
    meta: {
      heuristic: cropped ? "jpeg-detail-density-cropped" : "jpeg-detail-density",
      width,
      height,
      payloadKb: Math.round(payloadBytes / 1024),
      bytesPerPixel: Math.round(bpp * 1000) / 1000,
      meanLuma: null,
      sharpness: null,
      clipDark: null,
      clipBright: null,
      cropped,
    },
  };
}
