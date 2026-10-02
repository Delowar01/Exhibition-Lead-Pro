// =============================================================================
// Batch 25 — canonical object keys. Every object stored through the central
// storage boundary lives under a tenant-prefixed key that is built server-side
// from validated components and is never taken from a client:
//
//   tenants/<companyId>/documents/<id>
//   tenants/<companyId>/exports/<id>
//   tenants/<companyId>/reports/<id>
//   tenants/<companyId>/scans/<id>
//   tenants/<companyId>/branding/<id>.<ext>
//   health/<id>                       (readiness probe namespace)
//
// A key is a sequence of 2–6 components separated by "/". Each component is
// matched against a strict allow-list (ASCII letters, digits, ".", "_", "-";
// no leading dot), so "..", encoded traversal ("%2e%2e"), backslashes, NUL
// bytes, drive letters and absolute paths can never form a valid key.
// =============================================================================

export const STORAGE_KINDS = ["document", "export", "report", "scan_image", "branding_logo"] as const;
export type StorageKind = (typeof STORAGE_KINDS)[number];

export const KIND_DIRECTORY: Record<StorageKind, string> = {
  document: "documents",
  export: "exports",
  report: "reports",
  scan_image: "scans",
  branding_logo: "branding",
};

export function isStorageKind(v: string): v is StorageKind {
  return (STORAGE_KINDS as readonly string[]).includes(v);
}

const COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_COMPONENTS = 6;
const MIN_COMPONENTS = 2;

export class InvalidStorageKeyError extends Error {
  readonly code = "STORAGE_INVALID_KEY" as const;
  constructor() {
    super("Invalid storage key");
    this.name = "InvalidStorageKeyError";
  }
}

/** One path component: strict allow-list, never ".", "..", hidden names or separators. */
export function isValidKeyComponent(component: string): boolean {
  if (typeof component !== "string" || component.length === 0) return false;
  if (!COMPONENT.test(component)) return false;
  if (component.includes("..")) return false;
  return true;
}

/** True when `key` is a well-formed canonical key (tenants/… or health/…). */
export function isValidStorageKey(key: string): boolean {
  if (typeof key !== "string" || key.length === 0 || key.length > 512) return false;
  if (key.startsWith("/") || key.endsWith("/")) return false;
  const parts = key.split("/");
  if (parts.length < MIN_COMPONENTS || parts.length > MAX_COMPONENTS) return false;
  if (!parts.every(isValidKeyComponent)) return false;
  if (parts[0] === "health") return parts.length === 2;
  if (parts[0] !== "tenants") return false;
  if (!/^[1-9][0-9]{0,11}$/.test(parts[1])) return false;
  if (parts.length < 4) return false;
  return (Object.values(KIND_DIRECTORY) as string[]).includes(parts[2]);
}

export function assertValidStorageKey(key: string): void {
  if (!isValidStorageKey(key)) throw new InvalidStorageKeyError();
}

/** Build the canonical tenant key for an object. Throws on any invalid input. */
export function tenantKey(kind: StorageKind, companyId: number, objectId: string, extension?: string): string {
  if (!Number.isInteger(companyId) || companyId <= 0) throw new InvalidStorageKeyError();
  if (!isValidKeyComponent(objectId)) throw new InvalidStorageKeyError();
  let file = objectId;
  if (extension !== undefined) {
    if (!/^[a-z0-9]{1,8}$/.test(extension)) throw new InvalidStorageKeyError();
    file = `${objectId}.${extension}`;
  }
  const key = `tenants/${companyId}/${KIND_DIRECTORY[kind]}/${file}`;
  assertValidStorageKey(key);
  return key;
}

export function healthKey(id: string): string {
  const key = `health/${id}`;
  assertValidStorageKey(key);
  return key;
}

export interface ParsedTenantKey {
  companyId: number;
  kind: StorageKind;
  file: string;
}

/** Parse a canonical tenant key back into its ownership (null for health keys / invalid keys). */
export function parseTenantKey(key: string): ParsedTenantKey | null {
  if (!isValidStorageKey(key)) return null;
  const parts = key.split("/");
  if (parts[0] !== "tenants") return null;
  const dir = parts[2];
  const kind = (Object.keys(KIND_DIRECTORY) as StorageKind[]).find((k) => KIND_DIRECTORY[k] === dir);
  if (!kind) return null;
  return { companyId: Number(parts[1]), kind, file: parts.slice(3).join("/") };
}

/** True when the key belongs to the given tenant (server-side ownership check). */
export function keyBelongsToTenant(key: string, companyId: number): boolean {
  const parsed = parseTenantKey(key);
  return parsed !== null && parsed.companyId === companyId;
}
