import { describe, expect, it } from "vitest";

import { mapLinkToMobileRoute } from "./notification-center";

// Shared deep-link mapping used by BOTH the Notification Center screen and the
// header-bell panel — server links are web-portal paths; only known routes get
// a mobile counterpart, everything else must be safely ignored.
describe("mapLinkToMobileRoute", () => {
  it("maps a lead detail link to the mobile pipeline detail route", () => {
    expect(mapLinkToMobileRoute("/admin/leads/42")).toBe("/pipeline/42");
  });

  it("maps a contact detail link to the mobile contact route", () => {
    expect(mapLinkToMobileRoute("/admin/contacts/7")).toBe("/contact/7");
  });

  it("maps list-level links to the mobile list screens", () => {
    expect(mapLinkToMobileRoute("/admin/leads")).toBe("/leads");
    expect(mapLinkToMobileRoute("/admin/leads?stage=won")).toBe("/leads");
    expect(mapLinkToMobileRoute("/admin/contacts")).toBe("/contacts");
    expect(mapLinkToMobileRoute("/admin/contacts?filter=hot")).toBe("/contacts");
  });

  it("prefers the detail route when an id is present", () => {
    expect(mapLinkToMobileRoute("/admin/leads/9/edit")).toBe("/pipeline/9");
    expect(mapLinkToMobileRoute("/admin/contacts/12/documents")).toBe("/contact/12");
  });

  it("ignores unknown admin routes", () => {
    expect(mapLinkToMobileRoute("/admin/settings")).toBeNull();
    expect(mapLinkToMobileRoute("/admin/reports/security")).toBeNull();
  });

  it("never opens external or non-admin links", () => {
    expect(mapLinkToMobileRoute("https://evil.example.com/admin/leads/1")).toBeNull();
    expect(mapLinkToMobileRoute("/settings")).toBeNull();
    expect(mapLinkToMobileRoute("")).toBeNull();
    expect(mapLinkToMobileRoute(null)).toBeNull();
    expect(mapLinkToMobileRoute(undefined)).toBeNull();
  });
});
