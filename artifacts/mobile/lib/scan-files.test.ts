// Phase 2 Batch 1 — offline scan images as files (lib/scan-files.ts), against an
// in-memory file system that fails the way a phone does.
import { describe, expect, it } from "vitest";

import { createMemoryScanDriver, fakeImage } from "./testing/memory-scan-driver";
import {
  MIN_FREE_BYTES,
  QUARANTINE_DIR_NAME,
  ScanFileError,
  base64ByteLength,
  createScanFileStore,
  hasRoomFor,
  imageExtension,
  isSafeScanFileName,
  isSafeScanId,
  looksLikeDiskFull,
  ownerDirName,
  ownerOfDirName,
  parseImageData,
} from "./scan-files";

const A = "11@1";
const B = "22@2";
const ROOT = "file:///data/app/files/offline-scans/";

async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ScanFileError) return err.failure;
    throw err;
  }
  throw new Error("expected a ScanFileError");
}

describe("account directories", () => {
  it("derive from a tenant owner key only, and map back", () => {
    expect(ownerDirName("11@1")).toBe("11_1");
    expect(ownerOfDirName("11_1")).toBe("11@1");
    for (const bad of [null, undefined, "", "11", "11@platform", "0@1", "11@0", "11@1@2", "../11@1", "11@1/..", " 11@1"]) {
      expect(ownerDirName(bad as string), String(bad)).toBeNull();
    }
    for (const bad of ["", "11", "_quarantine", "11_1_2", "..", "a_b", "11_1/x"]) expect(ownerOfDirName(bad), bad).toBeNull();
  });

  it("only safe ids and file names are ever turned into a path", () => {
    expect(isSafeScanId("1763630000000-ab12cd3")).toBe(true);
    for (const bad of ["", "../x", "a/b", "a\\b", "a b", ".hidden", "x".repeat(200), null, 7]) expect(isSafeScanId(bad), String(bad)).toBe(false);
    expect(isSafeScanFileName("1763630000000-ab12cd3.jpg")).toBe(true);
    for (const bad of ["x.jpg.part", "../x.jpg", "x.exe", "x", ".jpg", "a/b.jpg", "x.JPG"]) expect(isSafeScanFileName(bad), bad).toBe(false);
  });
});

describe("what counts as an image", () => {
  it("accepts a data URL and bare base64, and computes the decoded size", () => {
    expect(parseImageData("data:image/jpeg;base64,QUJD")).toEqual({ mime: "image/jpeg", base64: "QUJD", bytes: 3 });
    expect(parseImageData("data:image/png;base64,QUI=")).toEqual({ mime: "image/png", base64: "QUI=", bytes: 2 });
    expect(parseImageData("QQ==")).toEqual({ mime: "image/jpeg", base64: "QQ==", bytes: 1 });
    expect(base64ByteLength("")).toBe(0);
  });

  it("rejects everything else instead of writing garbage", () => {
    for (const bad of ["", "data:image/jpeg;base64,", "data:text/html;base64,QUJD", "data:image/jpeg,QUJD", "not base64!", "QUJDR", null, 42, {}]) {
      expect(parseImageData(bad), String(bad)).toBeNull();
    }
  });

  it("maps image types to a fixed set of extensions", () => {
    expect(imageExtension("image/jpeg")).toBe("jpg");
    expect(imageExtension("image/png")).toBe("png");
    expect(imageExtension("image/webp")).toBe("webp");
    expect(imageExtension("image/heic")).toBe("heic");
    expect(imageExtension("image/x-unknown")).toBe("img");
  });
});

describe("saving and reading an image", () => {
  it("round-trips the exact image and keeps it in the owner's directory", async () => {
    const driver = createMemoryScanDriver();
    const store = createScanFileStore(driver);
    const image = fakeImage(4200, "Q");
    const saved = await store.saveImage(A, "100-a", image);
    expect(saved).toEqual({ file: "100-a.jpg", bytes: 4200, mime: "image/jpeg" });
    expect([...driver.files.keys()]).toEqual([`${ROOT}11_1/100-a.jpg`]);
    expect(await store.loadImage(A, saved.file)).toBe(image);
  });

  it("never lets one account read another account's image, even with the right file name", async () => {
    const driver = createMemoryScanDriver();
    const store = createScanFileStore(driver);
    const saved = await store.saveImage(A, "100-a", fakeImage());
    expect(await failure(store.loadImage(B, saved.file))).toBe("image-missing");
    expect(await store.findOrphans(B, new Set())).toEqual([]);
    expect(await store.usage(B)).toEqual({ files: 0, bytes: 0 });
    expect(await store.deleteImage(B, saved.file)).toBe(true); // removing a file B does not have changes nothing…
    expect(driver.files.has(`${ROOT}11_1/100-a.jpg`)).toBe(true); // …A's image is still there
  });

  it("refuses an owner that is not a tenant account (platform operator, malformed, traversal)", async () => {
    const store = createScanFileStore(createMemoryScanDriver());
    for (const owner of ["7@platform", "", "../11@1", "11@1/../22@2"]) {
      expect(await failure(store.saveImage(owner, "100-a", fakeImage())), owner).toBe("storage-unavailable");
    }
    expect(await failure(store.saveImage(A, "../../etc", fakeImage()))).toBe("image-invalid");
    expect(await failure(store.loadImage(A, "../22_2/100-a.jpg"))).toBe("image-missing");
  });

  it("ownerless (quarantined) images go to a separate directory nobody's orphan scan looks at", async () => {
    const driver = createMemoryScanDriver();
    const store = createScanFileStore(driver);
    await store.saveImage(null, "100-q", fakeImage());
    expect([...driver.files.keys()]).toEqual([`${ROOT}${QUARANTINE_DIR_NAME}/100-q.jpg`]);
    expect(await store.findOrphans(A, new Set())).toEqual([]);
  });
});

describe("a write is all or nothing", () => {
  it("a write that throws leaves no file behind", async () => {
    const driver = createMemoryScanDriver();
    const store = createScanFileStore(driver);
    driver.failNextWrite = new Error("EIO: i/o error");
    expect(await failure(store.saveImage(A, "100-a", fakeImage()))).toBe("storage-unavailable");
    expect(driver.files.size).toBe(0);
  });

  it("a write cut short is detected, reported and cleaned up — never published as a real image", async () => {
    const driver = createMemoryScanDriver();
    const store = createScanFileStore(driver);
    driver.truncateNextWrite = 400;
    expect(await failure(store.saveImage(A, "100-a", fakeImage(4000)))).toBe("storage-unavailable");
    expect(driver.files.size).toBe(0);
  });

  it("a write cut short on a nearly full device is reported as STORAGE FULL", async () => {
    const driver = createMemoryScanDriver();
    const store = createScanFileStore(driver);
    driver.free = MIN_FREE_BYTES + 10_000; // enough to start…
    driver.truncateNextWrite = 400;
    const attempt = store.saveImage(A, "100-a", fakeImage(4000));
    driver.free = 1024; // …and gone while writing
    expect(await failure(attempt)).toBe("storage-full");
    expect(driver.files.size).toBe(0);
  });

  it("the device's own no-space error is classified as storage-full", async () => {
    const driver = createMemoryScanDriver();
    const store = createScanFileStore(driver);
    driver.failNextWrite = new Error("write failed: ENOSPC (No space left on device)");
    expect(await failure(store.saveImage(A, "100-a", fakeImage()))).toBe("storage-full");
    expect(looksLikeDiskFull(new Error("database or disk is full"))).toBe(true);
    expect(looksLikeDiskFull(new Error("Permission denied"))).toBe(false);
  });

  it("is refused up front when the safety margin would be eaten — nothing is written", async () => {
    const driver = createMemoryScanDriver();
    const store = createScanFileStore(driver);
    driver.free = MIN_FREE_BYTES - 1;
    expect(await failure(store.saveImage(A, "100-a", fakeImage()))).toBe("storage-full");
    expect(driver.writes).toBe(0);
    expect(hasRoomFor(null, 5_000_000)).toBe(true); // unknown free space never blocks a capture
    expect(hasRoomFor(MIN_FREE_BYTES + 100, 100)).toBe(true);
    expect(hasRoomFor(MIN_FREE_BYTES + 99, 100)).toBe(false);
  });

  it("an invalid image is refused before anything touches the disk", async () => {
    const driver = createMemoryScanDriver();
    const store = createScanFileStore(driver);
    expect(await failure(store.saveImage(A, "100-a", "data:text/plain;base64,QUJD"))).toBe("image-invalid");
    expect(await failure(store.saveImage(A, "100-a", ""))).toBe("image-invalid");
    expect(driver.writes).toBe(0);
  });

  it("without a document directory (web preview) the store says so instead of failing", async () => {
    const driver = createMemoryScanDriver(null);
    const store = createScanFileStore(driver);
    expect(store.available()).toBe(false);
    expect(await failure(store.saveImage(A, "100-a", fakeImage()))).toBe("storage-unavailable");
  });
});

describe("reading problems are told apart", () => {
  it("a missing image is image-missing; a read error is storage-unavailable", async () => {
    const driver = createMemoryScanDriver();
    const store = createScanFileStore(driver);
    const saved = await store.saveImage(A, "100-a", fakeImage());
    driver.failReads = new Error("EIO");
    expect(await failure(store.loadImage(A, saved.file))).toBe("storage-unavailable");
    driver.failReads = null;
    await store.deleteImage(A, saved.file);
    expect(await failure(store.loadImage(A, saved.file))).toBe("image-missing");
  });

  it("deleting never throws, even when the device refuses", async () => {
    const driver = createMemoryScanDriver();
    const store = createScanFileStore(driver);
    const saved = await store.saveImage(A, "100-a", fakeImage());
    driver.failRemoves = new Error("EBUSY");
    expect(await store.deleteImage(A, saved.file)).toBe(false);
    expect(driver.files.size).toBe(1); // still there, to be cleaned up later
  });
});

describe("images the queue does not list", () => {
  it("finds complete images of that owner only, skipping listed ids and unfinished writes", async () => {
    const driver = createMemoryScanDriver();
    const store = createScanFileStore(driver);
    await store.saveImage(A, "100-a", fakeImage(3000));
    await store.saveImage(A, "200-b", fakeImage(6000));
    await store.saveImage(B, "300-c", fakeImage());
    driver.files.set(`${ROOT}11_1/400-d.jpg.part`, "QUJD"); // an interrupted write
    driver.files.set(`${ROOT}11_1/notes.txt`, "QUJD"); // not ours
    driver.files.set(`${ROOT}11_1/500-e.jpg`, ""); // empty
    expect(await store.findOrphans(A, new Set(["100-a"]))).toEqual([{ id: "200-b", file: "200-b.jpg", bytes: 6000 }]);
    expect(await store.usage(A)).toEqual({ files: 3, bytes: 9000 });
  });
});

describe("a long scanning session", () => {
  it("600 scans of two accounts stay separate, complete and readable; the index never holds an image", async () => {
    const driver = createMemoryScanDriver();
    const store = createScanFileStore(driver);
    const saved: Array<{ owner: string; file: string; image: string }> = [];
    for (let i = 0; i < 600; i += 1) {
      const owner = i % 3 === 0 ? B : A;
      const image = fakeImage(2000 + (i % 7) * 300, "ABCDEFGH"[i % 8]!);
      const s = await store.saveImage(owner, `${1763630000000 + i}-x${i}`, image);
      saved.push({ owner, file: s.file, image });
    }
    expect(driver.files.size).toBe(600);
    expect((await store.usage(A)).files).toBe(400);
    expect((await store.usage(B)).files).toBe(200);
    for (const s of saved) expect(await store.loadImage(s.owner, s.file)).toBe(s.image);
    // what the queue index stores per scan is a file name: tens of bytes, not hundreds of kilobytes
    expect(Math.max(...saved.map((s) => s.file.length))).toBeLessThan(40);
  });
});
