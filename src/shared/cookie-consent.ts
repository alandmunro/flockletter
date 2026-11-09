/** Browser preferences are independent of login, workspace grants and email consent. */
export const COOKIE_NOTICE_VERSION = 'flockletter-cookies-v1';
export const COOKIE_PREFERENCE_KEY = 'flockletter_cookie_choices';
export const COOKIE_PREFERENCE_MS = 180 * 24 * 60 * 60 * 1000;
// This site has no optional website analytics or advertising integrations. A future
// integration needs a new notice, an explicit purpose and reviewed withdrawal logic.
export const COOKIE_OPTIONAL_PURPOSES: readonly string[] = Object.freeze([]);
export type CookieDecision = 'accept' | 'reject';
export type CookieChoice = {
  version: string;
  choice: CookieDecision;
  at: number;
  purposes: readonly string[];
};

export function newCookieChoice(choice: CookieDecision, now = Date.now()): CookieChoice {
  return {version:COOKIE_NOTICE_VERSION,choice,at:now,purposes:[...COOKIE_OPTIONAL_PURPOSES]};
}

export function savedCookieChoice(raw: string | null, now = Date.now()): CookieChoice | null {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as Record<string,unknown>;
    if (Object.keys(item).length !== 4 || item.version !== COOKIE_NOTICE_VERSION ||
        (item.choice !== 'accept' && item.choice !== 'reject') ||
        typeof item.at !== 'number' || !Number.isSafeInteger(item.at) || item.at <= 0 ||
        item.at > now || now - item.at >= COOKIE_PREFERENCE_MS ||
        !Array.isArray(item.purposes) || item.purposes.length !== COOKIE_OPTIONAL_PURPOSES.length ||
        item.purposes.some((purpose,index) => purpose !== COOKIE_OPTIONAL_PURPOSES[index])) return null;
    return {version:COOKIE_NOTICE_VERSION,choice:item.choice as CookieDecision,at:item.at,
      purposes:[...COOKIE_OPTIONAL_PURPOSES]};
  } catch { return null; }
}

/** No optional purpose is enabled by accepting a necessary-only notice. */
export function optionalCookieAllowed(raw: string | null, purpose: string, privacySignal = false, now = Date.now()): boolean {
  const saved = savedCookieChoice(raw,now);
  return !privacySignal && COOKIE_OPTIONAL_PURPOSES.includes(purpose) &&
    saved?.choice === 'accept' && saved.purposes.includes(purpose);
}
