---
name: Metro crawl crashes on server-only pnpm staging dirs
description: Expo/Metro FallbackWatcher ENOENT-crashes crawling the workspace .pnpm store; blockList server-only packages the mobile app never imports.
---

# Metro crawl vs. server-only packages in a pnpm monorepo

Symptom: the Expo/mobile workflow dies on startup with
`Error: ENOENT: no such file or directory, watch '.../node_modules/.pnpm/pdfkit@X/node_modules/pdfkit_tmp_NNNNN/.yarn'`
thrown from `metro-file-map` `FallbackWatcher._watchdir`. The `pdfkit_tmp_NNNNN`
suffix is a leftover pnpm install **staging** directory (NNNNN ≈ the installer
PID) that existed mid-install and is gone by the time Metro tries to `fs.watch`
it — a crawl-time race, not a missing dependency.

**Why:** Metro crawls the ENTIRE workspace `node_modules/.pnpm` store, including
packages that only the server imports (here `pdfkit`, a server dep added for PDF
export). It has no reason to watch them, but the crawl still walks them and trips
over transient staging dirs.

**How to apply:**
- Add a `config.resolver.blockList` RegExp in `artifacts/mobile/metro.config.js`
  excluding the pnpm path of any server-only package the mobile app never
  imports, e.g. `/\/node_modules\/\.pnpm\/pdfkit@[^/]+\/.*/`. Use a plain
  `RegExp` literal — don't `require("metro-config")` mergers.
- Clear stale caches after the fix: `/tmp/metro-cache` and `/tmp/metro-file-map-*`.
- Debugging trap: the workflow log is a point-in-time capture that can END on an
  old crash with a trailing `</logs>` marker while the CURRENT process is healthy.
  Confirm liveness by pinging the expo port (`curl localhost:$PORT` → 200) and
  checking the live pid, NOT by trusting the log tail.
