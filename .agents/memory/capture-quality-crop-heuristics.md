---
name: Capture crop & quality heuristics
description: Why guide-frame cropping uses cover-math inversion and why sharpness must use top-tail gradients on the cropped card, not whole-frame bpp/percentiles.
---

# Capture crop & quality heuristics (mobile camera)

**Rules:**
- Crop to the on-screen guide frame with real cover-scale inversion (`mapFrameToPhotoCrop` in `lib/capture-crop.ts`): measure the frame at shutter time (measureInWindow), invert the preview→photo cover mapping, swap dimensions when the photo is reported pre-rotation, expand by a small margin, clamp, and return null (→ full-frame fallback) on degenerate results. Never hardcode coordinates.
- Quality must be measured on the CROPPED card pixels, not the whole frame. Whole-frame bytes-per-pixel is inherently false-positive-prone: background/table texture dominates the compression signal.
- Sharpness scoring on business cards must use the mean of the TOP tail of luminance gradients (e.g. top 0.5%), not a fixed percentile like p95 — sparse cards are mostly flat paper, so p95 sits in the flat region and flags sharp cards as blurry.
- Score exposure (mean-luma band + clip fractions) and sharpness separately; combine weighted, cap when exposure is terrible. Keep a bpp fallback only when the thumbnail can't be decoded, and tag the heuristic used.

**Why:** the original whole-frame bpp heuristic warned "low quality" on good captures (device-verified false positives), and a first pixel-based attempt using p95 gradients false-flagged sparse-text cards.

**How to apply:** any change to the capture path must preserve: single manipulateAsync [crop, resize] for the upload image + tiny thumbnail decode (jpeg-js) for scoring; crop math covered by unit tests (web can't exercise native camera).
