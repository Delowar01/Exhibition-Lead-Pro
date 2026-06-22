---
name: Mobile batch-store OCR lifecycle
description: Rules for batch capture OCR result storage — what clears ocrResults and when, and how batch-review polls for pending results.
---

## The rule

`setBatchCaptures(items)` must **NOT** call `ocrResults.clear()`.

Background OCR fires `setBatchOcrResult(id, { status: "pending" })` immediately on capture, then `setBatchOcrResult(id, { status: "done", extracted })` when the API returns — both happen **before** `setBatchCaptures` is called (user taps "Done"). Clearing inside `setBatchCaptures` wipes every pre-computed result a moment before `batch-review` reads them, forcing sequential OCR at review time.

`ocrResults` is only cleared inside `clearBatchCaptures()` — called at the end of a session (user finishes review). That is the correct and only clear point.

**Why:** A previous "fix" added `ocrResults.clear()` to `setBatchCaptures` to prevent stale cross-session results. But batch IDs are unique timestamps + random suffixes, so cross-session collisions are impossible. The clear was purely harmful.

## batch-review polling pattern

When `getBatchOcrResult(id)?.status === "pending"` at review time (user navigated to review before OCR finished), do NOT immediately run a duplicate sequential scan. Instead:

1. Show loading indicator
2. Poll `getBatchOcrResult(id)` every 500 ms for up to 20 seconds
3. If result arrives (done/error) → use it
4. If 20 s elapses → fall through to sequential OCR as last resort

**How to apply:** Any time `runOcr` in `batch-review.tsx` is updated, ensure the pending branch has this polling loop before the sequential fallback.
