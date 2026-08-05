// Pure geometry for cropping a camera capture to the on-screen guide frame.
//
// The camera preview renders the sensor image with aspect-fill ("cover"):
// the photo is scaled uniformly until it covers the whole preview, and the
// overflow is cropped equally on both sides. To map a rectangle drawn in
// preview coordinates (the guide frame, in dp) into source-photo pixels we
// invert that transform. Everything here is unit-testable math — no RN
// imports, no hardcoded screen sizes.
//
// Coordinate notes:
// - previewW/previewH and the frame rect share the same unit (dp). Density
//   (DPR) cancels out because the cover scale is a ratio of the two spaces.
// - photoW/photoH are the pixel dimensions reported by the camera. On Android
//   with skipProcessing the sensor image can be reported pre-rotation
//   (landscape) while the preview is portrait; expo-image-manipulator loads
//   images EXIF-upright, so when the orientations disagree we swap the photo
//   dimensions to compute the crop in upright space.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CropRect {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

// Reject crops smaller than this (px) on either edge — a degenerate rect means
// the measurement was wrong and cropping would destroy the capture.
const MIN_CROP_EDGE_PX = 64;

/**
 * Map the guide-frame rect (preview/dp coords) to a pixel crop rect in the
 * captured photo, assuming the preview displays the photo with cover scaling.
 *
 * @param marginRatio expands the frame on every side by this fraction of the
 *   frame's width/height before mapping — a forgiveness margin for cards that
 *   slightly overflow the guide. Default 6%.
 * @returns integer crop rect clamped to the photo bounds, or null when the
 *   inputs are unusable (zero/negative sizes, frame outside the preview, or a
 *   degenerate result) — callers must skip cropping in that case.
 */
export function mapFrameToPhotoCrop(params: {
  previewW: number;
  previewH: number;
  photoW: number;
  photoH: number;
  frame: Rect;
  marginRatio?: number;
}): CropRect | null {
  const { previewW, previewH, frame } = params;
  let { photoW, photoH } = params;
  const marginRatio = params.marginRatio ?? 0.06;

  if (
    !isFinite(previewW) || !isFinite(previewH) || !isFinite(photoW) || !isFinite(photoH) ||
    previewW <= 0 || previewH <= 0 || photoW <= 0 || photoH <= 0 ||
    !isFinite(frame.x) || !isFinite(frame.y) ||
    !isFinite(frame.width) || !isFinite(frame.height) ||
    frame.width <= 0 || frame.height <= 0
  ) {
    return null;
  }

  // Orientation mismatch: photo reported pre-rotation. Compute in upright space.
  const previewPortrait = previewH >= previewW;
  const photoPortrait = photoH >= photoW;
  if (previewPortrait !== photoPortrait) {
    const tmp = photoW;
    photoW = photoH;
    photoH = tmp;
  }

  // Cover scale (photo -> preview) and the preview-space overflow offsets.
  const scale = Math.max(previewW / photoW, previewH / photoH);
  const offsetX = (photoW * scale - previewW) / 2;
  const offsetY = (photoH * scale - previewH) / 2;

  // Expand the frame by the forgiveness margin (preview space).
  const mx = frame.width * marginRatio;
  const my = frame.height * marginRatio;
  const fx = frame.x - mx;
  const fy = frame.y - my;
  const fw = frame.width + 2 * mx;
  const fh = frame.height + 2 * my;

  // Preview -> photo.
  let px = (fx + offsetX) / scale;
  let py = (fy + offsetY) / scale;
  let pw = fw / scale;
  let ph = fh / scale;

  // Clamp to the photo bounds.
  if (px < 0) {
    pw += px;
    px = 0;
  }
  if (py < 0) {
    ph += py;
    py = 0;
  }
  pw = Math.min(pw, photoW - px);
  ph = Math.min(ph, photoH - py);

  const originX = Math.round(px);
  const originY = Math.round(py);
  const width = Math.floor(pw);
  const height = Math.floor(ph);

  if (width < MIN_CROP_EDGE_PX || height < MIN_CROP_EDGE_PX) return null;
  // A crop that covers (almost) the whole photo is pointless; skip so the
  // caller keeps the plain resize path (also guards against bogus measures).
  if (width >= photoW - 1 && height >= photoH - 1) return null;

  return { originX, originY, width, height };
}
