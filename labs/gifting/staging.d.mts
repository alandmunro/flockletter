import type { GiftEvent, GiftStatus } from '../../src/shared/gifting.js';
export function openCapture(
  workspace: string,
  history: GiftEvent[],
): {
  apply(event: GiftEvent): unknown;
  status(): GiftStatus;
  close(): void;
};
