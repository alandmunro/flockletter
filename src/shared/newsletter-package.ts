// Packages are read in memory. Entry names are identifiers, never filesystem paths.
import {
  newsletterSourceBytes,
  type NewsletterFormat,
} from "./newsletter-import.js";

export const newsletterArchiveBytes = 21 * 1024 * 1024;
const imageBytes = 5 * 1024 * 1024,
  batchBytes = 20 * 1024 * 1024,
  maxPhotos = 10;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
type Entry = {
  path: string;
  directory: boolean;
  start: number;
  end: number;
  packed: number;
  size: number;
  method: number;
  crc: number;
};
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  return n >>> 0;
});
function checksum(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ b) & 255]!;
  return (crc ^ 0xffffffff) >>> 0;
}
function ensure(condition: unknown, reason: string): asserts condition {
  if (!condition) throw Error("Newsletter ZIP: " + reason);
}
function validatePath(path: string) {
  ensure(
    path.length > 0 &&
      path.length <= 240 &&
      !/[\\:\p{Cc}\p{Cf}\p{Cs}]/u.test(path) &&
      path.normalize("NFC") === path,
    "unsafe filename.",
  );
  const name = path.endsWith("/") ? path.slice(0, -1) : path;
  ensure(
    name
      .split("/")
      .every(
        (piece) =>
          piece &&
          piece !== "." &&
          piece !== ".." &&
          !piece.startsWith(".") &&
          !piece.endsWith(".") &&
          !piece.endsWith(" "),
      ),
    "unsafe archive path.",
  );
}
function inspect(bytes: Uint8Array) {
  ensure(
    bytes.length <= newsletterArchiveBytes,
    "choose a file of 21 MiB or less.",
  );
  ensure(bytes.length >= 22, "invalid or incomplete archive.");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => dv.getUint16(at, true),
    u32 = (at: number) => dv.getUint32(at, true);
  let end = bytes.length - 22;
  const lower = Math.max(0, end - 65535);
  while (
    end >= lower &&
    !(u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === bytes.length)
  )
    end--;
  ensure(end >= lower, "ZIP end record missing.");
  ensure(
    u16(end + 4) === 0 && u16(end + 6) === 0 && u16(end + 8) === u16(end + 10),
    "multi-disk archives are unsupported.",
  );
  const count = u16(end + 10),
    central = u32(end + 16);
  ensure(
    count > 0 && count <= 32 && central + u32(end + 12) === end,
    "invalid or excessive central directory.",
  );
  const paths = new Set<string>(),
    entries: Entry[] = [],
    spans: [number, number][] = [];
  let at = central,
    total = 0,
    documents = 0,
    photos = 0;
  for (let i = 0; i < count; i++) {
    ensure(
      at + 46 <= end && u32(at) === 0x02014b50,
      "invalid directory entry.",
    );
    const flags = u16(at + 8),
      method = u16(at + 10),
      crc = u32(at + 16),
      packed = u32(at + 20),
      size = u32(at + 24);
    const nameLen = u16(at + 28),
      extra = u16(at + 30),
      comment = u16(at + 32),
      external = u32(at + 38),
      local = u32(at + 42);
    ensure(
      at + 46 + nameLen + extra + comment <= end && u16(at + 34) === 0,
      "invalid entry bounds.",
    );
    ensure(
      (flags & ~0x80e) === 0 && (method === 0 || method === 8),
      "encrypted, unusual or unsupported compression method.",
    );
    const path = utf8.decode(bytes.subarray(at + 46, at + 46 + nameLen)),
      directory = path.endsWith("/");
    validatePath(path);
    const normalized = path.toLowerCase();
    ensure(!paths.has(normalized), "duplicate or ambiguous entry names.");
    paths.add(normalized);
    const kind = (external >>> 16) & 0xf000;
    ensure(
      kind === 0 || kind === (directory ? 0x4000 : 0x8000),
      "symlinks and special files are forbidden.",
    );
    if (directory) {
      ensure(
        path.startsWith("images/") && size === 0,
        "only the images directory is supported.",
      );
    } else if (/^newsletter\.(md|html)$/.test(path)) {
      ensure(
        ++documents === 1 && size <= newsletterSourceBytes,
        "supply one newsletter.md or newsletter.html up to 64 KiB.",
      );
    } else {
      ensure(
        /^images\/.+\.(png|jpe?g|gif|webp|svg)$/i.test(path) &&
          path.startsWith("images/"),
        "unsupported entry; supply newsletter.md or newsletter.html and images/.",
      );
      total += size;
      ensure(
        ++photos <= maxPhotos &&
          size > 0 &&
          size <= imageBytes &&
          total <= batchBytes,
        "use at most ten images, 5 MiB per image and 20 MiB total.",
      );
    }
    ensure(
      local + 30 <= central &&
        u32(local) === 0x04034b50 &&
        u16(local + 6) === flags &&
        u16(local + 8) === method,
      "invalid local header.",
    );
    const localName = u16(local + 26),
      start = local + 30 + localName + u16(local + 28),
      dataEnd = start + packed;
    ensure(
      dataEnd <= central &&
        utf8.decode(bytes.subarray(local + 30, local + 30 + localName)) ===
          path,
      "inconsistent local name or compressed size.",
    );
    let recordEnd = dataEnd;
    if (flags & 8) {
      if (recordEnd + 4 <= central && u32(recordEnd) === 0x08074b50)
        recordEnd += 4;
      ensure(
        recordEnd + 12 <= central &&
          u32(recordEnd) === crc &&
          u32(recordEnd + 4) === packed &&
          u32(recordEnd + 8) === size,
        "invalid streaming descriptor.",
      );
      recordEnd += 12;
    } else
      ensure(
        u32(local + 14) === crc &&
          u32(local + 18) === packed &&
          u32(local + 22) === size,
        "central and local checksums or sizes disagree.",
      );
    ensure(method !== 0 || packed === size, "invalid stored size.");
    entries.push({
      path,
      directory,
      start,
      end: recordEnd,
      packed,
      size,
      method,
      crc,
    });
    spans.push([local, recordEnd]);
    at += 46 + nameLen + extra + comment;
  }
  ensure(
    at === end && documents === 1,
    "missing newsletter document or unexpected trailing directory data.",
  );
  let cursor = 0;
  for (const [begin, finish] of spans.sort((a, b) => a[0] - b[0])) {
    ensure(cursor === begin, "overlapping or unlisted ZIP records.");
    cursor = finish;
  }
  ensure(cursor === central, "unexpected ZIP records before directory.");
  return entries;
}
async function unpack(entry: Entry, archive: Uint8Array) {
  const packed = archive.subarray(entry.start, entry.start + entry.packed);
  let out: Uint8Array;
  if (entry.method === 0) out = packed.slice();
  else {
    // Keep the real output bounded even if the deflate stream disagrees with its size header.
    const stream = new Blob([new Uint8Array(packed)])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    const reader = stream.getReader();
    out = new Uint8Array(entry.size);
    let written = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        ensure(
          written + next.value.length <= out.length,
          "expanded data exceeds declared size.",
        );
        out.set(next.value, written);
        written += next.value.length;
      }
      ensure(written === out.length, "expanded size differs from header.");
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
  ensure(checksum(out) === entry.crc, "entry checksum mismatch.");
  return out;
}
export async function readNewsletterPackage(bytes: Uint8Array): Promise<{
  source: string;
  format: NewsletterFormat;
  photos: { path: string; bytes: Uint8Array }[];
}> {
  const entries = inspect(bytes);
  let source = "",
    format: NewsletterFormat = "markdown";
  const photos: { path: string; bytes: Uint8Array }[] = [];
  for (const entry of entries) {
    const data = await unpack(entry, bytes);
    if (entry.directory) continue;
    if (entry.path.startsWith("images/"))
      photos.push({ path: entry.path, bytes: data });
    else {
      source = utf8.decode(data).replace(/^\uFEFF/, "");
      format = entry.path === "newsletter.md" ? "markdown" : "html";
    }
  }
  ensure(source.trim(), "newsletter document is empty.");
  return { source, format, photos };
}
