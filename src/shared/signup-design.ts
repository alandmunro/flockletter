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

export const signupDesign = z
  .object({
    displayName: z.string().trim().max(100),
    heading: z.string().trim().max(120),
    introduction: z.string().trim().max(400),
    accent: z.string().regex(/^#[0-9a-f]{6}$/i),
    font: z.enum(["serif", "sans"]),
    logoId: z.uuid().nullable(),
    confirmation: confirmationDesign.optional(),
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
