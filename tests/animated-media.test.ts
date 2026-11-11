import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { inspectImage, digest } from "../src/server/content.js";
import { inlineOriginals } from "../src/server/campaign/ses-simulator.js";

const twoFramesRaw = Buffer.from(
  Array.from({ length: 32 }, (_, pixel) =>
    pixel < 16 ? [255, 0, 0, 255] : [0, 0, 255, 255],
  ).flat(),
);

async function makeGif(): Promise<Buffer> {
  return sharp(twoFramesRaw, {
    raw: { width: 4, height: 8, channels: 4, pageHeight: 4 },
  })
    .gif({ loop: 0, delay: [100, 200] })
    .toBuffer();
}

async function makeWebp(): Promise<Buffer> {
  return sharp(twoFramesRaw, {
    raw: { width: 4, height: 8, channels: 4, pageHeight: 4 },
  })
    .webp({ loop: 0, delay: [100, 200] })
    .toBuffer();
}

describe("inspectImage", () => {
  it("preserves two-frame GIF bytes, width/height, MIME and animation notice", async () => {
    const gifBytes = await makeGif();
    const result = await inspectImage(gifBytes.toString("base64"));

    expect(result.bytes).toEqual(gifBytes);
    expect(result.sha256).toBe(digest(gifBytes));
    expect(result.mime).toBe("image/gif");
    expect(
      await sharp(result.bytes, { animated: true }).metadata(),
    ).toMatchObject({ pages: 2, delay: [100, 200], loop: 0 });
    expect(result.width).toBe(4);
    expect(result.height).toBe(4);
    expect(result.converted).toBe(false);
    expect(result.notice).toBe(
      "Animation preserved. Some email apps display only the first frame.",
    );
    const files = inlineOriginals({
      operationKey: "test",
      workspaceId: "test",
      brandId: "test",
      to: "test@example.com",
      subject: "Animation",
      html: `<img src="cid:${result.sha256}">`,
      text: "Animation",
      images: [
        {
          name: "animation.gif",
          mime: result.mime,
          sha256: result.sha256,
          bytes: result.bytes,
        },
      ],
    });
    expect(files?.[0]).toMatchObject({
      ContentType: "image/gif",
      FileName: "animation.gif",
    });
    expect(Buffer.from(files![0]!.RawContent!)).toEqual(gifBytes);
  });

  it("preserves two-frame WebP bytes, width/height, MIME and animation notice", async () => {
    const webpBytes = await makeWebp();
    const result = await inspectImage(webpBytes.toString("base64"));

    expect(result.bytes).toEqual(webpBytes);
    expect(result.mime).toBe("image/webp");
    expect(
      await sharp(result.bytes, { animated: true }).metadata(),
    ).toMatchObject({ pages: 2, delay: [100, 200], loop: 0 });
    expect(result.width).toBe(4);
    expect(result.height).toBe(4);
    expect(result.converted).toBe(false);
    expect(result.notice).toBe(
      "Animation preserved. Some email apps display only the first frame.",
    );
  });

  it("converts a plain static SVG rect to PNG", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#ff0000"/></svg>';
    const result = await inspectImage(Buffer.from(svg).toString("base64"));

    expect(result.converted).toBe(true);
    expect(result.mime).toBe("image/png");
    expect(result.width).toBe(4);
    expect(result.height).toBe(4);
    expect(await sharp(result.bytes).metadata()).toMatchObject({
      format: "png",
      width: 4,
      height: 4,
    });
    const { data } = await sharp(result.bytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([...data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect(result.notice).toBe(
      "SVG converted to PNG for safe, compatible email display.",
    );
  });

  it("rejects SVG containing a script element", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>alert(1)</script></svg>';
    await expect(
      inspectImage(Buffer.from(svg).toString("base64")),
    ).rejects.toMatchObject({
      status: 422,
      code: "invalid_image",
    });
  });

  it("rejects SVG with an external image href", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><image href="http://example.com/evil.png"/></svg>';
    await expect(
      inspectImage(Buffer.from(svg).toString("base64")),
    ).rejects.toMatchObject({
      status: 422,
      code: "invalid_image",
    });
  });

  it("rejects SVG with DOCTYPE entity expansion", async () => {
    const svg =
      '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg" width="4" height="4">&xxe;</svg>';
    await expect(
      inspectImage(Buffer.from(svg).toString("base64")),
    ).rejects.toMatchObject({
      status: 422,
      code: "invalid_image",
    });
  });

  it("rejects SVG with an onload handler", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" onload="alert(1)"><rect width="4" height="4"/></svg>';
    await expect(
      inspectImage(Buffer.from(svg).toString("base64")),
    ).rejects.toMatchObject({
      status: 422,
      code: "invalid_image",
    });
  });
});

it("rejects oversized frame counts without flattening to a static image", async () => {
  const raw = Buffer.from(
    Array.from({ length: 101 }, (_, i) => [
      i % 2 ? 255 : 0,
      i % 2 ? 0 : 255,
      0,
      255,
    ]).flat(),
  );
  const gif = await sharp(raw, {
    raw: { width: 1, height: 101, channels: 4, pageHeight: 1 },
  })
    .gif({ delay: Array(101).fill(100) })
    .toBuffer();
  expect((await sharp(gif, { animated: true }).metadata()).pages).toBe(101);
  await expect(inspectImage(gif.toString("base64"))).rejects.toMatchObject({
    code: "invalid_image",
  });
});
it.each([
  '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">Hi</div></foreignObject>',
  '<rect width="4" height="4" style="fill:url(https://example.com/a)"/>',
  '<style>@import "https://example.com/font.css";</style>',
  '<animate attributeName="x" values="0;4" dur="1s"/>',
  '<use href="#loop" id="loop"/>',
])("rejects active or externally referenced SVG: %s", async (body) => {
  await expect(
    inspectImage(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4">${body}</svg>`,
      ).toString("base64"),
    ),
  ).rejects.toMatchObject({ code: "invalid_image" });
});
it("renders gradients and local references but rejects malformed or excessive XML", async () => {
  const safe =
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><defs><linearGradient id="paint"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs><rect width="8" height="8" fill="url(#paint)"/></svg>';
  expect((await inspectImage(Buffer.from(safe).toString("base64"))).mime).toBe(
    "image/png",
  );
  for (const svg of [
    "<svg><g></svg>",
    "<svg>" + "<g>".repeat(34) + "</g>".repeat(34) + "</svg>",
    "<svg>" + "<path/>".repeat(3001) + "</svg>",
  ])
    await expect(
      inspectImage(Buffer.from(svg).toString("base64")),
    ).rejects.toMatchObject({ code: "invalid_image" });
});
