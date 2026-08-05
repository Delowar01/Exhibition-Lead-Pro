import { describe, expect, it } from "vitest";
import * as jpeg from "jpeg-js";

import {
  analyzeJpegThumbnail,
  base64ToBytes,
  computeCaptureQuality,
  exposureScore,
  sharpnessScore,
} from "./capture-quality";

// ── Synthetic fixtures ───────────────────────────────────────────────────────
// A fake business card: bright paper background with dark "text" bars (hard
// edges). Rendered directly into RGBA, then JPEG-encoded with jpeg-js — the
// same codec family the camera produces, so gradients survive realistically.

const W = 160;
const H = 100;

function renderCard(opts: { bg: number; ink: number; blurPasses?: number }): Uint8Array {
  const px = new Float32Array(W * H).fill(opts.bg);
  // Horizontal "text lines": rows of short dark bars.
  for (let line = 0; line < 5; line++) {
    const y0 = 14 + line * 17;
    for (let y = y0; y < y0 + 5; y++) {
      for (let x = 12; x < W - 12; x++) {
        // Break the bars into word-like chunks.
        if (Math.floor(x / 14) % 2 === 0) px[y * W + x] = opts.ink;
      }
    }
  }
  // Box-blur passes to simulate defocus.
  const passes = opts.blurPasses ?? 0;
  let src = px;
  for (let p = 0; p < passes; p++) {
    const dst = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let sum = 0;
        let n = 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const yy = y + dy;
            const xx = x + dx;
            if (yy >= 0 && yy < H && xx >= 0 && xx < W) {
              sum += src[yy * W + xx];
              n++;
            }
          }
        }
        dst[y * W + x] = sum / n;
      }
    }
    src = dst;
  }
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const v = Math.max(0, Math.min(255, Math.round(src[i])));
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

function encodeJpegDataUrl(rgba: Uint8Array, quality = 80): string {
  const encoded = jpeg.encode({ data: rgba, width: W, height: H }, quality);
  const b64 = Buffer.from(encoded.data).toString("base64");
  return `data:image/jpeg;base64,${b64}`;
}

const SHARP_CARD = encodeJpegDataUrl(renderCard({ bg: 235, ink: 20 }));
const BLURRY_CARD = encodeJpegDataUrl(renderCard({ bg: 235, ink: 20, blurPasses: 4 }));
const DARK_CARD = encodeJpegDataUrl(renderCard({ bg: 34, ink: 5 }));

// A plausible cropped upload payload (content irrelevant for the pixel path).
const UPLOAD = SHARP_CARD;

describe("base64ToBytes", () => {
  it("decodes standard base64", () => {
    const bytes = base64ToBytes(Buffer.from("hello!").toString("base64"));
    expect(Array.from(bytes!)).toEqual(Array.from(Buffer.from("hello!")));
  });
  it("rejects garbage", () => {
    expect(base64ToBytes("!!!not-base64!!!")).toBeNull();
    expect(base64ToBytes("")).toBeNull();
  });
});

describe("analyzeJpegThumbnail", () => {
  it("measures a sharp, well-lit card as bright and edgy", () => {
    const a = analyzeJpegThumbnail(SHARP_CARD)!;
    expect(a).not.toBeNull();
    expect(a.meanLuma).toBeGreaterThan(150);
    expect(a.sharpness).toBeGreaterThan(80);
    expect(a.clipDark).toBeLessThan(0.3);
  });

  it("measures blur as a collapse in gradient energy", () => {
    const sharp = analyzeJpegThumbnail(SHARP_CARD)!;
    const blurry = analyzeJpegThumbnail(BLURRY_CARD)!;
    expect(blurry.sharpness).toBeLessThan(sharp.sharpness * 0.5);
  });

  it("measures a dark capture as low mean luma", () => {
    const a = analyzeJpegThumbnail(DARK_CARD)!;
    expect(a.meanLuma).toBeLessThan(50);
  });

  it("returns null for a non-JPEG payload", () => {
    expect(analyzeJpegThumbnail(Buffer.from("plainly not a jpeg").toString("base64"))).toBeNull();
  });
});

describe("computeCaptureQuality (pixel path)", () => {
  it("scores a sharp, well-lit card as GOOD (>= 66)", () => {
    const q = computeCaptureQuality({
      imageData: UPLOAD,
      width: 1100,
      height: 694,
      thumbnail: SHARP_CARD,
      cropped: true,
    })!;
    expect(q.score).toBeGreaterThanOrEqual(66);
    expect(q.meta.heuristic).toBe("cropped-card-pixels");
    expect(q.meta.cropped).toBe(true);
  });

  it("scores a blurry card below GOOD", () => {
    const q = computeCaptureQuality({
      imageData: UPLOAD,
      width: 1100,
      height: 694,
      thumbnail: BLURRY_CARD,
      cropped: true,
    })!;
    expect(q.score).toBeLessThan(66);
  });

  it("scores a dark capture as POOR (< 40)", () => {
    const q = computeCaptureQuality({
      imageData: UPLOAD,
      width: 1100,
      height: 694,
      thumbnail: DARK_CARD,
      cropped: true,
    })!;
    expect(q.score).toBeLessThan(40);
  });

  it("a white card with sparse text does NOT read as blurry (the old false-poor)", () => {
    // Only one thin text line — very low average detail, but sharp edges.
    const sparse = new Float32Array(W * H).fill(240);
    for (let y = 46; y < 50; y++) {
      for (let x = 30; x < 130; x++) {
        if (Math.floor(x / 12) % 2 === 0) sparse[y * W + x] = 15;
      }
    }
    const rgba = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const v = Math.round(sparse[i]);
      rgba[i * 4] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = 255;
    }
    const q = computeCaptureQuality({
      imageData: UPLOAD,
      width: 1100,
      height: 694,
      thumbnail: encodeJpegDataUrl(rgba),
      cropped: true,
    })!;
    expect(q.score).toBeGreaterThanOrEqual(66);
  });
});

describe("computeCaptureQuality (fallback path)", () => {
  it("falls back to bytes-per-pixel when no thumbnail is provided", () => {
    const q = computeCaptureQuality({ imageData: UPLOAD, width: 160, height: 100, cropped: true })!;
    expect(q.meta.heuristic).toBe("jpeg-detail-density-cropped");
    expect(q.meta.bytesPerPixel).toBeGreaterThan(0);
    expect(q.score).toBeGreaterThanOrEqual(0);
    expect(q.score).toBeLessThanOrEqual(100);
  });

  it("falls back when the thumbnail is not decodable", () => {
    const q = computeCaptureQuality({
      imageData: UPLOAD,
      width: 160,
      height: 100,
      thumbnail: Buffer.from("nope").toString("base64"),
      cropped: false,
    })!;
    expect(q.meta.heuristic).toBe("jpeg-detail-density");
  });

  it("returns null for non-data-URL payloads and zero dimensions", () => {
    expect(computeCaptureQuality({ imageData: "card", width: 100, height: 100 })).toBeNull();
    expect(computeCaptureQuality({ imageData: UPLOAD, width: 0, height: 0 })).toBeNull();
  });
});

describe("score components", () => {
  it("exposure score peaks inside the ideal band and caps on heavy clipping", () => {
    expect(exposureScore({ meanLuma: 140, sharpness: 50, clipDark: 0, clipBright: 0 })).toBe(100);
    expect(exposureScore({ meanLuma: 30, sharpness: 50, clipDark: 0, clipBright: 0 })).toBeLessThan(20);
    expect(
      exposureScore({ meanLuma: 140, sharpness: 50, clipDark: 0.4, clipBright: 0.3 }),
    ).toBeLessThanOrEqual(30);
  });

  it("sharpness score is monotone in gradient strength", () => {
    const lo = sharpnessScore({ meanLuma: 140, sharpness: 30, clipDark: 0, clipBright: 0 });
    const mid = sharpnessScore({ meanLuma: 140, sharpness: 85, clipDark: 0, clipBright: 0 });
    const hi = sharpnessScore({ meanLuma: 140, sharpness: 150, clipDark: 0, clipBright: 0 });
    expect(lo).toBe(0);
    expect(mid).toBeGreaterThan(lo);
    expect(hi).toBe(100);
  });
});
