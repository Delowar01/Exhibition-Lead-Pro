import { describe, expect, it } from "vitest";
import { combineQueryViewStates, resolveQueryViewState } from "./query-state";

// Batch 38 — the loading / error / ready decision used by the Home metrics
// grid, the Notifications list and the Lead edit form. These transitions are
// the contract the screens render; the screens themselves are not renderable
// under the node test environment (see the manual acceptance cases).

const idle = { isLoading: false, isError: false, isFetching: false, hasData: false };

describe("resolveQueryViewState", () => {
  it("first load → loading", () => {
    expect(resolveQueryViewState({ ...idle, isLoading: true, isFetching: true })).toBe("loading");
  });

  it("failed first load (nothing to show) → error, never ready/empty", () => {
    expect(resolveQueryViewState({ ...idle, isError: true })).toBe("error");
  });

  it("retry in flight after an error → loading (the error state does not linger during the retry)", () => {
    expect(resolveQueryViewState({ ...idle, isError: true, isFetching: true })).toBe("loading");
  });

  it("retry succeeded → ready", () => {
    expect(resolveQueryViewState({ ...idle, hasData: true })).toBe("ready");
  });

  it("failed background refresh with last-known data → ready (a failed refresh never blanks a loaded screen)", () => {
    expect(resolveQueryViewState({ ...idle, isError: true, hasData: true })).toBe("ready");
  });

  it("successful background refresh → ready without flicker", () => {
    expect(resolveQueryViewState({ ...idle, isFetching: true, hasData: true })).toBe("ready");
  });

  it("disabled / idle query (create mode of the lead form) → ready", () => {
    expect(resolveQueryViewState(idle)).toBe("ready");
  });

  it("Notifications: an empty list is 'ready' (EmptyState) only when the query succeeded", () => {
    // data = { notifications: [] } → hasData true → ready → EmptyState
    expect(resolveQueryViewState({ ...idle, hasData: true })).toBe("ready");
    // request failed, no data → error → ErrorState (never "no notifications")
    expect(resolveQueryViewState({ ...idle, isError: true })).toBe("error");
  });

  it("Lead edit form: a fetch failure is 'error' (no editor, so no save is reachable), not an empty editor", () => {
    expect(resolveQueryViewState({ ...idle, isError: true })).toBe("error");
    expect(resolveQueryViewState({ ...idle, isError: true, isFetching: true })).toBe("loading");
  });
});

describe("combineQueryViewStates (Home metrics: dashboard counts + pipeline values)", () => {
  it("loading wins over error and ready", () => {
    expect(combineQueryViewStates("ready", "loading")).toBe("loading");
    expect(combineQueryViewStates("error", "loading")).toBe("loading");
  });

  it("a failed pipeline query never renders the grid as zeros: error wins over ready", () => {
    expect(combineQueryViewStates("ready", "error")).toBe("error");
    expect(combineQueryViewStates("error", "ready")).toBe("error");
  });

  it("all sources ready → ready", () => {
    expect(combineQueryViewStates("ready", "ready")).toBe("ready");
  });
});
