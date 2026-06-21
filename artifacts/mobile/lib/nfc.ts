import { Platform } from "react-native";

import type { ExtractedCardData } from "@workspace/api-client-react";

import {
  hasAnyContactField,
  mergeExtracted,
  parseQr,
  parseVCard,
} from "./contact-parse";

// ─── Logging ─────────────────────────────────────────────────────────────────
// Tagged logs so they are easy to filter in Logcat / Metro:  adb logcat | grep NFC
const TAG = "[NFC]";
function log(msg: string, ...args: unknown[]): void {
  console.log(TAG, msg, ...args);
}
function warn(msg: string, ...args: unknown[]): void {
  console.warn(TAG, msg, ...args);
}
function err(msg: string, ...args: unknown[]): void {
  console.error(TAG, msg, ...args);
}

// ─── Public error surface ────────────────────────────────────────────────────
// Typed failure codes let the UI map each cause to a clear, crash-free message
// without leaking native error strings to end users.
export type NfcErrorCode =
  | "unsupported"
  | "disabled"
  | "empty"
  | "unreadable"
  | "no_contact"
  | "cancelled"
  | "unknown";

export class NfcError extends Error {
  code: NfcErrorCode;
  constructor(code: NfcErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "NfcError";
  }
}

// ─── Module loading ──────────────────────────────────────────────────────────
// Dynamic import keeps web and Expo Go (no native module) from crashing at
// module-eval time.  On the New Architecture the native package is still
// registered at startup by MainApplication; this import only loads the JS
// wrapper.  We memoize both the promise and the start() result.
type NfcModule = typeof import("react-native-nfc-manager");

let modPromise: Promise<NfcModule | null> | null = null;
let started = false;
let startErrorMsg: string | null = null; // preserved for readNfcCard() to log

async function loadNfc(): Promise<NfcModule | null> {
  if (Platform.OS === "web") {
    log("Platform is web — NFC not available.");
    return null;
  }
  if (!modPromise) {
    log("Importing react-native-nfc-manager…");
    modPromise = import("react-native-nfc-manager")
      .then(async (mod) => {
        if (!started) {
          try {
            log("Calling NfcManager.start()…");
            await mod.default.start();
            started = true;
            startErrorMsg = null;
            log("NfcManager.start() — OK");
          } catch (e) {
            startErrorMsg =
              String((e as { message?: string })?.message ?? e ?? "unknown");
            warn("NfcManager.start() FAILED:", startErrorMsg);
            // Don't block: isSupported()/isEnabled() may still answer correctly
            // even when start() throws on some Android builds.
          }
        }
        return mod;
      })
      .catch((e) => {
        err("Failed to import react-native-nfc-manager:", e);
        return null;
      });
  }
  return modPromise;
}

// ─── Support / enabled query ─────────────────────────────────────────────────
export async function getNfcSupport(): Promise<{
  supported: boolean;
  enabled: boolean;
}> {
  const mod = await loadNfc();
  if (!mod) {
    log("getNfcSupport: module unavailable → unsupported");
    return { supported: false, enabled: false };
  }
  try {
    const supported = await mod.default.isSupported();
    log("NfcManager.isSupported():", supported);
    if (!supported) return { supported: false, enabled: false };

    let enabled = true;
    if (Platform.OS === "android") {
      // iOS has no user-facing NFC toggle; hardware + entitlement are already
      // covered by isSupported().
      try {
        enabled = await mod.default.isEnabled();
        log("NfcManager.isEnabled():", enabled);
      } catch (e) {
        warn("NfcManager.isEnabled() threw — assuming enabled:", e);
        enabled = true;
      }
    }
    return { supported: true, enabled };
  } catch (e) {
    err("getNfcSupport error:", e);
    return { supported: false, enabled: false };
  }
}

// ─── NDEF record parsing ─────────────────────────────────────────────────────
type NdefRecord = { tnf: number; type: number[]; payload: number[]; id?: number[] };

function recordsToData(records: NdefRecord[], ndefLib: unknown): ExtractedCardData {
  const ndef = ndefLib as any;
  let data: ExtractedCardData = {};
  let vcard: string | null = null;
  const freeform: string[] = [];

  for (const [i, record] of (records ?? []).entries()) {
    try {
      const typeStr =
        record.type?.length ? ndef.util.bytesToString(record.type) : "";

      if (ndef.isType(record, ndef.TNF_WELL_KNOWN, ndef.RTD_TEXT)) {
        const text: string = ndef.text.decodePayload(record.payload);
        log(`  record[${i}] Well-Known Text:`, text?.slice(0, 120));
        if (text && /BEGIN:VCARD/i.test(text)) vcard = text;
        else if (text) freeform.push(text);
      } else if (ndef.isType(record, ndef.TNF_WELL_KNOWN, ndef.RTD_URI)) {
        const uri: string = ndef.uri.decodePayload(record.payload);
        log(`  record[${i}] Well-Known URI:`, uri?.slice(0, 120));
        if (uri) freeform.push(uri);
      } else {
        const body: string = ndef.util.bytesToString(record.payload);
        log(`  record[${i}] type="${typeStr}" body:`, body?.slice(0, 120));
        if (body && (/vcard/i.test(typeStr) || /BEGIN:VCARD/i.test(body)))
          vcard = body;
        else if (body) freeform.push(body);
      }
    } catch (e) {
      warn(`  record[${i}] parse error:`, e);
    }
  }

  if (vcard) data = parseVCard(vcard);
  for (const value of freeform) {
    if (!value.trim()) continue;
    data = mergeExtracted(data, parseQr(value));
  }
  return data;
}

// ─── Technology priority list ─────────────────────────────────────────────────
// The Android library (TagTechnologyRequest.connect) iterates this list in
// order and connects to the FIRST technology the physical tag supports.
//
// Why this list?
//   • Ndef        — primary target: NDEF-formatted NFC business cards (ISO 15693,
//                   NfcA/NfcB tags with an NDEF TLV layer)
//   • NfcA        — catch-all for ISO 14443-3A chips (Mifare Ultralight,
//                   NTAG21x, many modern business card inlays)
//   • IsoDep      — ISO 14443-4 / APDU-capable chips (some smart-card NFC cards)
//   • MifareUltralight — explicit Mifare Ultralight / NTAG handle
//   • MifareClassic   — older Mifare 1K/4K chips (less common for business cards
//                        but still found in some conference badges)
//   • NdefFormatable  — blank writable chips that present as formatable NDEF
//   • NfcB        — ISO 14443-3B chips
//   • NfcV        — ISO 15693 vicinity chips
//
// Requesting all of these means that if an NFC tag is physically detected by the
// OS (ACTION_TAG_DISCOVERED fires) the library will attempt to connect via the
// first matching technology instead of returning false and leaving the JS promise
// hanging forever.
const TECH_PRIORITY: string[] = [
  "Ndef",
  "NfcA",
  "IsoDep",
  "MifareUltralight",
  "MifareClassic",
  "NdefFormatable",
  "NfcB",
  "NfcV",
];

// ─── Main read function ──────────────────────────────────────────────────────
export async function readNfcCard(): Promise<ExtractedCardData> {
  log("readNfcCard() called");

  const mod = await loadNfc();
  if (!mod) {
    throw new NfcError("unsupported", "NFC isn't available on this device.");
  }
  const NfcManager = mod.default;
  const { NfcTech, Ndef } = mod;

  // ── 1. Support / enabled check ────────────────────────────────────────────
  const support = await getNfcSupport();
  log("Support check result:", JSON.stringify(support));

  if (!support.supported) {
    throw new NfcError("unsupported", "This device doesn't support NFC reading.");
  }
  if (!support.enabled) {
    throw new NfcError(
      "disabled",
      "NFC is turned off. Turn it on in your device settings, then try again.",
    );
  }

  if (startErrorMsg) {
    warn("Note: NfcManager.start() previously failed:", startErrorMsg);
  }

  // ── 2. Request technologies ───────────────────────────────────────────────
  // Resolve string keys against the NfcTech enum from the installed library so
  // we never send a value the library doesn't recognise.
  const techValues = TECH_PRIORITY.map(
    (k) => (NfcTech as Record<string, string>)[k],
  ).filter(Boolean);
  log("Requesting technologies:", techValues.join(", "));

  try {
    // The JS wrapper (NfcManagerAndroid) converts a string arg to [string], so
    // passing an array is the documented way to request multiple technologies.
    // techValues is string[], which is compatible with NfcTech[] at runtime
    // since NfcTech is a plain string enum — cast through unknown to satisfy TS.
    await NfcManager.requestTechnology(
      techValues as unknown as import("react-native-nfc-manager").NfcTech[],
      { alertMessage: "Hold your phone near the NFC business card." },
    );
    log("requestTechnology() resolved — tag session is open");

    // ── 3. Read tag ───────────────────────────────────────────────────────
    const tag = await NfcManager.getTag();
    log("getTag() raw result:", JSON.stringify(tag));

    // techTypes is an array of full Java class names, e.g.
    // "android.nfc.tech.NfcA", "android.nfc.tech.Ndef"
    const techTypes: string[] = (tag as any)?.techTypes ?? [];
    const shortTechs = techTypes
      .map((t) => t.replace(/^android\.nfc\.tech\./, ""))
      .join(", ");
    log("Tag techTypes:", shortTechs || "(none reported)");

    // ── 4. NDEF records ───────────────────────────────────────────────────
    const records = (tag as { ndefMessage?: NdefRecord[] } | null)?.ndefMessage;
    log("NDEF records on tag:", records ? records.length : "none");

    if (!records || records.length === 0) {
      // The tag was detected and we connected to it — but it carries no NDEF
      // data.  Report exactly which NFC technology the chip advertises so the
      // user knows what kind of card they have.
      if (shortTechs) {
        warn("Tag detected but no NDEF message. Tech:", shortTechs);
        throw new NfcError(
          "empty",
          `This tag has no contact data. Detected tag type: ${shortTechs}. ` +
            "NFC business cards must be NDEF-formatted (most are).",
        );
      }
      throw new NfcError(
        "empty",
        "This tag is empty or has no readable contact data.",
      );
    }

    // ── 5. Parse ──────────────────────────────────────────────────────────
    log(`Parsing ${records.length} NDEF record(s)…`);
    const data = recordsToData(records, Ndef);
    const filledFields = Object.keys(data).filter(
      (k) => (data as Record<string, unknown>)[k],
    );
    log("Parsed fields:", filledFields.join(", ") || "(none)");

    if (!hasAnyContactField(data)) {
      throw new NfcError("no_contact", "No contact details were found on this tag.");
    }

    log("Read success —", filledFields.length, "field(s) extracted");
    return data;
  } catch (e) {
    if (e instanceof NfcError) throw e;

    // Surface the native error string so it appears in logs and in the UI
    // error message (debug builds) rather than being silently swallowed.
    const nativeMsg = String((e as { message?: string })?.message ?? e ?? "");
    err("NFC native error:", nativeMsg);

    if (/cancel/i.test(nativeMsg) || /user cancel/i.test(nativeMsg)) {
      throw new NfcError("cancelled", "Scan cancelled.");
    }
    throw new NfcError(
      "unreadable",
      `Couldn't read this NFC tag. Move it closer and try again. (${nativeMsg})`,
    );
  } finally {
    try {
      await NfcManager.cancelTechnologyRequest();
      log("cancelTechnologyRequest() — done");
    } catch {
      /* noop */
    }
  }
}

// ─── Cancel ──────────────────────────────────────────────────────────────────
export async function cancelNfcScan(): Promise<void> {
  log("cancelNfcScan() called");
  const mod = await loadNfc();
  if (!mod) return;
  try {
    await mod.default.cancelTechnologyRequest();
    log("cancelNfcScan() — done");
  } catch {
    /* noop */
  }
}
