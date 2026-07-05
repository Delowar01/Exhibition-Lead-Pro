import { describe, it, expect } from "vitest";

import { cleanFilters } from "./export-filters";

// Stage 4B — Import & Export Center: the mobile export must forward the screen's
// active filter state to the server (not an unscoped export). cleanFilters is the
// single normalization step every export payload flows through, so asserting it
// here pins the filter-forwarding contract.
describe("cleanFilters — export forwards active filter state", () => {
  it("forwards an active lead stage focus (the pipeline board's only scoping context)", () => {
    // leads.tsx passes { stage: highlightStage ?? undefined }; a focused stage
    // must reach the export API so the file matches what the user is looking at.
    expect(cleanFilters({ stage: "prospect" })).toEqual({ stage: "prospect" });
  });

  it("exports the full pipeline when there is no active stage focus", () => {
    expect(cleanFilters({ stage: undefined })).toEqual({});
  });

  it("forwards the contacts screen's active filters and drops empties/sentinels", () => {
    expect(
      cleanFilters({
        search: "acme",
        status: "all",
        temperature: "",
        eventId: null,
        sort: "recent",
      }),
    ).toEqual({ search: "acme", sort: "recent" });
  });

  it("stringifies numeric ids so eventId/assignedToId serialize correctly", () => {
    expect(cleanFilters({ eventId: 42, assignedToId: 7 })).toEqual({
      eventId: "42",
      assignedToId: "7",
    });
  });
});
