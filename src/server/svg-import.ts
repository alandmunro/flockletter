import { SaxesParser } from "saxes";

const svgNamespace = "http://www.w3.org/2000/svg";
const elements = new Set([
  "svg",
  "g",
  "defs",
  "title",
  "desc",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
]);
const attributes = new Set([
  "id",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "fx",
  "fy",
  "width",
  "height",
  "viewBox",
  "preserveAspectRatio",
  "d",
  "points",
  "transform",
  "gradientTransform",
  "gradientUnits",
  "spreadMethod",
  "offset",
  "fill",
  "fill-rule",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "stop-color",
  "stop-opacity",
  "clip-path",
  "clip-rule",
  "clipPathUnits",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "dx",
  "dy",
  "letter-spacing",
]);
const presentation = new Set([
  "fill",
  "fill-rule",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "stop-color",
  "stop-opacity",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "letter-spacing",
]);
const escapeXml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
const reject = (): never => {
  throw Error("Unsupported SVG artwork.");
};

/** Rebuild a small inert SVG vocabulary before the native rasterizer sees any bytes. */
export function staticSvg(bytes: Buffer): Buffer {
  if (bytes.length > 1024 * 1024) reject();
  const input = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parser = new SaxesParser({ xmlns: true });
  const output: string[] = [];
  let depth = 0,
    nodes = 0;
  const value = (name: string, text: string) => {
    if (text.length > 20000 || /[\p{Cc}\\@<>]/u.test(text)) reject();
    // Only an exact local paint/clip reference can use url(). No CSS escapes/imports/fonts.
    if (
      /url\s*\(/i.test(text) &&
      !(
        ["fill", "stroke", "clip-path"].includes(name) &&
        /^url\(#[A-Za-z_][\w.-]{0,127}\)$/.test(text)
      )
    )
      reject();
    if (/https?:|file:|data:|javascript:|\/\//i.test(text)) reject();
    if (name === "id" && !/^[A-Za-z_][\w.-]{0,127}$/.test(text)) reject();
    if (name === "font-family" && !/^(serif|sans-serif|monospace)$/.test(text))
      reject();
    return `${name}="${escapeXml(text)}"`;
  };
  parser.on("error", reject);
  parser.on("doctype", reject);
  parser.on("processinginstruction", reject);
  parser.on("xmldecl", (decl) => {
    if (decl.encoding && !/^utf-8$/i.test(decl.encoding)) reject();
  });
  parser.on("opentag", (tag) => {
    if (
      ++nodes > 3000 ||
      ++depth > 32 ||
      !elements.has(tag.local) ||
      tag.prefix ||
      (tag.uri && tag.uri !== svgNamespace) ||
      (depth === 1 && tag.local !== "svg") ||
      (depth > 1 && tag.local === "svg")
    )
      reject();
    const props: string[] = depth === 1 ? [`xmlns="${svgNamespace}"`] : [];
    for (const attr of Object.values(tag.attributes)) {
      if (attr.name === "xmlns" && attr.value === svgNamespace) continue;
      if (
        attr.prefix ||
        attr.uri ||
        (!attributes.has(attr.local) && attr.local !== "style")
      )
        reject();
      if (attr.local === "style") {
        for (const entry of attr.value
          .split(";")
          .filter((entry) => entry.trim())) {
          const colon = entry.indexOf(":");
          const name = entry.slice(0, colon).trim(),
            text = entry.slice(colon + 1).trim();
          if (colon < 1 || !presentation.has(name) || !text) reject();
          props.push(value(name, text));
        }
      } else props.push(value(attr.local, attr.value));
    }
    output.push(`<${tag.local}${props.length ? " " + props.join(" ") : ""}>`);
  });
  parser.on("text", (text) => {
    if (depth) output.push(escapeXml(text));
  });
  parser.on("cdata", (text) => {
    if (depth) output.push(escapeXml(text));
  });
  parser.on("closetag", (tag) => {
    output.push(`</${tag.local}>`);
    depth--;
  });
  parser.write(input).close();
  if (!nodes || depth !== 0) reject();
  return Buffer.from(output.join(""));
}
