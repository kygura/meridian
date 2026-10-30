import { describe, expect, it, vi } from "vitest";
import {
  PHOTO_BATCH,
  PHOTO_KEYS,
  photoBatches,
  emailContentType,
  fingerprintFile,
  isImageFile,
  wallClockIso,
  mergeReports,
  photoMeta,
  photoPoint,
  progressText,
  scanPhotos,
  uploadKind,
} from "./importUpload";

const file = (name: string, bytes = "x", type = "") => new File([bytes], name, { type });

describe("kinds", () => {
  it("classifies uploads by extension", () => {
    expect(uploadKind("a.EML")).toBe("email");
    expect(uploadKind("takeout.mbox")).toBe("email");
    expect(uploadKind("Timeline.json")).toBe("timeline");
    expect(uploadKind("a.pdf")).toBeNull();
    expect(emailContentType("a.mbox")).toBe("application/mbox");
    expect(emailContentType("a.eml")).toBe("message/rfc822");
  });
  it("recognises images by type or extension", () => {
    expect(isImageFile({ name: "a.JPG" })).toBe(true);
    expect(isImageFile({ name: "x", type: "image/heic" })).toBe(true);
    expect(isImageFile({ name: "notes.txt" })).toBe(false);
  });
});

describe("photoMeta / photoPoint", () => {
  it("formats the camera's wall clock without a zone", () => {
    expect(wallClockIso(new Date(2024, 4, 14, 9, 3, 7))).toBe("2024-05-14T09:03:07");
  });
  it("needs time and a plausible GPS fix", () => {
    const ok = photoMeta({ DateTimeOriginal: new Date(2024, 4, 14, 10, 0, 0), latitude: 38.7, longitude: -9.1 });
    expect(ok).toEqual({ timestamp: "2024-05-14T10:00:00", lat: 38.7, lng: -9.1 });
    expect(photoMeta({ latitude: 1, longitude: 1 })).toBeNull();
    expect(photoMeta({ DateTimeOriginal: new Date(), latitude: 1 })).toBeNull();
    expect(photoMeta({ DateTimeOriginal: new Date(), latitude: 0, longitude: 0 })).toBeNull();
    expect(photoMeta({ DateTimeOriginal: new Date(), latitude: 91, longitude: 0 })).toBeNull();
    expect(photoMeta({ DateTimeOriginal: new Date("nope"), latitude: 1, longitude: 1 })).toBeNull();
    expect(photoMeta(null)).toBeNull();
  });
  it("payload keys are exactly timestamp, lat, lng, hash (no image bytes, names or extra EXIF)", () => {
    const meta = { timestamp: "2024-05-14T10:00:00", lat: 1, lng: 2, name: "IMG_1.jpg", bytes: new Uint8Array(3), Make: "Canon" };
    const p = photoPoint(meta, "abc");
    expect(Object.keys(p).sort()).toEqual([...PHOTO_KEYS].sort());
    expect(JSON.stringify(p)).not.toContain("IMG_1");
  });
});

describe("fingerprintFile", () => {
  it("hashes only the first MiB plus the size", async () => {
    const digest = vi.fn(async (_alg: string, data: BufferSource) => new Uint8Array([data.byteLength & 255, 1]).buffer);
    const big = new File([new Uint8Array(3 * 1024 * 1024)], "big.jpg");
    const h = await fingerprintFile(big, { digest } as unknown as SubtleCrypto);
    const input = digest.mock.calls[0][1] as Uint8Array;
    expect(input.byteLength).toBe(1024 * 1024 + `:${big.size}`.length);
    expect(h).toMatch(/^[0-9a-f]{4}$/);
  });
  it("uses real SHA-256 by default and differs by content/size", async () => {
    const a = await fingerprintFile(file("a.jpg", "hello"));
    const b = await fingerprintFile(file("b.jpg", "hello"));
    const c = await fingerprintFile(file("c.jpg", "hello!"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("scanPhotos", () => {
  const tags = { DateTimeOriginal: new Date(2024, 4, 14, 10, 0, 0), latitude: 38.7, longitude: -9.1 };
  it("skips non-images and photos without GPS, hashes the rest, reports progress", async () => {
    const parse = vi.fn(async (f: File) => (f.name === "nogps.jpg" ? { DateTimeOriginal: new Date() } : f.name === "bad.jpg" ? Promise.reject(new Error("x")) : tags));
    const onProgress = vi.fn();
    const scan = await scanPhotos([file("a.jpg"), file("nogps.jpg"), file("bad.jpg"), file("readme.txt"), file("b.heic")], {
      parse: parse as never,
      hash: async (f) => `h-${f.name}`,
      onProgress,
      concurrency: 2,
    });
    expect(scan.scanned).toBe(4);
    expect(scan.skipped).toBe(2);
    expect(scan.points.map((p) => p.hash)).toEqual(["h-a.jpg", "h-b.heic"]);
    for (const p of scan.points) expect(Object.keys(p).sort()).toEqual([...PHOTO_KEYS].sort());
    expect(onProgress).toHaveBeenLastCalledWith(4, 4);
    expect(parse).toHaveBeenCalledTimes(4);
  });
  it("stops between groups when cancelled", async () => {
    let n = 0;
    const scan = await scanPhotos([file("a.jpg"), file("b.jpg"), file("c.jpg"), file("d.jpg")], {
      parse: async () => tags,
      hash: async () => "h",
      concurrency: 2,
      shouldCancel: () => n++ > 0,
    });
    expect(scan.cancelled).toBe(true);
    expect(scan.scanned).toBe(2);
  });
});

describe("batching and reports", () => {
  it("batches time-sorted, never over PHOTO_BATCH, cutting a full batch where the date changes", () => {
    expect(PHOTO_BATCH).toBeLessThanOrEqual(5000);
    const p = (timestamp: string) => ({ timestamp, lat: 1, lng: 2, hash: timestamp });
    expect(photoBatches([])).toEqual([]);
    const pts = [p("2024-03-02T10:00:00"), p("2024-03-01T09:00:00"), p("2024-03-01T18:00:00"), p("2024-03-03T08:00:00")];
    expect(photoBatches(pts, 10).map((b) => b.map((x) => x.timestamp))).toEqual([
      ["2024-03-01T09:00:00", "2024-03-01T18:00:00", "2024-03-02T10:00:00", "2024-03-03T08:00:00"],
    ]);
    // size 3 would split day 03-02 from day 03-01 mid-day only if the date matched; it cuts at the day boundary instead
    const split = photoBatches(pts, 3).map((b) => b.map((x) => x.timestamp.slice(0, 10)));
    expect(split).toEqual([["2024-03-01", "2024-03-01", "2024-03-02"], ["2024-03-03"]]);
    // a multi-day stay is not split: the cut moves back to the last gap of more than one day
    const stay = [p("2024-05-01T10:00:00"), p("2024-05-12T10:00:00"), p("2024-05-13T10:00:00"), p("2024-05-14T10:00:00"), p("2024-05-15T10:00:00")];
    expect(photoBatches(stay, 4).map((b) => b.map((x) => x.timestamp.slice(5, 10)))).toEqual([["05-01"], ["05-12", "05-13", "05-14", "05-15"]]);
    // one day bigger than the size is cut hard
    const day = Array.from({ length: 5 }, (_, i) => p(`2024-03-01T0${i}:00:00`));
    expect(photoBatches(day, 2).map((b) => b.length)).toEqual([2, 2, 1]);
  });
  it("sums batch reports", () => {
    const r = mergeReports([{ received: 2, added: 1, duplicates: 1, errors: ["a"] }, { received: 3, added: 3, duplicates: 0 }], "2 WITHOUT GPS");
    expect(r).toEqual({ received: 5, added: 4, duplicates: 1, errors: ["a"], note: "2 WITHOUT GPS" });
    expect(mergeReports([{ received: 1, added: 1, duplicates: 0, unstructured: 2 }]).unstructured).toBe(2);
    expect("unstructured" in mergeReports([{ received: 1, added: 1, duplicates: 0 }])).toBe(false);
  });
  it("formats progress", () => {
    expect(progressText(412, 1280)).toBe("READING 412 / 1,280 · ON THIS DEVICE");
  });
});
