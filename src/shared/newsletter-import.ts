import { marked } from "marked";
import { parse, type DefaultTreeAdapterTypes as Tree } from "parse5";
import {
  studioSchema,
  validateStudioLink,
  type StudioBlock,
  type StudioDocument,
  type StudioRun,
} from "./studio.js";

export const newsletterSourceBytes = 65536;
export type NewsletterFormat = "markdown" | "html";
export type NewsletterPhoto = {
  type: "photo";
  key: string;
  source: string;
  alt: string;
};
export type NewsletterImportBlock = StudioBlock | NewsletterPhoto;
export type NewsletterReview = {
  blocks: NewsletterImportBlock[];
  suggestions: { title?: string; subject?: string; preheader?: string };
  warnings: { location: string; message: string }[];
  links: { href: string; label: string }[];
};
type Mark = Omit<StudioRun, "text">;
type Piece = StudioRun | NewsletterPhoto;
const tag = (node: Tree.ChildNode) => ("tagName" in node ? node.tagName : "");
const attr = (node: Tree.Element, key: string) =>
  node.attrs.find((a) => a.name === key)?.value ?? "";
function privateLink(href: string) {
  if (/^(?:library-file|project-file|page|blob|data):/i.test(href)) return true;
  try {
    const url = new URL(href);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (
      /(^|\.)(?:chatgpt\.com|chat\.openai\.com|oaiusercontent\.com)$/.test(host)
    )
      return true;
    const query = new Set(
      Array.from(url.searchParams.keys(), (key) => key.toLowerCase()),
    );
    return (
      query.has("x-amz-signature") ||
      query.has("x-goog-signature") ||
      (query.has("sig") && (query.has("se") || query.has("sv"))) ||
      (query.has("signature") &&
        ["expires", "awsaccesskeyid", "key-pair-id", "googleaccessid"].some(
          (k) => query.has(k),
        ))
    );
  } catch {
    return false;
  }
}
// Plain prose and metadata can also contain a pasted private URL without an anchor.
export function hasPrivateNewsletterReference(value: string) {
  if (
    /(?:^|[^a-z0-9-])(?:library-file|project-file|page|blob):[^\s]+/i.test(
      value,
    )
  )
    return true;
  return Array.from(
    value.matchAll(/https?:\/\/[^\s<>"']+/gi),
    (m) => m[0],
  ).some(privateLink);
}
const contentTags = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "aside",
  "ul",
  "ol",
  "hr",
]);
const containers = new Set([
  "html",
  "head",
  "body",
  "main",
  "section",
  "article",
  "div",
  "header",
  "footer",
  "figure",
  "figcaption",
]);
const dropTags = new Set([
  "script",
  "style",
  "iframe",
  "noscript",
  "object",
  "embed",
  "form",
  "input",
  "audio",
  "video",
  "template",
  "svg",
  "math",
  "link",
  "base",
  "canvas",
  "source",
  "button",
  "textarea",
  "select",
  "meta",
]);
const textTags = new Set(["span", "b", "strong", "i", "em", "a", "br", "img"]);
const isPhoto = (p: Piece): p is NewsletterPhoto => "type" in p;
const isRun = (p: Piece): p is StudioRun => !isPhoto(p);
function cleanRuns(runs: StudioRun[]) {
  const result: StudioRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const prev = result.at(-1);
    if (
      prev &&
      prev.bold === run.bold &&
      prev.italic === run.italic &&
      prev.href === run.href
    )
      prev.text += run.text;
    else result.push({ ...run });
  }
  if (result[0]) result[0].text = result[0].text.trimStart();
  if (result.at(-1)) result.at(-1)!.text = result.at(-1)!.text.trimEnd();
  return result.filter((r) => r.text);
}

export function convertNewsletter(input: {
  source: string;
  format: NewsletterFormat;
  acceptMetadata?: boolean;
  buttonLinks?: string[];
}): NewsletterReview {
  const { source, format } = input;
  if (!source.trim())
    throw Error("Supply newsletter content before reviewing it.");
  if (new TextEncoder().encode(source).length > newsletterSourceBytes)
    throw Error(
      "Newsletter source exceeds 64 KiB. Split the newsletter before importing.",
    );
  if (/[\p{Cc}\p{Cs}]/u.test(source.replace(/[\n\r\t]/g, "")))
    throw Error("Remove control characters from the newsletter source.");
  const result: NewsletterReview = {
    blocks: [],
    suggestions: {},
    warnings: [],
    links: [],
  };
  const warn = (location: string, message: string) => {
    if (result.warnings.length >= 200)
      throw Error(
        "More than 200 formatting changes. Simplify the source before importing.",
      );
    result.warnings.push({ location, message });
  };
  const html =
    format === "html"
      ? source
      : marked.parse(source, { async: false, gfm: true, breaks: true });
  const root = parse(html, {
    sourceCodeLocationInfo: true,
    scriptingEnabled: false,
    onParseError: (e) => {
      if (e.code !== "missing-doctype")
        warn(
          "HTML line " + e.startLine,
          "HTML parser corrected " + e.code + ".",
        );
    },
  });
  let photoCount = 0,
    count = 0;
  const checked = new WeakSet<object>();
  const loc = (n: Tree.ChildNode) =>
    (format === "markdown" ? "Converted HTML line " : "HTML line ") +
    (n.sourceCodeLocation?.startLine ?? 1);
  function inspect(n: Tree.ChildNode, depth: number) {
    if (depth > 60 || ++count > 12000)
      throw Error(
        "Newsletter markup is too deeply nested or complex. Simplify the source before importing.",
      );
    if (!("tagName" in n) || checked.has(n)) return;
    checked.add(n);
    const t = n.tagName;
    const ignored = n.attrs.filter(
      (a) =>
        !(
          (t === "a" && a.name === "href") ||
          (t === "img" && ["src", "alt"].includes(a.name)) ||
          (t === "aside" && a.name === "data-icon") ||
          (t === "meta" && ["charset", "name", "content"].includes(a.name)) ||
          (t === "html" && a.name === "lang") ||
          (t === "ol" && a.name === "start" && a.value === "1")
        ),
    );
    if (ignored.length)
      warn(
        loc(n),
        "Ignored " + ignored.map((a) => a.name).join(", ") + " on <" + t + ">.",
      );
  }
  function flat(nodes: Tree.ChildNode[], marks: Mark, depth: number): Piece[] {
    const out: Piece[] = [];
    for (const node of nodes) {
      inspect(node, depth);
      if ("value" in node) {
        out.push({ ...marks, text: node.value.replace(/[ \t\r\n]+/g, " ") });
        continue;
      }
      if (!("tagName" in node)) {
        if (node.nodeName === "#comment")
          warn(loc(node), "HTML comment omitted.");
        continue;
      }
      const t = node.tagName;
      if (dropTags.has(t)) {
        warn(loc(node), "Removed unsupported <" + t + "> and its contents.");
        continue;
      }
      if (t === "br") {
        out.push({ ...marks, text: "\n" });
        continue;
      }
      if (
        t === "img" ||
        (t === "a" &&
          /^(?:library-file|project-file):/i.test(attr(node, "href")))
      ) {
        const src = t === "img" ? attr(node, "src") : attr(node, "href");
        const alt =
          t === "img"
            ? attr(node, "alt")
            : flat(node.childNodes, {}, depth + 1)
                .filter(isRun)
                .map((p) => p.text)
                .join("");
        const ref = src.replace(/^\.\//, "");
        if (
          !ref ||
          !/^images\/[\w. /()-]+$/iu.test(ref) ||
          ref.split("/").includes("..")
        )
          warn(
            loc(node),
            "Supply a photo or choose a brand asset for this image position. External image references are never downloaded.",
          );
        if (marks.href)
          warn(
            loc(node),
            "The image link cannot be retained on a Studio image block.",
          );
        if (/^data:/i.test(ref))
          warn(
            loc(node),
            "Embedded image bytes must be supplied as a separate file.",
          );
        out.push({
          type: "photo",
          key: "photo-" + ++photoCount,
          source: /^data:/i.test(ref) ? "(embedded image)" : ref,
          alt,
        });
        continue;
      }
      if (t === "a") {
        const href = attr(node, "href");
        if (privateLink(href) || !validateStudioLink(href))
          throw Error(
            loc(node) +
              ": Replace the non-public or unsafe link with a public HTTPS link.",
          );
        const linked = flat(node.childNodes, { ...marks, href }, depth + 1);
        const label = linked
          .filter(isRun)
          .map((r) => r.text)
          .join("")
          .trim();
        if (label && !result.links.some((l) => l.href === href))
          result.links.push({ href, label });
        out.push(...linked);
        continue;
      }
      if (!textTags.has(t) && t !== "p")
        warn(loc(node), "Converted <" + t + "> to editable text.");
      if (
        (t === "ul" || t === "ol" || t === "aside" || t === "blockquote") &&
        depth > 1
      )
        throw Error(
          loc(node) +
            ": Move nested lists or callouts into separate sections before importing.",
        );
      if (t === "p" && out.length) out.push({ ...marks, text: "\n" });
      out.push(
        ...flat(
          node.childNodes,
          {
            ...marks,
            ...(["b", "strong"].includes(t) ? { bold: true } : {}),
            ...(["i", "em"].includes(t) ? { italic: true } : {}),
          },
          depth + 1,
        ),
      );
    }
    return out;
  }
  function metadata(runs: StudioRun[]) {
    const line = runs.map((r) => r.text).join("");
    const m = /^\s*(Title|Subject|Preview text|Preheader):\s*(\S.*)$/i.exec(
      line,
    );
    if (!m) return false;
    const k = m[1]!.toLowerCase(),
      key = k === "title" ? "title" : k === "subject" ? "subject" : "preheader";
    if (result.suggestions[key] !== undefined) return false;
    result.suggestions[key] = m[2]!.trim();
    return !!input.acceptMetadata;
  }
  function emitText(
    type: "paragraph" | "heading" | "callout",
    pieces: Piece[],
    level: 1 | 2 | 3 = 1,
    icon?: string,
  ) {
    let group: StudioRun[] = [];
    const flush = () => {
      const runs = cleanRuns(group);
      group = [];
      if (!runs.length) return;
      if (type === "paragraph") {
        const lines: StudioRun[][] = [[]];
        for (const r of runs) {
          r.text.split("\n").forEach((text, i) => {
            if (i) lines.push([]);
            lines.at(-1)!.push({ ...r, text });
          });
        }
        const kept = lines.filter((line) => !metadata(line));
        const remaining = cleanRuns(
          kept.flatMap((line, i) => (i ? [{ text: "\n" }, ...line] : line)),
        );
        if (remaining.length) result.blocks.push({ type, runs: remaining });
      } else if (type === "heading") result.blocks.push({ type, level, runs });
      else result.blocks.push({ type, runs, ...(icon ? { icon } : {}) });
    };
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]!;
      if (isPhoto(piece)) {
        flush();
        result.blocks.push(piece);
        continue;
      }
      if (piece.href && input.buttonLinks?.includes(piece.href)) {
        flush();
        let label = piece.text;
        while (i + 1 < pieces.length) {
          const next = pieces[i + 1]!;
          if (isPhoto(next) || next.href !== piece.href) break;
          label += next.text;
          i++;
        }
        result.blocks.push({
          type: "button",
          label: label.trim(),
          href: piece.href,
        });
        continue;
      }
      group.push(piece);
    }
    flush();
  }
  function blocks(nodes: Tree.ChildNode[], depth = 0) {
    let buffer: Tree.ChildNode[] = [];
    const flush = () => {
      if (buffer.length) {
        emitText("paragraph", flat(buffer, {}, depth));
        buffer = [];
      }
    };
    for (const n of nodes) {
      const t = tag(n);
      if (!t || !("tagName" in n)) {
        buffer.push(n);
        continue;
      }
      if (
        !contentTags.has(t) &&
        !containers.has(t) &&
        !["title", "meta", "table", "pre", "details", "dl"].includes(t)
      ) {
        buffer.push(n);
        continue;
      }
      flush();
      inspect(n, depth);
      if (t === "title") {
        const runs = flat(n.childNodes, {}, depth + 1).filter(isRun);
        const title = runs
          .map((r) => r.text)
          .join("")
          .trim();
        if (title) {
          result.suggestions.title ??= title;
          if (!input.acceptMetadata)
            result.blocks.push({ type: "paragraph", runs });
        }
      } else if (t === "meta") {
        if (!attr(n, "charset")) warn(loc(n), "HTML metadata omitted.");
      } else if (containers.has(t)) blocks(n.childNodes, depth + 1);
      else if (t === "hr") result.blocks.push({ type: "divider" });
      else if (t === "ul" || t === "ol") {
        const items: StudioRun[][] = [];
        for (const child of n.childNodes) {
          if ("value" in child && !child.value.trim()) continue;
          if (!("tagName" in child) || child.tagName !== "li")
            throw Error(
              loc(child) +
                ": Expected a list item. Move other content outside the list.",
            );
          inspect(child, depth + 1);
          const tokens = flat(child.childNodes, {}, depth + 2);
          if (tokens.some(isPhoto))
            throw Error(
              loc(child) +
                ": Move the image outside its list before importing.",
            );
          const itemRuns = tokens.filter(isRun);
          if (
            itemRuns.some((p) => p.href && input.buttonLinks?.includes(p.href))
          )
            throw Error(
              loc(child) +
                ": To convert this list link into a button, move it into a separate paragraph.",
            );
          items.push(cleanRuns(itemRuns));
        }
        if (items.length)
          result.blocks.push({ type: "list", ordered: t === "ol", items });
      } else if (t === "p")
        emitText("paragraph", flat(n.childNodes, {}, depth + 1));
      else if (/^h[1-6]$/.test(t)) {
        const level = Math.min(Number(t[1]), 3) as 1 | 2 | 3;
        if (Number(t[1]) > 3)
          warn(loc(n), "Converted <" + t + "> to heading level 3.");
        emitText("heading", flat(n.childNodes, {}, depth + 1), level);
      } else if (t === "blockquote" || t === "aside") {
        const pieces = flat(n.childNodes, {}, depth + 1);
        let icon = attr(n, "data-icon");
        const first = pieces.find(
          (p): p is StudioRun => !isPhoto(p) && !!p.text.trim(),
        );
        if (first) {
          const callout = /^\s*\[!CALLOUT\][ \t]*(\S+)?[ \t]*/i.exec(
            first.text,
          );
          const advisory =
            /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(
              first.text,
            );
          if (callout) {
            icon ||= callout[1] ?? "";
            first.text = first.text.slice(callout[0].length);
          } else if (advisory) {
            const icons: Record<string, string> = {
              NOTE: "ℹ️",
              TIP: "💡",
              IMPORTANT: "❗",
              WARNING: "⚠️",
              CAUTION: "⚠️",
            };
            icon ||= icons[advisory[1]!.toUpperCase()]!;
            first.text = first.text.slice(advisory[0].length);
          }
        }
        emitText("callout", pieces, 1, icon);
      } else
        throw Error(
          loc(n) +
            ": <" +
            t +
            "> has no editable equivalent. Convert it to paragraphs before importing.",
        );
    }
    flush();
  }
  blocks(root.childNodes);
  // Check joined runs so markup cannot split a private URL across formatting boundaries.
  for (const [index, block] of result.blocks.entries()) {
    const strings =
      block.type === "list"
        ? block.items.map((item) => item.map((r) => r.text).join(""))
        : "runs" in block
          ? [block.runs.map((r) => r.text).join("")]
          : block.type === "button"
            ? [block.label]
            : block.type === "photo"
              ? [block.alt]
              : [];
    if (strings.some(hasPrivateNewsletterReference))
      throw Error(
        "Block " +
          (index + 1) +
          ": Remove the private or temporary URL from the text before importing.",
      );
  }
  if (Object.values(result.suggestions).some(hasPrivateNewsletterReference))
    throw Error(
      "Metadata: Remove the private or temporary URL before importing.",
    );
  const firstHeading = result.blocks.find((b) => b.type === "heading");
  if (firstHeading?.type === "heading")
    result.suggestions.title ??= firstHeading.runs.map((r) => r.text).join("");
  if (!result.blocks.length) throw Error("No editable body content was found.");
  return result;
}

export function resolveNewsletterPhotos(
  blocks: NewsletterImportBlock[],
  mapping: Record<string, string | null>,
): StudioDocument {
  const resolved: StudioBlock[] = [];
  for (const block of blocks) {
    if (block.type !== "photo") {
      resolved.push(block);
      continue;
    }
    if (!Object.hasOwn(mapping, block.key))
      throw Error(
        "Choose a photo for " +
          (block.alt || block.key) +
          " or explicitly remove the image.",
      );
    const assetId = mapping[block.key];
    if (assetId === null) continue;
    if (!assetId)
      throw Error("Choose a valid brand asset for " + block.key + ".");
    resolved.push({ type: "image", assetId, alt: block.alt });
  }
  if (!resolved.length)
    throw Error(
      "A newsletter needs at least one body block after photo mapping.",
    );
  const doc = studioSchema.safeParse({ version: 2, blocks: resolved });
  if (!doc.success)
    throw Error(
      doc.error.issues
        .map((i) => i.path.join(".") + ": " + i.message)
        .join("; "),
    );
  return doc.data;
}
