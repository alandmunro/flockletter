import { z } from 'zod';

export const companyOrBrandName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(
    (value) =>
      [...value].every((ch) => {
        const code = ch.codePointAt(0)!;
        return code > 31 && code !== 127;
      }),
    'Use a name without control characters.',
  );
export type CompanyBrand = { id: string; name: string };
export type Company = { id: string; name: string; isDefault: boolean; brands: CompanyBrand[] };
export type CompanyLimits = { companies: number; brands: number };
export type CompanyDirectory = {
  companies: Company[];
  brandCount: number;
  limits: CompanyLimits;
  planName: string;
};
