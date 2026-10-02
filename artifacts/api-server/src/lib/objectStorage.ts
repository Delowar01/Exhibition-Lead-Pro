// =============================================================================
// Google Cloud Storage client — Batch 25: TEMPORARY legacy / migration seam.
//
// The only remaining consumer is storage/gcs-driver.ts (through the registry's
// lazy import), used for (a) the legacy `gcs` primary driver until the hosted
// cutover, (b) fallback reads of pre-B25 objects, (c) strict mirrored writes
// during the transition and (d) the GCS → filesystem migration command. No
// feature module talks to this client directly any more; the former
// presigned-URL service (ObjectStorageService) and the unused ACL helper were
// removed — every product file now flows through services/storage.service.ts.
// This file, the @google-cloud/storage dependency and the GCS environment
// variables are removed only after the owner-approved, verified migration
// (docs/B25_OBJECT_STORAGE.md).
// =============================================================================
import { Storage } from "@google-cloud/storage";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

// GCS authentication — two supported modes:
//   1. Replit workspace sidecar (default when running on Replit): short-lived
//      external-account tokens. Requires no configuration inside the workspace.
//   2. Standard Google auth (portable/self-hosted): the client library's normal
//      credential chain — GOOGLE_APPLICATION_CREDENTIALS service-account file,
//      gcloud ADC, or GCE/GKE metadata.
// Selection is automatic: the sidecar is used only when running inside Replit
// (REPL_ID present) and no explicit Google credential is configured. Override
// with OBJECT_STORAGE_AUTH=replit-sidecar|google.
function shouldUseReplitSidecar(): boolean {
  const mode = process.env.OBJECT_STORAGE_AUTH;
  if (mode === "replit-sidecar") return true;
  if (mode === "google") return false;
  return Boolean(process.env.REPL_ID) && !process.env.GOOGLE_APPLICATION_CREDENTIALS;
}
const usingReplitSidecar = shouldUseReplitSidecar();

export const objectStorageClient = usingReplitSidecar
  ? new Storage({
      credentials: {
        audience: "replit",
        subject_token_type: "access_token",
        token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
        type: "external_account",
        credential_source: {
          url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
          format: {
            type: "json",
            subject_token_field_name: "access_token",
          },
        },
        universe_domain: "googleapis.com",
      },
      projectId: "",
    })
  : new Storage();
