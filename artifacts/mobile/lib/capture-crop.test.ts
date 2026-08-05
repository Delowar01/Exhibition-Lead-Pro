import { describe, expect, it } from "vitest";

import { mapFrameToPhotoCrop, type Rect } from "./capture-crop";

// Typical device: 390x844 dp preview, portrait photo 1200x1600 px.
const PREVIEW = { previewW: 390, previewH: 844 };
const PHOTO = { photoW: 1200, photoH: 1600 };

// The guide frame used by the capture screen: 85% width, card aspect 1.586,
// vertically centered-ish.
function guideFrame(previewW = 390, previewH = 844): Rect {
  const width = previewW * 0.85;
  const height = width / 1.586;
  return { x: (previewW - width) / 2, y: (previewH - height) / 2 - 60, width, height };
}

describe("mapFrameToPhotoCrop", () => {
  it("maps a centered frame to a centered, correctly scaled photo rect", () => {
    const frame = guideFrame();
    const crop = mapFrameToPhotoCrop({ ...PREVIEW, ...PHOTO, frame, marginRatio: 0 });
    expect(crop).not.toBeNull();
    // Cover scale: max(390/1200, 844/1600) = 0.5275 (height-dominated).
    const scale = 844 / 1600;
    // Width overflow: 1200*scale = 633 shown in a 390 window → 121.5 dp cut each side.
    const offsetX = (1200 * scale - 390) / 2;
    expect(crop!.width).toBe(Math.floor(frame.width / scale));
    expect(crop!.height).toBe(Math.floor(frame.height / scale));
    expect(crop!.originX).toBe(Math.round((frame.x + offsetX) / scale));
    expect(crop!.originY).toBe(Math.round(frame.y / scale));
    // Sanity: crop stays inside the photo.
    expect(crop!.originX).toBeGreaterThanOrEqual(0);
    expect(crop!.originX + crop!.width).toBeLessThanOrEqual(1200);
    expect(crop!.originY + crop!.height).toBeLessThanOrEqual(1600);
    // Card aspect is preserved through the uniform scale (±rounding).
    expect(crop!.width / crop!.height).toBeCloseTo(1.586, 1);
  });

  it("expands the crop by the margin ratio on every side", () => {
    const frame = guideFrame();
    const tight = mapFrameToPhotoCrop({ ...PREVIEW, ...PHOTO, frame, marginRatio: 0 })!;
    const withMargin = mapFrameToPhotoCrop({ ...PREVIEW, ...PHOTO, frame, marginRatio: 0.06 })!;
    expect(withMargin.width).toBeGreaterThan(tight.width);
    expect(withMargin.height).toBeGreaterThan(tight.height);
    expect(withMargin.originX).toBeLessThan(tight.originX);
    expect(withMargin.originY).toBeLessThan(tight.originY);
    // 6% each side → 12% total growth (±rounding).
    expect(withMargin.width).toBeCloseTo(tight.width * 1.12, -1);
  });

  it("is DPR-independent: same physical layout at 2x dp scale gives the same crop", () => {
    const frame = guideFrame();
    const crop1 = mapFrameToPhotoCrop({ ...PREVIEW, ...PHOTO, frame });
    const frame2: Rect = { x: frame.x * 2, y: frame.y * 2, width: frame.width * 2, height: frame.height * 2 };
    const crop2 = mapFrameToPhotoCrop({
      previewW: PREVIEW.previewW * 2,
      previewH: PREVIEW.previewH * 2,
      ...PHOTO,
      frame: frame2,
    });
    expect(crop2).toEqual(crop1);
  });

  it("swaps pre-rotation (landscape-reported) photo dims for a portrait preview", () => {
    const frame = guideFrame();
    const upright = mapFrameToPhotoCrop({ ...PREVIEW, photoW: 1200, photoH: 1600, frame });
    const preRotation = mapFrameToPhotoCrop({ ...PREVIEW, photoW: 1600, photoH: 1200, frame });
    expect(preRotation).toEqual(upright);
  });

  it("clamps a frame that reaches past the visible photo to the photo bounds", () => {
    // Wider preview than the photo aspect: cover crops top/bottom, and a
    // frame hugging the left edge (plus margin) maps partially outside the
    // photo → clamped at 0 and never exceeding the photo bounds.
    const crop = mapFrameToPhotoCrop({
      previewW: 800,
      previewH: 400,
      photoW: 1200,
      photoH: 900,
      frame: { x: 0, y: 100, width: 700, height: 200 },
      marginRatio: 0.1,
    });
    expect(crop).not.toBeNull();
    expect(crop!.originX).toBeGreaterThanOrEqual(0);
    expect(crop!.originY).toBeGreaterThanOrEqual(0);
    expect(crop!.originX + crop!.width).toBeLessThanOrEqual(1200);
    expect(crop!.originY + crop!.height).toBeLessThanOrEqual(900);
  });

  it("returns null for degenerate inputs", () => {
    const frame = guideFrame();
    expect(mapFrameToPhotoCrop({ previewW: 0, previewH: 844, ...PHOTO, frame })).toBeNull();
    expect(mapFrameToPhotoCrop({ ...PREVIEW, photoW: 0, photoH: 0, frame })).toBeNull();
    expect(
      mapFrameToPhotoCrop({ ...PREVIEW, ...PHOTO, frame: { x: 10, y: 10, width: 0, height: 0 } }),
    ).toBeNull();
    expect(
      mapFrameToPhotoCrop({ ...PREVIEW, ...PHOTO, frame: { x: NaN, y: 10, width: 100, height: 60 } }),
    ).toBeNull();
  });

  it("returns null when the crop would be uselessly small", () => {
    // Tiny photo → the mapped rect is under the minimum edge.
    const crop = mapFrameToPhotoCrop({
      ...PREVIEW,
      photoW: 80,
      photoH: 100,
      frame: { x: 180, y: 400, width: 10, height: 6 },
      marginRatio: 0,
    });
    expect(crop).toBeNull();
  });

  it("returns null when the crop covers the whole photo (no-op crop)", () => {
    // Frame covering the entire preview with a photo of identical aspect.
    const crop = mapFrameToPhotoCrop({
      previewW: 390,
      previewH: 844,
      photoW: 780,
      photoH: 1688,
      frame: { x: 0, y: 0, width: 390, height: 844 },
      marginRatio: 0,
    });
    expect(crop).toBeNull();
  });
});
