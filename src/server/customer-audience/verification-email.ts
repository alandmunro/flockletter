import { readFile } from "node:fs/promises";
import type { ConfirmationEnvelope } from "./service.js";
import { renderVerificationEmail } from "../../shared/confirmation-email.js";

export async function confirmationContent(
  message: Pick<
    ConfirmationEnvelope,
    "brandName" | "identity" | "confirmUrl" | "unsubscribeUrl"
  >,
  capture = false,
) {
  const logo = message.identity?.logo;
  const photo = message.identity?.photo;
  const cid = logo ? "verification-brand" : "verification-postage";
  const mail = renderVerificationEmail(
    {
      brandName: message.brandName,
      layout: "appreciation",
      font: message.identity?.font,
      buttonColor: message.identity?.accent,
      confirmation: message.identity?.confirmation,
      photo: photo
        ? {
            contentId: "verification-photo",
            alt: "",
            width: photo.width,
            height: photo.height,
          }
        : undefined,
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
  const attachments = [attachment];
  if (photo)
    attachments.push({
      filename: "confirmation-photo." + photo.mime.split("/")[1],
      content_type: photo.mime,
      content_id: "verification-photo",
      content: photo.bytes.toString("base64"),
    });
  return { mail, attachment, attachments };
}
