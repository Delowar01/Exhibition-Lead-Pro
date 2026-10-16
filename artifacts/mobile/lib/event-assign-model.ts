// MOBILE-R2 — later event assignment (single contact from the detail screen, many
// from the list's multi-select). Pure helpers shared by the assign screen and tests.

/** Parse the `ids` route param ("12,15,9") into unique positive integers, in order. */
export function parseContactIds(raw: string | string[] | undefined): number[] {
  const text = Array.isArray(raw) ? raw.join(",") : (raw ?? "");
  const out: number[] = [];
  for (const part of text.split(",")) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

/** The server accepts at most 200 contacts per call. */
export const MAX_BULK_CONTACTS = 200;

export function chunkContactIds(ids: number[], size = MAX_BULK_CONTACTS): number[][] {
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

/** Label of the detail-screen action: "Assign to Event" without an event, "Change Event" with one. */
export function eventActionKey(eventId: number | null | undefined): "contacts.assignToEvent" | "contacts.changeEvent" {
  return eventId == null ? "contacts.assignToEvent" : "contacts.changeEvent";
}

/** Toggle one id in a selection set (returns a new Set; the empty set leaves selection mode). */
export function toggleSelected(selected: ReadonlySet<number>, id: number): Set<number> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
