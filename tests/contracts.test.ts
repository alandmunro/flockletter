import { describe, expect, it } from 'vitest';
import { commands, contentSchema, emptyContent, plans } from '../src/shared/contracts.js';
import type { CampaignContent } from '../src/shared/contracts.js';

const uuid = (): string => globalThis.crypto.randomUUID();
const operationKey = (suffix: number | string): string => `op-key-${String(suffix).padStart(9, '0')}`;
const fileItemKey = (index: number): string => `item-key-${String(index).padStart(8, '0')}`;

type ContentStringField =
  | 'title'
  | 'subject'
  | 'preheader'
  | 'fromName'
  | 'replyTo'
  | 'heading'
  | 'body'
  | 'ctaLabel'
  | 'ctaUrl';

const stringFieldMaxima: Array<[field: ContentStringField, max: number]> = [
  ['title', 120],
  ['subject', 150],
  ['preheader', 200],
  ['fromName', 100],
  ['replyTo', 254],
  ['heading', 150],
  ['body', 12000],
  ['ctaLabel', 60],
  ['ctaUrl', 2048],
];

const contentWithField = (field: ContentStringField, value: string): CampaignContent =>
  ({ ...emptyContent(), [field]: value }) as CampaignContent;

const contentWithAssetIds = (ids: string[]): CampaignContent =>
  ({ ...emptyContent(), assetIds: ids });

describe('plan catalogue', () => {
  it('exposes three approved plans', () => {
    expect(plans).toHaveLength(3);
  });

  it('keeps approved starter limits', () => {
    const plan = plans[0];

    expect(plan.id).toBe('starter');
    expect(plan.currency).toBe('USD');
    expect(plan.priceMinor).toBe(1500);
    expect(plan.contacts).toBe(2500);
    expect(plan.recipients).toBe(2500);
    expect(plan.campaigns).toBe(2);
    expect(plan.emails).toBe(5000);
    expect(plan.companies).toBe(1);
    expect(plan.brands).toBe(1);
    expect(plan.users).toBe(1);
  });

  it('keeps approved growth limits', () => {
    const plan = plans[1];

    expect(plan.id).toBe('growth');
    expect(plan.currency).toBe('USD');
    expect(plan.priceMinor).toBe(2500);
    expect(plan.contacts).toBe(5000);
    expect(plan.recipients).toBe(5000);
    expect(plan.campaigns).toBe(5);
    expect(plan.emails).toBe(25000);
    expect(plan.companies).toBe(3);
    expect(plan.brands).toBe(3);
    expect(plan.users).toBe(3);
  });

  it('keeps approved pro limits with explicitly unlimited users', () => {
    const plan = plans[2];

    expect(plan.id).toBe('pro');
    expect(plan.currency).toBe('USD');
    expect(plan.priceMinor).toBe(3900);
    expect(plan.contacts).toBe(10000);
    expect(plan.recipients).toBe(10000);
    expect(plan.campaigns).toBe(20);
    expect(plan.emails).toBe(100000);
    expect(plan.companies).toBe(5);
    expect(plan.brands).toBe(5);
    expect(plan.users).toBeNull();
  });
});

describe('emptyContent', () => {
  it('returns independent objects and arrays', () => {
    const a = emptyContent();
    const b = emptyContent();

    expect(a).not.toBe(b);
    expect(a.assetIds).not.toBe(b.assetIds);

    a.title = 'changed';
    a.assetIds.push(uuid());

    expect(b.title).toBe('');
    expect(b.assetIds).toEqual([]);
  });

  it('blank draft parses', () => {
    expect(contentSchema.safeParse(emptyContent()).success).toBe(true);
  });
});

describe('contentSchema string length boundaries', () => {
  it.each(stringFieldMaxima)('%s accepts %d characters and rejects one more', (field, max) => {
    expect(contentSchema.safeParse(contentWithField(field, 'a'.repeat(max))).success).toBe(true);
    expect(contentSchema.safeParse(contentWithField(field, 'a'.repeat(max + 1))).success).toBe(false);
  });
});

describe('contentSchema assetIds boundaries', () => {
  it('accepts six distinct image ids', () => {
    const ids = Array.from({ length: 6 }, () => uuid());

    expect(new Set(ids).size).toBe(6);
    expect(contentSchema.safeParse(contentWithAssetIds(ids)).success).toBe(true);
  });

  it('rejects seven image ids', () => {
    const ids = Array.from({ length: 7 }, () => uuid());

    expect(contentSchema.safeParse(contentWithAssetIds(ids)).success).toBe(false);
  });

  it('rejects duplicate image ids', () => {
    const id = uuid();

    expect(contentSchema.safeParse(contentWithAssetIds([id, id])).success).toBe(false);
  });
});

describe('command schema boundaries', () => {
  it('campaign.create accepts a 16-character operation key and rejects shorter keys', () => {
    const schema = commands['campaign.create'].schema;
    const valid = { brandId: uuid(), content: emptyContent() };

    expect(schema.safeParse({ operationKey: 'a'.repeat(16), ...valid }).success).toBe(true);
    expect(schema.safeParse({ operationKey: 'a'.repeat(15), ...valid }).success).toBe(false);
  });

  it('campaign.update requires a positive integer expectedVersion', () => {
    const schema = commands['campaign.update'].schema;
    const id = uuid();
    const payload = (expectedVersion: number) => ({
      operationKey: operationKey(2),
      id,
      expectedVersion,
      content: emptyContent(),
    });

    expect(schema.safeParse(payload(1)).success).toBe(true);
    expect(schema.safeParse(payload(0)).success).toBe(false);
    expect(schema.safeParse(payload(-1)).success).toBe(false);
    expect(schema.safeParse(payload(1.5)).success).toBe(false);
  });

  it('campaign.preview requires a positive integer expectedVersion', () => {
    const schema = commands['campaign.preview'].schema;
    const id = uuid();
    const payload = (expectedVersion: number) => ({ id, expectedVersion });

    expect(schema.safeParse(payload(1)).success).toBe(true);
    expect(schema.safeParse(payload(0)).success).toBe(false);
    expect(schema.safeParse(payload(-1)).success).toBe(false);
    expect(schema.safeParse(payload(1.5)).success).toBe(false);
  });

  it('asset.uploadBatch enforces structural file-count and item-key constraints', () => {
    const schema = commands['asset.uploadBatch'].schema;

    const makeFiles = (count: number, duplicateFirstItemKey = false) =>
      Array.from({ length: count }, (_, index) => ({
        itemKey: duplicateFirstItemKey && index > 0 ? fileItemKey(0) : fileItemKey(index),
        name: `image-${index}`,
        base64: '',
      }));

    const payload = (files: Array<{ itemKey: string; name: string; base64: string }>) => ({
      operationKey: operationKey(3),
      brandId: uuid(),
      files,
    });

    expect(schema.safeParse(payload(makeFiles(10))).success).toBe(true);
    expect(schema.safeParse(payload(makeFiles(11))).success).toBe(false);
    expect(schema.safeParse(payload(makeFiles(0))).success).toBe(false);
    expect(schema.safeParse(payload(makeFiles(2, true))).success).toBe(false);
  });
});
