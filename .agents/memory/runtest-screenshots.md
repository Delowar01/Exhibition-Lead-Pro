---
name: runTest screenshot capture
description: How to reliably get screenshot files out of the testing subagent
---
The testing subagent's `runTest` returns `screenshotPaths: []` even when screenshots are taken. To get files: instruct the agent in the test plan to SAVE a PNG with an exact filename; the file appears in the workspace ROOT — move it to its destination afterward.

**Why:** screenshotPaths is unreliable; only explicit save-with-filename works.
**How to apply:** any before/after screenshot capture for reports. Note: runTest params are camelCase (`testPlan`, `whereToStart`). Also: heavy runTest traffic against the live API can fail the integration suite if run concurrently — run the test suite with a quiet API.
