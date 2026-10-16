# Gemini production configuration — operator runbook (MOBILE-R1)

**Purpose.** AI card scanning (OCR) in the mobile app and every other AI feature run
**server-side only** through the Enterprise AI Layer of the API (`artifacts/api-server/src/ai/`,
provider adapter `src/ai/providers/gemini.ts`, SDK wrapper `lib/integrations-gemini-ai`). Until the
API process holds a Gemini credential the readiness gate (`src/ai/readiness.ts`) answers every AI
request with `503 AI_NOT_CONFIGURED` ("AI features are not configured for this environment. Please
contact your administrator."), `GET /ai/health` reports `configured=false` / `status="unconfigured"`,
and the mobile Scan tab shows "AI scanning unavailable" (QR, NFC and manual entry keep working).

**The credential never leaves the server.** It is never put in the mobile source, `app.json`,
`eas.json`, an `EXPO_PUBLIC_*` variable, the generated API client, the web bundle, a log line, a
chat, a ticket or this document. `artifacts/mobile/lib/no-bundled-secrets.test.ts` fails the mobile
suite if any of those files ever names or carries it.

## 1. Which variables the product reads (names only)

`lib/integrations-gemini-ai/src/client.ts` → `resolveCredentials()`:

| Variable | Role | Rule |
|---|---|---|
| `GEMINI_API_KEY` | **Canonical for the VPS**: direct Google Gemini API key. The only AI variable the compose file maps explicitly into the `api` container (`docker/docker-compose.yml`: `GEMINI_API_KEY: ${GEMINI_API_KEY:-}`). | Must be **non-empty**. A line `GEMINI_API_KEY=` (set-but-empty, the recorded VPS state in `docs/B23_FINAL_RECONCILIATION.md`) is treated as *unconfigured*. |
| `AI_INTEGRATIONS_GEMINI_API_KEY` + `AI_INTEGRATIONS_GEMINI_BASE_URL` | Legacy alias: the Replit AI-integration proxy pair. When **both** are set they take precedence over `GEMINI_API_KEY`. | Do not use on the VPS (no proxy there). If only the key half is set it is used as a direct key — avoid that ambiguity. |

Model: `gemini-2.5-flash` (the only approved model; `artifacts/api-server/src/config.ts`) — it is
not an environment variable and must not be changed.

Where the API reads them on the VPS: the compose env file of the api service (`env_file: .env`
next to the compose files — the file the B23 reconciliation calls "the env file", mode 600, the
same file the B25 ops tooling validates by digest and line count and never prints). Every variable in
that file reaches the container; `GEMINI_API_KEY` is additionally mapped explicitly.

## 2. Runbook (hidden input; the value is never echoed, logged or pasted)

Preconditions: you are the owner / operator with SSH access to the VPS; a maintenance window is not
required (only the api container is recreated; see step 7); no B25 hosted activation is running.

1. **Obtain the credential** in Google AI Studio (or the Google Cloud project that owns the
   Gemini API) under an account the company controls. Create a key dedicated to this deployment,
   restrict it to the Generative Language API if the console allows, and note its creation date.
2. **Store an offline copy** in the company password manager (entry: "Lead Capture Pro — Gemini
   production key — VPS"). Never store it in Git, chat, e-mail, a ticket or a screenshot.
3. **SSH to the VPS** with the deploy user and `cd` to the compose directory (the directory that
   holds `docker-compose.yml`, `compose.vps.yml` and the `.env` file).
4. **Stage the value with hidden input** (nothing is echoed; the value exists only in the shell
   variable and the file):
   ```bash
   umask 077
   read -r -s -p 'GEMINI_API_KEY (hidden): ' GEMINI_VALUE; echo
   [ -n "$GEMINI_VALUE" ] || { echo "empty — aborting"; unset GEMINI_VALUE; exit 1; }
   # replace the existing (empty) line, or append one; the temp file inherits the 600 mode via umask
   awk -v v="$GEMINI_VALUE" 'BEGIN{done=0} /^GEMINI_API_KEY=/{print "GEMINI_API_KEY=" v; done=1; next} {print} END{if(!done) print "GEMINI_API_KEY=" v}' .env > .env.tmp
   unset GEMINI_VALUE
   ```
5. **Preserve owner / group / mode** of the env file before swapping it in, then remove the temp
   file:
   ```bash
   chown --reference=.env .env.tmp && chmod --reference=.env .env.tmp && mv -f .env.tmp .env
   stat -c '%U:%G %a %s' .env        # expect the previous owner:group, mode 600, a larger size
   ```
6. **Validate presence and shape without printing the value**:
   ```bash
   grep -cE '^GEMINI_API_KEY=.{20,}$' .env            # expect 1 (non-empty line present)
   grep -cE '^AI_INTEGRATIONS_GEMINI_' .env            # expect 0 on the VPS (no proxy alias)
   grep -c  '^GEMINI_API_KEY=' .env                    # expect 1 (exactly one line)
   history -d "$(history 1 | awk '{print $1}')" 2>/dev/null || true   # keep the hidden read out of history if it was echoed by a shell option
   ```
7. **Recreate ONLY the api container** (sufficient: the variable is read at process start; no
   schema, volume, proxy or web change is involved):
   ```bash
   docker compose -f docker-compose.yml -f compose.vps.yml up -d --no-deps --force-recreate api
   ```
8. **Health / readiness**:
   ```bash
   curl -fsS http://127.0.0.1:18080/api/healthz; echo
   curl -fsS http://127.0.0.1:18080/api/readyz; echo      # expect database "ok", storage "ok"
   docker compose -f docker-compose.yml -f compose.vps.yml logs --since 2m api | grep -c 'Server listening'   # expect 1
   ```
   The api log must contain **no** line with the key; the product never logs it.
9. **AI health endpoint** (as a tenant admin, from the admin web or with a session token):
   `GET /api/ai/health` → `configured: true`, `status: "ok"`, `provider: "gemini"`,
   `model: "gemini-2.5-flash"`. (`platform_owner` accounts are firewalled from this tenant route by
   design — use a tenant account.)
10. **One server-side OCR smoke without exposing the secret**: run the opt-in live verification
    from a workstation that can reach the same-origin gateway of the deployment:
    `pnpm --filter @workspace/api-server exec tsx scripts/verify-ocr-live.ts` (Batch 7 tool: sends the
    bundled fixture images through the real `POST /api/scans` pipeline under a throwaway tenant and
    records acceptance / extraction / token usage; it reads **no** credential — the server holds it).
    Alternatively, from the mobile app on the device: the Scan tab notice disappears and one card
    scan completes; a failed scan now reports an OCR / image reason, never `AI_NOT_CONFIGURED`.

## 3. Rotation / revocation

Repeat steps 3–8 with the new value; revoke the old key in the Google console afterwards. To
disable AI deliberately, set the line back to `GEMINI_API_KEY=` (empty) and recreate the api
container: the product degrades to the documented 503 / notice behaviour.

## 4. What this runbook does NOT do

It does not stage any value itself, does not touch the B25 object-storage variables or the
`OBJECT_STORAGE_ENCRYPTION_KEY` line, does not change the mobile build, and does not deploy product
code. Deploying MOBILE-R1 / MOBILE-R2 (branch `claude/mobile-release-blockers`) is a separate,
later step that follows the B25 Stage 2A closure.
