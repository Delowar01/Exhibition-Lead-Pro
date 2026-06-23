---
name: QR scan — ML Kit raw vs data (Android)
description: Why Android QR scans of vCard/MECARD detect but extract no contact, and the raw-vs-data fix.
---

On Android, expo-camera's barcode engine is Google ML Kit, which **parses** structured
QR codes (vCard / MECARD) and returns a *lossy* human-readable string in
`result.data` (ML Kit `getDisplayValue()` — strips the `BEGIN:VCARD` wrapper and drops
most fields). The full original payload is only in `result.raw`. iOS/web populate
`result.data` with the full payload and leave `raw` empty.

**Symptom:** QR is detected on a native Android APK but no usable contact is created —
only a name or company survives. Works fine in samples decoded on desktop/iOS because
those return the raw string in `data`.

**Fix:** never feed only `result.data` to the parser. Use `parseQrBest(result.raw, result.data)`
(in `lib/contact-parse.ts`) — it parses every distinct non-empty candidate, ranks by
populated-field count, and merges so the richest decode wins regardless of which field
carried the raw bytes. This is platform-agnostic (raw-only / data-only / both).

**Why:** the bug is invisible in unit tests that only feed a raw vCard string, and
invisible on iOS/desktop decoders — it only reproduces on a real Android device. The
attached Elite Marcom regression QR (a standard vCard 3.0 with stray bare-CR line folds
in FN/ADR) is captured verbatim in `contact-parse.test.ts` as `ELITE_MARCOM_VCARD`.

**How to apply:** keep `parseQrBest` the canonical entry point for ALL camera barcode
scans. Do not reintroduce `parseQr(result.data)` in any scanner path. (NFC reads NDEF
records directly and is unaffected.)
