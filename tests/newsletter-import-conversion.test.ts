import { expect, it } from "vitest";
import {
  convertNewsletter,
  resolveNewsletterPhotos,
} from "../src/shared/newsletter-import.js";

const md = `**Subject:** Shop stories
**Preview text:** Welcome 🚀
# Welcome 🚀

**Bold text** and *italic text*.

![Window photograph](library-file:private-example)

> [!CALLOUT] 🦩
>
> **At a glance**
>
> Callout details 🏔️

- First **amenity**
- Second amenity

[Book now](https://example.com/book)

Stay frosty,\x20\x20
The shop
`;
it("reviews source metadata without consuming it, then preserves formatting, Unicode, photos and buttons in source order", () => {
  const review = convertNewsletter({ format: "markdown", source: md });
  expect(review.suggestions).toEqual({
    subject: "Shop stories",
    preheader: "Welcome 🚀",
    title: "Welcome 🚀",
  });
  expect(review.blocks[0]).toMatchObject({
    type: "paragraph",
    runs: expect.arrayContaining([{ bold: true, text: "Subject:" }]),
  });
  const mapped = convertNewsletter({
    format: "markdown",
    source: md,
    acceptMetadata: true,
    buttonLinks: ["https://example.com/book"],
  });
  expect(mapped.blocks.map((b) => b.type)).toEqual([
    "heading",
    "paragraph",
    "photo",
    "callout",
    "list",
    "button",
    "paragraph",
  ]);
  expect(mapped.blocks[1]).toMatchObject({
    runs: expect.arrayContaining([
      { bold: true, text: "Bold text" },
      { italic: true, text: "italic text" },
    ]),
  });
  expect(mapped.blocks[3]).toMatchObject({
    icon: "🦩",
    runs: expect.arrayContaining([{ bold: true, text: "At a glance" }]),
  });
  expect(mapped.blocks[4]).toMatchObject({
    ordered: false,
    items: [
      [{ text: "First " }, { text: "amenity", bold: true }],
      [{ text: "Second amenity" }],
    ],
  });
  expect(mapped.warnings[0]).toEqual({
    location: expect.any(String),
    message: expect.stringContaining("brand asset"),
  });
  expect(() => resolveNewsletterPhotos(mapped.blocks, {})).toThrow(
    /Choose a photo/,
  );
  expect(
    resolveNewsletterPhotos(mapped.blocks, { "photo-1": null }).blocks,
  ).toHaveLength(6);
  const id = "45675675-f35a-4930-a497-2b42d73cc10d";
  const doc = resolveNewsletterPhotos(mapped.blocks, { "photo-1": id });
  expect(doc.blocks[2]).toEqual({
    type: "image",
    assetId: id,
    alt: "Window photograph",
  });
  expect(JSON.stringify(doc)).not.toContain("library-file:");
});
it("parses formatted HTML inertly and reports unsupported elements and attributes", () => {
  const review = convertNewsletter({
    format: "html",
    source:
      '<h2>Welcome 🚀</h2><p><strong>Bold</strong> and <em>italic</em></p><script>private()</script><img src="images/a.jpg" alt="Photo" onerror="steal()"><blink>Visible</blink><ol><li>First</li></ol>',
  });
  expect(review.blocks.map((b) => b.type)).toEqual([
    "heading",
    "paragraph",
    "photo",
    "paragraph",
    "list",
  ]);
  expect(review.blocks.at(-1)).toMatchObject({
    ordered: true,
    items: [[{ text: "First" }]],
  });
  expect(JSON.stringify(review.blocks)).not.toMatch(
    /private\(|steal\(|<blink>/,
  );
  expect(review.warnings.map((w) => w.message).join(" ")).toMatch(
    /script.*onerror.*blink/,
  );
  expect(review.warnings.every((w) => w.location === "HTML line 1")).toBe(true);
  for (const href of [
    "javascript:alert(1)",
    "https://chatgpt.com/share/example",
    "blob:private",
  ]) {
    expect(() =>
      convertNewsletter({
        format: "html",
        source: '<p><a href="' + href + '">Link</a></p>',
      }),
    ).toThrow(/public HTTPS/);
  }
});
it("reports impossible conversions and document limits without clipping", () => {
  expect(() =>
    convertNewsletter({
      format: "markdown",
      source: "| Item | Price |\n|--|--|\n| A | B |",
    }),
  ).toThrow(/table/);
  expect(() =>
    resolveNewsletterPhotos(
      convertNewsletter({ format: "markdown", source: "a".repeat(12001) })
        .blocks,
      {},
    ),
  ).toThrow();
  expect(() =>
    convertNewsletter({ format: "markdown", source: "a".repeat(65537) }),
  ).toThrow(/64 KiB/);
});

it("blocks private references in editable text and signed downloads in outgoing links", () => {
  for (const link of [
    "https://media.example.com/a?X-Amz-Signature=123",
    "https://storage.example.com/a?X-Goog-Signature=abc",
    "https://storage.example.com/a?sv=1&se=expiry&sig=abc",
    "https://cdn.example.com/a?Expires=4&Signature=abc",
    "https://chatgpt.com./share/private",
  ]) {
    expect(() =>
      convertNewsletter({
        format: "html",
        source: '<a href="' + link + '">Download</a>',
      }),
    ).toThrow(/public HTTPS/);
    expect(() =>
      convertNewsletter({
        format: "html",
        source: "<p>File: " + link + "</p>",
      }),
    ).toThrow(/temporary URL/);
  }
  for (const markup of [
    "<p>See blob:https://example.com/id</p>",
    "<p>See library-<b>file:</b>id</p>",
    "<p>Subject: page://private</p>",
  ]) {
    expect(() =>
      convertNewsletter({
        format: "html",
        source: markup,
        acceptMetadata: true,
      }),
    ).toThrow(/private or temporary/);
  }
});
