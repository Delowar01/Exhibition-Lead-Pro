import { Platform } from "react-native";

import type { ExtractedCardData } from "@workspace/api-client-react";

import {
  hasAnyContactField,
  mergeExtracted,
  parseQr,
  parseVCard,
} from "./contact-parse";

// Typed failure surface so the screen can map each cause to a clear, crash-free
// message (empty tag, unsupported payload, corrupted data, NFC disabled, no
// hardware) without leaking native error strings to the user.
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

type NfcModule = typeof import("react-native-nfc-manager");

let modPromise: Promise<NfcModule | null> | null = null;
let started = false;

// The native module does not exist on web and may be absent in Expo Go. Loading
// it lazily (instead of a top-level import) keeps those targets from crashing at
// module-eval time, so the screen can show a graceful "NFC unavailable" message.
async function loadNfc(): Promise<NfcModule | null> {
  if (Platform.OS === "web") return null;
  if (!modPromise) {
    modPromise = import("react-native-nfc-manager")
      .then(async (mod) => {
        try {
          if (!started) {
            await mod.default.start();
            started = true;
          }
        } catch {
          /* start failures surface later via isSupported() */
        }
        return mod;
      })
      .catch(() => null);
  }
  return modPromise;
}

export async function getNfcSupport(): Promise<{
  supported: boolean;
  enabled: boolean;
}> {
  const mod = await loadNfc();
  if (!mod) return { supported: false, enabled: false };
  try {
    const supported = await mod.default.isSupported();
    if (!supported) return { supported: false, enabled: false };
    let enabled = true;
    if (Platform.OS === "android") {
      // iOS has no "NFC disabled" toggle to query; Core NFC is gated by hardware
      // + entitlement, both covered by isSupported above.
      try {
        enabled = await mod.default.isEnabled();
      } catch {
        enabled = true;
      }
    }
    return { supported: true, enabled };
  } catch {
    return { supported: false, enabled: false };
  }
}

type NdefRecord = { tnf: number; type: number[]; payload: number[]; id?: number[] };

// Convert an NDEF message into contact fields. Supports vCard (well-known Text
// record, MIME text/vcard, or any record whose body is a VCARD), NDEF Text
// records, and NDEF URI records. Unknown record types fall back to a UTF-8
// decode so future/standard NFC business-card layouts still extract something.
// The parser is intentionally additive: drop in another `else if` branch to
// support a new record type.
function recordsToData(records: NdefRecord[], ndefLib: unknown): ExtractedCardData {
  const ndef = ndefLib as any;
  let data: ExtractedCardData = {};
  let vcard: string | null = null;
  const freeform: string[] = [];

  for (const record of records ?? []) {
    try {
      const typeStr =
        record.type && record.type.length
          ? ndef.util.bytesToString(record.type)
          : "";

      if (ndef.isType(record, ndef.TNF_WELL_KNOWN, ndef.RTD_TEXT)) {
        const text: string = ndef.text.decodePayload(record.payload);
        if (text && /BEGIN:VCARD/i.test(text)) vcard = text;
        else if (text) freeform.push(text);
      } else if (ndef.isType(record, ndef.TNF_WELL_KNOWN, ndef.RTD_URI)) {
        const uri: string = ndef.uri.decodePayload(record.payload);
        if (uri) freeform.push(uri);
      } else {
        const body: string = ndef.util.bytesToString(record.payload);
        if (body && (/vcard/i.test(typeStr) || /BEGIN:VCARD/i.test(body))) vcard = body;
        else if (body) freeform.push(body);
      }
    } catch {
      /* skip a corrupted record but keep parsing the rest of the message */
    }
  }

  if (vcard) data = parseVCard(vcard);
  for (const value of freeform) {
    if (!value.trim()) continue;
    data = mergeExtracted(data, parseQr(value));
  }
  return data;
}

export async function readNfcCard(): Promise<ExtractedCardData> {
  const mod = await loadNfc();
  if (!mod) {
    throw new NfcError("unsupported", "NFC isn't available on this device.");
  }
  const NfcManager = mod.default;
  const { NfcTech, Ndef } = mod;

  const support = await getNfcSupport();
  if (!support.supported) {
    throw new NfcError("unsupported", "This device doesn't support NFC reading.");
  }
  if (!support.enabled) {
    throw new NfcError(
      "disabled",
      "NFC is turned off. Turn it on in your device settings, then try again.",
    );
  }

  try {
    await NfcManager.requestTechnology(NfcTech.Ndef, {
      alertMessage: "Hold your phone near the NFC business card.",
    });
    const tag = await NfcManager.getTag();
    const records = (tag as { ndefMessage?: NdefRecord[] } | null)?.ndefMessage;
    if (!records || records.length === 0) {
      throw new NfcError("empty", "This tag is empty or has no readable contact data.");
    }
    const data = recordsToData(records, Ndef);
    if (!hasAnyContactField(data)) {
      throw new NfcError("no_contact", "No contact details were found on this tag.");
    }
    return data;
  } catch (err) {
    if (err instanceof NfcError) throw err;
    const message = String((err as { message?: string })?.message ?? err ?? "");
    if (/cancel/i.test(message)) throw new NfcError("cancelled", "Scan cancelled.");
    throw new NfcError(
      "unreadable",
      "Couldn't read this NFC tag. Move it closer and try again.",
    );
  } finally {
    try {
      await NfcManager.cancelTechnologyRequest();
    } catch {
      /* noop */
    }
  }
}

export async function cancelNfcScan(): Promise<void> {
  const mod = await loadNfc();
  if (!mod) return;
  try {
    await mod.default.cancelTechnologyRequest();
  } catch {
    /* noop */
  }
}
