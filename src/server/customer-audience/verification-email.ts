import { readFile } from "node:fs/promises";
import type { ConfirmationEnvelope } from "./service.js";
import { buttonInk } from "../../shared/signup-design.js";
import type { TemplateId } from "../../shared/authoring.js";
import { renderAuthoringLayout } from "../authoring-layout.js";

type InlineImage = {
  contentId: string;
  alt: string;
  width: number;
  height: number;
};
type SenderTemplate = {
  brandName: string;
  layout: TemplateId;
  logo?: InlineImage;
  photo?: InlineImage;
  font?: "serif" | "sans";
  buttonColor?: string;
};

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

function imageTag(image: InlineImage, maxWidth: number, maxHeight: number) {
  if (
    !/^[a-zA-Z0-9._@-]+$/.test(image.contentId) ||
    ![image.width, image.height].every((n) => Number.isFinite(n) && n >= 1)
  ) {
    throw new Error("Use a valid inline image from the sending brand.");
  }
  const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  return `<img src="cid:${image.contentId}" alt="${escapeHtml(image.alt)}" width="${width}" height="${height}" style="display:block;border:0;width:${width}px;max-width:100%;height:auto">`;
}

export function renderVerificationEmail(
  template: SenderTemplate,
  links: { confirmUrl: string; unsubscribeUrl: string },
  capture = false,
) {
  const name = template.brandName.trim();
  if (!name || /[\r\n]/.test(name))
    throw new Error("Supply the sending brand’s display name.");
  // The caller supplies the two existing signed URLs after the provider's origin checks.
  for (const raw of [links.confirmUrl, links.unsubscribeUrl]) {
    const url = new URL(raw);
    if (
      (url.protocol !== "https:" &&
        !(
          capture &&
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        )) ||
      url.username ||
      url.password
    )
      throw new Error("Expected an HTTPS action URL.");
  }
  if (links.confirmUrl === links.unsubscribeUrl)
    throw new Error("The two actions require separate links.");
  const brand = escapeHtml(name);
  const confirm = escapeHtml(links.confirmUrl);
  const unsubscribe = escapeHtml(links.unsubscribeUrl);
  const subject = `Confirm your ${name} subscription`;
  const preheader = `Confirm your email address to receive the ${name} newsletter.`;
  const buttonColor = template.buttonColor ?? "#83364f";
  if (!/^#[a-fA-F0-9]{6}$/.test(buttonColor))
    throw new Error("Use a six-digit hex button color.");
  const ink = buttonInk(buttonColor);
  const stamp = {
    contentId: "verification-postage",
    alt: "",
    width: 348,
    height: 208,
  };
  const media = template.logo ?? stamp;
  const identity = imageTag(media, template.logo ? 112 : 120, 76);
  const face =
    template.font === "sans"
      ? "Arial,Helvetica,sans-serif"
      : "Georgia,Times New Roman,serif";
  const heading = `<h1 style="margin:0 0 16px;font:normal 38px/1.1 ${face};color:#4a0a1e">Confirm your email</h1>`;
  const photos = template.photo
    ? `<p style="margin:16px 0">${imageTag(template.photo, 470, 156)}</p>`
    : "";
  const story = `<p style="margin:0 0 15px">Thanks for signing up for the <strong>${brand}</strong> newsletter.</p><p style="margin:0 0 23px">Open the confirmation page and select <strong>Confirm subscription</strong> to start receiving our emails.</p>`;
  const link = `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${buttonColor}" style="border-radius:5px;mso-padding-alt:14px 22px"><a href="${confirm}" style="display:inline-block;padding:14px 22px;color:${ink};background:${buttonColor};border-radius:5px;text-decoration:none;font:bold 16px/20px Arial,Helvetica,sans-serif;mso-padding-alt:0">Confirm my subscription</a></td></tr></table>`;
  const body = renderAuthoringLayout(template.layout, {
    heading,
    photos,
    story,
    link,
  });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title><style>
  @media (max-width:480px){.outer{padding:12px 8px!important}.pad{padding-left:22px!important;padding-right:22px!important}.brand{font-size:21px!important}.mark{width:88px!important}.mark img{max-width:84px!important}}
  </style></head><body style="margin:0;padding:0;background:#fff7f8">
  <div style="display:none!important;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#fff7f8"><tr><td class="outer" align="center" style="padding:28px 12px">
  <!--[if mso]><table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600"><tr><td><![endif]-->
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#ffffff" style="max-width:600px;background:#ffffff;border:1px solid #eadbdf;border-collapse:separate;border-radius:8px;font:16px/1.55 Arial,Helvetica,sans-serif;color:#342b30;text-align:left">
  <tr><td class="pad" bgcolor="#f5e8ea" style="padding:22px 34px;border-bottom:1px solid #e5d1d7;border-radius:7px 7px 0 0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="middle" style="padding-right:10px">
  <div class="brand" style="font:bold 25px/1.15 ${face};color:#4a0a1e;overflow-wrap:anywhere">${brand}</div>
  <div style="padding-top:7px;font:bold 11px/1.4 Arial,Helvetica,sans-serif;letter-spacing:2px;color:#69515d">NEWSLETTER</div></td>
  <td class="mark" width="120" align="right" valign="middle">${identity}</td></tr></table></td></tr>
  <tr><td class="pad" style="padding:34px 34px 30px;font:16px/1.55 Arial,Helvetica,sans-serif">${body}</td></tr>
  <tr><td class="pad" style="border-top:1px solid #eadbdf;padding:18px 34px 20px;color:#69515d;font:14px/1.55 Arial,Helvetica,sans-serif">
  Didn’t sign up? You can ignore this email or <a href="${unsubscribe}" style="color:#713049;text-decoration:underline">opt out</a>.</td></tr></table>
  <!--[if mso]></td></tr></table><![endif]-->
  </td></tr></table></body></html>`;
  const text = `Thanks for signing up for the ${name} newsletter.\n\nOpen the confirmation page and select “Confirm subscription” to start receiving our emails.\n\nConfirm my subscription\n${links.confirmUrl}\n\nDidn’t sign up? You can ignore this email or opt out here:\n${links.unsubscribeUrl}`;
  return { subject, preheader, html, text };
}

export async function confirmationContent(
  message: Pick<
    ConfirmationEnvelope,
    "brandName" | "identity" | "confirmUrl" | "unsubscribeUrl"
  >,
  capture = false,
) {
  const logo = message.identity?.logo;
  const cid = logo ? "verification-brand" : "verification-postage";
  const mail = renderVerificationEmail(
    {
      brandName: message.brandName,
      layout: "appreciation",
      font: message.identity?.font,
      buttonColor: message.identity?.accent,
      logo: logo
        ? {
            contentId: cid,
            alt: message.brandName,
            width: logo.width,
            height: logo.height,
          }
        : undefined,
    },
    message,
    capture,
  );
  const mime = logo?.mime ?? "image/png";
  const attachment = {
    filename: "identity." + mime.split("/")[1],
    content_type: mime,
    content_id: cid,
    content: (
      logo?.bytes ?? (await readFile("public/brand/newsletter-postage.png"))
    ).toString("base64"),
  };
  return { mail, attachment };
}
