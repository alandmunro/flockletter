import { expect, it } from "vitest";
import { crc32, deflateRawSync } from "node:zlib";
import { readNewsletterPackage } from "../src/shared/newsletter-package.js";

type Item = {
  name: string;
  data: Buffer;
  mode?: number;
  size?: number;
  localName?: string;
};
function sample(items: Item[]) {
  const central: Buffer[] = [],
    locals: Buffer[] = [];
  let offset = 0;
  for (const item of items) {
    const packed = deflateRawSync(item.data),
      crc = crc32(item.data),
      size = item.size ?? item.data.length;
    const name = Buffer.from(item.name),
      localName = Buffer.from(item.localName ?? item.name);
    const local = Buffer.alloc(30),
      entry = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(localName.length, 26);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(788, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE((item.mode ?? 0o100644) * 65536, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    locals.push(local, localName, packed);
    offset += local.length + localName.length + packed.length;
  }
  const cd = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const doc = { name: "newsletter.md", data: Buffer.from("# Welcome 🦩") };
const img = {
  name: "images/photograph.png",
  data: Buffer.from([0, 15, 16, 128, 255]),
};
it("extracts UTF-8 content and preserves original image bytes", async () => {
  const result = await readNewsletterPackage(sample([doc, img]));
  expect(result).toEqual({
    source: "# Welcome 🦩",
    format: "markdown",
    photos: [{ path: img.name, bytes: new Uint8Array(img.data) }],
  });
});
it("rejects duplicate documents, ambiguous paths, symlinks and hidden local names", async () => {
  for (const item of [
    { ...doc, name: "newsletter.html" },
    { ...img, name: "images/../photo.jpg" },
    { ...img, name: "/photo.jpg" },
    { ...img, name: "images\\photo.jpg" },
    { ...img, localName: "images/alternate.png" },
    { ...img, mode: 0o120777 },
  ]) {
    await expect(readNewsletterPackage(sample([doc, item]))).rejects.toThrow(
      /ZIP/,
    );
  }
  await expect(readNewsletterPackage(sample([doc, img, img]))).rejects.toThrow(
    /duplicate/,
  );
});
it("stops deflate when it exceeds declared output length, and rejects oversized headers before allocating", async () => {
  await expect(
    readNewsletterPackage(
      sample([doc, { ...img, data: Buffer.alloc(128 * 1024), size: 1024 }]),
    ),
  ).rejects.toThrow(/expanded data/);
  await expect(
    readNewsletterPackage(sample([doc, { ...img, size: 6 * 1024 * 1024 }])),
  ).rejects.toThrow(/5 MiB/);
});
