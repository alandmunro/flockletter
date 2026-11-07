import { z } from 'zod';
import { emptyContent, type CampaignContent } from './contracts.js';

export const templateIds = ['announcement', 'collection', 'appreciation'] as const;
export type TemplateId = (typeof templateIds)[number];
export type TemplateSummary = {
  id: TemplateId;
  name: string;
  description: string;
  sections: readonly string[];
};

const presets = {
  announcement: {
    name: 'Product announcement',
    description: 'Give one item the spotlight with a lead image and a link to its product page.',
    sections: ['Headline', 'Product photo', 'Story and product link'],
    subject: 'A closer look',
    heading: 'A closer look',
  },
  collection: {
    name: 'Seasonal collection',
    description: 'Introduce a collection, then show its pieces in a photo gallery.',
    sections: ['Headline', 'Collection story', 'Photo gallery and link'],
    subject: 'The seasonal edit',
    heading: 'The seasonal edit',
  },
  appreciation: {
    name: 'Customer appreciation',
    description: 'Start with a personal note. Add a photo or link when it belongs in the letter.',
    sections: ['Greeting', 'Personal note', 'Optional photo and link'],
    subject: 'A note of thanks',
    heading: 'Thank you',
  },
} satisfies Record<TemplateId, Omit<TemplateSummary, 'id'> & { subject: string; heading: string }>;

export const templates: readonly TemplateSummary[] = templateIds.map((id) => {
  const { name, description, sections } = presets[id];
  return { id, name, description, sections };
});

export function fromTemplateContent(id: TemplateId): CampaignContent {
  const { name, subject, heading } = presets[id];
  return { ...emptyContent(), layout: id, title: name, subject, heading };
}

const hasControl = (value: string) =>
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

export const productFields = {
  productName: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((value) => !hasControl(value), 'Use a printable product name on one line.'),
  excerpt: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .refine((value) => !value.includes(String.fromCharCode(0)), 'Use a plain-text description.'),
  productUrl: z
    .string()
    .trim()
    .max(2048)
    .refine(publicProductLink, 'Use a public HTTPS product page without credentials or a custom port.'),
};

export function fromProductContent(product: {
  productName: string;
  productUrl: string;
  excerpt: string;
  assetIds: string[];
}): CampaignContent {
  return {
    ...fromTemplateContent('announcement'),
    title: product.productName,
    subject: product.productName,
    heading: product.productName,
    body: product.excerpt,
    ctaLabel: 'View product',
    ctaUrl: product.productUrl,
    assetIds: [...product.assetIds],
  };
}
