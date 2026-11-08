import { z } from 'zod';
import type { Capability } from './contracts.js';

export function commandDefinition<T extends z.ZodRawShape>(
  description: string, scope: Capability | 'owner', mutation: boolean, shape: T,
) {
  return { description, scope, mutation, schema: z.object(shape).strict() };
}
