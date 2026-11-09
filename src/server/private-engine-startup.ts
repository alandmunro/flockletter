import type { Config } from './config.js';
import { startPrivateMessenger } from './campaign/private-messenger.js';

/** Production customer renderers never expose the legacy staging rehearsal dispatcher. */
export async function startLegacyMessenger(
  config: Pick<Config, 'environment'>,
  ...args: Parameters<typeof startPrivateMessenger>
) {
  if (config.environment === 'production') return;
  return startPrivateMessenger(...args);
}
