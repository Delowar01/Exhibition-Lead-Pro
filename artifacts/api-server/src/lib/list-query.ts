// Phase 2.7 — shared list-query convention for collection endpoints.
//
// A single parser for pagination/sort/search so every list endpoint behaves the same:
// 1-based `page`, a bounded `pageSize` (alias `limit`), `sort` (+ `order`), and `search`
// (alias `q`). It hardens the previously ad-hoc inline parsing — a non-numeric or
// negative `limit` no longer yields NaN/negative offsets; it falls back to the default
// and is clamped to [1, maxPageSize]. Response shapes are unchanged: endpoints keep
// returning their existing envelopes; this only normalizes the inputs.

export interface ListQuery {
  page: number;
  pageSize: number;
  limit: number;
  offset: number;
  /**
   * True only when the caller explicitly asked for a page or page size (`page`,
   * `pageSize`, or `limit`). Endpoints that historically returned the full result
   * set can consult this to keep that behavior by default (return everything) and
   * apply `limit`/`offset` only when pagination was requested — so adding the shared
   * contract stays backward compatible with existing clients that pass no paging params.
   */
  paginated: boolean;
  search?: string;
  sort?: string;
  order: "asc" | "desc";
}

export interface ParseListQueryOptions {
  defaultPageSize?: number;
  maxPageSize?: number;
  allowedSort?: string[];
  defaultSort?: string;
}

function firstStr(value: unknown): string | undefined {
  if (Array.isArray(value)) value = value[0];
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const s = String(value).trim();
  return s === "" ? undefined : s;
}

function toInt(value: unknown): number | undefined {
  const s = firstStr(value);
  if (s === undefined) return undefined;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Parse a request query object into a normalized {@link ListQuery}. Accepts both the
 * canonical names (`page`, `pageSize`, `q`) and the established aliases (`limit`,
 * `search`) so it is a drop-in for existing endpoints.
 */
export function parseListQuery(query: unknown, options: ParseListQueryOptions = {}): ListQuery {
  const { defaultPageSize = 25, maxPageSize = 100, allowedSort, defaultSort } = options;
  const q = (query ?? {}) as Record<string, unknown>;

  const pageProvided = toInt(q.page) !== undefined;
  const sizeProvided = toInt(q.pageSize) !== undefined || toInt(q.limit) !== undefined;
  const page = Math.max(1, toInt(q.page) ?? 1);
  const requestedSize = toInt(q.pageSize) ?? toInt(q.limit) ?? defaultPageSize;
  const pageSize = Math.min(maxPageSize, Math.max(1, requestedSize));

  const requestedSort = firstStr(q.sort) ?? defaultSort;
  const sort = requestedSort && (!allowedSort || allowedSort.includes(requestedSort)) ? requestedSort : defaultSort;

  const order: "asc" | "desc" = firstStr(q.order)?.toLowerCase() === "asc" ? "asc" : "desc";

  return {
    page,
    pageSize,
    limit: pageSize,
    offset: (page - 1) * pageSize,
    paginated: pageProvided || sizeProvided,
    search: firstStr(q.q) ?? firstStr(q.search),
    sort,
    order,
  };
}
