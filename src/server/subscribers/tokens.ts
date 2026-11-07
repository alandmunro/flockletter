import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { LinkBinding } from './config.js';

export type LinkAction = 'confirm' | 'unsubscribe';
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function actionToken(binding: LinkBinding, action: LinkAction, id: string) {
  const signature = createHmac('sha256', binding.key)
    .update(JSON.stringify(['flockletter-subscriber-v1', binding.workspaceId, binding.brandId, action, id]))
    .digest('base64url');
  return id + '.' + signature;
}
export function verifiedId(binding: LinkBinding, action: LinkAction, token: string) {
  if (token.length !== 80) return;
  const [id] = token.split('.');
  if (!id || !z.uuid().safeParse(id)) return;
  const candidate = Buffer.from(token);
  const expected = Buffer.from(actionToken(binding, action, id));
  if (candidate.length === expected.length && timingSafeEqual(expected, candidate)) return id;
}
export function actionUrl(binding: LinkBinding, action: LinkAction, id: string) {
  return `${binding.origin}/subscriptions/${action}#${actionToken(binding, action, id)}`;
}
