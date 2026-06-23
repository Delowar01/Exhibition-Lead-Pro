# Reports

Point-in-time QA, release, and pre-build verification reports captured during
development. These are historical records of what was tested and found at a given
date; for the living architecture and developer documentation, see the
[`docs/` index](../README.md).

| Report | Scope |
|---|---|
| [QA Report — Full Regression](QA_REPORT.md) | Full regression of the mobile app (App Lock, currency fix, feature regression); separates automated/code-review results from items pending native on-device verification. |
| [Production Release Checklist](PRODUCTION_RELEASE_CHECKLIST.md) | Final production verification & QA sign-off across the mobile app + API server (functional, data-consistency, security, performance, UX phases). |
| [OCR / QR / NFC Verification](OCR_QR_NFC_VERIFICATION.md) | Pre-build verification of the mobile capture pipeline (OCR, QR, NFC, contact extraction) and the server OCR path. |

> These reports describe the mobile client and the broader product history. Many
> items they list as "pending native verification" require real-device testing and
> are tracked there, not in the engineering [Technical-Debt Register](../tech-debt.md).
