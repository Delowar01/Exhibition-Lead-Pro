---
name: HEIC is not decodable in this runtime
description: Why scan uploads reject HEIC with SCAN_IMAGE_HEIC_UNSUPPORTED and how each image path enforces it
---

The rule: HEIC/HEIF (HEVC-coded, i.e. real iPhone photos) must be REJECTED at
byte-level validation (`SCAN_IMAGE_HEIC_UNSUPPORTED`, 400, "use or convert to
JPEG"), never accepted.

**Why:** The prebuilt sharp/libheif in this environment has NO HEVC decoder
plugin (patent licensing — only AVIF is decodable). `sharp().metadata()` on a
genuine HEIC *succeeds* while actual decode fails ("Error while loading
plugin"), so a magic-byte allowlist that accepts HEIC passes validation and
then strands the upload at the later compression/storage step. Verified with a
genuine Nokia-conformance HEVC fixture (kept at
api-server test/fixtures/genuine-hevc.heic — sharp cannot fabricate one, it has
no HEVC encoder either).

**How to apply:**
- EVERY image-accepting path must run the shared `validateScanImage()` before
  any provider call: single scan, replace-image, AND batch-analyze items (the
  batch job runner was the path that bypassed it — a per-item soft failure
  records the structured message).
- Mobile never sends HEIC: camera capture and gallery picks are converted to
  JPEG on-device via ImageManipulator (`data:image/jpeg;base64,...`); the
  rejection exists for web uploads / third-party clients.
- Clients map the code to a localized message (mobile key `capture.errHeic`,
  EN/AR parity asserted in tests).
- Don't "fix" this by switching HEIC support on: it needs a libheif build with
  an HEVC plugin, which the prebuilt sharp binaries do not ship.
