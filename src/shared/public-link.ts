export const hasControl = (value: string) =>
  Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
// Validate the supplied link as text. Creating a draft never resolves or fetches its destination.
export function publicProductLink(value: string) {
  if (!/^https:\/\//i.test(value) || /[\s\\]/u.test(value) || hasControl(value)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      host.includes('.') &&
      !host.includes(':') &&
      !/^\d+(?:\.\d+){3}$/.test(host) &&
      !/(^|\.)(localhost|local|localdomain|internal|home|lan|test|invalid|onion|arpa)$/.test(host) &&
      host.split('.').every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label))
    );
  } catch {
    return false;
  }
}
