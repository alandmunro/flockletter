import { describe, it, expect } from 'vitest';
import { commands } from '../src/shared/contracts.js';

const brandId = '123e4567-e89b-42d3-a456-426614174000';
const contactId = '9f8c2d1e-3b7a-4c5d-8e9f-0a1b2c3d4e5f';

const parse = (name: keyof typeof commands, input: Record<string, unknown>) =>
  commands[name].schema.parse(input);

describe('audience contracts', () => {
  it('list applies limits, rejects bad values, and normalizes email', () => {
    expect(parse('audience.list', { brandId })).toEqual(expect.objectContaining({ limit: 25 }));
    expect(parse('audience.list', { brandId, limit: 50 })).toEqual(expect.objectContaining({ limit: 50 }));
    expect(() => parse('audience.list', { brandId, limit: 0 })).toThrow();
    expect(() => parse('audience.list', { brandId, limit: 51 })).toThrow();
    expect(() => parse('audience.list', { brandId, state: 'not-a-state' })).toThrow();
    expect(() => parse('audience.list', { brandId, workspaceId: contactId })).toThrow();
    expect(parse('audience.list', { brandId, email: ' Reader+ffa@EXAMPLE.COM ' })).toEqual(
      expect.objectContaining({ email: 'Reader+ffa@example.com' }),
    );
  });

  it('contact rejects cursor containing an email', () => {
    expect(() =>
      parse('audience.contact', { brandId, id: contactId, cursor: 'reader+ffa@example.com' }),
    ).toThrow();
  });

  it('normalizes resource IDs for stable opt-out replay keys', () => {
    expect(
      parse('audience.unsubscribe', { brandId: brandId.toUpperCase(), id: contactId.toUpperCase() }),
    ).toEqual({ brandId, id: contactId });
  });

  it('unsubscribe rejects extra state', () => {
    expect(() => parse('audience.unsubscribe', { brandId, id: contactId, state: 'confirmed' })).toThrow();
  });

  it('declares expected scopes', () => {
    expect(commands['audience.list'].scope).toBe('owner');
    expect(commands['audience.contact'].scope).toBe('owner');
    expect(commands['audience.unsubscribe'].scope).toBe('owner');
    expect(commands['audience.summary'].scope).toBe('audience:summary');
  });
});
