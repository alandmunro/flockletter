import { buttonInk, type SignupDesign, type WelcomeDesign } from "./signup-design.js";
import { escapeHtml, imageTag, renderEmailDocument } from "./confirmation-email.js";
import { renderAuthoringLayout } from "./authoring-layout.js";

type InlineImage = { contentId: string; alt: string; width: number; height: number };
export type WelcomeTemplate = {
  brandName: string;
  welcome: WelcomeDesign;
  logo?: InlineImage;
  font?: "serif" | "sans";
  buttonColor?: string;
};
export type WelcomeLinks = { unsubscribeUrl: string; preferencesUrl?: string };

function actionUrl(raw: string, capture: boolean) {
  const url = new URL(raw);
  const local = capture && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !local) || url.username || url.password)
    throw new Error("Expected an HTTPS action URL.");
  return raw;
}

/** Sent once after double opt-in. Copy is owner-authored; every fragment is escaped here. */
export function renderWelcomeEmail(template: WelcomeTemplate, links: WelcomeLinks, capture = false) {
  const name = template.brandName.trim();
  if (!name || /[\r\n]/.test(name)) throw new Error("Supply the sending brand’s display name.");
  const unsubscribeUrl = actionUrl(links.unsubscribeUrl, capture);
  const preferencesUrl = links.preferencesUrl ? actionUrl(links.preferencesUrl, capture) : undefined;
  const copy = template.welcome;
  const subject = copy.subject || `Welcome to the ${name} newsletter`;
  if (/[\r\n]/.test(subject)) throw new Error("Use a single-line welcome subject.");
  const title = copy.heading || "You’re subscribed";
  const introduction = copy.message || `Thank you for signing up for the ${name} newsletter.`;
  const code = copy.promoCode?.trim() ?? "";
  const details = copy.promoDetails?.trim() ?? "";
  const link = copy.link?.trim() ? actionUrl(copy.link.trim(), false) : "";
  const buttonLabel = copy.button || `Visit ${name}`;
  const buttonColor = template.buttonColor ?? "#83364f";
  if (!/^#[a-fA-F0-9]{6}$/.test(buttonColor)) throw new Error("Use a six-digit hex button color.");
  const ink = buttonInk(buttonColor);
  const face = template.font === "sans" ? "Arial,Helvetica,sans-serif" : "Georgia,Times New Roman,serif";
  const preheader = code ? `Your promo code: ${code}` : `Thanks for subscribing to the ${name} newsletter.`;
  const stamp = { contentId: "verification-postage", alt: "", width: 348, height: 208 };
  const identity = imageTag(template.logo ?? stamp, template.logo ? 112 : 120, 76);

  const heading = `<h1 style="margin:0 0 16px;font:normal 38px/1.1 ${face};color:#4a0a1e">${escapeHtml(title)}</h1>`;
  const promo = code
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px"><tr><td align="center" style="border:2px dashed ${buttonColor};border-radius:6px;padding:14px 26px">` +
      `<div style="font:bold 11px/1.4 Arial,Helvetica,sans-serif;letter-spacing:2px;color:#69515d">PROMO CODE</div>` +
      `<div style="font:bold 28px/1.3 'Courier New',Courier,monospace;letter-spacing:2px;color:#4a0a1e">${escapeHtml(code)}</div>` +
      `</td></tr></table>`
    : "";
  const story =
    `<p style="margin:0 0 18px">${escapeHtml(introduction).replace(/\r\n|\r|\n/g, "<br>")}</p>` +
    promo +
    (details ? `<p style="margin:0 0 22px">${escapeHtml(details)}</p>` : "");
  const action = link
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${buttonColor}" style="border-radius:5px;mso-padding-alt:14px 22px"><a href="${escapeHtml(link)}" style="display:inline-block;padding:14px 22px;color:${ink};background:${buttonColor};border-radius:5px;text-decoration:none;font:bold 16px/20px Arial,Helvetica,sans-serif;mso-padding-alt:0">${escapeHtml(buttonLabel)}</a></td></tr></table>`
    : "";
  const body = renderAuthoringLayout("appreciation", { heading, photos: "", story, link: action });
  const linkStyle = 'style="color:#713049;text-decoration:underline"';
  const footer =
    `You’re receiving this because you confirmed your subscription to the ${escapeHtml(name)} newsletter. ` +
    (preferencesUrl ? `<a href="${escapeHtml(preferencesUrl)}" ${linkStyle}>Manage preferences</a> or ` : "") +
    `<a href="${escapeHtml(unsubscribeUrl)}" ${linkStyle}>unsubscribe</a>.`;
  const html = renderEmailDocument({ subject, preheader, brand: escapeHtml(name), face, identity, body, footer });
  const text =
    `${title}\n\n${introduction}\n\n` +
    (code ? `Promo code: ${code}\n` : "") +
    (details ? `${details}\n` : "") +
    (code || details ? "\n" : "") +
    (link ? `${buttonLabel}\n${link}\n\n` : "") +
    `You’re receiving this because you confirmed your subscription to the ${name} newsletter.\n` +
    (preferencesUrl ? `Manage preferences: ${preferencesUrl}\n` : "") +
    `Unsubscribe: ${unsubscribeUrl}`;
  return { subject, preheader, html, text };
}

type PreviewImage = { url: string; width: number; height: number };

/** Editor preview: same renderer, inert links and browser-local images. */
export function renderWelcomePreview(
  design: SignupDesign,
  brandName: string,
  images: { logo?: PreviewImage; postage?: string } = {},
) {
  const name = (design.displayName.trim() || brandName).replace(/[\r\n]+/g, " ");
  const preview = renderWelcomeEmail(
    {
      brandName: name,
      welcome: design.welcome ?? { enabled: false },
      font: design.font,
      buttonColor: design.accent,
      logo: images.logo && { ...images.logo, contentId: "verification-brand", alt: name },
    },
    { unsubscribeUrl: "https://preview.invalid/opt-out" },
  );
  const html = preview.html
    .replace(/href="[^"]*"/g, 'aria-disabled="true"')
    .replace(/src="cid:(verification-(?:brand|postage))"/g, (_, id: string) => {
      if (id === "verification-postage")
        return images.postage && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(images.postage)
          ? 'src="' + images.postage + '"'
          : 'src="/brand/newsletter-postage.png"';
      const url = images.logo?.url;
      if (!url || !/^(blob:|data:image\/(?:png|jpeg|gif|webp);base64,)/i.test(url)) return "";
      return 'src="' + escapeHtml(url) + '"';
    });
  return { ...preview, html };
}
