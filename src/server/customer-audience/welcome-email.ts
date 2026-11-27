import { readFile } from "node:fs/promises";
import { renderWelcomeEmail } from "../../shared/welcome-email.js";
import type { WelcomeDesign } from "../../shared/signup-design.js";

export type WelcomeEnvelope = {
  operationKey: string;
  routeToken?: string;
  to: string;
  brandName: string;
  identity?: {
    accent: string;
    font: "serif" | "sans";
    logo?: { mime: string; width: number; height: number; bytes: Buffer };
  };
  welcome: WelcomeDesign;
  unsubscribeUrl: string;
  preferencesUrl?: string;
};

/** Renders the welcome message with the brand logo (or Flockletter postage) as its only inline image. */
export async function welcomeContent(message: WelcomeEnvelope, capture = false) {
  const logo = message.identity?.logo;
  const cid = logo ? "verification-brand" : "verification-postage";
  const mail = renderWelcomeEmail(
    {
      brandName: message.brandName,
      welcome: message.welcome,
      font: message.identity?.font,
      buttonColor: message.identity?.accent,
      logo: logo ? { contentId: cid, alt: message.brandName, width: logo.width, height: logo.height } : undefined,
    },
    { unsubscribeUrl: message.unsubscribeUrl, preferencesUrl: message.preferencesUrl },
    capture,
  );
  const mime = logo?.mime ?? "image/png";
  const attachments = [
    {
      filename: "identity." + mime.split("/")[1],
      content_type: mime,
      content_id: cid,
      content: (logo?.bytes ?? (await readFile("public/brand/newsletter-postage.png"))).toString("base64"),
    },
  ];
  return { mail, attachments };
}
