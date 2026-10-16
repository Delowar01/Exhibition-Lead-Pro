import { describe, expect, it } from "vitest";
import { chunkContactIds, eventActionKey, MAX_BULK_CONTACTS, parseContactIds, toggleSelected } from "./event-assign-model";
import en from "./i18n/locales/en.json";
import ar from "./i18n/locales/ar.json";

// MOBILE-R2 — later event assignment helpers.

describe("parseContactIds", () => {
  it("accepts a csv route param, drops junk and duplicates, keeps order", () => {
    expect(parseContactIds("12,15, 9,12,abc,-1,0,3.5")).toEqual([12, 15, 9]);
    expect(parseContactIds(["4", "5,6"])).toEqual([4, 5, 6]);
    expect(parseContactIds(undefined)).toEqual([]);
    expect(parseContactIds("")).toEqual([]);
  });
});

describe("chunkContactIds", () => {
  it("splits a large selection into server-sized calls", () => {
    const ids = Array.from({ length: 450 }, (_, i) => i + 1);
    const chunks = chunkContactIds(ids);
    expect(chunks.map((c) => c.length)).toEqual([MAX_BULK_CONTACTS, MAX_BULK_CONTACTS, 50]);
    expect(chunks.flat()).toEqual(ids);
    expect(chunkContactIds([])).toEqual([]);
  });
});

describe("eventActionKey / toggleSelected", () => {
  it("labels the detail action by the contact's current event and both labels exist in EN and AR", () => {
    expect(eventActionKey(null)).toBe("contacts.assignToEvent");
    expect(eventActionKey(undefined)).toBe("contacts.assignToEvent");
    expect(eventActionKey(7)).toBe("contacts.changeEvent");
    for (const k of ["assignToEvent", "changeEvent", "selectedCount", "eventAssignTitle", "eventAssignSub", "eventAssignNone", "eventAssignNoneSub", "eventAssignedTitle", "eventAssignedBody", "eventAssignFailedBody"]) {
      expect(typeof (en as unknown as Record<string, Record<string, unknown>>).contacts[k], `en contacts.${k}`).toBe("string");
      expect(typeof (ar as unknown as Record<string, Record<string, unknown>>).contacts[k], `ar contacts.${k}`).toBe("string");
    }
    for (const k of ["noEventWarnTitle", "noEventWarnBody", "noEventSelect", "noEventContinue", "noEventAcknowledgedHint", "noEventBadge"]) {
      expect(typeof (en as unknown as Record<string, Record<string, unknown>>).capture[k], `en capture.${k}`).toBe("string");
      expect(typeof (ar as unknown as Record<string, Record<string, unknown>>).capture[k], `ar capture.${k}`).toBe("string");
    }
    expect((en as unknown as Record<string, Record<string, string>>).capture.noEventWarnTitle).toBe("No Event Selected");
    expect((en as unknown as Record<string, Record<string, string>>).capture.noEventWarnBody).toBe(
      "You are about to scan this contact without assigning it to an event. You can assign the contact to an event later.",
    );
    expect((en as unknown as Record<string, Record<string, string>>).capture.noEventSelect).toBe("Select Event");
    expect((en as unknown as Record<string, Record<string, string>>).capture.noEventContinue).toBe("Continue with No Event");
  });

  it("toggles ids immutably", () => {
    const a = toggleSelected(new Set([1]), 2);
    expect([...a]).toEqual([1, 2]);
    expect([...toggleSelected(a, 1)]).toEqual([2]);
    expect(toggleSelected(new Set([3]), 3).size).toBe(0);
  });
});
