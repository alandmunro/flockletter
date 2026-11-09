// node-postgres permits query options to override URL host/user fields.
// Release guards inspect those fields, so only one reviewed TLS option may remain.
const sslModes = new Set(['disable', 'no-verify', 'prefer', 'require', 'verify-ca', 'verify-full']);

export function hasSupportedProductionConnectionOptions(url) {
  const entries = [...url.searchParams.entries()];
  return Boolean(url.hostname) && !url.hash && (entries.length === 0 ||
    (entries.length === 1 && entries[0][0] === 'sslmode' && sslModes.has(entries[0][1])));
}
