import { z } from "zod";

const singleLine = (limit: number) =>
  z
    .string()
    .trim()
    .max(limit)
    .regex(/^[^\r\n]*$/, "Use one line.");
export const confirmationDesign = z
  .object({
    subject: singleLine(120).optional(),
    heading: singleLine(120).optional(),
    message: z.string().trim().max(800).optional(),
    button: singleLine(60).optional(),
    photoId: z.uuid().nullable().optional(),
  })
  .strict();
export type ConfirmationDesign = z.infer<typeof confirmationDesign>;

/** An HTTPS page without credentials, or blank to omit the button. */
const welcomeLink = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "Use a full https:// link.");
/**
 * Optional one-time message sent after a subscriber completes double opt-in.
 * The promo code is display text only: Flockletter does not issue, track or redeem it.
 */
export const welcomeDesign = z
  .object({
    enabled: z.boolean(),
    subject: singleLine(120).optional(),
    heading: singleLine(120).optional(),
    message: z.string().trim().max(800).optional(),
    promoCode: z
      .string()
      .trim()
      .max(40)
      .regex(/^(?:[A-Za-z0-9][A-Za-z0-9_-]*)?$/, "Use letters, numbers, dashes or underscores.")
      .optional(),
    promoDetails: singleLine(200).optional(),
    button: singleLine(60).optional(),
    link: welcomeLink.optional(),
  })
  .strict();
export type WelcomeDesign = z.infer<typeof welcomeDesign>;

export const signupDesign = z
  .object({
    displayName: z.string().trim().max(100),
    heading: z.string().trim().max(120),
    introduction: z.string().trim().max(400),
    accent: z.string().regex(/^#[0-9a-f]{6}$/i),
    font: z.enum(["serif", "sans"]),
    logoId: z.uuid().nullable(),
    confirmation: confirmationDesign.optional(),
    welcome: welcomeDesign.optional(),
  })
  .strict();
export type SignupDesign = z.infer<typeof signupDesign>;
export const defaultDesign: SignupDesign = {
  displayName: "",
  heading: "",
  introduction: "",
  accent: "#83364f",
  font: "serif",
  logoId: null,
};
export function buttonInk(accent: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const value = parseInt(accent.slice(i, i + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return r * 0.2126 + g * 0.7152 + b * 0.0722 > 0.179 ? "#000000" : "#ffffff";
}
