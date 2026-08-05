# Batch 8 — Mobile Capture Tests, APK Build, and Physical-Device Verification

Implement Batch 8 — Mobile Capture Tests, APK Build, and Physical-Device Verification for the existing Lead Capture Pro project.

## PURPOSE

Complete the remaining mobile verification work by testing the retained capture workflows, producing an installable Android APK, and verifying the application on a real Android device.

This batch must also close task #133 by confirming how real iPhone HEIC images are handled end to end.

## CURRENT VERIFIED BASELINE

- Batch 7 is complete.
- API tests pass 702/702.
- Playwright passes 43/43.
- Mobile tests pass 72/72.
- API, web, and mobile typechecks are clean.
- Live Gemini Vision verification passed 8/8 controlled fixtures.
- Mobile retains:
  - Camera business-card capture
  - Batch capture
  - Scan review
  - Manual capture
  - QR capture
  - NFC capture
  - Event selection
  - AI Assistant
  - MFA login
- Full mobile administration and removed mobile AI intelligence screens remain permanently out of scope.
- Task #134 was audited and closed as not applicable.

## IMPORTANT BOUNDARIES

Do not:

- Redesign the mobile app.
- Add new capture modes.
- Add full mobile administration.
- Restore AI Command Center, Workflow Intelligence, or Executive Intelligence on mobile.
- Replace Expo or the existing React Native architecture.
- Add a new mobile test framework unless absolutely required.
- Publish to Google Play or Apple App Store.
- Use production customer data.
- Put production secrets inside the APK.
- Change working backend, OCR, AI, or authentication architecture without a proven defect.
- Start Batch 9.
- Claim physical-device verification unless the APK was actually installed and tested on a real device.

## STEP 1 — INSPECT THE MOBILE BUILD

Inspect:

- `app.json` or app config
- `eas.json`
- Android package identifier
- App version and build number
- Environment-variable handling
- API base URL
- Camera, gallery, NFC, and network permissions
- Expo Camera configuration
- Image picker configuration
- Android manifest generation
- Current build scripts
- Current mobile test setup

Confirm that the test APK connects to the staging API and never depends on localhost or a temporary Replit development URL that will stop working.

Use the existing application identity and configuration.

## STEP 2 — VERIFY CAMERA IMAGE FORMAT

Confirm the actual output format from the current Expo Camera capture path.

Requirements:

- Confirm Android camera captures are sent as JPEG or another explicitly supported format.
- Inspect the iOS Expo Camera behavior from the current implementation and configuration.
- Do not assume that native camera captures are HEIC.
- Confirm MIME type, filename extension, and base64/data-URL formatting are consistent.
- Ensure EXIF orientation continues to be handled correctly.
- Do not unnecessarily recompress images on the mobile device if the backend already handles safe normalization.

Add focused automated tests for any image-mapping or payload logic that changes.

## STEP 3 — CLOSE TASK #133: HEIC END-TO-END

Use one genuine, small HEIC image fixture.

Test it through the real backend path:

```text
POST /api/scans
→ image validation
→ OCR pipeline
→ Sharp decode/orientation/compression
→ private image storage
→ authenticated image retrieval
```

The AI provider may use the existing stub for the automated integration test. The important requirement is proving that the installed Sharp/runtime environment can decode and process HEIC.

Required outcome:

### A. If HEIC works

- Keep HEIC accepted.
- Add an integration test using the genuine HEIC fixture.
- Confirm compression and private storage succeed.
- Confirm the saved image can be retrieved through the authorized endpoint.
- Confirm no temporary or orphaned file remains.

### B. If HEIC cannot be decoded reliably

- Stop accepting HEIC as a supported image.
- Reject it before OCR with a clear structured error.
- Show a user-friendly mobile message such as:
  - “This HEIC image cannot be processed. Please use or convert it to JPEG.”
- Do not accept HEIC and then fail later during compression.

Also verify:

- Whether gallery/image-picker selection can return HEIC.
- Whether mobile camera capture itself produces JPEG.
- English and Arabic error-message parity.

Do not claim iPhone physical-device testing unless an iPhone was actually used.

## STEP 4 — MOBILE CAPTURE AUTOMATED TESTS

Use the current mobile test infrastructure.

Add or update focused tests for:

- Camera response-to-scan payload mapping
- Image MIME and data-URL handling
- OCR success response mapping
- OCR failure mapping
- Budget-limit response
- AI rate-limit response
- Invalid-image response
- HEIC unsupported response, if applicable
- Batch partial-success state
- Retry only failed batch item
- Duplicate-save prevention
- Manual capture validation
- QR result mapping
- NFC result mapping where logic is testable
- Event association
- English and Arabic translation-key parity

Do not add a large React Native UI automation framework solely for this batch.

## STEP 5 — BUILD AN INSTALLABLE ANDROID APK

Produce an Android test APK using the project’s existing Expo/EAS approach.

Requirements:

- Use a preview/internal-testing profile.
- Connect to the staging API.
- Do not embed production credentials.
- Use the correct Android package identifier.
- Increment the build number only where required.
- Keep signing credentials secure.
- Do not commit signing keys or credentials.
- Confirm the APK installs without requiring developer tooling.
- Provide the exact APK file or secure build download reference.
- Record:
  - App version
  - Build number
  - Package name
  - Build profile
  - Build timestamp
  - Git commit used

Do not publish the app to an app store.

## STEP 6 — PHYSICAL ANDROID DEVICE VERIFICATION

Install the generated APK on at least one real Android device.

Record:

- Device manufacturer and model
- Android version
- APK version/build number
- Network used
- Date of verification

Test these flows:

1. Installation and launch
2. Login
3. MFA login when required
4. Camera permission request
5. Camera denial and later permission recovery
6. Clear business-card capture
7. OCR processing
8. Review and edit extracted fields
9. Explicit save creates one contact
10. Cancel/back does not create a contact
11. Duplicate-contact handling
12. Batch capture with at least two cards
13. Retry one failed batch item
14. Manual capture
15. QR capture
16. NFC capture when the device supports NFC
17. Event association
18. Scan history and private image access
19. Network failure and retry
20. App background/resume during a recoverable flow
21. Logout and session rejection afterward

Use safe test-card data only.

NFC rule:

- If the device supports NFC, perform the real NFC test.
- If the device does not support NFC, verify the unsupported-device message and clearly report that real NFC reading remains unverified.
- Do not remove NFC.

## STEP 7 — REAL OCR DEVICE TEST

From the physical Android device, scan at least:

- One clear English business card
- One Arabic or bilingual business card
- One rotated or angled card
- One difficult or low-light card

Verify:

- The image reaches the staging OCR endpoint.
- Gemini Vision processes the image through the Enterprise AI Layer.
- Results appear in the review screen.
- Extracted values can be edited.
- No contact is created before explicit confirmation.
- Usage ledger entries are created without image or extracted-card content.
- Failure and retry states remain usable.

Do not use real customer data.

## STEP 8 — RESPONSIVENESS AND DEVICE UX

On the physical device, verify:

- No horizontal overflow
- No clipped buttons or inputs
- Keyboard does not block required fields/actions
- Safe-area handling
- Loading indicators
- Disabled states during submission
- English layout
- Arabic RTL layout
- Light theme
- Dark theme
- Error messages remain readable
- Camera and review screens remain usable in portrait orientation

Fix only confirmed mobile defects.

## STEP 9 — SECURITY AND ENVIRONMENT CHECK

Verify the APK does not contain:

- Gemini API keys
- Database credentials
- SMTP credentials
- Signing credentials
- Production secrets
- Debug-only authentication bypasses
- Localhost API URLs
- Temporary Replit development URLs intended only for editor previews

Confirm:

- Authentication tokens use the existing secure mobile storage.
- Private scan images require authentication.
- Cross-tenant scan/image access remains denied.
- Platform Owner tenant-data firewall remains intact.
- Logs do not expose card content, tokens, or credentials.

## STEP 10 — REGRESSION VERIFICATION

Run:

- API-server typecheck
- Web-app typecheck
- Mobile typecheck
- Mobile unit tests
- HEIC integration test
- OCR-focused API tests
- Tenant-isolation tests affected by changes
- Full API suite if backend code changes
- Full Playwright suite
- Existing AI usage and OCR tests

Restart the API server before integration tests when required.

Report actual totals. Do not assume they remain 702, 43, or 72.

## COMPLETION CRITERIA

Mark Batch 8 complete only when:

- Mobile capture logic tests pass.
- HEIC behavior is conclusively verified or safely rejected.
- The Android APK builds successfully.
- The APK installs and launches on a real Android device.
- Core capture flows are physically tested.
- Camera OCR works from the physical device.
- Review and explicit-save behavior is confirmed.
- Batch capture and retry are confirmed.
- Manual and QR capture are confirmed.
- NFC is tested where supported, or the hardware limitation is honestly reported.
- English/Arabic and light/dark mobile UI remain usable.
- No secrets are embedded in the APK.
- Staging API configuration is stable.
- Typechecks and regression suites pass.
- No app-store publication occurs.
- No removed mobile administration or AI intelligence screens are restored.

If Replit cannot directly access a physical device, do not mark the batch complete after building the APK. Provide the APK and a precise test checklist, then wait for the owner or an assigned tester to return the physical-device results.

## FINAL REPORT

Return only:

1. Existing mobile architecture reused
2. Camera output format confirmed
3. HEIC end-to-end result
4. HEIC support retained or rejection behavior added
5. Mobile capture tests added or changed
6. APK build method
7. APK artifact or secure build reference
8. App version, build number, and package name
9. Physical Android device tested
10. Android version and device model
11. Login and MFA results
12. Camera and OCR results
13. Single-card review/save results
14. Batch-capture and retry results
15. Manual, QR, and NFC results
16. Event-association result
17. English/Arabic and light/dark results
18. Network/background-resume results
19. Security and secret-scan findings
20. Files changed
21. Schema changes, if any
22. Commands run
23. Exact test pass/fail totals
24. Physical-device failures fixed
25. Genuine limitations
26. Confirmation that no app-store publication occurred
27. Confirmation that no removed mobile scope was restored
28. Confirmation that Batch 9 was not started

Do not begin another batch or recommend unrelated features.
