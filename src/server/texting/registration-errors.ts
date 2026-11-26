// Twilio's A2P error dictionary and Event Streams schemas. Keep only registration codes;
// free-form carrier descriptions may include private identity or application details.
export function registrationCodes(values: unknown): string | undefined {
  const fields = Array.isArray(values) ? values : [values];
  const codes = new Set<string>();
  for (const value of fields.slice(0, 25)) {
    const entry = typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
    const code = entry ? entry.error_code ?? entry.registrationerrorcode ?? entry.errorcode ?? entry.code : value;
    if ((typeof code === 'string' || typeof code === 'number') && /^30[789]\d{2}$/.test(String(code))) codes.add(String(code));
  }
  return codes.size ? [...codes].join(',') : undefined;
}

const fixes: Record<string,string> = {
  '30795': 'Check the EIN and legal name against the tax registration. Request a billing review if the paid business identity needs to change.',
  '30799': 'Check the registered business name and identification number against the official record.',
  '30801': 'Check the street, city, state and ZIP code against the official business address.',
  '30907': 'Provide a public website for the business named on the application.',
  '30908': 'Update the public privacy policy to explain how mobile opt-in data is used and protected.',
  '30933': 'Enter the direct public URL of the business’s privacy policy.',
  '30934': 'Enter the direct public URL of the SMS program terms.',
  '30882': 'Update the public SMS terms to identify the program and explain message frequency, rates, STOP and HELP.',
  '30896': 'Show how customers actively opt in to your texts on the published signup page.',
  '30909': 'Describe each opt-in step and make the signup form and disclosures available for review.',
  '30918': 'Check that the trade name on the website matches the DBA registered to the business.',
  '30921': 'Make the website and consent pages accessible without signing in.',
  '30925': 'Leave the SMS consent checkbox unchecked so customers actively opt in.',
  '30932': 'Explain mobile opt-in data sharing in the public privacy policy.',
};
export function rejectionMessage(reason: string | null) {
  const codes = reason?.match(/(?<!\d)30[789]\d{2}(?!\d)/g) ?? [];
  const messages = [...new Set(codes.map(code => fixes[code]).filter(Boolean))];
  if (messages.length) return messages.join(' ');
  if (reason?.includes('signup_page_missing')) return 'Enable your Flockletter signup page and its mobile number field.';
  return 'Review the business information, campaign examples and published SMS policies. Contact support if you need the carrier decision reviewed.';
}
