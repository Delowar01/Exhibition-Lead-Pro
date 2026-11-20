// Phase 2 Batch 1 — offline scan images as FILES instead of inline base64 in
// AsyncStorage.
//
// Why: the offline queue used to keep every captured card image inside one
// AsyncStorage value. On Android that store has a small total budget and cannot
// read back a single value larger than about 2 MB, so a few queued scans were
// enough to make the whole queue unreadable — and the next write then replaced
// it. Images now live as individual files in the app's private document
// directory; AsyncStorage only keeps a small index.
//
// Rules implemented here (pure: no React Native import, so the node test suite
// covers them through an in-memory driver):
//   • one directory per account (`<userId>_<companyId>`), derived only from a
//     well-formed tenant owner key — a scan image is never stored where another
//     account's code path would look for it;
//   • a write is published atomically (temporary file → size check → rename),
//     so an interrupted write never leaves a truncated image under a real name;
//   • a write is refused, with a classified reason, when the device is short of
//     space — the caller tells the user instead of pretending the scan was kept;
//   • nothing here deletes an image on its own: deletion happens only after a
//     confirmed upload or an explicit removal by the user.

/** Directory (inside the app's document directory) that holds every offline scan image. */
export const SCAN_DIR_NAME = "offline-scans";
/** Sub-directory for images of items that have no valid owner (kept, never used, never adopted). */
export const QUARANTINE_DIR_NAME = "_quarantine";
/** A new image is refused when less than this would remain free afterwards. */
export const MIN_FREE_BYTES = 25 * 1024 * 1024;

const TENANT_OWNER = /^([1-9][0-9]*)@([1-9][0-9]*)$/;
const OWNER_DIR = /^([1-9][0-9]*)_([1-9][0-9]*)$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.(jpg|png|webp|heic|img)$/;

/** `12@7` → `12_7`; null for anything that is not a tenant owner key. */
export function ownerDirName(owner: string | null | undefined): string | null {
  const m = typeof owner === "string" ? TENANT_OWNER.exec(owner) : null;
  return m ? `${m[1]}_${m[2]}` : null;
}

/** `12_7` → `12@7`; null for any other directory name. */
export function ownerOfDirName(name: string): string | null {
  const m = OWNER_DIR.exec(name);
  return m ? `${m[1]}@${m[2]}` : null;
}

export function isSafeScanId(id: unknown): id is string {
  return typeof id === "string" && SAFE_ID.test(id);
}

export function isSafeScanFileName(name: unknown): name is string {
  return typeof name === "string" && SAFE_FILE.test(name);
}

export interface ParsedImage {
  mime: string;
  /** Base64 payload without the data-URL prefix. */
  base64: string;
  /** Size of the decoded image in bytes. */
  bytes: number;
}

/** Decoded byte length of a base64 string (padding-aware). */
export function base64ByteLength(base64: string): number {
  const len = base64.length;
  if (len === 0) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((len * 3) / 4) - padding);
}

/**
 * Accepts what the camera produces: a data URL (`data:image/jpeg;base64,…`) or
 * bare base64 (treated as JPEG). Returns null for anything else — an empty
 * payload, a non-image data URL or characters outside the base64 alphabet.
 */
export function parseImageData(input: unknown): ParsedImage | null {
  if (typeof input !== "string" || input.length === 0) return null;
  let mime = "image/jpeg";
  let base64 = input;
  if (input.startsWith("data:")) {
    const comma = input.indexOf(",");
    if (comma < 0) return null;
    const header = input.slice(5, comma);
    const parts = header.split(";");
    if (!parts.includes("base64")) return null;
    mime = (parts[0] ?? "").trim().toLowerCase();
    if (!mime.startsWith("image/")) return null;
    base64 = input.slice(comma + 1);
  }
  if (base64.length === 0 || base64.length % 4 === 1) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  const bytes = base64ByteLength(base64);
  if (bytes === 0) return null;
  return { mime, base64, bytes };
}

export function imageExtension(mime: string): "jpg" | "png" | "webp" | "heic" | "img" {
  switch (mime) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/heic":
    case "image/heif":
      return "heic";
    default:
      return "img";
  }
}

export function mimeOfFileName(name: string): string {
  if (name.endsWith(".jpg")) return "image/jpeg";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".heic")) return "image/heic";
  return "image/jpeg";
}

export function toDataUrl(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`;
}

/** Why a scan image could not be stored or read. Each maps to one message for the user. */
export type ScanFileFailure =
  /** The device is (nearly) out of space. */
  | "storage-full"
  /** The file system refused the operation (no document directory, I/O error). */
  | "storage-unavailable"
  /** The captured image is empty or not an image. */
  | "image-invalid"
  /** The image file of a queued scan is no longer on the device. */
  | "image-missing";

export class ScanFileError extends Error {
  readonly name = "ScanFileError";
  readonly failure: ScanFileFailure;
  constructor(failure: ScanFileFailure, detail?: string) {
    super(detail ? `${failure}: ${detail}` : failure);
    Object.setPrototypeOf(this, new.target.prototype);
    this.failure = failure;
  }
}

/** Recognises the "no space left" family of file-system errors across Android/iOS wording. */
export function looksLikeDiskFull(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /ENOSPC|no space left|not enough (free )?(space|storage)|disk (is )?full|quota|SQLITE_FULL|database or disk is full/i.test(msg);
}

/** True when `bytes` more can be written while keeping the safety margin (unknown free space never blocks). */
export function hasRoomFor(freeBytes: number | null, bytes: number): boolean {
  if (freeBytes === null || !Number.isFinite(freeBytes)) return true;
  return freeBytes - bytes >= MIN_FREE_BYTES;
}

/**
 * The few file operations this feature needs. The real implementation
 * (lib/scan-file-driver.ts) maps them onto expo-file-system; tests use an
 * in-memory one that can also be told to fail.
 */
export interface ScanFileDriver {
  /** Absolute URI of the offline-scans directory, with a trailing slash; null when the platform has no document directory. */
  root(): string | null;
  ensureDir(uri: string): Promise<void>;
  writeBase64(uri: string, base64: string): Promise<void>;
  readBase64(uri: string): Promise<string>;
  move(from: string, to: string): Promise<void>;
  /** Idempotent: removing a missing file is not an error. */
  remove(uri: string): Promise<void>;
  /** Size in bytes, or null when the file does not exist. */
  size(uri: string): Promise<number | null>;
  /** Entry names of a directory; an absent directory lists as empty. */
  list(uri: string): Promise<string[]>;
  /** Free space on the device in bytes, or null when it cannot be determined. */
  freeBytes(): Promise<number | null>;
}

export interface StoredScanImage {
  /** File name inside the owner's directory (never a path). */
  file: string;
  bytes: number;
  mime: string;
}

export interface OrphanImage {
  /** Queue id recovered from the file name. */
  id: string;
  file: string;
  bytes: number;
}

export interface ScanFileStore {
  /** True when the platform offers a place to keep files (false on web previews). */
  available(): boolean;
  /**
   * Store one captured image for `owner` under the queue id. Resolves only once
   * the complete image is on disk under its final name. `owner === null` stores
   * into the quarantine directory (used solely while migrating ownerless items).
   */
  saveImage(owner: string | null, id: string, imageData: string): Promise<StoredScanImage>;
  /** The image as a data URL, exactly as it has to be sent to the scan endpoint. */
  loadImage(owner: string | null, file: string): Promise<string>;
  /** Remove one image (after a confirmed upload or an explicit removal). Never throws. */
  deleteImage(owner: string | null, file: string): Promise<boolean>;
  /** Complete images in the owner's directory whose id is not in `knownIds`. */
  findOrphans(owner: string, knownIds: ReadonlySet<string>): Promise<OrphanImage[]>;
  /**
   * Remove what an interrupted write left behind in the owner's directory:
   * temporary files older than `olderThanMs` (a write in progress is younger
   * and is left alone). Returns how many were removed. Never touches an image.
   */
  cleanPartials(owner: string, now: number, olderThanMs?: number): Promise<number>;
  /** Number of image files and their total size for one owner. */
  usage(owner: string): Promise<{ files: number; bytes: number }>;
  /**
   * Is a capture photo of ANY account stored on this device? Only a yes/no:
   * nothing is read, attributed or changed. `null` = it could not be found out.
   */
  anyImages(): Promise<boolean | null>;
}

const TMP_SUFFIX = ".part";
/** A temporary file older than this cannot belong to a write that is still running. */
const STALE_PARTIAL_MS = 10 * 60_000;

function dirFor(root: string, owner: string | null): string | null {
  if (owner === null) return `${root}${QUARANTINE_DIR_NAME}/`;
  const name = ownerDirName(owner);
  return name ? `${root}${name}/` : null;
}

export function createScanFileStore(driver: ScanFileDriver): ScanFileStore {
  function requireDir(owner: string | null): string {
    const root = driver.root();
    if (!root) throw new ScanFileError("storage-unavailable", "no document directory");
    const dir = dirFor(root, owner);
    if (!dir) throw new ScanFileError("storage-unavailable", "no account directory");
    return dir;
  }

  return {
    available: () => driver.root() !== null,

    async saveImage(owner, id, imageData) {
      if (!isSafeScanId(id)) throw new ScanFileError("image-invalid", "unsafe id");
      const parsed = parseImageData(imageData);
      if (!parsed) throw new ScanFileError("image-invalid");
      const dir = requireDir(owner);
      const file = `${id}.${imageExtension(parsed.mime)}`;
      const finalUri = `${dir}${file}`;
      const tmpUri = `${finalUri}${TMP_SUFFIX}`;

      let free: number | null = null;
      try {
        free = await driver.freeBytes();
      } catch {
        free = null; // unknown free space never blocks a capture
      }
      if (!hasRoomFor(free, parsed.bytes)) throw new ScanFileError("storage-full");

      try {
        await driver.ensureDir(dir);
        await driver.writeBase64(tmpUri, parsed.base64);
        const written = await driver.size(tmpUri);
        if (written === null || written !== parsed.bytes) {
          throw new ScanFileError("storage-unavailable", `incomplete write (${written ?? "missing"} of ${parsed.bytes} bytes)`);
        }
        await driver.move(tmpUri, finalUri);
        const published = await driver.size(finalUri);
        if (published !== parsed.bytes) throw new ScanFileError("storage-unavailable", "image not published");
      } catch (err) {
        // Leave nothing half-written behind; the caller reports the failure.
        await driver.remove(tmpUri).catch(() => {});
        if (err instanceof ScanFileError) {
          if (err.failure === "storage-unavailable" && /incomplete write/.test(err.message)) {
            // A short write is how a full disk usually shows up.
            let after: number | null = null;
            try {
              after = await driver.freeBytes();
            } catch {
              after = null;
            }
            if (after !== null && after < MIN_FREE_BYTES) throw new ScanFileError("storage-full");
          }
          throw err;
        }
        throw new ScanFileError(looksLikeDiskFull(err) ? "storage-full" : "storage-unavailable", err instanceof Error ? err.message : undefined);
      }
      return { file, bytes: parsed.bytes, mime: parsed.mime };
    },

    async loadImage(owner, file) {
      if (!isSafeScanFileName(file)) throw new ScanFileError("image-missing", "unsafe file name");
      const dir = requireDir(owner);
      const uri = `${dir}${file}`;
      let size: number | null;
      try {
        size = await driver.size(uri);
      } catch (err) {
        throw new ScanFileError("storage-unavailable", err instanceof Error ? err.message : undefined);
      }
      if (size === null || size === 0) throw new ScanFileError("image-missing");
      let base64: string;
      try {
        base64 = await driver.readBase64(uri);
      } catch (err) {
        throw new ScanFileError("storage-unavailable", err instanceof Error ? err.message : undefined);
      }
      if (!base64) throw new ScanFileError("image-missing");
      return toDataUrl(mimeOfFileName(file), base64);
    },

    async deleteImage(owner, file) {
      if (!isSafeScanFileName(file)) return false;
      const root = driver.root();
      const dir = root ? dirFor(root, owner) : null;
      if (!dir) return false;
      try {
        await driver.remove(`${dir}${file}`);
        return true;
      } catch {
        return false;
      }
    },

    async findOrphans(owner, knownIds) {
      const root = driver.root();
      const dir = root ? dirFor(root, owner) : null;
      if (!dir || ownerDirName(owner) === null) return [];
      let names: string[];
      try {
        names = await driver.list(dir);
      } catch {
        return [];
      }
      const out: OrphanImage[] = [];
      for (const name of names) {
        if (!isSafeScanFileName(name)) continue; // temporary and foreign files are never adopted
        const id = name.slice(0, name.lastIndexOf("."));
        if (knownIds.has(id)) continue;
        let bytes: number | null = null;
        try {
          bytes = await driver.size(`${dir}${name}`);
        } catch {
          bytes = null;
        }
        if (bytes === null || bytes === 0) continue;
        out.push({ id, file: name, bytes });
      }
      return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },

    async cleanPartials(owner, now, olderThanMs = STALE_PARTIAL_MS) {
      const root = driver.root();
      const dir = root ? dirFor(root, owner) : null;
      if (!dir || ownerDirName(owner) === null) return 0;
      let names: string[];
      try {
        names = await driver.list(dir);
      } catch {
        return 0;
      }
      let removed = 0;
      for (const name of names) {
        if (!name.endsWith(TMP_SUFFIX)) continue;
        const image = name.slice(0, -TMP_SUFFIX.length);
        if (!isSafeScanFileName(image)) continue; // not one of ours
        // The id starts with the capture time; a write that is still running is recent.
        const startedAt = Number(image.split("-")[0]);
        if (!Number.isFinite(startedAt) || now - startedAt < olderThanMs) continue;
        try {
          await driver.remove(`${dir}${name}`);
          removed += 1;
        } catch {
          /* tried again at the next start */
        }
      }
      return removed;
    },

    async anyImages() {
      const root = driver.root();
      if (!root) return false;
      let dirs: string[];
      try {
        dirs = await driver.list(root);
      } catch {
        return null;
      }
      let unknown = false;
      for (const name of dirs) {
        if (ownerOfDirName(name) === null) continue; // not an account's folder (quarantine, foreign)
        try {
          const files = await driver.list(`${root}${name}/`);
          if (files.some((f) => isSafeScanFileName(f))) return true;
        } catch {
          unknown = true;
        }
      }
      return unknown ? null : false;
    },

    async usage(owner) {
      const root = driver.root();
      const dir = root ? dirFor(root, owner) : null;
      if (!dir || ownerDirName(owner) === null) return { files: 0, bytes: 0 };
      let names: string[];
      try {
        names = await driver.list(dir);
      } catch {
        return { files: 0, bytes: 0 };
      }
      let files = 0;
      let bytes = 0;
      for (const name of names) {
        if (!isSafeScanFileName(name)) continue;
        const size = await driver.size(`${dir}${name}`).catch(() => null);
        if (size === null) continue;
        files += 1;
        bytes += size;
      }
      return { files, bytes };
    },
  };
}
