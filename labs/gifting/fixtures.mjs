// WA-03 supplies canonical person IDs after resolving shared addresses and consent.
export function contacts(count) {
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Invalid fixture size');
  const result = [];
  for (let id = 1; id <= count; id++) {
    result.push({ personId: id, channel: 'email' }, { personId: id, channel: 'sms' });
  }
  return result;
}

export const workspaces = ['Studio', 'Orchard'];
export const catalog = Array.from({ length: 10 }, (_, i) => 'sample-' + (i + 1));
export const thankYou = 'Thank you for being part of our community. Please enjoy this gift.';
