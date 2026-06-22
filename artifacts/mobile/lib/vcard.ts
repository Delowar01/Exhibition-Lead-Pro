import { Platform, Share } from "react-native";

import type { Contact } from "@workspace/api-client-react";

/** Escape a value per RFC 6350 vCard text rules. */
function esc(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function displayName(contact: Contact): string {
  if (contact.fullName) return contact.fullName;
  const parts = [contact.firstName, contact.lastName].filter(Boolean);
  return parts.length ? parts.join(" ") : "Contact";
}

/** Build an RFC 6350 vCard 3.0 string from a contact. */
export function buildVCard(contact: Contact): string {
  const first = contact.firstName ?? "";
  const last = contact.lastName ?? "";
  const lines: string[] = ["BEGIN:VCARD", "VERSION:3.0"];

  lines.push(`N:${esc(last)};${esc(first)};;;`);
  lines.push(`FN:${esc(displayName(contact))}`);
  if (contact.contactCompany) lines.push(`ORG:${esc(contact.contactCompany)}`);
  if (contact.jobTitle) lines.push(`TITLE:${esc(contact.jobTitle)}`);
  if (contact.mobile) lines.push(`TEL;TYPE=CELL:${esc(contact.mobile)}`);
  if (contact.officePhone) lines.push(`TEL;TYPE=WORK:${esc(contact.officePhone)}`);
  if (contact.email) lines.push(`EMAIL;TYPE=WORK:${esc(contact.email)}`);
  if (contact.website) lines.push(`URL:${esc(contact.website)}`);
  if (contact.linkedin) lines.push(`X-SOCIALPROFILE;TYPE=linkedin:${esc(contact.linkedin)}`);
  if (contact.address) lines.push(`ADR;TYPE=WORK:;;${esc(contact.address)};;;;${esc(contact.country ?? "")}`);
  if (contact.notes) lines.push(`NOTE:${esc(contact.notes)}`);

  lines.push("END:VCARD");
  return lines.join("\r\n");
}

function safeFileName(contact: Contact): string {
  const base = displayName(contact).replace(/[^a-zA-Z0-9-_]+/g, "_").replace(/^_+|_+$/g, "");
  return `${base || "contact"}.vcf`;
}

/**
 * Shares the contact as an importable .vcf file via the OS share sheet.
 *
 * On native builds it writes the vCard to the cache directory and opens
 * expo-sharing with the correct MIME/UTI so the recipient can import it
 * straight into their address book. When file sharing is unavailable
 * (web / Expo Go / device without a sharing provider) it falls back to the
 * React Native Share sheet with the vCard text payload so the action never
 * silently fails.
 */
export async function shareContactAsVCard(contact: Contact): Promise<void> {
  const vcard = buildVCard(contact);

  if (Platform.OS === "web") {
    await shareText(contact, vcard);
    return;
  }

  try {
    const Sharing = await import("expo-sharing");
    // expo-file-system@19 (SDK 54) made the class-based API the default export;
    // the functional helpers (writeAsStringAsync, deleteAsync) live under /legacy.
    const FileSystem = await import("expo-file-system/legacy");

    const canShareFile =
      typeof FileSystem.cacheDirectory === "string" && (await Sharing.isAvailableAsync());

    if (!canShareFile) {
      await shareText(contact, vcard);
      return;
    }

    const uri = `${FileSystem.cacheDirectory}${safeFileName(contact)}`;
    await FileSystem.writeAsStringAsync(uri, vcard, {
      encoding: FileSystem.EncodingType.UTF8,
    });

    try {
      await Sharing.shareAsync(uri, {
        mimeType: "text/vcard",
        dialogTitle: displayName(contact),
        UTI: "public.vcard",
      });
    } finally {
      try {
        await FileSystem.deleteAsync(uri, { idempotent: true });
      } catch {
        // Non-critical: the OS clears the cache directory eventually.
      }
    }
  } catch {
    // Native modules unavailable (e.g. Expo Go) — fall back to text sharing.
    await shareText(contact, vcard);
  }
}

async function shareText(contact: Contact, vcard: string): Promise<void> {
  try {
    await Share.share({ title: displayName(contact), message: vcard });
  } catch {
    // User dismissed or sharing unavailable — nothing else to do.
  }
}
